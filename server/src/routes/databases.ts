import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { fail, requireUser, type AuthUser } from '../auth.js';
import { one, q } from '../db.js';
import { emit } from '../events.js';
import { assertPage, atLeast } from '../perms.js';
import { evaluateRowFormula, parseFormula, type FormulaContext } from '../formula.js';
import { PAGE_COLS } from '../pageOps.js';
import { cleanButton, cleanPlace, cleanVerification, cleanViewConfig, isViewType, verificationState } from '../dbviews.js';

export interface Prop {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string; group?: string }[];
  number_format?: string;
  relation?: { databaseId: string; syncedPropId?: string | null };
  rollup?: { relationPropId: string; targetPropId: string; fn: string };
  formula?: { expression: string };
  date_format?: string;
  id_prefix?: string;
  /** Shown as a tooltip in headers and in the property menu (Notion property descriptions). */
  description?: string;
  /** person properties: 'one' limits the value to a single person (Notion "Limit: 1 person"). */
  limit?: 'one' | 'many';
  /** Button property (type 'button'): label + actions run per row (server/src/routes/dbviews.ts). */
  button?: { label: string; actions: any[] };
  /** AI autofill property (type 'ai'); values are filled by server/src/ai/autofill.ts. */
  ai?: { instruction: string; kind: 'summary' | 'keywords' | 'translate' | 'custom'; language?: string; outputType: 'text' | 'select' | 'multi_select'; autoUpdate: boolean };
}

const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const shortId = () => randomUUID().slice(0, 8);
export const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

export function defaultStatusOptions() {
  return [
    { id: shortId(), name: 'Not started', color: 'default', group: 'todo' },
    { id: shortId(), name: 'In progress', color: 'blue', group: 'in_progress' },
    { id: shortId(), name: 'Done', color: 'green', group: 'complete' },
  ];
}

const STATUS_GROUP_ALIASES: Record<string, 'todo' | 'in_progress' | 'complete'> = {
  todo: 'todo', 'to-do': 'todo', 'to do': 'todo', to_do: 'todo', not_started: 'todo', 'not started': 'todo', backlog: 'todo',
  in_progress: 'in_progress', 'in progress': 'in_progress', 'in-progress': 'in_progress', doing: 'in_progress', started: 'in_progress',
  complete: 'complete', completed: 'complete', done: 'complete', closed: 'complete',
};
export function statusGroupKey(g: unknown): 'todo' | 'in_progress' | 'complete' | null {
  return g == null ? null : STATUS_GROUP_ALIASES[String(g).trim().toLowerCase()] ?? null;
}

/**
 * Status options keep the group they were given. Options without one get a positional default
 * (first → To-do, last → Complete, the rest → In progress) — never a guess from the option name.
 */
export function normalizeStatusOptions(options: any[] | undefined): { id: string; name: string; color: string; group: string }[] {
  const list = options ?? [];
  return list.map((o: any, i: number) => ({
    id: o.id ?? shortId(),
    name: String(o.name ?? ''),
    color: o.color ?? 'default',
    group: statusGroupKey(o.group) ?? (i === 0 ? 'todo' : i === list.length - 1 && list.length > 1 ? 'complete' : 'in_progress'),
  }));
}

/** Create the database record. When `views` are given they replace the default "Table" view (no extra view). */
export async function createDatabase(pageId: string, schema?: Prop[], views?: { name?: string; type?: string; config?: any }[]) {
  const s: Prop[] = schema ?? [
    { id: 'title', name: 'Name', type: 'title' },
    { id: shortId(), name: 'Tags', type: 'multi_select', options: [] },
  ];
  await q('insert into databases(page_id, schema) values ($1,$2) on conflict do nothing', [pageId, JSON.stringify(s)]);
  const list = (views ?? []).filter((v) => v && isViewType(v.type ?? 'table'));
  if (!list.length) {
    await q(`insert into database_views(database_id, name, type, config, position) values ($1,'Table','table','{}',0)`, [pageId]);
    return;
  }
  for (const [i, v] of list.entries()) {
    const type = v.type ?? 'table';
    await q('insert into database_views(database_id, name, type, config, position) values ($1,$2,$3,$4,$5)', [
      pageId, v.name || type[0].toUpperCase() + type.slice(1), type, cleanViewConfig(type, v.config ?? {}), i,
    ]);
  }
}

// ---------- row value normalisation (dates → ISO 8601, person limits) ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

/**
 * Normalise one date string to ISO 8601: 'YYYY-MM-DD' stays date-only; date-times become
 * 'YYYY-MM-DDTHH:mm:ss.sssZ'. Accepts Notion/raw forms like "2026-10-20 14:05:00Z", "2026-10-20 14:05",
 * "2026-10-20T14:05:00.000+02:00", "October 20, 2026". A date-time without an offset is kept as local
 * wall-clock time with seconds ("2026-10-20T14:05:00") — the editor's own format — rather than guessed as UTC.
 */
