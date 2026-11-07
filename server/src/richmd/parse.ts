/**
 * Rich markdown → Atrium blocks. Accepts Atrium's own output (see emit.ts) and Notion-flavored Markdown
 * as returned by Notion's MCP, plus plain CommonMark/GFM. Never drops content silently: anything it
 * can't represent becomes plain text/links and is reported in `warnings`.
 */

export interface ResolvedRef {
  kind: 'page' | 'user' | 'database';
  id: string;
  title?: string;
}

export interface ParseOptions {
  /** Atrium's public base URL; links under it with /p/<uuid> become mentions/sub-pages. */
  baseUrl?: string;
  /** Map foreign URLs (e.g. Notion page/user URLs during an import) to Atrium ids. */
  resolveUrl?: (url: string) => ResolvedRef | null | undefined;
  /**
   * Notion API Markdown (GET /pages/:id/markdown): every line is its own block and a container's first line is
   * its text, its following lines its children (no blank-line separation inside containers). A line ending in
   * a backslash still continues the same paragraph (hard break). Off by default (CommonMark paragraphs).
   */
  lineBlocks?: boolean;
}

export interface ParseResult {
  blocks: any[];
  warnings: string[];
}

interface Ctx extends ParseOptions {
  warnings: string[];
  usedIds: Set<string>;
}

type Styles = Record<string, any>;

