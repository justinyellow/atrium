import { useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, post, queryClient } from '../lib/api';
import { SsoButton, requiresSso, type SsoStatus } from './SsoButton';

function useSubmit(fn: () => Promise<void>) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, onSubmit };
}

async function finish(nav: (p: string) => void, to = '/') {
  queryClient.clear();
  await queryClient.invalidateQueries({ queryKey: ['status'] });
  nav(to);
}

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, onSubmit } = useSubmit(async () => {
    await post('/auth/login', { email, password });
    await finish(nav, params.get('next') || '/');
  });
  const status = useQuery({ queryKey: ['status'], queryFn: () => get('/auth/status') });
  const sso: SsoStatus | undefined = status.data?.sso;
  const ssoError = params.get('sso_error');
  // SSO_ONLY hides the password form; owners keep a break-glass path via ?owner=1.
  if (sso?.enabled && sso.only && params.get('owner') !== '1') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-logo">A</div>
          <h1>Log in to Atrium</h1>
          {ssoError && <div className="auth-error">{ssoError}</div>}
          <SsoButton sso={sso} next={params.get('next')} />
          <a className="faint" style={{ fontSize: 12 }} href="/login?owner=1">Workspace owner login</a>
        </div>
      </div>
    );
  }
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-logo">A</div>
        <h1>Log in to Atrium</h1>
        {ssoError && <div className="auth-error">{ssoError}</div>}
        {sso?.enabled && (
          <>
            <SsoButton sso={sso} next={params.get('next')} />
            <div className="auth-divider"><span>or</span></div>
          </>
        )}
        <label>Email</label>
        <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        {requiresSso(sso, email) ? (
          <div className="auth-note">@{email.split('@')[1]} accounts sign in with single sign-on — use “{sso!.label}” above.</div>
        ) : (
          <>
            <label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
            {error && <div className="auth-error">{error}</div>}
            <button className="btn primary" disabled={busy}>Continue</button>
          </>
        )}
        <a className="faint" style={{ fontSize: 12 }} href="/forgot" onClick={(e) => { e.preventDefault(); nav('/forgot'); }}>Forgot password?</a>
        <div className="faint" style={{ fontSize: 12 }}>No account? Ask a workspace admin for an invite link.</div>
      </form>
    </div>
  );
}

export function Setup() {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', workspaceName: '', setupToken: '' });
  const status = useQuery({ queryKey: ['status'], queryFn: () => get('/auth/status') });
  const { error, busy, onSubmit } = useSubmit(async () => {
    await post('/auth/setup', f);
    await finish(nav);
  });
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: any) => setF({ ...f, [k]: e.target.value }) });
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-logo">A</div>
        <h1>Set up your workspace</h1>
        <div className="muted" style={{ marginBottom: 8 }}>You'll be the owner. Invite your team afterwards.</div>
        <label>Workspace name</label>
        <input className="input" autoFocus placeholder="Acme Inc." {...field('workspaceName')} />
        <label>Your name</label>
        <input className="input" placeholder="Ada Lovelace" {...field('name')} />
        <label>Email</label>
        <input className="input" type="email" placeholder="you@company.com" {...field('email')} />
        <label>Password</label>
        <input className="input" type="password" placeholder="At least 8 characters" {...field('password')} />
        {status.data?.setupTokenRequired && (
          <>
            <label>Setup token</label>
            <input className="input" placeholder="From the server's SETUP_TOKEN" {...field('setupToken')} />
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary" disabled={busy}>Create workspace</button>
      </form>
    </div>
  );
}

export function Invite() {
  const { token } = useParams();
  const nav = useNavigate();
  const inviteStatus = useQuery({ queryKey: ['status'], queryFn: () => get('/auth/status') });
  const inviteSso: SsoStatus | undefined = inviteStatus.data?.sso;
  const inv = useQuery({ queryKey: ['invite', token], queryFn: () => get(`/auth/invite/${token}`), retry: false });
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const { error, busy, onSubmit } = useSubmit(async () => {
    await post('/auth/signup', { ...f, token, email: inv.data?.email || f.email });
    await finish(nav);
  });
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: any) => setF({ ...f, [k]: e.target.value }) });
  if (inv.isLoading) return null;
  return (
    <div className="auth-wrap">
      {inv.error ? (
        <div className="auth-card">
          <div className="auth-logo">A</div>
          <h1>Invite not valid</h1>
          <div className="muted">{(inv.error as Error).message}</div>
          <button className="btn" onClick={() => nav('/login')}>Go to login</button>
        </div>
      ) : (
        <form className="auth-card" onSubmit={onSubmit}>
          <div className="auth-logo">A</div>
          <h1>Join {inv.data.workspace_name}</h1>
          <div className="muted" style={{ marginBottom: 8 }}>You've been invited as {inv.data.role === 'guest' ? 'a guest' : `a${inv.data.role === 'admin' ? 'n admin' : ' member'}`}.</div>
          <label>Your name</label>
          <input className="input" autoFocus {...field('name')} />
          <label>Email</label>
          {inv.data.email ? <input className="input" value={inv.data.email} disabled /> : <input className="input" type="email" {...field('email')} />}
          {requiresSso(inviteSso, inv.data.email || f.email) ? (
            <>
              <div className="auth-note">@{(inv.data.email || f.email).split('@')[1]} accounts join with single sign-on.</div>
              <SsoButton sso={inviteSso!} next="/" />
            </>
          ) : (
            <>
          <label>Password</label>
            <input className="input" type="password" placeholder="At least 8 characters" {...field('password')} />
            {error && <div className="auth-error">{error}</div>}
            <button className="btn primary" disabled={busy}>Join workspace</button>
            </>
          )}
        </form>
      )}
    </div>
  );
}