export function normalizeDateString(v: unknown): string | null {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  if (ISO_DATE.test(s)) return s;
  s = s.replace(/^(\d{4}-\d{2}-\d{2})[ _](\d{2}:\d{2})/, '$1T$2').replace(/\s*(Z|[+-]\d{2}:?\d{2})$/i, (m) => m.trim().toUpperCase());
  if (NAIVE_DATETIME.test(s)) return s.length === 16 ? `${s}:00` : s;
  if (ISO_DATETIME.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Free-form text without a time component → date-only.
  if (!/\d{1,2}:\d{2}/.test(s)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return d.toISOString();
}

export function normalizeDateValue(v: any): any {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const start = normalizeDateString(v);
    return start ? { start } : null;
  }
  if (typeof v !== 'object') return v;
  const start = normalizeDateString(v.start);
  if (!start) return null;
  const out: any = { ...v, start };
  if (v.end != null && v.end !== '') {
    const end = normalizeDateString(v.end);
    if (end) out.end = end;
    else delete out.end;
  } else delete out.end;
  return out;
}

/** Validate + normalise row property values against the schema before they are stored. */
export function normalizeRowProps(schema: Prop[], props: Record<string, any>): Record<string, any> {
  const out = { ...props };
  for (const p of schema) {
    if (!(p.id in out)) continue;
    const v = out[p.id];
    if (p.type === 'date') out[p.id] = normalizeDateValue(v);
    if (p.type === 'place') out[p.id] = cleanPlace(v, p.name);
    if (p.type === 'verification') out[p.id] = cleanVerification(v, p.name);
    if (p.type === 'button') delete out[p.id]; // buttons have no stored value
    if (p.type === 'person' && p.limit === 'one' && Array.isArray(v) && v.length > 1) {
      fail(400, `"${p.name}" is limited to one person`);
    }
  }
  return out;
}

export async function normalizeRowPropsFor(dbId: string, props: Record<string, any>) {
  return normalizeRowProps(await getSchema(dbId), props);
}

/** One-off, idempotent backfill: rewrite stored non-ISO date values. Safe to run on every boot. */
export async function backfillIsoDates() {
  const dbs = await q<{ page_id: string; schema: Prop[] }>('select page_id, schema from databases');
  let fixed = 0;
  for (const db of dbs) {
    const dateProps = (db.schema ?? []).filter((p) => p.type === 'date');
    if (!dateProps.length) continue;
    const rows = await q<{ id: string; props: any }>(`select id, props from pages where parent_id = $1 and kind = 'row'`, [db.page_id]);
    for (const r of rows) {
      const patch: Record<string, any> = {};
      for (const p of dateProps) {
        const v = r.props?.[p.id];
        if (v == null) continue;
        const n = normalizeDateValue(v);
        if (JSON.stringify(n) !== JSON.stringify(v)) patch[p.id] = n;
      }
      if (Object.keys(patch).length) {
        await q('update pages set props = props || $2 where id = $1', [r.id, patch]);
        fixed++;
      }
    }
  }
  return fixed;
}

export async function getSchema(dbId: string): Promise<Prop[]> {
  const r = await one('select schema from databases where page_id = $1', [dbId]);
  if (!r) fail(404, 'Database not found');
  return r.schema;
}
async function saveSchema(dbId: string, schema: Prop[]) {
  await q('update databases set schema = $2 where page_id = $1', [dbId, JSON.stringify(schema)]);
  emit({ type: 'db', id: dbId });
}

// ---------- computing values ----------

interface Row {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  props: Record<string, any>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  auto_id: number;
  position: number;
  is_template: boolean;
  [k: string]: any;
}

const userNames = new Map<string, string>();

/** Value of a property for filtering/sorting/formulas, with computed properties resolved. */
function rawValue(row: Row, p: Prop, ctx: Ctx): any {
  switch (p.type) {
    case 'title': return row.title;
    case 'created_time': return row.created_at;
    case 'last_edited_time': return row.updated_at;
    case 'created_by': return row.created_by ? [row.created_by] : [];
    case 'last_edited_by': return row.updated_by ? [row.updated_by] : [];
    case 'unique_id': return row.props.__uid ?? null;
    case 'formula': return ctx.computed.get(row.id)?.[p.id] ?? null;
    case 'rollup': return ctx.computed.get(row.id)?.[p.id] ?? null;
    default: return row.props[p.id] ?? null;
  }
}

function displayValue(row: Row, p: Prop, ctx: Ctx): any {
  const v = rawValue(row, p, ctx);
  if (v == null) return null;
  switch (p.type) {
    case 'select':
    case 'status': return p.options?.find((o) => o.id === v)?.name ?? null;
    case 'multi_select': return (v as string[]).map((id) => p.options?.find((o) => o.id === id)?.name).filter(Boolean);
    case 'person':
    case 'created_by':
    case 'last_edited_by': return (v as string[]).map((id) => userNames.get(id) ?? '');
    case 'date': return v?.start ?? null;
    case 'relation': return (v as string[]).map((id) => ctx.titles.get(id) ?? '');
    case 'files': return (v as any[]).map((f) => f.name);
    case 'place': return v?.name ?? v?.address ?? (v?.lat != null ? `${v.lat}, ${v.lng}` : null);
    case 'verification': return verificationState(v);
    case 'ai':
      if (p.ai?.outputType === 'select') return p.options?.find((o) => o.id === v)?.name ?? null;
      if (p.ai?.outputType === 'multi_select') return (Array.isArray(v) ? v : []).map((id: string) => p.options?.find((o) => o.id === id)?.name).filter(Boolean);
      return v;
    default: return v;
  }
}

interface Ctx {
  schema: Prop[];
  computed: Map<string, Record<string, any>>;
  titles: Map<string, string>;
}

async function computeDerived(rows: Row[], schema: Prop[]): Promise<Ctx> {
  const ctx: Ctx = { schema, computed: new Map(), titles: new Map() };
  if (!userNames.size || Math.random() < 0.05) {
    for (const u of await q('select id, name from users')) userNames.set(u.id, u.name);
  }
  // titles for relations + rollup targets
  const relProps = schema.filter((p) => p.type === 'relation');
  const relIds = new Set<string>();
  for (const r of rows) for (const p of relProps) for (const id of r.props[p.id] ?? []) relIds.add(id);
  const related = relIds.size
    ? await q<Row>(`select ${PAGE_COLS} from pages where id = any($1::uuid[]) and deleted_at is null`, [[...relIds]])
    : [];
  const relatedById = new Map(related.map((r) => [r.id, r]));
  for (const r of related) ctx.titles.set(r.id, r.title);
  const foreignSchemas = new Map<string, Prop[]>();
  for (const p of schema.filter((p) => p.type === 'rollup')) {
    const rel = schema.find((x) => x.id === p.rollup?.relationPropId);
    if (rel?.relation && !foreignSchemas.has(rel.relation.databaseId)) {
      foreignSchemas.set(rel.relation.databaseId, await getSchema(rel.relation.databaseId).catch(() => []));
    }
  }
  const formulas = schema.filter((p) => p.type === 'formula').map((p) => {
    try { return { p, ast: parseFormula(p.formula?.expression ?? '') , err: null as string | null }; }
    catch (e: any) { return { p, ast: null, err: e.message as string }; }
  });
  // Formula context: users (name/email), related rows and their databases' schemas.
  let fctxBase: FormulaContext | null = null;
  if (formulas.length) {
    const users = new Map<string, { id: string; name: string; email: string }>();
    for (const u of await q('select id, name, email from users')) users.set(u.id, u);
    const relSchemas = new Map<string, Prop[]>();
    for (const dbId of new Set(related.map((r) => r.parent_id).filter(Boolean))) {
      relSchemas.set(dbId, foreignSchemas.get(dbId) ?? (await getSchema(dbId).catch(() => [])));
    }
    fctxBase = {
      schema,
      users,
      getRow: (id) => relatedById.get(id),
      schemaForRow: (id) => relSchemas.get(relatedById.get(id)?.parent_id),
    };
  }
  for (const row of rows) {
    const out: Record<string, any> = {};
    ctx.computed.set(row.id, out);
    for (const p of schema.filter((x) => x.type === 'rollup')) {
      const rel = schema.find((x) => x.id === p.rollup?.relationPropId);
      if (!rel?.relation || !p.rollup) { out[p.id] = null; continue; }
      const fschema = foreignSchemas.get(rel.relation.databaseId) ?? [];
      const target = fschema.find((x) => x.id === p.rollup!.targetPropId) ?? { id: 'title', type: 'title', name: 'Name' };
      const fctx: Ctx = { schema: fschema, computed: new Map(), titles: ctx.titles };
      const vals = (row.props[rel.id] ?? [])
        .map((id: string) => relatedById.get(id))
        .filter(Boolean)
        .map((r: Row) => displayValue(r, target as Prop, fctx));
      const flat = vals.flat().filter((v: any) => v != null && v !== '');
      const nums = flat.map(Number).filter((n: number) => !Number.isNaN(n));
      switch (p.rollup.fn) {
        case 'count': out[p.id] = vals.length; break;
        case 'count_values': out[p.id] = flat.length; break;
        case 'unique': out[p.id] = new Set(flat.map(String)).size; break;
        case 'sum': out[p.id] = nums.reduce((a: number, b: number) => a + b, 0); break;
        case 'average': out[p.id] = nums.length ? nums.reduce((a: number, b: number) => a + b, 0) / nums.length : null; break;
        case 'min': out[p.id] = nums.length ? Math.min(...nums) : null; break;
        case 'max': out[p.id] = nums.length ? Math.max(...nums) : null; break;
        case 'percent_checked': out[p.id] = vals.length ? Math.round((vals.filter((v: any) => v === true).length / vals.length) * 100) : 0; break;
        case 'empty': out[p.id] = vals.filter((v: any) => v == null || v === '' || (Array.isArray(v) && !v.length)).length; break;
        default: out[p.id] = flat.map(String);
      }
    }
    for (const f of formulas) {
      if (!f.ast) { out[f.p.id] = { error: f.err }; continue; }
      out[f.p.id] = evaluateRowFormula(f.ast, { ...row, computed: out }, fctxBase!);
    }
  }
  return ctx;
}

// ---------- filters & sorts ----------

export interface Filter { prop: string; op: string; value?: any }
export interface FilterGroup { op: 'and' | 'or'; filters: (Filter | FilterGroup)[] }

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

let clock: () => Date = () => new Date();
/** TESTS ONLY: freeze "now" for relative date filters. Call with no argument to restore the real clock. */
export function __setClockForTests(fn?: () => Date) { clock = fn ?? (() => new Date()); }

type Unit = 'day' | 'week' | 'month' | 'year';
export interface RelativeRange { direction: 'past' | 'next' | 'this'; count?: number; unit: Unit }

const UNIT_ALIASES: Record<string, Unit> = { day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' };

/**
 * Parse a relative date value: an object {direction, count, unit} or text such as "past 30 days",
 * "next 2 weeks", "this month", "last 7 days", "today", "yesterday", "tomorrow".
 */
export function parseRelative(v: any): RelativeRange | 'today' | 'yesterday' | 'tomorrow' | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const unit = UNIT_ALIASES[String(v.unit ?? '').toLowerCase()];
    const dir = String(v.direction ?? '').toLowerCase();
    const direction = dir === 'last' ? 'past' : dir;
    if (!unit || !['past', 'next', 'this'].includes(direction)) return null;
    return { direction: direction as RelativeRange['direction'], unit, count: direction === 'this' ? 1 : Math.max(1, Math.floor(Number(v.count ?? 1)) || 1) };
  }
  const s = String(v).trim().toLowerCase().replace(/_/g, ' ');
  if (s === 'today' || s === 'yesterday' || s === 'tomorrow') return s;
  const m = s.match(/^(past|last|next|this)\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years)$/);
  if (!m) return null;
  const direction = m[1] === 'last' ? 'past' : (m[1] as RelativeRange['direction']);
  return { direction, unit: UNIT_ALIASES[m[3]], count: direction === 'this' ? 1 : Math.max(1, Number(m[2] ?? 1)) };
}

