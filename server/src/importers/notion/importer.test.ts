// Notion importer integration test against a fake Notion API (synthetic fixtures) and the local dev DB.
// Run: npx tsx --test src/importers/notion/importer.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { migrate, one, pool, q } from '../../db.js';
import { loadUser } from '../../auth.js';
import { docToBlocks } from '../../markdown.js';
import { hocuspocus } from '../../collab.js';
import { NotionImport } from './importer.js';
import { buildExtraWorkspace, buildWorkspace, fakeNotionFetch, IDS, rt, XIDS } from './fake.js';
import { NotionClient, mapLimit } from './client.js';
import { startNotionImport } from '../../routes/import.js';

let tsId = '';
const extraTeamspaces: string[] = [];
let admin: any;
const createdUsers: string[] = [];
const files: string[] = [];

const fakeFiles = async (_u: any, url: string, o: any = {}) => {
  files.push(url);
  const id = randomUUID();
  return { id, url: `/api/v1/files/${id}`, name: o.name ?? 'file', size: 1, mime: 'application/octet-stream' };
};

async function blocksOf(pageId: string) {
  const r = await one<{ ydoc: Buffer }>('select ydoc from page_content where page_id = $1', [pageId]);
  const d = new Y.Doc();
  if (r) Y.applyUpdate(d, new Uint8Array(r.ydoc));
  return docToBlocks(d);
}
const flat = (blocks: any[]): any[] => blocks.flatMap((b) => [b, ...flat(b.children ?? [])]);
const atriumId = async (nid: string) => (await one<{ atrium_id: string }>(`select atrium_id from import_mappings where source = 'notion' and source_id = $1`, [nid]))?.atrium_id;

async function run(ws: any, extra: Record<string, any> = {}) {
  const { id, done } = await startNotionImport(
    admin,
    { token: 'secret_fake', targetTeamspaceId: tsId, peopleMode: 'guests', ...extra },
    { fetchImpl: fakeNotionFetch(ws, { rateLimitOnce: true }), fileImporter: fakeFiles as any, minIntervalMs: 0 },
  );
  await done;
  return one<any>('select * from import_jobs where id = $1', [id]);
}

test('setup', async () => {
  await migrate();
  const u = await one<{ id: string }>(`select id from users where email = 'justin@example.com'`);
  assert.ok(u, 'dev user justin@example.com must exist');
  admin = await loadUser(u!.id, 'session');
  // Leftovers from an interrupted earlier run (after() never ran): synthetic fixtures only.
  const stale = (await q<{ id: string }>(`select id from teamspaces where workspace_id = $1 and name like 'Notion importer test%'`, [admin.workspaceId])).map((r) => r.id);
  if (stale.length) {
    const pages = (await q<{ id: string }>(`select id from pages where teamspace_id = any($1::uuid[])`, [stale])).map((r) => r.id);
    await q(`delete from import_mappings where atrium_id = any($1::uuid[])`, [[...pages, ...stale]]);
    await q(`delete from pages where teamspace_id = any($1::uuid[])`, [stale]);
    await q(`delete from import_jobs where options->>'targetTeamspaceId' = any($1::text[])`, [stale]);
    await q(`delete from teamspaces where id = any($1::uuid[])`, [stale]);
  }
  const ts = await one<{ id: string }>(`insert into teamspaces(workspace_id, name, icon) values ($1, 'Notion importer test', '🧪') returning id`, [admin.workspaceId]);
  tsId = ts!.id;
});

test('dry run discovers without writing', async () => {
  const ws = buildWorkspace();
  const job = await run(ws, { dryRun: true });
  assert.equal(job.status, 'done', job.error);
  const s = job.report.summary;
  assert.equal(s.pages, 2);
  assert.equal(s.databases, 2);
  assert.equal(s.rows, 3);
  assert.equal(s.templates, 1);
  assert.ok(s.views >= 5);
  assert.deepEqual(s.roots.map((r: any) => r.title).sort(), ['Estimates', 'Handbook']);
  const pages = await one<{ n: number }>(`select count(*)::int as n from pages where teamspace_id = $1`, [tsId]);
  assert.equal(pages!.n, 0);
  assert.equal(job.report.counts.people.created, 0, 'dry run must not create guests');
});