const COLORS = new Set(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE_URL_RE = new RegExp(`(?:^|/)p/(${UUID})(?:[/?#]|$)`, 'i');

const warn = (ctx: Ctx, msg: string) => {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
};

// ---------------- small helpers ----------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'", '#10': '\n', nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

/** Plain (non-inline) text: backslash escapes and entities, e.g. captions and titles. */
export function unescapePlain(s: string): string {
  return s.replace(/\\([\s\S])|&(#x?[0-9a-f]+|[a-z]+);/gi, (m, esc) => (esc !== undefined ? esc : decodeEntities(m)));
}

export function parseAttrs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (s ?? '').matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = decodeEntities(m[2]);
  for (const m of (s ?? '').matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) out[m[1].toLowerCase()] ??= decodeEntities(m[2]);
  return out;
}

/** NFM color attrs → {textColor, backgroundColor}. */
function colorsFrom(a: Record<string, string>, ctx: Ctx): { textColor?: string; backgroundColor?: string } {
  const r: { textColor?: string; backgroundColor?: string } = {};
  const c = a.color;
  if (c) {
    const bg = c.endsWith('_bg') || c.endsWith('_background');
    const name = c.replace(/_(bg|background)$/, '');
    if (COLORS.has(name)) r[bg ? 'backgroundColor' : 'textColor'] = name;
    else warn(ctx, `Unknown colour "${c}" ignored`);
  }
  if (a.background && COLORS.has(a.background.replace(/_bg$/, ''))) r.backgroundColor = a.background.replace(/_bg$/, '');
  return r;
}

function alignFrom(a: Record<string, string>) {
  return a.align && ['left', 'center', 'right', 'justify'].includes(a.align) ? { textAlignment: a.align } : {};
}

function blockAttrs(a: Record<string, string>, ctx: Ctx) {
  return { ...colorsFrom(a, ctx), ...alignFrom(a) };
}

function isAtriumPageUrl(url: string, ctx: Ctx): string | null {
  if (/^atrium:\/\/page\//i.test(url)) return url.split('/').pop()!.toLowerCase();
  const m = url.match(PAGE_URL_RE);
  if (!m) return null;
  if (/^https?:\/\//i.test(url) && ctx.baseUrl) {
    try {
      if (new URL(url).host !== new URL(ctx.baseUrl).host) return null;
    } catch {
      return null;
    }
  }
  if (/notion\.(so|site|com)/i.test(url)) return null;
  return m[1].toLowerCase();
}

function resolve(url: string, ctx: Ctx): ResolvedRef | null {
  const ext = ctx.resolveUrl?.(url);
  if (ext) return ext;
  const um = url.match(new RegExp(`^user://(${UUID})$`, 'i'));
  if (um) return { kind: 'user', id: um[1].toLowerCase() };
  const pid = isAtriumPageUrl(url, ctx);
  if (pid) return { kind: 'page', id: pid };
  return null;
}

// ---------------- inline ----------------

function styleKey(s: Styles) {
  return JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
}

function pushText(out: any[], text: string, styles: Styles) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text' && styleKey(last.styles) === styleKey(styles)) last.text += text;
  else out.push({ type: 'text', text, styles: { ...styles } });
}

function mergeInline(nodes: any[]): any[] {
  const out: any[] = [];
  for (const n of nodes) {
    if (n.type === 'text') pushText(out, n.text, n.styles);
    else out.push(n);
  }
  return out;
}

/** Find the matching closing tag for an inline tag with nesting, starting after the opening tag. */
function findClose(s: string, from: number, names: string[]): { start: number; end: number } | null {
  let depth = 1;
  const re = new RegExp(`<(/?)(${names.join('|')})(?:\\s[^>]*)?(/?)>`, 'gi');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[3]) continue; // self-closing
    if (m[1]) depth--;
    else depth++;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

const INLINE_TAG_STYLES: Record<string, [string, any]> = {
  b: ['bold', true], strong: ['bold', true],
  i: ['italic', true], em: ['italic', true],
  u: ['underline', true],
  s: ['strike', true], del: ['strike', true], strike: ['strike', true],
};
const TAG_ALIASES: Record<string, string[]> = {
  b: ['b', 'strong'], strong: ['b', 'strong'], i: ['i', 'em'], em: ['i', 'em'], u: ['u'], s: ['s', 'del', 'strike'], del: ['s', 'del', 'strike'], strike: ['s', 'del', 'strike'],
};

function mentionNode(url: string, label: string, ctx: Ctx, styles: Styles): any[] {
  const ref = resolve(url, ctx);
  if (ref?.kind === 'user') return [{ type: 'mention', props: { kind: 'user', id: ref.id, label: label || ref.title || '', date: '', reminder: '' } }];
  if (ref) return [{ type: 'mention', props: { kind: 'page', id: ref.id, label: label || ref.title || '', date: '', reminder: '' } }];
  if (/^user:\/\//i.test(url)) {
    warn(ctx, `Unknown user mention ${url} kept as text`);
    return [{ type: 'text', text: `@${label || 'Unknown user'}`, styles }];
  }
  warn(ctx, `Mention of a page outside this workspace (${url}) kept as a link`);
  return [{ type: 'link', href: url.replace(/^collection:\/\//, 'https://www.notion.so/'), content: [{ type: 'text', text: label || 'Notion page', styles }] }];
}

function dateNode(a: Record<string, string>, ctx: Ctx): any {
  const start = a.start ?? a.date ?? '';
  const time = a['start-time'];
  const value = a.iso || (time ? `${start}T${time}` : start);
  if (a.end || a['end-time']) warn(ctx, 'Date range end dropped (Atrium date mentions are single dates)');
  if (a['time-zone'] && !a.iso) warn(ctx, `Date time zone "${a['time-zone']}" not kept`);
  return { type: 'mention', props: { kind: 'date', id: '', label: '', date: value, reminder: a.reminder ?? '' } };
}

const PUNCT = /[\\`*_{}[\]()#+\-.!~|<>$&"':;,=?@^/%]/;

export function parseInline(src: string, ctx: Ctx, styles: Styles = {}): any[] {
  const out: any[] = [];
  const s = src;
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) pushText(out, decodeEntities(buf), styles);
    buf = '';
  };
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;

    if (ch === '\\' && i + 1 < s.length) {
      const nx = s[i + 1];
      if (nx === '\n') { buf += '\n'; i += 2; continue; }
      if (PUNCT.test(nx)) { flush(); pushText(out, nx, styles); i += 2; continue; }
    }

    if (ch === '`') {
      const run = rest.match(/^`+/)![0];
      const close = s.indexOf(run, i + run.length);
      // require an exact-length closing run
      let c = close;
      while (c >= 0 && (s[c + run.length] === '`' || s[c - 1] === '`')) c = s.indexOf(run, c + 1);
      if (c > 0) {
        flush();
        let code = s.slice(i + run.length, c);
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        pushText(out, code, { ...styles, code: true });
        i = c + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    if (ch === '$' && s[i + 1] !== '$' && s[i + 1] && !/\s/.test(s[i + 1])) {
      let j = i + 1;
      let found = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') {
          if (!/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] ?? '')) found = j;
          break;
        }
        j++;
      }
      if (found > 0) {
        flush();
        out.push({ type: 'inlineEquation', props: { latex: s.slice(i + 1, found).replace(/\\\$/g, '$') } });
        i = found + 1;
        continue;
      }
    }

    if (ch === '<') {
      if ((m = rest.match(/^<br\s*\/?>/i))) { buf += '\n'; i += m[0].length; continue; }
      if ((m = rest.match(/^<(https?:\/\/[^>\s]+)>/))) {
        flush();
        out.push({ type: 'link', href: m[1], content: [{ type: 'text', text: m[1], styles }] });
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<(b|strong|i|em|u|s|del|strike)>/i))) {
        const tag = m[1].toLowerCase();
        const close = findClose(s, i + m[0].length, TAG_ALIASES[tag]);
        if (close) {
          flush();
          const [k, v] = INLINE_TAG_STYLES[tag];
          out.push(...parseInline(s.slice(i + m[0].length, close.start), ctx, { ...styles, [k]: v }));
          i = close.end;
          continue;
        }
      }
      if ((m = rest.match(/^<code>/i))) {
        const close = s.indexOf('</code>', i + 6);
        if (close > 0) {
          flush();
          const inner = s.slice(i + 6, close).replace(/\\(.)/gs, '$1');
          pushText(out, decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n')), { ...styles, code: true });
          i = close + 7;
          continue;
        }
      }
      if ((m = rest.match(/^<span(\s[^>]*)?>/i))) {
        const close = findClose(s, i + m[0].length, ['span']);
        if (close) {
          flush();
          const a = parseAttrs(m[1]);
          const cs = colorsFrom(a, ctx);
          const st = { ...styles };
          if (cs.textColor && cs.textColor !== 'default') st.textColor = cs.textColor;
          if (cs.backgroundColor && cs.backgroundColor !== 'default') st.backgroundColor = cs.backgroundColor;
          if (a.underline === 'true') st.underline = true;
          out.push(...parseInline(s.slice(i + m[0].length, close.start), ctx, st));
          i = close.end;
          continue;
        }
      }
      if ((m = rest.match(/^<a(\s[^>]*)>/i))) {
        const close = findClose(s, i + m[0].length, ['a']);
        if (close) {
          flush();
          const href = parseAttrs(m[1]).href ?? '';
          const inner = parseInline(s.slice(i + m[0].length, close.start), ctx, styles).filter((n) => n.type === 'text');
          out.push({ type: 'link', href, content: inner.length ? inner : [{ type: 'text', text: href, styles }] });
          i = close.end;
          continue;
        }
      }
      if ((m = rest.match(/^<(mention|mention-page|mention-user|mention-database)(\s[^>]*?)\s*\/>/i)) || (m = rest.match(/^<(mention|mention-page|mention-user|mention-database)(\s[^>]*?)>([\s\S]*?)<\/\1>/i))) {
        flush();
        const a = parseAttrs(m[2]);
        const label = m[3] ? unescapePlain(m[3].replace(/<[^>]+>/g, '')) : '';
        let url = a.url ?? a.href ?? '';
        if (m[1].toLowerCase() === 'mention-user' && url && !url.startsWith('user://') && new RegExp(`^${UUID}$`, 'i').test(url)) url = `user://${url}`;
        out.push(...mentionNode(url, label, ctx, styles));
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<(date|mention-date)(\s[^>]*?)\s*\/>/i)) || (m = rest.match(/^<(date|mention-date)(\s[^>]*?)>[\s\S]*?<\/\1>/i))) {
        flush();
        out.push(dateNode(parseAttrs(m[2]), ctx));
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<link-preview(\s[^>]*?)\s*\/>/i))) {
        flush();
        const a = parseAttrs(m[1]);
        out.push({ type: 'link', href: a.url ?? '', content: [{ type: 'text', text: a.url ?? '', styles }] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === '!' && s[i + 1] === '[') {
      const lm = matchLink(s, i + 1);
      if (lm) {
        flush();
        warn(ctx, 'Inline image converted to a link (images must be their own block)');
        out.push({ type: 'link', href: lm.url, content: [{ type: 'text', text: lm.text || lm.url, styles }] });
        i = lm.end;
        continue;
      }
    }

    if (ch === '[') {
      if ((m = rest.match(/^\[\^([^\]\s]+)\]/))) {
        flush();
        out.push({ type: 'link', href: m[1], content: [{ type: 'text', text: m[1], styles }] });
        i += m[0].length;
        continue;
      }
      const lm = matchLink(s, i);
      if (lm) {
        flush();
        const inner = parseInline(lm.text, ctx, styles);
        const textNodes = inner.flatMap((n) => (n.type === 'text' ? [n] : n.type === 'link' ? n.content : [{ type: 'text', text: n.props?.label ?? '', styles }]));
        const href = lm.url;
        out.push({ type: 'link', href, content: textNodes.length ? textNodes : [{ type: 'text', text: href, styles }] });
        i = lm.end;
        continue;
      }
    }

    // emphasis delimiters
    if ((m = rest.match(/^(\*\*|__|~~|\*|_)/))) {
      const d = m[1];
      const prev = s[i - 1] ?? ' ';
      const intraword = d.startsWith('_') && /[\p{L}\p{N}]/u.test(prev);
      if (!intraword && s[i + d.length] && !/\s/.test(s[i + d.length])) {
        let j = i + d.length;
        let close = -1;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '`') { const r = s.slice(j).match(/^`+/)![0]; const e = s.indexOf(r, j + r.length); j = e > 0 ? e + r.length : j + r.length; continue; }
          if (s.startsWith(d, j) && !/\s/.test(s[j - 1]) && (d.length === 2 || s[j + 1] !== d) && !(d.startsWith('_') && /[\p{L}\p{N}]/u.test(s[j + d.length] ?? ''))) {
            close = j;
            break;
          }
          j++;
        }
        if (close > i + d.length - 1 && close > i) {
          flush();
          const key = d === '~~' ? 'strike' : d.length === 2 ? 'bold' : 'italic';
          out.push(...parseInline(s.slice(i + d.length, close), ctx, { ...styles, [key]: true }));
          i = close + d.length;
          continue;
        }
      }
      buf += d;
      i += d.length;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return mergeInline(out);
}

function matchLink(s: string, i: number): { text: string; url: string; end: number } | null {
  if (s[i] !== '[') return null;
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') depth++;
    else if (s[j] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  let k = j + 2;
  let url = '';
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0) return null;
    url = s.slice(k + 1, e).replace(/%3C/gi, '<').replace(/%3E/gi, '>');
    k = e + 1;
    const close = s.indexOf(')', k);
    if (close < 0) return null;
    return { text: s.slice(i + 1, j), url, end: close + 1 };
  }
  let paren = 0;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '(') paren++;
    else if (c === ')') {
      if (paren === 0) break;
      paren--;
    } else if (/\s/.test(c)) break;
  }
  url = s.slice(j + 2, k);
  if (s[k] !== ')') {
    // optional title: [x](url "title")
    const t = s.slice(k).match(/^\s+"[^"]*"\)/);
    if (!t) return null;
    k += t[0].length - 1;
  }
  return { text: s.slice(i + 1, j), url, end: k + 1 };
}

// ---------------- blocks ----------------

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'blockquote', 'callout', 'toggle', 'ul', 'ol', 'li', 'todo', 'columns', 'column',
  'table', 'equation', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed', 'page', 'database', 'synced-block',
  'synced-block-reference', 'synced_block', 'synced_block_reference', 'table-of-contents', 'breadcrumb', 'button', 'unknown', 'details', 'meeting-notes', 'tabs', 'tab', 'mail',
  'custom-block', 'folder', 'external_object_instance', 'hr', 'empty-block',
]);

const TAG_LINE = /^<([a-zA-Z][\w-]*)(\s[^>]*?)?\s*(\/?)>/;

function dedent(lines: string[]): string[] {
  const ind = lines.filter((l) => l.trim()).map((l) => (l.match(/^[\t ]*/)![0]));
  if (!ind.length) return lines;
  // one tab or the smallest run of spaces
  const minTabs = Math.min(...ind.map((x) => (x.match(/^\t*/)![0].length)));
  if (minTabs > 0) return lines.map((l) => (l.startsWith('\t') ? l.slice(1) : l.replace(/^ {1,4}/, '')));
  const min = Math.min(...ind.map((x) => x.length));
  return lines.map((l) => l.slice(Math.min(min, l.match(/^ */)![0].length)));
}

function isBlockStart(line: string): boolean {
  const t = line;
  if (/^(#{1,6})\s/.test(t)) return true;
  if (/^([-*+])(\s|$)/.test(t)) return true;
  if (/^\d+[.)](\s|$)/.test(t)) return true;
  if (/^>/.test(t)) return true;
  if (/^(`{3,}|~{3,})/.test(t)) return true;
  if (/^\$\$\s*$/.test(t)) return true;
  if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(t)) return true;
  if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(t)) return true;
  if (/^\|/.test(t)) return true;
  const m = t.match(TAG_LINE);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return true;
  if (/^<\/[a-zA-Z]/.test(t)) return true;
  return false;
}

/** Join paragraph lines: trailing backslash = hard break, otherwise soft break (space). */
function joinLines(lines: string[]): string {
  let out = '';
  lines.forEach((l, idx) => {
    if (idx === lines.length - 1) {
      out += l;
      return;
    }
    const trailing = l.match(/\\+$/)?.[0].length ?? 0;
    if (trailing % 2 === 1) out += `${l.slice(0, -1)}\\\n`;
    else if (/ {2,}$/.test(l)) out += `${l.replace(/ +$/, '')}\\\n`;
    else out += `${l} `;
  });
  return out;
}

interface NumState {
  active: boolean;
  last: number;
}

/** Scan forward from (line, col) for the close of <tag>, handling nesting and skipping fenced code. */
function findBlockClose(lines: string[], li: number, col: number, tag: string): { line: number; start: number; end: number } | null {
  let depth = 1;
  let fence: string | null = null;
  const re = new RegExp(`<(/?)${tag.replace(/[-]/g, '\\-')}(?=[\\s>/])[^>]*?(/?)>`, 'gi');
  for (let l = li; l < lines.length; l++) {
    const line = lines[l];
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && line.trim() === fm[1]) fence = null;
      continue;
    }
    if (fm && l !== li) {
      fence = fm[1];
      continue;
    }
    re.lastIndex = l === li ? col : 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[2]) continue;
      if (m[1]) depth--;
      else depth++;
      if (depth === 0) return { line: l, start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/** Split a container's inner lines into title (until first blank line) and children lines. */
function splitTitle(inner: string[], lineBlocks = false): { title: string | null; kids: string[] } {
  let k = 0;
  while (k < inner.length && inner[k].trim() === '' && k < 1) k++;
  const lines = inner.slice(k);
  if (!lines.length) return { title: '', kids: [] };
  if (/^<p\s*\/>\s*$/.test(lines[0].trim()) || /^<empty-block\s*\/>$/.test(lines[0].trim())) return { title: '', kids: lines.slice(1) };
  if (isBlockStart(lines[0].trimStart())) return { title: '', kids: lines };
  const blank = lines.findIndex((l) => l.trim() === '');
  if (lineBlocks) {
    // Title = first line (plus hard-break continuations); every following line is a child block.
    let end = 1;
    while (end < lines.length && /(^|[^\\])(\\\\)*\\$/.test(lines[end - 1].trimEnd()) && lines[end].trim()) end++;
    const rest = lines.slice(end);
    while (rest.length && rest[0].trim() === '') rest.shift();
    return { title: joinLines(lines.slice(0, end).map((l) => l.trim())), kids: rest };
  }
  if (blank < 0) return { title: joinLines(lines.map((l) => l.trim())), kids: [] };
  return { title: joinLines(lines.slice(0, blank).map((l) => l.trim())), kids: lines.slice(blank + 1) };
}

function inl(text: string, ctx: Ctx) {
  return parseInline(text, ctx);
}

function newId(ctx: Ctx, id?: string): string | undefined {
  if (!id || ctx.usedIds.has(id)) return undefined;
  ctx.usedIds.add(id);
  return id;
}

function mediaBlock(type: string, a: Record<string, string>, caption: string, ctx: Ctx) {
  const props: any = { url: a.source ?? a.src ?? a.url ?? '', caption: unescapePlain(caption.trim()), ...blockAttrs(a, ctx) };
  if (a.name) props.name = a.name;
  if (a.preview === 'false') props.showPreview = false;
  if (a.width && !Number.isNaN(Number(a.width)) && type !== 'file' && type !== 'audio') props.previewWidth = Number(a.width);
  delete props.textColor;
  if (/^notion-file-block:|^attachment:/.test(props.url)) warn(ctx, `File "${props.name || props.url}" is a Notion upload reference; it must be re-uploaded`);
  return { type, props, children: [] };
}

function tableBlock(attrsStr: string | undefined, innerText: string, ctx: Ctx) {
  const a = parseAttrs(attrsStr);
  const widths: (number | null)[] = [];
  const colColors: Record<number, any> = {};
  const cg = innerText.match(/<colgroup>([\s\S]*?)<\/colgroup>/i);
  if (cg) {
    [...cg[1].matchAll(/<col(\s[^>]*?)?\s*\/?>/gi)].forEach((m, idx) => {
      const ca = parseAttrs(m[1]);
      widths.push(ca.width && !Number.isNaN(Number(ca.width)) ? Number(ca.width) : null);
      const c = colorsFrom(ca, ctx);
      if (c.textColor || c.backgroundColor) colColors[idx] = c;
    });
  }
  const rows: any[] = [];
  let allThFirstRow = true;
  [...innerText.matchAll(/<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/gi)].forEach((rm, ri) => {
    const rowColor = colorsFrom(parseAttrs(rm[1]), ctx);
    const cells: any[] = [];
    [...rm[2].matchAll(/<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].forEach((cm, ci) => {
      if (ri === 0 && cm[1].toLowerCase() !== 'th') allThFirstRow = false;
      const ca = parseAttrs(cm[2]);
      const text = cm[3].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      const props: any = { ...(colColors[ci] ?? {}), ...rowColor, ...colorsFrom(ca, ctx), ...alignFrom(ca) };
      if (ca.colspan) props.colspan = Number(ca.colspan);
      if (ca.rowspan) props.rowspan = Number(ca.rowspan);
      cells.push({ type: 'tableCell', props, content: inl(text, ctx) });
    });
    rows.push({ cells });
  });
  const cols = Math.max(widths.length, ...rows.map((r) => r.cells.reduce((n: number, c: any) => n + (c.props.colspan ?? 1), 0)), 1);
  while (widths.length < cols) widths.push(null);
  const headerRows = a['header-rows'] ? Number(a['header-rows']) : a['header-row'] === 'true' || (rows.length > 1 && allThFirstRow && a['header-row'] !== 'false') ? 1 : 0;
  const headerCols = a['header-columns'] ? Number(a['header-columns']) : a['header-column'] === 'true' ? 1 : 0;
  const content: any = { type: 'tableContent', columnWidths: widths, rows };
  if (headerRows) content.headerRows = headerRows;
  if (headerCols) content.headerCols = headerCols;
  const tc = colorsFrom(a, ctx).textColor;
  return { type: 'table', props: tc ? { textColor: tc } : {}, content, children: [] };
}

function splitPipeRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '\\' && l[i + 1] === '|') { cur += '|'; i++; continue; }
    if (l[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += l[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseBlocks(lines: string[], ctx: Ctx, list?: { type: 'bullet' | 'number'; start?: number }, num: NumState = { active: false, last: 0 }): any[] {
  const out: any[] = [];
  let i = 0;
  const push = (b: any) => {
    if (b.type !== 'numberedListItem') num.active = false;
    out.push(b);
  };
  const pushNumbered = (b: any, n: number, setStart: boolean) => {
    if (setStart) b.props = { ...b.props, start: n };
    num.active = true;
    num.last = n;
    out.push(b);
  };

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '') {
      i++;
      continue;
    }

    // Indented lines belong to the previous block as children (Notion uses tab-indented children).
    if (/^(\t| {2,})/.test(raw) && out.length) {
      const chunk: string[] = [];
      while (i < lines.length && (lines[i].trim() === '' || /^(\t| {2,})/.test(lines[i]))) chunk.push(lines[i++]);
      while (chunk.length && chunk[chunk.length - 1].trim() === '') chunk.pop();
      const prev = out[out.length - 1];
      const kids = parseBlocks(dedent(chunk), ctx);
      if (prev.type === 'columnList' || prev.type === 'table') out.push(...kids);
      else prev.children = [...(prev.children ?? []), ...kids];
      continue;
    }
    const line = raw.replace(/^\s+/, '');
    let m: RegExpMatchArray | null;

    // fenced code
    if ((m = line.match(/^(`{3,}|~{3,})\s*([^`\s]*)\s*$/))) {
      const fence = m[1];
      const lang = m[2] || 'text';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.length >= fence.length && t === fence[0].repeat(t.length)) break;
        body.push(lines[i++]);
      }
      i++;
      push({ type: 'codeBlock', props: { language: lang }, content: [{ type: 'text', text: body.join('\n'), styles: {} }], children: [] });
      continue;
    }

    // display math
    if (/^\$\$\s*$/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      push({ type: 'equation', props: { latex: body.join('\n') }, children: [] });
      continue;
    }
    if ((m = line.match(/^\$\$(.+)\$\$\s*$/))) {
      push({ type: 'equation', props: { latex: m[1].trim() }, children: [] });
      i++;
      continue;
    }

    // divider
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line)) {
      push({ type: 'divider', props: {}, children: [] });
      i++;
      continue;
    }

    // headings
    if ((m = line.match(/^(#{1,6})\s+(.*)$/)) || (m = line.match(/^(#{1,6})$/))) {
      push({ type: 'heading', props: { level: Math.min(m[1].length, 4) }, content: inl(m[2] ?? '', ctx), children: [] });
      i++;
      continue;
    }

    // block image
    if ((m = line.match(/^!\[(.*)\]\(<([^>]*)>\)\s*$/)) || (m = line.match(/^!\[(.*)\]\((\S*?)(?:\s+"[^"]*")?\)\s*$/))) {
      push({ type: 'image', props: { url: m[2].replace(/%3C/gi, '<').replace(/%3E/gi, '>'), caption: unescapePlain(m[1]) }, children: [] });
      i++;
      continue;
    }

    // pipe table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitPipeRow(line);
      const rows = [header];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitPipeRow(lines[i++]));
      const cols = Math.max(...rows.map((r) => r.length));
      push({
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          columnWidths: Array(cols).fill(null),
          headerRows: 1,
          rows: rows.map((r) => ({ cells: Array.from({ length: cols }, (_, ci) => ({ type: 'tableCell', props: {}, content: inl(r[ci] ?? '', ctx) })) })),
        },
        children: [],
      });
      continue;
    }

    // list items (markdown)
    if ((m = line.match(/^[-*+]\s+\[( |x|X)\]\s?(.*)$/))) {
      push({ type: 'checkListItem', props: { checked: m[1].toLowerCase() === 'x' }, content: inl(m[2], ctx), children: [] });
      i++;
      continue;
    }
    if ((m = line.match(/^[-*+](?:\s+(.*))?$/))) {
      push({ type: 'bulletListItem', props: {}, content: inl(m[1] ?? '', ctx), children: [] });
      i++;
      continue;
    }
    if ((m = line.match(/^(\d+)[.)](?:\s+(.*))?$/))) {
      const n = Number(m[1]);
      const expected = num.active ? num.last + 1 : 1;
      pushNumbered({ type: 'numberedListItem', props: {}, content: inl(m[2] ?? '', ctx), children: [] }, n, n !== expected);
      i++;
      continue;
    }

    // markdown quote
    if (/^>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
      const { title, kids } = splitTitle(body, !!ctx.lineBlocks);
      push({ type: 'quote', props: {}, content: inl(title ?? '', ctx), children: parseBlocks(kids, ctx) });
      continue;
    }

    // XML-style block tags
    if ((m = line.match(TAG_LINE)) && BLOCK_TAGS.has(m[1].toLowerCase())) {
      // Notion's API spells synced blocks with underscores; Notion's MCP with hyphens.
      const tag = m[1].toLowerCase().replace(/^synced_block(_reference)?$/, (x) => x.replace(/_/g, '-'));
      const a = parseAttrs(m[2]);
      const selfClosing = !!m[3];
      const afterOpen = raw.indexOf(m[0]) + m[0].length;
      let innerLines: string[] = [];
      let next = i + 1;
      if (!selfClosing) {
        const close = findBlockClose(lines, i, afterOpen, m[1]);
        if (!close) {
          warn(ctx, `Unclosed <${tag}> treated as text`);
          push({ type: 'paragraph', props: {}, content: inl(line, ctx), children: [] });
          i++;
          continue;
        }
        if (close.line === i) innerLines = [raw.slice(afterOpen, close.start)];
        else innerLines = [raw.slice(afterOpen), ...lines.slice(i + 1, close.line), lines[close.line].slice(0, close.start)];
        const trailing = lines[close.line].slice(close.end);
        next = close.line + 1;
        if (trailing.trim()) {
          lines = [...lines.slice(0, next), trailing, ...lines.slice(next)];
        }
        // drop the empty first/last fragments produced by multi-line tags
        if (innerLines.length > 1 && innerLines[0].trim() === '') innerLines.shift();
        if (innerLines.length > 1 && innerLines[innerLines.length - 1].trim() === '') innerLines.pop();
      }
      i = next;
      const innerText = innerLines.join('\n');
      const container = () => splitTitle(innerLines, !!ctx.lineBlocks);
      const titleBlock = (type: string, props: any) => {
        const { title, kids } = container();
        return { type, props, content: inl(title ?? '', ctx), children: parseBlocks(dedent(kids), ctx) };
      };
      switch (tag) {
        case 'p':
        case 'empty-block':
          push(titleBlock('paragraph', blockAttrs(a, ctx)));
          break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          push(titleBlock('heading', { level: Math.min(Number(tag[1]), 4), ...blockAttrs(a, ctx) }));
          break;
        case 'toggle': {
          const h = a.heading?.match(/^h([1-6])$/);
          push(h ? titleBlock('heading', { level: Math.min(Number(h[1]), 4), isToggleable: true, ...blockAttrs(a, ctx) }) : titleBlock('toggleListItem', blockAttrs(a, ctx)));
          break;
        }
        case 'details': {
          const sm = innerText.match(/^\s*<summary>([\s\S]*?)<\/summary>[ \t]*\n?/i); // keep the next line's indent
          const title = sm ? sm[1].trim() : '';
          const restLines = (sm ? innerText.slice(sm[0].length) : innerText).split('\n');
          push({ type: 'toggleListItem', props: blockAttrs(a, ctx), content: inl(title, ctx), children: parseBlocks(dedent(restLines), ctx) });
          break;
        }
        case 'quote':
        case 'blockquote':
          push(titleBlock('quote', blockAttrs(a, ctx)));
          break;
        case 'callout': {
          const c = colorsFrom(a, ctx);
          const props: any = { ...c };
          if (a.icon) {
            if (/^(icons\/|https?:)/.test(a.icon)) warn(ctx, `Callout icon "${a.icon}" isn't an emoji; kept as text`);
            props.emoji = a.icon;
          }
          push(titleBlock('callout', props));
          break;
        }
        case 'todo':
          push(titleBlock('checkListItem', { checked: a.checked === 'true', ...blockAttrs(a, ctx) }));
          break;
        case 'ul':
        case 'ol': {
          const sub = parseBlocks(dedent(innerLines), ctx, { type: tag === 'ul' ? 'bullet' : 'number', start: a.start ? Number(a.start) : undefined }, num);
          for (const b of sub) {
            if (b.type === 'numberedListItem') out.push(b);
            else push(b);
          }
          if (tag === 'ul') num.active = false;
          break;
        }
        case 'li': {
          const kind = list?.type === 'number' ? 'numberedListItem' : 'bulletListItem';
          const b = titleBlock(kind, blockAttrs(a, ctx));
          if (kind === 'numberedListItem') {
            const first = !out.some((x) => x.type === 'numberedListItem');
            const explicit = first && list?.start !== undefined ? list.start : undefined;
            const n = explicit ?? (num.active ? num.last + 1 : 1);
            pushNumbered(b, n, explicit !== undefined);
          } else push(b);
          break;
        }
        case 'columns': {
          // Notion indents each <column> under <columns>; dedent so sibling columns aren't read as nested children.
          const cols = parseBlocks(dedent(innerLines), ctx).filter((b) => b.type === 'column');
          if (cols.length >= 2) push({ type: 'columnList', props: {}, children: cols });
          else for (const c of cols) for (const k of c.children ?? []) push(k);
          break;
        }
        case 'column': {
          const props: any = {};
          if (a.width && !Number.isNaN(Number(a.width))) props.width = Number(a.width);
          else if (a.ratio && !Number.isNaN(Number(a.ratio))) props.width = Number(a.ratio);
          const kids = parseBlocks(dedent(innerLines), ctx);
          out.push({ type: 'column', props, children: kids.length ? kids : [{ type: 'paragraph', props: {}, content: [], children: [] }] });
          break;
        }
        case 'table':
          push(tableBlock(m[2], innerText, ctx));
          break;
        case 'equation':
          push({ type: 'equation', props: { latex: decodeEntities(innerText.trim()) }, children: [] });
          break;
        case 'image':
        case 'video':
        case 'audio':
        case 'file':
        case 'pdf':
          push(mediaBlock(tag === 'pdf' ? 'file' : tag, a, innerText, ctx));
          break;
        case 'bookmark': {
          const props: any = { url: a.source ?? a.url ?? '' };
          for (const k of ['title', 'description', 'image', 'favicon']) if (a[k]) props[k] = a[k];
          if (!props.title && innerText.trim()) props.title = decodeEntities(innerText.trim());
          push({ type: 'bookmark', props, children: [] });
          break;
        }
        case 'embed': {
          const props: any = { url: a.source ?? a.src ?? a.url ?? '' };
          if (a.height && !Number.isNaN(Number(a.height))) props.height = Number(a.height);
          push({ type: 'embed', props, children: [] });
          break;
        }
        case 'page': {
          const title = unescapePlain(innerText.trim());
          const url = a.url ?? '';
          const ref = url ? resolve(url, ctx) : null;
          if (!url) push({ type: 'subpage', props: { pageId: '', title }, children: [] });
          else if (ref && ref.kind !== 'user') push({ type: 'subpage', props: { pageId: ref.id, title: title || ref.title || '' }, children: [] });
          else {
            warn(ctx, `Sub-page "${title || url}" is outside this workspace; kept as a link`);
            push({ type: 'paragraph', props: {}, content: [{ type: 'link', href: url, content: [{ type: 'text', text: title || url, styles: {} }] }], children: [] });
          }
          break;
        }
        case 'database': {
          const title = unescapePlain(innerText.trim());
          const url = a.url ?? '';
          const ref = url ? resolve(url, ctx) : null;
          if (ref && ref.kind !== 'user') {
            const b: any = { type: 'database', props: { databaseId: ref.id, linked: a.linked === 'true' }, children: [] };
            const id = newId(ctx, a['block-id']);
            if (id) b.id = id;
            push(b);
          } else {
            warn(ctx, url ? `Database "${title || url}" is outside this workspace; kept as a link` : `Database "${title}" has no url; skipped (create databases with create-database)`);
            if (url) push({ type: 'paragraph', props: {}, content: [{ type: 'link', href: url, content: [{ type: 'text', text: title || 'Database', styles: {} }] }], children: [] });
          }
          break;
        }
        case 'synced-block':
        case 'synced-block-reference': {
          const url = a.url ?? '';
          const sm = url.match(/^atrium:\/\/synced\/([0-9a-f-]{36})$/i);
          if (sm) push({ type: 'syncedBlock', props: { sourceId: sm[1].toLowerCase() }, children: [] });
          else {
            const kids = parseBlocks(dedent(innerLines), ctx);
            warn(ctx, kids.length ? 'Synced block from outside this workspace copied as regular blocks' : `Synced block reference ${url || ''} dropped (source not in this workspace)`.trim());
            for (const k of kids) push(k);
          }
          break;
        }
        case 'table-of-contents':
          push({ type: 'toc', props: {}, children: [] });
          break;
        case 'breadcrumb':
          push({ type: 'breadcrumb', props: {}, children: [] });
          break;
        case 'button': {
          const props: any = { label: a.label ?? decodeEntities(innerText.trim()) ?? 'New button' };
          if (a.actions) props.actions = a.actions;
          push({ type: 'button', props, children: [] });
          break;
        }
        case 'hr':
          push({ type: 'divider', props: {}, children: [] });
          break;
        case 'meeting-notes':
        case 'tabs':
        case 'tab':
        case 'mail': {
          warn(ctx, `<${tag}> isn't supported; its content was kept as regular blocks`);
          const { title, kids } = container();
          if (title) push({ type: 'heading', props: { level: 3 }, content: inl(title, ctx), children: [] });
          const inner = kids.join('\n').replace(/<\/?meeting-notes-section-[a-z]+>/gi, '').split('\n');
          for (const k of parseBlocks(dedent(inner), ctx)) push(k);
          break;
        }
        case 'unknown':
        case 'custom-block':
        case 'folder':
        case 'external_object_instance': {
          const url = a.url ?? '';
          const label = a.alt ?? a.type ?? tag;
          warn(ctx, `Unsupported block (${label}) kept as ${url ? 'a link' : 'text'}`);
          const { title, kids } = container();
          const content = url ? [{ type: 'link', href: url, content: [{ type: 'text', text: title || label, styles: {} }] }] : inl(title || '', ctx);
          if (url || title) push({ type: 'paragraph', props: {}, content, children: parseBlocks(dedent(kids), ctx) });
          else for (const k of parseBlocks(dedent(kids), ctx)) push(k);
          break;
        }
        default:
          push({ type: 'paragraph', props: {}, content: inl(innerText, ctx), children: [] });
      }
      continue;
    }

    // closing tag with no opener: drop with a warning rather than printing it
    if (/^<\/[a-zA-Z][\w-]*>\s*$/.test(line)) {
      warn(ctx, `Stray ${line.trim()} ignored`);
      i++;
      continue;
    }

    // paragraph: accumulate until blank line or the start of another block
    const para: string[] = [line];
    i++;
    const hardBreak = (l: string) => /(^|[^\\])(\\\\)*\\$/.test(l.trimEnd());
    while (
      i < lines.length && lines[i].trim() !== '' && !/^(\t| {2,})/.test(lines[i]) && !isBlockStart(lines[i]) &&
      (!ctx.lineBlocks || hardBreak(para[para.length - 1]))
    ) para.push(lines[i++]);
    push({ type: 'paragraph', props: {}, content: inl(joinLines(para), ctx), children: [] });
  }
  return out;
}

