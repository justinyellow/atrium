/**
 * Database fixes from the Notion migration test (docs/NOTION-MIGRATION-TEST.md):
 * status groups, no extra default view, relative date filters, ISO dates, default template,
 * person limit, database/property descriptions, upload-from-URL + SSRF guard.
 * Unit tests run standalone; HTTP tests need the dev server:
 *   ATRIUM_URL=http://localhost:3100 npx tsx --test src/dbfixes.test.ts
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';

const dbmod = await import('./routes/databases.js');
const { normalizeStatusOptions, statusGroupKey, normalizeDateString, normalizeRowProps, parseRelative, relativeRange, __setClockForTests, queryDatabase, backfillIsoDates } = dbmod;
const { importFileFromUrl, __setFromUrlGuardForTests } = await import('./files/fromUrl.js');
const { loadUser } = await import('./auth.js');
const { pool, one, q } = await import('./db.js');

const BASE = (process.env.ATRIUM_URL ?? 'http://localhost:3100') + '/api/v1';
const ROOT = BASE.replace(/\/api\/v1$/, '');
const OWNER = { email: process.env.ATRIUM_EMAIL ?? 'justin@example.com', password: process.env.ATRIUM_PASSWORD ?? 'password123' };
const tag = `dbfix${Date.now().toString(36)}`;

// ---------- unit ----------

test('status groups: explicit groups kept, aliases mapped, positional default only when missing', () => {
  const opts = normalizeStatusOptions([
    { name: 'Open', group: 'To-do' },
    { name: 'Fixed', group: 'Complete' },
    { name: 'Investigating', group: 'in progress' },
    { name: 'Wontfix' },
  ]);
  assert.deepEqual(opts.map((o) => [o.name, o.group]), [['Open', 'todo'], ['Fixed', 'complete'], ['Investigating', 'in_progress'], ['Wontfix', 'complete']]);
  const pos = normalizeStatusOptions([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  assert.deepEqual(pos.map((o) => o.group), ['todo', 'in_progress', 'complete']);
  assert.equal(statusGroupKey('Done'), 'complete');
  assert.equal(statusGroupKey('nonsense'), null);
});

test('dates normalise to ISO 8601 (Notion raw formats accepted)', () => {
  assert.equal(normalizeDateString('2026-10-20'), '2026-10-20');
  assert.equal(normalizeDateString('2026-10-20 14:05:00Z'), '2026-10-20T14:05:00.000Z');
  assert.equal(normalizeDateString('2026-10-20T14:05:00.000+02:00'), '2026-10-20T12:05:00.000Z');
  assert.equal(normalizeDateString('2026-10-20 14:05'), '2026-10-20T14:05:00', 'naive date-time keeps wall-clock time');
  assert.equal(normalizeDateString('2026-10-20T14:05:00'), '2026-10-20T14:05:00');
  assert.equal(normalizeDateString('October 20, 2026'), '2026-10-20');
  assert.equal(normalizeDateString('not a date'), null);
  const schema: any[] = [{ id: 'd', name: 'Due', type: 'date' }];
  assert.deepEqual(normalizeRowProps(schema, { d: { start: '2026-10-20 14:05:00Z', end: '2026-10-21' } }).d, { start: '2026-10-20T14:05:00.000Z', end: '2026-10-21' });
  assert.deepEqual(normalizeRowProps(schema, { d: '2026-10-20' }).d, { start: '2026-10-20' });
  assert.equal(normalizeRowProps(schema, { d: '' }).d, null);
});

test('person limit "one" rejects multiple people', () => {
  const schema: any[] = [{ id: 'p', name: 'Owner', type: 'person', limit: 'one' }, { id: 'q', name: 'Team', type: 'person' }];
  assert.doesNotThrow(() => normalizeRowProps(schema, { p: ['u1'], q: ['u1', 'u2'] }));
  assert.throws(() => normalizeRowProps(schema, { p: ['u1', 'u2'] }), /limited to one person/);
});

test('relative date ranges (frozen clock: Wed 2026-11-11)', () => {
  const now = new Date(2026, 10, 11, 15, 30); // local time
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  assert.deepEqual(parseRelative('past 30 days'), { direction: 'past', unit: 'day', count: 30 });
  assert.deepEqual(parseRelative('last 2 weeks'), { direction: 'past', unit: 'week', count: 2 });
  assert.deepEqual(parseRelative({ direction: 'next', count: 3, unit: 'months' }), { direction: 'next', unit: 'month', count: 3 });
  assert.equal(parseRelative('soonish'), null);
  assert.deepEqual(relativeRange(parseRelative('past 30 days')!, now), [day(2026, 10, 12), day(2026, 11, 11)]);
  assert.deepEqual(relativeRange(parseRelative('next 1 week')!, now), [day(2026, 11, 11), day(2026, 11, 18)]);
  assert.deepEqual(relativeRange(parseRelative('this week')!, now), [day(2026, 11, 9), day(2026, 11, 15)], 'Monday–Sunday');
  assert.deepEqual(relativeRange(parseRelative('this month')!, now), [day(2026, 11, 1), day(2026, 11, 30)]);
  assert.deepEqual(relativeRange(parseRelative('this year')!, now), [day(2026, 1, 1), day(2026, 12, 31)]);
  assert.deepEqual(relativeRange('yesterday', now), [day(2026, 11, 10), day(2026, 11, 10)]);
});

// ---------- upload from URL (in-process, fixture server on 127.0.0.1) ----------

let fixture: http.Server;
let fixtureUrl = '';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/img') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); // forces magic-byte sniffing
      return res.end(PNG);
    }
    if (req.url === '/named') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': "attachment; filename*=UTF-8''Q3%20report.txt" });
      return res.end('hello');
    }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.alloc(4096));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});
after(async () => {
  __setFromUrlGuardForTests();
  __setClockForTests();
  await new Promise<void>((r) => fixture.close(() => r()));
  await pool.end();
});

async function owner() {
  const u = await one<{ id: string }>('select id from users where email = $1', [OWNER.email]);
  return (await loadUser(u!.id, 'session'))!;
}

/** Test-only guard: allow loopback (the fixture) but still block everything else private. */
function allowLoopbackOnly() {
  __setFromUrlGuardForTests({
    isBlockedHost: (h) => h !== '127.0.0.1' && /^(10\.|127\.|169\.254\.|192\.168\.|::1$)/.test(h),
    lookup: ((hostname: string, options: any, cb: any) =>
      dns.lookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err);
        const a = (addrs as dns.LookupAddress[])[0];
        if (a.address !== '127.0.0.1') return cb(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
        return options?.all ? cb(null, addrs) : cb(null, a.address, a.family);
      })) as any,
  });
}

