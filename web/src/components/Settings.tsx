import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Building2, Check, Copy, KeyRound, LogOut, Plus, Settings2, Trash2, User as UserIcon, Users, UsersRound, X, Layers,
} from 'lucide-react';
import { del, get, patch, post, put, queryClient, uploadFile } from '../lib/api';
import { useMe, useUsers } from '../lib/hooks';
import { applyTheme, useUi } from '../lib/store';
import type { Level, Role } from '../lib/types';
import { Avatar, Modal, Toggle, timeAgo, toast } from './ui';
import './collab.css';
import { Bell } from 'lucide-react';
import { NotificationsTab } from './settings/NotificationsTab';
import { SsoTab } from './settings/SsoTab';
import { ShieldCheck } from 'lucide-react';
import { ScrollText } from 'lucide-react';
import { AdminMembers } from './settings/AdminMembers';
import { SessionsSection } from './settings/SessionsSection';
import { AuditTab } from './settings/AuditTab';
import { SecuritySection } from './settings/SecuritySection';
import { AiSettingsTab } from '../ai/AiSettingsTab';
import { Sparkles } from 'lucide-react';
import { Upload } from 'lucide-react';
import { ImportTab } from './settings/ImportTab';

const copy = (t: string, msg = 'Copied to clipboard') => navigator.clipboard?.writeText(t).then(() => toast(msg), () => toast(t));
const go = (tab: string) => useUi.getState().set({ settings: tab });
const isAdmin = (r?: Role) => r === 'owner' || r === 'admin';

function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="l">
        <div>{label}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function useRun() {
  return async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e: any) {
      toast(e.message);
    }
  };
}

// ---------------- account ----------------
function Account() {
  const { data: me } = useMe();
  const [name, setName] = useState(me?.name ?? '');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [showPw, setShowPw] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useRun();
  useEffect(() => setName(me?.name ?? ''), [me?.name]);
  if (!me) return null;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['me'] });
    queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  return (
    <>
      <h2>My account</h2>
      <div className="set-row" style={{ justifyContent: 'flex-start' }}>
        <span className="avatar-upload" onClick={() => fileRef.current?.click()}>
          <Avatar user={me} size={60} />
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) run(async () => { const up = await uploadFile(f); await patch('/me', { avatar_url: up.url }); refresh(); }, 'Photo updated');
          }}
        />
        <div style={{ flex: 1, maxWidth: 280 }}>
          <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Preferred name</div>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== me.name && run(async () => { await patch('/me', { name: name.trim() }); refresh(); }, 'Name updated')}
          />
        </div>
        {me.avatar_url && (
          <button className="btn sm" onClick={() => run(async () => { await patch('/me', { avatar_url: null }); refresh(); })}>Remove photo</button>
        )}
      </div>
      <h3>Account security</h3>
      <Row label="Email" desc={me.email} />
      <Row label="Password" desc="Change the password you use to log in">
        <button className="btn sm" onClick={() => setShowPw(!showPw)}>Change password</button>
      </Row>
      {showPw && (
        <div className="set-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
          <input className="input" type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <input className="input" type="password" placeholder="New password (8+ characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <div>
            <button
              className="btn primary sm"
              disabled={pw.next.length < 8}
              onClick={() => run(async () => { await patch('/me', { password: pw.next, currentPassword: pw.current }); setPw({ current: '', next: '' }); setShowPw(false); }, 'Password changed')}
            >
              Update password
            </button>
          </div>
        </div>
      )}
      <h3>Preferences</h3>
      <Row label="Appearance" desc="Customize how Atrium looks on your device">
        <select
          className="select"
          value={me.theme}
          onChange={(e) => {
            const theme = e.target.value;
            applyTheme(theme);
            run(async () => { await patch('/me', { theme }); refresh(); });
          }}
        >
          <option value="system">Use system setting</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Row>
      <h3>Session</h3>
      <Row label="Log out" desc="Log out of this device">
        <button
          className="btn sm danger"
          onClick={async () => {
            const r = await post('/auth/logout');
            location.href = r?.redirect || '/login';
          }}
        >
          <LogOut size={14} /> Log out
        </button>
      </Row>
      <SessionsSection />
    </>
  );
}

