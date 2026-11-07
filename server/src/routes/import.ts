import type { FastifyInstance } from 'fastify';
import { fail, requireAdmin, type AuthUser } from '../auth.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import { NotionImport, type ImportDeps, type ImportOptions, type PeopleMode, type TeamspaceSpec } from '../importers/notion/importer.js';
import { relinkImported } from '../importers/notion/relink.js';

/** Jobs running in this process (the token lives only here, never in the database). */
const running = new Map<string, NotionImport>();

async function setJob(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await q(
    `update import_jobs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, heartbeat_at = now() where id = $1`,
    [id, ...keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null && !(fields[k] instanceof Date) ? JSON.stringify(fields[k]) : fields[k]))],
  );
}

/** Starts a Notion import job in the background and returns its id. Exported for tests. */
export async function startNotionImport(admin: AuthUser, opts: ImportOptions, deps: ImportDeps = {}): Promise<{ id: string; done: Promise<void> }> {
  const job = await one<{ id: string }>(
    `insert into import_jobs(workspace_id, source, status, dry_run, options, started_by, started_at, heartbeat_at)
     values ($1,'notion','running',$2,$3,$4, now(), now()) returning id`,
    [
      admin.workspaceId,
      !!opts.dryRun,
      JSON.stringify({
        rootIds: opts.rootIds ?? [], targetTeamspaceId: opts.targetTeamspaceId, peopleMode: opts.peopleMode, force: !!opts.force,
        teamspaces: (opts.teamspaces ?? []).map((t) => ({ name: t.name, roots: t.rootIds.length })), contentMode: opts.contentMode ?? 'auto',
        includeInlineComments: !!opts.includeInlineComments, followLinks: opts.followLinks ?? 0, census: !!opts.census, privatePages: opts.privatePages ?? 'owner',
      }),
      admin.id,
    ],
  );
  const id = job!.id;
  let lastBeat = 0;
  const imp = new NotionImport(opts, admin, deps, (phase, done, total) => {
    if (Date.now() - lastBeat < 1000 && done !== total) return;
    lastBeat = Date.now();
    setJob(id, { progress: { phase, done, total, counts: imp.counts } }).catch(() => {});
  });
  imp.jobId = id;
  running.set(id, imp);
  const started = Date.now();
  // Steady liveness signal: some phases (large roots, comments, relink) emit no progress for minutes, and the
  // interrupted-job sweep must not mistake a live import for one whose process died.
  const beat = setInterval(() => q('update import_jobs set heartbeat_at = now() where id = $1', [id]).catch(() => {}), 30_000);
  beat.unref();
  const done = (async () => {
    try {
      await imp.discover();
      await imp.mapPeople();
      if (opts.census) await imp.runCensus();
      if (!opts.dryRun) {
        await imp.write();
        // Point links in earlier imports at pages this run brought in.
        imp.counts.relink = await relinkImported(admin.workspaceId, { userId: admin.id });
      }
      await setJob(id, { status: 'done', error: null, finished_at: new Date(), progress: { phase: 'done', done: 1, total: 1, counts: imp.counts }, report: imp.report(started) });
      await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: opts.dryRun ? 'import.notion_previewed' : 'import.notion_completed', targetType: 'import', targetId: id, meta: { counts: imp.counts, warnings: imp.warningCounts } });
    } catch (e: any) {
      const cancelled = e?.code === 'cancelled' || imp.cancelled;
      await setJob(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled' : e.message,
        finished_at: new Date(),
        report: imp.report(started),
      }).catch(() => {});
      if (!cancelled) console.error(JSON.stringify({ level: 'error', msg: 'notion import failed', job: id, err: e.message }));
    } finally {
      clearInterval(beat);
      running.delete(id);
    }
  })();
  return { id, done };
}

/** Jobs left "running" by a process that died can't continue (the token was only in its memory). */
async function sweepInterrupted() {
  await q(
    `update import_jobs set status = 'interrupted', error = 'The server restarted during the import. Run it again to resume — already-imported items are kept and updated.', finished_at = now()
     where status = 'running' and heartbeat_at < now() - interval '2 minutes'`,
  ).catch(() => {});
}

