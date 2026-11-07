/**
 * Notion-parity database extras: chart / form / dashboard / map views, quick filters,
 * place / verification / button properties, page verification. Shared by routes/databases.ts,
 * routes/dbviews.ts and the MCP tool layer.
 */
import { randomToken, fail } from './auth.js';

export const VIEW_TYPES_ALL = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'form', 'dashboard', 'map'] as const;
export type ViewType = (typeof VIEW_TYPES_ALL)[number];
export const isViewType = (t: unknown): t is ViewType => typeof t === 'string' && (VIEW_TYPES_ALL as readonly string[]).includes(t);

const CHART_KINDS = ['bar', 'column', 'line', 'area', 'donut', 'number'] as const;
const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max', 'median'] as const;
const CHART_SORTS = ['x-asc', 'x-desc', 'value-asc', 'value-desc'] as const;
const BUCKETS = ['day', 'week', 'month', 'year'] as const;
const WIDGET_KINDS = ['chart', 'number', 'table', 'list', 'board'] as const;

export interface ChartConfig {
  kind: (typeof CHART_KINDS)[number];
  xProp?: string;
  groupProp?: string;
  aggregate: { fn: (typeof AGG_FNS)[number]; prop?: string };
  sort?: (typeof CHART_SORTS)[number];
  cumulative?: boolean;
  hideEmpty?: boolean;
  showLegend?: boolean;
  /** Date x axes: bucket size (default month). */
  bucket?: (typeof BUCKETS)[number];
}

const oneOf = <T extends readonly string[]>(list: T, v: unknown, d: T[number]): T[number] => (list.includes(v as string) ? (v as T[number]) : d);
const str = (v: unknown, max = 500) => (v == null ? undefined : String(v).slice(0, max));
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function cleanChart(c: any): ChartConfig {
  c = c ?? {};
  const out: ChartConfig = {
    kind: oneOf(CHART_KINDS, c.kind, 'column'),
    aggregate: { fn: oneOf(AGG_FNS, c.aggregate?.fn, 'count') },
  };
  if (c.aggregate?.prop && out.aggregate.fn !== 'count') out.aggregate.prop = String(c.aggregate.prop);
  if (c.xProp) out.xProp = String(c.xProp);
  if (c.groupProp) out.groupProp = String(c.groupProp);
  if (c.sort) out.sort = oneOf(CHART_SORTS, c.sort, 'x-asc');
  if (c.bucket) out.bucket = oneOf(BUCKETS, c.bucket, 'month');
  for (const k of ['cumulative', 'hideEmpty', 'showLegend'] as const) if (c[k] !== undefined) out[k] = !!c[k];
  return out;
}

export function cleanForm(f: any, prev?: any) {
  f = f ?? {};
  const questions = (Array.isArray(f.questions) ? f.questions : [])
    .filter((x: any) => x && x.propId)
    .slice(0, 100)
    .map((x: any) => ({
      propId: String(x.propId),
      ...(x.label ? { label: str(x.label, 300) } : {}),
      ...(x.description ? { description: str(x.description, 1000) } : {}),
      ...(x.required ? { required: true } : {}),
    }));
  const access = f.access === 'link' ? 'link' : 'members';
  return {
    ...(f.title != null ? { title: str(f.title, 300) } : {}),
    ...(f.description != null ? { description: str(f.description, 4000) } : {}),
    questions,
    ...(f.submitLabel ? { submitLabel: str(f.submitLabel, 60) } : {}),
    access,
    ...(f.thankYou != null ? { thankYou: str(f.thankYou, 2000) } : {}),
    // Public forms get an unguessable slug (kept stable once created; rotate by sending slug: null).
    ...(access === 'link' ? { slug: f.slug === null ? randomToken(12) : prev?.slug || (typeof f.slug === 'string' && /^[\w-]{10,40}$/.test(f.slug) ? f.slug : randomToken(12)) } : {}),
  };
}

