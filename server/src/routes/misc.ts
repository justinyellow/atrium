import type { FastifyInstance } from 'fastify';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, requireUser } from '../auth.js';
import { one, q } from '../db.js';
import { emit } from '../events.js';
import { assertPage, atLeast, pageLevel, visibleTree } from '../perms.js';
import { notify } from '../notify.js';
import { loadDocSnapshot } from '../collab.js';
import { docToBlocks } from '../markdown.js';
import { queryDatabase } from './databases.js';
import { storage } from '../storage.js';
import { getSettings } from '../workspaceSettings.js';
import { visibleUsers } from '../userVisibility.js';

export default async function miscRoutes(app: FastifyInstance) {
  // ----- search -----
  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', async (req) => {
    const user = requireUser(req);
    const term = (req.query.q ?? '').trim();
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    if (!term) return [];
    const rows = await q(
      `select p.id, p.title, p.icon, p.kind, p.parent_id, p.updated_at,
         (select title from pages x where x.id = p.parent_id) as parent_title,
         case when p.title ilike '%' || $2 || '%' then null
              else substring(c.text from greatest(1, position(lower($2) in lower(c.text)) - 40) for 140) end as snippet,
         (case when lower(p.title) = lower($2) then 3 when p.title ilike $2 || '%' then 2 when p.title ilike '%' || $2 || '%' then 1 else 0 end) as score
       from pages p left join page_content c on c.page_id = p.id
       where p.workspace_id = $1 and p.deleted_at is null and not p.is_template and p.kind <> 'synced'
         and (p.title ilike '%' || $2 || '%' or c.text ilike '%' || $2 || '%'
              or to_tsvector('simple', coalesce(c.text, '')) @@ plainto_tsquery('simple', $2))
       order by score desc, p.updated_at desc limit 200`,
      [user.workspaceId, term],
    );
    const out = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (atLeast(await pageLevel(user, r.id), 'view')) out.push(r);
    }
    return out;
  });

  // ----- comments -----
  app.get<{ Params: { id: string } }>('/pages/:id/comments', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'view');
    return q(
      `select t.id, t.block_id, t.quote, t.resolved, t.created_at,
         coalesce(json_agg(json_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at, 'edited_at', c.edited_at,
           'reactions', c.reactions, 'author', json_build_object('id', u.id, 'name', u.name, 'avatar_url', u.avatar_url)) order by c.created_at)
           filter (where c.id is not null), '[]') as comments
       from comment_threads t left join comments c on c.thread_id = t.id left join users u on u.id = c.author_id
       where t.page_id = $1 group by t.id order by t.created_at`,
      [req.params.id],
    );
  });

  const mentionIds = (body: string) => [...body.matchAll(/@\[[^\]]*\]\(([0-9a-f-]{36})\)/g)].map((m) => m[1]);

  app.post<{ Params: { id: string }; Body: { body: string; blockId?: string; quote?: string; threadId?: string } }>('/pages/:id/comments', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'comment');
    const b = req.body ?? ({} as any);
    if (!b.body?.trim()) fail(400, 'Comment is empty');
    let threadId = b.threadId;
    if (threadId) {
      const t = await one('select id from comment_threads where id = $1 and page_id = $2', [threadId, req.params.id]);
      if (!t) fail(404, 'Thread not found');
      await q('update comment_threads set resolved = false where id = $1', [threadId]);
    } else {
      threadId = (await one('insert into comment_threads(page_id, block_id, quote, created_by) values ($1,$2,$3,$4) returning id', [
        req.params.id, b.blockId ?? null, b.quote ?? null, user.id,
      ])).id;
    }
    const c = await one('insert into comments(thread_id, author_id, body) values ($1,$2,$3) returning *', [threadId, user.id, b.body]);
    // notify thread participants + page creator + mentioned users
    const participants = await q('select distinct author_id from comments where thread_id = $1', [threadId]);
    const page = await one('select created_by, title from pages where id = $1', [req.params.id]);
    const targets = new Set<string>([...participants.map((p) => p.author_id), page.created_by].filter(Boolean));
    const mentioned = new Set(mentionIds(b.body));
    for (const t of targets) if (!mentioned.has(t)) await notify(t, b.threadId ? 'reply' : 'comment', user.id, req.params.id, { threadId, commentId: c.id, body: b.body.slice(0, 200) });
    for (const m of mentioned) await notify(m, 'mention', user.id, req.params.id, { threadId, commentId: c.id, body: b.body.slice(0, 200) });
    emit({ type: 'comments', pageId: req.params.id });
    return { ...c, thread_id: threadId };
  });

  app.patch<{ Params: { cid: string }; Body: { body?: string; reaction?: string } }>('/comments/:cid', async (req) => {
    const user = requireUser(req);
    const c = await one('select c.*, t.page_id from comments c join comment_threads t on t.id = c.thread_id where c.id = $1', [req.params.cid]);
    if (!c) fail(404, 'Comment not found');
    await assertPage(user, c.page_id, 'comment');
    if (req.body?.body !== undefined) {
      if (c.author_id !== user.id) fail(403, 'You can only edit your own comments');
      await q('update comments set body = $2, edited_at = now() where id = $1', [c.id, req.body.body]);
    }
    if (req.body?.reaction) {
      const r = { ...(c.reactions ?? {}) };
      const list: string[] = r[req.body.reaction] ?? [];
      r[req.body.reaction] = list.includes(user.id) ? list.filter((x) => x !== user.id) : [...list, user.id];
      if (!r[req.body.reaction].length) delete r[req.body.reaction];
      await q('update comments set reactions = $2 where id = $1', [c.id, r]);
    }
    emit({ type: 'comments', pageId: c.page_id });
    return { ok: true };
  });

  app.delete<{ Params: { cid: string } }>('/comments/:cid', async (req) => {
    const user = requireUser(req);
    const c = await one('select c.*, t.page_id from comments c join comment_threads t on t.id = c.thread_id where c.id = $1', [req.params.cid]);
    if (!c) fail(404, 'Comment not found');
    const level = await assertPage(user, c.page_id, 'comment');
    if (c.author_id !== user.id && !atLeast(level, 'full')) fail(403, 'Cannot delete this comment');
    await q('delete from comments where id = $1', [c.id]);
    await q('delete from comment_threads t where id = $1 and not exists (select 1 from comments where thread_id = t.id)', [c.thread_id]);
    emit({ type: 'comments', pageId: c.page_id });
    return { ok: true };
  });

  app.patch<{ Params: { tid: string }; Body: { resolved: boolean } }>('/threads/:tid', async (req) => {
    const user = requireUser(req);
    const t = await one('select page_id from comment_threads where id = $1', [req.params.tid]);
    if (!t) fail(404, 'Thread not found');
    await assertPage(user, t.page_id, 'comment');
    await q('update comment_threads set resolved = $2 where id = $1', [req.params.tid, !!req.body?.resolved]);
    emit({ type: 'comments', pageId: t.page_id });
    return { ok: true };
  });

  // ----- notifications -----
  app.get<{ Querystring: { archived?: string } }>('/notifications', async (req) => {
    const user = requireUser(req);
    return q(
      `select n.id, n.type, n.data, n.read_at, n.created_at, n.archived, n.page_id,
         json_build_object('id', a.id, 'name', a.name, 'avatar_url', a.avatar_url) as actor,
         p.title as page_title, p.icon as page_icon
       from notifications n left join users a on a.id = n.actor_id left join pages p on p.id = n.page_id
       where n.user_id = $1 and n.archived = $2 and (p.id is null or p.deleted_at is null)
       order by n.created_at desc limit 100`,
      [user.id, req.query.archived === 'true'],
    );
  });
  app.get('/notifications/unread', async (req) => {
    const user = requireUser(req);
    return one('select count(*)::int as count from notifications where user_id = $1 and read_at is null and not archived', [user.id]);
  });
  app.post<{ Body: { ids?: string[]; all?: boolean; archive?: boolean } }>('/notifications/read', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    const col = b.archive ? 'archived = true, read_at = coalesce(read_at, now())' : 'read_at = coalesce(read_at, now())';
    if (b.all) await q(`update notifications set ${col} where user_id = $1`, [user.id]);
    else await q(`update notifications set ${col} where user_id = $1 and id = any($2::uuid[])`, [user.id, b.ids ?? []]);
    emit({ type: 'notifications', userId: user.id });
    return { ok: true };
  });

  // ----- files -----
  app.post('/files', async (req) => {
    const user = requireUser(req);
    const part = await req.file();
    if (!part) fail(400, 'No file');
    const id = randomUUID();
    const ext = extname(part!.filename).slice(0, 10).replace(/[^.\w]/g, '');
    const path = `${id}${ext}`;
    // Local disk or S3 depending on STORAGE_DRIVER.
    const size = await storage.put(path, part!.file, part!.mimetype);
    if (part!.file.truncated) fail(413, 'File too large');
    await q('insert into files(id, workspace_id, name, mime, size, path, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)', [
      id, user.workspaceId, part!.filename, part!.mimetype, size, path, user.id,
    ]);
    return { id, name: part!.filename, url: `/api/v1/files/${id}`, size, mime: part!.mimetype };
  });
  // Re-host a remote file (e.g. an expiring Notion/S3 signed URL). SSRF-guarded; see files/fromUrl.ts.
  app.post<{ Body: { url?: string; name?: string; pageId?: string } }>('/files/from-url', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    if (!b.url || typeof b.url !== 'string') fail(400, 'url is required');
    const key = `fromurl:${user.id}`;
    const recent = await one<{ n: number }>(`select count(*)::int as n from login_attempts where key = $1 and at > now() - interval '1 minute'`, [key]);
    if ((recent?.n ?? 0) >= 60) fail(429, 'Too many downloads — try again in a minute');
    await q('insert into login_attempts(key) values ($1)', [key]);
    if (b.pageId) await assertPage(user, b.pageId, 'edit');
    const { importFileFromUrl } = await import('../files/fromUrl.js');
    return importFileFromUrl(user, b.url!, { name: b.name, pageId: b.pageId ?? null });
  });
  app.get<{ Params: { id: string } }>('/files/:id', async (req, reply) => {
    // File URLs are unguessable UUIDs; they're embedded in pages (including public ones).
    const f = await one('select * from files where id = $1', [req.params.id]);
    const body = f ? await storage.get(f.path) : null;
    if (!f || !body) fail(404, 'File not found');
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('content-disposition', `${f.mime.startsWith('image/') || f.mime.startsWith('video/') || f.mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`);
    if (f.size) reply.header('content-length', String(f.size));
    return reply.type(f.mime).send(body);
  });

  // ----- public (share to web) -----
  // Public viewer routes live in routes/sharing.ts (passwords, expiry, email shares).

  // ----- users mention search -----
  app.get<{ Querystring: { q?: string } }>('/mentions', async (req) => {
    const user = requireUser(req);
    const term = req.query.q ?? '';
    const [users, pages] = await Promise.all([
      // Same visibility rules as GET /users (guests: collaborators only, no emails).
      visibleUsers(user, { search: term, limit: 8, activeOnly: true }).then((us) => us.map((u) => ({ id: u.id, name: u.name, avatar_url: u.avatar_url, email: u.email }))),
      visibleTree(user),
    ]);
    const t = term.toLowerCase();
    return {
      users,
      pages: pages.filter((p) => (p.title || 'untitled').toLowerCase().includes(t)).slice(0, 10).map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind })),
    };
  });
}
