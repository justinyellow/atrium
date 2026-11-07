/**
 * Read-only Notion import dry runs from the command line (no Atrium writes).
 *
 *   NOTION_TOKEN=… npx tsx src/importers/notion/cli.ts census --out ../.import/census.json [--roots id,id] [--max 500]
 *   NOTION_TOKEN=… npx tsx src/importers/notion/cli.ts bench --roots id,id --max 60
 *   NOTION_TOKEN=… npx tsx src/importers/notion/cli.ts sample --strata strata.json --out ../.import/census-sample.json [--minutes 35]
 *
 * census: discover everything the integration can see (or --roots), convert in memory, write counts only.
 * bench:  the same sample twice — legacy settings (block tree, 1 worker) vs current (Markdown, 4 workers).
 * The token is read from the environment and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { one, pool } from '../../db.js';
import { loadUser } from '../../auth.js';
import { NotionImport, type ImportOptions } from './importer.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const token = process.env.NOTION_TOKEN;
if (!token) throw new Error('NOTION_TOKEN is not set');

async function admin() {
  const u = await one<{ id: string }>(`select u.id from users u join workspace_members m on m.user_id = u.id where m.role = 'owner' order by u.created_at limit 1`);
  if (!u) throw new Error('No workspace owner found in the local database');
  return (await loadUser(u.id, 'session'))!;
}

async function dryRun(opts: Partial<ImportOptions>, label: string, progressFile?: string, onImp?: (imp: NotionImport) => void) {
  const a = await admin();
  const ts = await one<{ id: string }>(`select id from teamspaces where workspace_id = $1 order by created_at limit 1`, [a.workspaceId]);
  const started = Date.now();
  let last = 0;
  const imp = new NotionImport(
    { token: token!, targetTeamspaceId: ts!.id, peopleMode: 'text', dryRun: true, ...opts },
    a,
    {},
    (phase, done, total) => {
      if (Date.now() - last < 15_000) return;
      last = Date.now();
      const line = { label, phase, done, total, requests: imp.client.requests, rateLimited: imp.client.rateLimited, elapsedS: Math.round((Date.now() - started) / 1000) };
      console.log(JSON.stringify(line));
      if (progressFile) writeFileSync(progressFile, JSON.stringify(line));
    },
  );
  onImp?.(imp);
  await imp.discover();
  await imp.mapPeople();
  if (opts.census) await imp.runCensus();
  const report = imp.report(started);
  return { label, seconds: Math.round((Date.now() - started) / 100) / 10, requests: imp.client.requests, rateLimited: imp.client.rateLimited, summary: report.summary, report };
}

const roots = arg('roots')?.split(',').filter(Boolean);
const max = arg('max') ? Number(arg('max')) : undefined;
try {
  if (cmd === 'bench') {
    const legacy = await dryRun({ rootIds: roots, maxItems: max, contentMode: 'blocks', concurrency: 1 }, 'legacy (block tree, 1 worker)');
    const current = await dryRun({ rootIds: roots, maxItems: max, contentMode: 'auto', concurrency: 4 }, 'current (markdown, 4 workers)');
    for (const r of [legacy, current]) {
      const s = r.summary;
      console.log(JSON.stringify({ label: r.label, seconds: r.seconds, requests: r.requests, rateLimited: r.rateLimited, pages: s.pages, rows: s.rows, databases: s.databases, blocks: s.blocks, markdownPages: r.report.counts.markdownPages ?? 0, blockFallbacks: r.report.counts.blockFallbacks ?? 0 }));
    }
  } else if (cmd === 'census') {
    const out = arg('out') ?? 'census.json';
    // On SIGTERM/SIGINT write what discovery has seen so far instead of losing it (no in-memory conversion yet).
    const stop = (imp: NotionImport) => () => {
      const rep = imp.report(Date.now());
      writeFileSync(`${out}.partial`, JSON.stringify({ partial: true, generatedAt: new Date().toISOString(), requests: imp.client.requests, items: { pages: rep.summary.pages, databases: rep.summary.databases, rows: rep.summary.rows, views: rep.summary.views }, counts: rep.counts, census: rep.census, warningCounts: rep.warningCounts }, null, 1));
      process.exit(130);
    };
    const r = await dryRun({ rootIds: roots, maxItems: max, contentMode: 'auto', concurrency: Number(arg('concurrency') ?? 4), census: true }, 'census', `${out}.progress`, (imp) => {
      process.once('SIGTERM', stop(imp));
      process.once('SIGINT', stop(imp));
    });
    const rep = r.report;
    // Counts only — no titles, no content.
    writeFileSync(out, JSON.stringify({
      generatedAt: new Date().toISOString(), seconds: r.seconds, requests: r.requests, rateLimited: r.rateLimited,
      items: { pages: rep.summary.pages, databases: rep.summary.databases, rows: rep.summary.rows, templates: rep.summary.templates, views: rep.summary.views, roots: rep.summary.roots.length },
      counts: rep.counts, census: rep.census, warningCounts: rep.warningCounts, unresolvedTargets: rep.unresolvedTargets.length,
    }, null, 1));
    console.log(`census written to ${out}`);
  } else if (cmd === 'sample') {
    // Stratified sample: strata = [{ name, rootIds, maxItems }]. Strata run in turn; each result is checkpointed
    // to --out as it finishes, and strata that would start after the time budget are skipped.
    const strata: { name: string; rootIds: string[]; maxItems: number; rootsInStratum: number }[] = JSON.parse(readFileSync(arg('strata')!, 'utf8'));
    const out = arg('out') ?? 'census-sample.json';
    const deadline = Date.now() + Number(arg('minutes') ?? 35) * 60_000;
    const rowsCap = Number(arg('rows') ?? 20);
    const results: any[] = [];
    for (const st of strata) {
      if (Date.now() > deadline) { results.push({ stratum: st.name, skipped: 'time budget' }); continue; }
      let current: NotionImport | undefined;
      // Stop a stratum that runs past the deadline (its partial counts are still reported).
      const timer = setInterval(() => { if (Date.now() > deadline + 5 * 60_000) current?.cancel(); }, 10_000);
      let r: any;
      try {
        r = await dryRun({ rootIds: st.rootIds, maxItems: st.maxItems, maxRowsPerSource: rowsCap, contentMode: 'auto', concurrency: 4, census: true }, `sample:${st.name}`, `${out}.progress`, (i) => (current = i));
      } catch (e: any) {
        r = null;
        results.push({ stratum: st.name, error: e.message });
      }
      clearInterval(timer);
      if (r) {
        const rep = r.report;
        results.push({
          stratum: st.name, rootsInStratum: st.rootsInStratum, rootsSampled: st.rootIds.length, seconds: r.seconds, requests: r.requests, rateLimited: r.rateLimited,
          items: { pages: rep.summary.pages, databases: rep.summary.databases, rows: rep.summary.rows, templates: rep.summary.templates, views: rep.summary.views, roots: rep.summary.roots.length },
          counts: { markdownPages: rep.counts.markdownPages ?? 0, blockFallbacks: rep.counts.blockFallbacks ?? 0 }, census: rep.census, warningCounts: rep.warningCounts, unresolvedTargets: rep.unresolvedTargets.length,
        });
      }
      writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rowsPerDatabaseCap: rowsCap, strata: results }, null, 1));
    }
    console.log(`sample written to ${out}`);
  } else {
    console.log('usage: cli.ts census|bench|sample [--roots id,id] [--max N] [--out file]');
  }
} finally {
  await pool.end();
}
