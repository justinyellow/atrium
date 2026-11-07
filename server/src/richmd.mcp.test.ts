/**
 * End-to-end: rich markdown through the MCP server (official SDK client) against a running Atrium.
 * Proves that fetch → edit one paragraph → update-page leaves every other block (toggles, callouts,
 * colours, mentions, columns, tables) intact — same content AND same block ids.
 *   ATRIUM_URL (default http://localhost:3100), ATRIUM_EMAIL / ATRIUM_PASSWORD (dev defaults).
 * Run: npx tsx --test src/richmd.mcp.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.ATRIUM_URL ?? 'http://localhost:3100';
const EMAIL = process.env.ATRIUM_EMAIL ?? 'justin@example.com';
const PASSWORD = process.env.ATRIUM_PASSWORD ?? 'password123';

let cookie = '';
let tokenId = '';
let client: Client;
let me: any;
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
  return t && (r.headers.get('content-type') ?? '').includes('json') ? JSON.parse(t) : t;
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

/** Page body from fetch (after the JSON header). */
const bodyOf = (fetched: string) => fetched.slice(fetched.indexOf('\n---\n') + 5).trim();

/** Top-level block ids + serialisable content, for comparing untouched blocks. */
async function blocks(id: string) {
  return (await api('GET', `/pages/${id}/content`)).blocks as any[];
}

