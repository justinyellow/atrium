// Download a remote file (SSRF-guarded, size-capped) and store it like a normal upload.
// Used by POST /files/from-url, the MCP `upload-file-from-url` tool and the Notion importer
// (Notion's signed file URLs expire after about an hour, so files must be re-hosted).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AuthUser } from '../auth.js';
import { HttpError } from '../auth.js';
import { q } from '../db.js';
import { storage } from '../storage.js';
import { isPrivateAddress, safeLookup } from '../routes/blocks.js';

export interface StoredFile { id: string; url: string; name: string; size: number; mime: string }

const DEFAULT_MAX = 100 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

interface Guard {
  lookup: net.LookupFunction;
  isBlockedHost: (host: string) => boolean;
}
const defaultGuard: Guard = { lookup: safeLookup, isBlockedHost: (h) => net.isIP(h) !== 0 && isPrivateAddress(h) };
let guard: Guard = defaultGuard;

/**
 * TESTS ONLY: relax the SSRF guard so tests can fetch from a fixture server on 127.0.0.1.
 * Never wired to request input. Call with no argument to restore the real guard.
 */
export function __setFromUrlGuardForTests(g?: Partial<Guard>) {
  guard = g ? { ...defaultGuard, ...g } : defaultGuard;
}

const fail = (status: number, msg: string): never => {
  throw new HttpError(status, msg);
};

function request(url: URL, deadline: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (guard.isBlockedHost(host)) return reject(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guard.lookup,
      timeout: Math.max(1, deadline - Date.now()),
      headers: { 'user-agent': 'AtriumFileImport/1.0', accept: '*/*' },
    });
    req.on('response', resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Content type from the first bytes when the server doesn't say (or says octet-stream). */
function sniff(b: Buffer): string | null {
  const hex = b.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('504b0304')) return 'application/zip';
  if (b.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  const head = b.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'video/mp4': '.mp4', 'text/plain': '.txt', 'text/csv': '.csv',
};

function filenameFrom(res: http.IncomingMessage, url: URL, mime: string, override?: string) {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').trim().slice(0, 200);
  if (override?.trim()) return clean(override);
  const cd = String(res.headers['content-disposition'] ?? '');
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return clean(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
    } catch {}
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/);
  if (plain) return clean(plain[1]);
  let last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {}
  if (last) return clean(last);
  return `file${EXT[mime] ?? ''}`;
}

export async function importFileFromUrl(
  user: AuthUser,
  rawUrl: string,
  opts: { name?: string; maxBytes?: number; pageId?: string | null } = {},
): Promise<StoredFile> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(400, 'Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'Only http(s) URLs can be imported');
  if (url.username || url.password) fail(400, 'URLs with credentials are not allowed');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  const deadline = Date.now() + TIMEOUT_MS;

  let res: http.IncomingMessage | undefined;
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await request(cur, deadline);
    } catch (e: any) {
      if (e.code === 'EBLOCKED') fail(400, 'That address is not allowed');
      if (e.code === 'ETIMEDOUT') fail(504, 'The server took too long to respond');
      fail(502, 'Could not download that file');
    }
    const status = res!.statusCode ?? 0;
    if (status >= 300 && status < 400 && res!.headers.location) {
      res!.resume();
      const next = new URL(String(res!.headers.location), cur);
      if (!['http:', 'https:'].includes(next.protocol)) fail(400, 'Redirect to an unsupported protocol');
      cur = next; // re-checked by the guard on the next hop
      res = undefined;
      continue;
    }
    break;
  }
  if (!res) return fail(400, 'Too many redirects');
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    res.resume();
    fail(502, `The server returned ${status}`);
  }
  const tooBig = () => new HttpError(413, `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const declared = Number(res.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    res.destroy();
    throw tooBig();
  }

  // Read the first chunk to sniff the type, then stream the rest with a running size cap.
  const it = res[Symbol.asyncIterator]();
  const first = await it.next();
  const head: Buffer = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  let mime = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') mime = sniff(head) ?? (mime || 'application/octet-stream');
  const name = filenameFrom(res, cur, mime, opts.name);
  let total = 0;
  let overflow = false;
  const source = res;
  async function* body() {
    if (head.length) {
      total += head.length;
      if (total > maxBytes) {
        overflow = true;
        throw tooBig();
      }
      yield head;
    }
    while (true) {
      const n = await it.next();
      if (n.done) return;
      total += n.value.length;
      if (total > maxBytes) {
        overflow = true;
        source.destroy();
        throw tooBig();
      }
      yield n.value as Buffer;
    }
  }

  const id = randomUUID();
  const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? EXT[mime] ?? '').toLowerCase();
  const path = `${id}${ext}`;
  let size: number;
  try {
    size = await storage.put(path, Readable.from(body()), mime);
  } catch (e: any) {
    if (overflow) throw tooBig();
    if (e instanceof HttpError) throw e;
    return fail(502, 'Could not download that file');
  }
  size = size || total;
  await q('insert into files(id, workspace_id, name, mime, size, path, uploaded_by, page_id, source_url) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    id, user.workspaceId, name, mime, size, path, user.id, opts.pageId ?? null, url.toString(),
  ]);
  return { id, url: `/api/v1/files/${id}`, name, size, mime };
}
