import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { fail, hashPassword, randomToken, requireUser, type AuthUser } from '../auth.js';
import { one, q } from '../db.js';
import { emit } from '../events.js';
import { assertPage, atLeast, pageLevel, visibleTree, RANK, type Level } from '../perms.js';
import { breadcrumbs, descendants, duplicateTree, isDescendant, nextPosition, PAGE_COLS } from '../pageOps.js';
import { hocuspocus, loadDocSnapshot, persistDoc, replaceDocContent, withDoc, FRAGMENT } from '../collab.js';
import { blocksToDoc, docToBlocks, docToMarkdown, markdownToDoc } from '../markdown.js';
import { notify } from '../notify.js';
import { createDatabase, normalizeRowPropsFor, syncRelations } from './databases.js';
import { audit } from '../audit.js';
import { applyContentUpdates, blocksToRich, createMissingSubpages, locate, patchTopLevel, refTitles, richToBlocks, verifyRefs, type ContentUpdate } from '../richmd/index.js';
import { config } from '../config.js';
import { assertExportsAllowed, assertPublishAllowed, getSettings } from '../workspaceSettings.js';

async function teamspaceAccess(user: AuthUser, teamspaceId: string): Promise<Level> {
  if (user.role === 'guest') return 'none';
  const t = await one(
    `select t.is_default, t.default_level, m.role from teamspaces t
     left join teamspace_members m on m.teamspace_id = t.id and m.user_id = $2 where t.id = $1`,
    [teamspaceId, user.id],
  );
  if (!t) return 'none';
  if (t.role === 'owner') return 'full';
  return t.role || t.is_default ? t.default_level : 'none';
}

export async function createPage(
  user: AuthUser,
  body: {
    parentId?: string | null;
    teamspaceId?: string | null;
    title?: string;
    icon?: string | null;
    kind?: 'page' | 'database' | 'row';
    props?: Record<string, unknown>;
    markdown?: string;
    blocks?: any[];
    templateId?: string;
    isTemplate?: boolean;
    position?: number;
    /** kind 'database' only: initial views (replace the default "Table" view). */
    views?: { name?: string; type?: string; config?: any }[];
  },
) {
  let parent: any = null;
  let teamspaceId: string | null = null;
  let ownerId: string | null = user.id;
  if (body.parentId) {
    parent = await one('select id, kind, teamspace_id, owner_id from pages where id = $1 and deleted_at is null', [body.parentId]);
    if (!parent) fail(404, 'Parent not found');
    await assertPage(user, parent.id, 'edit');
    teamspaceId = parent.teamspace_id;
    ownerId = parent.owner_id;
  } else if (body.teamspaceId) {
    if (!atLeast(await teamspaceAccess(user, body.teamspaceId), 'edit')) fail(403, 'No access to teamspace');
    teamspaceId = body.teamspaceId;
  } else if (user.role === 'guest') {
    fail(403, 'Guests cannot create private pages');
  }
  let kind = body.kind ?? 'page';
  if (parent?.kind === 'database') kind = 'row';
  if (kind === 'row' && parent?.kind !== 'database') fail(400, 'Rows must have a database parent');

  if (body.templateId) {
    const tpl = await one('select parent_id, title from pages where id = $1 and is_template', [body.templateId]);
    if (!tpl || tpl.parent_id !== body.parentId) fail(400, 'Invalid template');
    const id = await duplicateTree(body.templateId, user.id, {
      parent_id: body.parentId ?? null,
      title: body.title ?? tpl.title,
      position: body.position ?? (await nextPosition(body.parentId ?? null, teamspaceId, ownerId)),
      is_template: false,
    });
    if (body.props) await q(`update pages set props = props || $2 where id = $1`, [id, body.props]);
    emit(kind === 'row' ? { type: 'db', id: body.parentId! } : { type: 'tree' });
    return one(`select ${PAGE_COLS} from pages where id = $1`, [id]);
  }

  const position = body.position ?? (await nextPosition(body.parentId ?? null, teamspaceId, ownerId));
  const page = await one(
    `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, icon, props, position, is_template, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning ${PAGE_COLS}`,
    [
      user.workspaceId,
      body.parentId ?? null,
      teamspaceId,
      ownerId,
      kind,
      body.title ?? '',
      body.icon ?? null,
      body.props ?? {},
      position,
      body.isTemplate ?? false,
      user.id,
    ],
  );
  if (kind === 'database') await createDatabase(page.id, undefined, Array.isArray(body.views) ? body.views : undefined);
  if (body.markdown || body.blocks) {
    const doc = body.blocks ? blocksToDoc(body.blocks) : await markdownToDoc(body.markdown!);
    await persistDoc(page.id, doc, user.id);
  }
  emit(kind === 'row' ? { type: 'db', id: body.parentId! } : { type: 'tree' });
  return page;
}

