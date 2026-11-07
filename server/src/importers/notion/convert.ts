/**
 * Notion API JSON → Atrium (BlockNote blocks, database schemas, row values, views).
 * Converts directly from the API's block JSON (not via Markdown) to keep colours, toggles,
 * callouts, columns, mentions and nesting.
 */
import { createHash } from 'node:crypto';

export type WarnFn = (kind: string, message: string, notionId?: string) => void;

export interface ConvertCtx {
  /** Atrium id + title for an imported Notion page / database / data source id. */
  page(notionId: string): { id: string; title: string } | undefined;
  /** Atrium user for a Notion user id (people mapping). */
  user(notionUserId: string): { id: string; name: string } | undefined;
  /** Display name for a Notion user id, even when unmapped. */
  userName(notionUserId: string): string;
  /** Rehosts a Notion-hosted file; returns the URL to store, or null on failure. */
  file(f: any, name?: string): Promise<string | null>;
  /** Atrium synced-content page id for a Notion synced_block original id (created on demand). */
  synced(notionBlockId: string): Promise<string | null>;
  /** Pre-fetched children by Notion block id. */
  children(blockId: string): any[];
  /** For a linked database view (Notion block/database id): the Atrium source database to show. */
  linked?(notionId: string): { databaseId: string } | undefined;
  warn: WarnFn;
}

const NOTION_COLORS = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);

export function colorStyles(color: string | undefined): Record<string, string> {
  if (!color || color === 'default') return {};
  if (color.endsWith('_background')) {
    const c = color.replace('_background', '');
    return NOTION_COLORS.has(c) ? { backgroundColor: c } : {};
  }
  return NOTION_COLORS.has(color) ? { textColor: color } : {};
}

export const plain = (rt: any): string =>
  typeof rt === 'string' ? rt : Array.isArray(rt) ? rt.map((t) => t.plain_text ?? t.text?.content ?? '').join('') : '';

