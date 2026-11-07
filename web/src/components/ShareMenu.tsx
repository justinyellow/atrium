import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Check, ChevronDown, Globe, Link2, Lock, Mail, Users } from 'lucide-react';
import { del, get, post, put, queryClient } from '../lib/api';
import { useMe, useUsers } from '../lib/hooks';
import type { Level, Page } from '../lib/types';
import { Avatar, MenuItem, Popover, Toggle, toast } from './ui';
import { ExternalSharesPanel, PublicLinkOptions } from './ExternalShares';
import './collab.css';

interface Grant {
  id: string;
  page_id: string;
  principal_type: 'user' | 'group' | 'workspace' | 'public';
  principal_id: string | null;
  level: Exclude<Level, 'none'>;
  user_name: string | null;
  user_email: string | null;
  avatar_url: string | null;
  group_name: string | null;
  page_title: string | null;
  inherited: boolean;
  has_password?: boolean;
  expires_at?: string | null;
}
interface PermInfo {
  level: Level;
  grants: Grant[];
  owner: { id: string; name: string; email: string; avatar_url: string | null } | null;
  teamspace: { id: string; name: string; icon: string | null; default_level: Level } | null;
  public: boolean;
  publicSlug: string | null;
}

const LEVELS: { v: Exclude<Level, 'none'>; label: string; desc: string }[] = [
  { v: 'full', label: 'Full access', desc: 'Edit, suggest, comment, and share' },
  { v: 'edit', label: 'Can edit', desc: 'Edit, suggest, and comment' },
  { v: 'comment', label: 'Can comment', desc: 'Suggest and comment' },
  { v: 'view', label: 'Can view', desc: 'Read only' },
];
const labelOf = (l: string) => LEVELS.find((x) => x.v === l)?.label ?? l;

function LevelPicker({
  value, onChange, onRemove, disabled,
}: { value: Exclude<Level, 'none'>; onChange: (l: Exclude<Level, 'none'>) => void; onRemove?: () => void; disabled?: boolean }) {
  const [a, setA] = useState<HTMLElement | null>(null);
  if (disabled) return <span className="share-level">{labelOf(value)}</span>;
  return (
    <>
      <button className="share-level" onClick={(e) => setA(e.currentTarget)}>
        {labelOf(value)} <ChevronDown size={12} />
      </button>
      <Popover anchor={a} open={!!a} onClose={() => setA(null)} placement="bottom-end" width={260}>
        {LEVELS.map((l) => (
          <MenuItem key={l.v} right={value === l.v ? <Check size={14} /> : null} onClick={() => { setA(null); onChange(l.v); }}>
            <div>{l.label}</div>
            <div className="faint" style={{ fontSize: 12, lineHeight: 1.3, whiteSpace: 'normal' }}>{l.desc}</div>
          </MenuItem>
        ))}
        {onRemove && (
          <>
            <div className="menu-sep" />
            <MenuItem danger onClick={() => { setA(null); onRemove(); }}>Remove</MenuItem>
          </>
        )}
      </Popover>
    </>
  );
}

function copy(text: string, msg = 'Copied link to clipboard') {
  navigator.clipboard?.writeText(text).then(() => toast(msg), () => toast(text));
}

import { canInviteGuests, EMAIL_RE, useWorkspaceSettings } from './settings/useWorkspaceSettings';

