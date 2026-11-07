/**
 * A fake Notion API serving a SYNTHETIC workspace in the documented JSON shapes, for tests.
 * Exercises: every Atrium-supported block type, rich text annotations/colours/links/mentions,
 * inline + full-page databases with every property type, relations (two-way) and rollups,
 * status groups, views with filters/sorts/grouping, templates, comments, people, files,
 * pagination (small page size) and one 429 with Retry-After.
 */
import type { FetchLike } from './client.js';

const T0 = '2025-03-01T09:00:00.000Z';
const T1 = '2025-06-15T12:30:00.000Z';

export const IDS = {
  justin: '00000000-0000-4000-8000-0000000000a1',
  grace: '00000000-0000-4000-8000-0000000000a2',
  bot: '00000000-0000-4000-8000-0000000000a3',
  handbook: '11111111-0000-4000-8000-000000000001',
  sub: '11111111-0000-4000-8000-000000000002',
  db1: '22222222-0000-4000-8000-000000000001',
  ds1: '22222222-0000-4000-8000-0000000000d1',
  db2: '22222222-0000-4000-8000-000000000002',
  ds2: '22222222-0000-4000-8000-0000000000d2',
  r1: '33333333-0000-4000-8000-000000000001',
  r2: '33333333-0000-4000-8000-000000000002',
  r3: '33333333-0000-4000-8000-000000000003',
  tpl: '33333333-0000-4000-8000-0000000000f1',
  synced: '44444444-0000-4000-8000-000000000001',
  linked: '22222222-0000-4000-8000-0000000000e1',
};

const ann = (a: Partial<Record<'bold' | 'italic' | 'strikethrough' | 'underline' | 'code', boolean>> & { color?: string } = {}) => ({
  bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default', ...a,
});
export const rt = (content: string, a: Parameters<typeof ann>[0] = {}, link?: string) => ({
  type: 'text', text: { content, link: link ? { url: link } : null }, annotations: ann(a), plain_text: content, href: link ?? null,
});
const mention = (mention: any, plain: string) => ({ type: 'mention', mention, annotations: ann(), plain_text: plain, href: null });
const user = (id: string) => ({ object: 'user', id });

let bid = 0;
const blockId = () => `55555555-0000-4000-8000-${String(++bid).padStart(12, '0')}`;