test('trial-import regressions: data_source query results, unreadable feed views, encoded property ids', async () => {
  const ws = buildWorkspace();
  // A Notion "feed" view whose settings the API refuses to return.
  (ws.views as any)[IDS.db1].push({ object: 'view', id: 'v-feed', name: 'Feed' });
  const inner = fakeNotionFetch(ws, { rateLimitOnce: true });
  const res = (status: number, body: any) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl: any = async (url: string, init: any) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    if (path === '/views/v-feed') return res(400, { object: 'error', code: 'validation_error', message: 'Unsupported view type: feed' });
    const r = await inner(url, init);
    if (/^\/data_sources\/[^/]+\/query$/.test(path) && path.includes(IDS.ds1)) {
      // Notion also returns data_source objects (databases inside row pages) from a data source query.
      const body = await r.json();
      return res(200, { ...body, results: [{ object: 'data_source', id: '99999999-9999-4999-8999-999999999999', title: [rt('Nested')], properties: { Name: { id: 'title', type: 'title', title: {} } } }, ...body.results] });
    }
    return r;
  };
  const { id, done } = await startNotionImport(admin, { token: 'secret_fake', targetTeamspaceId: tsId, peopleMode: 'text', dryRun: true }, { fetchImpl, fileImporter: fakeFiles as any, minIntervalMs: 0 });
  await done;
  const job = await one<any>('select * from import_jobs where id = $1', [id]);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.error, null);
  assert.equal(job.report.summary.rows, 3, 'data_source results are not rows');
  assert.ok(!job.report.warnings.some((w: any) => w.kind === 'fetch_failed'), JSON.stringify(job.report.warnings.filter((w: any) => w.kind === 'fetch_failed')));
  assert.ok(!job.report.warnings.some((w: any) => w.kind === 'views'), 'one unreadable view must not drop the others');
  const { convertView, findProp, plain } = await import('./convert.js');
  const warns: string[] = [];
  const ctx: any = { warn: (_k: string, m: string) => warns.push(m) };
  assert.equal(convertView({ name: 'Feed', type: 'feed', _unreadable: 'x' }, [], ctx).type, 'list');
  const schema = [{ id: 'p1', name: 'Area', type: 'select', notion_id: 'xC%3Ej' }];
  assert.equal(findProp(schema, 'xC>j')?.id, 'p1', 'decoded ids from view filters match encoded schema ids');
  assert.equal(findProp(schema, 'xC%3Ej')?.id, 'p1');
  assert.equal(plain({} as any), '');
  assert.equal(plain('text' as any), 'text');
});

test('full import: pages, blocks, rich text, mentions', async () => {
  const ws = buildWorkspace();
  const job = await run(ws);
  assert.equal(job.status, 'done', job.error);
  const handbook = (await atriumId(IDS.handbook))!;
  const sub = (await atriumId(IDS.sub))!;
  const db1 = (await atriumId(IDS.db1))!;
  assert.ok(handbook && sub && db1);
  const page = await one<any>('select * from pages where id = $1', [handbook]);
  assert.equal(page.title, 'Handbook');
  assert.equal(page.icon, '📘');
  assert.equal(page.cover, 'https://images.example.com/cover.jpg');
  assert.equal(page.teamspace_id, tsId);
  assert.equal(new Date(page.created_at).toISOString(), '2025-03-01T09:00:00.000Z', 'created time preserved');
  assert.equal(page.created_by, admin.id, 'created_by mapped by email');
  const subRow = await one<any>('select parent_id from pages where id = $1', [sub]);
  assert.equal(subRow.parent_id, handbook);

  const blocks = await blocksOf(handbook);
  const types = flat(blocks).map((b) => b.type);
  for (const t of ['heading', 'callout', 'checkListItem', 'numberedListItem', 'toggleListItem', 'quote', 'divider', 'codeBlock', 'equation', 'table', 'image', 'bookmark', 'embed', 'columnList', 'column', 'syncedBlock', 'toc', 'breadcrumb', 'subpage', 'database']) {
    assert.ok(types.includes(t), `missing block type ${t}`);
  }
  const h = blocks.find((b) => b.type === 'heading')!;
  assert.equal(h.props.isToggleable, true);
  assert.equal(h.children[0].content[0].text, 'Hidden in a toggle heading');
  const callout = blocks.find((b) => b.type === 'callout')!;
  assert.equal(callout.props.emoji, '🚀');
  assert.equal(callout.props.backgroundColor, 'blue');
  assert.equal(callout.children[0].type, 'bulletListItem');
  const p = blocks.find((b) => b.type === 'paragraph' && b.content?.some((c: any) => c.type === 'mention'))!;
  const inl = p.content;
  assert.ok(inl.some((c: any) => c.type === 'text' && c.text === 'Bold' && c.styles.bold));
  assert.ok(inl.some((c: any) => c.type === 'text' && c.text === 'red' && c.styles.textColor === 'red'));
  assert.ok(inl.some((c: any) => c.type === 'text' && c.text === 'highlight' && c.styles.backgroundColor === 'yellow'));
  assert.ok(inl.some((c: any) => c.type === 'link' && c.href === `/p/${sub}`), 'link to Notion page remapped');
  assert.ok(inl.some((c: any) => c.type === 'mention' && c.props.kind === 'user' && c.props.id === admin.id));
  assert.ok(inl.some((c: any) => c.type === 'mention' && c.props.kind === 'page' && c.props.id === sub));
  assert.ok(inl.some((c: any) => c.type === 'mention' && c.props.kind === 'date' && c.props.date === '2025-07-01'));
  assert.ok(inl.some((c: any) => c.type === 'inlineEquation' && c.props.latex === 'E=mc^2'));
  const table = blocks.find((b) => b.type === 'table')!;
  assert.equal(table.content.headerRows, 1);
  assert.equal(table.content.rows.length, 2);
  const images = blocks.filter((b) => b.type === 'image');
  assert.ok(images[0].props.url.startsWith('/api/v1/files/'), 'Notion-hosted image rehosted');
  assert.equal(images[1].props.url, 'https://images.example.com/photo.jpg', 'external image kept');
  assert.ok(files.some((u) => u.includes('diagram.png')));
  const cols = blocks.find((b) => b.type === 'columnList')!;
  assert.equal(cols.children.length, 2);
  assert.equal(cols.children[1].children[0].content[0].text, 'Right column');
  assert.equal(blocks.find((b) => b.type === 'database')!.props.databaseId, db1);
  assert.ok(blocks.some((b) => b.type === 'callout' && b.props.emoji === '⚠️'), 'unsupported block noted');
  assert.ok(job.report.warningCounts.unsupported_block >= 1);

  // synced block: original + duplicate point at the same Atrium synced page
  const syncedId = blocks.find((b) => b.type === 'syncedBlock')!.props.sourceId;
  const subBlocks = await blocksOf(sub);
  assert.equal(subBlocks.find((b) => b.type === 'syncedBlock')!.props.sourceId, syncedId);
  const syncedBlocks = await blocksOf(syncedId);
  assert.equal(syncedBlocks[0].content[0].text, 'Shared policy text');
  assert.ok(subBlocks.some((b) => b.content?.some?.((c: any) => c.type === 'mention' && c.props.id === handbook)), 'link_to_page → mention');

  // linked database view → linked 'database' block on the source, with block-scoped views
  const db2 = (await atriumId(IDS.db2))!;
  const linkedBlock = subBlocks.find((b) => b.type === 'database')!;
  assert.deepEqual(linkedBlock.props, { databaseId: db2, linked: true });
  const lv = await q<any>('select * from database_views where database_id = $1 and block_id = $2', [db2, IDS.linked]);
  assert.equal(lv.length, 1);
  assert.equal(lv[0].name, 'Big estimates');
  assert.equal(lv[0].config.filter.filters[0].op, '>');
  const unscoped = await q<any>('select name from database_views where database_id = $1 and block_id is null', [db2]);
  assert.deepEqual(unscoped.map((v) => v.name), ['All'], 'source database keeps only its own views');
});

