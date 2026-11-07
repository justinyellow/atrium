/**
 * End-to-end test of the MCP server through the official SDK client, against a running Atrium.
 *   ATRIUM_URL (default http://localhost:3100), ATRIUM_EMAIL / ATRIUM_PASSWORD (dev defaults).
 * Run: npx tsx --test src/mcp.test.ts
 * Creates its own test data (a database + page) and deletes it afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.ATRIUM_URL ?? 'http://localhost:3100';
const EMAIL = process.env.ATRIUM_EMAIL ?? 'justin@example.com';
const PASSWORD = process.env.ATRIUM_PASSWORD ?? 'password123';

let cookie = '';
let token = '';
let tokenId = '';
let client: Client;
const cleanup: string[] = [];

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

before(async () => {
  await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  const t = await api('POST', '/tokens', { name: 'mcp e2e test' });
  token = t.token;
  tokenId = t.id;
  client = new Client({ name: 'atrium-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});

after(async () => {
  for (const id of cleanup.reverse()) {
    await api('DELETE', `/pages/${id}`).catch(() => {});
    await api('DELETE', `/pages/${id}/permanent`).catch(() => {});
  }
  await client?.close().catch(() => {});
  if (tokenId) await api('DELETE', `/tokens/${tokenId}`).catch(() => {});
});

test('rejects missing / bad credentials with an OAuth challenge', async () => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer atr_nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata=/);
});

test('lists tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['search', 'fetch', 'create-pages', 'update-page', 'query-database', 'create-database', 'update-database', 'create-view', 'create-comment', 'get-comments', 'get-users', 'get-self'])
    assert.ok(names.includes(n), `missing tool ${n}`);
  assert.ok(tools.find((t) => t.name === 'search')?.annotations?.readOnlyHint);
});

test('get-self returns the token owner', async () => {
  const me = await tool('get-self');
  assert.equal(me.email, EMAIL);
});

let dbId = '';
let rowId = '';
let pageId = '';

test('create-database with typed properties', async () => {
  const teams = await tool('get-teamspaces');
  const db = await tool('create-database', {
    parent: { teamspace_id: teams[0].id },
    title: 'MCP test tasks',
    icon: '🧪',
    properties: [
      { name: 'Task', type: 'title' },
      { name: 'Status', type: 'status', options: ['Todo', 'Doing', 'Done'] },
      { name: 'Points', type: 'number' },
      { name: 'Owner', type: 'person' },
      { name: 'Due', type: 'date' },
      { name: 'Tags', type: 'multi_select', options: ['api', 'mcp'] },
      { name: 'Double', type: 'formula', formula: 'prop("Points") * 2' },
    ],
  });
  dbId = db.id;
  cleanup.push(dbId);
  const names = db.schema.map((p: any) => p.name);
  assert.deepEqual(names.sort(), ['Double', 'Due', 'Owner', 'Points', 'Status', 'Tags', 'Task'].sort());
});

test('create-pages rows with friendly property values', async () => {
  const rows = await tool('create-pages', {
    parent: { database_id: dbId },
    pages: [
      { properties: { Task: 'Write MCP server', Status: 'Doing', Points: 5, Owner: EMAIL, Due: '2026-11-10', Tags: 'mcp, new-tag' }, content: '## Notes\n\n- stateless' },
      { properties: { Task: 'Ship it', Status: 'Todo', Points: 2, 'date:Due:start': '2026-11-12', 'date:Due:end': '2026-11-14' } },
    ],
  });
  assert.equal(rows.length, 2);
  rowId = rows[0].id;
});

test('query-database with filters and sorts by property name', async () => {
  const r = await tool('query-database', { database_id: dbId, filters: [{ property: 'Points', op: '>', value: 3 }], sorts: [{ property: 'Points', direction: 'descending' }] });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].Task, 'Write MCP server');
  assert.equal(r.rows[0].Status, 'Doing');
  assert.equal(r.rows[0].Double, 10);
  assert.deepEqual(r.rows[0].Tags.sort(), ['mcp', 'new-tag']);
  const byStatus = await tool('query-database', { database_id: dbId, filters: [{ property: 'Status', op: 'is', value: 'Todo' }] });
  assert.equal(byStatus.rows[0].Task, 'Ship it');
  assert.equal(byStatus.rows[0].Due, '2026-11-12 → 2026-11-14');
  const mine = await tool('query-database', { database_id: dbId, filters: [{ property: 'Owner', op: 'contains', value: 'me' }] });
  assert.equal(mine.total, 1);
});

test('update-page properties by name', async () => {
  await tool('update-page', { page_id: rowId, command: 'update_properties', properties: { Status: 'Done', Points: 8 } });
  const r = await tool('query-database', { database_id: dbId, search: 'Write MCP' });
  assert.equal(r.rows[0].Status, 'Done');
  assert.equal(r.rows[0].Double, 16);
});

test('fetch a row returns properties and markdown', async () => {
  const text: string = await tool('fetch', { id: `${BASE}/p/${rowId}` });
  assert.match(text, /"Status": "Done"/);
  assert.match(text, /## Notes/);
});

test('create-pages page with markdown, then content edits', async () => {
  const [p] = await tool('create-pages', { pages: [{ title: 'MCP test page', content: '# Intro\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.' }] });
  pageId = p.id;
  cleanup.push(pageId);
  await tool('update-page', { page_id: pageId, command: 'insert_content_after', selection: 'First paragraph.', content: 'Inserted after first.' });
  await tool('update-page', { page_id: pageId, command: 'replace_content_range', selection: 'Second...Third paragraph.', content: 'Replaced middle.' });
  await tool('update-page', { page_id: pageId, command: 'append_content', content: '- appended item' });
  const text: string = await tool('fetch', { id: pageId });
  const body = text.split('---').slice(1).join('---');
  assert.match(body, /First paragraph\.\s+Inserted after first\.\s+Replaced middle\.\s+[*-] appended item/);
  assert.doesNotMatch(body, /Second paragraph/);
});

test('search finds the new page', async () => {
  const r = await tool('search', { query: 'MCP test page' });
  assert.ok(r.some((x: any) => x.id === pageId));
});

test('comments round-trip', async () => {
  const c = await tool('create-comment', { page_id: pageId, body: 'Looks good from MCP' });
  await tool('create-comment', { page_id: pageId, thread_id: c.thread_id, body: 'Reply' });
  const threads = await tool('get-comments', { page_id: pageId });
  assert.equal(threads[0].comments.length, 2);
});

test('create-view and update-view by property names', async () => {
  const v = await tool('create-view', { database_id: dbId, name: 'Board', type: 'board' });
  await tool('update-view', { database_id: dbId, view_id: v.id, filters: [{ property: 'Status', op: 'is_not', value: 'Done' }], sorts: [{ property: 'Due', direction: 'ascending' }] });
  const db = await tool('fetch', { id: dbId });
  const board = db.views.find((x: any) => x.id === v.id);
  assert.equal(board.type, 'board');
  assert.equal(board.filters[0].property, 'Status');
});

test('update-database adds, renames and deletes properties', async () => {
  const r = await tool('update-database', {
    database_id: dbId,
    add_properties: [{ name: 'Link', type: 'url' }],
    update_properties: [{ name: 'Points', new_name: 'Estimate' }],
    delete_properties: ['Tags'],
  });
  const names = r.schema.map((p: any) => p.name);
  assert.ok(names.includes('Link') && names.includes('Estimate') && !names.includes('Tags') && !names.includes('Points'));
});

test('permission errors come back as tool errors, not crashes', async () => {
  await assert.rejects(tool('fetch', { id: '00000000-0000-4000-8000-000000000000' }), /not found|access/i);
  await assert.rejects(tool('update-page', { page_id: rowId, command: 'update_properties', properties: { Nope: 1 } }), /Unknown property "Nope"/);
});