export function buildWorkspace() {
  bid = 0;
  const children = new Map<string, any[]>();
  const blk = (type: string, data: any, kids?: any[], id = blockId()) => {
    if (kids) children.set(id, kids);
    return { object: 'block', id, type, has_children: !!kids?.length, created_time: T0, last_edited_time: T0, [type]: data };
  };
  const para = (...r: any[]) => blk('paragraph', { rich_text: r, color: 'default' });

  const syncedOriginal = blk('synced_block', { synced_from: null }, [para(rt('Shared policy text'))], IDS.synced);
  const handbookBlocks = [
    blk('heading_1', { rich_text: [rt('Overview')], is_toggleable: true, color: 'default' }, [para(rt('Hidden in a toggle heading'))]),
    para(
      rt('Bold', { bold: true }), rt(' and '), rt('red', { color: 'red' }), rt(' and '), rt('highlight', { color: 'yellow_background' }), rt(' '),
      rt('see sub page', {}, `https://www.notion.so/Sub-${IDS.sub.replace(/-/g, '')}`), rt(' '),
      mention({ type: 'user', user: { object: 'user', id: IDS.justin, name: 'Justin' } }, '@Justin'), rt(' '),
      mention({ type: 'page', page: { id: IDS.sub } }, 'Sub page'), rt(' '),
      mention({ type: 'date', date: { start: '2025-07-01', end: null } }, '2025-07-01'), rt(' '),
      { type: 'equation', equation: { expression: 'E=mc^2' }, annotations: ann(), plain_text: 'E=mc^2' },
    ),
    blk('callout', { rich_text: [rt('Launch checklist')], icon: { type: 'emoji', emoji: '🚀' }, color: 'blue_background' }, [blk('bulleted_list_item', { rich_text: [rt('inside callout')], color: 'default' })]),
    blk('to_do', { rich_text: [rt('Done item')], checked: true, color: 'default' }),
    blk('numbered_list_item', { rich_text: [rt('First')], color: 'default' }),
    blk('toggle', { rich_text: [rt('A toggle')], color: 'default' }, [para(rt('toggle body'))]),
    blk('quote', { rich_text: [rt('Quoted')], color: 'default' }),
    blk('divider', {}),
    blk('code', { rich_text: [rt('print("hi")')], language: 'python', caption: [] }),
    blk('equation', { expression: '\\int_0^1 x\\,dx' }),
    blk('table', { table_width: 2, has_column_header: true, has_row_header: false }, [
      blk('table_row', { cells: [[rt('Col A')], [rt('Col B')]] }),
      blk('table_row', { cells: [[rt('1')], [rt('2', { bold: true })]] }),
    ]),
    blk('image', { type: 'file', file: { url: 'https://prod-files.fake-notion.test/ws/abc/diagram.png?X-Amz-Signature=1', expiry_time: T1 }, caption: [rt('A diagram')] }),
    blk('image', { type: 'external', external: { url: 'https://images.example.com/photo.jpg' }, caption: [] }),
    blk('bookmark', { url: 'https://example.com/article', caption: [] }),
    blk('embed', { url: 'https://www.youtube.com/watch?v=abc' }),
    blk('link_preview', { url: 'https://github.com/org/repo/pull/1' }),
    blk('column_list', {}, [
      blk('column', { width_ratio: 0.5 }, [para(rt('Left column'))]),
      blk('column', { width_ratio: 0.5 }, [para(rt('Right column'))]),
    ]),
    syncedOriginal,
    blk('table_of_contents', { color: 'default' }),
    blk('breadcrumb', {}),
    blk('ai_block', {}),
    blk('child_page', { title: 'Sub page' }, [], IDS.sub),
    blk('child_database', { title: 'Tasks' }, [], IDS.db1),
  ];
  children.set(IDS.handbook, handbookBlocks);
  children.set(IDS.sub, [
    blk('synced_block', { synced_from: { type: 'block_id', block_id: IDS.synced } }, [para(rt('Shared policy text'))]),
    blk('link_to_page', { type: 'page_id', page_id: IDS.handbook }),
    para(rt('Version one')),
    blk('child_database', { title: 'Estimates (linked)' }, [], IDS.linked),
  ]);
  children.set(IDS.r1, [para(rt('Row body for task one'))]);
  children.set(IDS.r2, []);
  children.set(IDS.r3, []);
  children.set(IDS.tpl, [blk('to_do', { rich_text: [rt('Template step')], checked: false, color: 'default' })]);

  const titleProp = (s: string) => ({ title: { id: 'title', type: 'title', title: [rt(s)] } });
  const page = (id: string, parent: any, props: any, extra: any = {}) => ({
    object: 'page', id, created_time: T0, last_edited_time: T1, created_by: user(IDS.justin), last_edited_by: user(IDS.grace),
    cover: null, icon: null, parent, archived: false, in_trash: false, properties: props, url: `https://www.notion.so/${id.replace(/-/g, '')}`, ...extra,
  });

  const pages: Record<string, any> = {
    [IDS.handbook]: page(IDS.handbook, { type: 'workspace', workspace: true }, titleProp('Handbook'), {
      icon: { type: 'emoji', emoji: '📘' },
      cover: { type: 'external', external: { url: 'https://images.example.com/cover.jpg' } },
    }),
    [IDS.sub]: page(IDS.sub, { type: 'page_id', page_id: IDS.handbook }, titleProp('Sub page')),
  };

  const statusOpts = [
    { id: 'st1', name: 'Backlog', color: 'gray' },
    { id: 'st2', name: 'Doing', color: 'blue' },
    { id: 'st3', name: 'Fixed', color: 'green' },
  ];
  const ds1Props: Record<string, any> = {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    Status: { id: 'stat', name: 'Status', type: 'status', status: { options: statusOpts, groups: [
      { id: 'g1', name: 'To-do', color: 'gray', option_ids: ['st1'] },
      { id: 'g2', name: 'In progress', color: 'blue', option_ids: ['st2'] },
      { id: 'g3', name: 'Complete', color: 'green', option_ids: ['st3'] },
    ] } },
    Tags: { id: 'tags', name: 'Tags', type: 'multi_select', multi_select: { options: [{ id: 't1', name: 'Ops', color: 'red' }, { id: 't2', name: 'Docs', color: 'purple' }] } },
    Owner: { id: 'ownr', name: 'Owner', type: 'people', people: {}, description: 'Who is responsible' },
    Due: { id: 'due', name: 'Due', type: 'date', date: {} },
    Points: { id: 'pts', name: 'Points', type: 'number', number: { format: 'number' } },
    Done: { id: 'done', name: 'Done', type: 'checkbox', checkbox: {} },
    Link: { id: 'link', name: 'Link', type: 'url', url: {} },
    Ref: { id: 'ref', name: 'Ref', type: 'unique_id', unique_id: { prefix: 'T' } },
    Double: { id: 'dbl', name: 'Double', type: 'formula', formula: { expression: `{{notion:block_property:pts:${IDS.ds1}:00000000}} * 2` } },
    Rel: { id: 'rel', name: 'Rel', type: 'relation', relation: { data_source_id: IDS.ds2, type: 'dual_property', dual_property: { synced_property_id: 'back', synced_property_name: 'Back' } } },
    Total: { id: 'tot', name: 'Total', type: 'rollup', rollup: { relation_property_id: 'rel', relation_property_name: 'Rel', rollup_property_id: 'est', rollup_property_name: 'Estimate', function: 'sum' } },
    Attach: { id: 'att', name: 'Attach', type: 'files', files: {} },
    Created: { id: 'crt', name: 'Created', type: 'created_time', created_time: {} },
  };
  const ds2Props: Record<string, any> = {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    Estimate: { id: 'est', name: 'Estimate', type: 'number', number: { format: 'number' } },
    Back: { id: 'back', name: 'Back', type: 'relation', relation: { data_source_id: IDS.ds1, type: 'dual_property', dual_property: { synced_property_id: 'rel', synced_property_name: 'Rel' } } },
  };
  const rowParent = (ds: string, db: string) => ({ type: 'data_source_id', data_source_id: ds, database_id: db });
  const rows: Record<string, any> = {
    [IDS.r1]: page(IDS.r1, rowParent(IDS.ds1, IDS.db1), {
      Name: { id: 'title', type: 'title', title: [rt('Task one')] },
      Status: { id: 'stat', type: 'status', status: statusOpts[2] },
      Tags: { id: 'tags', type: 'multi_select', multi_select: [{ id: 't1', name: 'Ops', color: 'red' }] },
      Owner: { id: 'ownr', type: 'people', people: [{ object: 'user', id: IDS.justin, name: 'Justin' }] },
      Due: { id: 'due', type: 'date', date: { start: '2025-07-01', end: '2025-07-03', time_zone: null } },
      Points: { id: 'pts', type: 'number', number: 5 },
      Done: { id: 'done', type: 'checkbox', checkbox: false },
      Link: { id: 'link', type: 'url', url: 'https://example.com' },
      Ref: { id: 'ref', type: 'unique_id', unique_id: { prefix: 'T', number: 1 } },
      Double: { id: 'dbl', type: 'formula', formula: { type: 'number', number: 10 } },
      Rel: { id: 'rel', type: 'relation', relation: [{ id: IDS.r3 }], has_more: false },
      Total: { id: 'tot', type: 'rollup', rollup: { type: 'number', number: 3 } },
      Attach: { id: 'att', type: 'files', files: [{ name: 'spec.pdf', type: 'file', file: { url: 'https://prod-files.fake-notion.test/ws/abc/spec.pdf?X-Amz-Signature=2', expiry_time: T1 } }] },
      Created: { id: 'crt', type: 'created_time', created_time: T0 },
    }),
    [IDS.r2]: page(IDS.r2, rowParent(IDS.ds1, IDS.db1), {
      Name: { id: 'title', type: 'title', title: [rt('Task two')] },
      Status: { id: 'stat', type: 'status', status: statusOpts[0] },
      Tags: { id: 'tags', type: 'multi_select', multi_select: [] },
      Owner: { id: 'ownr', type: 'people', people: [{ object: 'user', id: IDS.grace, name: 'Grace' }] },
      Due: { id: 'due', type: 'date', date: null },
      Points: { id: 'pts', type: 'number', number: 2 },
      Done: { id: 'done', type: 'checkbox', checkbox: true },
      Link: { id: 'link', type: 'url', url: null },
      Ref: { id: 'ref', type: 'unique_id', unique_id: { prefix: 'T', number: 2 } },
      Double: { id: 'dbl', type: 'formula', formula: { type: 'number', number: 4 } },
      Rel: { id: 'rel', type: 'relation', relation: [], has_more: false },
      Total: { id: 'tot', type: 'rollup', rollup: { type: 'number', number: 0 } },
      Attach: { id: 'att', type: 'files', files: [] },
      Created: { id: 'crt', type: 'created_time', created_time: T0 },
    }),
    [IDS.r3]: page(IDS.r3, rowParent(IDS.ds2, IDS.db2), {
      Name: { id: 'title', type: 'title', title: [rt('Estimate A')] },
      Estimate: { id: 'est', type: 'number', number: 3 },
      Back: { id: 'back', type: 'relation', relation: [{ id: IDS.r1 }], has_more: false },
    }),
  };
  const template = page(IDS.tpl, { type: 'data_source_id', data_source_id: IDS.ds1, database_id: IDS.db1 }, {
    Name: { id: 'title', type: 'title', title: [rt('Bug report')] },
  });

  const databases: Record<string, any> = {
    [IDS.db1]: { object: 'database', id: IDS.db1, title: [rt('Tasks')], description: [], icon: { type: 'emoji', emoji: '✅' }, cover: null, is_inline: true,
      parent: { type: 'page_id', page_id: IDS.handbook }, data_sources: [{ id: IDS.ds1, name: 'Tasks' }], created_time: T0, last_edited_time: T1, created_by: user(IDS.justin), last_edited_by: user(IDS.justin), archived: false, in_trash: false },
    [IDS.linked]: { object: 'database', id: IDS.linked, title: [rt('Estimates (linked)')], description: [], icon: null, cover: null, is_inline: true,
      parent: { type: 'block_id', block_id: IDS.sub }, data_sources: [], created_time: T0, last_edited_time: T1, archived: false, in_trash: false },
    [IDS.db2]: { object: 'database', id: IDS.db2, title: [rt('Estimates')], description: [rt('Sizing data')], icon: null, cover: null, is_inline: false,
      parent: { type: 'workspace', workspace: true }, data_sources: [{ id: IDS.ds2, name: 'Estimates' }], created_time: T0, last_edited_time: T1, created_by: user(IDS.justin), last_edited_by: user(IDS.justin), archived: false, in_trash: false },
  };
  const dataSources: Record<string, any> = {
    [IDS.ds1]: { object: 'data_source', id: IDS.ds1, title: [rt('Tasks')], properties: ds1Props, parent: { type: 'database_id', database_id: IDS.db1 }, database_parent: { type: 'page_id', page_id: IDS.handbook } },
    [IDS.ds2]: { object: 'data_source', id: IDS.ds2, title: [rt('Estimates')], properties: ds2Props, parent: { type: 'database_id', database_id: IDS.db2 }, database_parent: { type: 'workspace', workspace: true } },
  };
  const views: Record<string, any[]> = {
    [IDS.db1]: [
      { object: 'view', id: 'v-board', name: 'By status', type: 'board', data_source_id: IDS.ds1, filter: { property: 'done', checkbox: { equals: false } }, sorts: [{ property: 'pts', direction: 'descending' }], configuration: { group_by: { property_id: 'stat' } } },
      { object: 'view', id: 'v-cal', name: 'Calendar', type: 'calendar', data_source_id: IDS.ds1, filter: null, sorts: [], configuration: { date_property_id: 'due' } },
      { object: 'view', id: 'v-recent', name: 'Recent', type: 'table', data_source_id: IDS.ds1, filter: { and: [{ timestamp: 'created_time', created_time: { past_week: {} } }, { property: 'Status', status: { equals: 'Fixed' } }, { property: 'Due', date: { this_week: {} } }] }, sorts: [], configuration: { properties: [{ property_id: 'title', visible: true }, { property_id: 'pts', visible: false }] } },
      { object: 'view', id: 'v-chart', name: 'Chart', type: 'chart', data_source_id: IDS.ds1, filter: null, sorts: [] },
    ],
    [IDS.db2]: [{ object: 'view', id: 'v-est', name: 'All', type: 'table', data_source_id: IDS.ds2, filter: null, sorts: [] }],
    [IDS.linked]: [{ object: 'view', id: 'v-linked', name: 'Big estimates', type: 'table', data_source_id: IDS.ds2, filter: { property: 'est', number: { greater_than: 1 } }, sorts: [] }],
  };
  const comments: Record<string, any[]> = {
    [IDS.handbook]: [
      { object: 'comment', id: 'c1', discussion_id: 'd1', parent: { type: 'page_id', page_id: IDS.handbook }, created_time: '2025-05-01T10:00:00.000Z', created_by: user(IDS.justin), rich_text: [rt('Looks good '), mention({ type: 'user', user: { object: 'user', id: IDS.grace } }, '@Grace')] },
      { object: 'comment', id: 'c2', discussion_id: 'd1', parent: { type: 'page_id', page_id: IDS.handbook }, created_time: '2025-05-02T10:00:00.000Z', created_by: user(IDS.grace), rich_text: [rt('Thanks!')] },
    ],
  };
  const users = [
    { object: 'user', id: IDS.justin, type: 'person', name: 'Justin', person: { email: 'justin@example.com' } },
    { object: 'user', id: IDS.grace, type: 'person', name: 'Grace Hopper', person: { email: 'grace.import-test@synthetic.test' } },
    { object: 'user', id: IDS.bot, type: 'bot', name: 'Integration', bot: {} },
  ];
  return { children, pages: { ...pages, ...rows, [IDS.tpl]: template }, databases, dataSources, views, comments, users, templates: { [IDS.ds1]: [{ id: IDS.tpl, name: 'Bug report', is_default: true }] } };
}

