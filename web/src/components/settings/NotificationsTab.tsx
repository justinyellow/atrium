import { useQuery } from '@tanstack/react-query';
import { get, post, put, queryClient } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import { toast } from '../ui';

type Mode = 'immediate' | 'digest' | 'off';
const ROWS: { key: string; label: string; desc: string }[] = [
  { key: 'mention', label: 'Mentions', desc: 'Someone @-mentions you in a page or comment.' },
  { key: 'comment', label: 'Comments & replies', desc: 'New comments on pages you created and replies to your discussions.' },
  { key: 'share', label: 'Pages shared with you', desc: 'Someone gives you access to a page.' },
  { key: 'assigned', label: 'Assignments', desc: 'You are added to a person property in a database.' },
  { key: 'reminder', label: 'Reminders', desc: 'Date reminders you set in pages.' },
];

export function NotificationsTab() {
  const { data: me } = useMe();
  const { data } = useQuery({ queryKey: ['notification-prefs'], queryFn: () => get('/me/notification-prefs') });
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const save = async (key: string, mode: Mode) => {
    try {
      const r = await put('/me/notification-prefs', { [key]: mode });
      queryClient.setQueryData(['notification-prefs'], (old: any) => ({ ...old, prefs: r.prefs }));
      toast('Saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const hour = data?.digestHour ?? 8;
  return (
    <>
      <h2>Notifications</h2>
      <p className="muted" style={{ fontSize: 13, margin: '12px 0 4px' }}>
        Choose which notifications are also sent to <b>{me?.email}</b>. Everything always appears in your Inbox.
        Immediate emails are held for about two minutes and skipped if you've already seen the notification.
      </p>
      {data && !data.emailEnabled && (
        <div className="set-card" style={{ fontSize: 13 }}>Email delivery isn't configured on this server yet (EMAIL_DRIVER=log) — your choices are saved and apply once it is.</div>
      )}
      {ROWS.map((r) => (
        <div key={r.key} className="set-row" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="l">
            <div>{r.label}</div>
            <div className="d">{r.desc}</div>
          </div>
          <select className="select" value={data?.prefs?.[r.key] ?? 'immediate'} onChange={(e) => save(r.key, e.target.value as Mode)} disabled={!data}>
            <option value="immediate">Email immediately</option>
            <option value="digest">Daily digest ({String(hour).padStart(2, '0')}:00)</option>
            <option value="off">Don't email</option>
          </select>
        </div>
      ))}
      {isAdmin && (
        <>
          <h3>Email delivery (admin)</h3>
          <div className="set-row">
            <div className="l">
              <div>Send a test email</div>
              <div className="d">Sends a test message to your address using the server's email settings.</div>
            </div>
            <button className="btn sm" onClick={async () => {
              try {
                const r = await post('/admin/email/test', {});
                toast(r.ok ? `Test email ${r.status === 'sent' ? 'sent' : 'queued'} (${r.driver})` : `Failed: ${r.error ?? 'unknown error'}`);
              } catch (e: any) { toast(e.message); }
            }}>Send test</button>
          </div>
        </>
      )}
    </>
  );
}
