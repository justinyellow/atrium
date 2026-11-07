/**
 * SCIM 2.0 (RFC 7643/7644) for IdPs that push users and groups (Okta, Entra ID, OneLogin, …).
 * Mounted at /scim/v2. Auth: `Authorization: Bearer scim_…` (token generated in Settings → SSO & provisioning).
 * Deleting a user deactivates it (content is kept); owners can't be changed via SCIM.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashPassword, sha256 } from '../auth.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { config } from '../config.js';
import { applyNewMemberDefaults } from '../workspaceSettings.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

class ScimError extends Error {
  constructor(public status: number, message: string, public scimType?: string) {
    super(message);
  }
}

interface Ctx { workspaceId: string; tokenId: string; base: string }
declare module 'fastify' {
  interface FastifyRequest { scim?: Ctx }
}

function base(req: FastifyRequest) {
  if (config.publicUrl) return `${config.publicUrl}/scim/v2`;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0].trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0].trim() ?? req.headers.host;
  return `${proto}://${host}/scim/v2`;
}

// ---------- representations ----------

async function userResource(ctx: Ctx, id: string) {
  const u = await one(
    `select u.id, u.email, u.name, u.active, u.created_at, m.role,
       (select subject from user_identities i where i.user_id = u.id and i.provider = 'scim' limit 1) as external_id
     from users u join workspace_members m on m.user_id = u.id and m.workspace_id = $2 where u.id = $1`,
    [id, ctx.workspaceId],
  );
  if (!u) throw new ScimError(404, `User ${id} not found`);
  const groups = await q(`select g.id, g.name from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 and g.workspace_id = $2`, [id, ctx.workspaceId]);
  return toUser(ctx, u, groups);
}

function toUser(ctx: Ctx, u: any, groups: any[] = []) {
  const [given, ...rest] = String(u.name ?? '').split(' ');
  return {
    schemas: [USER],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: u.email,
    name: { formatted: u.name, givenName: given, familyName: rest.join(' ') || undefined },
    displayName: u.name,
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: u.active,
    groups: groups.map((g) => ({ value: g.id, display: g.name, $ref: `${ctx.base}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: u.created_at, location: `${ctx.base}/Users/${u.id}` },
  };
}

async function groupResource(ctx: Ctx, id: string, excludeMembers = false) {
  const g = await one(`select id, name, external_id from groups where id = $1 and workspace_id = $2`, [id, ctx.workspaceId]);
  if (!g) throw new ScimError(404, `Group ${id} not found`);
  const members = excludeMembers ? [] : await q(`select u.id, u.name from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1`, [id]);
  return {
    schemas: [GROUP],
    id: g.id,
    externalId: g.external_id ?? undefined,
    displayName: g.name,
    members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${ctx.base}/Users/${m.id}` })),
    meta: { resourceType: 'Group', location: `${ctx.base}/Groups/${g.id}` },
  };
}

function listResponse(resources: any[], total: number, startIndex: number) {
  return { schemas: [LIST], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** Supports the filters IdPs actually send: `attr eq "value"` (optionally combined with `and`). */
