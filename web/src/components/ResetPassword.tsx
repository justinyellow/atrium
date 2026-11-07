import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, post, queryClient } from '../lib/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/forgot', { email });
      setSent(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      {sent ? (
        <div className="auth-card">
          <div className="auth-logo">A</div>
          <h1>Check your email</h1>
          <div className="muted">If an account exists for <b>{email}</b>, we've sent a link to reset your password. It expires in 1 hour.</div>
          <Link className="btn" to="/login">Back to log in</Link>
        </div>
      ) : (
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-logo">A</div>
          <h1>Reset your password</h1>
          <div className="muted" style={{ marginBottom: 8 }}>Enter your account email and we'll send you a reset link.</div>
          <label>Email</label>
          <input className="input" type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary" disabled={busy || !email}>Send reset link</button>
          <Link className="faint" style={{ fontSize: 12 }} to="/login">Back to log in</Link>
        </form>
      )}
    </div>
  );
}

export function ResetPassword() {
  const { token } = useParams();
  const nav = useNavigate();
  const check = useQuery({ queryKey: ['reset', token], queryFn: () => get(`/auth/reset/${token}`), retry: false });
  const [pw, setPw] = useState({ a: '', b: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.a !== pw.b) return setError("Passwords don't match");
    setBusy(true);
    setError('');
    try {
      await post('/auth/reset', { token, password: pw.a });
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ['status'] });
      nav('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (check.isLoading) return null;
  return (
    <div className="auth-wrap">
      {check.error ? (
        <div className="auth-card">
          <div className="auth-logo">A</div>
          <h1>Link expired</h1>
          <div className="muted">{(check.error as Error).message}</div>
          <Link className="btn" to="/forgot">Request a new link</Link>
        </div>
      ) : (
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-logo">A</div>
          <h1>Choose a new password</h1>
          <div className="muted" style={{ marginBottom: 8 }}>For {check.data?.email}. You'll be signed out everywhere else.</div>
          <label>New password</label>
          <input className="input" type="password" autoFocus value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} placeholder="At least 8 characters" />
          <label>Confirm password</label>
          <input className="input" type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary" disabled={busy || pw.a.length < 8}>Reset password</button>
        </form>
      )}
    </div>
  );
}
