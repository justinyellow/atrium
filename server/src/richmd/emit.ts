/**
 * Atrium blocks → "rich markdown": Notion-flavored Markdown (NFM) plus a few extension attributes
 * for things NFM can't express. Lossless for every block/inline type in Atrium's schema, so an
 * agent can fetch → edit → write back without destroying structure. The dialect is summarised for agents in tools/index.ts (RICH_MD).
 */

export interface EmitOptions {
  /** Public base URL used for page links/mentions, e.g. https://atrium.example.com (no trailing slash). */
  baseUrl?: string;
  /** Optional titles for page/database ids referenced by sub-page/database blocks. */
  titles?: Record<string, string>;
}

const DEFAULT = 'default';

// ---------------- attribute helpers ----------------

export function escAttr(v: unknown): string {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#10;');
}

function attrs(list: [string, unknown][]): string {
  return list
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
}

/** Block colours → NFM `color` (text, or `<name>_bg` for background) plus `background` when both are set. */
function colorAttrs(textColor?: string, backgroundColor?: string, bgDefault = DEFAULT): [string, unknown][] {
  const t = textColor && textColor !== DEFAULT ? textColor : undefined;
  const b = backgroundColor !== undefined && backgroundColor !== bgDefault ? backgroundColor : undefined;
  if (t && b) return [['color', t], ['background', b]];
  if (t) return [['color', t]];
  if (b) return b === DEFAULT ? [['background', DEFAULT]] : [['color', `${b}_bg`]];
  return [];
}

function alignAttr(p: any): [string, unknown][] {
  return p?.textAlignment && p.textAlignment !== 'left' ? [['align', p.textAlignment]] : [];
}

// ---------------- inline ----------------

