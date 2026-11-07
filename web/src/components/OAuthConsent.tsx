import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, FileText, Database, MessageSquare, Users } from 'lucide-react';
import { get, post } from '../lib/api';
import { useMe } from '../lib/hooks';
import { Avatar } from './ui';
import './collab.css';

/** OAuth consent screen for MCP connectors (Claude.ai, Claude Desktop, …). */
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const { data: me } = useMe();
  const client = useQuery({ queryKey: ['oauth-client', clientId], queryFn: () => get(`/oauth/clients/${encodeURIComponent(clientId)}`), enabled: !!clientId, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await post('/oauth/approve', {
        approve,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: params.get('code_challenge'),
        code_challenge_method: params.get('code_challenge_method'),
        state: params.get('state'),
        resource: params.get('resource'),
      });
      window.location.href = r.redirect;
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  let host = '';
  try {
    host = new URL(redirectUri).host;
  } catch {}

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ width: 400 }}>
        <div className="auth-logo">A</div>
        {client.error || !clientId ? (
          <>
            <h1>Can't connect</h1>
            <div className="muted">This connection request is invalid or has expired. Remove the connector and add it again.</div>
          </>
        ) : (
          <>
            <h1>Connect {client.data?.name ?? 'app'} to Atrium</h1>
            <div className="muted" style={{ marginBottom: 6 }}>
              <strong>{client.data?.name ?? 'This app'}</strong> wants to access your workspace as you. It will be able to:
            </div>
            <div className="consent-list">
              <div><FileText size={16} /> Search and read pages you can access</div>
              <div><Database size={16} /> Create and edit pages, databases and rows</div>
              <div><MessageSquare size={16} /> Read and add comments</div>
              <div><Users size={16} /> See workspace members</div>
              <div><ShieldCheck size={16} /> Only within your existing permissions</div>
            </div>
            {me && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} className="muted">
                <Avatar user={me} size={20} /> Signed in as {me.email}
              </div>
            )}
            {host && <div className="faint" style={{ fontSize: 12 }}>You'll be sent back to {host}. You can disconnect any time in Settings → API.</div>}
            {error && <div className="auth-error">{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => decide(false)}>Deny</button>
              <button className="btn primary" style={{ flex: 1 }} disabled={busy || !client.data} onClick={() => decide(true)}>Allow access</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