export async function getPageDto(user: AuthUser, id: string) {
  const level = await assertPage(user, id, 'view');
  const page = await one(`select ${PAGE_COLS} from pages where id = $1`, [id]);
  const [crumbs, fav, creator, editor, db] = await Promise.all([
    breadcrumbs(id),
    one('select 1 as f from favorites where user_id = $1 and page_id = $2', [user.id, id]),
    page.created_by ? one('select id, name, avatar_url from users where id = $1', [page.created_by]) : null,
    page.updated_by ? one('select id, name, avatar_url from users where id = $1', [page.updated_by]) : null,
    page.kind === 'row' ? one('select schema from databases where page_id = $1', [page.parent_id]) : null,
  ]);
  const ts = page.teamspace_id ? await one('select id, name, icon from teamspaces where id = $1', [page.teamspace_id]) : null;
  // Copy of a page in a linked Notion workspace (kept in sync until the link is removed).
  const mirror = await one<{ source_id: string; synced_at: string; status: string }>(
    `select m.source_id, m.updated_at as synced_at, l.status from import_mappings m join notion_links l on l.workspace_id = $2
     where m.source = 'notion' and m.atrium_id = $1 and m.kind in ('page', 'database', 'row', 'template')`,
    [id, user.workspaceId],
  );
  return {
    ...page,
    level,
    breadcrumbs: crumbs,
    favorite: !!fav,
    created_by_user: creator,
    updated_by_user: editor,
    teamspace: ts,
    parent_schema: db?.schema ?? null,
    notion_sync: mirror
      ? { url: `https://www.notion.so/${mirror.source_id.replace(/-/g, '')}`, synced_at: mirror.synced_at, paused: mirror.status !== 'active' }
      : null,
  };
}

export async function trashPage(user: AuthUser, id: string) {
  await assertPage(user, id, 'full');
  const ids = await descendants(id, false);
  const p = await one('update pages set deleted_at = now(), deleted_by = $2 where id = any($1::uuid[]) returning kind, parent_id', [ids, user.id]);
  const page = await one('select kind, parent_id from pages where id = $1', [id]);
  emit(page.kind === 'row' ? { type: 'db', id: page.parent_id } : { type: 'tree' });
  return p;
}

