import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, KeyRound, LogOut, MoreHorizontal, PenLine, Plus, Power, Trash2, UserPlus, Users as UsersIcon, Copy } from 'lucide-react';
import { del, get, patch, post, queryClient } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import type { Role } from '../../lib/types';
import { Avatar, MenuItem, Modal, Popover, timeAgo, toast } from '../ui';
import { EMAIL_RE, useWorkspaceSettings } from './useWorkspaceSettings';
import './admin.css';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  active: boolean;
  role: Role;
  joined_at: string;
  last_active_at: string | null;
  session_count: number;
  signin_method?: 'auto' | 'sso' | 'password';
  sso_linked?: boolean;
}

const SIGNIN_LABEL = { auto: 'Automatic (by email domain)', sso: 'Single sign-on only', password: 'Password' } as const;

const ROLE_LABEL: Record<Role, string> = { owner: 'Workspace owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

const copy = (t: string, msg = 'Copied to clipboard') => navigator.clipboard?.writeText(t).then(() => toast(msg), () => toast(t));

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
    return true;
  } catch (e: any) {
    toast(e.message);
    return false;
  }
}

const refreshAll = () => {
  queryClient.invalidateQueries({ queryKey: ['admin-users'] });
  queryClient.invalidateQueries({ queryKey: ['users'] });
  queryClient.invalidateQueries({ queryKey: ['invites'] });
};

