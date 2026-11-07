import { z } from 'zod';
import { call, pageUrl, parseId, ToolError, type ToolCtx } from './context.js';
import { filterValue, findProp, fromInternal, getDb, toInternalProps, userNameMap, type DbMeta } from './props.js';
import { rehostMarkdown, rehostUrl } from './rehost.js';

/**
 * The Atrium workspace tool layer. Shared by the MCP server (and later in-app AI agents).
 * Names and shapes follow Notion's hosted MCP where it makes sense so prompts carry over.
 * Every tool runs as ctx.user through the normal REST routes and their permission checks.
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  run: (ctx: ToolCtx, args: any) => Promise<unknown>;
}

const PROP_TYPES = [
  'title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'person', 'checkbox', 'url', 'email', 'phone',
  'files', 'relation', 'rollup', 'formula', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id',
  'place', 'verification', 'button',
] as const;
const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'form', 'dashboard', 'map'] as const;

const propertiesArg = z
  .record(z.string(), z.any())
  .describe(
    'Property values keyed by property NAME. Friendly values: select/status by option name (new select options are created), ' +
      'multi_select as an array or comma-separated names, person as emails/names/"me", date as "2026-11-08" or "2026-11-08 → 2026-11-15" ' +
      '(or Notion-style "date:Due:start"/"date:Due:end" keys), checkbox true/false, relation as page ids/URLs or exact titles. ' +
      'Use the title property name (e.g. "Name") for the row title.',
  );

const propertySpec = z.object({
  name: z.string(),
  type: z.enum(PROP_TYPES),
  options: z
    .array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional(), group: z.string().optional().describe("status only: 'todo' | 'in_progress' | 'complete'") })]))
    .optional()
    .describe('select/multi_select/status options. For status, give each option a group, or use `groups`; options without one default by position (first → todo, last → complete, others → in_progress).'),
  groups: z
    .array(z.object({ name: z.string().describe("'To-do' | 'In progress' | 'Complete' (or todo/in_progress/complete)"), options: z.array(z.string()).describe('Option names in this group') }))
    .optional()
    .describe("status only: Notion's status groups, e.g. [{name:'To-do',options:['Not started']},{name:'In progress',options:['Doing']},{name:'Complete',options:['Done','Fixed']}]"),
  description: z.string().optional().describe('Property description (shown as a tooltip on the column header)'),
  limit: z.enum(['one', 'many']).optional().describe("person only: 'one' limits the property to a single person"),
  number_format: z.string().optional().describe('number, number_with_commas, percent, dollar, euro, pound, rand, ...'),
  formula: z.string().optional().describe('Formula expression (Notion Formula 2.0 syntax)'),
  relation_database_id: z.string().optional().describe('Target database id/URL for relation properties'),
  two_way: z.boolean().optional().describe('Relation: also add a property on the target database (default true)'),
  rollup: z.object({ relation: z.string(), property: z.string(), function: z.string() }).optional().describe('Rollup: relation property name, target property name, function (count, sum, average, min, max, show_original, percent_checked, ...)'),
  button: z
    .object({
      label: z.string(),
      actions: z.array(z.record(z.string(), z.any())).describe(
        'Actions run per row when clicked: {type:"setProps", props:{<propId>: value}} (values may be "@me", "@today", "@now"), ' +
          '{type:"addRow", databaseId, title, props}, {type:"insert", blocks:[BlockNote blocks]}, {type:"open", target:"<url or /p/<id>>"}',
      ),
    })
    .optional()
    .describe('button properties only'),
});

const filterSpec = z.object({
  property: z.string(),
  op: z
    .string()
    .describe(
      'is, is_not, contains, does_not_contain, starts_with, ends_with, is_empty, is_not_empty, =, !=, >, <, >=, <=, ' +
        'dates: before, after, on_or_before, on_or_after, within (relative range — see value), past_week, past_month, past_year, next_week, next_month, next_year, this_week, this_month, this_year; ' +
        'status: group (value = todo | in_progress | complete)',
    ),
  value: z
    .any()
    .optional()
    .describe(
      'Friendly value: option names, emails/"me", numbers, true/false; dates "2026-11-08", "today"/"yesterday"/"tomorrow", ' +
        'or a relative range for op "within": "past 30 days", "next 2 weeks", "this month" or {direction:"past"|"next"|"this", count:30, unit:"day"|"week"|"month"|"year"}',
    ),
});
const sortSpec = z.object({ property: z.string(), direction: z.enum(['ascending', 'descending']).default('ascending') });

const chartSpec = z
  .object({
    kind: z.enum(['bar', 'column', 'line', 'area', 'donut', 'number']),
    x_property: z.string().optional().describe('Category axis (select/status/multi-select/person/date/checkbox/text)'),
    group_property: z.string().optional().describe('Series / stack by a second property (not for donut/number)'),
    aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max', 'median']).default('count'),
    aggregate_property: z.string().optional().describe('Number/formula/rollup property for sum/avg/min/max/median'),
    sort: z.enum(['x-asc', 'x-desc', 'value-asc', 'value-desc']).optional(),
    date_bucket: z.enum(['day', 'week', 'month', 'year']).optional(),
    cumulative: z.boolean().optional(),
    hide_empty: z.boolean().optional(),
    show_legend: z.boolean().optional(),
  })
  .describe('chart views / dashboard chart widgets');
const formSpec = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    questions: z.array(z.object({ property: z.string(), label: z.string().optional(), description: z.string().optional(), required: z.boolean().optional() })),
    access: z.enum(['members', 'link']).optional().describe('members = signed-in workspace members; link = public form URL (/f/<slug>)'),
    submit_label: z.string().optional(),
    thank_you: z.string().optional(),
  })
  .describe('form views: each submission creates a row');
const viewExtras = {
  chart: chartSpec.optional(),
  form: formSpec.optional(),
  dashboard: z
    .object({
      widgets: z.array(
        z.object({
          title: z.string().optional(),
          kind: z.enum(['chart', 'number', 'table', 'list', 'board']),
          chart: chartSpec.optional(),
          filters: z.array(z.lazy(() => filterSpec)).optional(),
          group_by: z.string().optional(),
          x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(),
        }),
      ),
    })
    .optional()
    .describe('dashboard views: a 12-column grid of widgets'),
  map_place_property: z.string().optional().describe('map views: the place property to plot'),
  quick_filters: z.array(z.lazy(() => filterSpec)).optional().describe('Pinned quick filters shown above the view (any view type)'),
};

function toOptions(list?: (string | { name: string; color?: string })[]) {
  return (list ?? []).map((o, i) => {
    const name = typeof o === 'string' ? o : o.name;
    const color = typeof o === 'string' ? undefined : o.color;
    return { id: Math.random().toString(36).slice(2, 10), name, color: color ?? ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'][i % 9] };
  });
}

async function propBody(ctx: ToolCtx, db: DbMeta, spec: z.infer<typeof propertySpec>) {
  const body: any = { name: spec.name, type: spec.type };
  if (spec.options) body.options = toOptions(spec.options);
  if (spec.type === 'status') {
    // Explicit groups win: per-option `group`, or Notion's `groups` lists. The server fills any gaps by position.
    const fromGroups = new Map<string, string>();
    for (const g of spec.groups ?? []) for (const n of g.options) fromGroups.set(n.toLowerCase(), g.name);
    const opts = spec.options ?? (spec.groups ?? []).flatMap((g) => g.options);
    if (opts.length) {
      body.options = toOptions(opts).map((o, i) => {
        const src = opts[i];
        const group = (typeof src === 'object' && src.group) || fromGroups.get(o.name.toLowerCase());
        return group ? { ...o, group } : o;
      });
    }
  }
  if (spec.description) body.description = spec.description;
  if (spec.type === 'button') body.button = spec.button ?? { label: spec.name, actions: [] };
  if (spec.type === 'person' && spec.limit) body.limit = spec.limit;
  if (spec.number_format) body.number_format = spec.number_format;
  if (spec.formula !== undefined) body.formula = { expression: spec.formula };
  if (spec.type === 'relation') {
    if (!spec.relation_database_id) throw new ToolError(`Relation "${spec.name}" needs relation_database_id`);
    body.relation = { databaseId: parseId(spec.relation_database_id) };
    body.twoWay = spec.two_way ?? true;
  }
  if (spec.type === 'rollup') {
    if (!spec.rollup) throw new ToolError(`Rollup "${spec.name}" needs rollup {relation, property, function}`);
    const rel = findProp(db.schema, spec.rollup.relation);
    if (rel.type !== 'relation' || !rel.relation) throw new ToolError(`"${rel.name}" is not a relation property`);
    const target = await getDb(ctx, rel.relation.databaseId);
    body.rollup = { relationPropId: rel.id, targetPropId: findProp(target.schema, spec.rollup.property).id, fn: spec.rollup.function };
  }
  return body;
}

async function viewConfig(ctx: ToolCtx, db: DbMeta, a: any) {
  const config: any = {};
  if (a.filters) {
    config.filter = {
      op: a.filter_mode ?? 'and',
      filters: await Promise.all(
        a.filters.map(async (f: any) => {
          const p = findProp(db.schema, f.property);
          // Status-group and relative-date filters carry their value through as-is.
          const raw = (f.op === 'group' && p.type === 'status') || ['date', 'created_time', 'last_edited_time'].includes(p.type);
          return { prop: p.id, op: f.op, value: raw ? f.value : await filterValue(ctx, db, p, f.value) };
        }),
      ),
    };
  }
  if (a.sorts) config.sorts = a.sorts.map((s: any) => ({ prop: findProp(db.schema, s.property).id, dir: s.direction === 'descending' ? 'desc' : 'asc' }));
  if (a.group_by !== undefined) config.groupBy = a.group_by ? findProp(db.schema, a.group_by).id : null;
  if (a.date_property) {
    const id = findProp(db.schema, a.date_property).id;
    config.calendarBy = id;
    config.timelineBy = id;
  }
  if (a.visible_properties) {
    const visible = a.visible_properties.map((n: string) => findProp(db.schema, n).id);
    config.properties = db.schema.map((p) => ({ id: p.id, visible: p.type === 'title' || visible.includes(p.id) }));
  }
  const chartOf = (c: any) => ({
    kind: c.kind,
    ...(c.x_property ? { xProp: findProp(db.schema, c.x_property).id } : {}),
    ...(c.group_property ? { groupProp: findProp(db.schema, c.group_property).id } : {}),
    aggregate: { fn: c.aggregate ?? 'count', ...(c.aggregate_property ? { prop: findProp(db.schema, c.aggregate_property).id } : {}) },
    ...(c.sort ? { sort: c.sort } : {}),
    ...(c.date_bucket ? { bucket: c.date_bucket } : {}),
    ...(c.cumulative !== undefined ? { cumulative: c.cumulative } : {}),
    ...(c.hide_empty !== undefined ? { hideEmpty: c.hide_empty } : {}),
    ...(c.show_legend !== undefined ? { showLegend: c.show_legend } : {}),
  });
  const filtersOf = async (list: any[]) =>
    Promise.all(
      list.map(async (f: any) => {
        const p = findProp(db.schema, f.property);
        const raw = (f.op === 'group' && p.type === 'status') || ['date', 'created_time', 'last_edited_time'].includes(p.type);
        return { prop: p.id, op: f.op, value: raw ? f.value : await filterValue(ctx, db, p, f.value) };
      }),
    );
  if (a.chart) config.chart = chartOf(a.chart);
  if (a.form) {
    config.form = {
      ...(a.form.title !== undefined ? { title: a.form.title } : {}),
      ...(a.form.description !== undefined ? { description: a.form.description } : {}),
      questions: a.form.questions.map((qn: any) => ({ propId: findProp(db.schema, qn.property).id, ...(qn.label ? { label: qn.label } : {}), ...(qn.description ? { description: qn.description } : {}), ...(qn.required ? { required: true } : {}) })),
      access: a.form.access ?? 'members',
      ...(a.form.submit_label ? { submitLabel: a.form.submit_label } : {}),
      ...(a.form.thank_you ? { thankYou: a.form.thank_you } : {}),
    };
  }
  if (a.dashboard) {
    config.dashboard = {
      widgets: await Promise.all(
        a.dashboard.widgets.map(async (w: any, i: number) => ({
          id: Math.random().toString(36).slice(2, 10),
          ...(w.title ? { title: w.title } : {}),
          kind: w.kind,
          viewConfig: {
            ...(w.chart ? { chart: chartOf(w.chart) } : w.kind === 'number' ? { chart: { kind: 'number', aggregate: { fn: 'count' } } } : {}),
            ...(w.filters ? { filter: { op: 'and', filters: await filtersOf(w.filters) } } : {}),
            ...(w.group_by ? { groupBy: findProp(db.schema, w.group_by).id } : {}),
          },
          x: w.x ?? (i % 2) * 6, y: w.y ?? Math.floor(i / 2) * 4, w: w.w ?? 6, h: w.h ?? 4,
        })),
      ),
    };
  }
  if (a.map_place_property) config.map = { placeProp: findProp(db.schema, a.map_place_property).id };
  if (a.quick_filters) config.quickFilters = await filtersOf(a.quick_filters);
  return config;
}

/** Concise description of the content dialect, shared by the content tools (agents read these). */
const RICH_MD =
  'Content uses Notion-flavored Markdown (lossless for Atrium): CommonMark + GFM, plus tags — ' +
  '<b>/<i>/<u>/<s>, <span color="red|blue_bg…">, <mention url="…/p/<id>">Title</mention>, <mention url="user://<id>">Name</mention>, ' +
  '<date start="YYYY-MM-DD" start-time="HH:mm" />, $inline math$, $$ display math $$; blocks: <callout icon="💡" color="yellow_bg">, ' +
  '<toggle> (title then a blank line then children), <toggle heading="h2">, <todo checked>, <quote>, <p color>, <columns><column width>, ' +
  '<table header-row="true"> with <tr>/<td color>, <image|video|audio|file source="url">caption</image>, <bookmark source>, <embed source>, ' +
  '<page url>Title</page> (sub-page; omit url to create one), <database url inline|linked>, <synced-block-reference url>, <table-of-contents />, ' +
  'children of list items are tab-indented. Fetch a page first and edit its returned text; unchanged blocks are left untouched.';