export function cleanDashboard(d: any) {
  const widgets = (Array.isArray(d?.widgets) ? d.widgets : []).slice(0, 40).map((w: any, i: number) => ({
    id: w?.id ? String(w.id).slice(0, 40) : randomToken(6),
    ...(w?.title ? { title: str(w.title, 200) } : {}),
    kind: oneOf(WIDGET_KINDS, w?.kind, 'chart'),
    viewConfig: w?.viewConfig && typeof w.viewConfig === 'object' ? cleanWidgetConfig(w.viewConfig) : {},
    x: Math.max(0, Math.min(11, Math.round(num(w?.x, 0)))),
    y: Math.max(0, Math.min(200, Math.round(num(w?.y, i * 4)))),
    w: Math.max(1, Math.min(12, Math.round(num(w?.w, 6)))),
    h: Math.max(2, Math.min(24, Math.round(num(w?.h, 4)))),
  }));
  return { widgets };
}

function cleanWidgetConfig(c: any) {
  const out: any = {};
  if (c.filter && typeof c.filter === 'object') out.filter = c.filter;
  if (Array.isArray(c.sorts)) out.sorts = c.sorts.slice(0, 10);
  if (c.groupBy !== undefined) out.groupBy = c.groupBy ? String(c.groupBy) : null;
  if (Array.isArray(c.properties)) out.properties = c.properties.slice(0, 200);
  if (c.chart) out.chart = cleanChart(c.chart);
  if (c.limit) out.limit = Math.max(1, Math.min(200, Math.round(num(c.limit, 10))));
  return out;
}

/**
 * Sanitise a view config for a view type. Unknown keys of the classic views pass through
 * (their existing behaviour); the new typed blocks are validated.
 */
export function cleanViewConfig(type: string, config: any, prev?: any) {
  const c = { ...(config ?? {}) };
  if ('chart' in c || type === 'chart') c.chart = cleanChart(c.chart ?? prev?.chart);
  if ('form' in c || type === 'form') c.form = cleanForm(c.form ?? prev?.form, prev?.form);
  if ('dashboard' in c || type === 'dashboard') c.dashboard = cleanDashboard(c.dashboard ?? prev?.dashboard);
  if ('map' in c || type === 'map') c.map = { placeProp: c.map?.placeProp ? String(c.map.placeProp) : prev?.map?.placeProp ?? '' };
  if ('quickFilters' in c) {
    c.quickFilters = (Array.isArray(c.quickFilters) ? c.quickFilters : [])
      .filter((f: any) => f && f.prop && f.op)
      .slice(0, 20)
      .map((f: any) => ({ prop: String(f.prop), op: String(f.op), ...(f.value !== undefined ? { value: f.value } : {}) }));
  }
  return c;
}

// ---------- property values ----------

export interface PlaceValue { lat: number; lng: number; name?: string; address?: string }
export interface VerificationValue { state: 'verified' | 'unverified' | 'expired'; by?: string; at?: string; until?: string }

export function cleanPlace(v: any, propName = 'Place'): PlaceValue | null {
  if (v == null || v === '') return null;
  const lat = Number(v.lat ?? v.latitude), lng = Number(v.lng ?? v.lon ?? v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    fail(400, `"${propName}" needs a latitude between -90 and 90 and a longitude between -180 and 180`);
  }
  return {
    lat, lng,
    ...(v.name ? { name: String(v.name).slice(0, 300) } : {}),
    ...(v.address ? { address: String(v.address).slice(0, 500) } : {}),
  };
}

const isoOrUndef = (s: unknown) => {
  if (s == null || s === '') return undefined;
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

export function cleanVerification(v: any, propName = 'Verification'): VerificationValue | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') v = { state: v };
  const state = String(v.state ?? '').toLowerCase();
  if (!['verified', 'unverified', 'expired'].includes(state)) fail(400, `"${propName}" state must be verified, unverified or expired`);
  return {
    state: state as VerificationValue['state'],
    ...(v.by ? { by: String(v.by) } : {}),
    ...(isoOrUndef(v.at) ? { at: isoOrUndef(v.at) } : {}),
    ...(isoOrUndef(v.until) ? { until: isoOrUndef(v.until) } : {}),
  };
}

/** Effective state: a verified value whose `until` has passed reads as expired. */
export function verificationState(v: VerificationValue | null | undefined, now = new Date()): VerificationValue['state'] | null {
  if (!v) return null;
  if (v.state === 'verified' && v.until && new Date(v.until).getTime() < now.getTime()) return 'expired';
  return v.state;
}