test('databases: schema, rows, relations, rollups, views, templates', async () => {
  const db1 = (await atriumId(IDS.db1))!;
  const db2 = (await atriumId(IDS.db2))!;
  const schema1 = (await one<any>('select schema from databases where page_id = $1', [db1])).schema;
  const byName = (n: string) => schema1.find((p: any) => p.name === n);
  assert.equal(byName('Name').type, 'title');
  assert.deepEqual(byName('Status').options.map((o: any) => [o.name, o.group]), [['Backlog', 'todo'], ['Doing', 'in_progress'], ['Fixed', 'complete']]);
  assert.equal(byName('Tags').options[0].color, 'red');
  assert.equal(byName('Owner').type, 'person');
  assert.equal(byName('Owner').description, 'Who is responsible');
  assert.equal(byName('Ref').id_prefix, 'T');
  assert.equal(byName('Double').type, 'formula');
  assert.ok(byName('Double').formula.expression.includes('{{notion:block_property:pts'));
  assert.equal(byName('Points').notion_id, 'pts');
  assert.equal(byName('Rel').relation.databaseId, db2);
  const schema2 = (await one<any>('select schema from databases where page_id = $1', [db2])).schema;
  const back = schema2.find((p: any) => p.name === 'Back');
  assert.equal(byName('Rel').relation.syncedPropId, back.id, 'two-way relation linked');
  assert.equal(byName('Total').type, 'rollup');
  assert.equal(byName('Total').rollup.relationPropId, byName('Rel').id);
  assert.equal(byName('Total').rollup.targetPropId, schema2.find((p: any) => p.name === 'Estimate').id);

  const r1 = await one<any>('select * from pages where id = $1', [await atriumId(IDS.r1)]);
  const r2 = await one<any>('select * from pages where id = $1', [await atriumId(IDS.r2)]);
  const r3id = await atriumId(IDS.r3);
  assert.equal(r1.kind, 'row');
  assert.equal(r1.title, 'Task one');
  assert.equal(r1.props[byName('Status').id], 'st3');
  assert.deepEqual(r1.props[byName('Tags').id], ['t1']);
  assert.deepEqual(r1.props[byName('Owner').id], [admin.id]);
  assert.deepEqual(r1.props[byName('Due').id], { start: '2025-07-01', end: '2025-07-03' });
  assert.equal(r1.props[byName('Points').id], 5);
  assert.deepEqual(r1.props[byName('Rel').id], [r3id]);
  assert.equal(r1.props.__uid, 1);
  assert.ok(r1.props[byName('Attach').id][0].url.startsWith('/api/v1/files/'));
  const grace = await one<any>(`select id from users where email = 'grace.import-test@synthetic.test'`);
  assert.ok(grace, 'guest created for unmatched person');
  createdUsers.push(grace.id);
  assert.deepEqual(r2.props[byName('Owner').id], [grace.id]);
  const role = await one<any>('select role from workspace_members where user_id = $1', [grace.id]);
  assert.equal(role.role, 'guest');
  assert.equal(r1.updated_by, grace.id, 'last_edited_by mapped');
  const rowBody = await blocksOf(r1.id);
  assert.equal(rowBody[0].content[0].text, 'Row body for task one');

  const views = await q<any>('select * from database_views where database_id = $1 order by position', [db1]);
  const board = views.find((v) => v.name === 'By status');
  assert.equal(board.type, 'board');
  assert.equal(board.config.groupBy, byName('Status').id);
  assert.deepEqual(board.config.sorts, [{ prop: byName('Points').id, dir: 'desc' }]);
  assert.deepEqual(board.config.filter, { op: 'and', filters: [{ prop: byName('Done').id, op: 'is', value: false }] });
  assert.equal(views.find((v) => v.name === 'Calendar').config.calendarBy, byName('Due').id);
  const recent = views.find((v) => v.name === 'Recent');
  assert.equal(recent.config.filter.filters.length, 2, 'unsupported "this_week" dropped, others kept');
  assert.ok(recent.config.properties.some((p: any) => p.id === byName('Points').id && p.visible === false));
  const chart = views.find((v) => v.name === 'Chart');
  assert.equal(chart.type, 'chart');
  assert.equal(chart.config.chart.kind, 'bar');
  const tpl = await one<any>('select * from pages where id = $1', [await atriumId(IDS.tpl)]);
  assert.equal(tpl.is_template, true);
  assert.equal(tpl.parent_id, db1);
});

