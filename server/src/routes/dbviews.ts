import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, INTERNAL_HEADER, INTERNAL_KEY, requireUser, type AuthUser } from '../auth.js';
import { one, q } from '../db.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { assertPage, atLeast, pageLevel } from '../perms.js';
import { nextPosition } from '../pageOps.js';
import { getSettings } from '../workspaceSettings.js';
import { aggregate, andFilters, cleanChart, cleanVerification, resolveButtonProps, type ChartConfig } from '../dbviews.js';
import { getSchema, normalizeRowProps, queryDatabase, syncRelations, type Prop } from './databases.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** login_attempts-backed limiter (shared across instances). */
async function allow(key: string, max: number, minutes = 15) {
  const r = await one<{ n: number }>(`select count(*)::int as n from login_attempts where key = $1 and at > now() - make_interval(mins => $2)`, [key, minutes]);
  if ((r?.n ?? 0) >= max) return false;
  await q('insert into login_attempts(key) values ($1)', [key]);
  return true;
}

async function userNames(workspaceId?: string) {
  const rows = workspaceId
    ? await q<{ id: string; name: string }>('select u.id, u.name from users u join workspace_members m on m.user_id = u.id where m.workspace_id = $1', [workspaceId])
    : await q<{ id: string; name: string }>('select id, name from users');
  return new Map(rows.map((u) => [u.id, u.name]));
}

// ---------- forms ----------