export type FakeWorkspace = ReturnType<typeof buildWorkspace>;

/** A fetch implementation answering like api.notion.com for the given workspace. */
export function fakeNotionFetch(ws: FakeWorkspace | ReturnType<typeof buildExtraWorkspace>, opts: { pageSize?: number; rateLimitOnce?: boolean } = {}): FetchLike & { calls: string[] } {
  const pageSize = opts.pageSize ?? 4;
  let limited = !opts.rateLimitOnce;
  const calls: string[] = [];
  const res = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const paged = (all: any[], cursor: string | null) => {
    const start = cursor ? Number(cursor) : 0;
    const results = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : null;
    return { object: 'list', results, has_more: !!next, next_cursor: next };
  };
  const fn: any = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, '');
    calls.push(`${init.method} ${path}`);
    if (!init.headers.Authorization?.startsWith('Bearer ')) return res(401, { code: 'unauthorized', message: 'API token is invalid.' });
    if (!init.headers['Notion-Version']) return res(400, { code: 'missing_version', message: 'Notion-Version header missing' });
    const body = init.body ? JSON.parse(init.body) : {};
    const cursor = u.searchParams.get('start_cursor') ?? body.start_cursor ?? null;
    let m: RegExpMatchArray | null;
    if (path === '/users') {
      if (!limited) { limited = true; return res(429, { code: 'rate_limited', message: 'slow down' }, { 'retry-after': '0' }); }
      return res(200, paged(ws.users, cursor));
    }
    if (path === '/users/me') return res(200, ws.users.find((x: any) => x.type === 'bot'));
    if (path === '/search') {
      const want = body.filter?.value;
      const all = want === 'page' ? Object.values(ws.pages) : want === 'data_source' ? Object.values(ws.dataSources) : [];
      return res(200, paged(all, cursor));
    }
    if ((m = path.match(/^\/pages\/([^/]+)\/properties\/([^/]+)$/))) {
      const p = ws.pages[m[1]];
      const prop = Object.values(p?.properties ?? {}).find((x: any) => x.id === decodeURIComponent(m![2])) as any;
      return res(200, paged((prop?.relation ?? []).map((r: any) => ({ object: 'property_item', type: 'relation', relation: r })), cursor));
    }
    if ((m = path.match(/^\/pages\/([^/]+)$/))) return ws.pages[m[1]] ? res(200, ws.pages[m[1]]) : res(404, { code: 'object_not_found', message: 'not found' });
    if ((m = path.match(/^\/pages\/([^/]+)\/markdown$/))) {
      const md = (ws as any).markdown?.[m[1]];
      return md !== undefined ? res(200, { object: 'page_markdown', markdown: md, truncated: false, unknown_block_ids: [] }) : res(404, { code: 'object_not_found', message: 'not found' });
    }
    if ((m = path.match(/^\/blocks\/([^/]+)\/children$/))) return res(200, paged(ws.children.get(m[1]) ?? [], cursor));
    if ((m = path.match(/^\/blocks\/([^/]+)$/))) {
      for (const [owner, list] of ws.children) {
        const b = list.find((x: any) => x.id === m![1]);
        if (b) return res(200, { ...b, parent: ws.pages[owner] ? { type: 'page_id', page_id: owner } : { type: 'block_id', block_id: owner } });
      }
      return res(404, { code: 'object_not_found', message: 'not found' });
    }
    if ((m = path.match(/^\/databases\/([^/]+)$/))) return ws.databases[m[1]] ? res(200, ws.databases[m[1]]) : res(404, { code: 'object_not_found', message: 'not found' });
    if ((m = path.match(/^\/data_sources\/([^/]+)\/query$/))) {
      const rows = Object.values(ws.pages).filter((p: any) => p.parent?.data_source_id === m![1] && !Object.values(ws.templates).flat().some((t: any) => t.id === p.id));
      return res(200, paged(rows, cursor));
    }
    if ((m = path.match(/^\/data_sources\/([^/]+)\/templates$/))) return res(200, { templates: (ws.templates as any)[m[1]] ?? [], has_more: false, next_cursor: null });
    if ((m = path.match(/^\/data_sources\/([^/]+)$/))) return ws.dataSources[m[1]] ? res(200, ws.dataSources[m[1]]) : res(404, { code: 'object_not_found', message: 'not found' });
    if (path === '/views') return res(200, paged(ws.views[u.searchParams.get('database_id') ?? ''] ?? [], cursor));
    if ((m = path.match(/^\/views\/([^/]+)$/))) {
      const v = Object.values(ws.views).flat().find((x: any) => x.id === m![1]);
      return v ? res(200, v) : res(404, { code: 'object_not_found', message: 'not found' });
    }
    if (path === '/comments') return res(200, paged(ws.comments[u.searchParams.get('block_id') ?? ''] ?? [], cursor));
    return res(404, { code: 'invalid_request_url', message: `No route ${init.method} ${path}` });
  };
  fn.calls = calls;
  return fn;
}

