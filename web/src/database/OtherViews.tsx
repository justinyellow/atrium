import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { Prop, Row } from '../lib/types';
import { PageIcon } from '../components/ui';
import { CellValue } from './cells';
import { createRow, groupRows, groupValue, isEmptyValue, parseDate, rowValue, setRowValue, viewProps, ymd } from './dbutil';
import { RowMenuButton, type ViewProps } from './shared';
import { Card, coverStyle } from './BoardView';
import { GroupLabel } from './TableView';

// ---------- list ----------

export function ListView(vp: ViewProps) {
  const { db, view, rows, users, titles, canEdit, openRow } = vp;
  const props = viewProps(db.schema, view).filter((x) => x.visible && x.prop.type !== 'title');
  const groupProp = view.config.groupBy ? db.schema.find((p) => p.id === view.config.groupBy) : null;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const item = (r: Row) => (
    <div key={r.id} className="list-item" onClick={() => openRow(r.id)}>
      {canEdit && <span className="list-handle" onClick={(e) => e.stopPropagation()}><RowMenuButton db={db} row={r} openRow={openRow} /></span>}
      <PageIcon icon={r.icon} size={18} />
      <span className="list-title">{r.title || <span className="faint">Untitled</span>}</span>
      <span className="list-props">
        {props.map((x) => isEmptyValue(rowValue(r, x.prop)) ? null : (
          <span key={x.prop.id} className="list-prop"><CellValue prop={x.prop} row={r} users={users} titles={titles} compact /></span>
        ))}
      </span>
    </div>
  );
  const newBtn = (props?: Record<string, any>) => canEdit && (
    <button className="list-new" onClick={() => createRow(db.id, { props })}><Plus size={14} /> New page</button>
  );
  if (groupProp) {
    return (
      <div className="list-view">
        {groupRows(rows, groupProp, users).map((g) => (
          <Fragment key={g.key}>
            <div className="group-head" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
              {collapsed[g.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <GroupLabel g={g} prop={groupProp} users={users} /><span className="faint">{g.rows.length}</span>
            </div>
            {!collapsed[g.key] && <>{g.rows.map(item)}{newBtn({ [groupProp.id]: groupValue(groupProp, g.key, null) })}</>}
          </Fragment>
        ))}
      </div>
    );
  }
  return <div className="list-view">{rows.map(item)}{newBtn()}</div>;
}

// ---------- gallery ----------

export function GalleryView(vp: ViewProps) {
  const { db, view, rows, canEdit } = vp;
  const size = view.config.cardSize ?? 'medium';
  const preview = (view.config.cardPreview ?? 'cover') === 'cover';
  return (
    <div className={`gallery size-${size}`}>
      {rows.map((r) => (
        <div key={r.id} className="gallery-card-wrap">
          {preview && <div className="gallery-cover" style={r.cover ? coverStyle(r.cover) : undefined} onClick={() => vp.openRow(r.id)}>
            {!r.cover && r.icon && <span className="gallery-icon"><PageIcon icon={r.icon} size={40} /></span>}
          </div>}
          <Card vp={vp} row={r} />
        </div>
      ))}
      {canEdit && <button className="gallery-new" onClick={() => createRow(db.id)}><Plus size={16} /> New page</button>}
    </div>
  );
}

// ---------- calendar ----------

function dateOf(row: Row, prop: Prop): { start: Date | null; end: Date | null } {
  const v = rowValue(row, prop);
  if (prop.type === 'date') return { start: parseDate(v?.start), end: parseDate(v?.end) };
  return { start: parseDate(v), end: null };
}

export function CalendarView(vp: ViewProps) {
  const { db, view, rows, canEdit, openRow, users, titles } = vp;
  const prop = db.schema.find((p) => p.id === view.config.calendarBy) ?? db.schema.find((p) => p.type === 'date');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [over, setOver] = useState<string | null>(null);
  const visibleProps = viewProps(db.schema, view).filter((x) => x.visible && x.prop.type !== 'title' && x.prop.id !== prop?.id);
  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    if (!prop) return m;
    for (const r of rows) {
      const { start, end } = dateOf(r, prop);
      if (!start) continue;
      const last = end && end > start ? end : start;
      for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()), n = 0; d <= last && n < 62; d.setDate(d.getDate() + 1), n++) {
        const k = ymd(d);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(r);
      }
    }
    return m;
  }, [rows, prop]);
  if (!prop) {
    return <div className="empty-state">Calendar views need a Date property.{canEdit && <> Add one with the <b>+</b> in a table view or in view settings.</>}</div>;
  }
  const days: Date[] = [];
  const first = new Date(month);
  first.setDate(1 - first.getDay());
  const weeks = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  for (let i = 0; i < weeks * 7; i++) days.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const today = ymd(new Date());
  const writable = canEdit && prop.type === 'date';
  const moveRow = (rowId: string, day: string) => {
    const r = rows.find((x) => x.id === rowId);
    if (!r) return;
    const v = rowValue(r, prop) ?? {};
    const s = parseDate(v.start), e = parseDate(v.end);
    const time = v.start?.length > 10 ? v.start.slice(10) : '';
    const out: any = { start: day + time };
    if (s && e) {
      const diff = Math.round((e.getTime() - s.getTime()) / 864e5);
      const ne = new Date(day + 'T00:00:00');
      ne.setDate(ne.getDate() + diff);
      out.end = ymd(ne) + (v.end?.length > 10 ? v.end.slice(10) : '');
    }
    setRowValue(db.id, rowId, prop, out);
  };
  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <span className="cal-month">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button className="tb-btn" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      </div>
      <div className="cal-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = ymd(d);
          const items = byDay.get(k) ?? [];
          return (
            <div key={k} className={`cal-cell ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${over === k ? 'over' : ''}`}
              onDragOver={(e) => { if (writable) { e.preventDefault(); setOver(k); } }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { setOver(null); const id = e.dataTransfer.getData('atrium/cal'); if (id) moveRow(id, k); }}>
              <div className="cal-cell-head">
                {writable && (
                  <button className="cal-add" onClick={() => createRow(db.id, { props: { [prop.id]: { start: k } } }).then((r) => openRow(r.id))}><Plus size={13} /></button>
                )}
                <span className={`cal-day ${k === today ? 'today' : ''}`}>{d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}</span>
              </div>
              {items.map((r) => (
                <div key={r.id} className="cal-item" draggable={writable} onDragStart={(e) => e.dataTransfer.setData('atrium/cal', r.id)}
                  onClick={() => openRow(r.id)}>
                  <div className="cal-item-title">{r.icon && <PageIcon icon={r.icon} size={13} />}{r.title || 'Untitled'}</div>
                  {visibleProps.map((x) => isEmptyValue(rowValue(r, x.prop)) ? null : (
                    <div key={x.prop.id} className="cal-item-prop"><CellValue prop={x.prop} row={r} users={users} titles={titles} compact /></div>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- timeline ----------

const SCALES = { day: 40, week: 18, month: 6 } as const;

export function TimelineView(vp: ViewProps) {
  const { db, view, rows, canEdit, openRow } = vp;
  const prop = db.schema.find((p) => p.id === view.config.timelineBy) ?? db.schema.find((p) => p.type === 'date');
  const [scale, setScale] = useState<keyof typeof SCALES>('week');
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'start' | 'end'; x0: number; delta: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayW = SCALES[scale];
  const origin = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (scale === 'month' ? 90 : scale === 'week' ? 28 : 7));
    return d;
  }, [scale]);
  const nDays = scale === 'month' ? 365 : scale === 'week' ? 150 : 60;
  if (!prop) return <div className="empty-state">Timeline views need a Date property.</div>;
  const writable = canEdit && prop.type === 'date';
  const dayIdx = (d: Date) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - origin.getTime()) / 864e5);
  const days: Date[] = [];
  for (let i = 0; i < nDays; i++) days.push(new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + i));
  const todayIdx = dayIdx(new Date());
  const listProps = viewProps(db.schema, view).filter((x) => x.visible && x.prop.type !== 'title').slice(0, 2);

  const startDrag = (e: React.MouseEvent, r: Row, mode: 'move' | 'start' | 'end') => {
    if (!writable) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let delta = 0;
    setDrag({ id: r.id, mode, x0, delta: 0 });
    const move = (ev: MouseEvent) => { delta = Math.round((ev.clientX - x0) / dayW); setDrag({ id: r.id, mode, x0, delta }); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setDrag(null);
      if (!delta) { if (mode === 'move') openRow(r.id); return; }
      const v = rowValue(r, prop) ?? {};
      const s = parseDate(v.start)!, e2 = parseDate(v.end) ?? s;
      const shift = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return ymd(x); };
      let ns = ymd(s), ne = ymd(e2);
      if (mode === 'move') { ns = shift(s, delta); ne = shift(e2, delta); }
      if (mode === 'start') { ns = shift(s, delta); if (ns > ne) ns = ne; }
      if (mode === 'end') { ne = shift(e2, delta); if (ne < ns) ne = ns; }
      setRowValue(db.id, r.id, prop, ns === ne ? { start: ns } : { start: ns, end: ne });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const months: { label: string; left: number; width: number }[] = [];
  days.forEach((d, i) => {
    if (i === 0 || d.getDate() === 1) months.push({ label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), left: i * dayW, width: 0 });
    months[months.length - 1].width += dayW;
  });

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        {(['day', 'week', 'month'] as const).map((s) => (
          <button key={s} className={`tb-btn ${scale === s ? 'active' : ''}`} onClick={() => setScale(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
        ))}
        <button className="tb-btn" onClick={() => scrollRef.current?.scrollTo({ left: todayIdx * dayW - 200, behavior: 'smooth' })}>Today</button>
      </div>
      <div className="tl-body">
        <div className="tl-left">
          <div className="tl-left-head">{db.schema.find((p) => p.type === 'title')?.name ?? 'Name'}</div>
          {rows.map((r) => (
            <div key={r.id} className="tl-left-row" onClick={() => openRow(r.id)}>
              <PageIcon icon={r.icon} size={14} /><span className="tl-name">{r.title || 'Untitled'}</span>
            </div>
          ))}
          {canEdit && <button className="list-new" onClick={() => createRow(db.id, { props: { [prop.id]: { start: ymd(new Date()) } } })}><Plus size={14} /> New</button>}
        </div>
        <div className="tl-scroll" ref={(el) => {
          (scrollRef as any).current = el;
          if (el && !el.dataset.init) { el.dataset.init = '1'; el.scrollLeft = Math.max(0, todayIdx * dayW - 200); }
        }}>
          <div style={{ width: nDays * dayW, position: 'relative' }}>
            <div className="tl-head">
              <div className="tl-months">{months.map((m, i) => <div key={i} style={{ left: m.left, width: m.width }}>{m.label}</div>)}</div>
              <div className="tl-days">
                {days.map((d, i) => (
                  <div key={i} style={{ width: dayW }} className={`${d.getDay() === 0 || d.getDay() === 6 ? 'we' : ''}`}>
                    {scale === 'day' || (scale === 'week' && d.getDay() === 1) ? d.getDate() : ''}
                  </div>
                ))}
              </div>
            </div>
            <div className="tl-today" style={{ left: todayIdx * dayW + dayW / 2 }} />
            {rows.map((r) => {
              const { start, end } = dateOf(r, prop);
              let si = start ? dayIdx(start) : null;
              let ei = start ? dayIdx(end && end > start ? end : start) : null;
              if (drag?.id === r.id && si != null && ei != null) {
                if (drag.mode !== 'end') si += drag.delta;
                if (drag.mode !== 'start') ei += drag.delta;
                if (ei < si) ei = si;
              }
              return (
                <div key={r.id} className="tl-row">
                  {si != null && ei != null ? (
                    <div className={`tl-bar ${writable ? 'w' : ''}`} style={{ left: si * dayW, width: (ei - si + 1) * dayW - 2 }}
                      onMouseDown={(e) => startDrag(e, r, 'move')} title={r.title}>
                      {writable && <span className="tl-grip l" onMouseDown={(e) => startDrag(e, r, 'start')} />}
                      <span className="tl-bar-label">{r.icon && <PageIcon icon={r.icon} size={12} />}{r.title || 'Untitled'}</span>
                      {listProps.map((x) => isEmptyValue(rowValue(r, x.prop)) ? null : (
                        <span key={x.prop.id} className="tl-bar-prop"><CellValue prop={x.prop} row={r} users={vp.users} titles={vp.titles} compact /></span>
                      ))}
                      {writable && <span className="tl-grip r" onMouseDown={(e) => startDrag(e, r, 'end')} />}
                    </div>
                  ) : writable ? (
                    <div className="tl-empty" onClick={(e) => {
                      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                      const idx = Math.floor((e.clientX - rect.left) / dayW);
                      const d = new Date(origin); d.setDate(d.getDate() + idx);
                      setRowValue(db.id, r.id, prop, { start: ymd(d) });
                    }} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