const PUBLIC_QUESTION_TYPES = ['title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'place'];
const MEMBER_QUESTION_TYPES = [...PUBLIC_QUESTION_TYPES, 'person', 'files', 'relation'];

function questionMeta(schema: Prop[], form: any, publicMode: boolean) {
  const allowed = publicMode ? PUBLIC_QUESTION_TYPES : MEMBER_QUESTION_TYPES;
  return (form?.questions ?? [])
    .map((qn: any) => {
      const p = schema.find((x) => x.id === qn.propId);
      if (!p || !allowed.includes(p.type)) return null;
      return {
        ...qn,
        prop: {
          id: p.id, name: p.name, type: p.type,
          ...(p.options ? { options: p.options.map((o) => ({ id: o.id, name: o.name, color: o.color })) } : {}),
          ...(p.number_format ? { number_format: p.number_format } : {}),
          ...(p.limit ? { limit: p.limit } : {}),
          ...(p.relation && !publicMode ? { relation: { databaseId: p.relation.databaseId } } : {}),
        },
      };
    })
    .filter(Boolean);
}

const isEmpty = (v: any) => v == null || v === '' || (Array.isArray(v) && !v.length);

/** Validate form answers against the form's questions → { title, props } in Atrium's internal shape. */
async function validateAnswers(schema: Prop[], form: any, answers: Record<string, any>, publicMode: boolean, workspaceId: string) {
  const questions = questionMeta(schema, form, publicMode);
  const errors: Record<string, string> = {};
  const props: Record<string, any> = {};
  let title = '';
  for (const qn of questions as any[]) {
    const p = schema.find((x) => x.id === qn.propId)!;
    const label = qn.label || p.name;
    let v = answers?.[p.id];
    if (typeof v === 'string') v = v.trim();
    if (isEmpty(v) || (p.type === 'checkbox' && v === false && qn.required)) {
      if (qn.required) errors[p.id] = `${label} is required`;
      continue;
    }
    const bad = (m: string) => { errors[p.id] = m; };
    switch (p.type) {
      case 'title': title = String(v).slice(0, 2000); break;
      case 'text': props[p.id] = String(v).slice(0, 20000); break;
      case 'number': { const n = Number(v); if (!Number.isFinite(n)) bad(`${label} must be a number`); else props[p.id] = n; break; }
      case 'checkbox': props[p.id] = v === true || v === 'true'; break;
      case 'url': if (!/^https?:\/\/\S+$/i.test(String(v)) && !/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(String(v))) bad(`${label} must be a link`); else props[p.id] = String(v).slice(0, 2000); break;
      case 'email': if (!EMAIL_RE.test(String(v))) bad(`${label} must be an email address`); else props[p.id] = String(v).slice(0, 320); break;
      case 'phone': if (!/^[+\d][\d\s().-]{2,30}$/.test(String(v))) bad(`${label} must be a phone number`); else props[p.id] = String(v); break;
      case 'select': case 'status': {
        const o = p.options?.find((x) => x.id === v || x.name.toLowerCase() === String(v).toLowerCase());
        if (!o) bad(`Pick one of the ${label} options`); else props[p.id] = o.id;
        break;
      }
      case 'multi_select': {
        const ids = (Array.isArray(v) ? v : [v]).map((x) => p.options?.find((o) => o.id === x || o.name.toLowerCase() === String(x).toLowerCase())?.id);
        if (ids.some((x) => !x)) bad(`Pick ${label} from its options`); else props[p.id] = [...new Set(ids)];
        break;
      }
      case 'date': props[p.id] = typeof v === 'string' ? { start: v } : v; break;
      case 'place': props[p.id] = v; break;
      case 'person': {
        const ids = (Array.isArray(v) ? v : [v]).map(String);
        const ok = await q<{ id: string }>('select user_id as id from workspace_members where workspace_id = $1 and user_id = any($2::uuid[])', [workspaceId, ids]).catch(() => []);
        if (ok.length !== new Set(ids).size) bad(`${label}: unknown person`); else props[p.id] = [...new Set(ids)];
        break;
      }
      case 'files': {
        const list = (Array.isArray(v) ? v : [v]).filter((f: any) => f && typeof f.url === 'string' && f.url.startsWith('/api/v1/files/'));
        props[p.id] = list.slice(0, 20).map((f: any) => ({ name: String(f.name ?? 'file').slice(0, 300), url: f.url, ...(f.mime ? { mime: String(f.mime) } : {}) }));
        break;
      }
      case 'relation': {
        const ids = (Array.isArray(v) ? v : [v]).map(String);
        const ok = p.relation ? await q<{ id: string }>(`select id from pages where id = any($1::uuid[]) and parent_id = $2 and kind = 'row' and deleted_at is null`, [ids, p.relation.databaseId]).catch(() => []) : [];
        if (ok.length !== new Set(ids).size) bad(`${label}: unknown page`); else props[p.id] = [...new Set(ids)];
        break;
      }
    }
  }
  if (Object.keys(errors).length) {
    const e: any = new Error('Please fix the highlighted answers');
    e.statusCode = 400;
    e.fieldErrors = errors;
    throw e;
  }
  return { title, props: normalizeRowProps(schema, props) };
}

/** Insert a row on behalf of a form (submitters need not have edit access to the database). */
async function insertRow(dbId: string, title: string, props: Record<string, any>, createdBy: string | null) {
  const db = await one<{ workspace_id: string; teamspace_id: string | null; owner_id: string | null }>(
    `select workspace_id, teamspace_id, owner_id from pages where id = $1 and kind = 'database' and deleted_at is null`, [dbId],
  );
  if (!db) fail(404, 'Form not found');
  const schema = await getSchema(dbId);
  if (schema.some((p) => p.type === 'unique_id')) {
    const r = await one(`select coalesce(max((props->>'__uid')::int), 0) + 1 as n from pages where parent_id = $1 and kind = 'row'`, [dbId]);
    props.__uid = r.n;
  }
  const status = schema.find((p) => p.type === 'status');
  if (status && props[status.id] === undefined) props[status.id] = status.options?.[0]?.id ?? null;
  const position = await nextPosition(dbId, db!.teamspace_id, db!.owner_id);
  const row = await one<{ id: string }>(
    `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, props, position, created_by, updated_by)
     values ($1,$2,$3,$4,'row',$5,$6,$7,$8,$8) returning id`,
    [db!.workspace_id, dbId, db!.teamspace_id, db!.owner_id, title, props, position, createdBy],
  );
  await syncRelations(row!.id, dbId, {}, props);
  emit({ type: 'db', id: dbId });
  return row!.id;
}

async function formView(dbId: string, viewId: string) {
  const v = await one<{ id: string; database_id: string; type: string; config: any; name: string }>(
    'select id, database_id, type, config, name from database_views where id = $1 and database_id = $2', [viewId, dbId],
  );
  if (!v || v.type !== 'form') fail(404, 'Form not found');
  return v!;
}

async function publicForm(slug: string) {
  if (!/^[\w-]{10,40}$/.test(slug)) fail(404, 'Form not found');
  const v = await one<{ id: string; database_id: string; config: any; name: string; workspace_id: string; title: string }>(
    `select v.id, v.database_id, v.config, v.name, p.workspace_id, p.title from database_views v join pages p on p.id = v.database_id
     where v.type = 'form' and v.config->'form'->>'access' = 'link' and v.config->'form'->>'slug' = $1 and p.deleted_at is null`,
    [slug],
  );
  if (!v) fail(404, 'Form not found');
  if (!(await getSettings(v!.workspace_id)).allow_public_pages) fail(404, 'Form not found');
  return v!;
}

function formOut(v: { id: string; name: string; config: any }, schema: Prop[], dbTitle: string, publicMode: boolean) {
  const f = v.config?.form ?? {};
  return {
    viewId: v.id,
    title: f.title || dbTitle || v.name || 'Form',
    description: f.description ?? '',
    submitLabel: f.submitLabel || 'Submit',
    thankYou: f.thankYou || 'Thanks — your response was recorded.',
    access: f.access ?? 'members',
    questions: questionMeta(schema, f, publicMode),
  };
}

const ip = (req: FastifyRequest) => req.ip ?? 'unknown';

export default async function dbViewRoutes(app: FastifyInstance) {
  // ----- chart aggregation -----
  app.post<{ Params: { id: string }; Body: { viewId?: string; chart?: Partial<ChartConfig>; filter?: any; quickFilters?: any[]; search?: string } }>(
    '/databases/:id/aggregate',
    async (req) => {
      const user = requireUser(req);
      await assertPage(user, req.params.id, 'view');
      const b = req.body ?? {};
      let viewCfg: any = {};
      if (b.viewId) {
        const v = await one('select config from database_views where id = $1 and database_id = $2', [b.viewId, req.params.id]);
        if (!v) fail(404, 'View not found');
        viewCfg = v.config ?? {};
      }
      const chart = cleanChart(b.chart ?? viewCfg.chart);
      const filter = andFilters(viewCfg.filter, b.filter, ...(b.quickFilters ?? []));
      const { schema, rows } = await queryDatabase(user, req.params.id, { filter, search: b.search });
      return aggregate(rows as any, schema as any, chart, await userNames(user.workspaceId));
    },
  );

  // ----- button properties -----
  app.post<{ Params: { id: string; rowId: string; propId: string } }>('/databases/:id/rows/:rowId/button/:propId', async (req) => {
    const user = requireUser(req);
    const { id: dbId, rowId, propId } = req.params;
    await assertPage(user, dbId, 'view');
    const row = await one<{ id: string; props: any }>(`select id, props from pages where id = $1 and parent_id = $2 and kind = 'row' and deleted_at is null`, [rowId, dbId]);
    if (!row) fail(404, 'Row not found');
    const schema = await getSchema(dbId);
    const prop = schema.find((p) => p.id === propId && p.type === 'button');
    if (!prop) fail(404, 'Button not found');
    const result: { ok: true; ran: string[]; open?: string; created?: { id: string; title: string }[] } = { ok: true, ran: [] };
    const internal = { [INTERNAL_HEADER]: `${INTERNAL_KEY}:${user.id}`, 'content-type': 'application/json' };
    for (const a of (prop!.button?.actions ?? []) as any[]) {
      if (a.type === 'setProps') {
        if (!atLeast(await pageLevel(user, rowId), 'edit')) fail(403, 'You need edit access to this page to use this button');
        const patch = normalizeRowProps(schema, resolveButtonProps(a.props, user.id));
        await q('update pages set props = props || $2, updated_at = now(), updated_by = $3 where id = $1', [rowId, patch, user.id]);
        await syncRelations(rowId, dbId, row!.props ?? {}, patch);
        emit({ type: 'db', id: dbId });
        emit({ type: 'page', id: rowId });
        result.ran.push('setProps');
      } else if (a.type === 'addRow') {
        const r = await app.inject({ method: 'POST', url: `/api/v1/databases/${a.databaseId}/rows`, headers: internal, payload: { title: a.title ?? '', props: resolveButtonProps(a.props ?? {}, user.id) } });
        if (r.statusCode >= 400) fail(r.statusCode, JSON.parse(r.body || '{}').error ?? 'Could not add the page');
        const created = JSON.parse(r.body);
        (result.created ??= []).push({ id: created.id, title: created.title ?? '' });
        result.ran.push('addRow');
      } else if (a.type === 'insert' && (a.blocks?.length || a.markdown)) {
        const payload = a.blocks?.length ? { blocks: a.blocks, mode: 'append' } : { rich: a.markdown, mode: 'append' };
        const r = await app.inject({ method: 'PUT', url: `/api/v1/pages/${rowId}/content`, headers: internal, payload });
        if (r.statusCode >= 400) fail(r.statusCode, JSON.parse(r.body || '{}').error ?? 'Could not insert content');
        result.ran.push('insert');
      } else if (a.type === 'open' && a.target) {
        result.open = a.target;
        result.ran.push('open');
      }
    }
    await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'database.button_clicked', targetType: 'page', targetId: rowId, meta: { prop: prop!.name, actions: result.ran } });
    return result;
  });

  // ----- page verification (Notion wiki "Verified") -----
  app.post<{ Params: { id: string }; Body: { state?: 'verified' | 'unverified' | null; until?: string | null } }>('/pages/:id/verification', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const b = req.body ?? {};
    if (!b.state) {
      await q(`update pages set props = props - '__verification' where id = $1`, [req.params.id]);
      await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.verification_removed', targetType: 'page', targetId: req.params.id });
    } else {
      const v = cleanVerification({ state: b.state, by: user.id, at: new Date().toISOString(), until: b.until ?? undefined });
      if (v!.until && new Date(v!.until).getTime() <= Date.now()) fail(400, 'Verification expiry must be in the future');
      await q(`update pages set props = props || jsonb_build_object('__verification', $2::jsonb) where id = $1`, [req.params.id, JSON.stringify(v)]);
      await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.verified', targetType: 'page', targetId: req.params.id, meta: { state: v!.state, until: v!.until ?? null } });
    }
    emit({ type: 'page', id: req.params.id });
    const page = await one<{ props: any }>('select props from pages where id = $1', [req.params.id]);
    return { verification: page?.props?.__verification ?? null };
  });

  // ----- forms: members -----
  app.get<{ Params: { id: string; viewId: string } }>('/databases/:id/forms/:viewId', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const v = await formView(req.params.id, req.params.viewId);
    const db = await one<{ title: string }>('select title from pages where id = $1', [req.params.id]);
    return formOut(v, await getSchema(req.params.id), db?.title ?? '', false);
  });

  app.post<{ Params: { id: string; viewId: string }; Body: { answers?: Record<string, any> } }>('/databases/:id/forms/:viewId/submit', async (req, reply) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const v = await formView(req.params.id, req.params.viewId);
    if (!(await allow(`form:${v.id}:user:${user.id}`, 60))) fail(429, 'Too many submissions — try again in a few minutes');
    const schema = await getSchema(req.params.id);
    let parsed;
    try {
      parsed = await validateAnswers(schema, v.config?.form, req.body?.answers ?? {}, false, user.workspaceId);
    } catch (e: any) {
      if (e.fieldErrors) return reply.status(400).send({ error: e.message, fields: e.fieldErrors });
      throw e;
    }
    const rowId = await insertRow(req.params.id, parsed.title, { ...parsed.props, __form: { viewId: v.id } }, user.id);
    await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'form.submission', targetType: 'page', targetId: rowId, meta: { viewId: v.id, databaseId: req.params.id, access: 'members' } });
    return { ok: true, id: rowId, thankYou: v.config?.form?.thankYou || 'Thanks — your response was recorded.' };
  });

  // ----- forms: public link (/f/<slug>) -----
  app.get<{ Params: { slug: string } }>('/public/forms/:slug', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('cache-control', 'private, no-store');
    const v = await publicForm(req.params.slug);
    return formOut(v, await getSchema(v.database_id), v.title, true);
  });

  app.post<{ Params: { slug: string }; Body: { answers?: Record<string, any> } }>('/public/forms/:slug/submit', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    const v = await publicForm(req.params.slug);
    if (!(await allow(`form:${v.id}:ip:${ip(req)}`, 10))) {
      await audit({ workspaceId: v.workspace_id, action: 'form.submission_rate_limited', targetType: 'view', targetId: v.id, ip: ip(req) });
      fail(429, 'Too many submissions from your network — try again in a few minutes');
    }
    const schema = await getSchema(v.database_id);
    let parsed;
    try {
      parsed = await validateAnswers(schema, v.config?.form, req.body?.answers ?? {}, true, v.workspace_id);
    } catch (e: any) {
      if (e.fieldErrors) return reply.status(400).send({ error: e.message, fields: e.fieldErrors });
      throw e;
    }
    const rowId = await insertRow(v.database_id, parsed.title, { ...parsed.props, __form: { viewId: v.id, public: true } }, null);
    await audit({ workspaceId: v.workspace_id, action: 'form.submission', targetType: 'page', targetId: rowId, meta: { viewId: v.id, databaseId: v.database_id, access: 'link' }, ip: ip(req) });
    return { ok: true, thankYou: v.config?.form?.thankYou || 'Thanks — your response was recorded.' };
  });
}

export type { AuthUser };