/** Parse rich markdown (Atrium or Notion flavour) into Atrium blocks. */
export function richToBlocks(src: string, opts: ParseOptions = {}): ParseResult {
  const ctx: Ctx = { ...opts, warnings: [], usedIds: new Set() };
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const blocks = parseBlocks(alignNestedTables(joinSplitInlineTags(text.split('\n'))), ctx);
  return { blocks, warnings: ctx.warnings };
}

const INLINE_PAIRED = ['mention-page', 'mention-database', 'mention-data-source', 'mention-user', 'mention-date', 'mention', 'span'];

/**
 * A mention whose label contains a line break (e.g. a database title with a newline) is emitted by Notion across
 * two lines, the second one unindented — which would break indentation-based nesting. Rejoin such lines.
 */
export function joinSplitInlineTags(lines: string[]): string[] {
  const out: string[] = [];
  const open = (l: string) =>
    INLINE_PAIRED.reduce((n, t) => {
      const opens = (l.match(new RegExp(`<${t}(?=[\\s>])[^>]*?(?<!/)>`, 'g')) ?? []).length;
      const closes = (l.match(new RegExp(`</${t}>`, 'g')) ?? []).length;
      return n + Math.max(0, opens - closes);
    }, 0);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    // At most a few joins: a genuinely unclosed tag must not swallow the rest of the page.
    for (let k = 0; k < 3 && open(l) > 0 && i + 1 < lines.length && /^\s*[^\s<]|^\s*<\//.test(lines[i + 1]); k++) l = `${l} ${lines[++i].trim()}`;
    out.push(l);
  }
  return out;
}

/**
 * Notion indents a nested table's opening tag (and <colgroup>) to its parent's depth but emits the <tr>/<td>
 * lines at column 0. Re-indent every line of such a table to the depth of its <table> line so the
 * indentation-based nesting (lists, toggles, columns) keeps the table inside its parent.
 */
export function alignNestedTables(lines: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let indent = '';
  for (const l of lines) {
    if (depth === 0) {
      const opens = l.match(/<table\b/g)?.length ?? 0;
      const closes = l.match(/<\/table>/g)?.length ?? 0;
      if (opens > closes) {
        indent = l.match(/^[\t ]*/)![0];
        depth = opens - closes;
      }
      out.push(l);
      continue;
    }
    const own = l.match(/^[\t ]*/)![0];
    out.push(own.length < indent.length && l.trim() ? indent + l.slice(own.length) : l);
    depth += (l.match(/<table\b/g)?.length ?? 0) - (l.match(/<\/table>/g)?.length ?? 0);
  }
  return out;
}