test('comments, people and report', async () => {
  const handbook = (await atriumId(IDS.handbook))!;
  const threads = await q<any>(
    `select t.id, c.body, c.author_id, c.created_at from comment_threads t join comments c on c.thread_id = t.id where t.page_id = $1 order by c.created_at`,
    [handbook],
  );
  assert.equal(threads.length, 2);
  assert.equal(threads[0].author_id, admin.id);
  assert.match(threads[0].body, /@\[Grace Hopper\]\(/);
  assert.equal(new Date(threads[0].created_at).toISOString(), '2025-05-01T10:00:00.000Z');
  const job = await one<any>(`select report from import_jobs where workspace_id = $1 and not dry_run and kind = 'import' order by created_at desc limit 1`, [admin.workspaceId]);
  assert.equal(job.report.counts.people.matched, 1);
  assert.equal(job.report.counts.people.created, 1);
  assert.ok(job.report.warningCounts.view_filter >= 1);
  assert.ok(job.report.warningCounts.view_best_effort >= 1);
});

test('re-run is idempotent and updates edited pages', async () => {
  const before = await one<{ n: number }>(`select count(*)::int as n from pages where teamspace_id = $1`, [tsId]);
  const comments = await one<{ n: number }>(`select count(*)::int as n from comments c join comment_threads t on t.id = c.thread_id join pages p on p.id = t.page_id where p.teamspace_id = $1`, [tsId]);
  const ws = buildWorkspace();
  const job = await run(ws);
  assert.equal(job.status, 'done', job.error);
  const after1 = await one<{ n: number }>(`select count(*)::int as n from pages where teamspace_id = $1`, [tsId]);
  assert.equal(after1!.n, before!.n, 'no duplicate pages');
  assert.ok(job.report.counts.pages.skipped >= 2);
  const comments2 = await one<{ n: number }>(`select count(*)::int as n from comments c join comment_threads t on t.id = c.thread_id join pages p on p.id = t.page_id where p.teamspace_id = $1`, [tsId]);
  assert.equal(comments2!.n, comments!.n, 'no duplicate comments');

  // Edit the sub page in "Notion" and re-run: same Atrium page, new content.
  const ws2 = buildWorkspace();
  ws2.pages[IDS.sub].last_edited_time = '2025-09-01T00:00:00.000Z';
  const sb = ws2.children.get(IDS.sub)!;
  sb[2] = { ...sb[2], paragraph: { rich_text: [rt('Version two')], color: 'default' } };
  const subId = await atriumId(IDS.sub);
  const job2 = await run(ws2);
  assert.equal(job2.status, 'done', job2.error);
  assert.equal(await atriumId(IDS.sub), subId);
  assert.ok(job2.report.counts.pages.updated >= 1);
  const blocks = await blocksOf(subId!);
  assert.ok(blocks.some((b) => b.content?.[0]?.text === 'Version two'));
  assert.ok(!blocks.some((b) => b.content?.[0]?.text === 'Version one'));
  const after2 = await one<{ n: number }>(`select count(*)::int as n from pages where teamspace_id = $1`, [tsId]);
  assert.equal(after2!.n, before!.n);
});

test('teamspace mapping, inline comments, block-parented pages, new property/view types', async () => {
  const ws = buildExtraWorkspace();
  const job = await run(ws, {
    rootIds: [XIDS.alpha, XIDS.beta],
    includeInlineComments: true,
    teamspaces: [{ name: 'Notion importer test Eng', icon: '🛠', rootIds: [XIDS.beta], access: 'members' }],
  });
  assert.equal(job.status, 'done', job.error);
  const eng = await one<any>(`select * from teamspaces where workspace_id = $1 and name = 'Notion importer test Eng'`, [admin.workspaceId]);
  assert.ok(eng, 'teamspace created');
  extraTeamspaces.push(eng.id);
  assert.equal(eng.is_default, false, 'members-only teamspace');
  assert.ok(await one(`select 1 from import_mappings where source = 'notion' and kind = 'teamspace' and atrium_id = $1`, [eng.id]), 'teamspace mapping recorded');
  const ts = async (nid: string) => (await one<any>('select teamspace_id from pages where id = $1', [await atriumId(nid)]))?.teamspace_id;
  assert.equal(await ts(XIDS.alpha), tsId);
  for (const nid of [XIDS.beta, XIDS.nested, XIDS.db, XIDS.row]) assert.equal(await ts(nid), eng.id, `${nid} follows its root into the mapped teamspace`);

  // Block-parented page (inside a column) keeps its parent instead of becoming a root.
  const beta = (await atriumId(XIDS.beta))!;
  assert.equal((await one<any>('select parent_id from pages where id = $1', [await atriumId(XIDS.nested)])).parent_id, beta);

  // Page verification.
  const betaPage = await one<any>('select props from pages where id = $1', [beta]);
  assert.deepEqual(betaPage.props.__verification, { state: 'verified', by: admin.id, at: '2025-04-02', until: '2025-10-02' });

  // Inline comment: thread anchored to the block, text marked.
  const thread = await one<any>(`select * from comment_threads where page_id = $1 and block_id = $2`, [beta, XIDS.commented]);
  assert.ok(thread, 'inline thread anchored to its block');
  assert.equal(thread.quote, 'Commented sentence');
  const para = (await blocksOf(beta)).find((b) => b.id === XIDS.commented)!;
  assert.equal(para.content[0].styles.comment, thread.id, 'commented text carries the thread mark');

  // New property types.
  const db = (await atriumId(XIDS.db))!;
  const schema = (await one<any>('select schema from databases where page_id = $1', [db])).schema;
  const prop = (n: string) => schema.find((p: any) => p.name === n);
  assert.equal(prop('Where').type, 'place');
  assert.equal(prop('Checked').type, 'verification');
  assert.deepEqual(prop('Go').button, { label: 'Go', actions: [] });
  const row = await one<any>('select props from pages where id = $1', [await atriumId(XIDS.row)]);
  assert.deepEqual(row.props[prop('Where').id], { lat: -33.92, lng: 18.42, name: 'Office', address: '1 Main Rd' });
  assert.deepEqual(row.props[prop('Checked').id], { state: 'verified', by: admin.id, at: '2025-04-03' });

  // New view types + quick filters.
  const views = await q<any>('select * from database_views where database_id = $1 order by position', [db]);
  const v = (n: string) => views.find((x) => x.name === n);
  assert.deepEqual(v('All').config.quickFilters, [{ prop: prop('Kind').id, op: 'is', value: ['k1'] }, { prop: prop('Checked').id }]);
  assert.equal(v('All').config.frozenColumns, 1);
  assert.equal(v('By kind').type, 'chart');
  assert.equal(v('By kind').config.chart.kind, 'donut');
  assert.equal(v('By kind').config.chart.xProp, prop('Kind').id);
  assert.equal(v('Suggest').type, 'form');
  assert.deepEqual(v('Suggest').config.form.questions, [{ propId: prop('Name').id, required: true }, { propId: prop('Where').id }]);
  assert.equal(v('Map').type, 'map');
  assert.equal(v('Map').config.map.placeProp, prop('Where').id);

  // Alpha links to Gamma, which wasn't imported: recorded for relinking.
  assert.ok(job.report.counts.unresolvedLinks >= 1);
  const meta = await one<any>(`select meta from import_mappings where source = 'notion' and source_id = $1`, [XIDS.alpha]);
  assert.deepEqual(meta.meta.unresolved, [XIDS.gamma]);
});

test('markdown fetch, follow links and relink', async () => {
  const ws = buildExtraWorkspace();
  const job = await run(ws, { rootIds: [XIDS.gamma], followLinks: 1 });
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.report.counts.markdownPages >= 3, 'Gamma, its child and Delta fetched as Markdown');
  const gamma = (await atriumId(XIDS.gamma))!;
  const delta = await atriumId(XIDS.delta);
  assert.ok(delta, 'Delta imported by following a link');
  assert.equal((await one<any>('select parent_id from pages where id = $1', [await atriumId(XIDS.gammaChild)])).parent_id, gamma);
  const gBlocks = flat(await blocksOf(gamma));
  const pointsAt = (c: any, id: string) => (c.type === 'mention' && c.props.id === id) || (c.type === 'link' && c.href === `/p/${id}`);
  assert.ok(gBlocks.some((b) => b.content?.some?.((c: any) => pointsAt(c, delta!))), 'link to Delta points at the Atrium page');
  assert.ok(gBlocks.some((b) => b.type === 'subpage'), 'child page tag became a sub-page block');

  // The job's relink pass fixed Alpha's link to Gamma from the earlier run.
  assert.ok(job.report.counts.relink.linksFixed >= 1);
  const alpha = (await atriumId(XIDS.alpha))!;
  assert.ok(flat(await blocksOf(alpha)).some((b) => b.content?.some?.((c: any) => c.type === 'mention' && c.props.id === gamma)), 'Alpha now mentions Gamma');
  const meta = await one<any>(`select meta from import_mappings where source = 'notion' and source_id = $1`, [XIDS.alpha]);
  assert.deepEqual(meta.meta.unresolved, []);
});