const TEXT_ESC = /[\\`*_[\]<>$~&|]/g;

function escText(s: string): string {
  return s.replace(TEXT_ESC, (c) => `\\${c}`);
}

/** Escape characters that would start a block construct at the beginning of a line. */
function escLineStarts(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)([#+\-=>])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2'))
    .join('\n');
}

function codeSpan(t: string): string {
  if (t.includes('\n') || /^`|`$/.test(t) || t === '') return `<code>${escText(t)}</code>`;
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith(' ') && t.endsWith(' ') && t.trim() ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function styledText(t: string, s: Record<string, any> = {}): string {
  // Hard line breaks: NFM trailing backslash.
  let out = s.code ? codeSpan(t) : escText(t).replace(/\n/g, '\\\n');
  if (s.strike) out = `<s>${out}</s>`;
  if (s.underline) out = `<u>${out}</u>`;
  if (s.italic) out = `<i>${out}</i>`;
  if (s.bold) out = `<b>${out}</b>`;
  if (s.backgroundColor && s.backgroundColor !== DEFAULT) out = `<span color="${escAttr(s.backgroundColor)}_bg">${out}</span>`;
  if (s.textColor && s.textColor !== DEFAULT) out = `<span color="${escAttr(s.textColor)}">${out}</span>`;
  return out;
}

function pageUrl(o: EmitOptions, id: string) {
  return `${o.baseUrl ?? ''}/p/${id}`;
}

/** Link destinations with spaces/parens/angle brackets use CommonMark's <...> form (no re-encoding). */
function urlForLink(u: string): string {
  return /[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : u;
}

/** Protect leading/trailing whitespace of each line (parsers trim and indentation means nesting). */
export function protectWs(s: string): string {
  const enc = (w: string) => w.replace(/ /g, '&#32;').replace(/\t/g, '&#9;');
  return s
    .split('\n')
    .map((line) => {
      const slashes = line.match(/\\+$/)?.[0].length ?? 0;
      const hb = slashes % 2 === 1 ? '\\' : '';
      const core = hb ? line.slice(0, -1) : line;
      return core.replace(/^[ \t]+/, enc).replace(/[ \t]+$/, enc) + hb;
    })
    .join('\n');
}

export function inlineToRich(content: any, o: EmitOptions = {}): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? escText(content) : '';
  return content
    .map((c: any) => {
      if (c.type === 'text') return styledText(c.text ?? '', c.styles);
      if (c.type === 'link') {
        const inner = Array.isArray(c.content) ? c.content.map((x: any) => styledText(x.text ?? '', x.styles)).join('') : escText(String(c.content ?? ''));
        return `[${inner}](${urlForLink(c.href ?? '')})`;
      }
      if (c.type === 'mention') {
        const p = c.props ?? {};
        if (p.kind === 'user') return `<mention url="user://${escAttr(p.id)}">${escText(p.label ?? '')}</mention>`;
        if (p.kind === 'date') {
          const v = String(p.date ?? '');
          const [d, t] = v.split('T');
          const time = t ? t.slice(0, 5) : undefined;
          return `<date${attrs([['start', d], ['start-time', time], ['iso', t ? v : undefined], ['reminder', p.reminder]])} />`;
        }
        return `<mention url="${escAttr(pageUrl(o, p.id))}">${escText(p.label ?? '')}</mention>`;
      }
      if (c.type === 'inlineEquation') return `$${String(c.props?.latex ?? '').replace(/\$/g, '\\$')}$`;
      return '';
    })
    .join('');
}

// ---------------- blocks ----------------

const isInlineBlock = (b: any) => Array.isArray(b.content);

/** Body text of a block, line-start-escaped. */
function body(b: any, o: EmitOptions) {
  return protectWs(escLineStarts(inlineToRich(b.content, o)));
}

function indent(s: string) {
  return s
    .split('\n')
    .map((l) => (l ? `\t${l}` : l))
    .join('\n');
}

/** NFM container form: <tag attrs>\nTitle\n\nchildren\n</tag> */
function container(tag: string, at: [string, unknown][], title: string, kids: string): string {
  const head = `<${tag}${attrs(at)}>`;
  const t = title === '' && kids ? '<p />' : title;
  return [head, t, ...(kids ? ['', kids] : []), `</${tag}>`].filter((x, i) => !(i === 1 && x === '')).join('\n');
}

function children(b: any, o: EmitOptions) {
  return blocksToRich(b.children ?? [], o);
}

/** Markdown list/paragraph form with tab-indented children. */
function mdWithKids(line: string, b: any, o: EmitOptions) {
  const kids = children(b, o);
  return kids ? `${line}\n${indent(kids)}` : line;
}

function mediaTag(tag: string, p: any, extra: [string, unknown][] = []) {
  const at: [string, unknown][] = [
    ['source', p.url],
    ['name', p.name],
    ...extra,
    ...(p.showPreview === false ? ([['preview', 'false']] as [string, unknown][]) : []),
    ...(p.previewWidth !== undefined && p.previewWidth !== null ? ([['width', p.previewWidth]] as [string, unknown][]) : []),
    ...alignAttr(p),
    ...colorAttrs(undefined, p.backgroundColor),
  ];
  return `<${tag}${attrs(at)}>${protectWs(escText(p.caption ?? '').replace(/\n/g, '&#10;'))}</${tag}>`;
}

function tableToRich(b: any, o: EmitOptions) {
  const t = b.content ?? {};
  const rows: any[] = t.rows ?? [];
  const headerRows = t.headerRows ?? 0;
  const headerCols = t.headerCols ?? 0;
  const lines = [`<table${attrs([['header-row', headerRows ? 'true' : undefined], ['header-rows', headerRows > 1 ? headerRows : undefined], ['header-column', headerCols ? 'true' : undefined], ['header-columns', headerCols > 1 ? headerCols : undefined], ...colorAttrs(b.props?.textColor, undefined)])}>`];
  const widths: any[] = t.columnWidths ?? [];
  if (widths.some((w) => w !== null && w !== undefined)) {
    lines.push('<colgroup>');
    for (const w of widths) lines.push(w === null || w === undefined ? '<col />' : `<col width="${w}" />`);
    lines.push('</colgroup>');
  }
  rows.forEach((r, ri) => {
    lines.push('<tr>');
    (r.cells ?? []).forEach((cell: any, ci: number) => {
      const cp = cell.props ?? {};
      const tag = ri < headerRows || ci < headerCols ? 'th' : 'td';
      const at: [string, unknown][] = [
        ...colorAttrs(cp.textColor, cp.backgroundColor),
        ['colspan', cp.colspan && cp.colspan !== 1 ? cp.colspan : undefined],
        ['rowspan', cp.rowspan && cp.rowspan !== 1 ? cp.rowspan : undefined],
        ...alignAttr(cp),
      ];
      const content = Array.isArray(cell) ? cell : cell.content ?? [];
      lines.push(`<${tag}${attrs(at)}>${protectWs(inlineToRich(content, o).replace(/\\\n/g, '<br />'))}</${tag}>`);
    });
    lines.push('</tr>');
  });
  lines.push('</table>');
  return lines.join('\n');
}

function blockToRich(b: any, o: EmitOptions, numbering: { n: number }): string {
  const p = b.props ?? {};
  const kids = () => children(b, o);
  const hasKids = (b.children ?? []).length > 0;
  const textAttrs = (): [string, unknown][] => [...colorAttrs(p.textColor, p.backgroundColor), ...alignAttr(p)];
  switch (b.type) {
    case 'paragraph': {
      const at = textAttrs();
      const t = body(b, o);
      if (!at.length && !hasKids) return t === '' ? '<p />' : t;
      if (t === '' && !hasKids) return `<p${attrs(at)} />`;
      return container('p', at, t, kids());
    }
    case 'heading': {
      const lvl = Number(p.level ?? 1);
      const at = textAttrs();
      if (p.isToggleable) return container('toggle', [['heading', `h${lvl}`], ...at], body(b, o), kids());
      if (!at.length && !hasKids && lvl <= 6) return `${'#'.repeat(lvl)} ${body(b, o)}`;
      return container(`h${lvl}`, at, body(b, o), kids());
    }
    case 'bulletListItem': {
      const at = textAttrs();
      if (at.length) return `<ul>\n${container('li', at, body(b, o), kids())}\n</ul>`;
      return mdWithKids(`- ${body(b, o)}`, b, o);
    }
    case 'numberedListItem': {
      const at = textAttrs();
      const n = p.start !== undefined && p.start !== null ? Number(p.start) : numbering.n;
      numbering.n = n + 1;
      if (at.length) return `<ol${attrs([['start', p.start]])}>\n${container('li', at, body(b, o), kids())}\n</ol>`;
      return mdWithKids(`${n}. ${body(b, o)}`, b, o);
    }
    case 'checkListItem': {
      const at = textAttrs();
      if (at.length) return container('todo', [['checked', p.checked ? 'true' : 'false'], ...at], body(b, o), kids());
      return mdWithKids(`- [${p.checked ? 'x' : ' '}] ${body(b, o)}`, b, o);
    }
    case 'toggleListItem':
      return container('toggle', textAttrs(), body(b, o), kids());
    case 'quote': {
      const at = textAttrs();
      const t = body(b, o);
      if (!at.length && !hasKids && t && !t.includes('\n')) return `> ${t}`;
      return container('quote', at, t, kids());
    }
    case 'callout':
      return container('callout', [['icon', p.emoji], ...colorAttrs(p.textColor, p.backgroundColor, 'gray')], body(b, o), kids());
    case 'divider':
      return '---';
    case 'codeBlock': {
      const code = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? '').join('') : '';
      const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r: string) => r.length));
      const fence = '`'.repeat(longest + 1);
      const lang = p.language && p.language !== 'text' ? p.language : '';
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case 'table':
      return tableToRich(b, o);
    case 'image': {
      const simple = !p.name && p.showPreview !== false && (p.previewWidth === undefined || p.previewWidth === null) && !alignAttr(p).length && (!p.backgroundColor || p.backgroundColor === DEFAULT) && !/[\[\]\n]/.test(p.caption ?? '');
      if (simple && p.url && !/^\s|\s$/.test(p.caption ?? '')) return `![${escText(p.caption ?? '')}](${urlForLink(p.url)})`;
      return mediaTag('image', p);
    }
    case 'video':
    case 'audio':
    case 'file':
      return mediaTag(b.type, p);
    case 'bookmark':
      return `<bookmark${attrs([['source', p.url], ['title', p.title], ['description', p.description], ['image', p.image], ['favicon', p.favicon]])} />`;
    case 'embed':
      return `<embed${attrs([['source', p.url], ['height', p.height !== undefined && Number(p.height) !== 400 ? p.height : undefined]])} />`;
    case 'equation':
      return `$$\n${p.latex ?? ''}\n$$`;
    case 'columnList':
      return `<columns>\n${(b.children ?? []).map((c: any) => blockToRich(c, o, { n: 1 })).join('\n')}\n</columns>`;
    case 'column': {
      const w = p.width !== undefined && Number(p.width) !== 1 ? p.width : undefined;
      const k = kids();
      return `<column${attrs([['width', w]])}>${k ? `\n${k}\n` : ''}</column>`;
    }
    case 'syncedBlock':
      return `<synced-block-reference${attrs([['url', p.sourceId ? `atrium://synced/${p.sourceId}` : undefined]])} />`;
    case 'subpage': {
      const title = o.titles?.[p.pageId] ?? p.title ?? '';
      return `<page${attrs([['url', p.pageId ? pageUrl(o, p.pageId) : undefined]])}>${protectWs(escText(title))}</page>`;
    }
    case 'database': {
      const title = o.titles?.[p.databaseId] ?? '';
      const linked = p.linked === true || p.linked === 'true';
      return `<database${attrs([['url', p.databaseId ? pageUrl(o, p.databaseId) : undefined], ['inline', linked ? undefined : 'true'], ['linked', linked ? 'true' : undefined], ['block-id', linked ? b.id : undefined]])}>${protectWs(escText(title))}</database>`;
    }
    case 'toc':
      return '<table-of-contents />';
    case 'breadcrumb':
      return '<breadcrumb />';
    case 'button':
      return `<button${attrs([['label', p.label ?? 'New button'], ['actions', p.actions && p.actions !== '[]' ? p.actions : undefined]])} />`;
    default: {
      // Unknown block types: keep their text so nothing silently disappears.
      const t = isInlineBlock(b) ? body(b, o) : '';
      return container('unknown', [['type', b.type]], t, kids());
    }
  }
}

/** Serialise blocks to rich markdown. Blocks are separated by blank lines (NFM block rule). */
export function blocksToRich(blocks: any[], o: EmitOptions = {}): string {
  const out: string[] = [];
  const numbering = { n: 1 };
  let prevType = '';
  for (const b of blocks ?? []) {
    if (b.type !== 'numberedListItem' || prevType !== 'numberedListItem') numbering.n = 1;
    out.push(blockToRich(b, o, numbering));
    prevType = b.type;
  }
  return out.join('\n\n');
}