function addUnits(d: Date, unit: Unit, n: number) {
  const x = new Date(d);
  if (unit === 'day') x.setDate(x.getDate() + n);
  else if (unit === 'week') x.setDate(x.getDate() + 7 * n);
  else if (unit === 'month') x.setMonth(x.getMonth() + n);
  else x.setFullYear(x.getFullYear() + n);
  return x;
}

/** Inclusive [start, end] day range (start-of-day timestamps) for a relative value. Weeks start on Monday. */
export function relativeRange(rel: NonNullable<ReturnType<typeof parseRelative>>, now = clock()): [number, number] {
  const today = startOfDay(now);
  if (rel === 'today') return [today.getTime(), today.getTime()];
  if (rel === 'yesterday') { const y = addUnits(today, 'day', -1).getTime(); return [y, y]; }
  if (rel === 'tomorrow') { const t = addUnits(today, 'day', 1).getTime(); return [t, t]; }
  const n = rel.count ?? 1;
  if (rel.direction === 'past') return [addUnits(today, rel.unit, -n).getTime(), today.getTime()];
  if (rel.direction === 'next') return [today.getTime(), addUnits(today, rel.unit, n).getTime()];
  // this week/month/year: the calendar period containing today
  let start: Date;
  let end: Date;
  if (rel.unit === 'day') { start = today; end = today; }
  else if (rel.unit === 'week') {
    const dow = (today.getDay() + 6) % 7; // Monday = 0
    start = addUnits(today, 'day', -dow);
    end = addUnits(start, 'day', 6);
  } else if (rel.unit === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  } else {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear(), 11, 31);
  }
  return [start.getTime(), end.getTime()];
}