test('private roots go to the owner\'s Private section, or are skipped', async () => {
  const email = 'ada.private-import@synthetic.test';
  const priv = (extra: any = {}) => [{ name: 'Ada Private', kind: 'private', ownerEmail: email, rootIds: [XIDS.delta], ...extra }];
  const job = await run(buildExtraWorkspace(), { rootIds: [XIDS.delta], teamspaces: priv() });
  assert.equal(job.status, 'done', job.error);
  const ada = await one<any>(`select id from users where email = $1`, [email]);
  assert.ok(ada, 'owner account created');
  createdUsers.push(ada.id);
  assert.equal((await one<any>(`select role from workspace_members where user_id = $1 and workspace_id = $2`, [ada.id, admin.workspaceId])).role, 'member');
  const delta = await one<any>('select teamspace_id, owner_id, parent_id from pages where id = $1', [await atriumId(XIDS.delta)]);
  assert.equal(delta.teamspace_id, null, 'never in a shared teamspace');
  assert.equal(delta.owner_id, ada.id);
  assert.equal(delta.parent_id, null);
  assert.equal(job.report.privateOwners[0].created, true);

  // skip: a private root is not read or written at all.
  const before = await one<any>('select teamspace_id from pages where id = $1', [await atriumId(XIDS.alpha)]);
  const job2 = await run(buildExtraWorkspace(), { rootIds: [XIDS.alpha], privatePages: 'skip', teamspaces: [{ name: 'Someone', kind: 'private', ownerEmail: email, rootIds: [XIDS.alpha] }] });
  assert.equal(job2.status, 'done', job2.error);
  assert.equal(job2.report.counts.privateSkipped, 1);
  assert.equal(job2.report.summary.pages, 0);
  assert.equal((await one<any>('select teamspace_id from pages where id = $1', [await atriumId(XIDS.alpha)])).teamspace_id, before.teamspace_id);

  // No owner email: left out rather than placed in a shared teamspace.
  const job3 = await run(buildExtraWorkspace(), { rootIds: [XIDS.gamma], dryRun: false, teamspaces: [{ name: 'Unknown', kind: 'private', rootIds: [XIDS.gamma] }] });
  assert.equal(job3.status, 'done', job3.error);
  assert.ok(job3.report.counts.privateSkipped >= 1);
  assert.ok(job3.report.warningCounts.private_owner >= 1);
});

