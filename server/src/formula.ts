/**
 * Notion Formula 2.0 compatible formula engine.
 *
 * Syntax: literals (numbers, "strings"/'strings' with escapes, true/false, [lists]), prop("Name"),
 * Notion API property placeholders {{notion:block_property:<propId>:...}}, operators
 * + - * / % ^ == != > < >= <= && || ! and/or/not, ternary `c ? a : b`, method chaining
 * (x.length(), list.map(current * 2)), `current`/`index` in list lambdas, let/lets, comments.
 */

// ---------------------------------------------------------------- values

export class DateVal {
  constructor(public start: Date, public end: Date | null = null) {}
}
export class PageVal {
  constructor(public id: string, public title: string, public row?: FormulaRow, public ctx?: FormulaContext) {}
}
export class PersonVal {
  constructor(public id: string, public name: string, public email: string) {}
}
export type Val = number | string | boolean | null | DateVal | PageVal | PersonVal | Val[];

export class FormulaError extends Error {}
const err = (m: string): never => {
  throw new FormulaError(m);
};

// ---------------------------------------------------------------- tokenizer

type Tok = { k: 'num' | 'str' | 'id' | 'op' | 'pref'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (src.startsWith('{{', i)) {
      const j = src.indexOf('}}', i);
      if (j < 0) err('Unterminated property reference');
      const inner = src.slice(i + 2, j);
      const m = /^notion:block_property:([^:]+)/.exec(inner);
      if (!m) err(`Unsupported reference {{${inner}}}`);
      let id = m![1];
      try { id = decodeURIComponent(id); } catch {}
      toks.push({ k: 'pref', v: id });
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c;
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== close && !(close === '”' && src[j] === '“')) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[++j];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          j++;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) err('Unterminated string');
      toks.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { toks.push({ k: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (id) { toks.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(==|!=|>=|<=|&&|\|\||≠|≥|≤|[-+*/%^<>()[\],.!?:])/.exec(src.slice(i));
    if (op) {
      const v = op[0] === '≠' ? '!=' : op[0] === '≥' ? '>=' : op[0] === '≤' ? '<=' : op[0];
      toks.push({ k: 'op', v });
      i += op[0].length;
      continue;
    }
    err(`Unexpected character "${c}"`);
  }
  return toks;
}

// ---------------------------------------------------------------- parser

export type Node =
  | { t: 'lit'; v: Val }
  | { t: 'list'; items: Node[] }
  | { t: 'var'; name: string }
  | { t: 'prop'; name?: string; id?: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'method'; target: Node; fn: string; args: Node[] }
  | { t: 'index'; target: Node; index: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: string; e: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node };

export function parseFormula(src: string): Node {
  if (!src.trim()) return { t: 'lit', v: null };
  const toks = tokenize(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const isOp = (...vs: string[]) => {
    const t = peek();
    return !!t && (t.k === 'op' || t.k === 'id') && vs.includes(t.v);
  };
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t) err(v ? `Expected "${v}" but the formula ended` : 'Unexpected end of formula');
    if (v && t.v !== v) err(`Expected "${v}" but found "${t.v}"`);
    p++;
    return t;
  };
  const args = (): Node[] => {
    eat('(');
    const out: Node[] = [];
    if (peek()?.v !== ')') {
      out.push(expr());
      while (peek()?.v === ',') { eat(','); if (peek()?.v === ')') break; out.push(expr()); }
    }
    eat(')');
    return out;
  };
  const expr = (): Node => ternary();
  const ternary = (): Node => {
    const c = or();
    if (isOp('?')) { eat('?'); const a = expr(); eat(':'); const b = expr(); return { t: 'cond', c, a, b }; }
    return c;
  };
  const or = (): Node => { let l = and(); while (isOp('||', 'or')) { eat(); l = { t: 'bin', op: '||', l, r: and() }; } return l; };
  const and = (): Node => { let l = not(); while (isOp('&&', 'and')) { eat(); l = { t: 'bin', op: '&&', l, r: not() }; } return l; };
  const not = (): Node => {
    if (isOp('not') && peek(1)?.v !== '(') { eat(); return { t: 'un', op: '!', e: not() }; }
    return cmp();
  };
  const cmp = (): Node => {
    let l = add();
    while (isOp('==', '!=', '>', '<', '>=', '<=')) { const op = eat().v; l = { t: 'bin', op, l, r: add() }; }
    return l;
  };
  const add = (): Node => { let l = mul(); while (isOp('+', '-')) { const op = eat().v; l = { t: 'bin', op, l, r: mul() }; } return l; };
  const mul = (): Node => { let l = unary(); while (isOp('*', '/', '%')) { const op = eat().v; l = { t: 'bin', op, l, r: unary() }; } return l; };
  const unary = (): Node => {
    if (isOp('-')) { eat(); return { t: 'un', op: '-', e: unary() }; }
    if (isOp('+')) { eat(); return unary(); }
    if (isOp('!')) { eat(); return { t: 'un', op: '!', e: unary() }; }
    return power();
  };
  const power = (): Node => {
    const base = postfix(primary());
    if (isOp('^')) { eat(); return { t: 'bin', op: '^', l: base, r: unary() }; }
    return base;
  };
  const postfix = (n: Node): Node => {
    for (;;) {
      if (peek()?.v === '.' && peek(1)?.k === 'id') {
        eat('.');
        const fn = eat().v;
        n = { t: 'method', target: n, fn, args: peek()?.v === '(' ? args() : [] };
        continue;
      }
      if (peek()?.v === '[' ) {
        eat('[');
        const index = expr();
        eat(']');
        n = { t: 'index', target: n, index };
        continue;
      }
      return n;
    }
  };
  const primary = (): Node => {
    const t = eat();
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'pref') return { t: 'prop', id: t.v };
    if (t.k === 'op' && t.v === '(') { const e = expr(); eat(')'); return e; }
    if (t.k === 'op' && t.v === '[') {
      const items: Node[] = [];
      if (peek()?.v !== ']') {
        items.push(expr());
        while (peek()?.v === ',') { eat(','); if (peek()?.v === ']') break; items.push(expr()); }
      }
      eat(']');
      return { t: 'list', items };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' };
      if (peek()?.v === '(') {
        const a = args();
        if (t.v === 'prop') {
          if (a.length !== 1 || a[0].t !== 'lit' || typeof a[0].v !== 'string') err('prop() expects a property name');
          return { t: 'prop', name: (a[0] as any).v };
        }
        return { t: 'call', fn: t.v, args: a };
      }
      return { t: 'var', name: t.v };
    }
    err(`Unexpected "${t.v}"`);
    return null as never;
  };
  const n = expr();
  if (p < toks.length) err(`Unexpected "${toks[p].v}"`);
  return n;
}