/** Legacy op names map onto relative ranges. */
const LEGACY_RELATIVE_OPS: Record<string, RelativeRange> = {
  past_week: { direction: 'past', count: 1, unit: 'week' },
  past_month: { direction: 'past', count: 1, unit: 'month' },
  past_year: { direction: 'past', count: 1, unit: 'year' },
  next_week: { direction: 'next', count: 1, unit: 'week' },
  next_month: { direction: 'next', count: 1, unit: 'month' },
  next_year: { direction: 'next', count: 1, unit: 'year' },
  this_week: { direction: 'this', unit: 'week' },
  this_month: { direction: 'this', unit: 'month' },
  this_year: { direction: 'this', unit: 'year' },
};

function matchFilter(row: Row, f: Filter, ctx: Ctx, user: AuthUser): boolean {
  const p = ctx.schema.find((x) => x.id === f.prop);
  if (!p) return true;
  let v = rawValue(row, p, ctx);
  if (v && typeof v === 'object' && 'error' in v) v = null;
  const isEmpty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
  if (f.op === 'is_empty') return isEmpty;
  if (f.op === 'is_not_empty') return !isEmpty;
  const fv = f.value;
  // Relative-date ops like past_week / this_month need no value; anything else without one is incomplete → no-op (like Notion).
  const valueless = !!LEGACY_RELATIVE_OPS[f.op] && ['date', 'created_time', 'last_edited_time'].includes(p.type);
  if (!valueless && (fv == null || fv === '' || (Array.isArray(fv) && !fv.length))) {
    if (p.type !== 'checkbox') return true;
  }
  switch (p.type) {
    case 'checkbox': return !!v === (fv === true || fv === 'true');
    case 'number':
    case 'unique_id': {
      const n = Number(v), m = Number(fv);
      if (isEmpty) return f.op === '!=';
      return { '=': n === m, '!=': n !== m, '>': n > m, '<': n < m, '>=': n >= m, '<=': n <= m }[f.op] ?? true;
    }
    case 'select':
    case 'status': {
      const vals = Array.isArray(fv) ? fv : [fv];
      if (f.op === 'is_not') return !vals.includes(v);
      if (f.op === 'group' && p.type === 'status') return vals.map((g) => statusGroupKey(g) ?? g).includes(p.options?.find((o) => o.id === v)?.group);
      return vals.includes(v);
    }
    case 'multi_select':
    case 'person':
    case 'relation':
    case 'created_by':
    case 'last_edited_by': {
      const arr: string[] = v ?? [];
      const want = (Array.isArray(fv) ? fv : [fv]).map((x: string) => (x === 'me' ? user.id : x));
      const has = want.some((w: string) => arr.includes(w));
      return f.op === 'does_not_contain' ? !has : has;
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time': {
      const raw = p.type === 'date' ? v?.start : v;
      if (!raw) return false;
      const d = startOfDay(new Date(raw)).getTime();
      const today = startOfDay(clock());
      // Relative ranges: legacy ops (past_week…), op "within"/"relative" with {direction,count,unit} or text like "past 30 days".
      const legacy = LEGACY_RELATIVE_OPS[f.op];
      if (legacy || f.op === 'within' || f.op === 'relative') {
        const rel = legacy ?? parseRelative(fv);
        if (!rel) return true; // incomplete filter = no-op
        const [a, b] = relativeRange(rel);
        return d >= a && d <= b;
      }
      const rel: Record<string, Date> = {
        today, tomorrow: new Date(today.getTime() + 864e5), yesterday: new Date(today.getTime() - 864e5),
        one_week_ago: new Date(today.getTime() - 7 * 864e5), one_week_from_now: new Date(today.getTime() + 7 * 864e5),
        one_month_ago: new Date(today.getTime() - 30 * 864e5), one_month_from_now: new Date(today.getTime() + 30 * 864e5),
      };
      // A relative value on a comparison op ("before" + "past 30 days" → before the start of that range).
      const relVal = typeof fv === 'object' || (typeof fv === 'string' && !rel[fv] && parseRelative(fv)) ? parseRelative(fv) : null;
      if (relVal) {
        const [a, b] = relativeRange(relVal);
        return ({ is: d >= a && d <= b, before: d < a, after: d > b, on_or_before: d <= b, on_or_after: d >= a } as Record<string, boolean>)[f.op] ?? true;
      }
      const target = (rel[fv] ?? startOfDay(new Date(fv))).getTime();
      return { is: d === target, before: d < target, after: d > target, on_or_before: d <= target, on_or_after: d >= target }[f.op as 'is'] ?? true;
    }
    default: {
      const s = (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)).toLowerCase();
      const t = String(fv).toLowerCase();
      switch (f.op) {
        case 'is': return s === t;
        case 'is_not': return s !== t;
        case 'does_not_contain': return !s.includes(t);
        case 'starts_with': return s.startsWith(t);
        case 'ends_with': return s.endsWith(t);
        default: return s.includes(t);
      }
    }
  }
}

