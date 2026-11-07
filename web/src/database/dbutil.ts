import { useQuery } from '@tanstack/react-query';
import { del, get, patch, post, put, queryClient } from '../lib/api';
import type { Database, DbView, Filter, Prop, PropType, QueryResult, Row, ViewConfig, User } from '../lib/types';

export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
export const randomColor = () => COLORS[1 + Math.floor(Math.random() * (COLORS.length - 1))];
export const shortId = () => Math.random().toString(36).slice(2, 10);

export const TYPE_LABELS: Record<PropType, string> = {
  title: 'Title', text: 'Text', number: 'Number', select: 'Select', multi_select: 'Multi-select', status: 'Status',
  date: 'Date', person: 'Person', checkbox: 'Checkbox', url: 'URL', email: 'Email', phone: 'Phone', files: 'Files & media',
  relation: 'Relation', rollup: 'Rollup', formula: 'Formula', created_time: 'Created time', created_by: 'Created by',
  last_edited_time: 'Last edited time', last_edited_by: 'Last edited by', unique_id: 'ID', ai: 'AI autofill',
  place: 'Place', verification: 'Verification', button: 'Button',
};
export const CREATABLE_TYPES: PropType[] = [
  'text', 'number', 'select', 'multi_select', 'status', 'date', 'person', 'files', 'checkbox', 'url', 'email', 'phone',
  'formula', 'relation', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'ai',
  'place', 'verification', 'button',
];
export const READONLY_TYPES: PropType[] = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'ai', 'button'];

export const NUMBER_FORMATS: [string, string][] = [
  ['number', 'Number'], ['number_with_commas', 'Number with commas'], ['percent', 'Percent'], ['dollar', 'US dollar'],
  ['euro', 'Euro'], ['pound', 'Pound'], ['rand', 'Rand'], ['yen', 'Yen'], ['rupee', 'Rupee'],
];

export function formatNumber(v: any, fmt = 'number') {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  const cur: Record<string, string> = { dollar: 'USD', euro: 'EUR', pound: 'GBP', rand: 'ZAR', yen: 'JPY', rupee: 'INR' };
  if (cur[fmt]) return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur[fmt] }).format(n);
  if (fmt === 'percent') return `${n}%`;
  if (fmt === 'number_with_commas') return n.toLocaleString();
  return String(n);
}