test('discovery from search keeps block-parented pages under their owner', async () => {
  const job = await run(buildExtraWorkspace(), { dryRun: true });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(job.report.summary.roots.map((r: any) => r.title).sort(), ['Alpha', 'Beta', 'Delta', 'Gamma']);
});

test('client: concurrent requests share the rate limit and back off together on 429', async () => {
  let inFlight = 0;
  let peak = 0;
  let limitedOnce = 0;
  const fetchImpl: any = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (limitedOnce < 2) {
      limitedOnce++;
      return { ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '0.05' : null) }, json: async () => ({}), text: async () => '' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '' };
  };
  const c = new NotionClient({ token: 'x', fetchImpl, minIntervalMs: 20, burst: 2 });
  const t0 = Date.now();
  const out = await mapLimit(Array.from({ length: 8 }, (_, i) => i), 4, () => c.request('GET', '/x'));
  const ms = Date.now() - t0;
  assert.equal(out.length, 8);
  assert.ok(out.every((r: any) => r.ok));
  assert.equal(c.rateLimited, 2);
  assert.equal(c.requests, 10);
  assert.ok(peak <= 4, 'never more than the worker limit in flight');
  assert.ok(ms >= 8 * 20 - 2 * 20 - 10, `token bucket paces requests (took ${ms}ms)`);
});

