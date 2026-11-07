import {
  BlockNoteSchema,
  createBlockSpec,
  createInlineContentSpec,
  createStyleSpec,
  defaultBlockSpecs,
  createHeadingBlockSpec,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';
import * as Y from 'yjs';
import { FRAGMENT } from './collab.js';

// Server-side mirror of the web editor schema (same type names + props) so documents
// can be converted to/from Markdown and block JSON for the API, import and export.
const el = (tag: string, text: string) => {
  const d = document.createElement(tag);
  d.textContent = text;
  return { dom: d };
};

const subpage = createBlockSpec(
  { type: 'subpage', propSchema: { pageId: { default: '' }, title: { default: '' } }, content: 'none' },
  { render: (b) => el('a', b.props.title || 'Untitled') },
);
const callout = createBlockSpec(
  {
    type: 'callout',
    propSchema: { emoji: { default: '💡' }, backgroundColor: { default: 'gray' }, textColor: { default: 'default' } },
    content: 'inline',
  },
  {
    render: () => {
      const d = document.createElement('blockquote');
      return { dom: d, contentDOM: d };
    },
  },
);
const toc = createBlockSpec(
  { type: 'toc', propSchema: {}, content: 'none' },
  { render: () => el('div', '') },
);
// Layout blocks (columns): BlockNote core layout blocks, see web/src/components/blocks/layout.tsx.
const frame = () => {
  const d = document.createElement('div');
  return { dom: d, slot: d };
};
const columnList = createBlockSpec(
  { type: 'columnList', propSchema: {}, content: 'none', layoutOnly: true, children: { allow: ['column'], min: 2, dissolve: true } } as any,
  { renderFrame: frame } as any,
);
const column = createBlockSpec(
  { type: 'column', propSchema: { width: { default: 1 } }, content: 'none', layoutOnly: true, placeable: 'namedOnly', children: { allow: 'blocks', exclude: ['columnList'] } } as any,
  { renderFrame: frame } as any,
);
const leaf = (type: string, propSchema: Record<string, { default: any }>) =>
  createBlockSpec({ type, propSchema, content: 'none' } as any, { render: () => el('div', '') } as any) as any;
const syncedBlock = leaf('syncedBlock', { sourceId: { default: '' } });
const bookmark = leaf('bookmark', { url: { default: '' }, title: { default: '' }, description: { default: '' }, image: { default: '' }, favicon: { default: '' } });
const embed = leaf('embed', { url: { default: '' }, height: { default: 400 } });
const equation = leaf('equation', { latex: { default: '' } });
const breadcrumb = leaf('breadcrumb', {});
const button = leaf('button', { label: { default: 'New button' }, actions: { default: '[]' } });
// Inline / linked database view (web/src/database/DatabaseBlock.tsx).
const database = leaf('database', { databaseId: { default: '' }, linked: { default: false } });

const inlineEquation = createInlineContentSpec(
  { type: 'inlineEquation', propSchema: { latex: { default: '' } }, content: 'none' },
  { render: (ic) => el('span', ic.props.latex) },
);

const mention = createInlineContentSpec(
  {
    type: 'mention',
    propSchema: { kind: { default: 'page' }, id: { default: '' }, label: { default: '' }, date: { default: '' }, reminder: { default: '' } },
    content: 'none',
  },
  { render: (ic) => el('span', (ic.props.kind === 'user' ? '@' : '') + ic.props.label) },
);
const comment = createStyleSpec(
  { type: 'comment', propSchema: 'string' },
  {
    render: () => {
      const s = document.createElement('span');
      return { dom: s, contentDOM: s };
    },
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // Headings 1–4 (Notion has H4; imported workspaces use it). Must match between web and server schemas.
    heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4] }),
    subpage: subpage(),
    callout: callout(),
    toc: toc(),
    columnList: (columnList as any)(),
    column: (column as any)(),
    syncedBlock: syncedBlock(),
    bookmark: bookmark(),
    embed: embed(),
    equation: equation(),
    breadcrumb: breadcrumb(),
    button: button(),
    database: database(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention, inlineEquation },
  styleSpecs: { ...defaultStyleSpecs, comment },
});

let editor: ServerBlockNoteEditor<any, any, any> | undefined;
function ed() {
  editor ??= ServerBlockNoteEditor.create({ schema }, getDocument()) as any;
  return editor!;
}