test('fromUrl: downloads, sniffs type, names files, records source', async () => {
  allowLoopbackOnly();
  try {
    const user = await owner();
    const img = await importFileFromUrl(user, `${fixtureUrl}/img`);
    assert.equal(img.mime, 'image/png');
    assert.equal(img.size, PNG.length);
    assert.match(img.url, /^\/api\/v1\/files\/[0-9a-f-]{36}$/);
    const named = await importFileFromUrl(user, `${fixtureUrl}/named`);
    assert.equal(named.name, 'Q3 report.txt');
    assert.equal(named.mime, 'text/plain');
    const row = await one('select source_url, size from files where id = $1', [named.id]);
    assert.equal(row.source_url, `${fixtureUrl}/named`);
    await assert.rejects(importFileFromUrl(user, `${fixtureUrl}/big`, { maxBytes: 1000 }), (e: any) => e.status === 413);
    await assert.rejects(importFileFromUrl(user, `${fixtureUrl}/redirect-private`), (e: any) => e.status === 400 && /not allowed/.test(e.message));
    await q('delete from files where id = any($1::uuid[])', [[img.id, named.id]]);
  } finally {
    __setFromUrlGuardForTests();
  }
});

test('fromUrl: real SSRF guard refuses private, loopback, metadata and odd URLs', async () => {
  __setFromUrlGuardForTests();
  const user = await owner();
  for (const url of [
    `${fixtureUrl}/img`,
    'http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.5/', 'http://192.168.1.1/', 'http://0x7f000001/', 'http://2130706433/',
  ]) {
    await assert.rejects(importFileFromUrl(user, url), (e: any) => e.status === 400 || e.status === 502, url);
  }
  await assert.rejects(importFileFromUrl(user, 'file:///etc/passwd'), (e: any) => e.status === 400);
  await assert.rejects(importFileFromUrl(user, 'http://user:pw@example.com/x'), (e: any) => e.status === 400);
});