test('fallback default view is replaced once the real views can be read', async () => {
  const ws = buildWorkspace();
  const inner = fakeNotionFetch(ws, { rateLimitOnce: true });
  const res = (status: number, body: any) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const failingViews: any = async (url: string, init: any) =>
    new URL(url).searchParams.get('database_id') === IDS.db2 ? res(500, { object: 'error', code: 'internal_server_error', message: 'views unavailable' }) : inner(url, init);
  const go = async (fetchImpl: any) => {
    const { done } = await startNotionImport(admin, { token: 'secret_fake', targetTeamspaceId: tsId, peopleMode: 'text', force: true }, { fetchImpl, fileImporter: fakeFiles as any, minIntervalMs: 0 });
    await done;
  };
  // Simulate a first import of db2 whose views can't be read yet.
  const db2 = await atriumId(IDS.db2);
  assert.ok(db2);
  const vids = (await q<{ id: string }>(`select id from database_views where database_id = $1`, [db2])).map((r) => r.id);
  await q(`delete from import_mappings where source = 'notion-view' and atrium_id = any($1::uuid[])`, [vids]);
  await q(`delete from database_views where database_id = $1`, [db2]);
  await go(failingViews);
  const before = await q<{ name: string }>(`select name from database_views where database_id = $1 and block_id is null`, [db2]);
  assert.deepEqual(before.map((v) => v.name), ['Table'], 'fallback view while views are unreadable');
  await go(fakeNotionFetch(ws, { rateLimitOnce: true }));
  const after1 = await q<{ name: string }>(`select name from database_views where database_id = $1 and block_id is null order by position`, [db2]);
  assert.deepEqual(after1.map((v) => v.name), ['All'], 'fallback removed once the real views import');
});

test('sync: pulls edits, new pages and row changes; full check trashes deletions; restores', async () => {
  const ws = buildWorkspace();
  const base = await run(ws);
  assert.equal(base.status, 'done', base.error);
  const sync = async (since: Date | null) => {
    const { id, done } = await startNotionImport(
      admin,
      { token: 'secret_fake', targetTeamspaceId: tsId, peopleMode: 'guests' },
      { fetchImpl: fakeNotionFetch(ws), fileImporter: fakeFiles as any, minIntervalMs: 0 },
      { kind: 'sync', since },
    );
    await done;
    return one<any>('select * from import_jobs where id = $1', [id]);
  };
  const since = new Date('2025-12-31T00:00:00.000Z');
  const T2 = '2026-01-01T10:00:00.000Z';

  // Nothing changed: only the search listing is read, nothing is written.
  const idle = await sync(since);
  assert.equal(idle.status, 'done', idle.error);
  assert.equal(idle.kind, 'sync');
  assert.equal(idle.report.counts.pages.updated + idle.report.counts.pages.created + idle.report.counts.rows.updated, 0);
  assert.ok(idle.report.requests <= 6, `idle sync made ${idle.report.requests} requests`);

  // Edits in Notion: a renamed page, a new sub-page under Handbook, a changed row.
  const NEW = '11111111-0000-4000-8000-0000000000ff';
  (ws.pages as any)[IDS.sub] = { ...ws.pages[IDS.sub], last_edited_time: T2, properties: { title: { id: 'title', type: 'title', title: [rt('Sub page (renamed)')] } } };
  (ws.pages as any)[NEW] = { ...ws.pages[IDS.sub], id: NEW, created_time: T2, last_edited_time: T2, parent: { type: 'page_id', page_id: IDS.handbook }, properties: { title: { id: 'title', type: 'title', title: [rt('Added later')] } } };
  ws.children.set(NEW, [{ object: 'block', id: '55555555-0000-4000-8000-0000000000ff', type: 'paragraph', has_children: false, created_time: T2, last_edited_time: T2, paragraph: { rich_text: [rt('Fresh content')], color: 'default' } }]);
  (ws.pages as any)[IDS.r1] = { ...ws.pages[IDS.r1], last_edited_time: T2, properties: { ...ws.pages[IDS.r1].properties, Points: { id: 'pts', type: 'number', number: 8 } } };
  // Someone also edited the Atrium copy of Sub page: their version is kept in history before Notion's replaces it.
  const subId = (await atriumId(IDS.sub))!;
  await q(`update page_content set updated_at = now() + interval '1 hour' where page_id = $1`, [subId]);
  const versionsBefore = (await one<any>('select count(*)::int n from page_versions where page_id = $1', [subId])).n;
  const job = await sync(since);
  assert.equal(job.status, 'done', job.error);
  assert.equal((await one<any>('select count(*)::int n from page_versions where page_id = $1', [subId])).n, versionsBefore + 1, 'Atrium edit kept in history');
  const c = job.report.counts;
  assert.equal(c.pages.created, 1, JSON.stringify(c));
  assert.equal(c.pages.updated, 1, JSON.stringify(c));
  assert.equal(c.rows.updated, 1, JSON.stringify(c));
  const sub = (await atriumId(IDS.sub))!;
  assert.equal((await one<any>('select title from pages where id = $1', [sub])).title, 'Sub page (renamed)');
  const added = (await atriumId(NEW))!;
  const addedRow = await one<any>('select parent_id, teamspace_id from pages where id = $1', [added]);
  assert.equal(addedRow.parent_id, await atriumId(IDS.handbook), 'new page lands under its imported parent');
  assert.equal(addedRow.teamspace_id, tsId);
  assert.ok(JSON.stringify(await blocksOf(added)).includes('Fresh content'));
  const db1 = (await atriumId(IDS.db1))!;
  const schema = (await one<any>('select schema from databases where page_id = $1', [db1])).schema as any[];
  const pts = schema.find((p) => p.name === 'Points').id;
  assert.equal((await one<any>('select props from pages where id = $1', [await atriumId(IDS.r1)])).props[pts], 8);
  // Links in re-read pages still point at earlier imported pages (preloaded mappings).
  assert.ok(!job.report.warnings.some((w: any) => w.kind === 'link_unresolved'), JSON.stringify(job.report.warnings));

  // A row deleted in Notion: incremental syncs can't see it; the full check trashes the copy.
  (ws.pages as any)[IDS.r2] = { ...ws.pages[IDS.r2], in_trash: true };
  const r2 = (await atriumId(IDS.r2))!;
  await sync(since);
  assert.equal((await one<any>('select deleted_at from pages where id = $1', [r2])).deleted_at, null);
  const fullJob = await sync(null);
  assert.equal(fullJob.status, 'done', fullJob.error);
  assert.equal(fullJob.report.counts.removed, 1, JSON.stringify(fullJob.report.counts));
  assert.equal(fullJob.report.counts.pages.updated, 0, 'full check re-reads nothing unchanged');
  assert.ok((await one<any>('select deleted_at from pages where id = $1', [r2])).deleted_at, 'deleted row trashed');
  assert.ok(await one('select 1 from pages where id = $1 and deleted_at is null', [sub]), 'untouched pages stay');

  // Restored in Notion: the same copy comes back (no duplicate).
  (ws.pages as any)[IDS.r2] = { ...ws.pages[IDS.r2], in_trash: false, last_edited_time: '2026-01-02T10:00:00.000Z' };
  const back = await sync(since);
  assert.equal(back.status, 'done', back.error);
  assert.equal(back.report.counts.restored, 1);
  assert.equal(await atriumId(IDS.r2), r2);
  assert.equal((await one<any>('select deleted_at from pages where id = $1', [r2])).deleted_at, null);

  // A copy someone deleted in Atrium is not brought back by a Notion edit.
  await q('update pages set deleted_at = now() where id = $1', [added]);
  (ws.pages as any)[NEW] = { ...ws.pages[NEW], last_edited_time: '2026-01-03T10:00:00.000Z' };
  const kept = await sync(since);
  assert.equal(kept.report.counts.deletedInAtrium, 1);
  assert.equal(kept.report.counts.pages.created, 0, 'no duplicate of a page deleted in Atrium');
});