// ---------------- workspace ----------------
function Workspace() {
  const { data: me } = useMe();
  const [name, setName] = useState(me?.workspace.name ?? '');
  const [icon, setIcon] = useState(me?.workspace.icon ?? '');
  const run = useRun();
  if (!me) return null;
  const admin = isAdmin(me.role);
  const save = () =>
    run(async () => {
      await patch('/workspace', { name: name.trim() || me.workspace.name, icon: icon || null });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    }, 'Workspace updated');
  return (
    <>
      <h2>Workspace</h2>
      <Row label="Name" desc="You can use your organization or company name">
        <input className="input" style={{ width: 260 }} disabled={!admin} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== me.workspace.name && save()} />
      </Row>
      <Row label="Icon" desc="An emoji shown next to the workspace name">
        <input className="input" style={{ width: 80, textAlign: 'center' }} disabled={!admin} maxLength={4} value={icon} onChange={(e) => setIcon(e.target.value)} onBlur={() => icon !== (me.workspace.icon ?? '') && save()} />
      </Row>
      {!admin && <div className="faint" style={{ fontSize: 13, marginTop: 8 }}>Only workspace owners and admins can change these settings.</div>}
      {admin && <SecuritySection />}
    </>
  );
}

// ---------------- members ----------------
const ROLES: { v: Role; label: string; desc: string }[] = [
  { v: 'owner', label: 'Workspace owner', desc: 'Can change workspace settings and invite new members' },
  { v: 'admin', label: 'Admin', desc: 'Can manage members, groups and teamspaces' },
  { v: 'member', label: 'Member', desc: 'Can create pages and teamspaces' },
  { v: 'guest', label: 'Guest', desc: 'Only sees pages explicitly shared with them' },
];

