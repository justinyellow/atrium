import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from './lib/api';
import { Login, Setup, Invite } from './components/Auth';
import Shell from './components/Shell';
import PublicPage, { MagicLink } from './components/PublicPage';
import OAuthConsent from './components/OAuthConsent';
import PublicFormRoute from './database/PublicFormRoute';
import { ForgotPassword, ResetPassword } from './components/ResetPassword';
import { Toaster } from './components/ui';

export default function App() {
  const loc = useLocation();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get('/auth/status'),
    // Keep retrying while the server restarts (deploys, dev reloads) instead of giving up.
    retry: (n, e: any) => !(e?.status >= 400 && e?.status < 500) && n < 1000,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
  });
  if (status.isLoading || (status.isError && status.fetchStatus === 'fetching')) {
    return status.failureCount > 0 ? (
      <div className="auth-wrap">
        <div className="auth-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="spinner" />
          <div className="muted">Can't reach the Atrium server — retrying…</div>
        </div>
      </div>
    ) : null;
  }
  if (status.isError) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="muted">Atrium is unavailable right now.</div>
          <button className="btn" onClick={() => status.refetch()}>Try again</button>
        </div>
      </div>
    );
  }
  const s = status.data;
  return (
    <>
      <Toaster />
      <Routes>
        <Route path="/share/:slug" element={<PublicPage />} />
        <Route path="/f/:slug" element={<PublicFormRoute />} />
        <Route path="/x/:token" element={<MagicLink />} />
        <Route path="/setup" element={s?.setupRequired ? <Setup /> : <Navigate to="/" />} />
        <Route path="/login" element={s?.setupRequired ? <Navigate to="/setup" /> : <Login />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/forgot" element={<ForgotPassword />} />
        <Route path="/reset/:token" element={<ResetPassword />} />
        <Route path="/oauth/consent" element={s?.user ? <OAuthConsent /> : <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} />} />
        <Route
          path="/*"
          element={
            s?.setupRequired ? (
              <Navigate to="/setup" />
            ) : !s?.user ? (
              <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} />
            ) : (
              <Shell />
            )
          }
        />
      </Routes>
    </>
  );
}
