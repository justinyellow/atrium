import type { FastifyInstance } from 'fastify';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { fail, requireUser } from '../auth.js';
import { one, q, runAsLeader } from '../db.js';
import { assertPage, atLeast, pageLevel } from '../perms.js';
import { fireDueReminders } from '../collab.js';
import { markdownToDoc } from '../markdown.js';
import { persistDoc } from '../collab.js';

// ---------- SSRF guard for link previews ----------

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(addr, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / compatible (::ffff:a.b.c.d, ::a.b.c.d) — judge by the embedded v4 address.
    const v4 = lower.match(/^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (v4) return blocked.check(v4, 'ipv4');
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
    }
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

/** DNS lookup that refuses private targets. Used at connect time, so DNS rebinding can't slip past. */
export const safeLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return (cb as any)(err);
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return (cb as any)(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    }
    if ((options as any)?.all) return (cb as any)(null, list);
    (cb as any)(null, list[0].address, list[0].family);
  });
};

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;

function fetchOnce(url: URL, deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) return reject(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: Math.max(1, deadline - Date.now()),
        headers: { 'user-agent': 'AtriumLinkPreview/1.0', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        const isHtml = /html|xml/.test(String(res.headers['content-type'] ?? ''));
        if (!isHtml || (res.statusCode ?? 0) >= 300) {
          res.resume();
          return resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
        }
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            return resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();

function meta(html: string, keys: string[]): string {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return '';
}

export async function unfurl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(400, 'Invalid URL');
  }
  if (!['http:', 'https:'].includes(url!.protocol)) fail(400, 'Only http(s) links can be previewed');
  if (url!.username || url!.password) fail(400, 'URLs with credentials are not allowed');
  const deadline = Date.now() + TIMEOUT_MS;
  let cur = url!;
  for (let hop = 0; hop < 5; hop++) {
    let r;
    try {
      r = await fetchOnce(cur, deadline);
    } catch (e: any) {
      if (e.code === 'EBLOCKED') fail(400, 'That address is not allowed');
      if (e.code === 'ETIMEDOUT') fail(504, 'The site took too long to respond');
      fail(502, 'Could not reach that site');
    }
    if (r!.status >= 300 && r!.status < 400 && r!.headers.location) {
      const next = new URL(String(r!.headers.location), cur);
      if (!['http:', 'https:'].includes(next.protocol)) fail(400, 'Redirect to an unsupported protocol');
      cur = next; // re-validated by fetchOnce / safeLookup on the next hop
      continue;
    }
    const html = r!.body;
    const abs = (u: string) => {
      try {
        return u ? new URL(u, cur).toString() : '';
      } catch {
        return '';
      }
    };
    const iconHref = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
    const title = meta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '') || cur.hostname;
    return {
      url: raw,
      title: title.slice(0, 300),
      description: meta(html, ['og:description', 'twitter:description', 'description']).slice(0, 500),
      image: abs(meta(html, ['og:image', 'og:image:url', 'twitter:image'])),
      favicon: abs(iconHref ?? '/favicon.ico'),
    };
  }
  fail(400, 'Too many redirects');
}

export default async function blockRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string } }>('/unfurl', async (req) => {
    requireUser(req);
    if (!req.query.url) fail(400, 'url required');
    return unfurl(req.query.url!);
  });

  // ----- synced blocks -----
  app.post<{ Body: { pageId: string; markdown?: string } }>('/blocks/synced', async (req) => {
    const user = requireUser(req);
    const pageId = req.body?.pageId;
    if (!pageId) fail(400, 'pageId required');
    await assertPage(user, pageId, 'edit');
    const parent = await one('select workspace_id, teamspace_id, owner_id from pages where id = $1', [pageId]);
    const s = await one(
      `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, created_by, updated_by)
       values ($1,$2,$3,$4,'synced','',$5,$5) returning id`,
      [parent.workspace_id, pageId, parent.teamspace_id, parent.owner_id, user.id],
    );
    if (req.body.markdown) await persistDoc(s.id, await markdownToDoc(req.body.markdown), user.id);
    return { id: s.id };
  });

  app.get<{ Params: { id: string } }>('/blocks/synced/:id', async (req) => {
    const user = requireUser(req);
    const level = await assertPage(user, req.params.id, 'view');
    const s = await one(
      `select s.id, s.parent_id, p.title as parent_title from pages s left join pages p on p.id = s.parent_id
       where s.id = $1 and s.kind = 'synced'`,
      [req.params.id],
    );
    if (!s) fail(404, 'Synced block not found');
    const refs = await q(
      `select p.id, p.title, p.icon from page_links l join pages p on p.id = l.source_id
       where l.target_id = $1 and p.deleted_at is null and p.kind <> 'synced' order by p.title`,
      [req.params.id],
    );
    const visible = [];
    for (const r of refs) if (atLeast(await pageLevel(user, r.id), 'view')) visible.push(r);
    return { ...s, level, refs: visible };
  });

  // ----- date-mention reminders -----
  // Only one instance (the advisory-lock leader) polls; claims are also SKIP LOCKED-safe.
  const timer = setInterval(() => runAsLeader(async () => { await fireDueReminders(); }), 30_000);
  app.addHook('onClose', async () => clearInterval(timer));
}