export function ShareMenu({ page, anchor, open, onClose }: { page: Page; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'share' | 'publish' | 'external'>('share');
  const [publishPw, setPublishPw] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ type: 'user' | 'group'; id: string; name: string }[]>([]);
  const [inviteLevel, setInviteLevel] = useState<Exclude<Level, 'none'>>('edit');
  const [focus, setFocus] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: me } = useMe();
  const { data: users = [] } = useUsers();
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<{ id: string; name: string; members: any[] }[]>('/groups'), enabled: open });
  const perms = useQuery({
    queryKey: ['perms', page.id],
    queryFn: () => get<PermInfo>(`/pages/${page.id}/permissions`),
    enabled: open,
  });
  const info = perms.data;
  const canManage = (info?.level ?? page.level) === 'full';
  const wsSettings = useWorkspaceSettings(open);
  const guestInviteOk = canInviteGuests(wsSettings.data, me?.role);
  const publishOk = wsSettings.data?.allow_public_pages !== false;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['perms', page.id] });
    queryClient.invalidateQueries({ queryKey: ['page', page.id] });
    queryClient.invalidateQueries({ queryKey: ['tree'] });
  };
  const grant = async (principal_type: string, principal_id: string | null, level: string) => {
    try {
      await put(`/pages/${page.id}/permissions`, { principal_type, principal_id, level });
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const revoke = async (g: Grant) => {
    try {
      await del(`/pages/${g.page_id}/permissions/${g.id}`);
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };

  const suggestions = useMemo(() => {
    const q = query.toLowerCase().trim();
    const taken = new Set(picked.map((p) => p.id));
    const us = users
      .filter((u) => u.active && !taken.has(u.id) && (u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)))
      .map((u) => ({ type: 'user' as const, id: u.id, name: u.name, sub: u.email, user: u }));
    const gs = (groups.data ?? [])
      .filter((g) => !taken.has(g.id) && g.name.toLowerCase().includes(q))
      .map((g) => ({ type: 'group' as const, id: g.id, name: g.name, sub: `${g.members.length} members`, user: null }));
    return [...gs, ...us].slice(0, 8);
  }, [query, users, groups.data, picked]);

  // An email that isn't a workspace member can be invited as a guest on this page.
  const guestEmail = (() => {
    const e = query.trim().toLowerCase();
    if (!EMAIL_RE.test(e) || users.some((u) => (u.email ?? '').toLowerCase() === e)) return null;
    return e;
  })();
  const inviteGuest = async (email: string) => {
    try {
      const r = await post<{ status: string; emailed?: boolean; url?: string }>(`/pages/${page.id}/invite-guest`, { email, level: inviteLevel });
      if (r.status === 'granted') toast(`Shared with ${email}`);
      else if (r.emailed) toast(`Invite sent to ${email}`);
      else if (r.url) copy(r.url, `Guest invite created — link copied for ${email}`);
      setQuery('');
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };

  const invite = async () => {
    for (const p of picked) await grant(p.type, p.id, inviteLevel);
    if (picked.length) toast(`Invited ${picked.map((p) => p.name).join(', ')}`);
    setPicked([]);
    setQuery('');
  };

  const workspaceGrant = info?.grants.find((g) => g.principal_type === 'workspace');
  const publicGrant = info?.grants.find((g) => g.principal_type === 'public');
  const people = info?.grants.filter((g) => g.principal_type === 'user' || g.principal_type === 'group') ?? [];
  const publicUrl = `${location.origin}/share/${info?.publicSlug ?? page.id}`;

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" width={440}>
      <div className="share-tabs">
        <button className={`share-tab ${tab === 'share' ? 'on' : ''}`} onClick={() => setTab('share')}>Share</button>
        <button className={`share-tab ${tab === 'publish' ? 'on' : ''}`} onClick={() => setTab('publish')}>
          Publish {info?.public && <Globe size={11} style={{ color: 'var(--accent)', marginLeft: 2 }} />}
        </button>
        <button className={`share-tab ${tab === 'external' ? 'on' : ''}`} onClick={() => setTab('external')}>
          <Mail size={12} style={{ marginRight: 3, verticalAlign: -1 }} />Email link
        </button>
      </div>
      {tab === 'external' ? (
        <div className="share-body">
          <ExternalSharesPanel pageId={page.id} canManage={canManage} allowed={wsSettings.data?.allow_external_shares !== false} />
        </div>
      ) : tab === 'share' ? (
        <div className="share-body">
          {canManage && (
            <div className="share-invite">
              <div className="input" style={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', height: 'auto', minHeight: 32, padding: '2px 6px' }} onClick={() => inputRef.current?.focus()}>
                {picked.map((p) => (
                  <span key={p.id} className="chip">
                    {p.type === 'group' ? <Users size={14} style={{ marginLeft: 4 }} /> : <Avatar user={{ name: p.name, id: p.id }} size={18} />}
                    {p.name}
                    <button onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>×</button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setFocus(true)}
                  onBlur={() => setTimeout(() => setFocus(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && guestEmail && !suggestions.length && guestInviteOk) {
                      inviteGuest(guestEmail);
                    } else if (e.key === 'Enter' && suggestions[0] && query) {
                      const s = suggestions[0];
                      setPicked([...picked, { type: s.type, id: s.id, name: s.name }]);
                      setQuery('');
                    } else if (e.key === 'Enter' && picked.length) invite();
                    if (e.key === 'Backspace' && !query && picked.length) setPicked(picked.slice(0, -1));
                  }}
                  placeholder={picked.length ? '' : 'Email, name, or group'}
                  style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, minWidth: 80, height: 26 }}
                />
              </div>
              {picked.length > 0 && <LevelPicker value={inviteLevel} onChange={setInviteLevel} />}
              <button className="btn primary" disabled={!picked.length} onClick={invite}>Invite</button>
              {focus && guestEmail && !suggestions.length && (
                <div className="share-suggest">
                  {guestInviteOk ? (
                    <MenuItem icon={<Mail size={16} />} right={<span>Guest · {labelOf(inviteLevel)}</span>} onClick={() => inviteGuest(guestEmail)}>
                      Invite {guestEmail}
                    </MenuItem>
                  ) : (
                    <div className="menu-footer">
                      {wsSettings.data?.allow_guests === false ? 'Your workspace admin has turned off guest access.' : 'Only workspace admins can invite guests.'}
                    </div>
                  )}
                </div>
              )}
              {focus && suggestions.length > 0 && (
                <div className="share-suggest">
                  <div className="menu-heading">Select a person or group</div>
                  {suggestions.map((s) => (
                    <MenuItem
                      key={s.id}
                      icon={s.type === 'group' ? <Users size={16} /> : <Avatar user={s.user} size={20} />}
                      right={<span>{s.sub}</span>}
                      onClick={() => {
                        setPicked([...picked, { type: s.type, id: s.id, name: s.name }]);
                        setQuery('');
                        inputRef.current?.focus();
                      }}
                    >
                      {s.name}
                    </MenuItem>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="menu-heading" style={{ marginTop: 8 }}>People with access</div>
          {perms.isLoading && <div className="spinner" style={{ margin: 12 }} />}
          {info?.owner && (
            <div className="share-row">
              <Avatar user={info.owner} size={28} />
              <div className="who">
                <div className="n">{info.owner.name}{info.owner.id === me?.id ? ' (You)' : ''}</div>
                <div className="s">{info.owner.email}</div>
              </div>
              <span className="share-level">Full access</span>
            </div>
          )}
          {info?.teamspace && (
            <div className="share-row">
              <span className="share-icon"><span className="emoji">{info.teamspace.icon ?? '🏠'}</span></span>
              <div className="who">
                <div className="n">Everyone in {info.teamspace.name}</div>
                <div className="s">Teamspace members</div>
              </div>
              <span className="share-level">{labelOf(info.teamspace.default_level)}</span>
            </div>
          )}
          {people.map((g) => (
            <div className="share-row" key={g.id}>
              {g.principal_type === 'group' ? (
                <span className="share-icon"><Users size={16} /></span>
              ) : (
                <Avatar user={{ id: g.principal_id ?? '', name: g.user_name ?? '?', avatar_url: g.avatar_url }} size={28} />
              )}
              <div className="who">
                <div className="n">
                  {g.principal_type === 'group' ? g.group_name : g.user_name}
                  {g.principal_id === me?.id ? ' (You)' : ''}
                </div>
                <div className="s">{g.inherited ? `Inherited from ${g.page_title || 'Untitled'}` : g.principal_type === 'group' ? 'Group' : g.user_email}</div>
              </div>
              <LevelPicker disabled={!canManage} value={g.level} onChange={(l) => grant(g.principal_type, g.principal_id, l)} onRemove={() => revoke(g)} />
            </div>
          ))}

          <div className="menu-heading" style={{ marginTop: 8 }}>General access</div>
          <div className="share-row">
            <span className="share-icon">{workspaceGrant ? <Building2 size={16} /> : <Lock size={16} />}</span>
            <div className="who">
              <div className="n">{workspaceGrant ? `Everyone at ${me?.workspace.name ?? 'workspace'}` : 'Only people invited'}</div>
              <div className="s">{workspaceGrant ? (workspaceGrant.inherited ? `Inherited from ${workspaceGrant.page_title || 'Untitled'}` : 'Anyone in the workspace can find and access') : 'Only people with access can open'}</div>
            </div>
            {canManage &&
              (workspaceGrant ? (
                <LevelPicker value={workspaceGrant.level} onChange={(l) => grant('workspace', null, l)} onRemove={() => revoke(workspaceGrant)} />
              ) : (
                <button className="share-level" onClick={() => grant('workspace', null, 'view')}>Share with workspace</button>
              ))}
          </div>

          <div className="share-footer">
            <span className="faint" style={{ fontSize: 12 }}>{canManage ? '' : 'Only people with full access can change sharing'}</span>
            <button className="btn sm" onClick={() => copy(`${location.origin}/p/${page.id}`)}>
              <Link2 size={14} /> Copy link
            </button>
          </div>
        </div>
      ) : (
        <div className="share-body">
          <div className="share-publish">
            <Globe className="globe" strokeWidth={1.3} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{info?.public ? 'This page is live on the web' : 'Publish to web'}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {info?.public ? (publicGrant?.has_password ? 'People with the link and password can view this page and its sub-pages.' : 'Anyone with the link can view this page and its sub-pages.') : 'Create a read-only public link anyone can view without logging in.'}
            </div>
          </div>
          {!publishOk && (
            <div className="faint" style={{ fontSize: 12, margin: '0 4px 8px' }}>
              Publishing to the web is turned off for this workspace by an admin.{info?.public ? ' Existing public links no longer work.' : ''}
            </div>
          )}
          <div className="share-row" style={{ padding: '6px 4px', opacity: publishOk || info?.public ? 1 : 0.5 }}>
            <div className="who"><div className="n">Share to web</div></div>
            <Toggle
              checked={!!info?.public}
              onChange={(v) => {
                if (!canManage) return toast('Only people with full access can publish');
                if (v && !publishOk) return toast('Publishing is disabled by your workspace admin');
                if (v && wsSettings.data?.require_public_link_password) return setPublishPw('');
                if (v) grant('public', null, 'view');
                else if (publicGrant) revoke(publicGrant);
              }}
            />
          </div>
          {publishPw !== null && !info?.public && (
            <form
              className="ext-inline"
              onSubmit={async (e) => {
                e.preventDefault();
                if (publishPw.length < 4) return toast('Use at least 4 characters');
                try {
                  await put(`/pages/${page.id}/permissions`, { principal_type: 'public', principal_id: null, level: 'view', password: publishPw });
                  setPublishPw(null);
                  refresh();
                } catch (err: any) {
                  toast(err.message);
                }
              }}
            >
              <input className="input" type="password" autoFocus placeholder="Your workspace requires a password" value={publishPw} onChange={(e) => setPublishPw(e.target.value)} />
              <button className="btn sm primary" disabled={!publishPw}>Publish</button>
            </form>
          )}
          {info?.public && publicGrant && !publicGrant.inherited && canManage && (
            <PublicLinkOptions
              pageId={page.id}
              hasPassword={!!publicGrant.has_password}
              expiresAt={publicGrant.expires_at ?? null}
              requirePassword={!!wsSettings.data?.require_public_link_password}
              onChange={refresh}
            />
          )}
          {publicGrant?.inherited && (publicGrant.has_password || publicGrant.expires_at) && (
            <div className="faint" style={{ fontSize: 12, margin: '6px 4px' }}>
              {publicGrant.has_password ? 'Password protected' : ''}{publicGrant.has_password && publicGrant.expires_at ? ' · ' : ''}{publicGrant.expires_at ? `expires ${new Date(publicGrant.expires_at).toLocaleDateString()}` : ''} (set on the parent page)
            </div>
          )}
          {info?.public && publicUrl && (
            <div className="share-url">
              <input className="input" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => copy(publicUrl)}>Copy</button>
              <a className="btn" href={publicUrl} target="_blank" rel="noreferrer">View</a>
            </div>
          )}
          {publicGrant?.inherited && (
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Published via parent page “{publicGrant.page_title || 'Untitled'}”.</div>
          )}
        </div>
      )}
    </Popover>
  );
}