// ---------------------------------------------------------------- helpers

const isDate = (v: Val): v is DateVal => v instanceof DateVal;
const isList = (v: Val): v is Val[] => Array.isArray(v);

export function isEmpty(v: Val): boolean {
  return v == null || v === '' || v === false || v === 0 || (Array.isArray(v) && v.length === 0);
}
const truthy = (v: Val) => !isEmpty(v);

function typeName(v: Val): string {
  if (v == null) return 'empty';
  if (isList(v)) return 'list';
  if (isDate(v)) return 'date';
  if (v instanceof PageVal) return 'page';
  if (v instanceof PersonVal) return 'person';
  return typeof v === 'string' ? 'text' : typeof v;
}

function num(v: Val, fn = 'operation'): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return err(`${fn} expects a number but got ${typeName(v)}${typeof v === 'string' ? ` "${v}"` : ''}`);
}
function str(v: Val): string {
  return format(v);
}
function list(v: Val, fn: string): Val[] {
  if (isList(v)) return v;
  if (v == null) return [];
  return err(`${fn}() expects a list but got ${typeName(v)}`);
}
function date(v: Val, fn: string): DateVal {
  if (isDate(v)) return v;
  if (typeof v === 'string' && v) {
    const d = parseDateString(v);
    if (d) return d;
  }
  return err(`${fn}() expects a date but got ${typeName(v)}`);
}

