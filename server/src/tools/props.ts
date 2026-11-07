import { call, parseId, ToolError, type ToolCtx } from './context.js';
import type { Prop } from '../routes/databases.js';

/** Friendly ⇄ internal conversion of database property values (names instead of ids). */

export interface DbMeta {
  id: string;
  title: string;
  icon: string | null;
  schema: Prop[];
  views: any[];
  templates: any[];
  level: string;
}

export const getDb = (ctx: ToolCtx, id: string) => call<DbMeta>(ctx, 'GET', `/databases/${id}`);

const COMPUTED = new Set(['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id']);
const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

export function findProp(schema: Prop[], name: string): Prop {
  const n = name.trim().toLowerCase();
  const p = schema.find((x) => x.name.toLowerCase() === n) ?? schema.find((x) => x.id === name);
  if (!p) throw new ToolError(`Unknown property "${name}". Properties: ${schema.map((x) => `"${x.name}"`).join(', ')}`);
  return p;
}

let usersCache: { at: number; list: any[] } | null = null;
async function users(ctx: ToolCtx) {
  if (!usersCache || Date.now() - usersCache.at > 30_000) usersCache = { at: Date.now(), list: await call<any[]>(ctx, 'GET', '/users') };
  return usersCache.list;
}

export async function resolveUser(ctx: ToolCtx, v: string): Promise<string> {
  const s = String(v).trim();
  if (s === 'me') return ctx.user.id;
  const list = await users(ctx);
  const l = s.toLowerCase();
  const u =
    list.find((x) => x.id === s) ??
    list.find((x) => x.email.toLowerCase() === l) ??
    list.find((x) => x.name.toLowerCase() === l) ??
    list.find((x) => x.name.toLowerCase().startsWith(l));
  if (!u) throw new ToolError(`No workspace member matches "${v}" (use an email, name or user id)`);
  return u.id;
}

const asList = (v: any): any[] =>
  v == null || v === '' ? [] : Array.isArray(v) ? v : typeof v === 'string' && v.trim().startsWith('[') ? JSON.parse(v) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [v];

function toDate(v: any): { start: string; end?: string } | null {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.start) return { start: String(v.start), ...(v.end ? { end: String(v.end) } : {}) };
  const s = String(v).trim();
  const range = s.split(/\s*(?:→|->|\bto\b)\s*/);
  if (range.length === 2) return { start: range[0], end: range[1] };
  return { start: s };
}

/** Ensure select-like options exist (creating missing ones like Notion does) and return their ids. */
async function optionIds(ctx: ToolCtx, db: DbMeta, p: Prop, names: string[]): Promise<string[]> {
  const opts = [...(p.options ?? [])];
  const ids: string[] = [];
  let created = false;
  for (const name of names) {
    const s = String(name).trim();
    let o = opts.find((x) => x.name.toLowerCase() === s.toLowerCase()) ?? opts.find((x) => x.id === s);
    if (!o) {
      if (p.type === 'status') throw new ToolError(`"${s}" is not a ${p.name} option. Options: ${opts.map((x) => `"${x.name}"`).join(', ')}`);
      o = { id: Math.random().toString(36).slice(2, 10), name: s, color: COLORS[1 + (opts.length % (COLORS.length - 1))] };
      opts.push(o);
      created = true;
    }
    ids.push(o.id);
  }
  if (created) {
    await call(ctx, 'PATCH', `/databases/${db.id}/properties/${p.id}`, { options: opts });
    p.options = opts;
  }
  return ids;
}

async function relationIds(ctx: ToolCtx, p: Prop, values: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const v of values) {
    try {
      out.push(parseId(String(v)));
    } catch {
      // Fall back to an exact title match in the related database.
      const target = p.relation?.databaseId;
      if (!target) throw new ToolError(`Relation "${p.name}" has no target database`);
      const r = await call(ctx, 'POST', `/databases/${target}/query`, { search: String(v) });
      const hit = r.rows.find((x: any) => x.title.toLowerCase() === String(v).toLowerCase());
      if (!hit) throw new ToolError(`No page titled "${v}" in the related database for "${p.name}"`);
      out.push(hit.id);
    }
  }
  return out;
}

/**
 * Convert { "Property name": friendly value } into { title?, props: { propId: internalValue } }.
 * Also accepts Notion's expanded date keys: "date:Due:start", "date:Due:end".
 */