before(async () => {
  await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  me = await api('GET', '/me');
  const t = await api('POST', '/tokens', { name: 'richmd e2e test' });
  tokenId = t.id;
  client = new Client({ name: 'atrium-richmd-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t.token}` } } }));
});

after(async () => {
  for (const id of cleanup.reverse()) {
    await api('DELETE', `/pages/${id}`).catch(() => {});
    await api('DELETE', `/pages/${id}/permanent`).catch(() => {});
  }
  await client?.close().catch(() => {});
  if (tokenId) await api('DELETE', `/tokens/${tokenId}`).catch(() => {});
});

test('fetch → edit one paragraph → update-page keeps every other block intact', async () => {
  const [target] = await tool('create-pages', { pages: [{ title: 'Richmd target', content: 'target page' }] });
  cleanup.push(target.id);
  const content = [
    '# Richmd round trip',
    '',
    `Owner <mention url="user://${me.id}">${me.name}</mention> links to <mention url="${target.url}">Richmd target</mention> by <date start="2026-11-20" />.`,
    '',
    'The alpha paragraph that we will edit.',
    '',
    '<callout icon="⚠️" color="red_bg">',
    'Careful <b>bold</b> and <span color="blue">blue</span>',
    '',
    '- callout child',
    '</callout>',
    '',
    '<toggle>',
    'Toggle title',
    '',
    'Hidden body',
    '</toggle>',
    '',
    '<toggle heading="h2">',
    'Toggle heading',
    '',
    '- [x] done inside',
    '</toggle>',
    '',
    '<columns>',
    '<column width="2">',
    'Left column',
    '</column>',
    '<column>',
    'Right column',
    '</column>',
    '</columns>',
    '',
    '<table header-row="true">',
    '<tr>',
    '<th>Key</th>',
    '<th>Value</th>',
    '</tr>',
    '<tr>',
    '<td color="yellow_bg">a</td>',
    '<td>1</td>',
    '</tr>',
    '</table>',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    'Closing words.',
  ].join('\n');
  const [page] = await tool('create-pages', { pages: [{ title: 'Richmd round trip', content }] });
  cleanup.push(page.id);
  assert.equal(page.warnings, undefined, `unexpected warnings: ${JSON.stringify(page.warnings)}`);

  const before = await blocks(page.id);
  const fetched = bodyOf(await tool('fetch', { id: page.id }));
  // Everything we wrote comes back structurally (callout/toggle/columns/table/mentions survive).
  for (const needle of ['<callout icon="⚠️" color="red_bg">', '<toggle>', '<toggle heading="h2">', '<columns>', '<column width="2">', '<td color="yellow_bg">a</td>', `<mention url="user://${me.id}">`, `<mention url="${target.url}">`, '<date start="2026-11-20" />', '$$\nE = mc^2\n$$', '<span color="blue">blue</span>']) {
    assert.ok(fetched.includes(needle), `fetch output lost: ${needle}\n---\n${fetched}`);
  }

  const r = await tool('update-page', { page_id: page.id, command: 'update_content', content_updates: [{ old_str: 'The alpha paragraph', new_str: 'The beta paragraph' }] });
  assert.equal(r.changed, true);
  const after = await blocks(page.id);
  assert.equal(after.length, before.length);
  const changed = after.map((b, i) => (JSON.stringify(b) === JSON.stringify(before[i]) ? null : i)).filter((x) => x !== null);
  assert.equal(changed.length, 1, `exactly one top-level block should change, got ${JSON.stringify(changed)}`);
  assert.ok(JSON.stringify(after[changed[0]!]).includes('The beta paragraph'));
  const refetched = bodyOf(await tool('fetch', { id: page.id }));
  assert.equal(refetched, fetched.replace('The alpha paragraph', 'The beta paragraph'));

  // replace_content with the fetched text + one edit: still only one block replaced, ids kept elsewhere.
  await tool('update-page', { page_id: page.id, command: 'replace_content', content: refetched.replace('Closing words.', 'Closing words, revised.') });
  const after2 = await blocks(page.id);
  const sameIds = after2.filter((b, i) => b.id === after[i]?.id).length;
  assert.equal(sameIds, after.length - 1, 'replace_content should only replace the edited block');
  assert.equal(bodyOf(await tool('fetch', { id: page.id })), refetched.replace('Closing words.', 'Closing words, revised.'));

  // insert after a selection, then replace a range: untouched blocks keep their ids.
  await tool('update-page', { page_id: page.id, command: 'insert_content_after', selection: 'The beta paragraph', content: '<callout icon="📌">Inserted note</callout>' });
  const after3 = await blocks(page.id);
  assert.equal(after3.length, after2.length + 1);
  assert.deepEqual(after3.filter((b) => !JSON.stringify(b).includes('Inserted note')).map((b) => b.id), after2.map((b) => b.id));
  await tool('update-page', { page_id: page.id, command: 'replace_content_range', selection: 'Inserted note', content: '> Replaced quote' });
  const after4 = await blocks(page.id);
  assert.deepEqual(after4.filter((b) => b.type !== 'quote').map((b) => b.id), after2.map((b) => b.id));
});

test('fetch formats, warnings for foreign references, and <page> creates sub-pages', async () => {
  const [page] = await tool('create-pages', {
    pages: [
      {
        title: 'Richmd warnings',
        content: [
          'See <mention url="https://app.notion.com/p/0123456789abcdef0123456789abcdef">Old spec</mention> and <mention url="user://00000000-0000-4000-8000-000000000000" />.',
          '',
          '<page>Fresh child page</page>',
        ].join('\n'),
      },
    ],
  });
  cleanup.push(page.id);
  assert.ok(page.warnings?.some((w: string) => w.includes('outside this workspace')), JSON.stringify(page.warnings));
  assert.ok(page.warnings?.some((w: string) => w.includes('unknown person')), JSON.stringify(page.warnings));
  const rich = bodyOf(await tool('fetch', { id: page.id }));
  assert.ok(rich.includes('[Old spec](https://app.notion.com/p/0123456789abcdef0123456789abcdef)'), rich);
  assert.ok(rich.includes('@Unknown person'), rich);
  const sub = rich.match(/<page url="[^"]*\/p\/([0-9a-f-]{36})">Fresh child page<\/page>/);
  assert.ok(sub, `sub-page should be created: ${rich}`);
  cleanup.push(sub![1]);
  const md = bodyOf(await tool('fetch', { id: page.id, format: 'markdown' }));
  assert.ok(md.includes('Old spec'));
  const asBlocks = await tool('fetch', { id: page.id, format: 'blocks' });
  assert.ok(Array.isArray(asBlocks.blocks));
});