function parseDateString(s: string): DateVal | null {
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00Z`) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : new DateVal(d);
}

export function equal(a: Val, b: Val): boolean {
  if (a === b) return true;
  if (a == null || b == null) {
    const blank = (v: Val) => v == null || v === '' || (Array.isArray(v) && !v.length);
    return blank(a) && blank(b);
  }
  if (isDate(a) && isDate(b)) return a.start.getTime() === b.start.getTime() && (a.end?.getTime() ?? null) === (b.end?.getTime() ?? null);
  if (a instanceof PageVal && b instanceof PageVal) return a.id === b.id;
  if (a instanceof PersonVal && b instanceof PersonVal) return a.id === b.id;
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  return false;
}

function compare(a: Val, b: Val): number {
  if (isDate(a) && isDate(b)) return a.start.getTime() - b.start.getTime();
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return num(a, 'Comparison') - num(b, 'Comparison');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return n + (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
};

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7);
}

/** Moment-style date formatting (the tokens Notion's formatDate accepts), in UTC. */
export function formatDateTokens(d: Date, fmt: string): string {
  const re = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|Mo|M|DDDD|Do|DD|D|dddd|ddd|dd|d|E|HH|H|hh|h|mm|m|ss|s|A|a|Q|wo|ww|w|WW|W|X|x|ZZ|Z/g;
  const H = d.getUTCHours();
  return fmt.replace(re, (tok, lit) => {
    if (lit !== undefined) return lit;
    switch (tok) {
      case 'YYYY': return String(d.getUTCFullYear());
      case 'YY': return String(d.getUTCFullYear()).slice(-2);
      case 'MMMM': return MONTHS[d.getUTCMonth()];
      case 'MMM': return MONTHS[d.getUTCMonth()].slice(0, 3);
      case 'MM': return pad(d.getUTCMonth() + 1);
      case 'Mo': return ordinal(d.getUTCMonth() + 1);
      case 'M': return String(d.getUTCMonth() + 1);
      case 'DDDD': return pad(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1, 3);
      case 'Do': return ordinal(d.getUTCDate());
      case 'DD': return pad(d.getUTCDate());
      case 'D': return String(d.getUTCDate());
      case 'dddd': return DAYS[d.getUTCDay()];
      case 'ddd': return DAYS[d.getUTCDay()].slice(0, 3);
      case 'dd': return DAYS[d.getUTCDay()].slice(0, 2);
      case 'd': return String(d.getUTCDay());
      case 'E': return String(d.getUTCDay() || 7);
      case 'HH': return pad(H);
      case 'H': return String(H);
      case 'hh': return pad(H % 12 || 12);
      case 'h': return String(H % 12 || 12);
      case 'mm': return pad(d.getUTCMinutes());
      case 'm': return String(d.getUTCMinutes());
      case 'ss': return pad(d.getUTCSeconds());
      case 's': return String(d.getUTCSeconds());
      case 'A': return H < 12 ? 'AM' : 'PM';
      case 'a': return H < 12 ? 'am' : 'pm';
      case 'Q': return String(Math.floor(d.getUTCMonth() / 3) + 1);
      case 'W': case 'w': return String(isoWeek(d));
      case 'WW': case 'ww': return pad(isoWeek(d));
      case 'wo': return ordinal(isoWeek(d));
      case 'X': return String(Math.floor(d.getTime() / 1000));
      case 'x': return String(d.getTime());
      case 'Z': return '+00:00';
      case 'ZZ': return '+0000';
    }
    return tok;
  });
}

const hasTime = (d: Date) => d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
function defaultDateFormat(d: Date) {
  return formatDateTokens(d, hasTime(d) ? 'MMMM D, YYYY h:mm A' : 'MMMM D, YYYY');
}

/** Text form of a value (format(), string concatenation). */
export function format(v: Val): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number.isInteger(v) ? v : +v.toPrecision(15)) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isDate(v)) return v.end ? `${defaultDateFormat(v.start)} → ${defaultDateFormat(v.end)}` : defaultDateFormat(v.start);
  if (v instanceof PageVal) return v.title;
  if (v instanceof PersonVal) return v.name;
  return v.map(format).join(', ');
}

/** JSON-safe form for the API/UI. */
export function serialize(v: Val): any {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isDate(v)) return v.end ? { start: v.start.toISOString(), end: v.end.toISOString() } : v.start.toISOString();
  if (v instanceof PageVal) return { id: v.id, title: v.title };
  if (v instanceof PersonVal) return { id: v.id, name: v.name };
  if (isList(v)) return v.map(serialize);
  return v;
}

const UNIT_MS: Record<string, number> = {
  millisecond: 1, second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5,
};
function normUnit(u: Val): string {
  const s = str(u).toLowerCase().trim().replace(/s$/, '');
  if (!['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].includes(s)) err(`Unknown date unit "${str(u)}"`);
  return s;
}
function addToDate(d: Date, amount: number, unit: string): Date {
  if (unit === 'month' || unit === 'quarter' || unit === 'year') {
    const months = amount * (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1);
    const whole = Math.trunc(months);
    const x = new Date(d.getTime());
    const day = x.getUTCDate();
    x.setUTCDate(1);
    x.setUTCMonth(x.getUTCMonth() + whole);
    const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
    x.setUTCDate(Math.min(day, last));
    return x;
  }
  return new Date(d.getTime() + amount * UNIT_MS[unit]);
}
function dateDiff(a: Date, b: Date, unit: string): number {
  if (unit === 'month' || unit === 'quarter' || unit === 'year') {
    let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
    // only count a month once the day/time has been reached
    const rest = (x: Date) => x.getTime() - Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1);
    if (months > 0 && rest(a) < rest(b)) months--;
    if (months < 0 && rest(a) > rest(b)) months++;
    return Math.trunc(months / (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1));
  }
  return Math.trunc((a.getTime() - b.getTime()) / UNIT_MS[unit]);
}

function toRegex(pattern: Val, flags = ''): RegExp {
  const s = str(pattern);
  try {
    return new RegExp(s, flags);
  } catch {
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

const flatNums = (args: Val[], fn: string) => args.flat(Infinity as 1).filter((x) => x != null && x !== '').map((x) => num(x as Val, fn + '()'));
const median = (ns: number[]) => {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- evaluation

export interface FormulaEnv {
  /** Resolve prop("Name") / {{notion:block_property:id}} for the current page. */
  getProp(ref: { name?: string; id?: string }): Val;
  /** Resolve a property on another (related) page. */
  getPageProp?(page: PageVal, name: string): Val;
  rowId?: string;
  now?: Date;
}

type Scope = Map<string, Val>;

// Functions whose arguments are evaluated lazily (lambdas, short-circuit, bindings).
const LAZY = new Set(['if', 'ifs', 'and', 'or', 'let', 'lets', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'count', 'sort']);

export function evaluate(node: Node, env: FormulaEnv, scope: Scope = new Map()): Val {
  const now = env.now ?? new Date();
  const ev = (n: Node, s: Scope = scope): Val => evaluate(n, env, s);

  const iterate = (items: Val[], body: Node, fnName: string, cb: (v: Val, item: Val, i: number) => boolean | void) => {
    for (let i = 0; i < items.length; i++) {
      const s = new Map(scope);
      s.set('current', items[i]);
      s.set('index', i);
      if (cb(ev(body, s), items[i], i) === false) break;
    }
  };

  const callLazy = (fn: string, target: Val | undefined, a: Node[]): Val => {
    const all = target !== undefined ? null : a; // in method form, target is already evaluated
    const firstVal = () => (target !== undefined ? target : ev(a[0]));
    const rest = target !== undefined ? a : a.slice(1);
    switch (fn) {
      case 'if': {
        const c = firstVal();
        return truthy(c) ? (rest[0] ? ev(rest[0]) : null) : rest[1] ? ev(rest[1]) : null;
      }
      case 'ifs': {
        const nodes = all ?? a;
        const vals = target !== undefined ? [target] : [];
        // method form `cond.ifs(v, c2, v2, else)`: treat target as first condition
        const seq: (Node | Val)[] = [...vals, ...nodes];
        for (let i = 0; i + 1 < seq.length; i += 2) {
          const c = i === 0 && target !== undefined ? target : ev(seq[i] as Node);
          if (truthy(c)) return ev(seq[i + 1] as Node);
        }
        return seq.length % 2 ? (seq.length === 1 && target !== undefined ? null : ev(seq[seq.length - 1] as Node)) : null;
      }
      case 'and': {
        if (!truthy(firstVal())) return false;
        for (const n of rest) if (!truthy(ev(n))) return false;
        return true;
      }
      case 'or': {
        if (truthy(firstVal())) return true;
        for (const n of rest) if (truthy(ev(n))) return true;
        return false;
      }
      case 'let': {
        if (target !== undefined) err('let() cannot be used as a method');
        if (a.length !== 3 || a[0].t !== 'var') err('let() expects a variable name, a value and an expression');
        const s = new Map(scope);
        s.set((a[0] as any).name, ev(a[1]));
        return ev(a[2], s);
      }
      case 'lets': {
        if (target !== undefined) err('lets() cannot be used as a method');
        if (a.length < 3 || a.length % 2 === 0) err('lets() expects name/value pairs followed by an expression');
        const s = new Map(scope);
        for (let i = 0; i + 1 < a.length; i += 2) {
          if (a[i].t !== 'var') err('lets() expects variable names');
          s.set((a[i] as any).name, evaluate(a[i + 1], env, s));
        }
        return evaluate(a[a.length - 1], env, s);
      }
    }
    // list lambdas
    const items = list(firstVal(), fn);
    const body = rest[0];
    switch (fn) {
      case 'map': {
        if (!body) err('map() expects an expression');
        const out: Val[] = [];
        iterate(items, body, fn, (v) => { out.push(v); });
        return out;
      }
      case 'filter': {
        if (!body) err('filter() expects a condition');
        const out: Val[] = [];
        iterate(items, body, fn, (v, item) => { if (truthy(v)) out.push(item); });
        return out;
      }
      case 'find': {
        let found: Val = null;
        iterate(items, body, fn, (v, item) => { if (truthy(v)) { found = item; return false; } });
        return found;
      }
      case 'findIndex': {
        let found = -1;
        iterate(items, body, fn, (v, _i, i) => { if (truthy(v)) { found = i; return false; } });
        return found;
      }
      case 'some': {
        let r = false;
        iterate(items, body, fn, (v) => { if (truthy(v)) { r = true; return false; } });
        return r;
      }
      case 'every': {
        let r = true;
        iterate(items, body, fn, (v) => { if (!truthy(v)) { r = false; return false; } });
        return r;
      }
      case 'count': {
        if (!body) return items.filter((x) => x != null && x !== '').length;
        let c = 0;
        iterate(items, body, fn, (v) => { if (truthy(v)) c++; });
        return c;
      }
      case 'sort': {
        const keyed = items.map((item, i) => {
          if (!body) return { item, key: item };
          const s = new Map(scope);
          s.set('current', item);
          s.set('index', i);
          return { item, key: ev(body, s) };
        });
        keyed.sort((x, y) => compare(x.key, y.key));
        return keyed.map((k) => k.item);
      }
    }
    return err(`Unknown function ${fn}()`);
  };

  const callEager = (fn: string, a: Val[]): Val => {
    const [x, y, z] = a;
    switch (fn) {
      // ---- text
      case 'length': return isList(x) ? x.length : str(x).length;
      case 'substring': { const s = str(x); return s.substring(num(y, 'substring()'), z == null ? undefined : num(z, 'substring()')); }
      case 'slice': return isList(x) ? x.slice(num(y, 'slice()'), z == null ? undefined : num(z, 'slice()')) : str(x).slice(num(y, 'slice()'), z == null ? undefined : num(z, 'slice()'));
      case 'contains': return isList(x) ? x.some((i) => equal(i, y) || format(i) === format(y)) : str(x).includes(str(y));
      case 'test': return toRegex(y).test(str(x));
      case 'match': return [...str(x).matchAll(toRegex(y, 'g'))].map((m) => m[0]);
      case 'replace': return str(x).replace(toRegex(y), str(z));
      case 'replaceAll': return str(x).replace(toRegex(y, 'g'), str(z));
      case 'lower': return str(x).toLowerCase();
      case 'upper': return str(x).toUpperCase();
      case 'repeat': return str(x).repeat(Math.max(0, num(y, 'repeat()')));
      case 'padStart': return str(x).padStart(num(y, 'padStart()'), z == null ? ' ' : str(z));
      case 'padEnd': return str(x).padEnd(num(y, 'padEnd()'), z == null ? ' ' : str(z));
      case 'link': return str(x);
      case 'style': return str(x);
      case 'unstyle': return str(x);
      case 'format': return format(x);
      case 'trim': return str(x).trim();
      case 'split': return str(x).split(y == null ? '' : str(y));
      case 'concat': return a.every((v) => isList(v)) && a.length ? (a as Val[][]).flat(1) : a.map(str).join('');
      case 'join': return list(x, 'join').map(format).join(y == null ? '' : str(y));
      case 'toNumber': {
        if (typeof x === 'number') return x;
        if (typeof x === 'boolean') return x ? 1 : 0;
        if (isDate(x)) return x.start.getTime();
        if (x == null || x === '') return null;
        const n = parseFloat(str(x).replace(/,/g, ''));
        return Number.isNaN(n) ? null : n;
      }
      // ---- numbers
      case 'add': return typeof x === 'string' || typeof y === 'string' ? str(x) + str(y) : num(x, 'add()') + num(y, 'add()');
      case 'subtract': return num(x, 'subtract()') - num(y, 'subtract()');
      case 'multiply': return num(x, 'multiply()') * num(y, 'multiply()');
      case 'divide': { const d = num(y, 'divide()'); return d === 0 ? null : num(x, 'divide()') / d; }
      case 'pow': return num(x, 'pow()') ** num(y, 'pow()');
      case 'mod': return num(x, 'mod()') % num(y, 'mod()');
      case 'abs': return Math.abs(num(x, 'abs()'));
      case 'round': { const f = 10 ** (y == null ? 0 : num(y, 'round()')); return Math.round(num(x, 'round()') * f) / f; }
      case 'ceil': return Math.ceil(num(x, 'ceil()'));
      case 'floor': return Math.floor(num(x, 'floor()'));
      case 'sqrt': return Math.sqrt(num(x, 'sqrt()'));
      case 'cbrt': return Math.cbrt(num(x, 'cbrt()'));
      case 'exp': return Math.exp(num(x, 'exp()'));
      case 'ln': return Math.log(num(x, 'ln()'));
      case 'log10': return Math.log10(num(x, 'log10()'));
      case 'log2': return Math.log2(num(x, 'log2()'));
      case 'sign': return Math.sign(num(x, 'sign()'));
      case 'pi': return Math.PI;
      case 'e': return Math.E;
      case 'min': { const ns = flatNums(a, 'min'); return ns.length ? Math.min(...ns) : null; }
      case 'max': { const ns = flatNums(a, 'max'); return ns.length ? Math.max(...ns) : null; }
      case 'sum': return flatNums(a, 'sum').reduce((p, q) => p + q, 0);
      case 'median': return median(flatNums(a, 'median'));
      case 'mean': case 'average': { const ns = flatNums(a, 'mean'); return ns.length ? ns.reduce((p, q) => p + q, 0) / ns.length : null; }
      // ---- dates
      case 'now': return new DateVal(now);
      case 'today': return new DateVal(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
      case 'minute': return date(x, fn).start.getUTCMinutes();
      case 'hour': return date(x, fn).start.getUTCHours();
      case 'day': return date(x, fn).start.getUTCDay() || 7; // 1 = Monday … 7 = Sunday
      case 'date': return date(x, fn).start.getUTCDate();
      case 'week': return isoWeek(date(x, fn).start);
      case 'month': return date(x, fn).start.getUTCMonth() + 1;
      case 'year': return date(x, fn).start.getUTCFullYear();
      case 'dateAdd': case 'dateSubtract': {
        const d = date(x, fn);
        const amt = num(y, `${fn}()`) * (fn === 'dateSubtract' ? -1 : 1);
        const u = normUnit(z ?? 'days');
        return new DateVal(addToDate(d.start, amt, u), d.end ? addToDate(d.end, amt, u) : null);
      }
      case 'dateBetween': return dateDiff(date(x, fn).start, date(y, fn).start, normUnit(z ?? 'days'));
      case 'dateRange': return new DateVal(date(x, fn).start, date(y, fn).start);
      case 'dateStart': case 'start': return new DateVal(date(x, fn).start);
      case 'dateEnd': case 'end': { const d = date(x, fn); return new DateVal(d.end ?? d.start); }
      case 'timestamp': return date(x, fn).start.getTime();
      case 'fromTimestamp': return new DateVal(new Date(num(x, 'fromTimestamp()')));
      case 'formatDate': { const d = date(x, fn); return y == null ? defaultDateFormat(d.start) : formatDateTokens(d.start, str(y)); }
      case 'parseDate': { const d = parseDateString(str(x)); return d ?? err(`parseDate(): "${str(x)}" is not a valid date`); }
      // ---- lists
      case 'at': { const l = list(x, 'at'); const i = num(y, 'at()'); return l.at(i) ?? null; }
      case 'first': return list(x, 'first')[0] ?? null;
      case 'last': { const l = list(x, 'last'); return l[l.length - 1] ?? null; }
      case 'reverse': return [...list(x, 'reverse')].reverse();
      case 'includes': return list(x, 'includes').some((i) => equal(i, y));
      case 'unique': { const out: Val[] = []; for (const i of list(x, 'unique')) if (!out.some((o) => equal(o, i))) out.push(i); return out; }
      case 'flat': return list(x, 'flat').flat(Infinity as 1);
      // ---- logic
      case 'not': return !truthy(x);
      case 'empty': return isEmpty(x);
      case 'equal': return equal(x, y);
      case 'unequal': return !equal(x, y);
      case 'larger': return compare(x, y) > 0;
      case 'largerEq': return compare(x, y) >= 0;
      case 'smaller': return compare(x, y) < 0;
      case 'smallerEq': return compare(x, y) <= 0;
      // ---- people & pages
      case 'name': return x instanceof PersonVal ? x.name : isList(x) ? x.map((p) => (p instanceof PersonVal ? p.name : format(p))) : format(x);
      case 'email': return x instanceof PersonVal ? x.email : isList(x) ? x.map((p) => (p instanceof PersonVal ? p.email : '')) : '';
      case 'id': return x === undefined ? env.rowId ?? '' : x instanceof PageVal || x instanceof PersonVal ? x.id : '';
      case 'toString': return format(x);
    }
    return err(`Unknown function ${fn}()`);
  };

  switch (node.t) {
    case 'lit': return node.v;
    case 'list': return node.items.map((n) => ev(n));
    case 'var': {
      if (scope.has(node.name)) return scope.get(node.name)!;
      if (node.name === 'pi') return Math.PI;
      if (node.name === 'e') return Math.E;
      if (node.name === 'current' || node.name === 'index') return err(`"${node.name}" can only be used inside a list function like map() or filter()`);
      return err(`Unknown variable "${node.name}"`);
    }
    case 'prop': return env.getProp({ name: node.name, id: node.id });
    case 'index': {
      const t = ev(node.target);
      const i = num(ev(node.index), 'Index');
      return isList(t) ? t.at(i) ?? null : str(t).at(i) ?? null;
    }
    case 'cond': return truthy(ev(node.c)) ? ev(node.a) : ev(node.b);
    case 'un': {
      const v = ev(node.e);
      return node.op === '-' ? -num(v, 'Negation') : !truthy(v);
    }
    case 'bin': {
      if (node.op === '&&') return truthy(ev(node.l)) && truthy(ev(node.r));
      if (node.op === '||') return truthy(ev(node.l)) || truthy(ev(node.r));
      const l = ev(node.l), r = ev(node.r);
      switch (node.op) {
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return str(l) + str(r);
          if (isList(l) && isList(r)) return [...l, ...r];
          if (isDate(l) || isDate(r)) return err('Cannot add dates with "+"; use dateAdd()');
          return num(l, '"+"') + num(r, '"+"');
        case '-': return num(l, '"-"') - num(r, '"-"');
        case '*': return num(l, '"*"') * num(r, '"*"');
        case '/': { const d = num(r, '"/"'); return d === 0 ? null : num(l, '"/"') / d; }
        case '%': return num(l, '"%"') % num(r, '"%"');
        case '^': return num(l, '"^"') ** num(r, '"^"');
        case '==': return equal(l, r);
        case '!=': return !equal(l, r);
        case '>': return compare(l, r) > 0;
        case '<': return compare(l, r) < 0;
        case '>=': return compare(l, r) >= 0;
        case '<=': return compare(l, r) <= 0;
      }
      return err(`Unknown operator ${node.op}`);
    }
    case 'call': {
      if (LAZY.has(node.fn)) return callLazy(node.fn, undefined, node.args);
      return callEager(node.fn, node.args.map((n) => ev(n)));
    }
    case 'method': {
      const target = ev(node.target);
      if (node.fn === 'prop') {
        if (node.args.length !== 1) err('.prop() expects a property name');
        const name = str(ev(node.args[0]));
        if (target instanceof PageVal) {
          if (!env.getPageProp) return err(`Cannot read "${name}" of a related page`);
          return env.getPageProp(target, name);
        }
        if (isList(target)) return target.map((p) => (p instanceof PageVal && env.getPageProp ? env.getPageProp(p, name) : null));
        return err(`.prop() can only be used on a page, not ${typeName(target)}`);
      }
      if (LAZY.has(node.fn)) return callLazy(node.fn, target, node.args);
      return callEager(node.fn, [target, ...node.args.map((n) => ev(n))]);
    }
  }
}

/** Backwards-compatible entry point: getProp by name, returns a JSON-safe value. */
export function evalFormula(node: Node, getProp: (name: string) => Val): any {
  return serialize(evaluate(node, { getProp: (ref) => getProp(ref.name ?? ref.id ?? '') }));
}

// ---------------------------------------------------------------- database rows

export interface FormulaProp {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string }[];
  formula?: { expression: string };
  notion_id?: string;
}
export interface FormulaRow {
  id: string;
  title: string;
  props: Record<string, any>;
  created_at?: string | Date;
  updated_at?: string | Date;
  created_by?: string | null;
  updated_by?: string | null;
  /** Already-computed values (rollups) keyed by property id. */
  computed?: Record<string, any>;
}
export interface FormulaContext {
  schema: FormulaProp[];
  users: Map<string, { id: string; name: string; email?: string }>;
  /** Look up a related page row (for relations). */
  getRow?(id: string): FormulaRow | undefined;
  /** Schema of the database a related row belongs to. */
  schemaForRow?(id: string): FormulaProp[] | undefined;
  now?: Date;
  depth?: number;
}

const astCache = new Map<string, Node>();
export function parseCached(expr: string): Node {
  let n = astCache.get(expr);
  if (!n) {
    n = parseFormula(expr);
    if (astCache.size > 2000) astCache.clear();
    astCache.set(expr, n);
  }
  return n;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function person(ctx: FormulaContext, id: string): PersonVal {
  const u = ctx.users.get(id);
  return new PersonVal(id, u?.name ?? '', u?.email ?? '');
}

function fromComputed(v: any): Val {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v) && 'error' in v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new DateVal(new Date(v));
  if (Array.isArray(v)) return v.map(fromComputed);
  if (typeof v === 'object' && 'start' in v) return new DateVal(new Date(v.start), v.end ? new Date(v.end) : null);
  return v;
}

/** Typed value of a property on a row, as formulas see it. */
export function propValue(row: FormulaRow, p: FormulaProp, ctx: FormulaContext, evaluating: Set<string> = new Set()): Val {
  const raw = row.props?.[p.id];
  const opt = (id: any) => p.options?.find((o) => o.id === id)?.name ?? null;
  switch (p.type) {
    case 'title': return row.title ?? '';
    case 'text': case 'url': case 'email': case 'phone': return raw ?? '';
    case 'number': return raw == null || raw === '' ? null : Number(raw);
    case 'checkbox': return !!raw;
    case 'select': case 'status': return raw ? opt(raw) : null;
    case 'multi_select': return (Array.isArray(raw) ? raw : []).map(opt).filter((x) => x != null);
    case 'date': {
      const s = toDate(raw?.start);
      return s ? new DateVal(s, toDate(raw?.end)) : null;
    }
    case 'person': return (Array.isArray(raw) ? raw : []).map((id: string) => person(ctx, id));
    case 'files': return (Array.isArray(raw) ? raw : []).map((f: any) => f?.name ?? '');
    case 'created_time': { const d = toDate(row.created_at); return d ? new DateVal(d) : null; }
    case 'last_edited_time': { const d = toDate(row.updated_at); return d ? new DateVal(d) : null; }
    case 'created_by': return row.created_by ? person(ctx, row.created_by) : null;
    case 'last_edited_by': return row.updated_by ? person(ctx, row.updated_by) : null;
    case 'unique_id': return raw ?? row.props?.__uid ?? null;
    case 'relation': {
      const depth = ctx.depth ?? 0;
      return (Array.isArray(raw) ? raw : []).map((id: string) => {
        const r = ctx.getRow?.(id);
        return new PageVal(id, r?.title ?? '', depth < 1 ? r : undefined, depth < 1 ? ctx : undefined);
      });
    }
    case 'rollup': return fromComputed(row.computed?.[p.id]);
    case 'formula': {
      const key = `${row.id}:${p.id}`;
      if (evaluating.has(key)) return err(`Circular reference involving "${p.name}"`);
      evaluating.add(key);
      try {
        return evaluateRowValue(parseCached(p.formula?.expression ?? ''), row, ctx, evaluating);
      } finally {
        evaluating.delete(key);
      }
    }
  }
  return raw ?? null;
}

function findProp(schema: FormulaProp[], ref: { name?: string; id?: string }): FormulaProp | undefined {
  if (ref.id) return schema.find((p) => p.id === ref.id || p.notion_id === ref.id);
  const n = (ref.name ?? '').toLowerCase();
  return schema.find((p) => p.name.toLowerCase() === n) ?? schema.find((p) => p.name.trim().toLowerCase() === n.trim());
}

function evaluateRowValue(ast: Node, row: FormulaRow, ctx: FormulaContext, evaluating: Set<string>): Val {
  const env: FormulaEnv = {
    rowId: row.id,
    now: ctx.now,
    getProp(ref) {
      const p = findProp(ctx.schema, ref);
      if (!p) return err(`Unknown property "${ref.name ?? ref.id}"`);
      return propValue(row, p, ctx, evaluating);
    },
    getPageProp(page, name) {
      const r = page.row ?? ctx.getRow?.(page.id);
      if (!r) return null;
      const schema = ctx.schemaForRow?.(page.id);
      if (!schema) return null;
      const p = findProp(schema, { name });
      if (!p) return err(`Unknown property "${name}" on related page`);
      const sub: FormulaContext = { ...ctx, schema, depth: (ctx.depth ?? 0) + 1 };
      return propValue(r, p, sub, evaluating);
    },
  };
  return evaluate(ast, env);
}

/** Evaluates a formula for a database row. Returns a JSON-safe value, or { error }. */
export function evaluateRowFormula(expr: string | Node, row: FormulaRow, ctx: FormulaContext): any {
  try {
    const ast = typeof expr === 'string' ? parseCached(expr) : expr;
    return serialize(evaluateRowValue(ast, row, ctx, new Set()));
  } catch (e: any) {
    return { error: e instanceof FormulaError ? e.message : `Formula error: ${e?.message ?? e}` };
  }
}
