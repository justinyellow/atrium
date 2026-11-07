import { useQuery } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import { del, get, post } from '../../lib/api';
import { timeAgo, toast } from '../ui';

interface Session { id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; current: boolean }

function describe(ua: string | null) {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Android|iPhone|iPad|Mobile/.test(ua) };
}

/** "Devices" list under My account: where you're logged in, with sign-out per device. */
export function SessionsSection() {
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => get<Session[]>('/me/sessions') });
  const list = sessions.data ?? [];
  const others = list.filter((s) => !s.current).length;
  return (
    <>
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Devices</span>
        {others > 0 && (
          <button
            className="btn sm"
            onClick={async () => {
              try {
                const r = await post<{ count: number }>('/me/sessions/logout-others', {});
                toast(`Logged out of ${r.count} other session${r.count === 1 ? '' : 's'}`);
                sessions.refetch();
              } catch (e: any) {
                toast(e.message);
              }
            }}
          >
            Log out of all other devices
          </button>
        )}
      </h3>
      <table className="set-table">
        <tbody>
          {list.map((s) => {
            const d = describe(s.user_agent);
            return (
              <tr key={s.id}>
                <td>
                  <div className="set-user">
                    {d.mobile ? <Smartphone size={18} className="faint" /> : <Monitor size={18} className="faint" />}
                    <div>
                      <div>{d.label}{s.current && <span className="adm-badge">This device</span>}</div>
                      <div className="e">{s.ip ?? 'Unknown location'} · signed in {timeAgo(s.created_at)}</div>
                    </div>
                  </div>
                </td>
                <td className="muted">Active {timeAgo(s.last_seen_at)}</td>
                <td style={{ textAlign: 'right' }}>
                  {!s.current && (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          await del(`/me/sessions/${s.id}`);
                          sessions.refetch();
                        } catch (e: any) {
                          toast(e.message);
                        }
                      }}
                    >
                      Log out
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
