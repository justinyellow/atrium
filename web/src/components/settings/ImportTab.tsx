import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, Link2, Loader2, Pause, Play, RefreshCw, Save, Square, Unlink, Upload } from 'lucide-react';
import { del, get, patch, post, put, queryClient } from '../../lib/api';
import { useUi } from '../../lib/store';
import { timeAgo, toast } from '../ui';

/** Summary headings for grouped import warnings (expand a group to see every item). */
const WARNING_LABELS: Record<string, string> = {
  person_unmatched: 'People without an Atrium account — shown as plain names (choose “Add them as guests” to keep them)',
  linked_database: 'Linked database views whose source database is not shared with the integration',
  view_other_source: 'Views that show a different database (not supported yet — skipped)',
  file_failed: 'Files that could not be copied',
  block_rejected: 'Blocks that could not be converted (kept as a note)',
  fetch_failed: 'Items Notion would not return',
  limit: 'Items left out because of the import limits',
  comments: 'Comments that could not be imported',
};
import './admin.css';

interface Job {
  id: string;
  kind?: 'import' | 'sync';
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'queued';
  dry_run: boolean;
  options: any;
  progress: { phase?: string; done?: number; total?: number; counts?: any };
  report?: any;
  error?: string | null;
  created_at: string;
  finished_at?: string | null;
  started_by_name?: string;
}

