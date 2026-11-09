import type { FastifyInstance } from 'fastify';
import { fail, requireAdmin, type AuthUser } from '../auth.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import { loadUser } from '../auth.js';
import { runAsLeader } from '../db.js';
import { decrypt, encrypt, encryptionAvailable } from '../ai/settings.js';
import { NotionApiError, NotionClient } from '../importers/notion/client.js';
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

export interface RunMode {
  /** 'sync': pull changes into an earlier import (linked workspace). */
  kind?: 'import' | 'sync';
  /** Sync: changes since this time; null compares everything and checks for deletions. */
  since?: Date | null;
  /** Called once the job has finished (any status). */
  onFinish?: (status: 'done' | 'failed' | 'cancelled', imp: NotionImport, error?: any) => Promise<void>;
}

/** Starts a Notion import (or sync) job in the background and returns its id. Exported for tests. */
export async function startNotionImport(admin: AuthUser, opts: ImportOptions, deps: ImportDeps = {}, mode: RunMode = {}): Promise<{ id: string; done: Promise<void> }> {
  const kind = mode.kind ?? 'import';
  const job = await one<{ id: string }>(
    `insert into import_jobs(workspace_id, source, status, dry_run, options, started_by, started_at, heartbeat_at, kind)
     values ($1,'notion','running',$2,$3,$4, now(), now(), $5) returning id`,
    [
      admin.workspaceId,
      !!opts.dryRun,
      JSON.stringify({
        rootIds: opts.rootIds ?? [], targetTeamspaceId: opts.targetTeamspaceId, peopleMode: opts.peopleMode, force: !!opts.force,
        teamspaces: (opts.teamspaces ?? []).map((t) => ({ name: t.name, roots: t.rootIds.length })), contentMode: opts.contentMode ?? 'auto',
        includeInlineComments: !!opts.includeInlineComments, followLinks: opts.followLinks ?? 0, census: !!opts.census, privatePages: opts.privatePages ?? 'owner',
        ...(kind === 'sync' ? { full: mode.since === null } : {}),
      }),
      admin.id,
      kind,
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
      if (kind === 'sync') {
        await imp.discoverChanges(mode.since ?? null);
        if (imp.order.length) {
          await imp.mapPeople();
          await imp.write();
        }
        await imp.applyRemovals();
        if (imp.order.length) imp.counts.relink = await relinkImported(admin.workspaceId, { userId: admin.id });
      } else {
        await imp.discover();
        await imp.mapPeople();
        if (opts.census) await imp.runCensus();
        if (!opts.dryRun) {
          await imp.write();
          // Point links in earlier imports at pages this run brought in.
          imp.counts.relink = await relinkImported(admin.workspaceId, { userId: admin.id });
        }
      }
      await setJob(id, { status: 'done', error: null, finished_at: new Date(), progress: { phase: 'done', done: 1, total: 1, counts: imp.counts }, report: imp.report(started) });
      if (kind === 'import' || imp.order.length || imp.counts.removed) {
        await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: kind === 'sync' ? 'import.notion_synced' : opts.dryRun ? 'import.notion_previewed' : 'import.notion_completed', targetType: 'import', targetId: id, meta: { counts: imp.counts, warnings: imp.warningCounts } });
      }
      await mode.onFinish?.('done', imp).catch(() => {});
    } catch (e: any) {
      const cancelled = e?.code === 'cancelled' || imp.cancelled;
      await setJob(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled' : e.message,
        finished_at: new Date(),
        report: imp.report(started),
      }).catch(() => {});
      if (!cancelled) console.error(JSON.stringify({ level: 'error', msg: `notion ${kind} failed`, job: id, err: e.message }));
      await mode.onFinish?.(cancelled ? 'cancelled' : 'failed', imp, e).catch(() => {});
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
      /** Link the Notion workspace: after this import, keep pulling changes on a schedule. */
      keepInSync?: boolean;
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
      const opts: ImportOptions = {
        token, rootIds, targetTeamspaceId: b.targetTeamspaceId!, peopleMode, dryRun: !!b.dryRun || !!b.census, force: !!b.force, teamspaces,
        contentMode: b.contentMode === 'blocks' ? 'blocks' : 'auto', includeInlineComments: !!b.includeInlineComments,
        privatePages: b.privatePages === 'skip' ? 'skip' : 'owner',
        followLinks: Math.max(0, Math.min(2, Number(b.followLinks) || 0)), concurrency: Math.max(1, Math.min(8, Number(b.concurrency) || 4)), census: !!b.census,
      };
      const link = b.keepInSync && !opts.dryRun;
      if (link) await saveLink(admin, opts, req.ip);
      const startedAt = new Date();
      const { id } = await startNotionImport(admin, opts, {}, {
        onFinish: link
          ? async (status) => {
              // The import read everything in scope: the next sync only needs changes made since it started.
              if (status === 'done') await q(`update notion_links set cursor = $2, last_sync_at = now(), last_full_at = now(), last_error = null where workspace_id = $1`, [admin.workspaceId, new Date(startedAt.getTime() - CURSOR_OVERLAP_MS)]);
            }
          : undefined,
      });
      await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: b.dryRun ? 'import.notion_preview_started' : 'import.notion_started', targetType: 'import', targetId: id, meta: { rootIds, peopleMode }, ip: req.ip });
      return { id };
    },
  );

  // ---- linked Notion workspace (one-way sync)
  startLinkScheduler(app);

  app.get('/admin/import/notion/link', async (req) => {
    const admin = requireAdmin(req);
    const l = await one<any>(
      `select l.*, u.name as created_by_name, t.name as teamspace_name from notion_links l
       left join users u on u.id = l.created_by left join teamspaces t on t.id = (l.options->>'targetTeamspaceId')::uuid
       where l.workspace_id = $1`,
      [admin.workspaceId],
    );
    const recent = await q(
      `select id, status, error, created_at, finished_at, (options->>'full')::boolean as full, report->'counts' as counts
       from import_jobs where workspace_id = $1 and kind = 'sync' order by created_at desc limit 20`,
      [admin.workspaceId],
    );
    if (!l) return { linked: false, encryptionAvailable: encryptionAvailable(), recent };
    const o = l.options ?? {};
    const running = [...runningJobs()].find((r) => r.admin.workspaceId === admin.workspaceId);
    return {
      linked: true,
      status: l.status,
      notionWorkspace: l.notion_workspace,
      intervalMinutes: l.interval_minutes,
      fullCheckHours: l.full_check_hours,
      lastSyncAt: l.last_sync_at,
      lastFullAt: l.last_full_at,
      nextSyncAt: l.status === 'active' ? (l.last_sync_at ? new Date(new Date(l.last_sync_at).getTime() + l.interval_minutes * 60_000) : new Date()) : null,
      lastError: l.last_error,
      createdAt: l.created_at,
      createdByName: l.created_by_name,
      teamspaceName: l.teamspace_name,
      peopleMode: o.peopleMode,
      roots: (o.rootIds ?? []).length,
      mappedTeamspaces: (o.teamspaces ?? []).length,
      running: running ? running.jobId : null,
      recent,
    };
  });

  app.patch<{ Body: { token?: string; intervalMinutes?: number; fullCheckHours?: number; status?: 'active' | 'paused' } }>('/admin/import/notion/link', async (req) => {
    const admin = requireAdmin(req);
    const l = await one<any>(`select * from notion_links where workspace_id = $1`, [admin.workspaceId]);
    if (!l) fail(404, 'Notion is not linked');
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [admin.workspaceId];
    if (b.token !== undefined) {
      const token = String(b.token).trim();
      const name = await checkToken(token);
      vals.push(encrypt(token), name);
      sets.push(`token_enc = $${vals.length - 1}`, `notion_workspace = $${vals.length}`, `last_error = null`);
    }
    if (b.intervalMinutes !== undefined) { vals.push(Math.max(5, Math.min(1440, Math.round(Number(b.intervalMinutes) || 15)))); sets.push(`interval_minutes = $${vals.length}`); }
    if (b.fullCheckHours !== undefined) { vals.push(Math.max(1, Math.min(168, Math.round(Number(b.fullCheckHours) || 24)))); sets.push(`full_check_hours = $${vals.length}`); }
    if (b.status === 'active' || b.status === 'paused') { vals.push(b.status); sets.push(`status = $${vals.length}`); }
    if (sets.length) await q(`update notion_links set ${sets.join(', ')}, updated_at = now() where workspace_id = $1`, vals);
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.notion_link_updated', targetType: 'import', meta: { token: b.token !== undefined, intervalMinutes: b.intervalMinutes, fullCheckHours: b.fullCheckHours, status: b.status }, ip: req.ip });
    return { ok: true };
  });

  app.post<{ Body: { full?: boolean } }>('/admin/import/notion/link/sync', async (req) => {
    const admin = requireAdmin(req);
    const l = await one<any>(`select * from notion_links where workspace_id = $1`, [admin.workspaceId]);
    if (!l) fail(404, 'Notion is not linked');
    if ([...runningJobs()].some((r) => r.admin.workspaceId === admin.workspaceId)) fail(409, 'An import or sync is already running');
    const id = await runLinkSync(l, !!req.body?.full, admin);
    return { id };
  });

  /** Cuts the link: stops syncing and deletes the stored token. Imported content stays, now owned by Atrium. */
  app.delete('/admin/import/notion/link', async (req) => {
    const admin = requireAdmin(req);
    for (const r of runningJobs()) if (r.admin.workspaceId === admin.workspaceId && (r as any).sync) r.cancel();
    const l = await one(`delete from notion_links where workspace_id = $1 returning workspace_id`, [admin.workspaceId]);
    if (!l) fail(404, 'Notion is not linked');
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.notion_unlinked', targetType: 'import', ip: req.ip });
    return { ok: true };
  });

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
       where j.workspace_id = $1 and j.kind = 'import' order by j.created_at desc limit 50`,
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

// ---------------------------------------------------------------- linked Notion workspace

/** Changes are read from slightly before the last sync started (search indexing lag, minute-rounded stamps). */
const CURSOR_OVERLAP_MS = 10 * 60_000;

const runningJobs = () => running.values();

/** Validates a Notion token; returns the Notion workspace name. */
async function checkToken(token: string): Promise<string | null> {
  if (!token) fail(400, 'A Notion integration token is required');
  try {
    const me: any = await new NotionClient({ token, maxRetries: 1, timeoutMs: 15_000 }).me();
    return me?.bot?.workspace_name ?? null;
  } catch (e: any) {
    if (e instanceof NotionApiError && (e.status === 401 || e.status === 403)) fail(400, 'Notion rejected this token');
    throw e;
  }
}

/** Stores (or replaces) the workspace's Notion link with the settings of the import that created it. */
async function saveLink(admin: AuthUser, opts: ImportOptions, ip?: string) {
  if (!encryptionAvailable()) fail(400, 'Keeping Atrium in sync needs ATRIUM_ENCRYPTION_KEY set on the server (the Notion token is stored encrypted)');
  const name = await checkToken(opts.token);
  const options = {
    rootIds: opts.rootIds ?? [], targetTeamspaceId: opts.targetTeamspaceId, peopleMode: opts.peopleMode, teamspaces: opts.teamspaces ?? [],
    privatePages: opts.privatePages ?? 'owner', contentMode: opts.contentMode ?? 'auto', includeInlineComments: !!opts.includeInlineComments,
  };
  await q(
    `insert into notion_links(workspace_id, token_enc, options, notion_workspace, created_by, status)
     values ($1,$2,$3,$4,$5,'active')
     on conflict (workspace_id) do update set token_enc = excluded.token_enc, options = excluded.options, notion_workspace = excluded.notion_workspace,
       created_by = excluded.created_by, status = 'active', cursor = null, last_error = null, updated_at = now()`,
    [admin.workspaceId, encrypt(opts.token), JSON.stringify(options), name, admin.id],
  );
  await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'import.notion_linked', targetType: 'import', meta: { notionWorkspace: name, roots: options.rootIds.length }, ip });
}

/** Starts one sync of a linked workspace (incremental, or a full check that also finds deletions). */
async function runLinkSync(l: any, full: boolean, actor?: AuthUser): Promise<string | null> {
  const ws = l.workspace_id;
  const pause = (msg: string) => q(`update notion_links set status = 'paused', last_error = $2, last_sync_at = now() where workspace_id = $1`, [ws, msg]);
  // Sync runs as the person who linked Notion, while they are still an admin of this workspace.
  const owner = l.created_by ? await loadUser(l.created_by, 'session') : undefined;
  const admin = actor ?? owner;
  if (!admin || admin.workspaceId !== ws || (admin.role !== 'owner' && admin.role !== 'admin')) {
    await pause('The person who linked Notion is no longer an admin. Update the token (or link again) as an admin to resume.');
    return null;
  }
  let token: string;
  try {
    token = decrypt(l.token_enc);
  } catch {
    await pause('The stored Notion token could not be decrypted (was ATRIUM_ENCRYPTION_KEY changed?). Enter the token again.');
    return null;
  }
  const o = l.options ?? {};
  const since = full || !l.cursor ? null : new Date(l.cursor);
  const startedAt = new Date();
  const { id } = await startNotionImport(
    admin,
    {
      token, rootIds: o.rootIds ?? [], targetTeamspaceId: o.targetTeamspaceId, peopleMode: o.peopleMode === 'guests' ? 'guests' : 'text',
      teamspaces: o.teamspaces ?? [], privatePages: o.privatePages === 'skip' ? 'skip' : 'owner', contentMode: o.contentMode === 'blocks' ? 'blocks' : 'auto',
      includeInlineComments: !!o.includeInlineComments, concurrency: 3,
    },
    {},
    {
      kind: 'sync',
      since,
      onFinish: async (status, _imp, err) => {
        if (status === 'done') {
          await q(
            `update notion_links set cursor = $2, last_sync_at = now(), last_full_at = case when $3 then now() else last_full_at end, last_error = null, last_job_id = $4
             where workspace_id = $1`,
            [ws, new Date(startedAt.getTime() - CURSOR_OVERLAP_MS), since === null, id],
          );
        } else if (err instanceof NotionApiError && (err.status === 401 || err.status === 403)) {
          await pause('Notion rejected the token (revoked or expired). Enter a new token to resume syncing.');
        } else {
          await q(`update notion_links set last_sync_at = now(), last_error = $2, last_job_id = $3 where workspace_id = $1`, [ws, status === 'cancelled' ? 'Sync cancelled' : String(err?.message ?? 'Sync failed').slice(0, 500), id]);
        }
        // Keep the sync history short.
        await q(
          `delete from import_jobs where workspace_id = $1 and kind = 'sync' and id not in
             (select id from import_jobs where workspace_id = $1 and kind = 'sync' order by created_at desc limit 200)`,
          [ws],
        );
      },
    },
  );
  const imp = running.get(id);
  if (imp) (imp as any).sync = true;
  return id;
}

/** Every minute (on the jobs leader): start due syncs of active links. */
function startLinkScheduler(app: FastifyInstance) {
  const tick = () =>
    runAsLeader(async () => {
      const links = await q<any>(`select * from notion_links where status = 'active'`);
      for (const l of links) {
        if ([...running.values()].some((r) => r.admin.workspaceId === l.workspace_id)) continue;
        // Another instance may be running a job for this workspace.
        const busy = await one(`select 1 from import_jobs where workspace_id = $1 and status = 'running' and heartbeat_at > now() - interval '2 minutes'`, [l.workspace_id]);
        if (busy) continue;
        const now = Date.now();
        if (l.last_sync_at && now - new Date(l.last_sync_at).getTime() < l.interval_minutes * 60_000) continue;
        const full = !l.cursor || !l.last_full_at || now - new Date(l.last_full_at).getTime() >= l.full_check_hours * 3_600_000;
        await runLinkSync(l, full).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'notion sync could not start', err: e.message })));
      }
    });
  const timer = setInterval(tick, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