export type ButtonAction =
  | { type: 'insert'; markdown?: string; blocks: any[] }
  | { type: 'addRow'; databaseId: string; title?: string; props: Record<string, any> }
  | { type: 'open'; target: string }
  | { type: 'setProps'; props: Record<string, any> };

export function cleanButton(b: any) {
  const actions: ButtonAction[] = [];
  for (const a of Array.isArray(b?.actions) ? b.actions.slice(0, 20) : []) {
    if (a?.type === 'insert') actions.push({ type: 'insert', ...(a.markdown ? { markdown: String(a.markdown).slice(0, 20000) } : {}), blocks: Array.isArray(a.blocks) ? a.blocks : [] });
    else if (a?.type === 'addRow' && a.databaseId) actions.push({ type: 'addRow', databaseId: String(a.databaseId), ...(a.title ? { title: String(a.title).slice(0, 500) } : {}), props: a.props && typeof a.props === 'object' ? a.props : {} });
    else if (a?.type === 'open' && a.target) actions.push({ type: 'open', target: String(a.target).slice(0, 2000) });
    else if (a?.type === 'setProps' && a.props && typeof a.props === 'object') actions.push({ type: 'setProps', props: a.props });
  }
  return { label: String(b?.label ?? 'Button').slice(0, 100) || 'Button', actions };
}

/** Resolve button placeholder values ("@me", "@today", "@now") at click time. */
export function resolveButtonProps(props: Record<string, any>, meId: string, now = new Date()) {
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === '@today') out[k] = { start: ymd };
    else if (v === '@now') out[k] = { start: now.toISOString() };
    else if (v === '@me') out[k] = [meId];
    else if (Array.isArray(v)) out[k] = v.map((x) => (x === '@me' ? meId : x));
    else out[k] = v;
  }
  return out;
}

// ---------- aggregation (charts, number widgets) ----------

interface AggProp { id: string; name: string; type: string; options?: { id: string; name: string; color: string }[]; ai?: any }
interface AggRow { id: string; title: string; props: Record<string, any>; computed?: Record<string, any>; created_at: string; updated_at: string; created_by: string | null; updated_by: string | null }

export interface Series { key: string; label: string; color?: string }
export interface Point { key: string; label: string; color?: string; values: Record<string, number>; total: number }
export interface AggResult { kind: ChartConfig['kind']; series: Series[]; points: Point[]; total: number; rows: number; fn: string; prop?: string }

const NONE = '__none';
const DATE_TYPES = ['date', 'created_time', 'last_edited_time'];
const NUMERIC_TYPES = ['number', 'formula', 'rollup', 'unique_id'];

function valueOf(row: AggRow, p: AggProp): any {
  switch (p.type) {
    case 'title': return row.title;
    case 'created_time': return row.created_at;
    case 'last_edited_time': return row.updated_at;
    case 'created_by': return row.created_by ? [row.created_by] : [];
    case 'last_edited_by': return row.updated_by ? [row.updated_by] : [];
    case 'unique_id': return row.props?.__uid ?? null;
    case 'formula': case 'rollup': return row.computed?.[p.id] ?? null;
    default: return row.props?.[p.id] ?? null;
  }
}