/** Notion ids arrive dashed or not, or as URLs; previews use dashed lowercase UUIDs. */
function normId(s: string) {
  const m = String(s).replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#].*)?$/i) ?? String(s).replace(/-/g, '').match(/([0-9a-f]{32})/i);
  if (!m) return String(s);
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const PHASES: Record<string, string> = {
  discovering: 'Reading your Notion workspace',
  people: 'Matching people',
  pages: 'Creating pages',
  content: 'Copying content',
  comments: 'Copying comments',
  finishing: 'Finishing up',
  census: 'Converting (dry run)',
  checking: 'Checking Notion for changes',
  listing: 'Listing Notion pages',
  done: 'Done',
};

function Counts({ c }: { c: any }) {
  if (!c) return null;
  const n = (x: any) => (typeof x === 'number' ? x : (x?.created ?? 0) + (x?.updated ?? 0));
  const items = [
    ['Pages', n(c.pages)], ['Databases', n(c.databases)], ['Rows', n(c.rows)], ['Views', c.views], ['Comments', c.comments],
    ['Files copied', c.files?.rehosted ?? 0], ['People matched', c.people?.matched ?? 0], ['Guests created', c.people?.created ?? 0],
    ...(c.unresolvedLinks != null ? [['Links to pages not imported', c.unresolvedLinks]] : []),
    ...(c.relink ? [['Links fixed by relink', c.relink.linksFixed]] : []),
  ];
  return (
    <div className="imp-counts">
      {items.map(([k, v]) => <div key={k as string}><b>{v ?? 0}</b><span>{k}</span></div>)}
    </div>
  );
}

/** One line per sync: what changed. */
function syncSummary(c: any) {
  if (!c) return '—';
  const sum = (k: 'created' | 'updated') => (c.pages?.[k] ?? 0) + (c.databases?.[k] ?? 0) + (c.rows?.[k] ?? 0);
  const parts = [
    sum('created') && `${sum('created')} new`,
    sum('updated') && `${sum('updated')} updated`,
    c.removed && `${c.removed} moved to trash`,
    c.restored && `${c.restored} restored`,
    c.comments && `${c.comments} comments`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No changes';
}

const inMinutes = (iso: string) => {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return m <= 0 ? 'any moment' : m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
};

/** Linked Notion workspace: status, schedule and controls (sync now, pause, new secret, unlink). */
function NotionLinkCard({ onView }: { onView: (jobId: string) => void }) {
  const link = useQuery({
    queryKey: ['notion-link'],
    queryFn: () => get<any>('/admin/import/notion/link'),
    refetchInterval: (q) => ((q.state.data as any)?.running ? 3000 : 30000),
  });
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const l = link.data;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !l?.running) queryClient.invalidateQueries({ queryKey: ['tree'] });
    wasRunning.current = !!l?.running;
  }, [l?.running]);
  if (!l?.linked) return null;
  const act = async (fn: () => Promise<any>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e: any) {
      toast(e.message);
    }
    link.refetch();
  };
  return (
    <div className="set-card imp-card">
      <div className="imp-head">
        <span className="imp-logo">N</span>
        <div style={{ flex: 1 }}>
          <b>Synced with Notion{l.notionWorkspace ? ` · ${l.notionWorkspace}` : ''}</b>
          <div className="faint" style={{ fontSize: 12 }}>
            Changes made in Notion are copied here automatically: edits, new pages and rows, and pages deleted in Notion (moved to the Atrium trash).
            It only works in one direction. Edits made in Atrium to a synced page are replaced the next time that page changes in Notion.
          </div>
        </div>
        <span className={`imp-pill ${l.running ? 'running' : l.status}`}>{l.running ? 'Syncing…' : l.status === 'active' ? 'Active' : 'Paused'}</span>
      </div>
      <div className="imp-link-grid">
        <div><span>Last sync</span>{l.lastSyncAt ? timeAgo(l.lastSyncAt) : 'Not yet'}</div>
        <div><span>Next sync</span>{l.running ? 'Running now' : l.status === 'active' && l.nextSyncAt ? inMinutes(l.nextSyncAt) : 'Paused'}</div>
        <div><span>Last full check</span>{l.lastFullAt ? timeAgo(l.lastFullAt) : 'Not yet'}</div>
        <div><span>New top-level pages go to</span>{l.teamspaceName ?? '—'}</div>
      </div>
      {l.lastError && <div className="imp-status failed" style={{ fontSize: 13, marginBottom: 8 }}>{l.lastError}</div>}
      <div className="imp-link-sched">
        <label>Check for changes every{' '}
          <select className="select" value={l.intervalMinutes} onChange={(e) => act(() => patch('/admin/import/notion/link', { intervalMinutes: Number(e.target.value) }))}>
            {[5, 15, 30, 60, 240, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? 'hour' : m === 1440 ? 'day' : `${m / 60} hours`}</option>)}
          </select>
        </label>
        <label>Full check (also finds deleted pages) every{' '}
          <select className="select" value={l.fullCheckHours} onChange={(e) => act(() => patch('/admin/import/notion/link', { fullCheckHours: Number(e.target.value) }))}>
            {[6, 12, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hours` : h === 24 ? 'day' : h === 168 ? 'week' : `${h / 24} days`}</option>)}
          </select>
        </label>
      </div>
      {secret !== null && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input className="input" type="password" autoComplete="off" placeholder="New integration secret (ntn_…)" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button className="btn primary" disabled={!secret.trim()} onClick={() => act(() => patch('/admin/import/notion/link', { token: secret, status: 'active' }), 'Secret replaced').then(() => setSecret(null))}>Save</button>
          <button className="btn" onClick={() => setSecret(null)}>Cancel</button>
        </div>
      )}
      {confirmUnlink ? (
        <div className="imp-unlink">
          <div>Stop syncing and delete the stored secret? Everything already copied stays in Atrium. Changes made in Notion after this won't be copied.</div>
          <div className="adm-actions">
            <button className="btn" onClick={() => setConfirmUnlink(false)}>Cancel</button>
            <button className="btn danger" onClick={() => act(() => del('/admin/import/notion/link'), 'Notion unlinked').then(() => { setConfirmUnlink(false); queryClient.invalidateQueries({ queryKey: ['page'] }); })}><Unlink size={13} /> Unlink</button>
          </div>
        </div>
      ) : (
        <div className="adm-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!!l.running} onClick={() => act(() => post('/admin/import/notion/link/sync', {}), 'Sync started')}><RefreshCw size={13} /> Sync now</button>
          <button className="btn sm" disabled={!!l.running} title="Compares everything and moves pages deleted in Notion to the trash" onClick={() => act(() => post('/admin/import/notion/link/sync', { full: true }), 'Full check started')}>Full check now</button>
          {l.status === 'active'
            ? <button className="btn sm" onClick={() => act(() => patch('/admin/import/notion/link', { status: 'paused' }))}><Pause size={13} /> Pause</button>
            : <button className="btn sm" onClick={() => act(() => patch('/admin/import/notion/link', { status: 'active' }))}><Play size={13} /> Resume</button>}
          <button className="btn sm" onClick={() => setSecret('')}>Replace secret</button>
          <button className="btn sm danger" onClick={() => setConfirmUnlink(true)}><Unlink size={13} /> Unlink</button>
        </div>
      )}
      {!!l.recent?.length && (
        <table className="set-table" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>Type</th><th>Result</th><th /></tr></thead>
          <tbody>
            {l.recent.filter((j: any, i: number) => i < 3 || j.status !== 'done' || syncSummary(j.counts) !== 'No changes').slice(0, 8).map((j: any) => (
              <tr key={j.id}>
                <td>{timeAgo(j.created_at)}</td>
                <td>{j.full ? 'Full check' : 'Changes'}</td>
                <td>{j.status === 'done' ? syncSummary(j.counts) : j.status === 'running' ? 'Running…' : j.error ?? j.status}</td>
                <td style={{ textAlign: 'right' }}>{j.status !== 'running' && <button className="btn sm" onClick={() => onView(j.id)}>View</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Report({ job, mapper }: { job: Job; mapper?: ReactNode }) {
  const nav = useNavigate();
  const r = job.report;
  const [open, setOpen] = useState<string | null>(null);
  if (!r) return null;
  const byKind = new Map<string, any[]>();
  for (const w of r.warnings ?? []) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w]);
  const kinds = Object.entries(r.warningCounts ?? {}).sort((a: any, b: any) => b[1] - a[1]);
  return (
    <div>
      {job.dry_run ? (
        <>
          <div className="set-h3">Preview</div>
          <p className="muted" style={{ fontSize: 13 }}>
            Found {r.summary.pages} pages, {r.summary.databases} databases with {r.summary.rows} rows and {r.summary.views} views, {r.summary.templates} templates
            and {r.summary.blocks} blocks. People: {r.counts.people.matched} matched by email, {r.counts.people.unmatched} without an Atrium account.
          </p>
          {mapper ?? (
            <>
              <div className="set-h3">Top-level items ({r.summary.roots.length})</div>
              <ul className="imp-roots">{r.summary.roots.slice(0, 50).map((x: any) => <li key={x.notionId}>{x.kind === 'database' ? '🗂️' : '📄'} {x.title}</li>)}</ul>
            </>
          )}
        </>
      ) : (
        <>
          <Counts c={r.counts} />
          {!!r.roots?.length && (
            <>
              <div className="set-h3">Imported</div>
              <ul className="imp-roots">
                {r.roots.slice(0, 50).map((x: any) => (
                  <li key={x.id}>
                    <a href={`/p/${x.id}`} onClick={(e) => { e.preventDefault(); useUi.getState().set({ settings: null }); nav(`/p/${x.id}`); }}>{x.kind === 'database' ? '🗂️' : '📄'} {x.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {!!kinds.length && (
        <>
          <div className="set-h3">Things to check ({kinds.reduce((a: number, [, v]: any) => a + v, 0)})</div>
          {kinds.map(([k, v]: any) => (
            <div key={k} className="imp-warn">
              <button className="imp-warn-head" onClick={() => setOpen(open === k ? null : k)}>
                <span>{WARNING_LABELS[k] ?? (byKind.get(k)?.[0]?.message ?? k).replace(/"[^"]*"/g, '…').slice(0, 90)}</span><span className="faint">{v}</span>
              </button>
              {open === k && (
                <ul>{(byKind.get(k) ?? []).slice(0, 100).map((w, i) => <li key={i}>{w.message}{w.page ? <span className="faint"> — in “{w.page}”</span> : null}</li>)}</ul>
              )}
            </div>
          ))}
          {r.warningsTruncated && <div className="faint" style={{ fontSize: 12 }}>Only the first 2,000 details are listed.</div>}
        </>
      )}
      <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
        {r.requests} Notion API requests{r.rateLimited ? ` (${r.rateLimited} rate-limited)` : ''} · {Math.round((r.durationMs ?? 0) / 1000)}s
        {r.counts?.markdownPages ? ` · ${r.counts.markdownPages} pages fetched whole, ${r.counts.blockFallbacks ?? 0} block by block` : ''}
      </div>
    </div>
  );
}

interface TsSpec { name: string; kind?: 'teamspace' | 'private'; ownerEmail?: string | null; icon?: string; notionTeamspaceId?: string; access?: 'everyone' | 'members'; members?: string[]; rootIds: string[] }

/** Assigns preview roots to Atrium teamspaces. Roots whose Notion parent is hidden from the integration are grouped. */
function TeamspaceMapper({ roots, assign, setAssign, names, privateNames, addName, addPrivate, targetName }: {
  roots: any[];
  assign: Record<string, string>;
  setAssign: (f: (a: Record<string, string>) => Record<string, string>) => void;
  names: string[];
  privateNames: string[];
  addName: (n: string) => void;
  addPrivate: (email: string) => void;
  targetName: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const isPrivate = (n?: string) => !!n && privateNames.includes(n);
  // Private roots are grouped by owner; the rest by their hidden Notion parent.
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of roots) {
      const k = isPrivate(assign[r.notionId]) ? `private:${assign[r.notionId]}` : r.hiddenParent ?? '';
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    const rank = (k: string) => (k === '' ? 0 : k.startsWith('private:') ? 2 : 1);
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length);
  }, [roots]); // eslint-disable-line react-hooks/exhaustive-deps
  const assigned = roots.filter((r) => assign[r.notionId]).length;
  const options = (
    <>
      <option value="">{targetName} (default)</option>
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
      {!!privateNames.length && (
        <optgroup label="Private (only the owner sees it)">
          {privateNames.map((n) => <option key={n} value={n}>🔒 {n}</option>)}
        </optgroup>
      )}
    </>
  );
  const setMany = (ids: string[], v: string) => setAssign((a) => { const n = { ...a }; for (const id of ids) { if (v) n[id] = v; else delete n[id]; } return n; });
  return (
    <div>
      <div className="set-h3">Teamspaces ({assigned} of {roots.length} top-level items assigned)</div>
      <p className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
        Notion's API doesn't say which teamspace a page is in. Pick one for each top-level item (everything under it follows); unassigned items go to the default teamspace.
        Items whose Notion parent isn't shared with the integration are grouped so you can assign them together.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="input" style={{ flex: 1 }} placeholder="New teamspace name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn" disabled={!newName.trim()} onClick={() => { addName(newName.trim()); setNewName(''); }}>Add teamspace</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Owner email for someone's private pages" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} />
        <button className="btn" disabled={!/^[^@\s]+@[^@\s]+$/.test(newOwner.trim())} onClick={() => { addPrivate(newOwner.trim().toLowerCase()); setNewOwner(''); }}>Add private owner</button>
      </div>
      {groups.map(([k, list]) => {
        const values = new Set(list.map((r) => assign[r.notionId] ?? ''));
        return (
          <div key={k || 'top'} className="imp-warn">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="imp-warn-head" style={{ flex: 1 }} onClick={() => setOpen(open === k ? null : k)}>
                <span>{k.startsWith('private:') ? `🔒 Private pages of ${k.slice(8).replace(/^Private — /, '')}` : k ? `Under a page outside this import · ${list.slice(0, 3).map((r) => r.title).join(', ')}${list.length > 3 ? ', …' : ''}` : 'Top level of the workspace'}</span>
                <span className="faint">{list.length}</span>
              </button>
              <select className="select" style={{ height: 28, maxWidth: 200 }} value={values.size === 1 ? [...values][0] : '__mixed'} onChange={(e) => e.target.value !== '__mixed' && setMany(list.map((r) => r.notionId), e.target.value)}>
                {values.size > 1 && <option value="__mixed">Mixed</option>}
                {options}
              </select>
            </div>
            {open === k && (
              <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
                {list.slice(0, 500).map((r) => (
                  <li key={r.notionId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.kind === 'database' ? '🗂️' : '📄'} {r.title}{r.depth ? <span className="faint"> · linked</span> : null}
                    </span>
                    <select className="select" style={{ height: 26, maxWidth: 200 }} value={assign[r.notionId] ?? ''} onChange={(e) => setMany([r.notionId], e.target.value)}>{options}</select>
                  </li>
                ))}
                {list.length > 500 && <li className="faint">…and {list.length - 500} more (use the group picker)</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ImportTab() {
  const [token, setToken] = useState('');
  const [roots, setRoots] = useState('');
  const [teamspace, setTeamspace] = useState('');
  const [people, setPeople] = useState<'guests' | 'text'>('text');
  const [force, setForce] = useState(false);
  const [followLinks, setFollowLinks] = useState(0);
  const [inlineComments, setInlineComments] = useState(false);
  const [blockMode, setBlockMode] = useState(false);
  // Teamspace map: Notion root id → teamspace name ('' / missing = default teamspace), plus per-teamspace settings.
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [tsMeta, setTsMeta] = useState<Record<string, Omit<TsSpec, 'rootIds' | 'name'>>>({});
  const [privatePages, setPrivatePages] = useState<'owner' | 'skip'>('owner');
  const [keepInSync, setKeepInSync] = useState(false);
  const linked = useQuery({ queryKey: ['notion-link'], queryFn: () => get<any>('/admin/import/notion/link') });
  const fileRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const teamspaces = useQuery({ queryKey: ['teamspaces-admin'], queryFn: () => get<{ id: string; name: string; icon: string | null }[]>('/teamspaces') });
  const jobs = useQuery({ queryKey: ['import-jobs'], queryFn: () => get<Job[]>('/admin/import/jobs') });
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => get<Job>(`/admin/import/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => ((q.state.data as Job | undefined)?.status === 'running' ? 1500 : false),
  });
  useEffect(() => {
    if (!teamspace && teamspaces.data?.length) setTeamspace(teamspaces.data[0].id);
  }, [teamspaces.data, teamspace]);
  const loadMap = (specs: TsSpec[]) => {
    const a: Record<string, string> = {};
    const meta: Record<string, Omit<TsSpec, 'rootIds' | 'name'>> = {};
    for (const t of specs ?? []) {
      if (!t?.name) continue;
      meta[t.name] = { kind: t.kind, ownerEmail: t.ownerEmail, icon: t.icon, notionTeamspaceId: t.notionTeamspaceId, access: t.access, members: t.members };
      for (const r of t.rootIds ?? []) a[normId(r)] = t.name;
    }
    setAssign(a);
    setTsMeta(meta);
  };
  useEffect(() => {
    get<{ teamspaces: TsSpec[] }>('/admin/import/notion/teamspace-map').then((r) => loadMap(r.teamspaces)).catch(() => {});
  }, []);
  const tsNames = useMemo(() => {
    const set = new Set<string>([...(teamspaces.data ?? []).map((t) => t.name), ...Object.keys(tsMeta), ...Object.values(assign)]);
    return [...set].filter((n) => n && tsMeta[n]?.kind !== 'private').sort((a, b) => a.localeCompare(b));
  }, [teamspaces.data, tsMeta, assign]);
  const privateNames = useMemo(() => Object.keys(tsMeta).filter((n) => tsMeta[n]?.kind === 'private').sort(), [tsMeta]);
  const specs = (): TsSpec[] => {
    const by = new Map<string, string[]>();
    for (const [id, n] of Object.entries(assign)) if (n) by.set(n, [...(by.get(n) ?? []), id]);
    return [...by.entries()].map(([name, rootIds]) => ({ name, ...tsMeta[name], kind: tsMeta[name]?.kind ?? 'teamspace', access: tsMeta[name]?.access ?? 'everyone', rootIds }));
  };
  const saveMap = async () => {
    try {
      await put('/admin/import/notion/teamspace-map', { teamspaces: specs() });
      toast('Teamspace map saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const downloadMap = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ teamspaces: specs() }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'notion-teamspace-map.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const uploadMap = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      loadMap(Array.isArray(j) ? j : j.teamspaces ?? []);
      toast('Teamspace map loaded — save it to keep it');
    } catch {
      toast(`That file isn't a teamspace map (expected { "teamspaces": [{ "name", "rootIds" }] })`);
    }
  };
  const relink = async () => {
    try {
      const r = await post<{ pagesChecked: number; linksFixed: number; stillUnresolved: number }>('/admin/import/relink');
      toast(`Relinked ${r.linksFixed} links across ${r.pagesChecked} pages · ${r.stillUnresolved} still point at Notion`);
    } catch (e: any) {
      toast(e.message);
    }
  };
  useEffect(() => {
    if (job.data && job.data.status !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
      if (!job.data.dry_run && job.data.status === 'done') queryClient.invalidateQueries({ queryKey: ['tree'] });
    }
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = job.data?.status === 'running';
  const rootIds = useMemo(() => roots.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), [roots]);
  const start = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>('/admin/import/notion', {
        token, rootIds, targetTeamspaceId: teamspace, peopleMode: people, dryRun, force, teamspaces: specs(),
        followLinks, includeInlineComments: inlineComments, contentMode: blockMode ? 'blocks' : 'auto', privatePages,
        keepInSync: keepInSync && !dryRun,
      });
      setJobId(r.id);
      if (keepInSync && !dryRun) queryClient.invalidateQueries({ queryKey: ['notion-link'] });
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (e: any) {
      toast(e.message);
    }
    setBusy(false);
  };
  const p = job.data?.progress ?? {};
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null;
  const eta = (() => {
    if (!running || !p.total || !p.done || !job.data) return null;
    const elapsed = Date.now() - new Date(job.data.created_at).getTime();
    const left = Math.round(((elapsed / p.done) * (p.total - p.done)) / 60000);
    return left < 1 ? 'under a minute left' : `about ${left} min left in this step`;
  })();
  const targetName = teamspaces.data?.find((t) => t.id === teamspace)?.name ?? 'Default';
  const previewRoots: any[] = job.data?.dry_run && job.data.status === 'done' ? job.data.report?.summary?.roots ?? [] : [];

  return (
    <div className="imp">
      <h2>Import</h2>
      <NotionLinkCard onView={setJobId} />
      <div className="set-card imp-card">
        <div className="imp-head"><span className="imp-logo">N</span><div><b>Notion</b><div className="faint" style={{ fontSize: 12 }}>Pages, databases (with views, relations, formulas), files, comments and people.</div></div></div>
        <ol className="imp-steps">
          <li>In Notion, open <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer">Integrations <ExternalLink size={11} /></a> and create an <b>internal</b> integration with <i>Read content</i>, <i>Read comments</i> and <i>Read user information including email addresses</i>.</li>
          <li>Share the pages or teamspaces you want to bring over with the integration (page ⋯ → Connections), then paste its secret below.</li>
          <li>Preview first, then import. Re-running updates what's already imported instead of duplicating it.</li>
        </ol>
        <label className="adm-label">Integration secret</label>
        <input className="input" type="password" autoComplete="off" placeholder="ntn_…" value={token} onChange={(e) => setToken(e.target.value)} />
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{keepInSync ? 'Stored encrypted so Atrium can keep checking Notion for changes. Unlinking deletes it.' : 'Used only for this import and never stored.'}</div>
        <label className="adm-label">Pages or databases to import <span className="faint">(optional — leave empty to import everything shared with the integration)</span></label>
        <textarea className="input" rows={2} placeholder="Paste Notion page or database links, one per line" value={roots} onChange={(e) => setRoots(e.target.value)} />
        <label className="adm-label">Import into teamspace</label>
        <select className="select" style={{ width: '100%', height: 32 }} value={teamspace} onChange={(e) => setTeamspace(e.target.value)}>
          {teamspaces.data?.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
        </select>
        <label className="adm-label">People who don't have an Atrium account yet</label>
        <label className="adm-check" style={{ marginTop: 4 }}><input type="radio" checked={people === 'text'} onChange={() => setPeople('text')} /> Leave them out (mentions become plain names)</label>
        <label className="adm-check" style={{ marginTop: 4 }}><input type="radio" checked={people === 'guests'} onChange={() => setPeople('guests')} /> Add them as guests (no email is sent)</label>
        <label className="adm-check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Re-copy content even if Notion says it hasn't changed</label>
        <label className="adm-check"><input type="checkbox" checked={inlineComments} onChange={(e) => setInlineComments(e.target.checked)} /> Include inline comments (comments on text; slower — reads each block)</label>
        <label className="adm-check"><input type="checkbox" checked={blockMode} onChange={(e) => setBlockMode(e.target.checked)} /> Read pages block by block (slower; only if a page looks wrong)</label>
        <label className="adm-label">Private pages (marked 🔒 in the teamspace map)</label>
        <label className="adm-check" style={{ marginTop: 4 }}><input type="radio" checked={privatePages === 'owner'} onChange={() => setPrivatePages('owner')} /> Import into each owner's Private section (an account is created if needed; no email is sent)</label>
        <label className="adm-check" style={{ marginTop: 4 }}><input type="radio" checked={privatePages === 'skip'} onChange={() => setPrivatePages('skip')} /> Leave them out</label>
        <label className="adm-label">Also import pages that imported pages link to</label>
        <select className="select" style={{ width: '100%', height: 32 }} value={followLinks} onChange={(e) => setFollowLinks(Number(e.target.value))}>
          <option value={0}>No — keep links to pages outside the selection pointing at Notion</option>
          <option value={1}>Yes, one link away</option>
          <option value={2}>Yes, up to two links away</option>
        </select>
        <label className="adm-label">Teamspace map <span className="faint">({Object.keys(assign).length} items assigned to {new Set(Object.values(assign)).size} teamspaces)</span></label>
        <div className="adm-actions" style={{ marginTop: 4, justifyContent: 'flex-start' }}>
          <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> Upload map</button>
          <button className="btn sm" disabled={!Object.keys(assign).length} onClick={downloadMap}><Download size={13} /> Download map</button>
          <button className="btn sm" onClick={saveMap}><Save size={13} /> Save map</button>
          <button className="btn sm" title="Point links in earlier imports at pages imported since" onClick={relink}><Link2 size={13} /> Relink imported pages</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMap(f); e.target.value = ''; }} />
        </div>
        <label className="adm-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={keepInSync} disabled={linked.data && !linked.data.linked && linked.data.encryptionAvailable === false} onChange={(e) => setKeepInSync(e.target.checked)} />
          <span>
            <b>Keep Atrium in sync with Notion</b>: after the import, check Notion for changes every 15 minutes and copy them here until you unlink.
            {linked.data?.linked ? ' This replaces the current link’s settings.' : ''}
            {linked.data && !linked.data.linked && linked.data.encryptionAvailable === false ? ' (Needs ATRIUM_ENCRYPTION_KEY set on the server.)' : ''}
          </span>
        </label>
        <div className="adm-actions">
          {running ? (
            <button className="btn" onClick={async () => { try { await post(`/admin/import/jobs/${jobId}/cancel`); } catch (e: any) { toast(e.message); } }}><Square size={13} /> Cancel</button>
          ) : (
            <>
              <button className="btn" disabled={!token || !teamspace || busy} onClick={() => start(true)}>Preview</button>
              <button className="btn primary" disabled={!token || !teamspace || busy} onClick={() => start(false)}><Upload size={14} /> Import</button>
            </>
          )}
        </div>
        {job.data && (
          <div className="imp-job">
            {running ? (
              <>
                <div className="imp-phase"><Loader2 size={14} className="spin" /> {PHASES[p.phase ?? ''] ?? 'Working'}{p.total ? ` · ${p.done}/${p.total}` : ''}{eta ? <span className="faint"> · {eta}</span> : null}</div>
                <div className="imp-bar"><span style={{ width: `${pct ?? 5}%` }} /></div>
                <Counts c={p.counts} />
              </>
            ) : (
              <>
                <div className={`imp-status ${job.data.status}`}>
                  {job.data.status === 'done' ? (job.data.dry_run ? 'Preview ready' : job.data.kind === 'sync' ? `Sync complete · ${syncSummary(job.data.report?.counts)}` : 'Import complete') : job.data.status === 'cancelled' ? 'Cancelled' : job.data.status === 'interrupted' ? 'Interrupted' : 'Import failed'}
                  {job.data.error && job.data.status !== 'cancelled' ? ` — ${job.data.error}` : ''}
                </div>
                <Report
                  job={job.data}
                  mapper={previewRoots.length ? (
                    <TeamspaceMapper roots={previewRoots} assign={assign} setAssign={setAssign} names={tsNames} privateNames={privateNames} targetName={targetName}
                      addName={(n) => setTsMeta((m) => ({ ...m, [n]: m[n] ?? { access: 'everyone' } }))}
                      addPrivate={(email) => setTsMeta((m) => ({ ...m, [`Private — ${email}`]: { kind: 'private', ownerEmail: email } }))} />
                  ) : undefined}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="set-card imp-card">
        <div className="imp-head"><span className="imp-logo md"><FileText size={14} /></span><div><b>Markdown</b><div className="faint" style={{ fontSize: 12 }}>Import .md files from the sidebar: <i>Import</i> at the bottom. Zip and Confluence importers are planned.</div></div></div>
      </div>

      {!!jobs.data?.length && (
        <>
          <div className="set-h3">Recent imports</div>
          <table className="set-table">
            <thead><tr><th>Started</th><th>By</th><th>Type</th><th>Status</th><th /></tr></thead>
            <tbody>
              {jobs.data.slice(0, 10).map((j) => (
                <tr key={j.id}>
                  <td>{timeAgo(j.created_at)}</td>
                  <td>{j.started_by_name ?? '—'}</td>
                  <td>{j.dry_run ? 'Preview' : 'Import'}</td>
                  <td>{j.status}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setJobId(j.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
