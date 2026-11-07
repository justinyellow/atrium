import type { AuthUser } from '../auth.js';
import { config } from '../config.js';
import { one } from '../db.js';
import { atLeast, pageLevel } from '../perms.js';
import { tools } from '../tools/index.js';
import type { ToolCtx } from '../tools/context.js';

export interface SourcePage {
  id: string;
  title: string;
  icon: string | null;
  text: string;
}

export const toolCtx = (user: AuthUser): ToolCtx => ({ user, baseUrl: config.publicUrl ?? '' });
const tool = (name: string) => tools.find((t) => t.name === name)!;

const STOP = new Set('a an and are as at be but by can do does for from has have how i in is it its me my of on or our please show tell that the their there this to us was we what when where which who why will with you your about'.split(' '));

/** Turn a natural-language question into a few keyword queries for the full-text search. */
function queries(question: string): string[] {
  const words = question.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const out = new Set<string>();
  if (question.trim().length <= 80) out.add(question.trim());
  if (words.length) out.add(words.slice(0, 4).join(' '));
  for (const w of words.slice(0, 5)) out.add(w);
  return [...out].slice(0, 6);
}

/**
 * Permission-aware retrieval: searches as the user (the search route only returns pages they can view),
 * then reads the top pages as Markdown through the same tool layer. Never sees anything the user can't.
 */
export async function retrieve(user: AuthUser, question: string, opts: { limit?: number; maxChars?: number; exclude?: string[] } = {}): Promise<SourcePage[]> {
  const limit = opts.limit ?? 5;
  const ctx = toolCtx(user);
  const scores = new Map<string, { id: string; title: string; score: number }>();
  for (const [i, qy] of queries(question).entries()) {
    let hits: any[] = [];
    try {
      hits = (await tool('search').run(ctx, { query: qy, limit: 10 })) as any[];
    } catch {
      continue;
    }
    hits.forEach((h, rank) => {
      const prev = scores.get(h.id);
      const s = (i === 0 ? 3 : 1) / (rank + 1);
      scores.set(h.id, { id: h.id, title: h.title, score: (prev?.score ?? 0) + s });
    });
  }
  const top = [...scores.values()].filter((x) => !opts.exclude?.includes(x.id)).sort((a, b) => b.score - a.score).slice(0, limit);
  const out: SourcePage[] = [];
  for (const t of top) {
    const p = await readPage(user, t.id, opts.maxChars ?? 3000);
    if (p) out.push(p);
  }
  return out;
}

/** One page as Markdown, only if the user can view it. */
export async function readPage(user: AuthUser, id: string, maxChars = 6000): Promise<SourcePage | null> {
  if (!atLeast(await pageLevel(user, id), 'view')) return null;
  try {
    const text = String(await tool('fetch').run(toolCtx(user), { id }));
    const meta = await one<{ title: string; icon: string | null }>('select title, icon from pages where id = $1', [id]);
    return { id, title: meta?.title || 'Untitled', icon: meta?.icon ?? null, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/"/g, '&quot;');

export function contextBlock(pages: SourcePage[], current?: SourcePage | null) {
  const parts: string[] = [];
  if (current) parts.push(`<current_page id="${current.id}" title="${esc(current.title)}">\n${current.text}\n</current_page>`);
  for (const p of pages) parts.push(`<page id="${p.id}" title="${esc(p.title)}">\n${p.text}\n</page>`);
  return `<workspace_context>\n${parts.join('\n\n') || '(no matching pages found)'}\n</workspace_context>`;
}