export function docToBlocks(doc: Y.Doc): any[] {
  return ed().yXmlFragmentToBlocks(doc.getXmlFragment(FRAGMENT));
}

export function blocksToDoc(blocks: any[]): Y.Doc {
  const doc = new Y.Doc();
  ed().blocksToYXmlFragment(blocks, doc.getXmlFragment(FRAGMENT));
  return doc;
}

/** Human-readable date mention ("November 5, 2026" / "November 5, 2026 3:00 PM"). */
export function formatDateValue(v: string) {
  const timed = v.includes('T');
  const d = timed ? new Date(v) : new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return v;
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return timed ? `${date} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : date;
}

const para = (content: any[], children: any[] = []) => ({ type: 'paragraph', content, children });
const text = (t: string, styles: Record<string, any> = {}) => ({ type: 'text', text: t, styles });

/**
 * Replace synced blocks with their source content (recursively, guarding against cycles),
 * so exports show what the reader sees.
 */
export async function expandSynced(blocks: any[], load: (id: string) => Promise<Y.Doc | null>, seen: string[] = []): Promise<any[]> {
  const out: any[] = [];
  for (const b of blocks) {
    if (b.type === 'syncedBlock' && b.props.sourceId && !seen.includes(b.props.sourceId) && seen.length < 5) {
      const doc = await load(b.props.sourceId);
      if (doc) out.push(...(await expandSynced(docToBlocks(doc), load, [...seen, b.props.sourceId])));
      continue;
    }
    out.push({ ...b, children: await expandSynced(b.children ?? [], load, seen) });
  }
  return out;
}

/** Map custom blocks/inlines onto default ones that Markdown can represent. */
export function toPortableBlocks(blocks: any[]): any[] {
  const out: any[] = [];
  const fixInline = (content: any) =>
    Array.isArray(content)
      ? content.map((c: any) => {
          if (c.type === 'mention') {
            if (c.props.kind === 'page') return { type: 'link', href: `/p/${c.props.id}`, content: c.props.label || 'page' };
            if (c.props.kind === 'date') return text(`@${formatDateValue(c.props.date)}`);
            return text(`@${c.props.label}`);
          }
          if (c.type === 'inlineEquation') return text(`$${c.props.latex}$`);
          if (c.styles?.comment) {
            const { comment: _c, ...styles } = c.styles;
            return { ...c, styles };
          }
          return c;
        })
      : content;
  for (const b of blocks) {
    const kids = toPortableBlocks(b.children ?? []);
    switch (b.type) {
      case 'subpage':
        out.push(para([{ type: 'link', href: `/p/${b.props.pageId}`, content: b.props.title || 'Untitled' }]));
        break;
      case 'database':
        out.push(para([{ type: 'link', href: `/p/${b.props.databaseId}`, content: b.props.linked ? 'Linked database view' : 'Database' }]));
        break;
      case 'callout':
        out.push({ ...b, type: 'quote', props: {}, content: [text(`${b.props.emoji} `), ...(fixInline(b.content) ?? [])], children: kids });
        break;
      case 'columnList':
      case 'column':
        out.push(...kids); // columns flatten into sequential blocks
        break;
      case 'bookmark':
        if (b.props.url) out.push(para([{ type: 'link', href: b.props.url, content: b.props.title || b.props.url }]));
        break;
      case 'embed':
        if (b.props.url) out.push(para([{ type: 'link', href: b.props.url, content: b.props.url }]));
        break;
      case 'equation':
        if (b.props.latex) out.push({ type: 'codeBlock', props: { language: 'latex' }, content: [text(b.props.latex)], children: [] });
        break;
      case 'button':
        out.push(para([text(`[${b.props.label}]`, { bold: true })]));
        break;
      case 'toc':
      case 'breadcrumb':
      case 'syncedBlock': // unexpanded (no access / cycle)
        break;
      default:
        out.push({ ...b, content: fixInline(b.content), children: kids });
    }
  }
  return out;
}

export async function docToMarkdown(doc: Y.Doc, load?: (id: string) => Promise<Y.Doc | null>): Promise<string> {
  let blocks = docToBlocks(doc);
  if (load) blocks = await expandSynced(blocks, load);
  return ed().blocksToMarkdownLossy(toPortableBlocks(blocks) as any);
}

export async function markdownToDoc(md: string): Promise<Y.Doc> {
  const blocks = await ed().tryParseMarkdownToBlocks(md);
  return blocksToDoc(blocks);
}
