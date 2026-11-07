/**
 * Notion-parity views & properties: chart aggregation, forms (members + public link), dashboards,
 * map/place, verification, button properties, quick filters, MCP support.
 * Unit tests run standalone; HTTP tests need the dev server:
 *   ATRIUM_URL=http://localhost:3100 npx tsx --test src/views.test.ts
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

const { aggregate, cleanChart, cleanPlace, cleanVerification, verificationState, cleanViewConfig, cleanButton, resolveButtonProps, andFilters } = await import('./dbviews.js');
const { pool } = await import('./db.js');

const BASE = (process.env.ATRIUM_URL ?? 'http://localhost:3100') + '/api/v1';
const ROOT = BASE.replace(/\/api\/v1$/, '');
const OWNER = { email: process.env.ATRIUM_EMAIL ?? 'justin@example.com', password: process.env.ATRIUM_PASSWORD ?? 'password123' };
const tag = `views${Date.now().toString(36)}`;

// ---------- unit: aggregation ----------

const schema: any[] = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: 'st', name: 'Status', type: 'status', options: [{ id: 'a', name: 'Todo', color: 'gray' }, { id: 'b', name: 'Doing', color: 'blue' }, { id: 'c', name: 'Done', color: 'green' }] },
  { id: 'pts', name: 'Points', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'tags', name: 'Tags', type: 'multi_select', options: [{ id: 'x', name: 'X', color: 'red' }, { id: 'y', name: 'Y', color: 'pink' }] },
  { id: 'who', name: 'Owner', type: 'person' },
];
const row = (id: string, props: any) => ({ id, title: id, props, computed: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: null, updated_by: null });
const rows = [
  row('r1', { st: 'a', pts: 1, due: { start: '2026-01-15' }, tags: ['x'], who: ['u1'] }),
  row('r2', { st: 'a', pts: 3, due: { start: '2026-01-20' }, tags: ['x', 'y'], who: ['u2'] }),
  row('r3', { st: 'b', pts: 10, due: { start: '2026-02-03' }, tags: [], who: ['u1'] }),
  row('r4', { st: 'c', pts: 6, due: { start: '2026-03-01T09:30:00' } }),
  row('r5', { pts: null }),
];
const users = new Map([['u1', 'Ada'], ['u2', 'Brian']]);
const point = (r: any, key: string) => r.points.find((p: any) => p.key === key);

test('aggregate: count by status lists every option in option order, empty bucket last', () => {
  const r = aggregate(rows as any, schema, cleanChart({ kind: 'column', xProp: 'st' }), users);
  assert.deepEqual(r.points.map((p: any) => [p.label, p.total]), [['Todo', 2], ['Doing', 1], ['Done', 1], ['No Status', 1]]);
  assert.equal(r.total, 5);
  assert.equal(point(r, 'b').color, 'blue');
  const hidden = aggregate(rows as any, schema, cleanChart({ kind: 'column', xProp: 'st', hideEmpty: true }), users);
  assert.ok(!hidden.points.some((p: any) => p.key === '__none'));
});

test('aggregate: sum / avg / median / min / max of a number property', () => {
  const by = (fn: string) => aggregate(rows as any, schema, cleanChart({ kind: 'bar', xProp: 'st', aggregate: { fn, prop: 'pts' } }), users);
  assert.equal(point(by('sum'), 'a').total, 4);
  assert.equal(point(by('avg'), 'a').total, 2);
  assert.equal(point(by('median'), 'a').total, 2);
  assert.equal(point(by('min'), 'a').total, 1);
  assert.equal(point(by('max'), 'a').total, 3);
  // overall median of 1,3,10,6 (null ignored) = 4.5
  assert.equal(aggregate(rows as any, schema, cleanChart({ kind: 'number', aggregate: { fn: 'median', prop: 'pts' } }), users).total, 4.5);
});

test('aggregate: dates bucket by month (default) and week; cumulative running totals', () => {
  const r = aggregate(rows as any, schema, cleanChart({ kind: 'line', xProp: 'due', hideEmpty: true }), users);
  assert.deepEqual(r.points.map((p: any) => [p.key, p.total]), [['2026-01-01', 2], ['2026-02-01', 1], ['2026-03-01', 1]]);
  assert.equal(r.points[0].label, 'Jan 2026');
  const cum = aggregate(rows as any, schema, cleanChart({ kind: 'line', xProp: 'due', hideEmpty: true, cumulative: true }), users);
  assert.deepEqual(cum.points.map((p: any) => p.total), [2, 3, 4]);
  const wk = aggregate(rows as any, schema, cleanChart({ kind: 'column', xProp: 'due', bucket: 'week', hideEmpty: true }), users);
  assert.equal(wk.points[0].key, '2026-01-12', 'weeks start on Monday');
});

test('aggregate: grouping into series (stacked) and multi-select counting each tag', () => {
  const r = aggregate(rows as any, schema, cleanChart({ kind: 'column', xProp: 'st', groupProp: 'who', aggregate: { fn: 'sum', prop: 'pts' } }), users);
  assert.deepEqual(r.series.map((s: any) => s.label), ['Ada', 'Brian', 'No Owner']);
  assert.deepEqual(point(r, 'a').values, { u1: 1, u2: 3, __none: 0 });
  const tags = aggregate(rows as any, schema, cleanChart({ kind: 'donut', xProp: 'tags' }), users);
  assert.equal(point(tags, 'x').total, 2);
  assert.equal(point(tags, 'y').total, 1);
  const byValue = aggregate(rows as any, schema, cleanChart({ kind: 'column', xProp: 'st', sort: 'value-desc' }), users);
  assert.equal(byValue.points[0].key, 'a');
});

// ---------- unit: validation ----------

test('place / verification / button / view config validation', () => {
  assert.deepEqual(cleanPlace({ lat: '-33.9', lng: 18.42, name: 'CPT' }), { lat: -33.9, lng: 18.42, name: 'CPT' });
  assert.throws(() => cleanPlace({ lat: 120, lng: 0 }), /latitude/);
  assert.throws(() => cleanPlace({ name: 'nowhere' }), /latitude/);
  assert.equal(cleanPlace(null), null);
  assert.equal(cleanVerification('verified')!.state, 'verified');
  assert.throws(() => cleanVerification({ state: 'maybe' }), /state/);
  assert.equal(verificationState({ state: 'verified', until: '2000-01-01T00:00:00Z' }), 'expired');
  assert.equal(verificationState({ state: 'verified' }), 'verified');
  const b = cleanButton({ label: 'Go', actions: [{ type: 'setProps', props: { s: 'x' } }, { type: 'bogus' }, { type: 'open', target: '/p/abc' }] });
  assert.deepEqual(b.actions.map((a: any) => a.type), ['setProps', 'open']);
  const now = new Date(2026, 4, 6, 12, 0);
  assert.deepEqual(resolveButtonProps({ d: '@today', p: '@me', q: ['@me', 'u2'] }, 'me1', now), { d: { start: '2026-05-06' }, p: ['me1'], q: ['me1', 'u2'] });
  const form = cleanViewConfig('form', { form: { questions: [{ propId: 'title', required: 1 }, { nope: 1 }], access: 'link' } });
  assert.equal(form.form.questions.length, 1);
  assert.match(form.form.slug, /^[\w-]{10,}$/);
  const again = cleanViewConfig('form', { form: { ...form.form, title: 'x' } }, form);
  assert.equal(again.form.slug, form.form.slug, 'public form slug is stable across edits');
  const chart = cleanViewConfig('chart', { chart: { kind: 'pie??', aggregate: { fn: 'sum', prop: 'p' } } });
  assert.equal(chart.chart.kind, 'column');
  const dash = cleanViewConfig('dashboard', { dashboard: { widgets: [{ kind: 'number', x: 50, w: 99 }] } });
  assert.deepEqual([dash.dashboard.widgets[0].x, dash.dashboard.widgets[0].w], [11, 12]);
  assert.deepEqual(andFilters(undefined, { prop: 'a', op: 'is', value: 1 }), { op: 'and', filters: [{ prop: 'a', op: 'is', value: 1 }] });
});

// ---------- HTTP (running server) ----------

let cookie = '';
let token = '';
async function api(method: string, path: string, body?: any, as = cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: as },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, headers: r.headers };
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
  try { return JSON.parse(text); } catch { return text; }
}

const created: string[] = [];
let serverUp = false;
let viewer: { id: string; cookie: string } | null = null;

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
  if (serverUp) {
    for (const id of created) {
      await api('DELETE', `/pages/${id}`);
      await api('DELETE', `/pages/${id}/permanent`);
    }
    const t = (await api('GET', '/tokens')).data.find((x: any) => x.name === tag);
    if (t) await api('DELETE', `/tokens/${t.id}`);
    if (viewer) {
      const me = (await api('GET', '/me')).data;
      await api('DELETE', `/admin/users/${viewer.id}?transferTo=${me.id}`);
    }
  }
  await pool.end();
});

async function makeDb() {
  const db = (await api('POST', '/pages', { kind: 'database', title: `${tag} db` })).data;
  created.push(db.id);
  const st = (await api('POST', `/databases/${db.id}/properties`, { name: 'Status', type: 'status' })).data;
  const pts = (await api('POST', `/databases/${db.id}/properties`, { name: 'Points', type: 'number' })).data;
  for (const [t, p, s] of [['alpha', 2, 0], ['beta', 5, 0], ['gamma', 7, 2]] as const) {
    await api('POST', `/databases/${db.id}/rows`, { title: t, props: { [pts.id]: p, [st.id]: st.options[s].id } });
  }
  return { id: db.id, st, pts };
}

test('HTTP: aggregate endpoint respects the view filter and extra quick filters', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = await makeDb();
  const v = (await api('POST', `/databases/${db.id}/views`, { type: 'chart', name: 'Chart', config: { chart: { kind: 'column', xProp: db.st.id, aggregate: { fn: 'sum', prop: db.pts.id } }, filter: { op: 'and', filters: [{ prop: db.pts.id, op: '>', value: 3 }] } } })).data;
  assert.equal(v.type, 'chart');
  const all = (await api('POST', `/databases/${db.id}/aggregate`, { viewId: v.id })).data;
  assert.equal(all.total, 12, 'view filter drops alpha (2)');
  const q = (await api('POST', `/databases/${db.id}/aggregate`, { viewId: v.id, quickFilters: [{ prop: 'title', op: 'is', value: 'beta' }] })).data;
  assert.equal(q.total, 5);
  const bad = await api('POST', `/databases/${db.id}/views`, { type: 'pie', name: 'x' });
  assert.equal(bad.status, 400);
});

test('HTTP: public form link — required fields, no data leakage, noindex, rate limit, settings respected', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = await makeDb();
  const v = (await api('POST', `/databases/${db.id}/views`, {
    type: 'form', name: 'Form',
    config: { form: { questions: [{ propId: 'title', required: true }, { propId: db.pts.id }, { propId: db.st.id }], access: 'link', thankYou: 'Ta!' } },
  })).data;
  const slug = v.config.form.slug;
  const g = await api('GET', `/public/forms/${slug}`, undefined, '');
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('x-robots-tag'), 'noindex, nofollow');
  const text = JSON.stringify(g.data);
  for (const leaked of ['alpha', 'beta', 'gamma']) assert.ok(!text.includes(leaked), `public form must not expose row "${leaked}"`);
  const missing = await api('POST', `/public/forms/${slug}/submit`, { answers: {} }, '');
  assert.equal(missing.status, 400);
  assert.ok(missing.data.fields.title);
  const badOpt = await api('POST', `/public/forms/${slug}/submit`, { answers: { title: 'x', [db.st.id]: 'not-an-option' } }, '');
  assert.equal(badOpt.status, 400);
  const ok = await api('POST', `/public/forms/${slug}/submit`, { answers: { title: 'from the web', [db.pts.id]: 4, [db.st.id]: db.st.options[1].name } }, '');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.thankYou, 'Ta!');
  const rows = (await api('POST', `/databases/${db.id}/query`, {})).data.rows;
  const sub = rows.find((r: any) => r.title === 'from the web');
  assert.ok(sub, 'submission became a row');
  assert.equal(sub.created_by, null, 'public submissions have no author');
  assert.equal(sub.props[db.st.id], db.st.options[1].id, 'option names are accepted');
  // 10 per 15 minutes per IP per form: 1 used above (+2 rejected count too)
  let last = 200;
  for (let i = 0; i < 12 && last !== 429; i++) last = (await api('POST', `/public/forms/${slug}/submit`, { answers: { title: `spam ${i}` } }, '')).status;
  assert.equal(last, 429);
  // workspace setting allow_public_pages=false hides the form
  await api('PATCH', '/admin/settings', { allow_public_pages: false });
  try {
    assert.equal((await api('GET', `/public/forms/${slug}`, undefined, '')).status, 404);
  } finally {
    await api('PATCH', '/admin/settings', { allow_public_pages: true });
  }
  // switching to members-only kills the public link
  await api('PATCH', `/views/${v.id}`, { config: { form: { ...v.config.form, access: 'members' } } });
  assert.equal((await api('GET', `/public/forms/${slug}`, undefined, '')).status, 404);
});

test('HTTP: members form — a view-only member can submit but not create rows directly', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = await makeDb();
  const v = (await api('POST', `/databases/${db.id}/views`, { type: 'form', name: 'Form', config: { form: { questions: [{ propId: 'title', required: true }], access: 'members' } } })).data;
  // a fresh member with view access only
  const email = `${tag}@example.com`;
  const inv = (await api('POST', '/invites', { role: 'member', email })).data;
  const su = await fetch(BASE + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inv.token, name: 'Form Tester', email, password: 'password123' }) });
  assert.equal(su.status, 200);
  const vc = (su.headers.get('set-cookie') ?? '').split(';')[0];
  const me = (await api('GET', '/me', undefined, vc)).data;
  viewer = { id: me.id, cookie: vc };
  assert.equal((await api('GET', `/databases/${db.id}/forms/${v.id}`, undefined, vc)).status, 404, 'no access yet');
  await api('PUT', `/pages/${db.id}/permissions`, { principal_type: 'user', principal_id: me.id, level: 'view' });
  const form = await api('GET', `/databases/${db.id}/forms/${v.id}`, undefined, vc);
  assert.equal(form.status, 200);
  assert.equal(form.data.questions.length, 1);
  assert.equal((await api('POST', `/databases/${db.id}/rows`, { title: 'direct' }, vc)).status, 403);
  const sub = await api('POST', `/databases/${db.id}/forms/${v.id}/submit`, { answers: { title: 'via form' } }, vc);
  assert.equal(sub.status, 200);
  const r = (await api('POST', `/databases/${db.id}/query`, {})).data.rows.find((x: any) => x.title === 'via form');
  assert.equal(r.created_by, me.id);
});

test('HTTP: button property runs setProps / addRow / open; place & verification validated on write', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = await makeDb();
  const done = db.st.options[2];
  const btn = (await api('POST', `/databases/${db.id}/properties`, {
    name: 'Complete', type: 'button',
    button: { label: 'Mark done', actions: [{ type: 'setProps', props: { [db.st.id]: done.id } }, { type: 'addRow', databaseId: db.id, title: 'follow-up', props: {} }, { type: 'open', target: 'https://example.com' }] },
  })).data;
  assert.equal(btn.button.label, 'Mark done');
  const rows = (await api('POST', `/databases/${db.id}/query`, {})).data.rows;
  const alpha = rows.find((r: any) => r.title === 'alpha');
  const r = await api('POST', `/databases/${db.id}/rows/${alpha.id}/button/${btn.id}`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.ran, ['setProps', 'addRow', 'open']);
  assert.equal(r.data.open, 'https://example.com');
  const after = (await api('POST', `/databases/${db.id}/query`, {})).data.rows;
  assert.equal(after.find((x: any) => x.id === alpha.id).props[db.st.id], done.id);
  assert.ok(after.some((x: any) => x.title === 'follow-up'));
  const place = (await api('POST', `/databases/${db.id}/properties`, { name: 'Where', type: 'place' })).data;
  const ver = (await api('POST', `/databases/${db.id}/properties`, { name: 'Checked', type: 'verification' })).data;
  assert.equal((await api('PATCH', `/pages/${alpha.id}`, { props: { [place.id]: { lat: 999, lng: 0 } } })).status, 400);
  assert.equal((await api('PATCH', `/pages/${alpha.id}`, { props: { [place.id]: { lat: -33.92, lng: 18.42, name: 'Cape Town' }, [ver.id]: { state: 'verified' } } })).status, 200);
  assert.equal((await api('PATCH', `/pages/${alpha.id}`, { props: { [ver.id]: { state: 'nope' } } })).status, 400);
});

test('HTTP: page verification (wiki "Verified") requires full access and validates expiry', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const page = (await api('POST', '/pages', { title: `${tag} wiki` })).data;
  created.push(page.id);
  const until = new Date(Date.now() + 7 * 864e5).toISOString();
  const r = await api('POST', `/pages/${page.id}/verification`, { state: 'verified', until });
  assert.equal(r.status, 200);
  assert.equal(r.data.verification.state, 'verified');
  const p = (await api('GET', `/pages/${page.id}`)).data;
  assert.equal(p.props.__verification.until, until);
  assert.equal((await api('POST', `/pages/${page.id}/verification`, { state: 'verified', until: '2001-01-01' })).status, 400);
  assert.equal((await api('POST', `/pages/${page.id}/verification`, { state: null })).data.verification, null);
});

test('MCP: create-view with chart / form / dashboard / map + quick filters; place & button properties', async (t) => {
  if (!serverUp) return t.skip('server not running');
  const db = await mcp('create-database', {
    title: `${tag} mcp`,
    properties: [
      { name: 'Name', type: 'title' },
      { name: 'Status', type: 'status', options: ['Open', 'Closed'] },
      { name: 'Hours', type: 'number' },
      { name: 'Office', type: 'place' },
      { name: 'Reviewed', type: 'verification' },
      { name: 'Close', type: 'button', button: { label: 'Close it', actions: [{ type: 'open', target: 'https://example.com' }] } },
    ],
  });
  created.push(db.id);
  await mcp('create-pages', { parent: { database_id: db.id }, pages: [{ properties: { Name: 'One', Status: 'Open', Hours: 3, Office: '-33.92, 18.42', Reviewed: 'verified' } }] });
  const chart = await mcp('create-view', { database_id: db.id, name: 'Hours by status', type: 'chart', chart: { kind: 'bar', x_property: 'Status', aggregate: 'sum', aggregate_property: 'Hours' }, quick_filters: [{ property: 'Status', op: 'is', value: 'Open' }] });
  const form = await mcp('create-view', { database_id: db.id, name: 'Intake', type: 'form', form: { questions: [{ property: 'Name', required: true }, { property: 'Hours' }], access: 'link' } });
  const dash = await mcp('create-view', { database_id: db.id, name: 'Overview', type: 'dashboard', dashboard: { widgets: [{ kind: 'number', title: 'Total' }, { kind: 'chart', chart: { kind: 'donut', x_property: 'Status' } }] } });
  const map = await mcp('create-view', { database_id: db.id, name: 'Offices', type: 'map', map_place_property: 'Office' });
  const meta = (await api('GET', `/databases/${db.id}`)).data;
  const byName = (n: string) => meta.views.find((v: any) => v.name === n);
  const hours = meta.schema.find((p: any) => p.name === 'Hours');
  assert.equal(byName('Hours by status').config.chart.aggregate.prop, hours.id);
  assert.equal(byName('Hours by status').config.quickFilters.length, 1);
  assert.equal(byName('Intake').config.form.access, 'link');
  assert.ok(byName('Intake').config.form.slug);
  assert.equal(byName('Overview').config.dashboard.widgets.length, 2);
  assert.equal(byName('Offices').config.map.placeProp, meta.schema.find((p: any) => p.name === 'Office').id);
  assert.ok(chart.id && form.id && dash.id && map.id);
  const btn = meta.schema.find((p: any) => p.name === 'Close');
  assert.equal(btn.button.label, 'Close it');
  const q = await mcp('query-database', { database_id: db.id });
  const one = q.rows.find((r: any) => r.Name === 'One');
  assert.deepEqual(one.Office, { lat: -33.92, lng: 18.42 });
  assert.equal(one.Reviewed, 'verified');
});