// ---------- HTTP (running server) ----------

let cookie = '';
let token = '';
async function api(method: string, path: string, body?: any) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data };
}
async function mcp(name: string, args: any) {
  const r = await fetch(`${ROOT}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? JSON.stringify(j.error ?? j);
  if (j.result?.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const created: string[] = [];
let serverUp = false;
before(async () => {
  try {
    const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    serverUp = r.ok;
    if (serverUp) token = (await api('POST', '/tokens', { name: tag })).data.token;
  } catch {
    serverUp = false;
  }
});
after(async () => {
  if (!serverUp) return;
  for (const id of created) {
    await api('DELETE', `/pages/${id}`);
    await api('DELETE', `/pages/${id}/permanent`);
  }
  const t = (await api('GET', '/tokens')).data.find((x: any) => x.name === tag);
  if (t) await api('DELETE', `/tokens/${t.id}`);
});

test('REST: database created with views gets exactly those views', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const a = await api('POST', '/pages', { kind: 'database', title: `${tag} views`, views: [{ name: 'Board', type: 'board' }, { name: 'Calendar', type: 'calendar' }] });
  created.push(a.data.id);
  const db = await api('GET', `/databases/${a.data.id}`);
  assert.deepEqual(db.data.views.map((v: any) => v.name), ['Board', 'Calendar']);
  const b = await api('POST', '/pages', { kind: 'database', title: `${tag} default` });
  created.push(b.data.id);
  assert.deepEqual((await api('GET', `/databases/${b.data.id}`)).data.views.map((v: any) => v.name), ['Table']);
});

test('MCP: create-database keeps status groups and creates no extra view', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const r = await mcp('create-database', {
    title: `${tag} incidents`,
    description: 'Production incidents',
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Status', type: 'status', groups: [{ name: 'To-do', options: ['Open'] }, { name: 'In progress', options: ['Investigating'] }, { name: 'Complete', options: ['Fixed', 'Closed'] }] },
      { name: 'Severity', type: 'select', options: ['P1', 'P2'], description: 'How bad is it' },
      { name: 'Owner', type: 'person', limit: 'one' },
      { name: 'Reported', type: 'date' },
    ],
    views: [
      { name: 'Incidents L30D', type: 'table', filters: [{ property: 'Reported', op: 'within', value: 'past 30 days' }] },
      { name: 'By status', type: 'board', group_by: 'Status' },
    ],
  });
  created.push(r.id);
  assert.deepEqual(r.views.map((v: any) => v.name), ['Incidents L30D', 'By status']);
  const db = (await api('GET', `/databases/${r.id}`)).data;
  const status = db.schema.find((p: any) => p.name === 'Status');
  assert.deepEqual(status.options.map((o: any) => [o.name, o.group]), [['Open', 'todo'], ['Investigating', 'in_progress'], ['Fixed', 'complete'], ['Closed', 'complete']]);
  assert.equal(db.schema.find((p: any) => p.name === 'Severity').description, 'How bad is it');
  assert.equal(db.schema.find((p: any) => p.name === 'Owner').limit, 'one');
  assert.equal(db.description, 'Production incidents');
  const fetched = await mcp('fetch', { id: r.id });
  assert.equal(fetched.description, 'Production incidents');
  assert.ok(fetched.schema.find((p: any) => p.name === 'Status').options.includes('Fixed (complete)'));
});

test('relative date filter + status group filter (in-process query, frozen clock)', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const r = await mcp('create-database', {
    title: `${tag} relative`,
    properties: [{ name: 'Name', type: 'title' }, { name: 'When', type: 'date' }, { name: 'Status', type: 'status', options: [{ name: 'Open', group: 'todo' }, { name: 'Fixed', group: 'complete' }] }],
  });
  created.push(r.id);
  const db = (await api('GET', `/databases/${r.id}`)).data;
  const when = db.schema.find((p: any) => p.name === 'When').id;
  const status = db.schema.find((p: any) => p.name === 'Status');
  const fixed = status.options.find((o: any) => o.name === 'Fixed').id;
  for (const [title, date, st] of [['recent', '2026-11-01', fixed], ['old', '2026-09-01', fixed], ['future', '2026-11-20', status.options[0].id]]) {
    await api('POST', `/databases/${r.id}/rows`, { title, props: { [when]: { start: date }, [status.id]: st } });
  }
  __setClockForTests(() => new Date(2026, 10, 11, 12));
  try {
    const user = await owner();
    const run = async (filters: any[]) => (await queryDatabase(user, r.id, { filter: { op: 'and', filters } })).rows.map((x: any) => x.title).sort();
    assert.deepEqual(await run([{ prop: when, op: 'within', value: 'past 30 days' }]), ['recent']);
    assert.deepEqual(await run([{ prop: when, op: 'within', value: { direction: 'next', count: 2, unit: 'week' } }]), ['future']);
    assert.deepEqual(await run([{ prop: when, op: 'this_month' }]), ['future', 'recent']);
    assert.deepEqual(await run([{ prop: when, op: 'past_week' }]), []);
    assert.deepEqual(await run([{ prop: when, op: 'before', value: '2026-10-01' }]), ['old'], 'existing ops still work');
    assert.deepEqual(await run([{ prop: status.id, op: 'group', value: 'Complete' }]), ['old', 'recent']);
  } finally {
    __setClockForTests();
  }
});

test('REST: ISO date normalisation on write + backfill; person limit enforced', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const r = await mcp('create-database', { title: `${tag} dates`, properties: [{ name: 'Name', type: 'title' }, { name: 'At', type: 'date' }, { name: 'Owner', type: 'person', limit: 'one' }] });
  created.push(r.id);
  const db = (await api('GET', `/databases/${r.id}`)).data;
  const at = db.schema.find((p: any) => p.name === 'At').id;
  const owner = db.schema.find((p: any) => p.name === 'Owner').id;
  const row = (await api('POST', `/databases/${r.id}/rows`, { title: 'x', props: { [at]: { start: '2026-10-20 14:05:00Z' } } })).data;
  const stored = await one('select props from pages where id = $1', [row.id]);
  assert.equal(stored.props[at].start, '2026-10-20T14:05:00.000Z');
  await api('PATCH', `/pages/${row.id}`, { props: { [at]: '2026-12-01' } });
  assert.deepEqual((await one('select props from pages where id = $1', [row.id])).props[at], { start: '2026-12-01' });
  // MCP props parser path
  await mcp('update-page', { page_id: row.id, command: 'update_properties', properties: { At: '2026-10-21 09:30' } });
  assert.equal((await one('select props from pages where id = $1', [row.id])).props[at].start, '2026-10-21T09:30:00');
  // backfill: write a raw value behind the API's back, then normalise
  await q(`update pages set props = props || jsonb_build_object($2::text, jsonb_build_object('start', '2026-10-22 08:00:00Z')) where id = $1`, [row.id, at]);
  assert.ok((await backfillIsoDates()) >= 1);
  assert.equal((await one('select props from pages where id = $1', [row.id])).props[at].start, '2026-10-22T08:00:00.000Z');
  // person limit
  const me = (await api('GET', '/me')).data.id;
  const other = (await api('GET', '/users')).data.find((u: any) => u.id !== me)?.id ?? me;
  const bad = await api('PATCH', `/pages/${row.id}`, { props: { [owner]: [me, other] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /one person/);
  assert.equal((await api('PATCH', `/pages/${row.id}`, { props: { [owner]: [me] } })).status, 200);
});

test('default template is used by "New" (useDefaultTemplate) and settable via REST + MCP', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const r = await mcp('create-database', { title: `${tag} templates`, properties: [{ name: 'Name', type: 'title' }] });
  created.push(r.id);
  const tpl = (await api('POST', `/databases/${r.id}/rows`, { title: 'Incident report', isTemplate: true, markdown: '## Timeline\n\n- detected' })).data;
  const set = await api('PATCH', `/databases/${r.id}`, { defaultTemplateId: tpl.id });
  assert.equal(set.data.default_template_id, tpl.id);
  const fromNew = (await api('POST', `/databases/${r.id}/rows`, { useDefaultTemplate: true })).data;
  const md = (await api('GET', `/pages/${fromNew.id}/content?format=markdown`)).data;
  assert.match(String(md), /Timeline/);
  const plain = (await api('POST', `/databases/${r.id}/rows`, { title: 'blank' })).data;
  assert.doesNotMatch(String((await api('GET', `/pages/${plain.id}/content?format=markdown`)).data), /Timeline/, 'API callers opt in explicitly');
  assert.equal((await api('PATCH', `/databases/${r.id}`, { defaultTemplateId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  await mcp('update-database', { database_id: r.id, default_template: null, description: 'cleared template' });
  const db = (await api('GET', `/databases/${r.id}`)).data;
  assert.equal(db.default_template_id, null);
  assert.equal(db.description, 'cleared template');
  await mcp('update-database', { database_id: r.id, default_template: 'Incident report' });
  assert.equal((await api('GET', `/databases/${r.id}`)).data.default_template_id, tpl.id);
});

test('REST + MCP upload-from-url refuse internal addresses', async (t) => {
  if (!serverUp) return t.skip('server not running');
  assert.equal((await api('POST', '/files/from-url', { url: 'http://169.254.169.254/latest/meta-data' })).status, 400);
  assert.equal((await api('POST', '/files/from-url', {})).status, 400);
  await assert.rejects(mcp('upload-file-from-url', { url: 'http://127.0.0.1:3100/api/v1/health' }), /not allowed/);
});

test('pages inside a row nest under it in the tree; rows without pages stay out; rows report a sub-page count', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = (await api('POST', '/pages', { kind: 'database', title: `${tag} subpages` })).data;
  created.push(db.id);
  const withKids = (await api('POST', `/databases/${db.id}/rows`, { title: 'has pages' })).data;
  const plain = (await api('POST', `/databases/${db.id}/rows`, { title: 'no pages' })).data;
  const sub = (await api('POST', '/pages', { parentId: withKids.id, title: `${tag} spec` })).data;
  await api('POST', '/pages', { parentId: withKids.id, title: `${tag} rollout` });

  const tree = (await api('GET', '/tree')).data.pages as any[];
  const byId = new Map(tree.map((p) => [p.id, p]));
  assert.equal(byId.get(sub.id)?.parent_id, withKids.id, 'sub-page keeps its row as parent');
  assert.equal(byId.get(withKids.id)?.parent_id, db.id, 'row with pages is in the tree under its database');
  assert.equal(byId.get(withKids.id)?.level, byId.get(db.id)?.level, 'row inherits the database access level');
  assert.ok(!byId.has(plain.id), 'rows without pages are left out');

  const rows = (await api('POST', `/databases/${db.id}/query`, {})).data.rows as any[];
  assert.equal(rows.find((r) => r.id === withKids.id).subpages, 2);
  assert.equal(rows.find((r) => r.id === plain.id).subpages, 0);
});
