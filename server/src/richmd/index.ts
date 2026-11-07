/**
 * Rich markdown (Notion-flavored Markdown + Atrium extensions): server helpers on top of the pure
 * emitter/parser — reference verification, sub-page creation, text selection, and block-granular
 * patching of the live Yjs document so untouched blocks (ids, comments, concurrent edits) survive.
 */
import * as Y from 'yjs';
import { q } from '../db.js';
import { FRAGMENT, withDoc } from '../collab.js';
import { blocksToDoc } from '../markdown.js';
import { blocksToRich } from './emit.js';

export { blocksToRich, inlineToRich } from './emit.js';
export { richToBlocks, type ParseOptions, type ParseResult, type ResolvedRef } from './parse.js';

const t = (text: string) => ({ type: 'text', text, styles: {} });

function walk(blocks: any[], fn: (b: any) => void) {
  for (const b of blocks) {
    fn(b);
    if (b.children?.length) walk(b.children, fn);
  }
}

function inlineNodes(b: any): any[] {
  if (Array.isArray(b.content)) return b.content;
  if (b.content?.type === 'tableContent') return b.content.rows.flatMap((r: any) => r.cells.flatMap((c: any) => (Array.isArray(c) ? c : c.content ?? [])));
  return [];
}

/** Ids referenced by blocks: pages (sub-pages, databases, page mentions, synced sources) and users. */
export function collectRefs(blocks: any[]) {
  const pages = new Set<string>();
  const users = new Set<string>();
  walk(blocks, (b) => {
    if (b.type === 'subpage' && b.props?.pageId) pages.add(b.props.pageId);
    if (b.type === 'database' && b.props?.databaseId) pages.add(b.props.databaseId);
    if (b.type === 'syncedBlock' && b.props?.sourceId) pages.add(b.props.sourceId);
    for (const c of inlineNodes(b)) {
      if (c.type !== 'mention') continue;
      if (c.props?.kind === 'page' && c.props.id) pages.add(c.props.id);
      if (c.props?.kind === 'user' && c.props.id) users.add(c.props.id);
    }
  });
  return { pages: [...pages], users: [...users] };
}

/**
 * Check that referenced pages/users exist in this workspace. Unknown references become plain
 * text/links and are reported, never dropped silently. Mutates and returns `blocks`.
 */
export async function verifyRefs(blocks: any[], workspaceId: string, warnings: string[]): Promise<any[]> {
  const { pages, users } = collectRefs(blocks);
  const okPages = new Map<string, { kind: string; title: string }>();
  const okUsers = new Map<string, string>();
  if (pages.length) {
    for (const r of await q(`select id, kind, title from pages where id = any($1::uuid[]) and workspace_id = $2 and deleted_at is null`, [pages, workspaceId])) okPages.set(r.id, r);
  }
  if (users.length) {
    for (const r of await q(
      `select u.id, u.name from users u join workspace_members m on m.user_id = u.id where u.id = any($1::uuid[]) and m.workspace_id = $2`,
      [users, workspaceId],
    )) okUsers.set(r.id, r.name);
  }
  const warn = (m: string) => !warnings.includes(m) && warnings.push(m);
  const fixInline = (content: any[]) =>
    content.map((c: any) => {
      if (c.type !== 'mention') return c;
      if (c.props?.kind === 'page' && !okPages.has(c.props.id)) {
        warn(`Mention of unknown page ${c.props.id} kept as text`);
        return t(c.props.label || 'Unknown page');
      }
      if (c.props?.kind === 'user' && !okUsers.has(c.props.id)) {
        warn(`Mention of unknown person ${c.props.id} kept as text`);
        return t(`@${c.props.label || 'Unknown person'}`);
      }
      if (c.props?.kind === 'user' && !c.props.label) return { ...c, props: { ...c.props, label: okUsers.get(c.props.id) } };
      if (c.props?.kind === 'page' && !c.props.label) return { ...c, props: { ...c.props, label: okPages.get(c.props.id)?.title ?? '' } };
      return c;
    });
  const fix = (list: any[]): any[] =>
    list.flatMap((b) => {
      const kids = fix(b.children ?? []);
      if (b.type === 'subpage' && b.props?.pageId && !okPages.has(b.props.pageId)) {
        warn(`Sub-page ${b.props.pageId} doesn't exist; kept as text`);
        return [{ type: 'paragraph', props: {}, content: [t(b.props.title || 'Untitled')], children: kids }];
      }
      if (b.type === 'database' && (!okPages.has(b.props?.databaseId) || okPages.get(b.props.databaseId)!.kind !== 'database')) {
        warn(`Database ${b.props?.databaseId} doesn't exist; block dropped`);
        return kids;
      }
      if (b.type === 'syncedBlock' && !okPages.has(b.props?.sourceId)) {
        warn(`Synced block source ${b.props?.sourceId} doesn't exist; block dropped`);
        return kids;
      }
      const out = { ...b, children: kids };
      if (Array.isArray(b.content)) out.content = fixInline(b.content);
      else if (b.content?.type === 'tableContent')
        out.content = { ...b.content, rows: b.content.rows.map((r: any) => ({ ...r, cells: r.cells.map((c: any) => (Array.isArray(c) ? fixInline(c) : { ...c, content: fixInline(c.content ?? []) })) })) };
      return [out];
    });
  return fix(blocks);
}