export function parseDate(s: string | null | undefined) {
  if (!s) return null;
  const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function fmtDate(s: string | null | undefined, withTime = false) {
  const d = parseDate(s);
  if (!d) return '';
  const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return withTime || (s && s.length > 10) ? `${date} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : date;
}
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Props in display order for a view, with visibility + width. */
export function viewProps(schema: Prop[], view: DbView): { prop: Prop; visible: boolean; width: number }[] {
  const cfg = view.config.properties ?? [];
  const defaultVisible = (p: Prop) =>
    p.type === 'title' || view.type === 'table' || (view.type === 'board' && false) || (view.type === 'timeline' && false);
  const seen = new Set<string>();
  const out: { prop: Prop; visible: boolean; width: number }[] = [];
  for (const c of cfg) {
    const p = schema.find((x) => x.id === c.id);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ prop: p, visible: p.type === 'title' ? true : c.visible, width: c.width ?? (p.type === 'title' ? 280 : 180) });
  }
  for (const p of schema) {
    if (seen.has(p.id)) continue;
    out.push({ prop: p, visible: defaultVisible(p), width: p.type === 'title' ? 280 : 180 });
  }
  // title first for non-table views
  if (view.type !== 'table') out.sort((a, b) => (a.prop.type === 'title' ? -1 : b.prop.type === 'title' ? 1 : 0));
  return out;
}

export function propsConfig(list: { prop: Prop; visible: boolean; width: number }[]) {
  return list.map((x) => ({ id: x.prop.id, visible: x.visible, width: x.width }));
}

// ---------- data hooks & mutations ----------

/** Database meta + views. With blockId, returns the views of that linked-database block. */
export function useDbMeta(dbId: string, blockId?: string | null) {
  return useQuery({
    queryKey: blockId ? ['db', dbId, 'block', blockId] : ['db', dbId],
    queryFn: () => get<Database>(`/databases/${dbId}${blockId ? `?blockId=${encodeURIComponent(blockId)}` : ''}`),
    enabled: !!dbId,
  });
}

export function useDbQuery(dbId: string, view: DbView | undefined, search: string, filterOverride?: any) {
  const filter = filterOverride !== undefined ? filterOverride : view?.config.filter;
  return useQuery({
    queryKey: ['dbq', dbId, view?.id, JSON.stringify(filter ?? null), JSON.stringify(view?.config.sorts ?? null), search],
    queryFn: () =>
      post<QueryResult>(`/databases/${dbId}/query`, {
        filter: filter ?? undefined,
        sorts: view?.config.sorts ?? undefined,
        search: search || undefined,
      }),
    enabled: !!view,
    placeholderData: (prev) => prev,
  });
}

function patchCachedRows(dbId: string, rowId: string, fn: (r: Row) => Row) {
  queryClient.setQueriesData<QueryResult>({ queryKey: ['dbq', dbId] }, (old) =>
    old ? { ...old, rows: old.rows.map((r) => (r.id === rowId ? fn(r) : r)) } : old,
  );
}

export async function setRowValue(dbId: string, rowId: string, prop: Prop, value: any) {
  if (prop.type === 'title') {
    patchCachedRows(dbId, rowId, (r) => ({ ...r, title: value }));
    await patch(`/pages/${rowId}`, { title: value });
  } else {
    patchCachedRows(dbId, rowId, (r) => ({ ...r, props: { ...r.props, [prop.id]: value } }));
    await patch(`/pages/${rowId}`, { props: { [prop.id]: value } });
  }
  queryClient.invalidateQueries({ queryKey: ['page', rowId] });
}

export async function createRow(dbId: string, body: { title?: string; props?: Record<string, any>; templateId?: string; position?: number; isTemplate?: boolean; useDefaultTemplate?: boolean } = {}) {
  const r = await post(`/databases/${dbId}/rows`, body);
  queryClient.invalidateQueries({ queryKey: ['dbq', dbId] });
  queryClient.invalidateQueries({ queryKey: ['db', dbId] });
  return r;
}

export async function updateView(dbId: string, viewId: string, body: { name?: string; type?: string; config?: Partial<ViewConfig> }) {
  queryClient.setQueriesData<Database>({ queryKey: ['db', dbId] }, (old) =>
    old?.views ? { ...old, views: old.views.map((v) => (v.id === viewId ? { ...v, ...(body as any), config: { ...v.config, ...(body.config ?? {}) } } : v)) } : old,
  );
  await patch(`/views/${viewId}`, body);
  queryClient.invalidateQueries({ queryKey: ['db', dbId] });
}

export async function addProperty(dbId: string, body: Partial<Prop> & { twoWay?: boolean }) {
  const p = await post<Prop>(`/databases/${dbId}/properties`, body);
  await refreshDb(dbId);
  return p;
}
export async function updateProperty(dbId: string, propId: string, body: Partial<Prop>) {
  queryClient.setQueriesData<Database>({ queryKey: ['db', dbId] }, (old) =>
    old?.schema ? { ...old, schema: old.schema.map((p) => (p.id === propId ? { ...p, ...body } : p)) } : old,
  );
  const p = await patch<Prop>(`/databases/${dbId}/properties/${propId}`, body);
  await refreshDb(dbId);
  return p;
}
export async function deleteProperty(dbId: string, propId: string) {
  await del(`/databases/${dbId}/properties/${propId}`);
  await refreshDb(dbId);
}
export async function refreshDb(dbId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['db', dbId] }),
    queryClient.invalidateQueries({ queryKey: ['dbq', dbId] }),
  ]);
  queryClient.invalidateQueries({ queryKey: ['page'] });
}
export { put, del, post, patch };

// ---------- values ----------

export function rowValue(row: Row, prop: Prop): any {
  switch (prop.type) {
    case 'title': return row.title;
    case 'created_time': return row.created_at;
    case 'last_edited_time': return row.updated_at;
    case 'created_by': return row.created_by ? [row.created_by] : [];
    case 'last_edited_by': return row.updated_by ? [row.updated_by] : [];
    case 'unique_id': return row.props.__uid ?? null;
    case 'formula':
    case 'rollup': return row.computed?.[prop.id] ?? null;
    default: return row.props[prop.id] ?? null;
  }
}

export function isEmptyValue(v: any) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && 'error' in v);
}

/** Text rendering of a value (for calendar labels, copy, sorting fallbacks). */
export function valueText(prop: Prop, v: any, users: Map<string, User>, titles: Record<string, string>): string {
  if (isEmptyValue(v)) return '';
  switch (prop.type) {
    case 'select':
    case 'status': return prop.options?.find((o) => o.id === v)?.name ?? '';
    case 'multi_select': return (v as string[]).map((id) => prop.options?.find((o) => o.id === id)?.name).filter(Boolean).join(', ');
    case 'person': case 'created_by': case 'last_edited_by': return (v as string[]).map((id) => users.get(id)?.name ?? '').join(', ');
    case 'relation': return (v as string[]).map((id) => titles[id] || 'Untitled').join(', ');
    case 'date': return fmtDate(v.start) + (v.end ? ` → ${fmtDate(v.end)}` : '');
    case 'created_time': case 'last_edited_time': return fmtDate(v, true);
    case 'number': return formatNumber(v, prop.number_format);
    case 'checkbox': return v ? 'Checked' : '';
    case 'files': return (v as any[]).map((f) => f.name).join(', ');
    case 'unique_id': return `${prop.id_prefix ? prop.id_prefix + '-' : ''}${v}`;
    case 'place': return v.name ?? v.address ?? `${v.lat}, ${v.lng}`;
    case 'verification': { const s = verificationState(v); return s ? s[0].toUpperCase() + s.slice(1) : ''; }
    case 'button': return '';
    default: return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

// ---------- grouping ----------

export interface Group { key: string; label: string; color?: string; rows: Row[]; userId?: string }

export const GROUPABLE: PropType[] = ['select', 'status', 'multi_select', 'person', 'checkbox', 'text', 'url', 'email', 'phone', 'number', 'created_by', 'last_edited_by', 'date'];

export function groupRows(rows: Row[], prop: Prop, users: Map<string, User>): Group[] {
  const groups = new Map<string, Group>();
  const ensure = (key: string, label: string, extra: Partial<Group> = {}) => {
    if (!groups.has(key)) groups.set(key, { key, label, rows: [], ...extra });
    return groups.get(key)!;
  };
  const NONE = '__none';
  if (['select', 'status', 'multi_select'].includes(prop.type)) {
    ensure(NONE, `No ${prop.name}`);
    for (const o of prop.options ?? []) ensure(o.id, o.name, { color: o.color });
  }
  if (prop.type === 'checkbox') { ensure('true', 'Checked'); ensure('false', 'Unchecked'); }
  for (const r of rows) {
    const v = rowValue(r, prop);
    if (prop.type === 'checkbox') { groups.get(v ? 'true' : 'false')!.rows.push(r); continue; }
    if (Array.isArray(v)) {
      if (!v.length) { ensure(NONE, `No ${prop.name}`).rows.push(r); continue; }
      for (const id of v) {
        const g = prop.type === 'multi_select'
          ? groups.get(id) ?? ensure(id, id)
          : ensure(id, users.get(id)?.name ?? 'Unknown', { userId: id });
        g.rows.push(r);
      }
      continue;
    }
    if (isEmptyValue(v)) { ensure(NONE, `No ${prop.name}`).rows.push(r); continue; }
    if (prop.type === 'select' || prop.type === 'status') { (groups.get(v) ?? ensure(v, v)).rows.push(r); continue; }
    if (prop.type === 'date') { const k = v.start?.slice(0, 7) ?? NONE; ensure(k, parseDate(v.start)?.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) ?? k).rows.push(r); continue; }
    ensure(String(v), String(v)).rows.push(r);
  }
  const list = [...groups.values()];
  // "No X" group last for non-option types, first for option types (Notion puts it first)
  return list;
}

/** Value to assign when a row is dropped into / created in a group. */
export function groupValue(prop: Prop, key: string, current: any): any {
  if (key === '__none') return prop.type === 'multi_select' || prop.type === 'person' ? [] : prop.type === 'checkbox' ? false : null;
  switch (prop.type) {
    case 'checkbox': return key === 'true';
    case 'multi_select': return [key];
    case 'person': return [key];
    case 'number': return Number(key);
    default: return key;
  }
  void current;
}

export const canGroupWrite = (p: Prop) => !READONLY_TYPES.includes(p.type) && p.type !== 'date' && p.type !== 'title';

// ---------- filter operators ----------

export function operatorsFor(t: PropType): [string, string][] {
  const empty: [string, string][] = [['is_empty', 'Is empty'], ['is_not_empty', 'Is not empty']];
  switch (t) {
    case 'number': case 'unique_id':
      return [['=', '='], ['!=', '≠'], ['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ...empty];
    case 'checkbox': return [['is', 'Is']];
    case 'select': return [['is', 'Is'], ['is_not', 'Is not'], ...empty];
    case 'status': return [['is', 'Is'], ['is_not', 'Is not'], ['group', 'Is in group'], ...empty];
    case 'multi_select': case 'person': case 'relation': case 'created_by': case 'last_edited_by':
      return [['contains', 'Contains'], ['does_not_contain', 'Does not contain'], ...empty];
    case 'date': case 'created_time': case 'last_edited_time':
      return [['is', 'Is'], ['before', 'Is before'], ['after', 'Is after'], ['on_or_before', 'Is on or before'], ['on_or_after', 'Is on or after'],
        ['within', 'Is within'], ['this_week', 'Is this week'], ['this_month', 'Is this month'], ['this_year', 'Is this year'],
        ['past_week', 'Is within past week'], ['next_week', 'Is within next week'], ['past_month', 'Is within past month'], ['next_month', 'Is within next month'],
        ['past_year', 'Is within past year'], ['next_year', 'Is within next year'], ...empty];
    default:
      return [['contains', 'Contains'], ['does_not_contain', 'Does not contain'], ['is', 'Is'], ['is_not', 'Is not'], ['starts_with', 'Starts with'], ['ends_with', 'Ends with'], ...empty];
  }
}

export const NO_VALUE_OPS = ['is_empty', 'is_not_empty', 'past_week', 'next_week', 'past_month', 'next_month', 'past_year', 'next_year', 'this_week', 'this_month', 'this_year'];

/** Relative date range used by the "Is within" filter: past/next N days|weeks|months|years, or this week|month|year. */
export interface RelativeValue { direction: 'past' | 'next' | 'this'; count?: number; unit: 'day' | 'week' | 'month' | 'year' }
export const DEFAULT_RELATIVE: RelativeValue = { direction: 'past', count: 30, unit: 'day' };
export function relativeLabel(v: RelativeValue | undefined) {
  if (!v) return '';
  if (v.direction === 'this') return `this ${v.unit}`;
  const n = v.count ?? 1;
  return `${v.direction} ${n} ${v.unit}${n === 1 ? '' : 's'}`;
}

export function defaultFilter(p: Prop): Filter {
  const op = operatorsFor(p.type)[0][0];
  return { prop: p.id, op, value: p.type === 'checkbox' ? true : undefined };
}

// ---------- calculations ----------

export const CALCS: [string, string][] = [
  ['none', 'None'], ['count', 'Count all'], ['count_values', 'Count values'], ['count_empty', 'Count empty'], ['count_not_empty', 'Count not empty'],
  ['unique', 'Count unique'], ['percent_empty', 'Percent empty'], ['percent_not_empty', 'Percent not empty'],
  ['sum', 'Sum'], ['average', 'Average'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max'], ['range', 'Range'],
  ['checked', 'Checked'], ['unchecked', 'Unchecked'], ['percent_checked', 'Percent checked'],
];
export function calcsFor(t: PropType) {
  const numeric = ['number', 'formula', 'rollup', 'unique_id'].includes(t);
  return CALCS.filter(([k]) => {
    if (['sum', 'average', 'median', 'min', 'max', 'range'].includes(k)) return numeric;
    if (['checked', 'unchecked', 'percent_checked'].includes(k)) return t === 'checkbox';
    return true;
  });
}
export function calculate(fn: string, prop: Prop, rows: Row[]): string {
  const vals = rows.map((r) => rowValue(r, prop));
  const filled = vals.filter((v) => !isEmptyValue(v) && !(prop.type === 'checkbox' && v === false));
  const nums = vals.map(Number).filter((n, i) => !isEmptyValue(vals[i]) && !Number.isNaN(n));
  const pct = (n: number) => `${rows.length ? Math.round((n / rows.length) * 1000) / 10 : 0}%`;
  const num = (n: number) => (prop.type === 'number' ? formatNumber(Math.round(n * 100) / 100, prop.number_format) : String(Math.round(n * 100) / 100));
  switch (fn) {
    case 'count': return String(rows.length);
    case 'count_values': return String(vals.flat().filter((v) => !isEmptyValue(v)).length);
    case 'count_empty': return String(rows.length - filled.length);
    case 'count_not_empty': return String(filled.length);
    case 'unique': return String(new Set(vals.flat().filter((v) => !isEmptyValue(v)).map((v) => JSON.stringify(v))).size);
    case 'percent_empty': return pct(rows.length - filled.length);
    case 'percent_not_empty': return pct(filled.length);
    case 'sum': return num(nums.reduce((a, b) => a + b, 0));
    case 'average': return nums.length ? num(nums.reduce((a, b) => a + b, 0) / nums.length) : '';
    case 'median': { if (!nums.length) return ''; const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return num(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
    case 'min': return nums.length ? num(Math.min(...nums)) : '';
    case 'max': return nums.length ? num(Math.max(...nums)) : '';
    case 'range': return nums.length ? num(Math.max(...nums) - Math.min(...nums)) : '';
    case 'checked': return String(vals.filter((v) => v === true).length);
    case 'unchecked': return String(vals.filter((v) => v !== true).length);
    case 'percent_checked': return pct(vals.filter((v) => v === true).length);
    default: return '';
  }
}
export const CALC_SHORT: Record<string, string> = {
  count: 'Count', count_values: 'Values', count_empty: 'Empty', count_not_empty: 'Not empty', unique: 'Unique',
  percent_empty: 'Empty', percent_not_empty: 'Not empty', sum: 'Sum', average: 'Average', median: 'Median', min: 'Min', max: 'Max',
  range: 'Range', checked: 'Checked', unchecked: 'Unchecked', percent_checked: 'Checked',
};

/** Effective verification state: a verified value past its `until` date reads as expired. */
export function verificationState(v: { state?: string; until?: string } | null | undefined): 'verified' | 'unverified' | 'expired' | null {
  if (!v || !v.state) return null;
  if (v.state === 'verified' && v.until && new Date(v.until).getTime() < Date.now()) return 'expired';
  return v.state as any;
}

/** All filters that must match: the view's own filter + any active quick filters. */
export function effectiveFilter(view: DbView, activeQuick: Filter[]): any {
  const base = view.config.filter && view.config.filter.filters?.length ? view.config.filter : null;
  if (!activeQuick.length) return base ?? undefined;
  return { op: 'and', filters: [...(base ? [base] : []), ...activeQuick] };
}
