import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { checkPassword, fail, hashPassword, randomToken, requireUser, sha256 } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import { chain, assertPage, atLeast, pageLevel } from '../perms.js';
import { getSettings } from '../workspaceSettings.js';
import { loadDocSnapshot } from '../collab.js';
import { docToBlocks } from '../markdown.js';
import { queryDatabase } from './databases.js';
import { enqueue, publicBase, workspaceName } from '../email.js';
import { externalCodeEmail, externalShareEmail } from '../emailTemplates.js';

/*
 * External sharing:
 *  - public links (page_permissions principal_type 'public') with optional password + expiry
 *  - account-less email shares (external_shares) redeemed through personal magic links,
 *    optionally confirmed with a 6-digit email code, giving a view-only session cookie.
 * Both grant view access to the shared page and every sub-page beneath it.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UNLOCK_PREFIX = 'atr_pl_';
const SESSION_PREFIX = 'atr_xs_';
const SESSION_DAYS = 30;
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;

// ---------- signing (shared across instances via app_secrets) ----------
let signingSecret: string | null = null;
async function secret() {
  if (signingSecret) return signingSecret;
  await q(`insert into app_secrets(name, value) values ('share_signing', $1) on conflict (name) do nothing`, [randomBytes(32).toString('base64url')]);
  signingSecret = (await one<{ value: string }>(`select value from app_secrets where name = 'share_signing'`))!.value;
  return signingSecret;
}
async function sign(payload: string) {
  return createHmac('sha256', await secret()).update(payload).digest('base64url');
}
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Shared login_attempts-based limiter (works across ECS tasks). */
async function allow(key: string, max: number) {
  const r = await one<{ n: number }>(`select count(*)::int as n from login_attempts where key = $1 and at > now() - interval '15 minutes'`, [key]);
  if ((r?.n ?? 0) >= max) return false;
  await q('insert into login_attempts(key) values ($1)', [key]);
  return true;
}

function cookieOpts(maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSecure, maxAge: Math.max(60, Math.floor(maxAgeSeconds)) };
}

const emailHint = (email: string) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
};

// ---------- access resolution ----------
export type PublicAccess =
  | { ok: true; via: 'public' | 'external' | 'member'; rootId: string | null; email?: string; shareId?: string }
  | { ok: false; needsPassword?: string };

async function resolvePage(idOrSlug: string) {
  const isUuid = /^[0-9a-f-]{36}$/.test(idOrSlug);
  return one(
    `select id, title, icon, cover, cover_position, full_width, small_text, kind, parent_id from pages
     where ${isUuid ? 'id' : 'public_slug'} = $1 and deleted_at is null`,
    [idOrSlug],
  );
}

export async function publicAccess(req: FastifyRequest, pageId: string): Promise<PublicAccess> {
  const c = await chain(pageId);
  if (!c.length || c.some((p) => p.deleted_at)) return { ok: false };
  const ids = c.map((p) => p.id);
  const depth = new Map(ids.map((id, i) => [id, i]));

  if (req.user && atLeast(await pageLevel(req.user, pageId), 'view')) return { ok: true, via: 'member', rootId: null };

  const s = await getSettings();
  let needsPassword: string | undefined;
  if (s.allow_public_pages) {
    const grants = await q<{ id: string; page_id: string; has_pw: boolean; password_version: number }>(
      `select id, page_id, password_hash is not null as has_pw, password_version from page_permissions
       where page_id = any($1::uuid[]) and principal_type = 'public' and (expires_at is null or expires_at > now())`,
      [ids],
    );
    grants.sort((a, b) => depth.get(a.page_id)! - depth.get(b.page_id)!);
    for (const g of grants) {
      if (!g.has_pw) {
        if (s.require_public_link_password) continue; // org policy: unprotected links don't work
        return { ok: true, via: 'public', rootId: g.page_id };
      }
      const cookie = req.cookies[UNLOCK_PREFIX + g.id];
      const [v, sig] = (cookie ?? '').split('.');
      if (cookie && Number(v) === g.password_version && safeEqual(sig ?? '', await sign(`pl:${g.id}:${g.password_version}`))) {
        return { ok: true, via: 'public', rootId: g.page_id };
      }
      needsPassword ??= g.id;
    }
  }
  if (s.allow_external_shares) {
    const tokens = Object.entries(req.cookies)
      .filter(([k, v]) => k.startsWith(SESSION_PREFIX) && v)
      .map(([, v]) => sha256(v as string));
    if (tokens.length) {
      const rows = await q<{ share_id: string; page_id: string; email: string }>(
        `select e.id as share_id, e.page_id, e.email from external_share_sessions x join external_shares e on e.id = x.share_id
         where x.token_hash = any($1) and x.expires_at > now() and e.revoked_at is null
           and (e.expires_at is null or e.expires_at > now()) and e.page_id = any($2::uuid[])`,
        [tokens, ids],
      );
      rows.sort((a, b) => depth.get(a.page_id)! - depth.get(b.page_id)!);
      if (rows[0]) return { ok: true, via: 'external', rootId: rows[0].page_id, email: rows[0].email, shareId: rows[0].share_id };
    }
  }
  return { ok: false, needsPassword };
}