async function rowsOut(ctx: ToolCtx, db: DbMeta, r: any, limit: number) {
  const names = await userNameMap(ctx);
  return r.rows.slice(0, limit).map((row: any) => ({ id: row.id, url: pageUrl(ctx, row.id), ...fromInternal(row, db.schema, r.titles ?? {}, names) }));
}

function schemaOut(db: DbMeta) {
  return db.schema.map((p) => {
    const o: any = { name: p.name, type: p.type };
    if (p.options) o.options = p.options.map((x) => (p.type === 'status' ? `${x.name} (${x.group})` : x.name));
    if (p.formula) o.formula = p.formula.expression;
    if (p.relation) o.relation_database_id = p.relation.databaseId;
    if (p.number_format && p.number_format !== 'number') o.number_format = p.number_format;
    if (p.description) o.description = p.description;
    if (p.type === 'person' && p.limit === 'one') o.limit = 'one';
    return o;
  });
}

function viewsOut(db: DbMeta) {
  const name = (id?: string | null) => (id ? db.schema.find((p) => p.id === id)?.name ?? id : undefined);
  return db.views.map((v) => ({
    id: v.id,
    name: v.name,
    type: v.type,
    ...(v.config.filter?.filters?.length ? { filters: v.config.filter.filters.map((f: any) => ({ property: name(f.prop), op: f.op, value: f.value })) } : {}),
    ...(v.config.sorts?.length ? { sorts: v.config.sorts.map((s: any) => ({ property: name(s.prop), direction: s.dir === 'desc' ? 'descending' : 'ascending' })) } : {}),
    ...(v.config.groupBy ? { group_by: name(v.config.groupBy) } : {}),
  }));
}