function startOfBucket(d: Date, bucket: NonNullable<ChartConfig['bucket']>) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (bucket === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  if (bucket === 'month') x.setDate(1);
  if (bucket === 'year') { x.setMonth(0); x.setDate(1); }
  return x;
}
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function bucketLabel(d: Date, bucket: NonNullable<ChartConfig['bucket']>) {
  if (bucket === 'year') return String(d.getFullYear());
  if (bucket === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  if (bucket === 'week') return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Category keys (with label/color/order) a row falls into for a property. Multi-valued props yield several. */
function keysFor(row: AggRow, p: AggProp, users: Map<string, string>, bucket: NonNullable<ChartConfig['bucket']>): { key: string; label: string; color?: string; order: number | string }[] {
  const v = valueOf(row, p);
  const empty = v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && 'error' in v);
  if (p.type === 'checkbox') return v ? [{ key: 'true', label: 'Checked', order: 0 }] : [{ key: 'false', label: 'Unchecked', order: 1 }];
  if (empty) return [{ key: NONE, label: `No ${p.name}`, order: Number.MAX_SAFE_INTEGER }];
  if (['select', 'status'].includes(p.type) || (p.type === 'ai' && p.ai?.outputType === 'select')) {
    const i = p.options?.findIndex((o) => o.id === v) ?? -1;
    const o = i >= 0 ? p.options![i] : null;
    return [{ key: String(v), label: o?.name ?? String(v), color: o?.color, order: i >= 0 ? i : 9999 }];
  }
  if (p.type === 'multi_select' || (p.type === 'ai' && p.ai?.outputType === 'multi_select')) {
    return (v as string[]).map((id) => {
      const i = p.options?.findIndex((o) => o.id === id) ?? -1;
      return { key: id, label: i >= 0 ? p.options![i].name : id, color: i >= 0 ? p.options![i].color : undefined, order: i >= 0 ? i : 9999 };
    });
  }
  if (['person', 'created_by', 'last_edited_by'].includes(p.type)) {
    return (v as string[]).map((id) => ({ key: id, label: users.get(id) ?? 'Unknown', order: (users.get(id) ?? '~').toLowerCase() }));
  }
  if (DATE_TYPES.includes(p.type)) {
    const raw = p.type === 'date' ? v?.start : v;
    const d = raw ? new Date(String(raw).length === 10 ? `${raw}T00:00:00` : raw) : null;
    if (!d || Number.isNaN(d.getTime())) return [{ key: NONE, label: `No ${p.name}`, order: Number.MAX_SAFE_INTEGER }];
    const b = startOfBucket(d, bucket);
    return [{ key: ymdOf(b), label: bucketLabel(b, bucket), order: b.getTime() }];
  }
  if (p.type === 'place') return [{ key: String(v.name ?? `${v.lat},${v.lng}`), label: String(v.name ?? `${v.lat}, ${v.lng}`), order: String(v.name ?? '').toLowerCase() }];
  if (p.type === 'verification') {
    const s = verificationState(v) ?? 'unverified';
    return [{ key: s, label: s[0].toUpperCase() + s.slice(1), order: ['verified', 'expired', 'unverified'].indexOf(s) }];
  }
  if (Array.isArray(v)) return v.map((x) => ({ key: String(x), label: String(x), order: String(x).toLowerCase() }));
  if (typeof v === 'number') return [{ key: String(v), label: String(v), order: v }];
  return [{ key: String(v), label: String(v), order: String(v).toLowerCase() }];
}

function reduce(fn: string, nums: number[], count: number): number {
  if (fn === 'count') return count;
  if (!nums.length) return 0;
  switch (fn) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'median': {
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
  }
  return 0;
}

function numberOf(row: AggRow, p: AggProp | undefined): number | null {
  if (!p) return null;
  let v = valueOf(row, p);
  if (v && typeof v === 'object' && !Array.isArray(v)) v = 'error' in v ? null : v.start ?? null;
  if (Array.isArray(v)) v = v.length ? v[0] : null;
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Aggregate rows into chart points (x categories) × series (groups). */
export function aggregate(rows: AggRow[], schema: AggProp[], cfg: ChartConfig, users: Map<string, string>): AggResult {
  const fn = cfg.aggregate?.fn ?? 'count';
  const valProp = cfg.aggregate?.prop ? schema.find((p) => p.id === cfg.aggregate.prop) : undefined;
  if (fn !== 'count' && valProp && !NUMERIC_TYPES.includes(valProp.type)) {
    // Non-numeric value props only support count.
  }
  const xProp = cfg.kind === 'number' ? undefined : cfg.xProp ? schema.find((p) => p.id === cfg.xProp) : undefined;
  const gProp = cfg.kind === 'number' || cfg.kind === 'donut' ? undefined : cfg.groupProp ? schema.find((p) => p.id === cfg.groupProp) : undefined;
  const bucket = cfg.bucket ?? 'month';

  const allNums = rows.map((r) => numberOf(r, valProp)).filter((n): n is number => n != null);
  const total = round(reduce(fn, allNums, rows.length));
  if (!xProp) {
    return { kind: cfg.kind, series: [{ key: 'value', label: valProp?.name ?? 'Count' }], points: [{ key: 'all', label: 'All', values: { value: total }, total }], total, rows: rows.length, fn, prop: valProp?.id };
  }

  type Cell = { nums: number[]; count: number };
  const xs = new Map<string, { label: string; color?: string; order: number | string; cells: Map<string, Cell>; all: Cell }>();
  const series = new Map<string, Series & { order: number | string }>();
  for (const r of rows) {
    const n = numberOf(r, valProp);
    const xKeys = keysFor(r, xProp, users, bucket);
    const gKeys = gProp ? keysFor(r, gProp, users, bucket) : [{ key: 'value', label: valProp?.name ?? 'Count', order: 0 }];
    for (const g of gKeys) if (!series.has(g.key)) series.set(g.key, { key: g.key, label: g.label, color: (g as any).color, order: g.order });
    for (const x of xKeys) {
      let e = xs.get(x.key);
      if (!e) xs.set(x.key, (e = { label: x.label, color: x.color, order: x.order, cells: new Map(), all: { nums: [], count: 0 } }));
      e.all.count++;
      if (n != null) e.all.nums.push(n);
      for (const g of gKeys) {
        let c = e.cells.get(g.key);
        if (!c) e.cells.set(g.key, (c = { nums: [], count: 0 }));
        c.count++;
        if (n != null) c.nums.push(n);
      }
    }
  }
  // Option-type axes list every option (Notion shows empty categories too), unless hidden.
  if (['select', 'status', 'multi_select'].includes(xProp.type)) {
    xProp.options?.forEach((o, i) => { if (!xs.has(o.id)) xs.set(o.id, { label: o.name, color: o.color, order: i, cells: new Map(), all: { nums: [], count: 0 } }); });
  }

  const seriesList = [...series.values()].sort((a, b) => cmp(a.order, b.order) || a.label.localeCompare(b.label));
  let points: Point[] = [...xs.entries()].map(([key, e]) => {
    const values: Record<string, number> = {};
    for (const s of seriesList) {
      const c = e.cells.get(s.key);
      values[s.key] = round(c ? reduce(fn, c.nums, c.count) : 0);
    }
    return { key, label: e.label, color: e.color, values, total: round(reduce(fn, e.all.nums, e.all.count)), order: e.order } as Point & { order: number | string };
  });
  if (cfg.hideEmpty) points = points.filter((p) => p.key !== NONE && p.total !== 0);
  const order = new Map([...xs.entries()].map(([k, e]) => [k, e.order]));
  const sort = cfg.sort ?? 'x-asc';
  points.sort((a, b) => {
    // "No value" always last on x sorts.
    if (sort.startsWith('x')) {
      const c = cmp(order.get(a.key)!, order.get(b.key)!);
      return sort === 'x-asc' ? c : -c;
    }
    return sort === 'value-asc' ? a.total - b.total : b.total - a.total;
  });
  if (cfg.cumulative) {
    const run: Record<string, number> = {};
    let runTotal = 0;
    for (const p of points) {
      for (const s of seriesList) { run[s.key] = round((run[s.key] ?? 0) + p.values[s.key]); p.values[s.key] = run[s.key]; }
      runTotal = round(runTotal + p.total);
      p.total = runTotal;
    }
  }
  return {
    kind: cfg.kind,
    series: seriesList.map(({ key, label, color }) => ({ key, label, ...(color ? { color } : {}) })),
    points: points.map(({ key, label, color, values, total }) => ({ key, label, ...(color ? { color } : {}), values, total })),
    total,
    rows: rows.length,
    fn,
    prop: valProp?.id,
  };
}

function cmp(a: number | string, b: number | string) {
  // The empty bucket ("No X") always sorts last.
  if (a === Number.MAX_SAFE_INTEGER || b === Number.MAX_SAFE_INTEGER) return a === b ? 0 : a === Number.MAX_SAFE_INTEGER ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Combine a view filter with quick filters / an extra filter (all must match). */
export function andFilters(...groups: any[]) {
  const parts = groups.filter((g) => g && ((g.filters && g.filters.length) || g.prop));
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0].prop ? { op: 'and', filters: parts } : parts[0];
  return { op: 'and', filters: parts.map((g) => (g.prop ? { op: 'and', filters: [g] } : g)) };
}