function matchGroup(row: Row, g: FilterGroup, ctx: Ctx, user: AuthUser): boolean {
  if (!g?.filters?.length) return true;
  const res = g.filters.map((f) => ('filters' in f ? matchGroup(row, f, ctx, user) : matchFilter(row, f, ctx, user)));
  return g.op === 'or' ? res.some(Boolean) : res.every(Boolean);
}

function sortKey(row: Row, p: Prop, ctx: Ctx): any {
  const v = rawValue(row, p, ctx);
  if (v == null || v === '') return null;
  switch (p.type) {
    case 'select':
    case 'status': return p.options?.findIndex((o) => o.id === v) ?? 0;
    case 'multi_select': return p.options?.findIndex((o) => o.id === v[0]) ?? 0;
    case 'date': return v.start ? new Date(v.start).getTime() : null;
    case 'created_time':
    case 'last_edited_time': return new Date(v).getTime();
    case 'checkbox': return v ? 1 : 0;
    case 'number':
    case 'unique_id': return Number(v);
    case 'formula':
    case 'rollup': return typeof v === 'object' ? null : v;
    default: { const d = displayValue(row, p, ctx); return Array.isArray(d) ? d.join(', ').toLowerCase() : String(d).toLowerCase(); }
  }
}

export async function queryDatabase(
  user: AuthUser,
  dbId: string,
  opts: { filter?: FilterGroup; sorts?: { prop: string; dir: 'asc' | 'desc' }[]; search?: string; includeTemplates?: boolean },
) {
  const schema = await getSchema(dbId);
  const rows = await q<Row>(
    `select ${PAGE_COLS} from pages where parent_id = $1 and kind = 'row' and deleted_at is null and is_template = $2
     order by position, created_at`,
    [dbId, !!opts.includeTemplates],
  );
  const ctx = await computeDerived(rows, schema);
  let out = rows;
  if (opts.filter) out = out.filter((r) => matchGroup(r, opts.filter!, ctx, user));
  if (opts.search) {
    const s = opts.search.toLowerCase();
    out = out.filter((r) => r.title.toLowerCase().includes(s) || schema.some((p) => String(displayValue(r, p, ctx) ?? '').toLowerCase().includes(s)));
  }
  if (opts.sorts?.length) {
    out = [...out].sort((a, b) => {
      for (const s of opts.sorts!) {
        const p = schema.find((x) => x.id === s.prop);
        if (!p) continue;
        const x = sortKey(a, p, ctx), y = sortKey(b, p, ctx);
        if (x === y) continue;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = x < y ? -1 : 1;
        return s.dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }
  return {
    schema,
    rows: out.map((r) => ({
      id: r.id, title: r.title, icon: r.icon, cover: r.cover, props: r.props, position: r.position,
      created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by,
      computed: ctx.computed.get(r.id) ?? {},
    })),
    titles: Object.fromEntries(ctx.titles),
  };
}

/** Keep two-way relations in sync after a row's relation values change. */
export async function syncRelations(rowId: string, dbId: string, before: Record<string, any>, after: Record<string, any>) {
  const schema = await getSchema(dbId);
  for (const p of schema.filter((x) => x.type === 'relation' && x.relation?.syncedPropId)) {
    if (!(p.id in after)) continue;
    const prev = new Set<string>(before[p.id] ?? []);
    const next = new Set<string>(after[p.id] ?? []);
    const synced = p.relation!.syncedPropId!;
    for (const id of next) if (!prev.has(id)) {
      await q(`update pages set props = jsonb_set(props, $2, coalesce(props->$3, '[]'::jsonb) || to_jsonb($4::text)) where id = $1 and not coalesce(props->$3, '[]'::jsonb) ? $4`, [id, `{${synced}}`, synced, rowId]);
    }
    for (const id of prev) if (!next.has(id)) {
      await q(`update pages set props = jsonb_set(props, $2, coalesce(props->$3, '[]'::jsonb) - $4) where id = $1`, [id, `{${synced}}`, synced, rowId]);
    }
    if (p.relation!.databaseId !== dbId) emit({ type: 'db', id: p.relation!.databaseId });
  }
}

export default async function databaseRoutes(app: FastifyInstance) {
  // ?blockId=<editor block id> returns the views of a linked database block instead of the database's own views.
  app.get<{ Params: { id: string }; Querystring: { blockId?: string } }>('/databases/:id', async (req) => {
    const user = requireUser(req);
    const level = await assertPage(user, req.params.id, 'view');
    const page = await one(`select ${PAGE_COLS} from pages where id = $1 and kind = 'database'`, [req.params.id]);
    if (!page) fail(404, 'Database not found');
    const blockId = req.query.blockId || null;
    const viewsFor = () =>
      blockId
        ? q('select * from database_views where database_id = $1 and block_id = $2 order by position, name', [req.params.id, blockId])
        : q('select * from database_views where database_id = $1 and block_id is null order by position, name', [req.params.id]);
    let views = await viewsFor();
    if (blockId && !views.length) {
      if (atLeast(level, 'edit')) {
        // First render of a linked block: give it its own default table view.
        await q(
          `insert into database_views(database_id, name, type, config, position, block_id)
           select $1, 'Table', 'table', '{}', 0, $2
           where not exists (select 1 from database_views where database_id = $1 and block_id = $2)`,
          [req.params.id, blockId],
        );
        views = await viewsFor();
      } else {
        views = await q('select * from database_views where database_id = $1 and block_id is null order by position, name', [req.params.id]);
      }
    }
    const [schema, templates, meta] = await Promise.all([
      getSchema(req.params.id),
      q(`select id, title, icon from pages where parent_id = $1 and is_template and deleted_at is null order by created_at`, [req.params.id]),
      one<{ description: string | null; default_template_id: string | null }>('select description, default_template_id from databases where page_id = $1', [req.params.id]),
    ]);
    const defaultTemplateId = templates.some((t: any) => t.id === meta?.default_template_id) ? meta!.default_template_id : null;
    return { ...page, level, schema, views, templates, blockId, description: meta?.description ?? null, default_template_id: defaultTemplateId };
  });

  // Database-level settings: description (shown under the title) and the default template for new rows.
  app.patch<{ Params: { id: string }; Body: { description?: string | null; defaultTemplateId?: string | null } }>('/databases/:id', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const b = req.body ?? {};
    if (b.description !== undefined) {
      await q('update databases set description = $2 where page_id = $1', [req.params.id, b.description ? String(b.description).slice(0, 5000) : null]);
    }
    if (b.defaultTemplateId !== undefined) {
      if (b.defaultTemplateId) {
        const t = await one('select 1 from pages where id = $1 and parent_id = $2 and is_template and deleted_at is null', [b.defaultTemplateId, req.params.id]);
        if (!t) fail(400, 'That template does not belong to this database');
      }
      await q('update databases set default_template_id = $2 where page_id = $1', [req.params.id, b.defaultTemplateId || null]);
    }
    emit({ type: 'db', id: req.params.id });
    const r = await one('select description, default_template_id from databases where page_id = $1', [req.params.id]);
    return { description: r?.description ?? null, default_template_id: r?.default_template_id ?? null };
  });

  app.post<{ Params: { id: string }; Body: { viewId?: string; filter?: FilterGroup; sorts?: any[]; search?: string; templates?: boolean } }>(
    '/databases/:id/query',
    async (req) => {
      const user = requireUser(req);
      await assertPage(user, req.params.id, 'view');
      const b = req.body ?? {};
      let filter = b.filter, sorts = b.sorts;
      if (b.viewId) {
        const v = await one('select config from database_views where id = $1 and database_id = $2', [b.viewId, req.params.id]);
        if (!v) fail(404, 'View not found');
        filter ??= v.config.filter;
        sorts ??= v.config.sorts;
      }
      return queryDatabase(user, req.params.id, { filter, sorts, search: b.search, includeTemplates: b.templates });
    },
  );

  // ----- properties -----
  app.post<{ Params: { id: string }; Body: Partial<Prop> & { twoWay?: boolean } }>('/databases/:id/properties', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const schema = await getSchema(req.params.id);
    const b = req.body ?? {};
    const prop: Prop = { id: shortId(), name: b.name || 'Property', type: b.type || 'text' };
    if (['select', 'multi_select'].includes(prop.type)) prop.options = b.options ?? [];
    if (prop.type === 'status') prop.options = b.options?.length ? normalizeStatusOptions(b.options) : defaultStatusOptions();
    if (b.description) prop.description = String(b.description).slice(0, 1000);
    if (prop.type === 'person') prop.limit = b.limit === 'one' ? 'one' : 'many';
    if (prop.type === 'number') prop.number_format = b.number_format ?? 'number';
    if (prop.type === 'formula') prop.formula = b.formula ?? { expression: '' };
    if (prop.type === 'rollup') prop.rollup = b.rollup ?? { relationPropId: '', targetPropId: '', fn: 'show_original' };
    if (prop.type === 'button') prop.button = cleanButton((b as any).button ?? { label: prop.name });
    if (prop.type === 'ai') {
      const a: any = (b as any).ai ?? {};
      prop.ai = {
        instruction: String(a.instruction ?? ''),
        kind: ['summary', 'keywords', 'translate', 'custom'].includes(a.kind) ? a.kind : 'summary',
        ...(a.language ? { language: String(a.language) } : {}),
        outputType: ['text', 'select', 'multi_select'].includes(a.outputType) ? a.outputType : 'text',
        autoUpdate: !!a.autoUpdate,
      };
      if (prop.ai.outputType !== 'text') prop.options = b.options ?? [];
    }
    if (prop.type === 'unique_id') {
      prop.id_prefix = b.id_prefix ?? '';
      const rows = await q('select id from pages where parent_id = $1 and kind = $2 order by created_at', [req.params.id, 'row']);
      for (let i = 0; i < rows.length; i++) await q(`update pages set props = props || jsonb_build_object('__uid', $2::int) where id = $1`, [rows[i].id, i + 1]);
    }
    if (prop.type === 'relation') {
      if (!b.relation?.databaseId) fail(400, 'relation.databaseId required');
      await assertPage(user, b.relation!.databaseId, 'edit');
      prop.relation = { databaseId: b.relation!.databaseId, syncedPropId: null };
      if (b.twoWay !== false) {
        const self = await one('select title from pages where id = $1', [req.params.id]);
        const back: Prop = { id: shortId(), name: `Related to ${self.title || 'Untitled'}`, type: 'relation', relation: { databaseId: req.params.id, syncedPropId: prop.id } };
        prop.relation.syncedPropId = back.id;
        if (b.relation!.databaseId === req.params.id) schema.push(back);
        else await saveSchema(b.relation!.databaseId, [...(await getSchema(b.relation!.databaseId)), back]);
      }
    }
    schema.push(prop);
    await saveSchema(req.params.id, schema);
    return prop;
  });

  app.patch<{ Params: { id: string; pid: string }; Body: Partial<Prop> }>('/databases/:id/properties/:pid', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const schema = await getSchema(req.params.id);
    const i = schema.findIndex((p) => p.id === req.params.pid);
    if (i < 0) fail(404, 'Property not found');
    const b = req.body ?? {};
    const cur = schema[i];
    const next: Prop = { ...cur, ...b, id: cur.id };
    if (cur.type === 'title') next.type = 'title';
    if (b.description !== undefined) next.description = b.description ? String(b.description).slice(0, 1000) : undefined;
    if (b.limit !== undefined) next.limit = b.limit === 'one' ? 'one' : 'many';
    if ((next.type === 'status') && b.options) next.options = normalizeStatusOptions(b.options);
    if (next.type === 'button' && ((b as any).button !== undefined || !next.button)) next.button = cleanButton((b as any).button ?? next.button ?? { label: next.name });
    if (b.type && b.type !== cur.type) {
      if (['select', 'multi_select', 'status'].includes(b.type) && !next.options?.length) {
        next.options = b.type === 'status' ? defaultStatusOptions() : [];
        // convert existing text values to options
        if (!['select', 'multi_select', 'status'].includes(cur.type)) {
          const rows = await q('select id, props from pages where parent_id = $1 and kind = $2', [req.params.id, 'row']);
          const byName = new Map<string, string>();
          for (const r of rows) {
            const raw = r.props[cur.id];
            if (raw == null || raw === '') continue;
            const names = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
            const ids = names.map((n) => {
              if (!byName.has(n)) { const o = { id: shortId(), name: n, color: randomColor() }; next.options!.push(o); byName.set(n, o.id); }
              return byName.get(n)!;
            });
            await q('update pages set props = props || $2 where id = $1', [r.id, { [cur.id]: b.type === 'multi_select' ? ids : ids[0] }]);
          }
        }
      } else if (['select', 'multi_select', 'status'].includes(cur.type)) {
        const rows = await q('select id, props from pages where parent_id = $1 and kind = $2', [req.params.id, 'row']);
        for (const r of rows) {
          const raw = r.props[cur.id];
          const names = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((id: string) => cur.options?.find((o) => o.id === id)?.name).filter(Boolean);
          const val = ['select', 'multi_select', 'status'].includes(b.type) ? (b.type === 'multi_select' ? (Array.isArray(raw) ? raw : raw ? [raw] : []) : Array.isArray(raw) ? raw[0] ?? null : raw) : names.join(', ');
          await q('update pages set props = props || $2 where id = $1', [r.id, { [cur.id]: val }]);
        }
      } else if (b.type === 'number') {
        await q(`update pages set props = props || jsonb_build_object($2::text, case when props->>$2 ~ '^-?[0-9.]+$' then to_jsonb((props->>$2)::numeric) else 'null'::jsonb end) where parent_id = $1 and kind = 'row' and props ? $2`, [req.params.id, cur.id]);
      } else if (b.type === 'checkbox') {
        await q(`update pages set props = props || jsonb_build_object($2::text, coalesce(props->>$2, '') in ('true','yes','1','x')) where parent_id = $1 and kind = 'row' and props ? $2`, [req.params.id, cur.id]);
      } else if (['text', 'url', 'email', 'phone'].includes(b.type) && ['number', 'checkbox', 'text', 'url', 'email', 'phone'].includes(cur.type)) {
        await q(`update pages set props = props || jsonb_build_object($2::text, props->>$2) where parent_id = $1 and kind = 'row' and props ? $2`, [req.params.id, cur.id]);
      } else {
        await q(`update pages set props = props - $2 where parent_id = $1 and kind = 'row'`, [req.params.id, cur.id]);
      }
      if (b.type === 'formula' && !next.formula) next.formula = { expression: '' };
      if (b.type === 'number' && !next.number_format) next.number_format = 'number';
    }
    schema[i] = next;
    await saveSchema(req.params.id, schema);
    return next;
  });

  app.delete<{ Params: { id: string; pid: string } }>('/databases/:id/properties/:pid', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    if (req.params.pid === 'title') fail(400, 'Cannot delete the title property');
    const schema = await getSchema(req.params.id);
    const p = schema.find((x) => x.id === req.params.pid);
    if (!p) fail(404, 'Property not found');
    await saveSchema(req.params.id, schema.filter((x) => x.id !== req.params.pid));
    await q(`update pages set props = props - $2 where parent_id = $1 and kind = 'row'`, [req.params.id, req.params.pid]);
    if (p!.relation?.syncedPropId) {
      const other = await getSchema(p!.relation.databaseId).catch(() => null);
      if (other) {
        const back = other.find((x) => x.id === p!.relation!.syncedPropId);
        if (back?.relation) { back.relation.syncedPropId = null; await saveSchema(p!.relation.databaseId, other); }
      }
    }
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { order: string[] } }>('/databases/:id/properties/order', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const schema = await getSchema(req.params.id);
    const order = req.body?.order ?? [];
    schema.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
    await saveSchema(req.params.id, schema);
    return schema;
  });

  // ----- rows -----
  app.post<{ Params: { id: string }; Body: { title?: string; props?: Record<string, any>; position?: number; templateId?: string; isTemplate?: boolean; markdown?: string; useDefaultTemplate?: boolean } }>(
    '/databases/:id/rows',
    async (req) => {
      const user = requireUser(req);
      const { createPage } = await import('./pages.js');
      const b = req.body ?? {};
      const schema = await getSchema(req.params.id);
      const props: Record<string, any> = normalizeRowProps(schema, { ...(b.props ?? {}) });
      // "New" in the UI asks for the database's default template; API/MCP callers opt in explicitly.
      if (b.useDefaultTemplate && !b.templateId && !b.isTemplate && !b.markdown) {
        const d = await one<{ default_template_id: string | null }>(
          `select d.default_template_id from databases d join pages t on t.id = d.default_template_id and t.is_template and t.deleted_at is null where d.page_id = $1`,
          [req.params.id],
        );
        if (d?.default_template_id) b.templateId = d.default_template_id;
      }
      if (schema.some((p) => p.type === 'unique_id')) {
        const r = await one(`select coalesce(max((props->>'__uid')::int), 0) + 1 as n from pages where parent_id = $1 and kind = 'row'`, [req.params.id]);
        props.__uid = r.n;
      }
      const status = schema.find((p) => p.type === 'status');
      if (status && props[status.id] === undefined && !b.templateId) props[status.id] = status.options?.[0]?.id ?? null;
      const row = await createPage(user, {
        parentId: req.params.id, kind: 'row', title: b.title, props, position: b.position,
        templateId: b.templateId, isTemplate: b.isTemplate, markdown: b.markdown,
      });
      await syncRelations(row.id, req.params.id, {}, props);
      return row;
    },
  );

  app.post<{ Params: { id: string }; Body: { order: string[] } }>('/databases/:id/rows/reorder', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const order = req.body?.order ?? [];
    await q(`update pages p set position = o.i from unnest($1::uuid[]) with ordinality as o(id, i) where p.id = o.id and p.parent_id = $2`, [order, req.params.id]);
    emit({ type: 'db', id: req.params.id });
    return { ok: true };
  });

  // ----- views -----
  app.post<{ Params: { id: string }; Body: { name?: string; type?: string; config?: any; blockId?: string | null } }>('/databases/:id/views', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const b = req.body ?? {};
    const type = b.type ?? 'table';
    if (!isViewType(type)) fail(400, 'Unknown view type');
    b.config = cleanViewConfig(type, b.config ?? {});
    const v = await one(
      `insert into database_views(database_id, name, type, config, position, block_id)
       values ($1,$2,$3,$4,(select coalesce(max(position),0)+1 from database_views where database_id = $1 and block_id is not distinct from $5), $5)
       returning *`,
      [req.params.id, b.name ?? type[0].toUpperCase() + type.slice(1), type, b.config ?? {}, b.blockId || null],
    );
    emit({ type: 'db', id: req.params.id });
    return v;
  });

  app.patch<{ Params: { vid: string }; Body: { name?: string; type?: string; config?: any; position?: number } }>('/views/:vid', async (req) => {
    const user = requireUser(req);
    const v = await one('select * from database_views where id = $1', [req.params.vid]);
    if (!v) fail(404, 'View not found');
    await assertPage(user, v.database_id, 'edit');
    const b = req.body ?? {};
    if (b.type && !isViewType(b.type)) fail(400, 'Unknown view type');
    if (b.config) b.config = cleanViewConfig(b.type ?? v.type, b.config, v.config);
    else if (b.type && b.type !== v.type && ['chart', 'form', 'dashboard', 'map'].includes(b.type)) b.config = cleanViewConfig(b.type, {}, v.config);
    const r = await one(
      `update database_views set name = coalesce($2, name), type = coalesce($3, type),
         config = case when $4::jsonb is null then config else config || $4::jsonb end, position = coalesce($5, position)
       where id = $1 returning *`,
      [req.params.vid, b.name ?? null, b.type ?? null, b.config ? JSON.stringify(b.config) : null, b.position ?? null],
    );
    emit({ type: 'db', id: v.database_id });
    return r;
  });

  app.delete<{ Params: { vid: string } }>('/views/:vid', async (req) => {
    const user = requireUser(req);
    const v = await one('select * from database_views where id = $1', [req.params.vid]);
    if (!v) fail(404, 'View not found');
    await assertPage(user, v.database_id, 'edit');
    const n = await one('select count(*)::int as n from database_views where database_id = $1 and block_id is not distinct from $2', [v.database_id, v.block_id]);
    if (n.n <= 1) fail(400, 'A database needs at least one view');
    await q('delete from database_views where id = $1', [req.params.vid]);
    emit({ type: 'db', id: v.database_id });
    return { ok: true };
  });

  app.post<{ Params: { vid: string } }>('/views/:vid/duplicate', async (req) => {
    const user = requireUser(req);
    const v = await one('select * from database_views where id = $1', [req.params.vid]);
    if (!v) fail(404, 'View not found');
    await assertPage(user, v.database_id, 'edit');
    const r = await one(
      `insert into database_views(database_id, name, type, config, position, block_id) values ($1,$2,$3,$4,$5,$6) returning *`,
      [v.database_id, `${v.name} (copy)`, v.type, v.config, v.position + 0.5, v.block_id],
    );
    emit({ type: 'db', id: v.database_id });
    return r;
  });

  app.get('/databases', async (req) => {
    const user = requireUser(req);
    const { visibleTree } = await import('../perms.js');
    return (await visibleTree(user)).filter((p) => p.kind === 'database').map((p) => ({ id: p.id, title: p.title, icon: p.icon }));
  });
}