function Members() {
  const { data: me } = useMe();
  const { data: users = [] } = useUsers();
  const admin = isAdmin(me?.role);
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => get<any[]>('/invites'), enabled: admin });
  const [inv, setInv] = useState<{ role: Role; email: string }>({ role: 'member', email: '' });
  const [link, setLink] = useState('');
  const [filter, setFilter] = useState('');
  const run = useRun();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const shown = users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <h2>Members</h2>
      {admin && (
        <>
          <h3>Invite people</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input" placeholder="Email (optional — leave blank for a reusable link)" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            <select className="select" style={{ height: 32 }} value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as Role })}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="guest">Guest</option>
            </select>
            <button
              className="btn primary"
              onClick={() =>
                run(async () => {
                  const r = await post<{ url: string }>('/invites', { role: inv.role, email: inv.email || undefined });
                  const url = location.origin + r.url;
                  setLink(url);
                  copy(url, 'Invite link copied');
                  setInv({ ...inv, email: '' });
                  invites.refetch();
                })
              }
            >
              Create link
            </button>
          </div>
          {link && (
            <div className="token-box" style={{ marginTop: 8 }}>
              <span style={{ flex: 1 }}>{link}</span>
              <button className="icon-btn" onClick={() => copy(link)}><Copy size={14} /></button>
            </div>
          )}
          {!!invites.data?.length && (
            <>
              <h3>Pending invites</h3>
              <table className="set-table">
                <thead><tr><th>Invite</th><th>Role</th><th>Expires</th><th /></tr></thead>
                <tbody>
                  {invites.data.map((i) => (
                    <tr key={i.token}>
                      <td>{i.email ?? <span className="muted">Anyone with the link</span>}</td>
                      <td style={{ textTransform: 'capitalize' }}>{i.role}</td>
                      <td className="muted">{new Date(i.expires_at).toLocaleDateString()}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="icon-btn" title="Copy link" onClick={() => copy(`${location.origin}/invite/${i.token}`)}><Copy size={14} /></button>
                        <button className="icon-btn" title="Revoke" onClick={() => run(async () => { await del(`/invites/${i.token}`); invites.refetch(); })}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {admin ? (
        <>
          <h3>People</h3>
          <AdminMembers />
        </>
      ) : (<>
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{users.length} members</span>
        <input className="input" style={{ width: 200, height: 28 }} placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </h3>
      <table className="set-table">
        <thead><tr><th>User</th><th>Role</th><th>Status</th>{admin && <th />}</tr></thead>
        <tbody>
          {shown.map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
              <td>
                <div className="set-user">
                  <Avatar user={u} size={28} />
                  <div>
                    <div>{u.name}{u.id === me?.id ? ' (You)' : ''}</div>
                    <div className="e">{u.email}</div>
                  </div>
                </div>
              </td>
              <td>
                {admin && u.id !== me?.id && (u.role !== 'owner' || me?.role === 'owner') ? (
                  <select
                    className="select"
                    value={u.role}
                    title={ROLES.find((r) => r.v === u.role)?.desc}
                    onChange={(e) => run(async () => { await patch(`/users/${u.id}`, { role: e.target.value }); refresh(); }, 'Role updated')}
                  >
                    {ROLES.filter((r) => r.v !== 'owner' || me?.role === 'owner').map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                  </select>
                ) : (
                  <span className="muted">{ROLES.find((r) => r.v === u.role)?.label}</span>
                )}
              </td>
              <td className="muted">{u.active ? 'Active' : 'Deactivated'}</td>
              {admin && (
                <td style={{ textAlign: 'right' }}>
                  {u.id !== me?.id && (
                    <button className={`btn sm ${u.active ? 'danger' : ''}`} onClick={() => run(async () => { await patch(`/users/${u.id}`, { active: !u.active }); refresh(); })}>
                      {u.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </>)}
    </>
  );
}

// ---------------- groups ----------------
function MemberPicker({ exclude, onPick, label = 'Add member' }: { exclude: string[]; onPick: (id: string) => void; label?: string }) {
  const { data: users = [] } = useUsers();
  const opts = users.filter((u) => u.active && !exclude.includes(u.id));
  return (
    <select className="select" value="" onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!opts.length}>
      <option value="">{label}…</option>
      {opts.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );
}

function Groups() {
  const { data: me } = useMe();
  const admin = isAdmin(me?.role);
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<{ id: string; name: string; members: { id: string; name: string; avatar_url: string | null }[] }[]>('/groups') });
  const [name, setName] = useState('');
  const run = useRun();
  const refresh = () => groups.refetch();
  const setMembers = (id: string, members: string[]) => run(async () => { await patch(`/groups/${id}`, { members }); refresh(); });
  return (
    <>
      <h2>Groups</h2>
      <div className="muted" style={{ fontSize: 13, margin: '8px 0 16px' }}>Groups let you share pages with many people at once, e.g. "Finance" or "Engineering".</div>
      {admin && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input className="input" placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && run(async () => { await post('/groups', { name: name.trim() }); setName(''); refresh(); })} />
          <button className="btn primary" disabled={!name.trim()} onClick={() => run(async () => { await post('/groups', { name: name.trim() }); setName(''); refresh(); })}>
            <Plus size={14} /> Create group
          </button>
        </div>
      )}
      {!groups.data?.length && <div className="empty-state">No groups yet</div>}
      {groups.data?.map((g) => (
        <div className="set-card" key={g.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <UsersRound size={16} className="faint" />
            {admin ? (
              <input
                className="input"
                style={{ height: 28, maxWidth: 260, fontWeight: 600 }}
                defaultValue={g.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== g.name && run(async () => { await patch(`/groups/${g.id}`, { name: e.target.value.trim() }); refresh(); })}
              />
            ) : (
              <b>{g.name}</b>
            )}
            <span className="faint" style={{ fontSize: 12 }}>{g.members.length} members</span>
            <span style={{ flex: 1 }} />
            {admin && <button className="icon-btn" title="Delete group" onClick={() => run(async () => { await del(`/groups/${g.id}`); refresh(); })}><Trash2 size={14} /></button>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
            {g.members.map((m) => (
              <span className="chip" key={m.id}>
                <Avatar user={m} size={18} /> {m.name}
                {admin && <button onClick={() => setMembers(g.id, g.members.filter((x) => x.id !== m.id).map((x) => x.id))}><X size={12} /></button>}
              </span>
            ))}
            {admin && <MemberPicker exclude={g.members.map((m) => m.id)} onPick={(id) => setMembers(g.id, [...g.members.map((m) => m.id), id])} />}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------- teamspaces ----------------
interface TS {
  id: string; name: string; icon: string | null; description: string | null; is_default: boolean; default_level: Level;
  my_role: 'owner' | 'member' | null; members: { id: string; name: string; avatar_url: string | null; role: 'owner' | 'member' }[];
}
function Teamspaces() {
  const { data: me } = useMe();
  const ts = useQuery({ queryKey: ['teamspaces'], queryFn: () => get<TS[]>('/teamspaces') });
  const [form, setForm] = useState({ name: '', icon: '📁' });
  const run = useRun();
  const refresh = () => {
    ts.refetch();
    queryClient.invalidateQueries({ queryKey: ['tree'] });
  };
  const canCreate = me?.role !== 'guest';
  return (
    <>
      <h2>Teamspaces</h2>
      <div className="muted" style={{ fontSize: 13, margin: '8px 0 16px' }}>Teamspaces are dedicated spaces for every team. Default teamspaces are open to everyone in the workspace.</div>
      {canCreate && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input className="input" style={{ width: 56, textAlign: 'center' }} value={form.icon} maxLength={4} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
          <input className="input" placeholder="Teamspace name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <button className="btn primary" disabled={!form.name.trim()} onClick={() => run(async () => { await post('/teamspaces', { name: form.name.trim(), icon: form.icon || '📁' }); setForm({ name: '', icon: '📁' }); refresh(); }, 'Teamspace created')}>
            <Plus size={14} /> Create
          </button>
        </div>
      )}
      {ts.data?.map((t) => {
        const manage = isAdmin(me?.role) || t.my_role === 'owner';
        const memberIds = t.members.map((m) => m.id);
        return (
          <div className="set-card" key={t.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="input" style={{ width: 48, textAlign: 'center', height: 28 }} disabled={!manage} defaultValue={t.icon ?? ''} maxLength={4}
                onBlur={(e) => e.target.value !== (t.icon ?? '') && run(async () => { await patch(`/teamspaces/${t.id}`, { icon: e.target.value }); refresh(); })} />
              <input className="input" style={{ height: 28, fontWeight: 600 }} disabled={!manage} defaultValue={t.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && run(async () => { await patch(`/teamspaces/${t.id}`, { name: e.target.value.trim() }); refresh(); })} />
              {!t.my_role && !t.is_default && me && (
                <button className="btn sm" onClick={() => run(async () => { await put(`/teamspaces/${t.id}/members/${me.id}`, {}); refresh(); })}>Join</button>
              )}
              {t.my_role && (
                <button className="btn sm" onClick={() => run(async () => { await del(`/teamspaces/${t.id}/members/${me!.id}`); refresh(); })}>Leave</button>
              )}
              {manage && <button className="icon-btn" title="Delete teamspace (pages move to trash)" onClick={() => run(async () => { await del(`/teamspaces/${t.id}`); refresh(); }, 'Teamspace deleted')}><Trash2 size={14} /></button>}
            </div>
            <input className="input" style={{ marginTop: 6, height: 28 }} placeholder="Description" disabled={!manage} defaultValue={t.description ?? ''}
              onBlur={(e) => e.target.value !== (t.description ?? '') && run(async () => { await patch(`/teamspaces/${t.id}`, { description: e.target.value }); refresh(); })} />
            <Row label="Default teamspace" desc="Everyone in the workspace can see and access it">
              <Toggle checked={t.is_default} onChange={(v) => manage && run(async () => { await patch(`/teamspaces/${t.id}`, { is_default: v }); refresh(); })} />
            </Row>
            <Row label="Member access" desc="What members can do with pages in this teamspace">
              <select className="select" disabled={!manage} value={t.default_level} onChange={(e) => run(async () => { await patch(`/teamspaces/${t.id}`, { default_level: e.target.value }); refresh(); })}>
                <option value="full">Full access</option>
                <option value="edit">Can edit</option>
                <option value="comment">Can comment</option>
                <option value="view">Can view</option>
              </select>
            </Row>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
              {t.members.map((m) => (
                <span className="chip" key={m.id} title={m.role === 'owner' ? 'Teamspace owner' : 'Member'}>
                  <Avatar user={m} size={18} /> {m.name}
                  {m.role === 'owner' && <span className="faint" style={{ fontSize: 11 }}>owner</span>}
                  {manage && (
                    <>
                      <button title={m.role === 'owner' ? 'Make member' : 'Make owner'} onClick={() => run(async () => { await put(`/teamspaces/${t.id}/members/${m.id}`, { role: m.role === 'owner' ? 'member' : 'owner' }); refresh(); })}>
                        <Check size={12} />
                      </button>
                      <button title="Remove" onClick={() => run(async () => { await del(`/teamspaces/${t.id}/members/${m.id}`); refresh(); })}><X size={12} /></button>
                    </>
                  )}
                </span>
              ))}
              {manage && <MemberPicker exclude={memberIds} onPick={(id) => run(async () => { await put(`/teamspaces/${t.id}/members/${id}`, {}); refresh(); })} />}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------------- API ----------------
function McpSection() {
  const conns = useQuery({ queryKey: ['oauth-connections'], queryFn: () => get<{ client_id: string; name: string; connected_at: string; last_used_at: string }[]>('/oauth/connections') });
  const run = useRun();
  const mcpUrl = `${location.origin}/mcp`;
  return (
    <>
      <h3>Connect AI tools (MCP)</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        Atrium has a built-in MCP server, so Claude and other AI tools can search, read and edit your workspace with your permissions.
      </div>
      <Row label="MCP server URL" desc={mcpUrl}><button className="btn sm" onClick={() => copy(mcpUrl)}><Copy size={13} /> Copy</button></Row>
      <div className="code-block">{`# Claude.ai / Claude Desktop
Settings → Connectors → Add custom connector → paste ${mcpUrl}
(you'll be asked to sign in to Atrium and allow access)

# Claude Code (uses an API token from above)
claude mcp add --transport http atrium ${mcpUrl} \\
  --header "Authorization: Bearer $ATRIUM_TOKEN"`}</div>
      <h3>Connected apps</h3>
      {!conns.data?.length && <div className="faint" style={{ fontSize: 13 }}>No apps connected yet.</div>}
      {!!conns.data?.length && (
        <table className="set-table">
          <thead><tr><th>App</th><th>Connected</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {conns.data.map((c) => (
              <tr key={c.client_id}>
                <td>{c.name}</td>
                <td className="muted">{timeAgo(c.connected_at)}</td>
                <td className="muted">{timeAgo(c.last_used_at)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm danger" onClick={() => run(async () => { await del(`/oauth/connections/${encodeURIComponent(c.client_id)}`); conns.refetch(); }, 'Disconnected')}>Disconnect</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Api() {
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => get<{ id: string; name: string; prefix: string; created_at: string; last_used_at: string | null }[]>('/tokens') });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const run = useRun();
  const base = `${location.origin}/api/v1`;
  return (
    <>
      <h2>API & integrations</h2>
      <div className="muted" style={{ fontSize: 13, margin: '8px 0 16px' }}>
        Personal integration tokens let scripts and tools use the Atrium API with your permissions.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" placeholder="Token name, e.g. “Reporting script”" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn primary"
          onClick={() =>
            run(async () => {
              const r = await post<{ token: string }>('/tokens', { name: name.trim() || 'Integration' });
              setCreated(r.token);
              setName('');
              tokens.refetch();
            })
          }
        >
          <Plus size={14} /> New token
        </button>
      </div>
      {created && (
        <div className="set-card" style={{ marginTop: 12, borderColor: 'var(--accent)' }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Copy your token now — you won't be able to see it again.</div>
          <div className="token-box">
            <span style={{ flex: 1 }}>{created}</span>
            <button className="icon-btn" onClick={() => copy(created, 'Token copied')}><Copy size={14} /></button>
          </div>
        </div>
      )}
      <h3>Your tokens</h3>
      {!tokens.data?.length && <div className="faint" style={{ fontSize: 13 }}>No tokens yet.</div>}
      {!!tokens.data?.length && (
        <table className="set-table">
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {tokens.data.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{t.prefix}…</td>
                <td className="muted">{timeAgo(t.created_at)}</td>
                <td className="muted">{t.last_used_at ? timeAgo(t.last_used_at) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm danger" onClick={() => run(async () => { await del(`/tokens/${t.id}`); tokens.refetch(); }, 'Token revoked')}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <McpSection />
      <h3>Quick start</h3>
      <Row label="Base URL" desc={base}><button className="btn sm" onClick={() => copy(base)}><Copy size={13} /> Copy</button></Row>
      <Row label="OpenAPI spec" desc="Machine-readable description of every endpoint">
        <a className="btn sm" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">Open</a>
      </Row>
      <div className="code-block">{`# Search pages
curl -H "Authorization: Bearer $ATRIUM_TOKEN" "${base}/search?q=roadmap"

# Read a page as Markdown
curl -H "Authorization: Bearer $ATRIUM_TOKEN" "${base}/pages/<page-id>/content?format=markdown"

# Append Markdown to a page
curl -X PUT -H "Authorization: Bearer $ATRIUM_TOKEN" -H "Content-Type: application/json" \\
  -d '{"markdown":"- [ ] New task","mode":"append"}' "${base}/pages/<page-id>/content"

# Query a database
curl -X POST -H "Authorization: Bearer $ATRIUM_TOKEN" -H "Content-Type: application/json" \\
  -d '{"sorts":[{"prop":"title","dir":"asc"}]}' "${base}/databases/<db-id>/query"`}</div>
    </>
  );
}

const TABS: { id: string; label: string; icon: ReactNode; section: 'account' | 'workspace'; admin?: boolean }[] = [
  { id: 'account', label: 'My account', icon: <UserIcon size={16} />, section: 'account' },
  { id: 'api', label: 'API tokens', icon: <KeyRound size={16} />, section: 'account' },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={16} />, section: 'account' },
  { id: 'workspace', label: 'General', icon: <Settings2 size={16} />, section: 'workspace' },
  { id: 'members', label: 'Members', icon: <Users size={16} />, section: 'workspace' },
  { id: 'groups', label: 'Groups', icon: <UsersRound size={16} />, section: 'workspace' },
  { id: 'teamspaces', label: 'Teamspaces', icon: <Layers size={16} />, section: 'workspace' },
  { id: 'ai', label: 'AI', icon: <Sparkles size={16} />, section: 'workspace' },
  { id: 'sso', label: 'SSO & provisioning', icon: <ShieldCheck size={16} />, section: 'workspace', admin: true },
  { id: 'audit', label: 'Audit log', icon: <ScrollText size={16} />, section: 'workspace', admin: true },
  { id: 'import', label: 'Import', icon: <Upload size={16} />, section: 'workspace', admin: true },
];

export function SettingsModal({ tab, onClose }: { tab: string | null; onClose: () => void }) {
  const { data: me } = useMe();
  const current = TABS.some((t) => t.id === tab) ? tab : 'account';
  return (
    <Modal open={!!tab} onClose={onClose} width={1040}>
      <div className="settings">
        <div className="settings-nav">
          <div className="menu-heading">Account</div>
          <div className="set-user" style={{ padding: '4px 10px 8px' }}>
            <Avatar user={me} size={22} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.name}</div>
              <div className="e" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.email}</div>
            </div>
          </div>
          {TABS.filter((t) => t.section === 'account').map((t) => (
            <button key={t.id} className={`nav-item ${current === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
          <div className="menu-heading" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Building2 size={12} /> Workspace
          </div>
          {TABS.filter((t) => t.section === 'workspace' && (!t.admin || isAdmin(me?.role))).map((t) => (
            <button key={t.id} className={`nav-item ${current === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
        <div className="settings-main">
          {current === 'account' && <Account />}
          {current === 'workspace' && <Workspace />}
          {current === 'members' && <Members />}
          {current === 'groups' && <Groups />}
          {current === 'teamspaces' && <Teamspaces />}
          {current === 'api' && <Api />}
          {current === 'notifications' && <NotificationsTab />}
          {current === 'ai' && <AiSettingsTab />}
          {current === 'sso' && <SsoTab />}
          {current === 'audit' && isAdmin(me?.role) && <AuditTab />}
          {current === 'import' && isAdmin(me?.role) && <ImportTab />}
        </div>
      </div>
    </Modal>
  );
}