export async function toInternalProps(ctx: ToolCtx, db: DbMeta, input: Record<string, any>) {
  const props: Record<string, any> = {};
  let title: string | undefined;
  const dates = new Map<string, { start?: string; end?: string }>();
  for (const [key, value] of Object.entries(input ?? {})) {
    const m = key.match(/^date:(.+):(start|end|is_datetime)$/);
    if (m) {
      if (m[2] === 'is_datetime') continue;
      const d = dates.get(m[1]) ?? {};
      (d as any)[m[2]] = value;
      dates.set(m[1], d);
      continue;
    }
    const p = findProp(db.schema, key);
    if (COMPUTED.has(p.type)) throw new ToolError(`"${p.name}" is a ${p.type} property and can't be set`);
    switch (p.type) {
      case 'title':
        title = value == null ? '' : String(value);
        break;
      case 'text': case 'url': case 'email': case 'phone':
        props[p.id] = value == null ? null : String(value);
        break;
      case 'number':
        props[p.id] = value == null || value === '' ? null : Number(value);
        if (Number.isNaN(props[p.id])) throw new ToolError(`"${p.name}" needs a number`);
        break;
      case 'checkbox':
        props[p.id] = value === true || ['true', 'yes', '1', '__YES__', 'checked'].includes(String(value).toLowerCase()) || value === '__YES__';
        break;
      case 'select': case 'status':
        props[p.id] = value == null || value === '' ? null : (await optionIds(ctx, db, p, [String(value)]))[0];
        break;
      case 'multi_select':
        props[p.id] = await optionIds(ctx, db, p, asList(value).map(String));
        break;
      case 'person':
        props[p.id] = await Promise.all(asList(value).map((v) => resolveUser(ctx, String(typeof v === 'object' ? v.id ?? v.email : v))));
        break;
      case 'date':
        props[p.id] = toDate(value);
        break;
      case 'relation':
        props[p.id] = await relationIds(ctx, p, asList(value));
        break;
      case 'place': {
        if (value == null || value === '') { props[p.id] = null; break; }
        if (typeof value === 'string') {
          const m = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
          if (!m) throw new ToolError(`"${p.name}" needs {lat, lng, name?, address?} or "lat, lng"`);
          props[p.id] = { lat: Number(m[1]), lng: Number(m[2]) };
        } else props[p.id] = value;
        break;
      }
      case 'verification':
        props[p.id] = value == null || value === '' ? null : typeof value === 'string' ? { state: value.toLowerCase(), by: ctx.user.id, at: new Date().toISOString() } : value;
        break;
      case 'button':
        throw new ToolError(`"${p.name}" is a button property and has no value`);
      case 'files':
        props[p.id] = asList(value).map((f: any) => (typeof f === 'string' ? { name: decodeURIComponent(f.split('/').pop() || f), url: f } : { name: f.name ?? f.url, url: f.url }));
        break;
      default:
        props[p.id] = value;
    }
  }
  for (const [name, d] of dates) {
    const p = findProp(db.schema, name);
    props[p.id] = d.start ? { start: String(d.start), ...(d.end ? { end: String(d.end) } : {}) } : null;
  }
  return { title, props };
}

/** Render a row's values with property names and human-readable values. */
export function fromInternal(row: any, schema: Prop[], titles: Record<string, string>, userMap: Map<string, string>) {
  const out: Record<string, any> = {};
  for (const p of schema) {
    const v = p.type === 'title' ? row.title : COMPUTED.has(p.type) ? computedValue(row, p, userMap) : row.props?.[p.id];
    if (p.type !== 'title' && !COMPUTED.has(p.type) && (v == null || v === '' || (Array.isArray(v) && !v.length))) continue;
    switch (p.type) {
      case 'select': case 'status': out[p.name] = p.options?.find((o) => o.id === v)?.name ?? null; break;
      case 'multi_select': out[p.name] = (v as string[]).map((id) => p.options?.find((o) => o.id === id)?.name).filter(Boolean); break;
      case 'person': out[p.name] = (v as string[]).map((id) => userMap.get(id) ?? id); break;
      case 'relation': out[p.name] = (v as string[]).map((id) => ({ id, title: titles[id] ?? '' })); break;
      case 'date': out[p.name] = v.end ? `${v.start} → ${v.end}` : v.start; break;
      case 'place': out[p.name] = { lat: v.lat, lng: v.lng, ...(v.name ? { name: v.name } : {}), ...(v.address ? { address: v.address } : {}) }; break;
      case 'verification': out[p.name] = v.state === 'verified' && v.until && new Date(v.until).getTime() < Date.now() ? 'expired' : v.state; break;
      case 'button': break;
      default: out[p.name] = v;
    }
  }
  return out;
}

function computedValue(row: any, p: Prop, userMap: Map<string, string>) {
  switch (p.type) {
    case 'created_time': return row.created_at;
    case 'last_edited_time': return row.updated_at;
    case 'created_by': return row.created_by ? userMap.get(row.created_by) ?? row.created_by : null;
    case 'last_edited_by': return row.updated_by ? userMap.get(row.updated_by) ?? row.updated_by : null;
    case 'unique_id': return row.props?.__uid != null ? `${p.id_prefix ? `${p.id_prefix}-` : ''}${row.props.__uid}` : null;
    default: return row.computed?.[p.id] ?? null;
  }
}

export async function userNameMap(ctx: ToolCtx) {
  return new Map((await users(ctx)).map((u: any) => [u.id, u.name] as [string, string]));
}

/** Friendly filter value → internal filter value for a property. */
export async function filterValue(ctx: ToolCtx, db: DbMeta, p: Prop, value: any) {
  if (value == null) return value;
  switch (p.type) {
    case 'select': case 'status': case 'multi_select': {
      const names = asList(value).map(String);
      const ids = names.map((n) => p.options?.find((o) => o.name.toLowerCase() === n.toLowerCase() || o.id === n)?.id);
      const missing = names.filter((_, i) => !ids[i]);
      if (missing.length) throw new ToolError(`Unknown ${p.name} option(s): ${missing.join(', ')}. Options: ${(p.options ?? []).map((o) => `"${o.name}"`).join(', ')}`);
      return ids.length === 1 ? ids[0] : ids;
    }
    case 'person': case 'created_by': case 'last_edited_by':
      return Promise.all(asList(value).map((v) => (String(v) === 'me' ? 'me' : resolveUser(ctx, String(v)))));
    case 'relation':
      return relationIds(ctx, p, asList(value));
    case 'checkbox':
      return value === true || String(value).toLowerCase() === 'true';
    default:
      return value;
  }
}