export const XIDS = {
  alpha: '66666666-0000-4000-8000-000000000001',
  beta: '66666666-0000-4000-8000-000000000002',
  gamma: '66666666-0000-4000-8000-000000000003',
  gammaChild: '66666666-0000-4000-8000-000000000004',
  delta: '66666666-0000-4000-8000-000000000005',
  nested: '66666666-0000-4000-8000-000000000006',
  db: '77777777-0000-4000-8000-000000000001',
  ds: '77777777-0000-4000-8000-0000000000d1',
  row: '77777777-0000-4000-8000-000000000011',
  commented: '88888888-0000-4000-8000-000000000001',
  column: '88888888-0000-4000-8000-000000000002',
};
const hex = (id: string) => id.replace(/-/g, '');

/**
 * A second synthetic workspace for teamspace mapping, Markdown fetching, follow-links/relink, inline comments,
 * block-parented pages and the newer property/view types.
 *   Alpha (blocks)  → links to Gamma (not a root: unresolved until Gamma is imported)
 *   Beta (blocks)   → inline comment on a paragraph, page verification, a column holding "Nested", an inline database
 *   Gamma (Markdown)→ child page tag + link to Delta (reached only by follow-links)
 */
export function buildExtraWorkspace() {
  const T = '2025-04-01T08:00:00.000Z';
  const children = new Map<string, any[]>();
  const blk = (type: string, data: any, id: string, kids?: any[]) => {
    if (kids) children.set(id, kids);
    return { object: 'block', id, type, has_children: !!kids?.length, created_time: T, last_edited_time: T, [type]: data };
  };
  let n = 0;
  const bid = () => `99999999-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const para = (...r: any[]) => blk('paragraph', { rich_text: r, color: 'default' }, bid());
  children.set(XIDS.alpha, [para(rt('Alpha intro '), rt('see Gamma', {}, `https://www.notion.so/Gamma-${hex(XIDS.gamma)}`))]);
  children.set(XIDS.beta, [
    blk('paragraph', { rich_text: [rt('Commented sentence')], color: 'default' }, XIDS.commented),
    blk('column_list', {}, bid(), [
      blk('column', { width_ratio: 0.5 }, XIDS.column, [blk('child_page', { title: 'Nested' }, XIDS.nested)]),
      blk('column', { width_ratio: 0.5 }, bid(), [para(rt('Right'))]),
    ]),
    blk('child_database', { title: 'Places' }, XIDS.db),
  ]);
  children.set(XIDS.nested, [para(rt('Nested body'))]);
  children.set(XIDS.row, []);
  const markdown: Record<string, string> = {
    [XIDS.gamma]: `Gamma body links to [Delta](https://www.notion.so/Delta-${hex(XIDS.delta)}).\n\n<page url="https://www.notion.so/${hex(XIDS.gammaChild)}">Gamma child</page>\n`,
    [XIDS.gammaChild]: 'Gamma child body\n',
    [XIDS.delta]: 'Delta body\n',
  };
  const title = (s: string) => ({ title: { id: 'title', type: 'title', title: [rt(s)] } });
  const page = (id: string, parent: any, props: any, extra: any = {}) => ({
    object: 'page', id, created_time: T, last_edited_time: T, created_by: user(IDS.justin), last_edited_by: user(IDS.justin),
    cover: null, icon: null, parent, archived: false, in_trash: false, properties: props, url: `https://www.notion.so/${hex(id)}`, ...extra,
  });
  const ws = { type: 'workspace', workspace: true };
  const props: Record<string, any> = {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    Kind: { id: 'kind', name: 'Kind', type: 'select', select: { options: [{ id: 'k1', name: 'Office', color: 'blue' }] } },
    Where: { id: 'whr', name: 'Where', type: 'place', place: {} },
    Checked: { id: 'ver', name: 'Checked', type: 'verification', verification: {} },
    Go: { id: 'btn', name: 'Go', type: 'button', button: {} },
  };
  const pages: Record<string, any> = {
    [XIDS.alpha]: page(XIDS.alpha, ws, title('Alpha')),
    [XIDS.beta]: page(XIDS.beta, ws, title('Beta'), { verification: { state: 'verified', verified_by: user(IDS.justin), date: { start: '2025-04-02', end: '2025-10-02' } } }),
    [XIDS.gamma]: page(XIDS.gamma, ws, title('Gamma')),
    [XIDS.gammaChild]: page(XIDS.gammaChild, { type: 'page_id', page_id: XIDS.gamma }, title('Gamma child')),
    [XIDS.delta]: page(XIDS.delta, ws, title('Delta')),
    [XIDS.nested]: page(XIDS.nested, { type: 'block_id', block_id: XIDS.column }, title('Nested')),
    [XIDS.row]: page(XIDS.row, { type: 'data_source_id', data_source_id: XIDS.ds, database_id: XIDS.db }, {
      Name: { id: 'title', type: 'title', title: [rt('HQ')] },
      Kind: { id: 'kind', type: 'select', select: { id: 'k1', name: 'Office', color: 'blue' } },
      Where: { id: 'whr', type: 'place', place: { lat: -33.92, lon: 18.42, name: 'Office', address: '1 Main Rd' } },
      Checked: { id: 'ver', type: 'verification', verification: { state: 'verified', verified_by: user(IDS.justin), date: { start: '2025-04-03', end: null } } },
      Go: { id: 'btn', type: 'button', button: {} },
    }),
  };
  const databases: Record<string, any> = {
    [XIDS.db]: { object: 'database', id: XIDS.db, title: [rt('Places')], description: [], icon: null, cover: null, is_inline: true,
      parent: { type: 'page_id', page_id: XIDS.beta }, data_sources: [{ id: XIDS.ds, name: 'Places' }], created_time: T, last_edited_time: T, archived: false, in_trash: false },
  };
  const dataSources: Record<string, any> = {
    [XIDS.ds]: { object: 'data_source', id: XIDS.ds, title: [rt('Places')], properties: props, parent: { type: 'database_id', database_id: XIDS.db }, database_parent: { type: 'page_id', page_id: XIDS.beta } },
  };
  const views: Record<string, any[]> = {
    [XIDS.db]: [
      { object: 'view', id: 'xv-table', name: 'All', type: 'table', data_source_id: XIDS.ds, filter: null, sorts: [], quick_filters: { kind: { select: { equals: 'Office' } }, ver: {} }, configuration: { frozen_column_index: 0 } },
      { object: 'view', id: 'xv-chart', name: 'By kind', type: 'chart', data_source_id: XIDS.ds, filter: null, sorts: [], configuration: { chart_type: 'donut', x_axis: { property_id: 'kind' } } },
      { object: 'view', id: 'xv-form', name: 'Suggest', type: 'form', data_source_id: XIDS.ds, filter: null, sorts: [], configuration: { questions: [{ property_id: 'title', required: true }, { property_id: 'whr' }] } },
      { object: 'view', id: 'xv-map', name: 'Map', type: 'map', data_source_id: XIDS.ds, filter: null, sorts: [], configuration: {} },
    ],
  };
  const comments: Record<string, any[]> = {
    [XIDS.commented]: [
      { object: 'comment', id: 'xc1', discussion_id: 'xd1', parent: { type: 'block_id', block_id: XIDS.commented }, created_time: '2025-04-05T10:00:00.000Z', created_by: user(IDS.justin), rich_text: [rt('Inline note')] },
    ],
  };
  const users = [{ object: 'user', id: IDS.justin, type: 'person', name: 'Justin', person: { email: 'justin@example.com' } }, { object: 'user', id: IDS.bot, type: 'bot', name: 'Integration', bot: {} }];
  return { children, pages, databases, dataSources, views, comments, users, templates: {}, markdown };
}
