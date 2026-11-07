import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { get } from '../../lib/api';
import { useUsers } from '../../lib/hooks';
import { Avatar } from '../ui';
import './admin.css';

interface Entry {
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  meta: Record<string, any>;
  ip: string | null;
  created_at: string;
  actor: { id: string; name: string; email: string; avatar_url: string | null } | null;
}

const PAGE = 50;

const CATEGORIES = [
  ['', 'All activity'],
  ['user', 'Users & logins'],
  ['invite', 'Invites'],
  ['page', 'Page sharing & deletion'],
  ['teamspace', 'Teamspaces'],
  ['group', 'Groups'],
  ['workspace', 'Workspace settings'],
  ['token', 'API tokens'],
  ['oauth', 'Connected apps'],
  ['export', 'Exports'],
  ['session', 'Sessions'],
  ['sso', 'Single sign-on'],
  ['scim', 'Provisioning (SCIM)'],
  ['trash', 'Trash'],
] as const;

/** Human-readable one-liner for an audit entry. */
function describe(e: Entry) {
  const t = e.target_label ? `“${e.target_label}”` : '';
  const m = e.meta ?? {};
  switch (e.action) {
    case 'user.login': return `Logged in${m.method && m.method !== 'password' ? ` with ${m.method}` : ''}`;
    case 'user.login_failed': return `Failed login for ${m.email ?? 'unknown email'}${m.reason ? ` (${String(m.reason).replace(/_/g, ' ')})` : ''}`;
    case 'user.logout': return 'Logged out';
    case 'user.created': return `Added ${t} as ${m.role ?? 'member'}`;
    case 'user.updated': return `Edited ${t}`;
    case 'user.role_changed': return `Changed ${t}'s role from ${m.role?.from} to ${m.role?.to}`;
    case 'user.deactivated': return `Deactivated ${t}`;
    case 'user.reactivated': return `Reactivated ${t}`;
    case 'user.deleted': return `Removed ${m.name ?? t} from the workspace${m.transferredRoots ? ` (${m.transferredRoots} pages transferred)` : ''}`;
    case 'user.sessions_revoked': return `Signed ${t} out everywhere`;
    case 'user.password_reset_issued': return `Issued a password reset for ${t}`;
    case 'user.password_changed': return 'Changed their password';
    case 'invite.created': return `Invited ${m.email ?? 'anyone with the link'} as ${m.role}`;
    case 'invite.revoked': return `Revoked the invite for ${m.email ?? 'a link'}`;
    case 'invite.accepted': return `Joined via invite as ${m.role}`;
    case 'invite.bulk': return `Bulk invited ${m.invited} of ${m.total} people`;
    case 'page.permission_granted': return `Shared ${t} (${m.principal_type}, ${m.level})`;
    case 'page.permission_changed': return `Changed access to ${t} (${m.principal_type}, ${m.level})`;
    case 'page.permission_removed': return `Removed access to ${t} (${m.principal_type})`;
    case 'page.published': return `Published ${t} to the web`;
    case 'page.unpublished': return `Unpublished ${t}`;
    case 'page.guest_invited': return `Invited guest ${m.email} to ${t}`;
    case 'page.deleted_permanently': return `Permanently deleted ${m.title ? `“${m.title}”` : 'a page'}`;
    case 'export.page_markdown': return `Exported ${t} as Markdown`;
    case 'export.members_csv': return 'Exported the member list';
    case 'export.audit_csv': return 'Exported the audit log';
    case 'workspace.settings_changed': return `Changed security settings: ${Object.entries(m).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${v}`).join(', ')}`;
    case 'workspace.updated': return 'Updated workspace name or icon';
    case 'token.created': return `Created API token ${t}`;
    case 'token.revoked': return `Revoked API token ${t}`;
    case 'oauth.app_authorized': return `Connected ${t}`;
    case 'oauth.app_disconnected': return `Disconnected ${t || 'an app'}`;
    case 'trash.purged': return `Emptied ${m.purged} page(s) from Trash (older than ${m.retentionDays} days)`;
    default: return `${e.action.replace(/[._]/g, ' ')}${t ? ` ${t}` : ''}`;
  }
}

/** Settings → Audit log (admins). */
export function AuditTab() {
  const { data: users = [] } = useUsers();
  const [f, setF] = useState({ action: '', actor: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams();
  if (f.action) params.set('action', f.action);
  if (f.actor) params.set('actor', f.actor);
  if (f.from) params.set('from', new Date(f.from).toISOString());
  if (f.to) params.set('to', new Date(new Date(f.to).getTime() + 864e5).toISOString());
  const qs = params.toString();
  const log = useQuery({
    queryKey: ['audit', qs, offset],
    queryFn: () => get<{ entries: Entry[]; total: number }>(`/admin/audit?limit=${PAGE}&offset=${offset}${qs ? `&${qs}` : ''}`),
  });
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setOffset(0); };
  const total = log.data?.total ?? 0;
  return (
    <>
      <h2>Audit log</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>Security-relevant activity in this workspace: logins, member and role changes, sharing, exports and settings.</p>
      <div className="adm-toolbar">
        <select className="select" value={f.action} onChange={(e) => set({ action: e.target.value })}>
          {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="select" value={f.actor} onChange={(e) => set({ actor: e.target.value })}>
          <option value="">Anyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input className="input" type="date" style={{ width: 150, height: 30 }} value={f.from} onChange={(e) => set({ from: e.target.value })} title="From" />
        <input className="input" type="date" style={{ width: 150, height: 30 }} value={f.to} onChange={(e) => set({ to: e.target.value })} title="To" />
        <span style={{ flex: 1 }} />
        <a className="btn sm" href={`/api/v1/admin/audit.csv${qs ? `?${qs}` : ''}`} download><Download size={14} /> Export CSV</a>
      </div>
      <table className="set-table adm-audit">
        <thead><tr><th style={{ width: 150 }}>Time</th><th style={{ width: 170 }}>Who</th><th>What</th><th style={{ width: 110 }}>IP</th></tr></thead>
        <tbody>
          {(log.data?.entries ?? []).map((e) => (
            <tr key={e.id}>
              <td className="muted" title={e.created_at}>{new Date(e.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td>
                {e.actor ? (
                  <div className="set-user"><Avatar user={e.actor} size={20} /><span>{e.actor.name}</span></div>
                ) : <span className="muted">System</span>}
              </td>
              <td>
                <div>{describe(e)}</div>
                <div className="adm-action">{e.action}</div>
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{e.ip ?? ''}</td>
            </tr>
          ))}
          {log.data && !log.data.entries.length && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No activity matches these filters</td></tr>}
        </tbody>
      </table>
      {total > PAGE && (
        <div className="adm-pager">
          <span className="faint">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <button className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft size={16} /></button>
          <button className="icon-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}><ChevronRight size={16} /></button>
        </div>
      )}
    </>
  );
}