/** Admin view of members: search/filter, create, bulk invite, edit, reset password, sign out, deactivate, offboard, export. */
export function AdminMembers() {
  const { data: me } = useMe();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('all');
  const [dialog, setDialog] = useState<null | { kind: 'create' } | { kind: 'bulk' } | { kind: 'edit'; user: AdminUser } | { kind: 'offboard'; user: AdminUser }>(null);
  const users = useQuery({
    queryKey: ['admin-users', search, role, status],
    queryFn: () => get<{ users: AdminUser[]; total: number }>(`/admin/users?limit=500&status=${status}${role ? `&role=${role}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`),
  });
  const list = users.data?.users ?? [];
  return (
    <>
      <div className="adm-toolbar">
        <input className="input" style={{ width: 220, height: 30 }} placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          {(['owner', 'admin', 'member', 'guest'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="deactivated">Deactivated</option>
        </select>
        <span style={{ flex: 1 }} />
        <a className="btn sm" href="/api/v1/admin/users.csv" download><Download size={14} /> Export CSV</a>
        <button className="btn sm" onClick={() => setDialog({ kind: 'bulk' })}><UsersIcon size={14} /> Bulk invite</button>
        <button className="btn sm primary" onClick={() => setDialog({ kind: 'create' })}><UserPlus size={14} /> Add member</button>
      </div>
      <div className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>{users.data ? `${users.data.total} ${users.data.total === 1 ? 'person' : 'people'}` : 'Loading…'}</div>
      <table className="set-table">
        <thead><tr><th>User</th><th>Role</th><th>Last active</th><th>Status</th><th /></tr></thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
              <td>
                <div className="set-user">
                  <Avatar user={u} size={28} />
                  <div>
                    <div>{u.name}{u.id === me?.id ? ' (You)' : ''}</div>
                    <div className="e">{u.email}{u.sso_linked ? ' · SSO' : ''}{u.signin_method && u.signin_method !== 'auto' ? ` · ${u.signin_method === 'sso' ? 'SSO only' : 'Password'}` : ''}</div>
                  </div>
                </div>
              </td>
              <td>
                {u.id !== me?.id && (u.role !== 'owner' || me?.role === 'owner') ? (
                  <select
                    className="select"
                    value={u.role}
                    onChange={(e) => run(async () => { await patch(`/admin/users/${u.id}`, { role: e.target.value }); refreshAll(); }, 'Role updated')}
                  >
                    {(['owner', 'admin', 'member', 'guest'] as Role[]).filter((r) => r !== 'owner' || me?.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                ) : (
                  <span className="muted">{ROLE_LABEL[u.role]}</span>
                )}
              </td>
              <td className="muted">{u.last_active_at ? timeAgo(u.last_active_at) : 'Never'}</td>
              <td className="muted">{u.active ? 'Active' : 'Deactivated'}</td>
              <td style={{ textAlign: 'right' }}>
                {u.id !== me?.id && (u.role !== 'owner' || me?.role === 'owner') && (
                  <RowMenu user={u} onEdit={() => setDialog({ kind: 'edit', user: u })} onOffboard={() => setDialog({ kind: 'offboard', user: u })} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dialog?.kind === 'create' && <CreateUserDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'bulk' && <BulkInviteDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditUserDialog user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'offboard' && <OffboardDialog user={dialog.user} onClose={() => setDialog(null)} />}
    </>
  );
}

function RowMenu({ user, onEdit, onOffboard }: { user: AdminUser; onEdit: () => void; onOffboard: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <>
      <button ref={btn} className="icon-btn" title="Manage user" onClick={() => setOpen(true)}><MoreHorizontal size={16} /></button>
      <Popover anchor={btn.current} open={open} onClose={close} placement="bottom-end" width={260}>
        <MenuItem icon={<PenLine size={16} />} onClick={() => { close(); onEdit(); }}>Edit name or email</MenuItem>
        <MenuItem icon={<KeyRound size={16} />} disabled={!user.active} onClick={() => { close(); run(() => post(`/admin/users/${user.id}/reset-password`, { sendEmail: true }), `Password reset email sent to ${user.email}`); }}>Send password reset email</MenuItem>
        <MenuItem icon={<Copy size={16} />} disabled={!user.active} onClick={() => { close(); run(async () => { const r = await post<{ url?: string }>(`/admin/users/${user.id}/reset-password`, { sendEmail: false }); if (r.url) copy(r.url, 'One-time reset link copied (valid 24h)'); }); }}>Copy password reset link</MenuItem>
        <MenuItem icon={<LogOut size={16} />} onClick={() => { close(); run(async () => { const r = await post<{ revoked: Record<string, number> }>(`/admin/users/${user.id}/logout`, { oauth: true }); refreshAll(); toast(`Signed out of ${r.revoked.sessions ?? 0} session(s)`); }); }}>Sign out everywhere</MenuItem>
        <div className="menu-sep" />
        <MenuItem icon={<Power size={16} />} onClick={() => { close(); run(async () => { await post(`/admin/users/${user.id}/${user.active ? 'deactivate' : 'reactivate'}`, {}); refreshAll(); }, user.active ? `${user.name} deactivated` : `${user.name} reactivated`); }}>
          {user.active ? 'Deactivate' : 'Reactivate'}
        </MenuItem>
        <MenuItem icon={<Trash2 size={16} />} danger onClick={() => { close(); onOffboard(); }}>Remove from workspace…</MenuItem>
      </Popover>
    </>
  );
}

function Dialog({ title, children, onClose, width = 480 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  return (
    <Modal open onClose={onClose} width={width}>
      <div className="adm-dialog">
        <h3>{title}</h3>
        {children}
      </div>
    </Modal>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'member' as Role, sendEmail: true, signinMethod: 'auto' as 'auto' | 'sso' | 'password' });
  const [groups, setGroups] = useState<string[]>([]);
  const [teamspaces, setTeamspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ setPasswordUrl: string | null; emailed: boolean; signin?: 'sso' | 'password' } | null>(null);
  const g = useQuery({ queryKey: ['groups'], queryFn: () => get<{ id: string; name: string }[]>('/groups') });
  const t = useQuery({ queryKey: ['teamspaces-admin'], queryFn: () => get<{ id: string; name: string; icon: string | null }[]>('/teamspaces') });
  const valid = f.name.trim() && EMAIL_RE.test(f.email.trim());
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  if (result) {
    return (
      <Dialog title="Member added" onClose={onClose}>
        <p className="muted" style={{ fontSize: 14 }}>
          {result.signin === 'sso'
            ? `${f.email} signs in with single sign-on — no password needed.${result.emailed ? ' We emailed them a sign-in link.' : ''}`
            : result.emailed ? `We emailed ${f.email} a link to set their password.` : 'Send them this one-time link to set their password (valid 7 days):'}
        </p>
        {!result.emailed && result.setPasswordUrl && (
          <div className="token-box"><span style={{ flex: 1 }}>{result.setPasswordUrl}</span><button className="icon-btn" onClick={() => copy(result.setPasswordUrl!)}><Copy size={14} /></button></div>
        )}
        <div className="adm-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Add a member" onClose={onClose} width={520}>
      <label className="adm-label">Name</label>
      <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <label className="adm-label">Email</label>
      <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <label className="adm-label">Role</label>
      <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="guest">Guest</option>
      </select>
      <label className="adm-label">Sign-in</label>
      <select className="select" value={f.signinMethod} onChange={(e) => setF({ ...f, signinMethod: e.target.value as any })}>
        {(['auto', 'sso', 'password'] as const).map((m) => <option key={m} value={m}>{SIGNIN_LABEL[m]}</option>)}
      </select>
      <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Automatic: staff email domains use single sign-on; anyone else (guests, contractors) gets a password.</div>
      {!!g.data?.length && (
        <>
          <label className="adm-label">Groups</label>
          <div className="adm-chips">{g.data.map((x) => <button key={x.id} className={`adm-chip ${groups.includes(x.id) ? 'on' : ''}`} onClick={() => toggle(groups, setGroups, x.id)}>{x.name}</button>)}</div>
        </>
      )}
      {!!t.data?.length && f.role !== 'guest' && (
        <>
          <label className="adm-label">Teamspaces</label>
          <div className="adm-chips">{t.data.map((x) => <button key={x.id} className={`adm-chip ${teamspaces.includes(x.id) ? 'on' : ''}`} onClick={() => toggle(teamspaces, setTeamspaces, x.id)}>{x.icon} {x.name}</button>)}</div>
        </>
      )}
      <label className="adm-check"><input type="checkbox" checked={f.sendEmail} onChange={(e) => setF({ ...f, sendEmail: e.target.checked })} /> Email them a link to set their password</label>
      <div className="adm-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            await run(async () => {
              const r = await post<{ setPasswordUrl: string | null; emailed: boolean; signin: 'sso' | 'password' }>('/admin/users', { ...f, name: f.name.trim(), email: f.email.trim(), groups, teamspaces: f.role === 'guest' ? [] : teamspaces });
              refreshAll();
              setResult(r);
            });
            setBusy(false);
          }}
        >
          <Plus size={14} /> Add member
        </button>
      </div>
    </Dialog>
  );
}

function BulkInviteDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ results: { email: string; status: string; url?: string; emailed?: boolean }[]; summary: Record<string, number> } | null>(null);
  const settings = useWorkspaceSettings();
  const count = new Set((text.match(/[^\s,;"'<>()]+@[^\s,;"'<>()]+/g) ?? []).map((e) => e.toLowerCase())).size;
  const STATUS: Record<string, string> = { invited: 'Invited', already_invited: 'Already invited (re-sent)', already_member: 'Already a member', invalid: 'Not a valid email', duplicate: 'Duplicate' };
  return (
    <Dialog title="Invite people in bulk" onClose={onClose} width={600}>
      {!res ? (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Paste email addresses separated by commas or new lines, or paste a CSV — we'll pick out the emails.</p>
          <textarea className="input" rows={8} style={{ fontFamily: 'var(--mono)', fontSize: 13 }} placeholder={'ada@example.com, grace@example.com\nor paste a CSV export…'} value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span className="adm-label" style={{ margin: 0 }}>Invite as</span>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              {settings.data?.allow_guests !== false && <option value="guest">Guest</option>}
            </select>
            <span className="faint" style={{ fontSize: 12 }}>{count} email{count === 1 ? '' : 's'} found</span>
          </div>
          <label className="adm-label">Personal message (optional)</label>
          <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Welcome to our new wiki!" />
          <div className="adm-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button
              className="btn primary"
              disabled={!count || busy}
              onClick={async () => {
                setBusy(true);
                await run(async () => { setRes(await post('/admin/invites/bulk', { csv: text, role, message: message || undefined })); refreshAll(); });
                setBusy(false);
              }}
            >
              Send {count || ''} invite{count === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14 }}>
            {res.summary.invited} invited · {res.summary.already_invited} already invited · {res.summary.already_member} already members · {res.summary.invalid + res.summary.duplicate} skipped
          </p>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="set-table">
              <tbody>
                {res.results.map((r, i) => (
                  <tr key={i}>
                    <td>{r.email}</td>
                    <td className="muted">{STATUS[r.status] ?? r.status}{r.url && r.emailed === false ? ' — email not sent' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{r.url && <button className="icon-btn" title="Copy invite link" onClick={() => copy(r.url!)}><Copy size={14} /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="adm-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      )}
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [f, setF] = useState({ name: user.name, email: user.email, signinMethod: user.signin_method ?? 'auto' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Edit ${user.name}`} onClose={onClose}>
      <label className="adm-label">Name</label>
      <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <label className="adm-label">Email</label>
      <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Changing the email changes how they log in. Any pending password reset links stop working.</div>
      {user.role !== 'owner' && (
        <>
          <label className="adm-label">Sign-in</label>
          <select className="select" value={f.signinMethod} onChange={(e) => setF({ ...f, signinMethod: e.target.value as any })}>
            {(['auto', 'sso', 'password'] as const).map((m) => <option key={m} value={m}>{SIGNIN_LABEL[m]}</option>)}
          </select>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Use “Password” for someone outside the identity provider (e.g. a contractor on a staff domain). Switching to SSO signs them out.</div>
        </>
      )}
      <div className="adm-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || !f.name.trim() || !EMAIL_RE.test(f.email.trim())}
          onClick={async () => {
            setBusy(true);
            const ok = await run(async () => { await patch(`/admin/users/${user.id}`, { name: f.name.trim(), email: f.email.trim(), ...(user.role !== 'owner' ? { signinMethod: f.signinMethod } : {}) }); refreshAll(); }, 'Saved');
            setBusy(false);
            if (ok) onClose();
          }}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}

function OffboardDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { data: me } = useMe();
  const detail = useQuery({ queryKey: ['admin-user', user.id], queryFn: () => get<any>(`/admin/users/${user.id}`) });
  const candidates = useQuery({ queryKey: ['admin-users', 'transfer'], queryFn: () => get<{ users: AdminUser[] }>('/admin/users?status=active&limit=500') });
  const ts = useQuery({ queryKey: ['teamspaces-admin'], queryFn: () => get<{ id: string; name: string; icon: string | null }[]>('/teamspaces') });
  const [to, setTo] = useState(me?.id ?? '');
  const [teamspace, setTeamspace] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const roots = detail.data?.counts?.private_roots ?? 0;
  const recipients = (candidates.data?.users ?? []).filter((u) => u.id !== user.id && u.role !== 'guest');
  return (
    <Dialog title={`Remove ${user.name} from the workspace`} onClose={onClose} width={540}>
      <p style={{ fontSize: 14, marginTop: 0 }}>
        They lose access immediately: sessions, API tokens and connected apps are revoked, and their contact details are removed. Pages and comments they wrote keep showing their name.
      </p>
      <label className="adm-label">Transfer their private pages{detail.data ? ` (${roots} top-level)` : ''} to</label>
      <select className="select" style={{ width: '100%' }} value={to} onChange={(e) => setTo(e.target.value)}>
        {recipients.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me?.id ? ' (You)' : ''} — {u.email}</option>)}
      </select>
      <label className="adm-label">Place them in</label>
      <select className="select" style={{ width: '100%' }} value={teamspace} onChange={(e) => setTeamspace(e.target.value)}>
        <option value="">Recipient's Private section</option>
        {(ts.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name} (teamspace)</option>)}
      </select>
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Pages are moved into a page called “From {user.name}”.</div>
      <label className="adm-label">Type <b>{user.email}</b> to confirm</label>
      <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div className="adm-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn danger"
          disabled={busy || !to || confirm.trim().toLowerCase() !== user.email.toLowerCase()}
          onClick={async () => {
            setBusy(true);
            const ok = await run(async () => {
              const r = await del<{ transferredRoots: number }>(`/admin/users/${user.id}?transferTo=${to}${teamspace ? `&teamspaceId=${teamspace}` : ''}`);
              refreshAll();
              queryClient.invalidateQueries({ queryKey: ['tree'] });
              toast(`${user.name} removed${r.transferredRoots ? ` — ${r.transferredRoots} page(s) transferred` : ''}`);
            });
            setBusy(false);
            if (ok) onClose();
          }}
        >
          Remove from workspace
        </button>
      </div>
    </Dialog>
  );
}
