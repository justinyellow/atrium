import { useRef, useState } from 'react';
import { Bell, CalendarDays } from 'lucide-react';
import { Popover, Toggle } from '../ui';
import { isolate } from './context';

/**
 * Date mention values:
 *  - all-day:  "2026-11-05"
 *  - timed:    full ISO with offset, e.g. "2026-11-05T15:00:00.000+02:00"
 * Reminder: '' | 'at' | '5m' | '15m' | '1h' | '1d' | '2d' | '1w'
 */
export const REMINDERS: Record<string, string> = {
  '': 'None',
  at: 'At time of event',
  '5m': '5 minutes before',
  '15m': '15 minutes before',
  '1h': '1 hour before',
  '1d': '1 day before',
  '2d': '2 days before',
  '1w': '1 week before',
};

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isTimed = (v: string) => v.includes('T');

export function toIsoWithOffset(d: Date) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00.000${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function parseDateValue(v: string): Date | null {
  if (!v) return null;
  const d = isTimed(v) ? new Date(v) : new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateMention(v: string) {
  const d = parseDateValue(v);
  if (!d) return 'Invalid date';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 864e5);
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : null;
  const dateStr = rel ?? d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return isTimed(v) ? `${dateStr} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : dateStr;
}

/** Natural-language dates for the @ menu: "today", "tomorrow", "next friday", "2026-12-01", "dec 5" … */
export function parseNaturalDate(q: string): Date | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const add = (n: number) => new Date(base.getTime() + n * 864e5);
  if ('today'.startsWith(s) && s.length >= 2) return base;
  if ('tomorrow'.startsWith(s) && s.length >= 3) return add(1);
  if ('yesterday'.startsWith(s) && s.length >= 3) return add(-1);
  if (s === 'next week') return add(7);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const m = s.match(/^(next\s+)?([a-z]{3,})$/);
  if (m) {
    const idx = days.findIndex((d) => d.startsWith(m[2]));
    if (idx >= 0) {
      let delta = (idx - base.getDay() + 7) % 7 || 7;
      if (m[1]) delta += delta < 7 ? 7 : 0;
      return add(delta);
    }
  }
  if (/\d/.test(s)) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : `${s} ${s.match(/\d{4}/) ? '' : base.getFullYear()}`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function DateMention({
  date, reminder, editable, onChange,
}: { date: string; reminder: string; editable: boolean; onChange: (p: { date: string; reminder: string }) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const d = parseDateValue(date) ?? new Date();
  const timed = isTimed(date);
  const setDay = (day: string) => {
    if (!day) return;
    if (!timed) return onChange({ date: day, reminder });
    const [y, mo, da] = day.split('-').map(Number);
    const nd = new Date(d);
    nd.setFullYear(y, mo - 1, da);
    onChange({ date: toIsoWithOffset(nd), reminder });
  };
  const setTime = (t: string) => {
    const [h, mi] = t.split(':').map(Number);
    const nd = new Date(d);
    nd.setHours(h || 0, mi || 0, 0, 0);
    onChange({ date: toIsoWithOffset(nd), reminder });
  };
  const past = d.getTime() < Date.now() && reminder;
  return (
    <>
      <span
        ref={ref}
        className={`mention date ${reminder ? 'has-reminder' : ''} ${past ? 'past' : ''}`}
        onClick={() => editable && setOpen(true)}
        title={reminder ? `Reminder: ${REMINDERS[reminder]}` : undefined}
      >
        <span className="at">@</span>
        {formatDateMention(date)}
        {reminder && <Bell size={12} style={{ marginLeft: 3, verticalAlign: '-1px' }} />}
      </span>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} width={260}>
        <div className="date-pop" ref={isolate}>
          <div className="menu-heading" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><CalendarDays size={14} /> Date</div>
          <input className="input" type="date" value={ymd(d)} onChange={(e) => setDay(e.target.value)} />
          <div className="date-row">
            <span>Include time</span>
            <Toggle checked={timed} onChange={(v) => {
              if (v) { const nd = new Date(d); nd.setHours(9, 0, 0, 0); onChange({ date: toIsoWithOffset(nd), reminder }); }
              else onChange({ date: ymd(d), reminder });
            }} />
          </div>
          {timed && <input className="input" type="time" value={`${pad(d.getHours())}:${pad(d.getMinutes())}`} onChange={(e) => setTime(e.target.value)} />}
          <div className="menu-heading" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Bell size={14} /> Remind</div>
          <select className="input" value={reminder} onChange={(e) => onChange({ date, reminder: e.target.value })}>
            {Object.entries(REMINDERS)
              .filter(([k]) => timed || !['5m', '15m', '1h'].includes(k))
              .map(([k, v]) => <option key={k} value={k}>{k === 'at' && !timed ? 'On day of event (9:00)' : v}</option>)}
          </select>
        </div>
      </Popover>
    </>
  );
}