function parseFilter(filter?: string): { attr: string; value: string }[] {
  if (!filter) return [];
  const out: { attr: string; value: string }[] = [];
  for (const part of filter.split(/\s+and\s+/i)) {
    const m = part.trim().match(/^([\w.:]+(?:\[[^\]]*\])?(?:\.\w+)?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
    if (!m) throw new ScimError(400, `Unsupported filter: ${part}`, 'invalidFilter');
    out.push({ attr: m[1].toLowerCase().replace(/^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/, ''), value: m[2].replace(/\\"/g, '"') });
  }
  return out;
}

// ---------- user mutations ----------

function emailFrom(body: any): string | undefined {
  const primary = Array.isArray(body.emails) ? (body.emails.find((e: any) => e.primary) ?? body.emails[0])?.value : undefined;
  const v = primary ?? (typeof body.userName === 'string' && body.userName.includes('@') ? body.userName : undefined);
  return v ? String(v).toLowerCase().trim() : undefined;
}
function nameFrom(body: any): string | undefined {
  const n = body.name;
  return body.displayName || n?.formatted || [n?.givenName, n?.familyName].filter(Boolean).join(' ') || undefined;
}

async function setActive(ctx: Ctx, userId: string, active: boolean) {
  const m = await one<{ role: string; active: boolean }>(
    `select m.role, u.active from workspace_members m join users u on u.id = m.user_id where m.user_id = $1 and m.workspace_id = $2`,
    [userId, ctx.workspaceId],
  );
  if (!m) throw new ScimError(404, 'User not found');
  if (m.active === active) return;
  if (!active && m.role === 'owner') throw new ScimError(403, 'Workspace owners cannot be deactivated via SCIM');
  await q(`update users set active = $2, deactivated_by = case when $2 then null else 'scim' end where id = $1`, [userId, active]);
  if (!active) await q('delete from sessions where user_id = $1', [userId]);
  await audit({ workspaceId: ctx.workspaceId, action: active ? 'scim.user_reactivated' : 'scim.user_deactivated', targetType: 'user', targetId: userId, meta: { tokenId: ctx.tokenId } });
  emit({ type: 'members' });
}

async function updateUser(ctx: Ctx, userId: string, f: { name?: string; email?: string; active?: boolean; externalId?: string }) {
  if (f.name) await q('update users set name = $2 where id = $1', [userId, f.name]);
  if (f.email) {
    const taken = await one('select id from users where email = $1 and id <> $2', [f.email, userId]);
    if (taken) throw new ScimError(409, `Email ${f.email} is already in use`, 'uniqueness');
    await q('update users set email = $2 where id = $1', [userId, f.email]);
  }
  if (f.externalId !== undefined) {
    await q(`delete from user_identities where user_id = $1 and provider = 'scim'`, [userId]);
    if (f.externalId) {
      await q(
        `insert into user_identities(user_id, provider, subject, email) values ($1,'scim',$2,$3)
         on conflict (provider, subject) do update set user_id = excluded.user_id`,
        [userId, f.externalId, f.email ?? null],
      );
    }
  }
  if (f.active !== undefined) await setActive(ctx, userId, f.active);
  if (f.name || f.email) {
    await audit({ workspaceId: ctx.workspaceId, action: 'scim.user_updated', targetType: 'user', targetId: userId, meta: { name: f.name, email: f.email, tokenId: ctx.tokenId } });
    emit({ type: 'members' });
  }
}

const isTrue = (v: any) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

/** Translate PATCH ops (path-style and Entra-style value objects) into field updates. */
function userPatchFields(ops: any[]) {
  const f: { name?: string; email?: string; active?: boolean; externalId?: string; given?: string; family?: string } = {};
  const apply = (path: string, value: any) => {
    const p = path.toLowerCase();
    if (p === 'active') f.active = isTrue(value);
    else if (p === 'displayname' || p === 'name.formatted') f.name = String(value);
    else if (p === 'name.givenname') f.given = String(value);
    else if (p === 'name.familyname') f.family = String(value);
    else if (p === 'name' && typeof value === 'object') { f.given = value.givenName ?? f.given; f.family = value.familyName ?? f.family; if (value.formatted) f.name = value.formatted; }
    else if (p === 'username') f.email = String(value).toLowerCase();
    else if (p.startsWith('emails')) {
      const v = Array.isArray(value) ? (value.find((e: any) => e.primary) ?? value[0])?.value : typeof value === 'object' ? value.value : value;
      if (v) f.email = String(v).toLowerCase();
    } else if (p === 'externalid') f.externalId = String(value);
  };
  for (const op of ops ?? []) {
    const kind = String(op.op ?? '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add') continue; // remove on users: nothing meaningful to remove
    if (op.path) apply(op.path, op.value);
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) apply(k, v);
  }
  return f;
}

// ---------- group mutations ----------

async function memberIds(ctx: Ctx, values: any[]): Promise<string[]> {
  const ids = (values ?? []).map((v: any) => String(v?.value ?? v)).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  if (!ids.length) return [];
  const rows = await q<{ user_id: string }>(`select user_id from workspace_members where workspace_id = $1 and user_id = any($2::uuid[])`, [ctx.workspaceId, ids]);
  return rows.map((r) => r.user_id);
}

async function setMembers(groupId: string, ids: string[]) {
  await q('delete from group_members where group_id = $1', [groupId]);
  for (const id of ids) await q('insert into group_members(group_id, user_id) values ($1,$2) on conflict do nothing', [groupId, id]);
}

export default async function scimRoutes(app: FastifyInstance) {
  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e: any) {
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof ScimError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : err.code === '22P02' ? 404 : 500;
    if (status === 500) console.error(err);
    return reply
      .status(status)
      .type('application/scim+json')
      .send({ schemas: [ERROR], status: String(status), detail: status === 500 ? 'Internal error' : err.message, ...(err.scimType ? { scimType: err.scimType } : {}) });
  });

  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new ScimError(401, 'Bearer token required');
    const t = await one<{ id: string; workspace_id: string }>('select id, workspace_id from scim_tokens where token_hash = $1 and revoked_at is null', [sha256(h.slice(7))]);
    if (!t) throw new ScimError(401, 'Invalid or revoked SCIM token');
    q('update scim_tokens set last_used_at = now() where id = $1', [t.id]).catch(() => {});
    req.scim = { workspaceId: t.workspace_id, tokenId: t.id, base: base(req) };
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('application/json')) reply.type('application/scim+json');
    return payload;
  });

  const ctx = (req: FastifyRequest) => req.scim!;
  const created = (reply: FastifyReply, body: any) => reply.status(201).header('location', body.meta.location).send(body);

  // ---------- discovery ----------
  app.get('/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'SCIM token from Settings → SSO & provisioning', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig' },
  }));
  app.get('/ResourceTypes', async (req) => {
    const b = ctx(req).base;
    const rt = (id: string, schema: string) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id, name: id, endpoint: `/${id}s`, schema,
      meta: { resourceType: 'ResourceType', location: `${b}/ResourceTypes/${id}` },
    });
    return listResponse([rt('User', USER), rt('Group', GROUP)], 2, 1);
  });
  app.get('/Schemas', async () => {
    const attr = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', caseExact: false, ...extra });
    const user = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], id: USER, name: 'User', attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('name', 'complex'), attr('displayName'),
      attr('emails', 'complex', { multiValued: true }), attr('active', 'boolean'), attr('externalId'), attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' }),
    ] };
    const group = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], id: GROUP, name: 'Group', attributes: [
      attr('displayName', 'string', { required: true }), attr('members', 'complex', { multiValued: true }), attr('externalId'),
    ] };
    return listResponse([user, group], 2, 1);
  });

  // ---------- Users ----------
  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/Users', async (req) => {
    const c = ctx(req);
    const start = Math.max(1, Number(req.query.startIndex ?? 1));
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)));
    const where: string[] = ['m.workspace_id = $1'];
    const params: any[] = [c.workspaceId];
    for (const f of parseFilter(req.query.filter)) {
      params.push(f.value);
      const p = `$${params.length}`;
      if (f.attr === 'username' || f.attr === 'emails.value' || f.attr === 'emails[type eq "work"].value' || f.attr === 'emails') where.push(`lower(u.email) = lower(${p})`);
      else if (f.attr === 'externalid') where.push(`exists (select 1 from user_identities i where i.user_id = u.id and i.provider = 'scim' and i.subject = ${p})`);
      else if (f.attr === 'id') where.push(`u.id::text = ${p}`);
      else if (f.attr === 'displayname') where.push(`u.name = ${p}`);
      else throw new ScimError(400, `Unsupported filter attribute: ${f.attr}`, 'invalidFilter');
    }
    const w = where.join(' and ');
    const total = (await one<{ n: number }>(`select count(*)::int as n from users u join workspace_members m on m.user_id = u.id where ${w}`, params))!.n;
    const rows = await q(
      `select u.id, u.email, u.name, u.active, u.created_at,
         (select subject from user_identities i where i.user_id = u.id and i.provider = 'scim' limit 1) as external_id
       from users u join workspace_members m on m.user_id = u.id where ${w} order by u.created_at offset ${start - 1} limit ${count}`,
      params,
    );
    return listResponse(rows.map((r) => toUser(c, r)), total, start);
  });

  app.get<{ Params: { id: string } }>('/Users/:id', async (req) => userResource(ctx(req), req.params.id));

  app.post<{ Body: Record<string, any> }>('/Users', async (req, reply) => {
    const c = ctx(req);
    const body = req.body ?? {};
    const email = emailFrom(body);
    if (!email || !email.includes('@')) throw new ScimError(400, 'userName or emails must contain an email address', 'invalidValue');
    const name = nameFrom(body) ?? email.split('@')[0];
    let user = await one<{ id: string }>('select id from users where email = $1', [email]);
    if (user && (await one('select 1 from workspace_members where user_id = $1 and workspace_id = $2', [user.id, c.workspaceId]))) {
      throw new ScimError(409, `User ${email} already exists`, 'uniqueness');
    }
    if (!user) {
      user = await one<{ id: string }>('insert into users(email, name, password_hash) values ($1,$2,$3) returning id', [
        email, name, await hashPassword(randomBytes(32).toString('hex')),
      ]);
    }
    await q(`insert into workspace_members(workspace_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [c.workspaceId, user!.id]);
    await applyNewMemberDefaults(user!.id, 'member');
    await updateUser(c, user!.id, { externalId: body.externalId, active: body.active === undefined ? undefined : isTrue(body.active) });
    await audit({ workspaceId: c.workspaceId, action: 'scim.user_created', targetType: 'user', targetId: user!.id, meta: { email, tokenId: c.tokenId } });
    emit({ type: 'members' });
    return created(reply, await userResource(c, user!.id));
  });

  app.put<{ Params: { id: string }; Body: Record<string, any> }>('/Users/:id', async (req) => {
    const c = ctx(req);
    await userResource(c, req.params.id); // 404 check
    const body = req.body ?? {};
    await updateUser(c, req.params.id, {
      name: nameFrom(body), email: emailFrom(body), externalId: body.externalId,
      active: body.active === undefined ? undefined : isTrue(body.active),
    });
    return userResource(c, req.params.id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, any> }>('/Users/:id', async (req) => {
    const c = ctx(req);
    await userResource(c, req.params.id);
    const f = userPatchFields(req.body?.Operations);
    if ((f.given || f.family) && !f.name) {
      const cur = await one<{ name: string }>('select name from users where id = $1', [req.params.id]);
      const [g, ...rest] = (cur?.name ?? '').split(' ');
      f.name = [f.given ?? g, f.family ?? rest.join(' ')].filter(Boolean).join(' ');
    }
    await updateUser(c, req.params.id, f);
    return userResource(c, req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
    const c = ctx(req);
    await userResource(c, req.params.id);
    await setActive(c, req.params.id, false); // soft delete: keep their content
    return reply.status(204).send();
  });

  // ---------- Groups ----------
  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string } }>('/Groups', async (req) => {
    const c = ctx(req);
    const start = Math.max(1, Number(req.query.startIndex ?? 1));
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)));
    const where: string[] = ['workspace_id = $1'];
    const params: any[] = [c.workspaceId];
    for (const f of parseFilter(req.query.filter)) {
      params.push(f.value);
      if (f.attr === 'displayname') where.push(`name = $${params.length}`);
      else if (f.attr === 'externalid') where.push(`external_id = $${params.length}`);
      else if (f.attr === 'id') where.push(`id::text = $${params.length}`);
      else throw new ScimError(400, `Unsupported filter attribute: ${f.attr}`, 'invalidFilter');
    }
    const w = where.join(' and ');
    const total = (await one<{ n: number }>(`select count(*)::int as n from groups where ${w}`, params))!.n;
    const rows = await q<{ id: string }>(`select id from groups where ${w} order by name offset ${start - 1} limit ${count}`, params);
    const exclude = (req.query.excludedAttributes ?? '').toLowerCase().includes('members');
    return listResponse(await Promise.all(rows.map((r) => groupResource(c, r.id, exclude))), total, start);
  });

  app.get<{ Params: { id: string } }>('/Groups/:id', async (req) => groupResource(ctx(req), req.params.id));

  app.post<{ Body: Record<string, any> }>('/Groups', async (req, reply) => {
    const c = ctx(req);
    const name = String(req.body?.displayName ?? '').trim();
    if (!name) throw new ScimError(400, 'displayName is required', 'invalidValue');
    if (await one('select 1 from groups where workspace_id = $1 and name = $2', [c.workspaceId, name])) throw new ScimError(409, `Group ${name} already exists`, 'uniqueness');
    const g = await one<{ id: string }>(`insert into groups(workspace_id, name, source, external_id) values ($1,$2,'scim',$3) returning id`, [c.workspaceId, name, req.body?.externalId ?? null]);
    await setMembers(g!.id, await memberIds(c, req.body?.members));
    await audit({ workspaceId: c.workspaceId, action: 'scim.group_created', targetType: 'group', targetId: g!.id, meta: { name, tokenId: c.tokenId } });
    emit({ type: 'tree' });
    return created(reply, await groupResource(c, g!.id));
  });

  app.put<{ Params: { id: string }; Body: Record<string, any> }>('/Groups/:id', async (req) => {
    const c = ctx(req);
    await groupResource(c, req.params.id, true);
    if (req.body?.displayName) await q('update groups set name = $2 where id = $1', [req.params.id, req.body.displayName]);
    if (req.body?.externalId !== undefined) await q('update groups set external_id = $2 where id = $1', [req.params.id, req.body.externalId]);
    if (Array.isArray(req.body?.members)) await setMembers(req.params.id, await memberIds(c, req.body.members));
    await audit({ workspaceId: c.workspaceId, action: 'scim.group_updated', targetType: 'group', targetId: req.params.id, meta: { tokenId: c.tokenId } });
    emit({ type: 'tree' });
    return groupResource(c, req.params.id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, any> }>('/Groups/:id', async (req, reply) => {
    const c = ctx(req);
    await groupResource(c, req.params.id, true);
    const changes: Record<string, unknown> = {};
    for (const op of req.body?.Operations ?? []) {
      const kind = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '');
      const m = path.match(/^members\[value eq "([^"]+)"\]$/i);
      if (path.toLowerCase() === 'members' || (!path && op.value?.members) || m) {
        const values = m ? [{ value: m[1] }] : Array.isArray(op.value) ? op.value : op.value?.members ?? (op.value ? [op.value] : []);
        if (kind === 'add') {
          for (const id of await memberIds(c, values)) await q('insert into group_members(group_id, user_id) values ($1,$2) on conflict do nothing', [req.params.id, id]);
          changes.added = values.length;
        } else if (kind === 'remove') {
          const ids = m ? [m[1]] : values.length ? values.map((v: any) => String(v.value ?? v)) : null;
          if (ids) await q('delete from group_members where group_id = $1 and user_id::text = any($2::text[])', [req.params.id, ids]);
          else await q('delete from group_members where group_id = $1', [req.params.id]);
          changes.removed = ids?.length ?? 'all';
        } else if (kind === 'replace') {
          await setMembers(req.params.id, await memberIds(c, values));
          changes.replaced = values.length;
        }
      } else if (kind === 'replace' || kind === 'add') {
        const name = path.toLowerCase() === 'displayname' ? op.value : op.value?.displayName;
        if (name) { await q('update groups set name = $2 where id = $1', [req.params.id, String(name)]); changes.name = name; }
        const ext = path.toLowerCase() === 'externalid' ? op.value : op.value?.externalId;
        if (ext !== undefined) await q('update groups set external_id = $2 where id = $1', [req.params.id, ext]);
      }
    }
    await audit({ workspaceId: c.workspaceId, action: 'scim.group_updated', targetType: 'group', targetId: req.params.id, meta: { ...changes, tokenId: c.tokenId } });
    emit({ type: 'tree' });
    // RFC 7644 allows 204 or 200 with the resource; Entra/Okta handle both.
    return reply.status(200).send(await groupResource(c, req.params.id));
  });

  app.delete<{ Params: { id: string } }>('/Groups/:id', async (req, reply) => {
    const c = ctx(req);
    await groupResource(c, req.params.id, true);
    await q('delete from groups where id = $1', [req.params.id]);
    await audit({ workspaceId: c.workspaceId, action: 'scim.group_deleted', targetType: 'group', targetId: req.params.id, meta: { tokenId: c.tokenId } });
    emit({ type: 'tree' });
    return reply.status(204).send();
  });
}