export default async function importRoutes(app: FastifyInstance) {
  await sweepInterrupted();
  const sweep = setInterval(sweepInterrupted, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    for (const imp of running.values()) imp.cancel();
  });

  app.post<{
    Body: {
      token?: string; rootIds?: string[]; targetTeamspaceId?: string; peopleMode?: PeopleMode; dryRun?: boolean; force?: boolean;
      teamspaces?: TeamspaceSpec[]; contentMode?: 'auto' | 'blocks'; includeInlineComments?: boolean; followLinks?: number; concurrency?: number; census?: boolean; privatePages?: "owner" | "skip";
    };
  }>(
    '/admin/import/notion',
    async (req) => {
      const admin = requireAdmin(req);
      const b = req.body ?? {};
      const token = String(b.token ?? '').trim();
      if (!token) fail(400, 'A Notion integration token is required');
      if (!b.targetTeamspaceId) fail(400, 'Choose a teamspace to import into');
      const ts = await one('select id from teamspaces where id = $1 and workspace_id = $2', [b.targetTeamspaceId, admin.workspaceId]);
      if (!ts) fail(404, 'Teamspace not found');
      if ([...running.values()].some((r) => r.admin.workspaceId === admin.workspaceId)) fail(409, 'An import is already running');
      const peopleMode: PeopleMode = b.peopleMode === 'guests' ? 'guests' : 'text';
      const rootIds = (b.rootIds ?? []).map((s) => String(s).trim()).filter(Boolean);
      const teamspaces = sanitizeTeamspaces(b.teamspaces);
      const { id } = await startNotionImport(admin, {
        token, rootIds, targetTeamspaceId: b.targetTeamspaceId!, peopleMode, dryRun: !!b.dryRun || !!b.census, force: !!b.force, teamspaces,
        contentMode: b.contentMode === 'blocks' ? 'blocks' : 'auto', includeInlineComments: !!b.includeInlineComments,
        privatePages: b.privatePages === 'skip' ? 'skip' : 'owner',
        followLinks: Math.max(0, Math.min(2, Number(b.followLinks) || 0)), concurrency: Math.max(1, Math.min(8, Number(b.concurrency) || 4)), census: !!b.census,
      });
      await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: b.dryRun ? 'import.notion_preview_started' : 'import.notion_started', targetType: 'import', targetId: id, meta: { rootIds, peopleMode }, ip: req.ip });
      return { id };
    },
  );

  // Teamspace map saved per workspace, pre-filled on the next import (see docs/NOTION-WORKSPACE-CENSUS.md).
  app.get('/admin/import/notion/teamspace-map', async (req) => {
    const admin = requireAdmin(req);
    const r = await one<{ value: any; updated_at: string }>(`select value, updated_at from import_settings where workspace_id = $1 and source = 'notion' and key = 'teamspace-map'`, [admin.workspaceId]);
    return r ? { ...r.value, updatedAt: r.updated_at } : { teamspaces: [] };
  });
  app.put<{ Body: { teamspaces?: TeamspaceSpec[] } }>('/admin/import/notion/teamspace-map', async (req) => {
    const admin = requireAdmin(req);
    const teamspaces = sanitizeTeamspaces(req.body?.teamspaces) ?? [];
    await q(
      `insert into import_settings(workspace_id, source, key, value) values ($1,'notion','teamspace-map',$2)
       on conflict (workspace_id, source, key) do update set value = excluded.value, updated_at = now()`,
      [admin.workspaceId, JSON.stringify({ teamspaces })],
    );
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.teamspace_map_saved', targetType: 'import', meta: { teamspaces: teamspaces.length }, ip: req.ip });
    return { teamspaces };
  });

  /** Rewrites links in previously imported pages that still point at Notion, now that more is imported. */
  app.post('/admin/import/relink', async (req) => {
    const admin = requireAdmin(req);
    const r = await relinkImported(admin.workspaceId, { userId: admin.id });
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.relinked', targetType: 'import', meta: r as any, ip: req.ip });
    return r;
  });

  app.get('/admin/import/jobs', async (req) => {
    const admin = requireAdmin(req);
    return q(
      `select j.id, j.source, j.status, j.dry_run, j.options, j.progress, j.error, j.created_at, j.started_at, j.finished_at,
         u.name as started_by_name,
         (j.report->'counts') as counts, (j.report->'warningCounts') as warning_counts
       from import_jobs j left join users u on u.id = j.started_by
       where j.workspace_id = $1 order by j.created_at desc limit 50`,
      [admin.workspaceId],
    );
  });

  app.get<{ Params: { id: string } }>('/admin/import/jobs/:id', async (req) => {
    const admin = requireAdmin(req);
    const j = await one(`select * from import_jobs where id = $1 and workspace_id = $2`, [req.params.id, admin.workspaceId]);
    if (!j) fail(404, 'Import not found');
    return j;
  });

  app.post<{ Params: { id: string } }>('/admin/import/jobs/:id/cancel', async (req) => {
    const admin = requireAdmin(req);
    const j = await one(`select id, status from import_jobs where id = $1 and workspace_id = $2`, [req.params.id, admin.workspaceId]);
    if (!j) fail(404, 'Import not found');
    const imp = running.get(j.id);
    if (!imp) fail(409, j.status === 'running' ? 'This import is running on another server instance' : 'This import is not running');
    imp!.cancel();
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.notion_cancelled', targetType: 'import', targetId: j.id, ip: req.ip });
    return { ok: true };
  });
}

/** Validates the teamspace map input (names, Notion ids/URLs, access, member emails). */
function sanitizeTeamspaces(input: unknown): TeamspaceSpec[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: TeamspaceSpec[] = [];
  for (const t of input.slice(0, 200)) {
    if (!t || typeof t !== 'object') continue;
    const name = String((t as any).name ?? '').trim().slice(0, 120);
    const rootIds = Array.isArray((t as any).rootIds) ? (t as any).rootIds.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 5000) : [];
    if (!name) continue;
    const kind = (t as any).kind === 'private' ? 'private' : 'teamspace';
    out.push({
      name,
      kind,
      ownerEmail: kind === 'private' && typeof (t as any).ownerEmail === 'string' ? (t as any).ownerEmail.trim().toLowerCase().slice(0, 200) : null,
      icon: typeof (t as any).icon === 'string' ? (t as any).icon.slice(0, 16) : null,
      notionTeamspaceId: typeof (t as any).notionTeamspaceId === 'string' ? (t as any).notionTeamspaceId.slice(0, 64) : null,
      rootIds,
      access: (t as any).access === 'members' ? 'members' : 'everyone',
      members: Array.isArray((t as any).members) ? (t as any).members.map((x: unknown) => String(x).trim()).filter((x: string) => /@/.test(x)).slice(0, 2000) : [],
    });
  }
  return out;
}
