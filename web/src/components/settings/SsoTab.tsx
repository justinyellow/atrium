import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, RefreshCw, Trash2, X } from 'lucide-react';
import { del, get, patch, post, queryClient } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import { timeAgo, toast } from '../ui';

const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied to clipboard'), () => toast(t));

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="l"><div>{label}</div></div>
      <div style={{ textAlign: 'right', maxWidth: '62%', overflowWrap: 'anywhere', fontSize: 13 }}>{children}</div>
    </div>
  );
}
const Yes = ({ on, children }: { on: boolean; children?: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: on ? 'var(--c-green)' : 'var(--text-3)' }}>
    {on ? <Check size={14} /> : <X size={14} />}{children ?? (on ? 'On' : 'Off')}
  </span>
);
const Mono = ({ children }: { children: ReactNode }) => <code style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{children}</code>;

export function SsoTab() {
  const { data: me } = useMe();
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const q = useQuery({ queryKey: ['sso-settings'], queryFn: () => get('/sso/settings'), enabled: admin });
  const [domains, setDomains] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  if (!admin) return <div><h2>SSO & provisioning</h2><div className="muted">Only workspace admins can view sign-in settings.</div></div>;
  const d = q.data;
  if (!d) return <div><h2>SSO & provisioning</h2><div className="spinner" /></div>;
  const s = d.sso;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sso-settings'] });
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); refresh(); } catch (e: any) { toast(e.message); }
  };
  const mapEntries = (m: Record<string, string>) => Object.entries(m);
  const last = d.cognito.lastRun;

  return (
    <div>
      <h2>SSO & provisioning</h2>
      <div className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        Sign-in settings come from the server's environment (secrets are never shown here). See <Mono>docs/DEPLOYMENT.md</Mono> → "SSO with Cognito".
      </div>

      <h3 className="set-h3">Single sign-on (OIDC)</h3>
      <Field label="Status"><Yes on={s.enabled}>{s.enabled ? 'Enabled' : 'Not configured'}</Yes></Field>
      {s.enabled && (
        <>
          <Field label="Issuer"><Mono>{s.issuer}</Mono></Field>
          <Field label="Client ID"><Mono>{s.clientId}</Mono> · secret {s.clientSecretSet ? 'set' : 'not set (public client)'}</Field>
          <Field label="Callback URL (register in the IdP)">
            <Mono>{s.redirectUri}</Mono> <button className="icon-btn" onClick={() => copy(s.redirectUri)}><Copy size={13} /></button>
          </Field>
          <Field label="Provider hint">{s.idpHint ?? <span className="faint">none (hosted UI chooser)</span>}</Field>
          <Field label="SSO only (password login for owners only)"><Yes on={s.only} /></Field>
          <Field label="Require verified email"><Yes on={s.requireEmailVerified} /></Field>
          <Field label="Linked accounts">{s.linkedUsers}</Field>
          <Field label="Test">
            <a className="btn sm" href="/api/v1/auth/sso/login?next=/" target="_blank" rel="noreferrer"><ExternalLink size={13} /> Test sign-in in a new tab</a>
          </Field>
        </>
      )}

      <h3 className="set-h3">Who can join</h3>
      <Field label="Any domain"><Yes on={s.allowAnyDomain} /></Field>
      <Field label="From environment (SSO_ALLOWED_DOMAINS)">{d.domains.env.length ? d.domains.env.join(', ') : <span className="faint">none</span>}</Field>
      <div className="set-row">
        <div className="l">
          <div>Auto-join domains</div>
          <div className="d">People signing in with SSO from these domains join as members automatically. Existing members can always sign in.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input" style={{ width: 240 }} placeholder="example.com, example.org"
            value={domains ?? d.domains.workspace.join(', ')} onChange={(e) => setDomains(e.target.value)}
          />
          <button className="btn sm" disabled={domains === null} onClick={() => run(async () => {
            await patch('/sso/settings', { allowed_domains: (domains ?? '').split(',').map((x) => x.trim()).filter(Boolean) });
            setDomains(null);
          }, 'Saved')}>Save</button>
        </div>
      </div>

      <h3 className="set-h3">Groups → access</h3>
      <Field label="Groups claim"><Mono>{s.groupsClaim}</Mono></Field>
      <Field label="Role sync on login"><Yes on={s.roleSync} /></Field>
      <Field label="Role mapping">
        {mapEntries(s.roleMap).length
          ? mapEntries(s.roleMap).map(([g, r]) => <div key={g}><Mono>{g}</Mono> → {r}</div>)
          : <span className="faint">none</span>}
        <div className="faint">Everyone else: {s.defaultRole} · owners are never changed</div>
      </Field>
      <Field label="Mirror IdP groups as Atrium groups"><Yes on={s.groupSync}>{s.groupSync ? `On${s.groupPrefix ? ` (prefix "${s.groupPrefix}")` : ''}` : 'Off'}</Yes></Field>
      <Field label="Teamspace mapping">
        {mapEntries(s.teamspaceMap).length
          ? mapEntries(s.teamspaceMap).map(([g, t]) => <div key={g}><Mono>{g}</Mono> → {t}</div>)
          : <span className="faint">none</span>}
      </Field>

      <h3 className="set-h3">Cognito deprovisioning sync</h3>
      <Field label="User pool">{d.cognito.userPoolId ? <Mono>{d.cognito.userPoolId} ({d.cognito.region})</Mono> : <span className="faint">not configured (COGNITO_USER_POOL_ID)</span>}</Field>
      {d.cognito.userPoolId && (
        <>
          <Field label="Schedule">every {d.cognito.intervalMinutes} min{d.cognito.dryRun ? ' · dry run' : ''} · aborts above {d.cognito.maxDeactivatePct}% deactivations</Field>
          <Field label="Last run">
            {last ? (
              <>
                <div>{timeAgo(last.started_at)}{last.dry_run ? ' (dry run)' : ''}</div>
                <div className="faint">
                  {last.result.error ? `Error: ${last.result.error}`
                    : last.result.aborted ? `Aborted: ${last.result.aborted}`
                    : `${last.result.linked ?? 0} linked · ${last.result.deactivate ?? 0} deactivated · ${last.result.reactivate ?? 0} reactivated · ${last.result.groupChanges ?? 0} group changes`}
                </div>
              </>
            ) : <span className="faint">never</span>}
          </Field>
          <Field label="Run now">
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {[true, false].map((dry) => (
                <button key={String(dry)} className="btn sm" disabled={syncing} onClick={async () => {
                  setSyncing(true);
                  await run(() => post('/sso/cognito-sync', { dryRun: dry }), dry ? 'Dry run finished' : 'Sync finished');
                  setSyncing(false);
                }}><RefreshCw size={13} /> {dry ? 'Dry run' : 'Sync now'}</button>
              ))}
            </div>
          </Field>
        </>
      )}

      <h3 className="set-h3">SCIM provisioning</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        For identity providers that push users and groups (Okta, Microsoft Entra ID, OneLogin). Cognito uses the sync above instead.
      </div>
      <Field label="SCIM base URL"><Mono>{d.scim.baseUrl}</Mono> <button className="icon-btn" onClick={() => copy(d.scim.baseUrl)}><Copy size={13} /></button></Field>
      {newToken && (
        <div className="set-card" style={{ borderColor: 'var(--accent)', margin: '8px 0' }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Copy this token now — it won't be shown again.</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" readOnly value={newToken} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
            <button className="btn sm" onClick={() => copy(newToken)}><Copy size={13} /> Copy</button>
          </div>
        </div>
      )}
      <table className="set-table">
        <thead><tr><th>Token</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {d.scim.tokens.map((t: any) => (
            <tr key={t.id}>
              <td><Mono>{t.prefix}…</Mono> {t.name}</td>
              <td>{timeAgo(t.created_at)}</td>
              <td>{t.last_used_at ? timeAgo(t.last_used_at) : 'Never'}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="icon-btn" title="Revoke" onClick={() => run(() => del(`/sso/scim-tokens/${t.id}`), 'Token revoked')}><Trash2 size={14} /></button>
              </td>
            </tr>
          ))}
          {!d.scim.tokens.length && <tr><td colSpan={4} className="faint">No SCIM tokens</td></tr>}
        </tbody>
      </table>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => run(async () => {
        const r = await post('/sso/scim-tokens', { name: 'SCIM' });
        setNewToken(r.token);
      })}>Generate SCIM token</button>
    </div>
  );
}