/** Maps links pointing at Notion pages to their imported Atrium page. */
function remapHref(href: string, ctx: ConvertCtx): string {
  // Notion URLs end in "<slug>-<32-hex id>"; the id is the last 32 hex chars of the final path segment.
  const isNotion = /^(https?:\/\/)?([\w-]+\.)?notion\.(so|site)\//i.test(href) || href.startsWith('/');
  const segment = href.split(/[?#]/)[0].split('/').pop() ?? '';
  const m = isNotion ? segment.replace(/-/g, '').match(/([0-9a-f]{32})$/i) : null;
  if (m) {
    const h = m[1].toLowerCase();
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const p = ctx.page(id);
    if (p) return `/p/${p.id}`;
  }
  return href;
}

export function richText(rt: any[] | undefined, ctx: ConvertCtx): any[] {
  const out: any[] = [];
  for (const t of rt ?? []) {
    const a = t.annotations ?? {};
    const styles: Record<string, any> = {
      ...(a.bold ? { bold: true } : {}),
      ...(a.italic ? { italic: true } : {}),
      ...(a.underline ? { underline: true } : {}),
      ...(a.strikethrough ? { strike: true } : {}),
      ...(a.code ? { code: true } : {}),
      ...colorStyles(a.color),
    };
    if (t.type === 'equation') {
      out.push({ type: 'inlineEquation', props: { latex: t.equation?.expression ?? t.plain_text ?? '' } });
      continue;
    }
    if (t.type === 'mention') {
      const m = t.mention ?? {};
      if (m.type === 'user' && m.user?.id) {
        const u = ctx.user(m.user.id);
        if (u) out.push({ type: 'mention', props: { kind: 'user', id: u.id, label: u.name } });
        else out.push({ type: 'text', text: `@${m.user.name ?? ctx.userName(m.user.id)}`, styles });
        continue;
      }
      if ((m.type === 'page' && m.page?.id) || (m.type === 'database' && m.database?.id) || (m.type === 'data_source' && m.data_source?.id)) {
        const nid = m.page?.id ?? m.database?.id ?? m.data_source?.id;
        const p = ctx.page(nid);
        if (p) out.push({ type: 'mention', props: { kind: 'page', id: p.id, label: p.title || t.plain_text || '' } });
        else {
          ctx.warn('mention_unresolved', `Mention of a page that wasn't imported: "${t.plain_text}"`, nid);
          out.push({ type: 'link', href: t.href ?? `https://www.notion.so/${String(nid).replace(/-/g, '')}`, content: [{ type: 'text', text: t.plain_text || 'Notion page', styles }] });
        }
        continue;
      }
      if (m.type === 'date' && m.date?.start) {
        out.push({ type: 'mention', props: { kind: 'date', id: '', label: '', date: m.date.start, reminder: '' } });
        if (m.date.end) out.push({ type: 'text', text: ' → ', styles: {} }, { type: 'mention', props: { kind: 'date', id: '', label: '', date: m.date.end, reminder: '' } });
        continue;
      }
      if ((m.type === 'link_preview' || m.type === 'link_mention') && (m.link_preview?.url || m.link_mention?.href)) {
        const url = m.link_preview?.url ?? m.link_mention?.href;
        out.push({ type: 'link', href: url, content: [{ type: 'text', text: t.plain_text || url, styles }] });
        continue;
      }
      // template mentions (@today/@me), custom emoji, etc. → their plain text
      out.push({ type: 'text', text: t.plain_text ?? '', styles });
      continue;
    }
    const text = t.text?.content ?? t.plain_text ?? '';
    if (!text) continue;
    const href = t.text?.link?.url ?? t.href;
    if (href) out.push({ type: 'link', href: remapHref(href, ctx), content: [{ type: 'text', text, styles }] });
    else out.push({ type: 'text', text, styles });
  }
  return out;
}

const blockColorProps = (color: string | undefined) => {
  const s = colorStyles(color);
  return { ...(s.textColor ? { textColor: s.textColor } : {}), ...(s.backgroundColor ? { backgroundColor: s.backgroundColor } : {}) };
};

const CODE_LANGS: Record<string, string> = { 'plain text': 'text', 'c++': 'cpp', 'c#': 'csharp', shell: 'bash', 'objective-c': 'objc', 'f#': 'fsharp', 'visual basic': 'vb' };

/** Converts a list of Notion blocks (with pre-fetched children) to BlockNote blocks. */
export async function convertBlocks(blocks: any[], ctx: ConvertCtx): Promise<any[]> {
  const out: any[] = [];
  for (const b of blocks) {
    const converted = await convertBlock(b, ctx);
    if (Array.isArray(converted)) out.push(...converted);
    // Keep Notion's block id so comments can anchor to it and re-imports stay stable.
    else if (converted) out.push(b.id && !converted.id ? { id: b.id, ...converted } : converted);
  }
  return out;
}

async function kids(b: any, ctx: ConvertCtx) {
  return b.has_children ? convertBlocks(ctx.children(b.id), ctx) : [];
}

async function fileBlock(b: any, ctx: ConvertCtx, type: 'image' | 'video' | 'audio' | 'file') {
  const data = b[b.type] ?? {};
  const name = data.name ?? (plain(data.caption) || undefined);
  const url = await ctx.file(data, name);
  if (!url) return { type: 'paragraph', content: [{ type: 'text', text: `[${b.type} could not be imported]`, styles: { italic: true, textColor: 'gray' } }], children: [] };
  return { type, props: { url, caption: plain(data.caption), ...(name ? { name } : {}) }, children: [] };
}

async function convertBlock(b: any, ctx: ConvertCtx): Promise<any | any[] | null> {
  const t = b.type as string;
  const d = b[t] ?? {};
  switch (t) {
    case 'paragraph':
      return { type: 'paragraph', props: blockColorProps(d.color), content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4': {
      const level = Math.min(Number(t.slice(-1)), 4);
      return { type: 'heading', props: { level, isToggleable: !!d.is_toggleable, ...blockColorProps(d.color) }, content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    }
    case 'bulleted_list_item':
      return { type: 'bulletListItem', props: blockColorProps(d.color), content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'numbered_list_item':
      return { type: 'numberedListItem', props: blockColorProps(d.color), content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'to_do':
      return { type: 'checkListItem', props: { checked: !!d.checked, ...blockColorProps(d.color) }, content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'toggle':
      return { type: 'toggleListItem', props: blockColorProps(d.color), content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'quote':
      return { type: 'quote', props: blockColorProps(d.color), content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    case 'callout': {
      const icon = d.icon;
      let emoji = '💡';
      if (icon?.type === 'emoji') emoji = icon.emoji;
      else if (icon) {
        // Custom/image icons: rehost and store the URL (Atrium callouts accept an image URL as the icon).
        const src = icon.type === 'custom_emoji' ? { type: 'external', external: { url: icon.custom_emoji?.url } } : icon;
        const url = await ctx.file(src, 'icon');
        if (url) emoji = url;
        else ctx.warn('callout_icon', 'Callout icon image could not be copied; default emoji used', b.id);
      }
      const bg = colorStyles(d.color).backgroundColor ?? (d.color && d.color !== 'default' ? 'gray' : 'default');
      return { type: 'callout', props: { emoji, backgroundColor: d.color === 'default' ? 'default' : bg, textColor: colorStyles(d.color).textColor ?? 'default' }, content: richText(d.rich_text, ctx), children: await kids(b, ctx) };
    }
    case 'divider':
      return { type: 'divider', children: [] };
    case 'code': {
      const lang = String(d.language ?? 'text').toLowerCase();
      return { type: 'codeBlock', props: { language: CODE_LANGS[lang] ?? lang }, content: [{ type: 'text', text: plain(d.rich_text), styles: {} }], children: [] };
    }
    case 'equation':
      return { type: 'equation', props: { latex: d.expression ?? '' }, children: [] };
    case 'table': {
      const rows = ctx.children(b.id).filter((r) => r.type === 'table_row');
      const width = d.table_width ?? Math.max(1, ...rows.map((r) => r.table_row?.cells?.length ?? 0));
      return {
        type: 'table',
        content: {
          type: 'tableContent',
          columnWidths: Array.from({ length: width }, () => undefined),
          ...(d.has_column_header ? { headerRows: 1 } : {}),
          ...(d.has_row_header ? { headerCols: 1 } : {}),
          rows: rows.map((r) => ({ cells: Array.from({ length: width }, (_, i) => richText(r.table_row?.cells?.[i] ?? [], ctx)) })),
        },
        children: [],
      };
    }
    case 'image':
      return fileBlock(b, ctx, 'image');
    case 'video':
      return fileBlock(b, ctx, 'video');
    case 'audio':
      return fileBlock(b, ctx, 'audio');
    case 'file':
    case 'pdf':
      return fileBlock(b, ctx, 'file');
    case 'bookmark':
      return { type: 'bookmark', props: { url: d.url ?? '', title: plain(d.caption) }, children: [] };
    case 'embed':
      return { type: 'embed', props: { url: d.url ?? '' }, children: [] };
    case 'link_preview':
      return { type: 'bookmark', props: { url: d.url ?? '' }, children: [] };
    case 'column_list': {
      const cols = ctx.children(b.id).filter((c) => c.type === 'column');
      if (cols.length < 2) return cols.length ? convertBlocks(ctx.children(cols[0].id), ctx) : null;
      const columns = [];
      for (const c of cols.slice(0, 5)) {
        const ratio = c.column?.width_ratio;
        columns.push({ type: 'column', props: { width: typeof ratio === 'number' ? ratio * cols.length : 1 }, children: await convertBlocks(ctx.children(c.id), ctx) });
      }
      if (cols.length > 5) ctx.warn('columns', `${cols.length} columns imported as 5`, b.id);
      return { type: 'columnList', children: columns };
    }
    case 'synced_block': {
      const sourceNotionId = d.synced_from?.block_id ?? b.id;
      const sourceId = await ctx.synced(sourceNotionId);
      if (!sourceId) {
        ctx.warn('synced_block', 'Synced block source not accessible; content inlined', b.id);
        return convertBlocks(ctx.children(b.id), ctx);
      }
      return { type: 'syncedBlock', props: { sourceId }, children: [] };
    }
    case 'child_page': {
      const p = ctx.page(b.id);
      return p ? { type: 'subpage', props: { pageId: p.id, title: d.title ?? p.title }, children: [] } : null;
    }
    case 'child_database': {
      const linked = ctx.linked?.(b.id);
      if (linked) return { type: 'database', props: { databaseId: linked.databaseId, linked: true }, children: [] };
      const p = ctx.page(b.id);
      if (!p) {
        ctx.warn('child_database', `Inline database "${d.title ?? ''}" was not imported (outside this import's selection or item limit, or a linked view whose source isn't shared)`, b.id);
        return { type: 'paragraph', content: [{ type: 'text', text: `Database: ${d.title ?? 'Untitled'} (not imported)`, styles: { italic: true, textColor: 'gray' } }], children: [] };
      }
      return { type: 'database', props: { databaseId: p.id, linked: false }, children: [] };
    }
    case 'link_to_page': {
      const nid = d.page_id ?? d.database_id ?? d.data_source_id;
      const p = nid ? ctx.page(nid) : undefined;
      if (!p) {
        ctx.warn('link_to_page', 'Link to a page that was not imported', nid);
        return null;
      }
      return { type: 'paragraph', content: [{ type: 'mention', props: { kind: 'page', id: p.id, label: p.title } }], children: [] };
    }
    case 'table_of_contents':
      return { type: 'toc', children: [] };
    case 'breadcrumb':
      return { type: 'breadcrumb', children: [] };
    case 'button':
    case 'template': {
      const label = plain(d.rich_text) || d.name || 'Button';
      ctx.warn('button', `Button "${label}" imported without its actions`, b.id);
      return { type: 'button', props: { label, actions: '[]' }, children: [] };
    }
    case 'unsupported':
    default: {
      ctx.warn('unsupported_block', `Unsupported Notion block: ${t}`, b.id);
      return { type: 'callout', props: { emoji: '⚠️', backgroundColor: 'yellow', textColor: 'default' }, content: [{ type: 'text', text: `Unsupported Notion block (${t}) — not imported`, styles: {} }], children: [] };
    }
  }
}

// ---------------- databases ----------------

/** Stable Atrium property id for a Notion property, so re-runs and cross-references line up. */
export function propId(dataSourceId: string, notionPropId: string, type?: string) {
  if (type === 'title') return 'title';
  return 'n' + createHash('sha1').update(`${dataSourceId}:${decodeURIComponent(notionPropId)}`).digest('hex').slice(0, 9);
}

const ROLLUP_FN: Record<string, string> = {
  count: 'count', count_all: 'count', count_values: 'count_values', count_not_empty: 'count_values', count_unique_values: 'unique', unique: 'unique',
  count_empty: 'empty', empty: 'empty', sum: 'sum', average: 'average', median: 'average', min: 'min', max: 'max', earliest_date: 'min', latest_date: 'max',
  percent_checked: 'percent_checked', checked: 'percent_checked', show_original: 'show_original', show_unique: 'show_original',
};

const STATUS_GROUP = (name: string, i: number): 'todo' | 'in_progress' | 'complete' => {
  const n = name.toLowerCase();
  if (/to.?do|not started|backlog/.test(n)) return 'todo';
  if (/progress|doing|active/.test(n)) return 'in_progress';
  if (/complete|done|closed/.test(n)) return 'complete';
  return (['todo', 'in_progress', 'complete'] as const)[Math.min(i, 2)];
};

/**
 * Notion data source properties → Atrium schema.
 * `dbFor(dataSourceId)` returns the Atrium database id for a related data source (if imported).
 */
export function convertSchema(dataSourceId: string, properties: Record<string, any>, dbFor: (dsId: string) => string | undefined, warn: WarnFn): any[] {
  const schema: any[] = [];
  const entries = Object.values(properties ?? {}) as any[];
  entries.sort((a, b) => (a.type === 'title' ? -1 : b.type === 'title' ? 1 : 0));
  for (const p of entries) {
    const id = propId(dataSourceId, p.id, p.type);
    const base: any = { id, name: p.name, notion_id: p.id, ...(p.description ? { description: p.description } : {}) };
    const opt = (o: any) => ({ id: o.id, name: o.name, color: o.color === 'default' ? 'default' : NOTION_COLORS.has(o.color) ? o.color : 'gray' });
    switch (p.type) {
      case 'title': schema.push({ ...base, type: 'title' }); break;
      case 'rich_text': schema.push({ ...base, type: 'text' }); break;
      case 'number': schema.push({ ...base, type: 'number', number_format: p.number?.format ?? 'number' }); break;
      case 'select': schema.push({ ...base, type: 'select', options: (p.select?.options ?? []).map(opt) }); break;
      case 'multi_select': schema.push({ ...base, type: 'multi_select', options: (p.multi_select?.options ?? []).map(opt) }); break;
      case 'status': {
        const groups: any[] = p.status?.groups ?? [];
        const groupOf = new Map<string, string>();
        groups.forEach((g, i) => (g.option_ids ?? []).forEach((oid: string) => groupOf.set(oid, STATUS_GROUP(g.name ?? '', i))));
        schema.push({ ...base, type: 'status', options: (p.status?.options ?? []).map((o: any) => ({ ...opt(o), group: groupOf.get(o.id) ?? 'todo' })) });
        break;
      }
      case 'date': schema.push({ ...base, type: 'date' }); break;
      case 'people': schema.push({ ...base, type: 'person', ...(p.people?.limit === 1 || p.people?.single ? { limit: 1 } : {}) }); break;
      case 'files': schema.push({ ...base, type: 'files' }); break;
      case 'checkbox': schema.push({ ...base, type: 'checkbox' }); break;
      case 'url': schema.push({ ...base, type: 'url' }); break;
      case 'email': schema.push({ ...base, type: 'email' }); break;
      case 'phone_number': schema.push({ ...base, type: 'phone' }); break;
      case 'formula': schema.push({ ...base, type: 'formula', formula: { expression: p.formula?.expression ?? '' } }); break;
      case 'relation': {
        const target = p.relation?.data_source_id ?? p.relation?.database_id;
        const targetDb = target ? dbFor(target) : undefined;
        if (!targetDb) {
          warn('relation_target', `Relation "${p.name}" points to a database that wasn't imported; kept as text`, p.id);
          schema.push({ ...base, type: 'text' });
          break;
        }
        const synced = p.relation?.dual_property?.synced_property_id;
        schema.push({ ...base, type: 'relation', relation: { databaseId: targetDb, syncedPropId: synced ? propId(target, synced) : null } });
        break;
      }
      case 'rollup': {
        const r = p.rollup ?? {};
        const relProp = entries.find((x) => x.id === r.relation_property_id || x.name === r.relation_property_name);
        const target = relProp?.relation?.data_source_id ?? relProp?.relation?.database_id;
        const fn = ROLLUP_FN[r.function] ?? 'show_original';
        if (!ROLLUP_FN[r.function]) warn('rollup_function', `Rollup "${p.name}" function "${r.function}" shown as original values`, p.id);
        if (!relProp || !target || !dbFor(target)) {
          warn('rollup_target', `Rollup "${p.name}" depends on a relation that wasn't imported`, p.id);
          schema.push({ ...base, type: 'text' });
          break;
        }
        schema.push({ ...base, type: 'rollup', rollup: { relationPropId: propId(dataSourceId, relProp.id), targetPropId: r.rollup_property_id ? propId(target, r.rollup_property_id) : 'title', fn } });
        break;
      }
      case 'created_time': schema.push({ ...base, type: 'created_time' }); break;
      case 'created_by': schema.push({ ...base, type: 'created_by' }); break;
      case 'last_edited_time': schema.push({ ...base, type: 'last_edited_time' }); break;
      case 'last_edited_by': schema.push({ ...base, type: 'last_edited_by' }); break;
      case 'unique_id': schema.push({ ...base, type: 'unique_id', id_prefix: p.unique_id?.prefix ?? '' }); break;
      case 'verification':
        schema.push({ ...base, type: 'verification' });
        break;
      case 'place':
        schema.push({ ...base, type: 'place' });
        break;
      case 'button':
        // Notion's API doesn't expose button actions; the button is created with its label so it can be set up again.
        warn('button_actions', `Button property "${p.name}" imported without its actions (not available through Notion's API)`, p.id);
        schema.push({ ...base, type: 'button', button: { label: p.name, actions: [] } });
        break;
      default:
        warn('property_type', `Property "${p.name}" of type ${p.type} imported as text`, p.id);
        schema.push({ ...base, type: 'text' });
    }
  }
  if (!schema.some((p) => p.type === 'title')) schema.unshift({ id: 'title', name: 'Name', type: 'title' });
  return schema;
}

/** Row page properties → Atrium props (keyed by Atrium property id). Title is returned separately. */
export async function convertRowProps(
  dataSourceId: string,
  properties: Record<string, any>,
  schema: any[],
  ctx: ConvertCtx,
  loadRelation: (propNotionId: string) => Promise<string[]>,
): Promise<{ title: string; props: Record<string, any> }> {
  const props: Record<string, any> = {};
  let title = '';
  for (const p of Object.values(properties ?? {}) as any[]) {
    const id = propId(dataSourceId, p.id, p.type);
    const def = schema.find((s) => s.id === id);
    const v = p[p.type];
    switch (p.type) {
      case 'title': title = plain(v); break;
      case 'rich_text': if (def) props[id] = plain(v); break;
      case 'number': props[id] = v ?? null; break;
      case 'select': props[id] = v?.id ?? null; break;
      case 'multi_select': props[id] = (v ?? []).map((o: any) => o.id); break;
      case 'status':
        props[id] = def?.type === 'status' ? v?.id ?? null : v?.name ?? null;
        break;
      case 'date': props[id] = v?.start ? { start: v.start, ...(v.end ? { end: v.end } : {}) } : null; break;
      case 'people': {
        const ids: string[] = [];
        for (const u of v ?? []) {
          const m = ctx.user(u.id);
          if (m) ids.push(m.id);
          else ctx.warn('person_unmapped', `"${u.name ?? ctx.userName(u.id)}" has no Atrium account; removed from "${p.name}"`, u.id);
        }
        props[id] = ids;
        break;
      }
      case 'files': {
        const files = [];
        for (const f of v ?? []) {
          const url = await ctx.file(f, f.name);
          if (url) files.push({ name: f.name ?? 'file', url });
        }
        props[id] = files;
        break;
      }
      case 'checkbox': props[id] = !!v; break;
      case 'url':
      case 'email':
      case 'phone_number': props[id] = v ?? null; break;
      case 'relation': {
        let rel: string[] = (v ?? []).map((r: any) => r.id);
        if (p.has_more) rel = await loadRelation(p.id);
        if (def?.type === 'relation') props[id] = rel.map((nid) => ctx.page(nid)?.id).filter(Boolean);
        else props[id] = rel.map((nid) => ctx.page(nid)?.title ?? '').filter(Boolean).join(', ');
        break;
      }
      case 'unique_id': if (v?.number != null) props.__uid = v.number; break;
      case 'verification':
        props[id] = v?.state
          ? {
              state: v.state === 'verified' || v.state === 'expired' ? v.state : 'unverified',
              ...(v.verified_by?.id && ctx.user(v.verified_by.id) ? { by: ctx.user(v.verified_by.id)!.id } : {}),
              ...(v.date?.start ? { at: v.date.start } : {}),
              ...(v.date?.end ? { until: v.date.end } : {}),
            }
          : null;
        break;
      case 'place':
        props[id] = v && (v.lat != null || v.latitude != null)
          ? { lat: Number(v.lat ?? v.latitude), lng: Number(v.lon ?? v.lng ?? v.longitude), ...(v.name ? { name: v.name } : {}), ...(v.address ? { address: v.address } : {}) }
          : v?.name || v?.address ? { lat: null, lng: null, name: v.name ?? undefined, address: v.address ?? undefined } : null;
        break;
      // formula, rollup, created_* and last_edited_* are computed by Atrium
    }
  }
  return { title, props };
}

// ---------------- views ----------------

const VIEW_TYPES = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'form', 'dashboard', 'map']);

const CHART_KINDS: Record<string, string> = { bar: 'bar', horizontal_bar: 'bar', column: 'column', vertical_bar: 'column', line: 'line', area: 'area', donut: 'donut', pie: 'donut', number: 'number' };
const AGG_FNS: Record<string, string> = { count: 'count', count_all: 'count', sum: 'sum', average: 'avg', avg: 'avg', min: 'min', max: 'max', median: 'median' };

const decodeId = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Notion returns property ids URL-encoded in schemas ("xC%3Ej") but decoded in view filters/sorts ("xC>j"). */
export function findProp(schema: any[], ref: string | undefined) {
  if (!ref) return undefined;
  const d = decodeId(ref);
  return schema.find((p) => p.notion_id === ref || (p.notion_id && decodeId(p.notion_id) === d) || p.name === ref || p.id === ref);
}

/** Notion filter → Atrium filter group. Unsupported conditions are dropped and reported. */
export function convertFilter(f: any, schema: any[], ctx: ConvertCtx, viewName: string): any | null {
  if (!f) return null;
  if (Array.isArray(f.and) || Array.isArray(f.or)) {
    const op = f.and ? 'and' : 'or';
    const filters = (f.and ?? f.or).map((x: any) => convertFilter(x, schema, ctx, viewName)).filter(Boolean);
    return filters.length ? { op, filters } : null;
  }
  const timestamp = f.timestamp as string | undefined;
  const p = timestamp ? schema.find((s) => s.type === timestamp) : findProp(schema, f.property);
  if (!p) {
    ctx.warn('view_filter', `View "${viewName}": filter on "${f.property ?? timestamp}" dropped (property not imported)`);
    return null;
  }
  const key = Object.keys(f).find((k) => !['property', 'timestamp', 'type'].includes(k))!;
  const cond = f[key] ?? {};
  const [opName, value] = Object.entries(cond)[0] ?? [];
  const wrap = (op: string, v?: any) => ({ op: 'and', filters: [{ prop: p.id, op, value: v }] }).filters[0];
  const optId = (name: any) => p.options?.find((o: any) => o.name === name || o.id === name)?.id ?? name;
  const simple: Record<string, string> = {
    equals: 'is', does_not_equal: 'is_not', contains: 'contains', does_not_contain: 'does_not_contain', starts_with: 'starts_with',
    ends_with: 'ends_with', is_empty: 'is_empty', is_not_empty: 'is_not_empty',
  };
  const numOps: Record<string, string> = {
    equals: '=', does_not_equal: '!=', greater_than: '>', less_than: '<', greater_than_or_equal_to: '>=', less_than_or_equal_to: '<=', is_empty: 'is_empty', is_not_empty: 'is_not_empty',
  };
  const dateOps: Record<string, string> = {
    equals: 'is', before: 'before', after: 'after', on_or_before: 'on_or_before', on_or_after: 'on_or_after', past_week: 'past_week', past_month: 'past_month',
    next_week: 'next_week', next_month: 'next_month', is_empty: 'is_empty', is_not_empty: 'is_not_empty',
  };
  if (p.type === 'number' || p.type === 'unique_id') {
    if (!numOps[opName!]) return unsupported();
    return wrap(numOps[opName!], value);
  }
  if (p.type === 'checkbox') return wrap('is', value === true || value === 'true');
  if (['date', 'created_time', 'last_edited_time'].includes(p.type)) {
    if (!dateOps[opName!]) return unsupported();
    return wrap(dateOps[opName!], typeof value === 'object' ? undefined : value);
  }
  if (p.type === 'select' || p.type === 'status') {
    if (opName === 'equals') return wrap('is', [optId(value)]);
    if (opName === 'does_not_equal') return wrap('is_not', [optId(value)]);
    if (opName === 'is_empty' || opName === 'is_not_empty') return wrap(opName);
    return unsupported();
  }
  if (['multi_select', 'person', 'relation', 'created_by', 'last_edited_by'].includes(p.type)) {
    const mapVal = (v: any) => (p.type === 'multi_select' ? optId(v) : p.type === 'relation' ? ctx.page(v)?.id ?? v : ctx.user(v)?.id ?? v);
    if (opName === 'contains') return wrap('contains', [mapVal(value)]);
    if (opName === 'does_not_contain') return wrap('does_not_contain', [mapVal(value)]);
    if (opName === 'is_empty' || opName === 'is_not_empty') return wrap(opName);
    return unsupported();
  }
  if (!simple[opName!]) return unsupported();
  return wrap(simple[opName!], value);

  function unsupported() {
    ctx.warn('view_filter', `View "${viewName}": filter "${p.name} ${opName}" not supported in Atrium; dropped`);
    return null;
  }
}

export function convertView(v: any, schema: any[], ctx: ConvertCtx): { name: string; type: string; config: any } {
  const name = v.name || 'View';
  let type = v.type ?? 'table';
  if (type === 'feed') {
    // Notion's feed view (pages shown as a stream) — Atrium's list view is the closest layout.
    ctx.warn('view_type', `View "${name}" (feed) imported as a list${v._unreadable ? ' (its settings are not readable through the Notion API)' : ''}`);
    type = 'list';
  } else if (!VIEW_TYPES.has(type)) {
    ctx.warn('view_type', `View "${name}" (${type}) imported as a table${v._unreadable ? ' (its settings are not readable through the Notion API)' : ''}`);
    type = 'table';
  }
  const conf = v.configuration ?? v.format ?? {};
  const config: any = {};
  const filter = convertFilter(v.filter ?? conf.filter, schema, ctx, name);
  if (filter) config.filter = filter.filters ? filter : { op: 'and', filters: [filter] };
  const sorts = (v.sorts ?? conf.sorts ?? [])
    .map((s: any) => {
      const p = s.timestamp ? schema.find((x) => x.type === s.timestamp) : findProp(schema, s.property);
      return p ? { prop: p.id, dir: s.direction === 'descending' ? 'desc' : 'asc' } : null;
    })
    .filter(Boolean);
  if (sorts.length) config.sorts = sorts;
  const groupRef = conf.group_by?.property_id ?? conf.group_by?.property ?? conf.group_by_property_id ?? v.group_by?.property;
  const group = findProp(schema, groupRef);
  if (group) config.groupBy = group.id;
  const dateRef = conf.date_property_id ?? conf.calendar_by ?? conf.timeline_by ?? conf.date_property;
  const dateProp = findProp(schema, dateRef) ?? (type === 'calendar' || type === 'timeline' ? schema.find((p) => p.type === 'date') : undefined);
  if (dateProp && type === 'calendar') config.calendarBy = dateProp.id;
  if (dateProp && type === 'timeline') config.timelineBy = dateProp.id;
  const propsConf: any[] = conf.properties ?? conf.table_properties ?? conf.visible_properties ?? [];
  if (Array.isArray(propsConf) && propsConf.length) {
    config.properties = propsConf
      .map((x: any) => {
        const ref = typeof x === 'string' ? x : x.property_id ?? x.property ?? x.id;
        const p = findProp(schema, ref);
        return p ? { id: p.id, visible: typeof x === 'string' ? true : x.visible !== false, ...(x.width ? { width: x.width } : {}) } : null;
      })
      .filter(Boolean);
  }
  if (type === 'gallery' && (conf.cover?.type === 'page_cover' || conf.card_preview === 'cover')) config.cardPreview = 'cover';
  if (conf.group_by?.hide_empty_groups) config.hideEmptyGroups = true;
  if (typeof conf.frozen_column_index === 'number' && conf.frozen_column_index >= 0) config.frozenColumns = conf.frozen_column_index + 1;

  // Quick filters: Notion keys them by property id, each value a filter condition ({} = pinned, no value yet).
  const qf = v.quick_filters ?? conf.quick_filters;
  if (qf && typeof qf === 'object' && Object.keys(qf).length) {
    const out: any[] = [];
    for (const [propRef, cond] of Object.entries(qf as Record<string, any>)) {
      const p = findProp(schema, propRef) ?? findProp(schema, decodeURIComponent(propRef));
      if (!p) continue;
      const condKey = cond && typeof cond === 'object' ? Object.keys(cond).find((k) => k !== 'property' && k !== 'type') : undefined;
      if (!condKey || !cond[condKey] || !Object.keys(cond[condKey]).length) { out.push({ prop: p.id }); continue; }
      const f = convertFilter({ property: p.notion_id ?? p.id, [condKey]: cond[condKey] }, schema, ctx, name);
      out.push(f && !f.filters ? { prop: f.prop, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) } : { prop: p.id });
    }
    if (out.length) config.quickFilters = out;
  }

  // New view types (best effort: Notion's API shapes for these aren't documented in detail yet).
  if (type === 'chart') {
    const c = conf.chart ?? conf;
    const x = findProp(schema, c.x_axis?.property_id ?? c.x_axis?.property ?? c.group_by?.property_id ?? c.x_property_id);
    const g = findProp(schema, c.y_axis?.group_by?.property_id ?? c.stack_by?.property_id ?? c.series_property_id);
    const aggProp = findProp(schema, c.y_axis?.property_id ?? c.aggregation?.property_id ?? c.value?.property_id);
    const fn = AGG_FNS[String(c.y_axis?.aggregation ?? c.aggregation?.function ?? c.value?.function ?? 'count')] ?? 'count';
    config.chart = {
      kind: CHART_KINDS[String(c.chart_type ?? c.type ?? 'bar')] ?? 'bar',
      ...(x ? { xProp: x.id } : {}),
      ...(g ? { groupProp: g.id } : {}),
      aggregate: { fn, ...(aggProp && fn !== 'count' ? { prop: aggProp.id } : {}) },
      ...(c.sort ? { sort: String(c.sort).includes('desc') ? 'value-desc' : 'x-asc' } : {}),
      ...(c.cumulative ? { cumulative: true } : {}),
      ...(c.hide_empty ? { hideEmpty: true } : {}),
      ...(c.show_legend === false ? { showLegend: false } : {}),
    };
    ctx.warn('view_best_effort', `View "${name}" (chart): chart settings mapped on a best-effort basis — check it`);
  }
  if (type === 'form') {
    const qs: any[] = conf.questions ?? conf.form?.questions ?? conf.properties ?? [];
    config.form = {
      ...(conf.title ? { title: String(conf.title) } : {}),
      ...(conf.description ? { description: typeof conf.description === 'string' ? conf.description : plain(conf.description) } : {}),
      questions: qs
        .map((x: any) => {
          const p = findProp(schema, typeof x === 'string' ? x : x.property_id ?? x.property);
          return p ? { propId: p.id, ...(x.label ? { label: x.label } : {}), ...(x.description ? { description: x.description } : {}), ...(x.required ? { required: true } : {}) } : null;
        })
        .filter(Boolean),
      access: conf.access === 'public' || conf.anyone_with_link ? 'link' : 'members',
    };
    if (!config.form.questions.length) config.form.questions = schema.filter((p) => !['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'button'].includes(p.type)).map((p) => ({ propId: p.id }));
    ctx.warn('view_best_effort', `View "${name}" (form): questions mapped on a best-effort basis — check it`);
  }
  if (type === 'map') {
    const pl = findProp(schema, conf.place_property_id ?? conf.map_by?.property_id) ?? schema.find((p) => p.type === 'place');
    if (pl) config.map = { placeProp: pl.id };
    else { ctx.warn('view_type', `View "${name}" (map) has no place property; imported as a table`); return { name, type: 'table', config }; }
  }
  if (type === 'dashboard') {
    const widgets: any[] = conf.widgets ?? conf.modules ?? [];
    config.dashboard = {
      widgets: widgets.map((w: any, i: number) => ({
        id: String(w.id ?? i),
        ...(w.title ? { title: String(w.title) } : {}),
        kind: ['chart', 'number', 'table', 'list', 'board'].includes(w.type) ? w.type : 'table',
        viewConfig: {},
        x: Number(w.x ?? (i % 2) * 6), y: Number(w.y ?? Math.floor(i / 2) * 4), w: Number(w.w ?? w.width ?? 6), h: Number(w.h ?? w.height ?? 4),
      })),
    };
    ctx.warn('view_best_effort', `View "${name}" (dashboard): ${widgets.length} widgets mapped on a best-effort basis — check it`);
  }
  return { name, type, config };
}

export function iconValue(icon: any): { emoji?: string; file?: any } | null {
  if (!icon) return null;
  if (icon.type === 'emoji') return { emoji: icon.emoji };
  if (icon.type === 'external' || icon.type === 'file' || icon.type === 'custom_emoji') return { file: icon.type === 'custom_emoji' ? { type: 'external', external: { url: icon.custom_emoji?.url } } : icon };
  return null;
}