test('cancel stops a running import', async () => {
  const ws = buildWorkspace();
  const imp = new NotionImport({ token: 'x', targetTeamspaceId: tsId, peopleMode: 'text' }, admin, { fetchImpl: fakeNotionFetch(ws), fileImporter: fakeFiles as any, minIntervalMs: 0 });
  imp.cancel();
  await assert.rejects(imp.discover(), /cancelled/i);
});

after(async () => {
  if (tsId) {
    const ids = (await q<{ id: string }>(`select id from pages where teamspace_id = $1`, [tsId])).map((r) => r.id);
    await q(`delete from import_mappings where atrium_id = any($1::uuid[])`, [ids]);
    await q(`delete from import_mappings where source in ('notion-view','notion-thread','notion-comment','notion-file') and job_id in (select id from import_jobs where workspace_id = $1 and options->>'targetTeamspaceId' = $2)`, [admin.workspaceId, tsId]);
    await q(`delete from pages where teamspace_id = $1`, [tsId]);
    await q(`delete from teamspaces where id = $1`, [tsId]);
    const extraIds = (await q<{ id: string }>(`select id from pages where teamspace_id = any($1::uuid[])`, [extraTeamspaces])).map((r) => r.id);
    await q(`delete from import_mappings where atrium_id = any($1::uuid[])`, [[...extraIds, ...extraTeamspaces]]);
    await q(`delete from pages where teamspace_id = any($1::uuid[])`, [extraTeamspaces]);
    await q(`delete from teamspaces where id = any($1::uuid[])`, [extraTeamspaces]);
    const owned = (await q<{ id: string }>(`select id from pages where owner_id = any($1::uuid[]) and teamspace_id is null`, [createdUsers])).map((r) => r.id);
    await q(`delete from import_mappings where atrium_id = any($1::uuid[])`, [owned]);
    await q(`delete from pages where id = any($1::uuid[])`, [owned]);
    await q(`delete from workspace_members where user_id = any($1::uuid[])`, [createdUsers]);
    await q(`delete from import_mappings where source = 'notion' and kind = 'user' and atrium_id = any($1::uuid[])`, [createdUsers]);
    for (const u of createdUsers) await q(`delete from users where id = $1`, [u]);
    await q(`delete from import_jobs where options->>'targetTeamspaceId' = $1`, [tsId]);
  }
  await hocuspocus.closeConnections?.();
  await pool.end();
  // Background job timers / sockets must not keep the runner alive after the suite.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