async function startExternalSession(req: FastifyRequest, reply: FastifyReply, share: { id: string; page_id: string; email: string; expires_at: string | null }) {
  const token = randomToken(32);
  const maxMs = SESSION_DAYS * 864e5;
  const until = share.expires_at ? Math.min(Date.now() + maxMs, new Date(share.expires_at).getTime()) : Date.now() + maxMs;
  await q(
    `insert into external_share_sessions(token_hash, share_id, expires_at, ip, user_agent) values ($1,$2,$3,$4,$5)`,
    [sha256(token), share.id, new Date(until), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  await q('update external_shares set last_accessed_at = now(), access_count = access_count + 1 where id = $1', [share.id]);
  reply.setCookie(SESSION_PREFIX + share.id, token, cookieOpts((until - Date.now()) / 1000));
  await audit({ action: 'page.external_share_accessed', targetType: 'page', targetId: share.page_id, meta: { email: share.email, shareId: share.id }, ip: req.ip });
}

async function sendShareEmail(share: { id: string; page_id: string; email: string; expires_at: string | null; require_verification: boolean; message: string | null }, token: string, sharer: string) {
  const page = await one<{ title: string }>('select title from pages where id = $1', [share.page_id]);
  await enqueue(
    share.email,
    externalShareEmail({
      workspace: await workspaceName(),
      sharer,
      pageTitle: page?.title ?? '',
      url: `${publicBase()}/x/${token}`,
      message: share.message,
      expires: share.expires_at ? new Date(share.expires_at) : null,
      verify: share.require_verification,
    }),
    { kind: 'external_share' },
  );
}

function parseExpiry(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) fail(400, 'Invalid expiry date');
  if (d.getTime() <= Date.now()) fail(400, 'Expiry must be in the future');
  return d;
}

export default async function sharingRoutes(app: FastifyInstance) {
  // ======================= public viewer =======================
  app.get<{ Params: { id: string } }>('/public/pages/:id', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('cache-control', 'private, no-store');
    const page = await resolvePage(req.params.id);
    if (!page) fail(404, 'Page not found');
    const access = await publicAccess(req, page.id);
    if (!access.ok) {
      if (access.needsPassword) return reply.status(401).send({ error: 'This page is password protected', needsPassword: true });
      fail(404, 'Page not found');
    }
    const ok = access as Extract<PublicAccess, { ok: true }>;
    const c = await chain(page.id);
    // Breadcrumbs stop at the shared root so viewers can't discover pages above it.
    const rootIdx = ok.rootId ? c.findIndex((p) => p.id === ok.rootId) : c.length - 1;
    const crumbIds = c.slice(0, rootIdx + 1).map((p) => p.id).reverse();
    const crumbs = crumbIds.length
      ? await q(`select id, title, icon from pages where id = any($1::uuid[])`, [crumbIds]).then((rows) => crumbIds.map((id) => rows.find((r: any) => r.id === id)))
      : [];
    const doc = await loadDocSnapshot(page.id);
    const children = await q(
      `select id, title, icon from pages where parent_id = $1 and deleted_at is null and kind not in ('row', 'synced') order by position`,
      [page.id],
    );
    const publicViewer = { id: '', groupIds: [], role: 'guest' } as any;
    // Names (never emails) for people referenced in shared database values.
    const peopleFor = async (schema: any[], rows: any[]) => {
      const ids = new Set<string>();
      for (const r of rows) {
        for (const p of schema) {
          if (['person', 'created_by', 'last_edited_by'].includes(p.type)) {
            const v = p.type === 'created_by' ? [r.created_by] : p.type === 'last_edited_by' ? [r.updated_by] : r.props?.[p.id];
            for (const id of Array.isArray(v) ? v : []) if (id) ids.add(id);
          }
        }
      }
      if (!ids.size) return {};
      const us = await q<{ id: string; name: string }>('select id, name from users where id = any($1::uuid[])', [[...ids]]);
      return Object.fromEntries(us.map((u) => [u.id, u.name]));
    };
    let database = null;
    if (page.kind === 'database') {
      const { schema, rows, titles } = await queryDatabase(publicViewer, page.id, {});
      const views = await q('select * from database_views where database_id = $1 and block_id is null order by position', [page.id]);
      database = { schema, rows, views, titles, people: await peopleFor(schema, rows) };
    }
    // A database row is a page under its database, so it is shared whenever the database is — show its properties too.
    let row = null;
    if (page.kind === 'row' && page.parent_id) {
      const { schema, rows, titles } = await queryDatabase(publicViewer, page.parent_id, {});
      const r = rows.find((x: any) => x.id === page.id);
      if (r) row = { schema: schema.filter((p: any) => p.type !== 'title'), row: r, titles, people: await peopleFor(schema, [r]) };
    }
    return { ...page, blocks: docToBlocks(doc), children, database, row, crumbs, via: ok.via, sharedWith: ok.email ?? null };
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>('/public/pages/:id/unlock', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    const page = await resolvePage(req.params.id);
    if (!page) fail(404, 'Page not found');
    const access = await publicAccess(req, page.id);
    if (access.ok) return { ok: true };
    if (!access.needsPassword) fail(404, 'Page not found');
    const g = await one<{ id: string; page_id: string; password_hash: string; password_version: number; expires_at: string | null }>(
      'select id, page_id, password_hash, password_version, expires_at from page_permissions where id = $1',
      [access.needsPassword],
    );
    if (!(await allow(`unlock:${req.ip}:${g!.id}`, 10))) {
      await audit({ action: 'page.public_unlock_rate_limited', targetType: 'page', targetId: g!.page_id, ip: req.ip });
      fail(429, 'Too many attempts — try again in a few minutes');
    }
    if (!(await checkPassword(String(req.body?.password ?? ''), g!.password_hash))) fail(401, 'Incorrect password');
    const ttl = g!.expires_at ? (new Date(g!.expires_at).getTime() - Date.now()) / 1000 : 7 * 86400;
    reply.setCookie(UNLOCK_PREFIX + g!.id, `${g!.password_version}.${await sign(`pl:${g!.id}:${g!.password_version}`)}`, cookieOpts(Math.min(ttl, 7 * 86400)));
    return { ok: true };
  });

  // ---- magic links ----
  async function shareByToken(token: string) {
    const s = await one(
      `select * from external_shares where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
      [sha256(String(token ?? ''))],
    );
    if (!s || !(await getSettings()).allow_external_shares) fail(404, 'This link is invalid, has expired, or access was removed');
    const page = await one('select deleted_at from pages where id = $1', [s.page_id]);
    if (!page || page.deleted_at) fail(404, 'This page is no longer available');
    return s;
  }

  app.post<{ Body: { token: string } }>('/public/external/redeem', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    const share = await shareByToken(req.body?.token);
    if (!share.require_verification) {
      await startExternalSession(req, reply, share);
      return { pageId: share.page_id };
    }
    if (!(await allow(`xcode:${share.id}`, 5))) fail(429, 'Too many codes requested — try again in a few minutes');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await q(
      `update external_shares set code_hash = $2, code_expires_at = now() + make_interval(mins => $3), code_attempts = 0 where id = $1`,
      [share.id, sha256(`${share.id}:${code}`), CODE_TTL_MIN],
    );
    const page = await one<{ title: string }>('select title from pages where id = $1', [share.page_id]);
    await enqueue(share.email, externalCodeEmail({ workspace: await workspaceName(), pageTitle: page?.title ?? '', code }), { kind: 'external_code' });
    return { needsCode: true, emailHint: emailHint(share.email) };
  });

  app.post<{ Body: { token: string; code: string } }>('/public/external/verify', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    const share = await shareByToken(req.body?.token);
    if (!share.code_hash || !share.code_expires_at || new Date(share.code_expires_at) < new Date()) fail(400, 'This code has expired — request a new one');
    if (share.code_attempts >= CODE_MAX_ATTEMPTS) fail(429, 'Too many incorrect codes — request a new one');
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    if (!safeEqual(sha256(`${share.id}:${code}`), share.code_hash)) {
      await q('update external_shares set code_attempts = code_attempts + 1 where id = $1', [share.id]);
      const left = CODE_MAX_ATTEMPTS - share.code_attempts - 1;
      fail(400, left > 0 ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left` : 'Too many incorrect codes — request a new one');
    }
    await q('update external_shares set code_hash = null, code_expires_at = null, code_attempts = 0 where id = $1', [share.id]);
    await startExternalSession(req, reply, share);
    return { pageId: share.page_id };
  });

  // ======================= owner controls =======================
  /** Password + expiry for this page's own public link. */
  app.patch<{ Params: { id: string }; Body: { password?: string | null; expiresAt?: string | null } }>('/pages/:id/public', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const g = await one(`select id, password_hash from page_permissions where page_id = $1 and principal_type = 'public'`, [req.params.id]);
    if (!g) fail(404, 'This page is not published');
    const b = req.body ?? {};
    if (b.password !== undefined) {
      if (b.password === null || b.password === '') {
        if ((await getSettings(user.workspaceId)).require_public_link_password) fail(400, 'Your workspace requires a password on public links');
        await q('update page_permissions set password_hash = null, password_version = password_version + 1 where id = $1', [g.id]);
        await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.public_password_removed', targetType: 'page', targetId: req.params.id, ip: req.ip });
      } else {
        if (String(b.password).length < 4) fail(400, 'Use at least 4 characters');
        await q('update page_permissions set password_hash = $2, password_version = password_version + 1 where id = $1', [g.id, await hashPassword(String(b.password))]);
        await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.public_password_set', targetType: 'page', targetId: req.params.id, meta: { changed: !!g.password_hash }, ip: req.ip });
      }
    }
    if (b.expiresAt !== undefined) {
      const exp = parseExpiry(b.expiresAt);
      await q('update page_permissions set expires_at = $2 where id = $1', [g.id, exp]);
      await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'page.public_expiry_set', targetType: 'page', targetId: req.params.id, meta: { expiresAt: exp }, ip: req.ip });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/pages/:id/external-shares', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const ids = (await chain(req.params.id)).map((p) => p.id);
    const rows = await q(
      `select e.id, e.page_id, e.email, e.require_verification, e.message, e.expires_at, e.created_at, e.last_accessed_at, e.access_count,
         (e.expires_at is not null and e.expires_at <= now()) as expired, p.title as page_title, u.name as created_by_name
       from external_shares e join pages p on p.id = e.page_id left join users u on u.id = e.created_by
       where e.page_id = any($1::uuid[]) and e.revoked_at is null order by e.created_at`,
      [ids],
    );
    return rows.map((r: any) => ({ ...r, inherited: r.page_id !== req.params.id }));
  });

  app.post<{ Params: { id: string }; Body: { emails: string[] | string; expiresAt?: string | null; requireVerification?: boolean; message?: string } }>(
    '/pages/:id/external-shares',
    async (req) => {
      const user = requireUser(req);
      await assertPage(user, req.params.id, 'full');
      if (user.role === 'guest') fail(403, 'Guests cannot share outside the workspace');
      if (!(await getSettings(user.workspaceId)).allow_external_shares) fail(403, 'Sharing with people outside the workspace is disabled by your admin');
      const b = req.body ?? ({} as any);
      const list = (Array.isArray(b.emails) ? b.emails : String(b.emails ?? '').split(/[\s,;]+/)).map((e: string) => e.trim().toLowerCase()).filter(Boolean);
      if (!list.length) fail(400, 'Add at least one email address');
      if (list.length > 50) fail(400, 'Share with at most 50 people at a time');
      const expires = parseExpiry(b.expiresAt);
      const message = b.message ? String(b.message).slice(0, 1000) : null;
      const results: { email: string; status: 'shared' | 'updated' | 'invalid' }[] = [];
      for (const email of [...new Set(list)] as string[]) {
        if (!EMAIL_RE.test(email)) {
          results.push({ email, status: 'invalid' });
          continue;
        }
        const token = randomToken(32);
        const existing = await one(`select id from external_shares where page_id = $1 and email = $2 and revoked_at is null`, [req.params.id, email]);
        const share = existing
          ? await one(
              `update external_shares set token_hash = $2, expires_at = $3, require_verification = $4, message = $5 where id = $1 returning *`,
              [existing.id, sha256(token), expires, !!b.requireVerification, message],
            )
          : await one(
              `insert into external_shares(page_id, email, token_hash, require_verification, message, expires_at, created_by)
               values ($1,$2,$3,$4,$5,$6,$7) returning *`,
              [req.params.id, email, sha256(token), !!b.requireVerification, message, expires, user.id],
            );
        await sendShareEmail(share, token, user.name);
        await audit({
          workspaceId: user.workspaceId, actorId: user.id, ip: req.ip, targetType: 'page', targetId: req.params.id,
          action: 'page.external_share_created', meta: { email, expiresAt: expires, requireVerification: !!b.requireVerification, refreshed: !!existing },
        });
        results.push({ email, status: existing ? 'updated' : 'shared' });
      }
      return { results };
    },
  );

  async function ownedShare(req: FastifyRequest<{ Params: { sid: string } }>) {
    const user = requireUser(req);
    const share = await one('select * from external_shares where id = $1 and revoked_at is null', [req.params.sid]);
    if (!share) fail(404, 'Share not found');
    await assertPage(user, share.page_id, 'full');
    return { user, share };
  }

  app.delete<{ Params: { sid: string } }>('/external-shares/:sid', async (req) => {
    const { user, share } = await ownedShare(req);
    await q('update external_shares set revoked_at = now(), code_hash = null where id = $1', [share.id]);
    await q('delete from external_share_sessions where share_id = $1', [share.id]);
    await audit({ workspaceId: user.workspaceId, actorId: user.id, ip: req.ip, targetType: 'page', targetId: share.page_id, action: 'page.external_share_revoked', meta: { email: share.email } });
    return { ok: true };
  });

  app.post<{ Params: { sid: string } }>('/external-shares/:sid/resend', async (req) => {
    const { user, share } = await ownedShare(req);
    if (share.expires_at && new Date(share.expires_at) <= new Date()) fail(400, 'This share has expired — share again to renew it');
    const token = randomToken(32);
    const updated = await one('update external_shares set token_hash = $2 where id = $1 returning *', [share.id, sha256(token)]);
    await sendShareEmail(updated, token, user.name);
    await audit({ workspaceId: user.workspaceId, actorId: user.id, ip: req.ip, targetType: 'page', targetId: share.page_id, action: 'page.external_share_resent', meta: { email: share.email } });
    return { ok: true };
  });
}