export const tools: ToolDef[] = [
  {
    name: 'search',
    title: 'Search workspace',
    description: 'Search pages and databases you can access by title and content. Returns ids, titles, URLs and snippets.',
    input: { query: z.string().describe('Search text'), limit: z.number().int().min(1).max(50).optional() },
    readOnly: true,
    run: async (ctx, a) => {
      const r = await call<any[]>(ctx, 'GET', `/search?q=${encodeURIComponent(a.query)}&limit=${a.limit ?? 15}`);
      return r.map((x) => ({ id: x.id, type: x.kind === 'database' ? 'database' : 'page', title: x.title || 'Untitled', url: pageUrl(ctx, x.id), parent: x.parent_title ?? undefined, snippet: x.snippet ?? undefined, updated_at: x.updated_at }));
    },
  },
  {
    name: 'fetch',
    title: 'Fetch page or database',
    description:
      'Get a page (with its properties if it is a database row), or a database with its schema and views. ' +
      'Page content is returned as lossless Notion-flavored Markdown (format "rich", default) that round-trips through update-page without losing ' +
      'toggles, callouts, colours, mentions, columns or tables; "markdown" is plain lossy CommonMark; "blocks" is Atrium block JSON. ' +
      'Accepts an id or an Atrium URL. Use query-database to list database rows.',
    input: {
      id: z.string().describe('Page/database id or URL'),
      format: z.enum(['rich', 'markdown', 'blocks']).optional().describe('Page content format (default rich)'),
    },
    readOnly: true,
    run: async (ctx, a) => {
      const id = parseId(a.id);
      const page = await call(ctx, 'GET', `/pages/${id}`);
      const meta = {
        id,
        url: pageUrl(ctx, id),
        title: page.title || 'Untitled',
        icon: page.icon ?? undefined,
        type: page.kind === 'database' ? 'database' : page.kind === 'row' ? 'database_row' : 'page',
        path: page.breadcrumbs.slice(0, -1).map((c: any) => c.title || 'Untitled').join(' / ') || undefined,
        teamspace: page.teamspace?.name,
        your_access: page.level,
        created_by: page.created_by_user?.name,
        last_edited_by: page.updated_by_user?.name,
        last_edited: page.updated_at,
      };
      if (page.kind === 'database') {
        const db = await getDb(ctx, id);
        const dflt = (db as any).default_template_id ? db.templates.find((t: any) => t.id === (db as any).default_template_id) : null;
        return {
          ...meta,
          ...((db as any).description ? { description: (db as any).description } : {}),
          schema: schemaOut(db),
          views: viewsOut(db),
          templates: db.templates.map((t: any) => t.title),
          ...(dflt ? { default_template: dflt.title } : {}),
        };
      }
      let properties: any;
      if (page.kind === 'row' && page.parent_id) {
        const db = await getDb(ctx, page.parent_id);
        const r = await call(ctx, 'POST', `/databases/${page.parent_id}/query`, { search: page.title });
        const row = r.rows.find((x: any) => x.id === id) ?? { ...page, computed: {} };
        properties = fromInternal(row, db.schema, r.titles ?? {}, await userNameMap(ctx));
        (meta as any).database_id = page.parent_id;
      }
      const header = JSON.stringify({ ...meta, ...(properties ? { properties } : {}) }, null, 2);
      if (a.format === 'blocks') return { ...meta, ...(properties ? { properties } : {}), blocks: (await call(ctx, 'GET', `/pages/${id}/content`)).blocks };
      const fmt = a.format === 'markdown' ? 'markdown' : 'rich';
      const body = await call<string>(ctx, 'GET', `/pages/${id}/content?format=${fmt}&base=${encodeURIComponent(ctx.baseUrl)}`);
      return `${header}\n\n---\n\n${body}`;
    },
  },
  {
    name: 'create-pages',
    title: 'Create pages',
    description:
      'Create one or more pages. Parent is a page, a teamspace, or a database (creates rows; set properties by name). ' +
      'With no parent the page is created in your Private section. ' + RICH_MD,
    input: {
      parent: z
        .object({ page_id: z.string().optional(), database_id: z.string().optional(), teamspace_id: z.string().optional() })
        .optional()
        .describe('Exactly one of page_id, database_id, teamspace_id (or omit for Private)'),
      pages: z
        .array(
          z.object({
            title: z.string().optional(),
            icon: z.string().optional().describe('Emoji'),
            properties: propertiesArg.optional(),
            content: z.string().optional().describe('Body in rich (Notion-flavored) Markdown'),
            blocks: z.array(z.any()).optional().describe('Alternative to content: Atrium block JSON'),
          }),
        )
        .min(1)
        .max(50),
      rehost: z.boolean().optional().describe('Copy remote images/files (e.g. expiring signed URLs) into Atrium storage and rewrite their URLs'),
      content_format: z.enum(['rich', 'markdown']).optional().describe('How to read content (default rich; markdown = legacy CommonMark parser)'),
    },
    run: async (ctx, a) => {
      const out = [];
      const writeBody = async (pageId: string, p: any) => {
        if (!p.content && !p.blocks) return [];
        const body = p.blocks ? { blocks: p.blocks } : a.content_format === 'markdown' ? { markdown: p.content } : { rich: p.content, base: ctx.baseUrl };
        const r = await call(ctx, 'PUT', `/pages/${pageId}/content`, { ...body, mode: 'replace' });
        return r.warnings ?? [];
      };
      const parent = a.parent ?? {};
      const db = parent.database_id ? await getDb(ctx, parseId(parent.database_id)) : null;
      for (const p0 of a.pages) {
        const p = a.rehost && p0.content ? { ...p0, content: (await rehostMarkdown(ctx, p0.content)).markdown } : p0;
        let created: any;
        if (db) {
          const { title, props } = await toInternalProps(ctx, db, p.properties ?? {});
          created = await call(ctx, 'POST', `/databases/${db.id}/rows`, { title: p.title ?? title ?? '', props });
          if (p.icon) await call(ctx, 'PATCH', `/pages/${created.id}`, { icon: p.icon });
        } else {
          if (p.properties && Object.keys(p.properties).length) throw new ToolError('Properties can only be set on pages inside a database (use parent.database_id)');
          created = await call(ctx, 'POST', '/pages', {
            parentId: parent.page_id ? parseId(parent.page_id) : undefined,
            teamspaceId: parent.teamspace_id ? parseId(parent.teamspace_id) : undefined,
            title: p.title ?? '',
            icon: p.icon,
          });
        }
        const warnings = await writeBody(created.id, p);
        out.push({ id: created.id, title: created.title || 'Untitled', url: pageUrl(ctx, created.id), ...(warnings.length ? { warnings } : {}) });
      }
      return out;
    },
  },
  {
    name: 'update-page',
    title: 'Update page',
    description:
      'Update a page. command: "update_properties" (title/icon/cover/full_width and, for database rows, properties by name); ' +
      '"update_content" (preferred for edits: content_updates = [{old_str, new_str, replace_all_matches?}] applied to the page text exactly as fetch returns it); ' +
      '"replace_content" (whole body; blocks that stay identical are kept untouched); "insert_content" (position start|end) / "append_content"; ' +
      '"insert_content_after" / "replace_content_range" (selection "start text...end text" picks top-level blocks). Results include warnings for anything ' +
      'that could not be represented (unknown mentions, foreign links). ' + RICH_MD,
    input: {
      page_id: z.string(),
      command: z.enum(['update_properties', 'update_content', 'replace_content', 'insert_content', 'append_content', 'insert_content_after', 'replace_content_range']),
      properties: propertiesArg.optional(),
      title: z.string().optional(),
      icon: z.string().nullable().optional().describe('Emoji, or null to remove'),
      cover: z.string().nullable().optional().describe('Image URL, or null to remove'),
      full_width: z.boolean().optional(),
      content: z.string().optional().describe('Rich (Notion-flavored) Markdown for content commands'),
      new_str: z.string().optional().describe('Alias of content for replace_content (Notion naming)'),
      blocks: z.array(z.any()).optional().describe('Alternative to content: Atrium block JSON'),
      content_updates: z
        .array(z.object({ old_str: z.string().min(1), new_str: z.string(), replace_all_matches: z.boolean().optional() }))
        .optional()
        .describe('For update_content'),
      position: z.object({ type: z.enum(['start', 'end']) }).optional().describe('For insert_content (default end)'),
      selection: z.string().optional().describe('For insert_content_after / replace_content_range: "start text...end text"'),
      content_format: z.enum(['rich', 'markdown']).optional().describe('How to read content (default rich)'),
      rehost: z.boolean().optional().describe('Copy remote images/files (and a remote cover) into Atrium storage and rewrite their URLs'),
    },
    destructive: true,
    run: async (ctx, a0) => {
      const id = parseId(a0.page_id);
      const a = { ...a0 };
      if (a.content === undefined && a.new_str !== undefined) a.content = a.new_str;
      if (a.rehost && a.content) a.content = (await rehostMarkdown(ctx, a.content, id)).markdown;
      if (a.rehost && a.cover) a.cover = await rehostUrl(ctx, a.cover, id);
      if (a.command === 'update_properties') {
        const page = await call(ctx, 'GET', `/pages/${id}`);
        const body: any = {};
        for (const k of ['title', 'icon', 'cover', 'full_width'] as const) if (a[k] !== undefined) body[k] = a[k];
        if (a.properties && Object.keys(a.properties).length) {
          if (page.kind !== 'row') throw new ToolError('Only database rows have properties; use title/icon/cover for pages');
          const db = await getDb(ctx, page.parent_id);
          const { title, props } = await toInternalProps(ctx, db, a.properties);
          if (title !== undefined) body.title = title;
          body.props = props;
        }
        if (!Object.keys(body).length) throw new ToolError('Nothing to update');
        const r = await call(ctx, 'PATCH', `/pages/${id}`, body);
        return { id, title: r.title, url: pageUrl(ctx, id), updated: Object.keys(body) };
      }
      let body: any;
      if (a.command === 'update_content') {
        if (!a.content_updates?.length) throw new ToolError('update_content needs content_updates: [{old_str, new_str}]');
        body = { mode: 'update', updates: a.content_updates, base: ctx.baseUrl };
      } else {
        if (a.content === undefined && !a.blocks) throw new ToolError(`${a.command} needs content`);
        const input = a.blocks ? { blocks: a.blocks } : a.content_format === 'markdown' ? { markdown: a.content || ' ' } : { rich: a.content ?? '', base: ctx.baseUrl };
        const mode =
          a.command === 'replace_content' ? 'replace'
          : a.command === 'append_content' ? 'append'
          : a.command === 'insert_content' ? (a.position?.type === 'start' ? 'prepend' : 'append')
          : a.command === 'insert_content_after' ? 'insert_after'
          : 'replace_range';
        if ((mode === 'insert_after' || mode === 'replace_range') && !a.selection) throw new ToolError(`${a.command} needs selection ("start text...end text")`);
        body = { ...input, mode, ...(a.selection ? { selection: a.selection } : {}) };
      }
      const r = await call(ctx, 'PUT', `/pages/${id}/content`, body);
      return { id, url: pageUrl(ctx, id), ok: true, changed: r.changed, ...(r.warnings?.length ? { warnings: r.warnings } : {}) };
    },
  },
  {
    name: 'move-pages',
    title: 'Move pages',
    description: 'Move pages under another page, to the top of a teamspace, or to your Private section.',
    input: {
      page_ids: z.array(z.string()).min(1).max(50),
      new_parent: z.object({ page_id: z.string().optional(), teamspace_id: z.string().optional(), private: z.boolean().optional() }),
    },
    run: async (ctx, a) => {
      const body = a.new_parent.page_id ? { parentId: parseId(a.new_parent.page_id) } : a.new_parent.teamspace_id ? { parentId: null, teamspaceId: parseId(a.new_parent.teamspace_id) } : { parentId: null };
      for (const p of a.page_ids) await call(ctx, 'POST', `/pages/${parseId(p)}/move`, body);
      return { moved: a.page_ids.length };
    },
  },
  {
    name: 'duplicate-page',
    title: 'Duplicate page',
    description: 'Duplicate a page with its sub-pages and databases.',
    input: { page_id: z.string() },
    run: async (ctx, a) => {
      const r = await call(ctx, 'POST', `/pages/${parseId(a.page_id)}/duplicate`, {});
      return { id: r.id, title: r.title, url: pageUrl(ctx, r.id) };
    },
  },
  {
    name: 'delete-page',
    title: 'Move page to Trash',
    description: 'Move a page (and its sub-pages) or database row to Trash. It can be restored with restore-page.',
    input: { page_id: z.string() },
    destructive: true,
    run: async (ctx, a) => {
      await call(ctx, 'DELETE', `/pages/${parseId(a.page_id)}`);
      return { trashed: true };
    },
  },
  {
    name: 'restore-page',
    title: 'Restore page from Trash',
    description: 'Restore a page from Trash.',
    input: { page_id: z.string() },
    run: async (ctx, a) => {
      await call(ctx, 'POST', `/pages/${parseId(a.page_id)}/restore`, {});
      return { restored: true };
    },
  },
  {
    name: 'query-database',
    title: 'Query database',
    description:
      'List rows of a database with optional filters and sorts (by property NAME and friendly values), or using a saved view. ' +
      'Returns property values by name.',
    input: {
      database_id: z.string(),
      view_id: z.string().optional().describe('Use a saved view’s filters and sorts'),
      filters: z.array(filterSpec).optional(),
      filter_mode: z.enum(['and', 'or']).optional(),
      sorts: z.array(sortSpec).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
    },
    readOnly: true,
    run: async (ctx, a) => {
      const db = await getDb(ctx, parseId(a.database_id));
      const body: any = { search: a.search };
      if (a.view_id) body.viewId = parseId(a.view_id);
      const cfg = await viewConfig(ctx, db, a);
      if (cfg.filter) body.filter = cfg.filter;
      if (cfg.sorts) body.sorts = cfg.sorts;
      const r = await call(ctx, 'POST', `/databases/${db.id}/query`, body);
      const limit = a.limit ?? 100;
      return { database: db.title || 'Untitled', total: r.rows.length, returned: Math.min(limit, r.rows.length), rows: await rowsOut(ctx, db, r, limit) };
    },
  },
  {
    name: 'create-database',
    title: 'Create database',
    description:
      'Create a full-page database under a page or teamspace (or Private) with the given properties. ' +
      'Include one "title" property (defaults to "Name").',
    input: {
      parent: z.object({ page_id: z.string().optional(), teamspace_id: z.string().optional() }).optional(),
      title: z.string(),
      icon: z.string().optional(),
      description: z.string().optional().describe('Database description shown under its title'),
      properties: z.array(propertySpec).optional(),
      views: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(VIEW_TYPES),
            filters: z.array(filterSpec).optional(),
            filter_mode: z.enum(['and', 'or']).optional(),
            sorts: z.array(sortSpec).optional(),
            group_by: z.string().optional(),
            date_property: z.string().optional(),
            visible_properties: z.array(z.string()).optional(),
            ...viewExtras,
          }),
        )
        .optional()
        .describe('Initial views (by property name). When given they replace the default "Table" view; otherwise one Table view is created.'),
    },
    run: async (ctx, a) => {
      const page = await call(ctx, 'POST', '/pages', {
        kind: 'database',
        title: a.title,
        icon: a.icon,
        parentId: a.parent?.page_id ? parseId(a.parent.page_id) : undefined,
        teamspaceId: a.parent?.teamspace_id ? parseId(a.parent.teamspace_id) : undefined,
      });
      let db = await getDb(ctx, page.id);
      const specs: z.infer<typeof propertySpec>[] = a.properties ?? [];
      const titleSpec = specs.find((s) => s.type === 'title');
      if (titleSpec) await call(ctx, 'PATCH', `/databases/${db.id}/properties/title`, { name: titleSpec.name });
      // Drop the default "Tags" unless the caller asked for it.
      const tags = db.schema.find((p) => p.name === 'Tags' && p.type === 'multi_select');
      const wantsTags = specs.find((s) => s.name.toLowerCase() === 'tags');
      if (tags && !(wantsTags && wantsTags.type === 'multi_select' && !wantsTags.options)) await call(ctx, 'DELETE', `/databases/${db.id}/properties/${tags.id}`);
      db = await getDb(ctx, page.id);
      for (const s of specs) {
        if (s.type === 'title' || db.schema.some((p) => p.name.toLowerCase() === s.name.toLowerCase())) continue;
        await call(ctx, 'POST', `/databases/${db.id}/properties`, await propBody(ctx, db, s));
        db = await getDb(ctx, page.id);
      }
      if (a.description) await call(ctx, 'PATCH', `/databases/${db.id}`, { description: a.description });
      if (a.views?.length) {
        // Turn the default view into the first requested one, then add the rest — no extra "Table" view.
        const [first, ...rest] = a.views as any[];
        const configFor = async (v: any) => {
          const config = await viewConfig(ctx, db, v);
          if (v.type === 'board' && !config.groupBy) {
            const g = db.schema.find((p) => p.type === 'status') ?? db.schema.find((p) => p.type === 'select');
            if (g) config.groupBy = g.id;
          }
          if ((v.type === 'calendar' || v.type === 'timeline') && !config.calendarBy) {
            const d = db.schema.find((p) => p.type === 'date');
            if (d) Object.assign(config, { calendarBy: d.id, timelineBy: d.id });
          }
          return config;
        };
        const defaultView = db.views[0];
        if (defaultView) await call(ctx, 'PATCH', `/views/${defaultView.id}`, { name: first.name, type: first.type, config: await configFor(first) });
        else await call(ctx, 'POST', `/databases/${db.id}/views`, { name: first.name, type: first.type, config: await configFor(first) });
        for (const v of rest) await call(ctx, 'POST', `/databases/${db.id}/views`, { name: v.name, type: v.type, config: await configFor(v) });
        db = await getDb(ctx, page.id);
      }
      return { id: page.id, url: pageUrl(ctx, page.id), schema: schemaOut(db), views: viewsOut(db) };
    },
  },
  {
    name: 'update-database',
    title: 'Update database',
    description:
      'Update a database: rename it / change icon, add properties, update properties (rename, change type, replace options, formula), or delete properties.',
    input: {
      database_id: z.string(),
      title: z.string().optional(),
      icon: z.string().optional(),
      description: z.string().nullable().optional().describe('Database description (null clears it)'),
      default_template: z.string().nullable().optional().describe('Template title or id used for new rows created from the UI "New" button (null clears it)'),
      add_properties: z.array(propertySpec).optional(),
      update_properties: z
        .array(
          z.object({
            name: z.string(),
            new_name: z.string().optional(),
            type: z.enum(PROP_TYPES).optional(),
            options: propertySpec.shape.options,
            groups: propertySpec.shape.groups,
            formula: z.string().optional(),
            number_format: z.string().optional(),
            description: z.string().nullable().optional(),
            limit: z.enum(['one', 'many']).optional(),
          }),
        )
        .optional(),
      delete_properties: z.array(z.string()).optional().describe('Property names'),
    },
    destructive: true,
    run: async (ctx, a) => {
      const id = parseId(a.database_id);
      if (a.title !== undefined || a.icon !== undefined) await call(ctx, 'PATCH', `/pages/${id}`, { ...(a.title !== undefined ? { title: a.title } : {}), ...(a.icon !== undefined ? { icon: a.icon } : {}) });
      let db = await getDb(ctx, id);
      if (a.description !== undefined || a.default_template !== undefined) {
        const body: any = {};
        if (a.description !== undefined) body.description = a.description;
        if (a.default_template !== undefined) {
          if (a.default_template === null) body.defaultTemplateId = null;
          else {
            const want = String(a.default_template);
            let asId: string | null = null;
            try {
              asId = parseId(want);
            } catch {}
            const t = db.templates.find((x: any) => (asId && x.id === asId) || (x.title || '').toLowerCase() === want.toLowerCase());
            if (!t) throw new ToolError(`No template "${want}". Templates: ${db.templates.map((x: any) => `"${x.title || 'Untitled'}"`).join(', ') || 'none'}`);
            body.defaultTemplateId = t.id;
          }
        }
        await call(ctx, 'PATCH', `/databases/${id}`, body);
      }
      for (const s of a.add_properties ?? []) {
        await call(ctx, 'POST', `/databases/${id}/properties`, await propBody(ctx, db, s));
        db = await getDb(ctx, id);
      }
      for (const u of a.update_properties ?? []) {
        const p = findProp(db.schema, u.name);
        const body: any = {};
        if (u.new_name) body.name = u.new_name;
        if (u.type) body.type = u.type;
        if (u.number_format) body.number_format = u.number_format;
        if (u.formula !== undefined) body.formula = { expression: u.formula };
        if (u.description !== undefined) body.description = u.description;
        if (u.limit) body.limit = u.limit;
        if (u.groups && !u.options) {
          // Regroup existing status options by name (keeps option ids, so row values survive).
          const groupOf = new Map<string, string>();
          for (const g of u.groups) for (const n of g.options) groupOf.set(n.toLowerCase(), g.name);
          body.options = (p.options ?? []).map((o) => ({ ...o, group: groupOf.get(o.name.toLowerCase()) ?? o.group }));
        }
        if (u.options) {
          // Keep ids (and therefore row values) of options whose names are unchanged.
          body.options = toOptions(u.options).map((o) => {
            const prev = p.options?.find((x) => x.name.toLowerCase() === o.name.toLowerCase());
            const src = u.options!.find((x: any) => (typeof x === 'string' ? x : x.name) === o.name);
            const group = (typeof src === 'object' && (src as any).group) || u.groups?.find((g: any) => g.options.some((n: string) => n.toLowerCase() === o.name.toLowerCase()))?.name;
            const base = prev ? { ...prev, ...(typeof src === 'object' && (src as any).color ? { color: o.color } : {}) } : o;
            return group ? { ...base, group } : base;
          });
        }
        await call(ctx, 'PATCH', `/databases/${id}/properties/${p.id}`, body);
        db = await getDb(ctx, id);
      }
      for (const n of a.delete_properties ?? []) {
        const p = findProp(db.schema, n);
        await call(ctx, 'DELETE', `/databases/${id}/properties/${p.id}`);
        db = await getDb(ctx, id);
      }
      return { id, url: pageUrl(ctx, id), schema: schemaOut(db) };
    },
  },
  {
    name: 'create-view',
    title: 'Create database view',
    description:
      'Add a view to a database: table, board, list, gallery, calendar, timeline, chart (bar/column/line/area/donut/number with count/sum/avg/min/max/median), ' +
      'form (questions → new rows; members or public link), dashboard (grid of chart/number/table/list/board widgets) or map (by a place property). ' +
      'Filters/sorts/grouping/quick filters by property name.',
    input: {
      database_id: z.string(),
      name: z.string(),
      type: z.enum(VIEW_TYPES),
      filters: z.array(filterSpec).optional(),
      filter_mode: z.enum(['and', 'or']).optional(),
      sorts: z.array(sortSpec).optional(),
      group_by: z.string().optional().describe('Property name (board/table/list)'),
      date_property: z.string().optional().describe('Date property for calendar/timeline'),
      visible_properties: z.array(z.string()).optional(),
      ...viewExtras,
    },
    run: async (ctx, a) => {
      const db = await getDb(ctx, parseId(a.database_id));
      const config = await viewConfig(ctx, db, a);
      if (a.type === 'board' && !config.groupBy) {
        const g = db.schema.find((p) => p.type === 'status') ?? db.schema.find((p) => p.type === 'select');
        if (g) config.groupBy = g.id;
      }
      if ((a.type === 'calendar' || a.type === 'timeline') && !config.calendarBy) {
        const d = db.schema.find((p) => p.type === 'date');
        if (d) Object.assign(config, { calendarBy: d.id, timelineBy: d.id });
      }
      const v = await call(ctx, 'POST', `/databases/${db.id}/views`, { name: a.name, type: a.type, config });
      return { id: v.id, name: v.name, type: v.type, database_url: pageUrl(ctx, db.id) };
    },
  },
  {
    name: 'update-view',
    title: 'Update database view',
    description: 'Rename a view, change its layout, or replace its filters/sorts/grouping/visible properties (by property name).',
    input: {
      view_id: z.string(),
      database_id: z.string(),
      name: z.string().optional(),
      type: z.enum(VIEW_TYPES).optional(),
      filters: z.array(filterSpec).optional().describe('Replaces the filter; pass [] to clear'),
      filter_mode: z.enum(['and', 'or']).optional(),
      sorts: z.array(sortSpec).optional().describe('Replaces the sorts; pass [] to clear'),
      group_by: z.string().nullable().optional(),
      date_property: z.string().optional(),
      visible_properties: z.array(z.string()).optional(),
      ...viewExtras,
    },
    run: async (ctx, a) => {
      const db = await getDb(ctx, parseId(a.database_id));
      const config = await viewConfig(ctx, db, a);
      const v = await call(ctx, 'PATCH', `/views/${parseId(a.view_id)}`, { name: a.name, type: a.type, config: Object.keys(config).length ? config : undefined });
      return { id: v.id, name: v.name, type: v.type };
    },
  },
  {
    name: 'upload-file-from-url',
    title: 'Upload file from URL',
    description:
      'Copy a remote file or image (e.g. an expiring Notion/S3 signed URL) into Atrium storage. Returns an Atrium file URL ' +
      'to use in page content (![alt](url)), as a cover, or in a files property. Private/internal addresses are refused.',
    input: {
      url: z.string().describe('http(s) URL of the file'),
      name: z.string().optional().describe('File name to store (default: from the server or URL)'),
      page_id: z.string().optional().describe('Page the file belongs to'),
    },
    run: async (ctx, a) => {
      const f = await call(ctx, 'POST', '/files/from-url', { url: a.url, name: a.name, ...(a.page_id ? { pageId: parseId(a.page_id) } : {}) });
      return { id: f.id, url: f.url, absolute_url: `${pageUrl(ctx, '').replace(/\/p\/?$/, '')}${f.url}`, name: f.name, size: f.size, mime: f.mime };
    },
  },
  {
    name: 'get-comments',
    title: 'Get comments',
    description: 'List comment threads on a page (open and resolved), including the quoted text for inline comments.',
    input: { page_id: z.string(), include_resolved: z.boolean().optional() },
    readOnly: true,
    run: async (ctx, a) => {
      const r = await call<any[]>(ctx, 'GET', `/pages/${parseId(a.page_id)}/comments`);
      return r
        .filter((t) => a.include_resolved || !t.resolved)
        .map((t) => ({
          thread_id: t.id,
          resolved: t.resolved,
          quote: t.quote ?? undefined,
          comments: t.comments.map((c: any) => ({ id: c.id, author: c.author?.name, body: c.body, created_at: c.created_at })),
        }));
    },
  },
  {
    name: 'create-comment',
    title: 'Create comment',
    description: 'Add a page-level comment, or reply to an existing thread with thread_id. Mention people with @[Name](user-id).',
    input: { page_id: z.string(), body: z.string().min(1), thread_id: z.string().optional() },
    run: async (ctx, a) => {
      const r = await call(ctx, 'POST', `/pages/${parseId(a.page_id)}/comments`, { body: a.body, threadId: a.thread_id ? parseId(a.thread_id) : undefined });
      return { comment_id: r.id, thread_id: r.thread_id };
    },
  },
  {
    name: 'get-users',
    title: 'List workspace members',
    description: 'List workspace members (id, name, email, role). Optional query filters by name/email.',
    input: { query: z.string().optional() },
    readOnly: true,
    run: async (ctx, a) => {
      const r = await call<any[]>(ctx, 'GET', '/users');
      const q = (a.query ?? '').toLowerCase();
      return r.filter((u) => u.active && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
    },
  },
  {
    name: 'get-self',
    title: 'Who am I',
    description: 'The user these tools act as, and the workspace.',
    input: {},
    readOnly: true,
    run: async (ctx) => {
      const me = await call(ctx, 'GET', '/me');
      return { id: me.id, name: me.name, email: me.email, role: me.role, workspace: me.workspace?.name, base_url: ctx.baseUrl };
    },
  },
  {
    name: 'list-recent',
    title: 'Recently visited pages',
    description: 'Pages you visited most recently.',
    input: {},
    readOnly: true,
    run: async (ctx) => (await call<any[]>(ctx, 'GET', '/recent')).map((p) => ({ id: p.id, title: p.title || 'Untitled', type: p.kind, url: pageUrl(ctx, p.id), visited_at: p.visited_at })),
  },
  {
    name: 'get-teamspaces',
    title: 'List teamspaces',
    description: 'Teamspaces in the workspace and whether you are a member. Use a teamspace id as a parent in create-pages.',
    input: {},
    readOnly: true,
    run: async (ctx) =>
      (await call<any[]>(ctx, 'GET', '/teamspaces')).map((t) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        description: t.description ?? undefined,
        member: !!t.my_role || t.is_default,
        open_to_everyone: t.is_default,
      })),
  },
];
