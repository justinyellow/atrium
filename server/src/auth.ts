import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, q } from './db.js';

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  theme: string;
  role: Role;
  workspaceId: string;
  groupIds: string[];
  via: 'session' | 'token';
  /** Set for cookie sessions (lets the session list mark "this device"). */
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const fail = (status: number, msg: string): never => {
  throw new HttpError(status, msg);
};

export const SESSION_COOKIE = 'atrium_session';
const SESSION_DAYS = 30;

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Pass the request so the session list can show device and IP (optional for callers without one). */
export async function createSession(userId: string, req?: FastifyRequest) {
  const token = randomToken();
  await q(
    `insert into sessions(token, user_id, expires_at, user_agent, ip) values ($1,$2, now() + interval '${SESSION_DAYS} days', $3, $4)`,
    [sha256(token), userId, (req?.headers['user-agent'] ?? '').slice(0, 400) || null, req?.ip ?? null],
  );
  q('update users set last_active_at = now() where id = $1', [userId]).catch(() => {});
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function workspaceId(): Promise<string | undefined> {
  return (await one<{ id: string }>('select id from workspaces order by created_at limit 1'))?.id;
}

export async function loadUser(userId: string, via: AuthUser['via']): Promise<AuthUser | undefined> {
  const u = await one(
    `select u.id, u.email, u.name, u.avatar_url, u.theme, m.role, m.workspace_id,
       coalesce((select array_agg(g.group_id) from group_members g where g.user_id = u.id), '{}') as group_ids
     from users u join workspace_members m on m.user_id = u.id
     where u.id = $1 and u.active`,
    [userId],
  );
  if (!u) return undefined;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatar_url: u.avatar_url,
    theme: u.theme,
    role: u.role,
    workspaceId: u.workspace_id,
    groupIds: u.group_ids,
    via,
  };
}

export async function userFromSessionToken(token: string | undefined) {
  if (!token) return undefined;
  const s = await one<{ id: string; user_id: string; stale: boolean }>(
    `select id, user_id, last_seen_at < now() - interval '5 minutes' as stale from sessions where token = $1 and expires_at > now()`,
    [sha256(token)],
  );
  if (!s) return undefined;
  if (s.stale) {
    q('update sessions set last_seen_at = now() where id = $1', [s.id]).catch(() => {});
    q('update users set last_active_at = now() where id = $1', [s.user_id]).catch(() => {});
  }
  const u = await loadUser(s.user_id, 'session');
  if (u) u.sessionId = s.id;
  return u;
}

export async function userFromApiToken(token: string) {
  const t = await one<{ id: string; user_id: string }>('select id, user_id from api_tokens where token_hash = $1', [
    sha256(token),
  ]);
  if (!t) return undefined;
  q('update api_tokens set last_used_at = now() where id = $1', [t.id]).catch(() => {});
  return loadUser(t.user_id, 'token');
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function userFromOAuthToken(token: string) {
  const t = await one<{ id: string; user_id: string }>(
    'select id, user_id from oauth_tokens where access_hash = $1 and revoked_at is null and access_expires_at > now()',
    [sha256(token)],
  );
  if (!t) return undefined;
  q('update oauth_tokens set last_used_at = now() where id = $1', [t.id]).catch(() => {});
  return loadUser(t.user_id, 'token');
}

/** API token (atr_…) or OAuth access token (ato_…). */
export async function userFromBearer(token: string) {
  return token.startsWith('ato_') ? userFromOAuthToken(token) : userFromApiToken(token);
}

/**
 * In-process calls from the tool layer (app.inject) authenticate with a per-process secret that never
 * leaves memory, so tools reuse route logic and permission checks exactly.
 */
export const INTERNAL_KEY = randomToken(32);
export const INTERNAL_HEADER = 'x-atrium-internal';

export async function authenticate(req: FastifyRequest) {
  const internal = req.headers[INTERNAL_HEADER];
  if (typeof internal === 'string') {
    const [key, userId] = internal.split(':');
    const ok = key?.length === INTERNAL_KEY.length && timingSafeEqual(Buffer.from(key), Buffer.from(INTERNAL_KEY));
    return ok && userId ? loadUser(userId, 'token') : undefined;
  }
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return userFromBearer(h.slice(7));
  return userFromSessionToken(req.cookies[SESSION_COOKIE]);
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) fail(401, 'Not authenticated');
  return req.user!;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (u.role !== 'owner' && u.role !== 'admin') fail(403, 'Admin only');
  return u;
}
