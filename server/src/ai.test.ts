/**
 * In-app AI tests. Uses the deterministic mock provider (no API key, no network to Anthropic).
 * Unit tests run standalone; the HTTP tests need a running server with the AI routes:
 *   ATRIUM_URL=http://localhost:3100 npx tsx --test src/ai.test.ts
 * The HTTP tests switch the workspace's AI settings to the mock provider and restore them afterwards.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ATRIUM_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
const { encrypt, decrypt } = await import('./ai/settings.js');
const { needsConfirmation } = await import('./ai/chat.js');
const { sanitizeForHistory, costUsdOf } = await import('./ai/provider.js').then(async (m) => ({ ...m, costUsdOf: (await import('./ai/usage.js')).costUsd }));
const { pool } = await import('./db.js');

const BASE = (process.env.ATRIUM_URL ?? 'http://localhost:3100') + '/api/v1';
const OWNER = { email: process.env.ATRIUM_EMAIL ?? 'justin@example.com', password: process.env.ATRIUM_PASSWORD ?? 'password123' };
const tag = `aitest${Date.now().toString(36)}`;

// ---------- unit ----------

test('encryption round-trips and never stores plaintext', () => {
  const secret = 'test-only-not-a-real-key-1234';
  const enc = encrypt(secret);
  assert.ok(!enc.includes(secret));
  assert.equal(decrypt(enc), secret);
  assert.notEqual(encrypt(secret), enc, 'fresh IV each time');
  assert.throws(() => decrypt(enc.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), 'tampering is detected');
});

test('destructive tool calls need confirmation; safe ones do not', () => {
  assert.equal(needsConfirmation('delete-page', { page_id: 'x' }), true);
  assert.equal(needsConfirmation('move-pages', { page_ids: ['x'] }), true);
  assert.equal(needsConfirmation('update-page', { command: 'replace_content' }), true);
  assert.equal(needsConfirmation('update-page', { command: 'append_content' }), false);
  assert.equal(needsConfirmation('update-page', { command: 'update_properties' }), false);
  assert.equal(needsConfirmation('update-database', { delete_properties: ['A'] }), true);
  assert.equal(needsConfirmation('update-database', { add_properties: [{ name: 'A', type: 'text' }] }), false);
  assert.equal(needsConfirmation('create-pages', { pages: Array(11).fill({}) }), true);
  assert.equal(needsConfirmation('create-pages', { pages: [{}] }), false);
  assert.equal(needsConfirmation('search', { query: 'x' }), false);
});

test('fallback boundary: pre-boundary thinking/tool_use are not echoed back', () => {
  const content: any[] = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'text', text: 'partial' },
    { type: 'tool_use', id: 't1', name: 'search', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'thinking', thinking: '', signature: 's2' },
    { type: 'text', text: 'rest' },
  ];
  assert.deepEqual(sanitizeForHistory(content).map((b: any) => b.type), ['text', 'fallback', 'thinking', 'text']);
  const plain: any[] = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'x' }];
  assert.equal(sanitizeForHistory(plain), plain, 'unchanged (verbatim) without a fallback');
});

test('cost estimate uses the model price table', () => {
  assert.equal(costUsdOf('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 }), 4);
  assert.equal(costUsdOf('anthropic.claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 }), 0.5);
});

// ---------- HTTP (mock provider) ----------

class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, text, type: res.headers.get('content-type') ?? '' };
  }
  async sse(path: string, body: unknown) {
    const r = await this.req('POST', path, body);
    const events = r.type.includes('event-stream')
      ? r.text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => ({ event: b.match(/^event: (.*)$/m)![1], data: JSON.parse(b.match(/^data: (.*)$/m)![1]) }))
      : [];
    return { ...r, events, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data) };
  }
}

const owner = new Client();
const other = new Client();
let reachable = false;
let prevSettings: any;
const created: string[] = [];

before(async () => {
  try {
    const r = await owner.req('POST', '/auth/login', OWNER);
    const probe = await owner.req('GET', '/ai/status');
    reachable = r.status === 200 && probe.status === 200;
  } catch {
    reachable = false;
  }
  if (!reachable) return;
  prevSettings = (await owner.req('GET', '/admin/ai/settings')).data;
  await owner.req('PUT', '/admin/ai/settings', { enabled: true, provider: 'mock', monthlyBudgetUsd: null, perUserMonthlyBudgetUsd: null, features: { write: true, chat: true, autofill: true, agents: true } });
  // A second member with a private page the owner must never see cited.
  const inv = await owner.req('POST', '/invites', { role: 'member', email: `${tag}@example.com` });
  await other.req('POST', '/auth/signup', { token: inv.data.token, name: 'AI Test Other', email: `${tag}@example.com`, password: 'password123' });
});

after(async () => {
  if (reachable) {
    for (const id of created) await owner.req('DELETE', `/pages/${id}`).catch(() => {});
    if (prevSettings) {
      await owner.req('PUT', '/admin/ai/settings', {
        enabled: prevSettings.enabled, provider: prevSettings.keySource === 'env' ? undefined : prevSettings.provider,
        monthlyBudgetUsd: prevSettings.monthlyBudgetUsd, perUserMonthlyBudgetUsd: prevSettings.perUserMonthlyBudgetUsd, features: prevSettings.features,
      });
    }
    await pool.query(`delete from pages where title like $1`, [`%${tag}%`]);
    await pool.query(`delete from ai_conversations where user_id in (select id from users where email = $1)`, [`${tag}@example.com`]);
    await pool.query(`delete from users where email = $1`, [`${tag}@example.com`]);
    await pool.query(`delete from invites where email = $1`, [`${tag}@example.com`]);
  }
  await pool.end();
});

test('status reports enabled with the mock provider', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const r = await owner.req('GET', '/ai/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.provider, 'mock');
});

test('write streams delta events then done', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const r = await owner.sse('/ai/write', { action: 'fix', text: 'teh cat' });
  assert.equal(r.status, 200);
  assert.ok(r.of('delta').length > 0);
  assert.match(r.of('delta').map((d) => d.text).join(''), /teh cat \(fix\)/);
  assert.equal(r.of('done').length, 1);
});

test('chat cites only pages the user can see', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const word = `zebracorn${tag}`;
  const mine = await owner.req('POST', '/pages', { title: `My ${word} notes ${tag}`, markdown: `All about ${word}.` });
  const theirs = await other.req('POST', '/pages', { title: `Secret ${word} plans ${tag}`, markdown: `Private ${word} details.` });
  created.push(mine.data.id);
  assert.equal(theirs.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const r = await owner.sse('/ai/chat', { message: `What do we know about ${word}?`, mode: 'ask' });
  const cited = r.of('citations').flatMap((c) => c.pages.map((p: any) => p.id));
  assert.ok(cited.includes(mine.data.id), 'own page is cited');
  assert.ok(!cited.includes(theirs.data.id), "another user's private page is never cited");
  assert.ok(!JSON.stringify(r.events).includes('Private'), 'private content never reaches the stream');
  const convId = r.of('conversation')[0].id;
  const conv = await owner.req('GET', `/ai/conversations/${convId}`);
  assert.equal(conv.data.messages.length, 2);
  assert.equal(conv.data.messages[1].role, 'assistant');
  const fromOther = await other.req('GET', `/ai/conversations/${convId}`);
  assert.equal(fromOther.status, 404, 'conversations are private to their owner');
});

test('agent creates a page', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const title = `Agent page ${tag}`;
  const r = await owner.sse('/ai/chat', { message: `Please create a page called "${title}"`, mode: 'agent' });
  const call = r.of('tool_call')[0];
  assert.equal(call?.name, 'create-pages');
  const result = r.of('tool_result')[0];
  assert.equal(result.ok, true);
  assert.ok(result.pageId);
  created.push(result.pageId);
  const page = await owner.req('GET', `/pages/${result.pageId}`);
  assert.equal(page.data.title, title);
  assert.equal(r.of('done').length, 1);
});

test('destructive tool calls pause for confirmation (deny, then approve)', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const p = await owner.req('POST', '/pages', { title: `Delete me ${tag}` });
  created.push(p.data.id);
  // Deny
  let r = await owner.sse('/ai/chat', { message: `delete page ${p.data.id}`, mode: 'agent' });
  let confirm = r.of('confirm')[0];
  assert.equal(confirm?.name, 'delete-page');
  assert.equal(r.of('done')[0]?.paused, true);
  const convId = r.of('conversation')[0].id;
  const pend = await owner.req('GET', `/ai/conversations/${convId}`);
  assert.equal(pend.data.pending.length, 1);
  r = await owner.sse(`/ai/chat/${convId}/confirm`, { toolCallId: confirm.id, approve: false });
  assert.equal(r.of('tool_result')[0]?.ok, false);
  assert.equal((await owner.req('GET', `/pages/${p.data.id}`)).data.deleted_at, null, 'page untouched after deny');
  // Approve (same conversation)
  r = await owner.sse('/ai/chat', { conversationId: convId, message: `delete page ${p.data.id}`, mode: 'agent' });
  confirm = r.of('confirm')[0];
  assert.ok(confirm);
  r = await owner.sse(`/ai/chat/${convId}/confirm`, { toolCallId: confirm.id, approve: true });
  assert.equal(r.of('tool_result')[0]?.ok, true);
  assert.ok((await owner.req('GET', `/pages/${p.data.id}`)).data.deleted_at, 'page moved to trash after approve');
  const stale = await owner.req('POST', `/ai/chat/${convId}/confirm`, { toolCallId: confirm.id, approve: true });
  assert.equal(stale.status, 409);
});

test('budget exceeded returns 402 before streaming', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  await owner.req('PUT', '/admin/ai/settings', { monthlyBudgetUsd: 0 });
  try {
    const r = await owner.req('POST', '/ai/write', { action: 'fix', text: 'x' });
    assert.equal(r.status, 402);
    assert.match(r.data.error, /budget/i);
    const s = await owner.req('GET', '/ai/status');
    assert.equal(s.data.enabled, false);
  } finally {
    await owner.req('PUT', '/admin/ai/settings', { monthlyBudgetUsd: null });
  }
});

test('settings never return the API key', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const key = `test-key-${tag}-SECRETVALUE9876`;
  const put = await owner.req('PUT', '/admin/ai/settings', { apiKey: key });
  if (put.status === 400) {
    assert.match(put.data.error, /ATRIUM_ENCRYPTION_KEY/, 'refuses to store a key without encryption');
  } else {
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(key));
    const get = await owner.req('GET', '/admin/ai/settings');
    assert.ok(!get.text.includes('SECRETVALUE'));
    assert.equal(get.data.apiKeyLast4, '9876');
    const row = await pool.query('select api_key_enc from ai_settings limit 1');
    assert.ok(!String(row.rows[0]?.api_key_enc).includes('SECRETVALUE'), 'encrypted at rest');
    await owner.req('PUT', '/admin/ai/settings', { apiKey: '' });
  }
  const member = await other.req('GET', '/admin/ai/settings');
  assert.equal(member.status, 403, 'members cannot read AI settings');
});

test('autofill fills an AI property for every row', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const db = await owner.req('POST', '/pages', { title: `AI fill db ${tag}`, kind: 'database' });
  created.push(db.data.id);
  for (const t of ['Alpha task', 'Beta task']) await owner.req('POST', `/databases/${db.data.id}/rows`, { title: t });
  const prop = await owner.req('POST', `/databases/${db.data.id}/properties`, { name: 'Summary', type: 'ai', ai: { kind: 'summary', outputType: 'text', autoUpdate: false } });
  assert.equal(prop.data.type, 'ai');
  assert.equal(prop.data.ai.kind, 'summary');
  const fill = await owner.req('POST', `/databases/${db.data.id}/ai-fill`, { propId: prop.data.id });
  assert.equal(fill.data.queued, 2);
  let rows: any[] = [];
  for (let i = 0; i < 40; i++) {
    rows = (await owner.req('POST', `/databases/${db.data.id}/query`, {})).data.rows;
    if (rows.every((r) => r.props[prop.data.id])) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(rows.every((r) => typeof r.props[prop.data.id] === 'string' && r.props[prop.data.id].length > 0), 'every row has a value');
  const usage = await owner.req('GET', '/admin/ai/usage');
  assert.ok(usage.data.byFeature.some((f: any) => f.feature === 'autofill'));
});

test('autoUpdate re-fills rows after they change (job tick)', async (t) => {
  if (!reachable) return t.skip('server with AI routes not reachable (set ATRIUM_URL)');
  const { autoUpdateTick } = await import('./ai/autofill.js');
  const db = await owner.req('POST', '/pages', { title: `AI auto db ${tag}`, kind: 'database' });
  created.push(db.data.id);
  const prop = await owner.req('POST', `/databases/${db.data.id}/properties`, { name: 'Keywords', type: 'ai', ai: { kind: 'keywords', outputType: 'multi_select', autoUpdate: true } });
  const row = await owner.req('POST', `/databases/${db.data.id}/rows`, { title: 'Gamma launch plan' });
  const backdate = () => pool.query(`update pages set updated_at = now() - interval '2 minutes' where id = $1`, [row.data.id]);
  const value = async () => (await pool.query(`select props from pages where id = $1`, [row.data.id])).rows[0].props;
  const waitFor = async (ok: (p: any) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const p = await value();
      if (ok(p)) return p;
      await new Promise((r) => setTimeout(r, 150));
    }
    return value();
  };
  await backdate();
  await autoUpdateTick();
  let props = await waitFor((p) => Array.isArray(p[prop.data.id]) && p[prop.data.id].length > 0);
  assert.ok(props[prop.data.id].length > 0, 'new row filled');
  const schema = (await owner.req('GET', `/databases/${db.data.id}`)).data.schema;
  assert.ok(schema.find((p: any) => p.id === prop.data.id).options.length > 0, 'multi_select options were created');
  const firstMarker = props.__ai[prop.data.id];
  // No change → nothing to do.
  await autoUpdateTick();
  assert.equal((await value()).__ai[prop.data.id], firstMarker);
  // Edit the row → re-filled after the debounce.
  await owner.req('PATCH', `/pages/${row.data.id}`, { title: 'Gamma launch plan v2' });
  await backdate();
  await autoUpdateTick();
  props = await waitFor((p) => p.__ai[prop.data.id] !== firstMarker);
  assert.notEqual(props.__ai[prop.data.id], firstMarker, 'changed row was re-filled');
});
