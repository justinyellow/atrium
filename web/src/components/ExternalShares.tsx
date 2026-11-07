import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, Mail, RotateCw, Trash2 } from 'lucide-react';
import { api, del, get, post, queryClient } from '../lib/api';
import { timeAgo, toast, Toggle } from './ui';
import { EMAIL_RE } from './settings/useWorkspaceSettings';
import './collab.css';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const toIsoEndOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
const dateInputValue = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

/** Password + expiry controls for this page's own public link. */
export function PublicLinkOptions({ pageId, hasPassword, expiresAt, requirePassword, onChange }: {
  pageId: string; hasPassword: boolean; expiresAt: string | null; requirePassword: boolean; onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState('');
  const save = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/pages/${pageId}/public`, { method: 'PATCH', body });
      toast(msg);
      onChange();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <div className="ext-options">
      <div className="share-row" style={{ padding: '6px 4px' }}>
        <div className="who">
          <div className="n"><Lock size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Require password</div>
          <div className="e">{hasPassword ? 'Visitors must enter a password' : requirePassword ? 'Required by your workspace admin' : 'Anyone with the link can view'}</div>
        </div>
        <Toggle
          checked={hasPassword || editing}
          onChange={(v) => {
            if (v) setEditing(true);
            else if (editing && !hasPassword) setEditing(false);
            else if (requirePassword) toast('Your workspace requires a password on public links');
            else save({ password: null }, 'Password removed');
          }}
        />
      </div>
      {(editing || hasPassword) && (
        <form
          className="ext-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.length < 4) return toast('Use at least 4 characters');
            save({ password: pw }, hasPassword ? 'Password changed — visitors must enter the new one' : 'Password set');
            setPw('');
            setEditing(false);
          }}
        >
          <input className="input" type="password" placeholder={hasPassword ? 'New password' : 'Set a password'} value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="btn sm" disabled={!pw}>{hasPassword ? 'Change' : 'Set'}</button>
        </form>
      )}
      <div className="share-row" style={{ padding: '6px 4px' }}>
        <div className="who">
          <div className="n">Link expires</div>
          <div className="e">{expiresAt ? (new Date(expiresAt) < new Date() ? `Expired ${fmtDate(expiresAt)}` : `On ${fmtDate(expiresAt)}`) : 'Never'}</div>
        </div>
        <input
          className="input"
          type="date"
          style={{ width: 150 }}
          min={tomorrow()}
          value={dateInputValue(expiresAt)}
          onChange={(e) => save({ expiresAt: toIsoEndOfDay(e.target.value) }, e.target.value ? 'Expiry set' : 'Link no longer expires')}
        />
      </div>
    </div>
  );
}

interface ExternalShare {
  id: string;
  page_id: string;
  email: string;
  require_verification: boolean;
  expires_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  expired: boolean;
  inherited: boolean;
  page_title: string | null;
}

/** "Share with people outside the workspace" — personal view-only links, no accounts. */
export function ExternalSharesPanel({ pageId, canManage, allowed }: { pageId: string; canManage: boolean; allowed: boolean }) {
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState('');
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ['external-shares', pageId], queryFn: () => get<ExternalShare[]>(`/pages/${pageId}/external-shares`), enabled: canManage });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['external-shares', pageId] });

  const addDraft = (text = draft) => {
    const parts = text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    if (bad.length) toast(`Not an email: ${bad.join(', ')}`);
    setEmails((cur) => [...new Set([...cur, ...parts.filter((p) => EMAIL_RE.test(p))])]);
    setDraft('');
  };

  const share = async () => {
    const all = draft.trim() ? [...emails, ...draft.split(/[\s,;]+/).filter((p) => EMAIL_RE.test(p.trim()))] : emails;
    if (!all.length) return toast('Add an email address');
    setBusy(true);
    try {
      const r = await post<{ results: { email: string; status: string }[] }>(`/pages/${pageId}/external-shares`, {
        emails: all, message: message || undefined, expiresAt: toIsoEndOfDay(expires), requireVerification: verify,
      });
      const ok = r.results.filter((x) => x.status !== 'invalid').map((x) => x.email);
      toast(ok.length ? `Sent a view link to ${ok.join(', ')}` : 'No valid emails');
      setEmails([]);
      setDraft('');
      setMessage('');
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
    setBusy(false);
  };

  if (!canManage) return <div className="faint" style={{ fontSize: 12, padding: 8 }}>Only people with full access can share outside the workspace.</div>;
  if (!allowed) return <div className="faint" style={{ fontSize: 12, padding: 8 }}>Sharing with people outside the workspace is turned off by your workspace admin.</div>;

  const shares = list.data ?? [];
  return (
    <div className="ext-panel">
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Send a personal, view-only link to this page and its sub-pages. Recipients don't need an account and can't see anything else in the workspace.
      </div>
      <div className="input ext-chips" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
        {emails.map((em) => (
          <span key={em} className="chip"><Mail size={12} style={{ marginLeft: 4 }} />{em}<button onClick={() => setEmails(emails.filter((x) => x !== em))}>×</button></span>
        ))}
        <input
          value={draft}
          placeholder={emails.length ? '' : 'Emails, separated by commas'}
          onChange={(e) => (/[,;\s]$/.test(e.target.value) ? addDraft(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); draft.trim() ? addDraft() : share(); }
            if (e.key === 'Backspace' && !draft && emails.length) setEmails(emails.slice(0, -1));
          }}
          onBlur={() => draft.trim() && addDraft()}
          onPaste={(e) => { e.preventDefault(); addDraft(draft + ' ' + e.clipboardData.getData('text')); }}
        />
      </div>
      <textarea className="input" rows={2} placeholder="Add a message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} style={{ marginTop: 6, minHeight: 0 }} />
      <div className="ext-opts">
        <label className="ext-opt">
          <span>Expires</span>
          <input className="input" type="date" min={tomorrow()} value={expires} onChange={(e) => setExpires(e.target.value)} style={{ width: 140, height: 28 }} />
        </label>
        <label className="ext-opt" title="Recipients confirm with a one-time code sent to their email each time they open the link on a new device">
          <Toggle checked={verify} onChange={setVerify} />
          <span>Email verification code</span>
        </label>
        <button className="btn primary sm" disabled={busy || (!emails.length && !draft.trim())} onClick={share}>Share</button>
      </div>

      {!!shares.length && <div className="menu-heading" style={{ paddingLeft: 0, marginTop: 10 }}>People with a link</div>}
      {shares.map((s) => (
        <div key={s.id} className="share-row">
          <span className="ext-avatar"><Mail size={14} /></span>
          <div className="who">
            <div className="n">{s.email}{s.require_verification && <Lock size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}</div>
            <div className="e">
              {s.inherited ? `From “${s.page_title || 'Untitled'}” · ` : ''}
              {s.expired ? 'Expired' : s.expires_at ? `Until ${fmtDate(s.expires_at)}` : 'No expiry'}
              {' · '}
              {s.last_accessed_at ? `Opened ${timeAgo(s.last_accessed_at)}` : 'Not opened yet'}
            </div>
          </div>
          {!s.inherited && (
            <>
              <button className="icon-btn" title="Resend (sends a new link; the old one stops working)" onClick={async () => {
                try { await post(`/external-shares/${s.id}/resend`); toast(`New link sent to ${s.email}`); refresh(); } catch (e: any) { toast(e.message); }
              }}><RotateCw size={14} /></button>
              <button className="icon-btn" title="Remove access" onClick={async () => {
                try { await del(`/external-shares/${s.id}`); toast(`Removed access for ${s.email}`); refresh(); } catch (e: any) { toast(e.message); }
              }}><Trash2 size={14} /></button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
