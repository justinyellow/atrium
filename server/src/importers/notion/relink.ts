/**
 * Relink pass: after more of a Notion workspace has been imported (a later run, follow-links, another
 * teamspace), rewrite links in earlier imported pages that still point at Notion so they point at the Atrium
 * copies — page links become page mentions, database links become embedded database blocks.
 *
 * Only pages that recorded unresolved Notion targets (import_mappings.meta.unresolved) are touched, and
 * only top-level blocks that actually change are rewritten (patchTopLevel), so it's cheap and safe to re-run.
 */
import { q } from '../../db.js';
import { docToBlocks } from '../../markdown.js';
import { loadDocSnapshot, persistDoc } from '../../collab.js';
import { patchTopLevel } from '../../richmd/index.js';
import { emit } from '../../events.js';
import { notionIdFromUrl as notionId } from './importer.js';

export interface RelinkResult { pagesChecked: number; pagesChanged: number; linksFixed: number; stillUnresolved: number }

export async function relinkImported(workspaceId: string, opts: { userId?: string | null } = {}): Promise<RelinkResult> {
  const pending = await q<{ source_id: string; atrium_id: string; unresolved: string[] }>(
    `select m.source_id, m.atrium_id, coalesce(m.meta->'unresolved', '[]'::jsonb) as unresolved
     from import_mappings m join pages p on p.id = m.atrium_id
     where m.source = 'notion' and p.workspace_id = $1 and p.deleted_at is null and p.kind <> 'database'
       and jsonb_array_length(coalesce(m.meta->'unresolved', '[]'::jsonb)) > 0`,
    [workspaceId],
  );
  const result: RelinkResult = { pagesChecked: pending.length, pagesChanged: 0, linksFixed: 0, stillUnresolved: 0 };
  if (!pending.length) return result;
  const targets = [...new Set(pending.flatMap((p) => p.unresolved))];
  const mapped = await q<{ source_id: string; atrium_id: string; kind: string; title: string }>(
    `select m.source_id, m.atrium_id, m.kind, p.title from import_mappings m join pages p on p.id = m.atrium_id
     where m.source = 'notion' and m.source_id = any($1::text[]) and p.deleted_at is null`,
    [targets],
  );
  const map = new Map(mapped.map((m) => [m.source_id, m]));
  for (const page of pending) {
    const resolvable = page.unresolved.filter((t) => map.has(t));
    const remaining = page.unresolved.filter((t) => !map.has(t));
    if (resolvable.length) {
      const prev = docToBlocks(await loadDocSnapshot(page.atrium_id));
      const next = JSON.parse(JSON.stringify(prev));
      let fixed = 0;
      const fixInline = (content: any[]): any[] =>
        content.map((c) => {
          if (c?.type !== 'link') return c;
          const nid = notionId(c.href ?? '');
          const m = nid ? map.get(nid) : undefined;
          if (!m) return c;
          fixed++;
          const label = (c.content ?? []).map((x: any) => x.text ?? '').join('') || m.title;
          return { type: 'mention', props: { kind: 'page', id: m.atrium_id, label, date: '', reminder: '' } };
        });
      const walk = (blocks: any[]): any[] =>
        blocks.map((b) => {
          // A paragraph that is just a link to an imported database (Markdown fallback) becomes the database block.
          const only = Array.isArray(b.content) && b.content.length === 1 ? b.content[0] : null;
          const target = only?.type === 'link' ? map.get(notionId(only.href ?? '') ?? '') : undefined;
          if (b.type === 'paragraph' && target?.kind === 'database') {
            fixed++;
            return { type: 'database', props: { databaseId: target.atrium_id, linked: false }, children: walk(b.children ?? []) };
          }
          return { ...b, ...(Array.isArray(b.content) ? { content: fixInline(b.content) } : {}), children: walk(b.children ?? []) };
        });
      const out = walk(next);
      if (fixed) {
        const r = await patchTopLevel(page.atrium_id, prev, out);
        if (r.changed) {
          await persistDoc(page.atrium_id, await loadDocSnapshot(page.atrium_id), opts.userId ?? null);
          emit({ type: 'page', id: page.atrium_id });
          result.pagesChanged++;
          result.linksFixed += fixed;
        }
      }
    }
    result.stillUnresolved += remaining.length;
    await q(`update import_mappings set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('unresolved', $2::jsonb) where source = 'notion' and source_id = $1`, [
      page.source_id,
      JSON.stringify(remaining),
    ]);
  }
  return result;
}
