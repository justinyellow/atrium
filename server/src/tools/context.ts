import type { FastifyInstance } from 'fastify';
import { INTERNAL_HEADER, INTERNAL_KEY, type AuthUser } from '../auth.js';

/**
 * Tools call the existing REST routes in-process (app.inject): the exact same validation, side effects
 * (events, notifications, relation sync) and permission checks as the UI — as the calling user.
 */
let app: FastifyInstance | undefined;
export function setToolApp(a: FastifyInstance) {
  app = a;
}

export interface ToolCtx {
  user: AuthUser;
  /** Public base URL, used to build page links. */
  baseUrl: string;
}

export class ToolError extends Error {}

export async function call<T = any>(ctx: ToolCtx, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!app) throw new Error('Tool layer not initialised');
  const res = await app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      [INTERNAL_HEADER]: `${INTERNAL_KEY}:${ctx.user.id}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = res.body;
  let data: any = text;
  if ((res.headers['content-type'] ?? '').toString().includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {}
  }
  if (res.statusCode >= 400) throw new ToolError(data?.error ?? `Request failed (${res.statusCode})`);
  return data as T;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID32 = /\b[0-9a-f]{32}\b/i;

/** Accepts a UUID, a 32-hex id, or any Atrium URL containing one (e.g. https://host/p/<id>). */
export function parseId(input: string): string {
  const s = String(input ?? '').trim();
  const m = s.match(UUID);
  if (m) return m[0].toLowerCase();
  const h = s.match(UUID32);
  if (h) {
    const x = h[0].toLowerCase();
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  throw new ToolError(`"${input}" is not a page/database id or URL`);
}

export const pageUrl = (ctx: ToolCtx, id: string) => `${ctx.baseUrl}/p/${id}`;