/** `<page>Title</page>` without a url creates a new child page (Notion semantics). */
export async function createMissingSubpages(blocks: any[], create: (title: string) => Promise<string>): Promise<number> {
  let n = 0;
  const todo: any[] = [];
  walk(blocks, (b) => b.type === 'subpage' && !b.props?.pageId && todo.push(b));
  for (const b of todo) {
    b.props.pageId = await create(b.props.title || '');
    n++;
  }
  return n;
}

/** Titles for sub-page/database blocks, so exports carry readable labels. */
export async function refTitles(blocks: any[]): Promise<Record<string, string>> {
  const ids: string[] = [];
  walk(blocks, (b) => {
    if (b.type === 'subpage' && b.props?.pageId) ids.push(b.props.pageId);
    if (b.type === 'database' && b.props?.databaseId) ids.push(b.props.databaseId);
  });
  if (!ids.length) return {};
  const rows = await q<{ id: string; title: string }>('select id, title from pages where id = any($1::uuid[])', [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

// ---------------- selections ----------------

/** Plain text of a block (recursive), used to locate content selections. */
export function blockText(b: any): string {
  const inline = inlineNodes(b).map((c: any) => c.text ?? (Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : c.props?.label ?? c.props?.latex ?? '')).join('');
  return [inline, ...(b.children ?? []).map(blockText)].join('\n');
}

/** Top-level block range covered by "start text...end text" (Notion's selection_with_ellipsis). */
export function locate(blocks: any[], selection: string): [number, number] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const idx = selection.indexOf('...');
  const [startRaw, endRaw] = idx >= 0 ? [selection.slice(0, idx), selection.slice(idx + 3)] : [selection, selection];
  const start = norm(startRaw);
  const end = norm(endRaw);
  const texts = blocks.map((b) => norm(blockText(b)));
  const s = texts.findIndex((x) => x.includes(start));
  if (s < 0) throw new Error(`Couldn't find "${startRaw.trim()}" in the page`);
  for (let e = s; e < texts.length; e++) if (texts[e].includes(end)) return [s, e];
  throw new Error(`Couldn't find "${endRaw.trim()}" after "${startRaw.trim()}"`);
}

// ---------------- search & replace on rich markdown ----------------

export interface ContentUpdate {
  old_str: string;
  new_str: string;
  replace_all_matches?: boolean;
}

/** Notion-style update_content: exact search/replace on the page's rich markdown. */
export function applyContentUpdates(rich: string, updates: ContentUpdate[], warnings: string[]): { text: string; applied: number } {
  let text = rich;
  let applied = 0;
  for (const u of updates) {
    if (!u.old_str) continue;
    const count = text.split(u.old_str).length - 1;
    if (count === 0) {
      warnings.push(`No match for "${u.old_str.slice(0, 80)}"`);
      continue;
    }
    if (count > 1 && !u.replace_all_matches) {
      warnings.push(`"${u.old_str.slice(0, 80)}" matches ${count} times; add more context or set replace_all_matches`);
      continue;
    }
    text = u.replace_all_matches ? text.split(u.old_str).join(u.new_str) : text.replace(u.old_str, () => u.new_str);
    applied++;
  }
  return { text, applied };
}

// ---------------- block-granular patching ----------------

/**
 * Replace the page's top-level blocks with `next`, touching only the region that differs from `prev`
 * (common prefix/suffix by serialised content are left untouched in the live Yjs document).
 * `prev` must be the current document's top-level blocks.
 */
export async function patchTopLevel(pageId: string, prev: any[], next: any[]): Promise<{ changed: boolean; removed: number; inserted: number }> {
  const key = (b: any) => `${b.type}|${blocksToRich([b])}`;
  const a = prev.map(key);
  const b = next.map(key);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.length - p - s;
  const middle = next.slice(p, next.length - s);
  if (!removed && !middle.length) return { changed: false, removed: 0, inserted: 0 };

  const srcGroup = middle.length ? (blocksToDoc(middle).getXmlFragment(FRAGMENT).get(0) as Y.XmlElement | undefined) : undefined;
  const incoming = () => (srcGroup ? srcGroup.toArray().map((n) => (n as Y.XmlElement).clone()) : []);
  await withDoc(pageId, (doc) => {
    const frag = doc.getXmlFragment(FRAGMENT);
    const group = frag.get(0) as Y.XmlElement | undefined;
    if (!group || frag.length !== 1 || group.length !== prev.length) {
      // Unexpected shape (empty doc, or changed underneath us): rebuild the whole body.
      const full = blocksToDoc(next).getXmlFragment(FRAGMENT);
      frag.delete(0, frag.length);
      frag.insert(0, full.toArray().map((n) => (n as Y.XmlElement).clone()));
      return;
    }
    if (removed) group.delete(p, removed);
    const ins = incoming();
    if (ins.length) group.insert(p, ins);
    if (group.length === 0) {
      const empty = blocksToDoc([{ type: 'paragraph' }]).getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
      group.insert(0, empty.toArray().map((n) => (n as Y.XmlElement).clone()));
    }
  });
  return { changed: true, removed, inserted: middle.length };
}