/** Base URL for links in rich markdown: explicit (validated) override, PUBLIC_URL, or forwarded headers. */
function contentBase(req: any, override?: string): string {
  if (override && /^https?:\/\/[^\s/]+/.test(override)) return override.replace(/\/+$/, '');
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Loads synced-block sources for exports, only where the reader has access. */
const syncedLoader = (user: AuthUser) => async (id: string) =>
  atLeast(await pageLevel(user, id), 'view') ? loadDocSnapshot(id) : null;

export default async function pageRoutes(app: FastifyInstance) {
  app.get('/tree', async (req) => {
    const user = requireUser(req);
    const [pages, teamspaces, favorites] = await Promise.all([
      visibleTree(user),
      q(
        `select t.id, t.name, t.icon, t.description, t.is_default, t.default_level, t.position, m.role as my_role,
           (select count(*) from teamspace_members x where x.teamspace_id = t.id)::int as member_count
         from teamspaces t left join teamspace_members m on m.teamspace_id = t.id and m.user_id = $2
         where t.workspace_id = $1 and (m.user_id is not null or (t.is_default and $3)) order by t.position, t.created_at`,
        [user.workspaceId, user.id, user.role !== 'guest'],
      ),
      q(
        `select f.page_id as id, p.title, p.icon, p.kind from favorites f join pages p on p.id = f.page_id
         where f.user_id = $1 and p.deleted_at is null order by f.position`,
        [user.id],
      ),
    ]);
    const visibleIds = new Set(pages.map((p) => p.id));
    // "Shared": roots I can see that live in someone else's private space.
    const shared = pages
      .filter((p) => !p.teamspace_id && p.owner_id !== user.id && (!p.parent_id || !visibleIds.has(p.parent_id)))
      .map((p) => p.id);
    return {
      pages: pages.map(({ owner_id, ...p }) => ({ ...p, private: !p.teamspace_id && owner_id === user.id })),
      teamspaces,
      favorites: favorites.filter((f) => visibleIds.has(f.id) || f.kind === 'row'),
      shared,
    };
  });

  app.get<{ Params: { id: string } }>('/pages/:id', async (req) => getPageDto(requireUser(req), req.params.id));

  app.post<{ Body: any }>('/pages', async (req) => createPage(requireUser(req), req.body ?? {}));

  app.patch<{ Params: { id: string }; Body: any }>('/pages/:id', async (req) => {
    const user = requireUser(req);
    const level = await assertPage(user, req.params.id, 'edit');
    const b: any = req.body ?? {};
    const page = await one('select kind, parent_id, locked, props from pages where id = $1', [req.params.id]);
    if (page.locked && b.locked !== false && !atLeast(level, 'full')) fail(403, 'Page is locked');
    const sets: string[] = [];
    const vals: any[] = [];
    const set = (col: string, v: any) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length + 1}`);
    };
    for (const k of ['title', 'icon', 'cover', 'cover_position', 'full_width', 'small_text', 'locked', 'is_template'] as const) {
      if (b[k] !== undefined) set(k, b[k]);
    }
    if (b.props && page.kind === 'row') b.props = await normalizeRowPropsFor(page.parent_id, b.props); // ISO dates, person limits
    if (b.props) {
      vals.push(b.props);
      sets.push(`props = props || $${vals.length + 1}`);
      // notify people newly assigned via person properties
      for (const [, v] of Object.entries(b.props)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'string' && /^[0-9a-f-]{36}$/.test(v[0])) {
          for (const uid of v as string[]) {
            const before = Object.values(page.props ?? {}).some((pv) => Array.isArray(pv) && pv.includes(uid));
            const isUser = await one('select 1 from users where id = $1', [uid]);
            if (!before && isUser) await notify(uid, 'assigned', user.id, req.params.id, {});
          }
        }
      }
    }
    if (!sets.length) return getPageDto(user, req.params.id);
    vals.push(user.id);
    sets.push('updated_at = now()', `updated_by = $${vals.length + 1}`);
    await q(`update pages set ${sets.join(', ')} where id = $1`, [req.params.id, ...vals]);
    emit({ type: 'page', id: req.params.id });
    if (page.kind === 'row') {
      if (b.props) await syncRelations(req.params.id, page.parent_id, page.props ?? {}, b.props);
      emit({ type: 'db', id: page.parent_id });
    } else if (b.title !== undefined || b.icon !== undefined) emit({ type: 'tree' });
    return getPageDto(user, req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { parentId?: string | null; teamspaceId?: string | null; position?: number; private?: boolean } }>(
    '/pages/:id/move',
    async (req) => {
      const user = requireUser(req);
      const id = req.params.id;
      await assertPage(user, id, 'full');
      const b: any = req.body ?? {};
      let teamspaceId: string | null = null;
      let ownerId: string | null = user.id;
      if (b.parentId) {
        if (b.parentId === id || (await isDescendant(b.parentId, id))) fail(400, 'Cannot move a page inside itself');
        await assertPage(user, b.parentId, 'edit');
        const parent = await one('select teamspace_id, owner_id, kind from pages where id = $1', [b.parentId]);
        if (parent.kind === 'database') fail(400, 'Use the database API to add rows');
        teamspaceId = parent.teamspace_id;
        ownerId = parent.owner_id;
      } else if (b.teamspaceId) {
        if (!atLeast(await teamspaceAccess(user, b.teamspaceId), 'edit')) fail(403, 'No access to teamspace');
        teamspaceId = b.teamspaceId;
      }
      const position = b.position ?? (await nextPosition(b.parentId ?? null, teamspaceId, ownerId));
      const ids = await descendants(id);
      await q('update pages set parent_id = $2, position = $3 where id = $1', [id, b.parentId ?? null, position]);
      await q('update pages set teamspace_id = $2, owner_id = $3 where id = any($1::uuid[])', [ids, teamspaceId, ownerId]);
      emit({ type: 'tree' });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/pages/:id/duplicate', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const p = await one('select parent_id, title, position, kind from pages where id = $1', [req.params.id]);
    if (p.parent_id) await assertPage(user, p.parent_id, 'edit');
    const id = await duplicateTree(req.params.id, user.id, { title: p.title ? `${p.title} (1)` : '', position: p.position + 0.5 });
    emit(p.kind === 'row' ? { type: 'db', id: p.parent_id } : { type: 'tree' });
    return getPageDto(user, id);
  });

  app.delete<{ Params: { id: string } }>('/pages/:id', async (req) => {
    await trashPage(requireUser(req), req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/pages/:id/restore', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const p = await one('select deleted_at, parent_id, kind from pages where id = $1', [req.params.id]);
    const ids = await descendants(req.params.id);
    await q('update pages set deleted_at = null, deleted_by = null where id = any($1::uuid[]) and deleted_at >= $2::timestamptz - interval \'1 second\'', [ids, p.deleted_at]);
    // If the parent is still in the trash, lift the page to the top level.
    if (p.parent_id) {
      const parent = await one('select deleted_at from pages where id = $1', [p.parent_id]);
      if (parent?.deleted_at) await q('update pages set parent_id = null where id = $1', [req.params.id]);
    }
    emit(p.kind === 'row' ? { type: 'db', id: p.parent_id } : { type: 'tree' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/pages/:id/permanent', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const p = await one('select deleted_at from pages where id = $1', [req.params.id]);
    if (!p?.deleted_at) fail(400, 'Move the page to trash first');
    const gone = await q('delete from pages where id = $1 returning title, kind', [req.params.id]);
    await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.deleted_permanently', targetType: 'page', targetId: req.params.id, meta: gone[0] ?? {}, ip: req.ip });
    emit({ type: 'tree' });
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string } }>('/trash', async (req) => {
    const user = requireUser(req);
    const rows = await q(
      `select p.id, p.title, p.icon, p.kind, p.deleted_at, p.parent_id, u.name as deleted_by_name,
         (select title from pages pp where pp.id = p.parent_id) as parent_title
       from pages p left join users u on u.id = p.deleted_by
       where p.workspace_id = $1 and p.deleted_at is not null
         and (p.parent_id is null or (select deleted_at from pages pp where pp.id = p.parent_id) is null
              or (select deleted_at from pages pp where pp.id = p.parent_id) <> p.deleted_at)
         and ($2::text is null or p.title ilike '%' || $2 || '%')
       order by p.deleted_at desc limit 200`,
      [user.workspaceId, req.query.q || null],
    );
    const out = [];
    for (const r of rows) if (atLeast(await pageLevel(user, r.id), 'full')) out.push(r);
    return out;
  });

  app.get<{ Params: { id: string } }>('/pages/:id/backlinks', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const rows = await q(
      `select p.id, p.title, p.icon from page_links l join pages p on p.id = l.source_id
       where l.target_id = $1 and p.deleted_at is null`,
      [req.params.id],
    );
    const out = [];
    for (const r of rows) if (atLeast(await pageLevel(user, r.id), 'view')) out.push(r);
    return out;
  });

  app.post<{ Params: { id: string } }>('/pages/:id/visit', async (req) => {
    const user = requireUser(req);
    await q(
      `insert into page_visits(user_id, page_id) values ($1,$2) on conflict (user_id, page_id) do update set visited_at = now()`,
      [user.id, req.params.id],
    );
    return { ok: true };
  });

  app.get('/recent', async (req) => {
    const user = requireUser(req);
    const rows = await q(
      `select p.id, p.title, p.icon, p.kind, p.cover, v.visited_at, p.updated_at,
         (select string_agg(x.title, ' / ') from pages x where x.id = p.parent_id) as parent_title
       from page_visits v join pages p on p.id = v.page_id
       where v.user_id = $1 and p.deleted_at is null order by v.visited_at desc limit 20`,
      [user.id],
    );
    const out = [];
    for (const r of rows) if (atLeast(await pageLevel(user, r.id), 'view')) out.push(r);
    return out;
  });

  app.put<{ Params: { id: string } }>('/favorites/:id', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    await q(
      `insert into favorites(user_id, page_id, position)
       values ($1,$2,(select coalesce(max(position),0)+1 from favorites where user_id = $1)) on conflict do nothing`,
      [user.id, req.params.id],
    );
    emit({ type: 'tree' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/favorites/:id', async (req) => {
    const user = requireUser(req);
    await q('delete from favorites where user_id = $1 and page_id = $2', [user.id, req.params.id]);
    emit({ type: 'tree' });
    return { ok: true };
  });

  // ----- content (API) -----
  // format=rich (lossless Notion-flavored Markdown, see server/src/richmd), markdown (lossy CommonMark), or blocks (default).
  app.get<{ Params: { id: string }; Querystring: { format?: string; base?: string } }>('/pages/:id/content', async (req, reply) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const doc = await loadDocSnapshot(req.params.id);
    if (req.query.format === 'markdown') {
      reply.type('text/markdown; charset=utf-8');
      return docToMarkdown(doc, syncedLoader(user));
    }
    if (req.query.format === 'rich') {
      const blocks = docToBlocks(doc);
      reply.type('text/markdown; charset=utf-8');
      return blocksToRich(blocks, { baseUrl: contentBase(req, req.query.base), titles: await refTitles(blocks) });
    }
    return { blocks: docToBlocks(doc) };
  });

  /**
   * Write page content. Input: `rich` (Atrium/Notion-flavored Markdown), `blocks`, or legacy `markdown`.
   * mode: replace (default) | append | prepend | insert_after | replace_range (both need `selection`)
   *       | update (Notion-style `updates: [{old_str, new_str, replace_all_matches}]` against the rich markdown).
   * Edits are block-granular: blocks outside the changed region keep their ids, comments and concurrent edits.
   */
  app.put<{
    Params: { id: string };
    Body: { markdown?: string; blocks?: any[]; rich?: string; mode?: string; selection?: string; updates?: ContentUpdate[]; base?: string };
  }>('/pages/:id/content', async (req) => {
    const user = requireUser(req);
    const pageId = req.params.id;
    await assertPage(user, pageId, 'edit');
    const b: any = req.body ?? {};
    const mode = b.mode ?? 'replace';
    if (!['replace', 'append', 'prepend', 'insert_after', 'replace_range', 'update'].includes(mode)) fail(400, `Unknown mode "${mode}"`);
    const base = contentBase(req, b.base);
    const warnings: string[] = [];
    const prev = docToBlocks(await loadDocSnapshot(pageId));

    const fromRich = async (text: string) => {
      const r = richToBlocks(text, { baseUrl: base });
      warnings.push(...r.warnings);
      const verified = await verifyRefs(r.blocks, user.workspaceId, warnings);
      await createMissingSubpages(verified, async (title) => (await createPage(user, { parentId: pageId, title })).id);
      return verified;
    };

    let next: any[];
    if (mode === 'update') {
      if (!Array.isArray(b.updates) || !b.updates.length) fail(400, 'mode "update" needs updates: [{old_str, new_str}]');
      const current = blocksToRich(prev, { baseUrl: base, titles: await refTitles(prev) });
      const { text, applied } = applyContentUpdates(current, b.updates, warnings);
      if (!applied) fail(400, `No update matched the page content. ${warnings.join(' ')}`.trim());
      next = await fromRich(text);
    } else {
      if (b.rich === undefined && b.markdown === undefined && !b.blocks) fail(400, 'Provide rich, markdown or blocks');
      const incoming = b.blocks ? b.blocks : b.rich !== undefined ? await fromRich(String(b.rich)) : docToBlocks(await markdownToDoc(b.markdown));
      if (mode === 'replace') next = incoming;
      else if (mode === 'append') next = [...prev, ...incoming];
      else if (mode === 'prepend') next = [...incoming, ...prev];
      else {
        if (!b.selection) fail(400, `mode "${mode}" needs selection ("start text...end text")`);
        let range: [number, number] = [0, 0];
        try {
          range = locate(prev, b.selection);
        } catch (e: any) {
          fail(400, e.message);
        }
        const [s, e] = range;
        next = mode === 'insert_after' ? [...prev.slice(0, e + 1), ...incoming, ...prev.slice(e + 1)] : [...prev.slice(0, s), ...incoming, ...prev.slice(e + 1)];
      }
    }
    const result = await patchTopLevel(pageId, prev, next.length ? next : [{ type: 'paragraph' }]);
    const doc = await loadDocSnapshot(pageId);
    if (result.changed) {
      await persistDoc(pageId, doc, user.id);
      emit({ type: 'page', id: pageId });
    }
    return { blocks: docToBlocks(doc), warnings, changed: result.changed, blocksRemoved: result.removed, blocksInserted: result.inserted };
  });

  app.get<{ Params: { id: string } }>('/pages/:id/export', async (req, reply) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    await assertExportsAllowed(user);
    const page = await one('select title from pages where id = $1', [req.params.id]);
    await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'export.page_markdown', targetType: 'page', targetId: req.params.id, meta: { title: page?.title }, ip: req.ip });
    const md = `# ${page.title || 'Untitled'}\n\n` + (await docToMarkdown(await loadDocSnapshot(req.params.id), syncedLoader(user)));
    const name = (page.title || 'Untitled').replace(/[^\w\- ]+/g, '').trim() || 'page';
    reply.header('content-disposition', `attachment; filename="${name}.md"`).type('text/markdown; charset=utf-8');
    return md;
  });

  app.post<{ Body: { markdown: string; title?: string; parentId?: string; teamspaceId?: string } }>('/import/markdown', async (req) => {
    const user = requireUser(req);
    let { markdown, title } = req.body ?? ({} as any);
    if (!markdown) fail(400, 'markdown required');
    const m = markdown.match(/^#\s+(.+)\n/);
    if (!title && m) {
      title = m[1].trim();
      markdown = markdown.slice(m[0].length);
    }
    return createPage(user, { parentId: req.body.parentId, teamspaceId: req.body.teamspaceId, title: title ?? 'Imported', markdown });
  });

  // ----- version history -----
  app.get<{ Params: { id: string } }>('/pages/:id/versions', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    return q(
      `select v.id, v.title, v.created_at, u.name as author_name, u.avatar_url as author_avatar
       from page_versions v left join users u on u.id = v.created_by where v.page_id = $1 order by v.created_at desc limit 100`,
      [req.params.id],
    );
  });
  app.get<{ Params: { id: string; vid: string } }>('/pages/:id/versions/:vid', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    const v = await one('select ydoc, title from page_versions where id = $1 and page_id = $2', [req.params.vid, req.params.id]);
    if (!v) fail(404, 'Version not found');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(v.ydoc));
    return { title: v.title, blocks: docToBlocks(doc) };
  });
  app.post<{ Params: { id: string; vid: string } }>('/pages/:id/versions/:vid/restore', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const v = await one('select ydoc, title from page_versions where id = $1 and page_id = $2', [req.params.vid, req.params.id]);
    if (!v) fail(404, 'Version not found');
    // snapshot current state first so the restore itself is undoable
    const current = await loadDocSnapshot(req.params.id);
    const cur = await one('select title from pages where id = $1', [req.params.id]);
    await q('insert into page_versions(page_id, ydoc, title, created_by) values ($1,$2,$3,$4)', [
      req.params.id,
      Buffer.from(Y.encodeStateAsUpdate(current)),
      cur.title,
      user.id,
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(v.ydoc));
    await replaceDocContent(req.params.id, doc);
    await q('update pages set title = $2, updated_at = now(), updated_by = $3 where id = $1', [req.params.id, v.title, user.id]);
    emit({ type: 'page', id: req.params.id });
    emit({ type: 'tree' });
    return { ok: true };
  });

  // ----- sharing & permissions -----
  app.get<{ Params: { id: string } }>('/pages/:id/permissions', async (req) => {
    const user = requireUser(req);
    const level = await assertPage(user, req.params.id, 'view');
    const crumbs = await breadcrumbs(req.params.id);
    const ids = crumbs.map((c: any) => c.id);
    const grants = await q(
      `select pp.id, pp.page_id, pp.principal_type, pp.principal_id, pp.level,
         (pp.password_hash is not null) as has_password, pp.expires_at,
         u.name as user_name, u.email as user_email, u.avatar_url, g.name as group_name,
         (select title from pages where id = pp.page_id) as page_title
       from page_permissions pp left join users u on pp.principal_type = 'user' and u.id = pp.principal_id
       left join groups g on pp.principal_type = 'group' and g.id = pp.principal_id
       where pp.page_id = any($1::uuid[]) order by pp.created_at`,
      [ids],
    );
    const page = await one('select teamspace_id, owner_id, public_slug from pages where id = $1', [req.params.id]);
    const owner = page.owner_id && !page.teamspace_id ? await one('select id, name, email, avatar_url from users where id = $1', [page.owner_id]) : null;
    const ts = page.teamspace_id ? await one('select id, name, icon, default_level from teamspaces where id = $1', [page.teamspace_id]) : null;
    return {
      level,
      grants: grants.map((g) => ({ ...g, inherited: g.page_id !== req.params.id })),
      owner,
      teamspace: ts,
      public: grants.some((g) => g.principal_type === 'public'),
      publicSlug: page.public_slug,
    };
  });

  app.put<{ Params: { id: string }; Body: { principal_type: string; principal_id?: string | null; level: Level; password?: string | null; expiresAt?: string | null } }>(
    '/pages/:id/permissions',
    async (req) => {
      const user = requireUser(req);
      await assertPage(user, req.params.id, 'full');
      const { principal_type, principal_id = null, level } = req.body ?? ({} as any);
      if (!['user', 'group', 'workspace', 'public'].includes(principal_type)) fail(400, 'Bad principal_type');
      if (!(level in RANK) || level === 'none') fail(400, 'Bad level');
      if (principal_type === 'public' && level !== 'view') fail(400, 'Public access is view-only');
      if (principal_type === 'public') {
        await assertPublishAllowed(user);
        const s = await getSettings(user.workspaceId);
        const hasPw = await one(`select 1 from page_permissions where page_id = $1 and principal_type = 'public' and password_hash is not null`, [req.params.id]);
        if (s.require_public_link_password && !req.body?.password && !hasPw) fail(400, 'Your workspace requires a password on public links');
      }
      const existing = await one(
        `select id from page_permissions where page_id = $1 and principal_type = $2 and principal_id is not distinct from $3`,
        [req.params.id, principal_type, principal_id],
      );
      if (existing) await q('update page_permissions set level = $2 where id = $1', [existing.id, level]);
      else
        await q('insert into page_permissions(page_id, principal_type, principal_id, level) values ($1,$2,$3,$4)', [
          req.params.id,
          principal_type,
          principal_id,
          level,
        ]);
      if (principal_type === 'public') {
        await q('update pages set public_slug = coalesce(public_slug, $2) where id = $1', [req.params.id, randomToken(9)]);
        // Optional password / expiry in the same call (also settable later via PATCH /pages/:id/public).
        if (req.body?.password) {
          if (String(req.body.password).length < 4) fail(400, 'Use at least 4 characters');
          await q(`update page_permissions set password_hash = $2, password_version = password_version + 1 where page_id = $1 and principal_type = 'public'`, [req.params.id, await hashPassword(String(req.body.password))]);
        }
        if (req.body?.expiresAt) {
          const d = new Date(req.body.expiresAt);
          if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) fail(400, 'Expiry must be a future date');
          await q(`update page_permissions set expires_at = $2 where page_id = $1 and principal_type = 'public'`, [req.params.id, d]);
        }
      }
      if (principal_type === 'user' && !existing && principal_id) await notify(principal_id, 'share', user.id, req.params.id, { level });
      await audit({
        workspaceId: user.workspaceId, actorId: user.id, ip: req.ip, targetType: 'page', targetId: req.params.id,
        action: principal_type === 'public' ? 'page.published' : existing ? 'page.permission_changed' : 'page.permission_granted',
        meta: { principal_type, principal_id, level },
      });
      emit({ type: 'tree' });
      emit({ type: 'page', id: req.params.id });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; pid: string } }>('/pages/:id/permissions/:pid', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const gone = await q('delete from page_permissions where id = $1 and page_id = $2 returning principal_type, principal_id, level', [req.params.pid, req.params.id]);
    if (gone.length) {
      await audit({
        workspaceId: user.workspaceId, actorId: user.id, ip: req.ip, targetType: 'page', targetId: req.params.id,
        action: gone[0].principal_type === 'public' ? 'page.unpublished' : 'page.permission_removed', meta: gone[0],
      });
    }
    emit({ type: 'tree' });
    emit({ type: 'page', id: req.params.id });
    return { ok: true };
  });

  // unload hook to avoid stale doc on permanent delete
  app.addHook('onClose', async () => {
    hocuspocus.flushPendingStores();
  });
}
