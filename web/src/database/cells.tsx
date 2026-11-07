import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlignLeft, ArrowUpRight, AtSign, Calendar, CheckSquare, ChevronDownCircle, Clock, Fingerprint, GripVertical, Hash, Link2,
  List, Loader, MoreHorizontal, Paperclip, Phone, Search, Sigma, Trash2, Type, UserCircle, Users, X, Plus, Check, FileText, AlertCircle,
  Sparkles, MapPin, BadgeCheck, MousePointerClick,
} from 'lucide-react';
import { ButtonCell, PlaceDisplay, PlaceEditor, VerificationBadge, VerificationEditor } from './newprops';
import { AiCellValue, aiDisplayProp } from '../ai/AiCell';
import type { Prop, PropType, Row, SelectOption, User, QueryResult } from '../lib/types';
import { Avatar, PageIcon, Popover, MenuItem } from '../components/ui';
import { uploadFile, post } from '../lib/api';
import { useUi } from '../lib/store';
import {
  COLORS, fmtDate, formatNumber, isEmptyValue, randomColor, READONLY_TYPES, rowValue, setRowValue, shortId, updateProperty, ymd,
} from './dbutil';

const ICONS: Record<PropType, any> = {
  title: Type, text: AlignLeft, number: Hash, select: ChevronDownCircle, multi_select: List, status: Loader, date: Calendar,
  person: Users, checkbox: CheckSquare, url: Link2, email: AtSign, phone: Phone, files: Paperclip, relation: ArrowUpRight,
  rollup: Search, formula: Sigma, created_time: Clock, created_by: UserCircle, last_edited_time: Clock, last_edited_by: UserCircle,
  unique_id: Fingerprint, ai: Sparkles, place: MapPin, verification: BadgeCheck, button: MousePointerClick,
};
export function TypeIcon({ type, size = 14 }: { type: PropType; size?: number }) {
  const I = ICONS[type] ?? AlignLeft;
  return <I size={size} strokeWidth={1.8} className="type-icon" />;
}

export const tagClass = (color?: string) => `tag c-${color || 'default'}`;

export function Tag({ option, onRemove, status }: { option?: SelectOption | null; onRemove?: () => void; status?: boolean }) {
  if (!option) return null;
  return (
    <span className={`${tagClass(option.color)} ${status ? 'status-tag' : ''}`}>
      {status && <span className={`status-dot sd-${option.color || 'default'}`} />}
      <span className="tag-text">{option.name}</span>
      {onRemove && (
        <button className="tag-x" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** Floating editor that covers the cell it was opened from (Notion-style). */
export function CellOverlay({ anchor, onClose, children, minWidth = 0, below = false }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; minWidth?: number; below?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.max(r.width, minWidth);
    const el = ref.current;
    const h = el?.offsetHeight ?? 200;
    let top = below ? r.bottom + 4 : r.top;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    setStyle({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top, minWidth: w });
  }, [anchor, minWidth, below, children]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t)) return;
      // nested popovers opened from inside the overlay
      if (t.closest?.('.popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="cell-overlay" style={{ position: 'fixed', ...style }} onMouseDown={(e) => e.stopPropagation()}>{children}</div>,
    document.body,
  );
}

// ---------- display ----------

export function CellValue({ prop, row, users, titles, wrap, compact }: {
  prop: Prop; row: Row; users: Map<string, User>; titles: Record<string, string>; wrap?: boolean; compact?: boolean;
}) {
  const v = rowValue(row, prop);
  return <ValueDisplay prop={prop} value={v} users={users} titles={titles} wrap={wrap} compact={compact} />;
}

export function ValueDisplay({ prop, value: v, users, titles, wrap, compact }: {
  prop: Prop; value: any; users: Map<string, User>; titles: Record<string, string>; wrap?: boolean; compact?: boolean;
}) {
  const openPeek = (id: string) => useUi.getState().set({ peekRowId: id });
  // AI autofill values are stored as text / option id / option ids — display them as that type.
  if (prop.type === 'ai') return <ValueDisplay prop={aiDisplayProp(prop)} value={v} users={users} titles={titles} wrap={wrap} compact={compact} />;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v)
    return <span className="cell-error" title={v.error}><AlertCircle size={13} /> {compact ? '' : 'Error'}</span>;
  if (prop.type === 'checkbox' || (prop.type === 'formula' && typeof v === 'boolean'))
    return <span className={`checkbox ${v ? 'checked' : ''}`}>{v && <Check size={12} strokeWidth={3} />}</span>;
  if (isEmptyValue(v)) return null;
  const cls = `cell-val ${wrap ? 'wrap' : ''}`;
  switch (prop.type) {
    case 'title': return <span className={cls}>{v}</span>;
    case 'select': return <Tag option={prop.options?.find((o) => o.id === v)} />;
    case 'status': return <Tag option={prop.options?.find((o) => o.id === v)} status />;
    case 'multi_select':
      return <span className={`tags ${wrap ? 'wrap' : ''}`}>{(v as string[]).map((id) => <Tag key={id} option={prop.options?.find((o) => o.id === id)} />)}</span>;
    case 'person': case 'created_by': case 'last_edited_by':
      return (
        <span className={`tags ${wrap ? 'wrap' : ''}`}>
          {(v as string[]).map((id) => (
            <span key={id} className="person"><Avatar user={users.get(id) ?? { name: '?', id }} size={20} />{!compact && <span>{users.get(id)?.name ?? 'Unknown'}</span>}</span>
          ))}
        </span>
      );
    case 'date': return <span className={cls}>{fmtDate(v.start, v.start?.length > 10)}{v.end ? ` → ${fmtDate(v.end, v.end.length > 10)}` : ''}</span>;
    case 'created_time': case 'last_edited_time': return <span className={cls}>{fmtDate(v, true)}</span>;
    case 'number': return <span className={`${cls} num`}>{formatNumber(v, prop.number_format)}</span>;
    case 'url': return <a className={`${cls} link`} href={/^https?:/.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{v}</a>;
    case 'email': return <a className={`${cls} link`} href={`mailto:${v}`} onClick={(e) => e.stopPropagation()}>{v}</a>;
    case 'phone': return <a className={`${cls} link`} href={`tel:${v}`} onClick={(e) => e.stopPropagation()}>{v}</a>;
    case 'files':
      return (
        <span className={`tags ${wrap ? 'wrap' : ''}`}>
          {(v as any[]).map((f, i) =>
            f.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)
              ? <img key={i} className="file-thumb" src={f.url} alt={f.name} title={f.name} />
              : <a key={i} className="file-chip" href={f.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><Paperclip size={11} />{f.name}</a>,
          )}
        </span>
      );
    case 'relation':
      return (
        <span className={`tags ${wrap ? 'wrap' : ''}`}>
          {(v as string[]).map((id) => (
            <span key={id} className="relation-chip" onClick={(e) => { e.stopPropagation(); openPeek(id); }}>
              <FileText size={13} className="default-icon" /><span>{titles[id] || 'Untitled'}</span>
            </span>
          ))}
        </span>
      );
    case 'unique_id': return <span className={cls}>{prop.id_prefix ? `${prop.id_prefix}-` : ''}{v}</span>;
    case 'place': return <PlaceDisplay value={v} />;
    case 'verification': return <VerificationBadge value={v} users={users} compact={compact} />;
    case 'formula': case 'rollup': {
      // Formula results: numbers, text, booleans, ISO dates, {start,end} ranges, pages {id,title}, people {id,name}, or lists.
      const one = (x: any, i: number): React.ReactNode => {
        if (x == null) return null;
        if (typeof x === 'number') return <span key={i} className="num">{Math.round(x * 1000) / 1000}</span>;
        if (typeof x === 'boolean') return <span key={i}>{x ? '✓' : '✗'}</span>;
        if (typeof x === 'string') return <span key={i}>{/^\d{4}-\d{2}-\d{2}T/.test(x) ? fmtDate(x) : x}</span>;
        if (typeof x === 'object' && 'start' in x) return <span key={i}>{fmtDate(x.start)}{x.end ? ` → ${fmtDate(x.end)}` : ''}</span>;
        if (typeof x === 'object' && 'title' in x)
          return <span key={i} className="relation-chip" onClick={(e) => { e.stopPropagation(); openPeek(x.id); }}><FileText size={13} className="default-icon" /><span>{x.title || 'Untitled'}</span></span>;
        if (typeof x === 'object' && 'name' in x)
          return <span key={i} className="person"><Avatar user={users.get(x.id) ?? { name: x.name, id: x.id }} size={20} />{!compact && <span>{x.name}</span>}</span>;
        return <span key={i}>{JSON.stringify(x)}</span>;
      };
      if (Array.isArray(v)) {
        const rich = v.some((x) => x && typeof x === 'object');
        return rich ? <span className={`tags ${wrap ? 'wrap' : ''}`}>{v.map(one)}</span> : <span className={cls}>{v.map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : String(x))).join(', ')}</span>;
      }
      return <span className={`${cls} ${typeof v === 'number' ? 'num' : ''}`}>{one(v, 0)}</span>;
    }
    default: return <span className={cls}>{String(v)}</span>;
  }
}

// ---------- editors ----------

interface EditorProps {
  dbId: string;
  row: Row;
  prop: Prop;
  anchor: HTMLElement | null;
  onClose: () => void;
  users: Map<string, User>;
  titles: Record<string, string>;
}

export function CellEditor(p: EditorProps) {
  switch (p.prop.type) {
    case 'select': case 'multi_select': case 'status': return <OptionEditor {...p} />;
    case 'date': return <DateEditor {...p} />;
    case 'person': return <PersonEditor {...p} />;
    case 'files': return <FilesEditor {...p} />;
    case 'relation': return <RelationEditor {...p} />;
    case 'place': return <PlaceEditor {...p} />;
    case 'verification': return <VerificationEditor {...p} />;
    case 'checkbox': return null;
    default:
      if (READONLY_TYPES.includes(p.prop.type)) return null;
      return <TextEditor {...p} />;
  }
}

function TextEditor({ dbId, row, prop, anchor, onClose }: EditorProps) {
  const initial = rowValue(row, prop);
  const [val, setVal] = useState(initial == null ? '' : String(initial));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [val]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    let out: any = val;
    if (prop.type === 'number') out = val.trim() === '' ? null : Number(val.replace(/[^\d.\-e]/g, ''));
    if (prop.type === 'number' && Number.isNaN(out)) out = null;
    if (prop.type !== 'number' && prop.type !== 'title') out = val.trim() === '' ? null : val;
    if ((out ?? '') !== (initial ?? '')) setRowValue(dbId, row.id, prop, out ?? (prop.type === 'title' ? '' : null));
    onClose();
  };
  return (
    <CellOverlay anchor={anchor} onClose={commit} minWidth={240}>
      <textarea
        ref={ref}
        className="cell-textarea"
        value={val}
        rows={1}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); commit(); }
        }}
        inputMode={prop.type === 'number' ? 'decimal' : undefined}
      />
    </CellOverlay>
  );
}

function OptionEditor({ dbId, row, prop, anchor, onClose }: EditorProps) {
  const multi = prop.type === 'multi_select';
  const raw = rowValue(row, prop);
  const [selected, setSelected] = useState<string[]>(multi ? raw ?? [] : raw ? [raw] : []);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const [editOpt, setEditOpt] = useState<{ opt: SelectOption; el: HTMLElement } | null>(null);
  const options = prop.options ?? [];
  const filtered = options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim() && !exact;
  const items: ({ kind: 'opt'; opt: SelectOption } | { kind: 'create' })[] = [
    ...filtered.map((opt) => ({ kind: 'opt' as const, opt })),
    ...(canCreate ? [{ kind: 'create' as const }] : []),
  ];

  const save = (ids: string[]) => {
    setSelected(ids);
    setRowValue(dbId, row.id, prop, multi ? ids : ids[0] ?? null);
  };
  const pick = (id: string) => {
    if (multi) save(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else { save([id]); onClose(); }
    setQ('');
  };
  const create = async () => {
    const opt: SelectOption = { id: shortId(), name: q.trim(), color: randomColor(), ...(prop.type === 'status' ? { group: 'todo' as const } : {}) };
    await updateProperty(dbId, prop.id, { options: [...options, opt] });
    pick(opt.id);
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'create') create(); else pick(it.opt.id);
  };
  const groups = prop.type === 'status'
    ? ([['todo', 'To-do'], ['in_progress', 'In progress'], ['complete', 'Complete']] as const)
    : null;

  const renderOpt = (opt: SelectOption) => {
    const i = items.findIndex((x) => x.kind === 'opt' && x.opt.id === opt.id);
    return (
      <div key={opt.id} className={`opt-row ${i === hl ? 'hl' : ''}`} onMouseEnter={() => setHl(i)} onClick={() => pick(opt.id)}>
        <GripVertical size={12} className="faint" />
        <Tag option={opt} status={prop.type === 'status'} />
        {selected.includes(opt.id) && multi && <Check size={14} className="faint" />}
        <button className="icon-btn opt-more" onClick={(e) => { e.stopPropagation(); setEditOpt({ opt, el: e.currentTarget }); }}>
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={280}>
      <div className="opt-input">
        {selected.map((id) => (
          <Tag key={id} option={options.find((o) => o.id === id)} status={prop.type === 'status'} onRemove={() => save(selected.filter((x) => x !== id))} />
        ))}
        <input
          autoFocus
          value={q}
          placeholder={selected.length ? '' : 'Search for an option...'}
          onChange={(e) => { setQ(e.target.value); setHl(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); choose(hl); }
            if (e.key === 'Backspace' && !q && selected.length) save(selected.slice(0, -1));
          }}
        />
      </div>
      <div className="opt-list">
        <div className="menu-heading">{canCreate ? '' : `Select an option${prop.type !== 'multi_select' ? '' : ' or create one'}`}</div>
        {groups
          ? groups.map(([g, label]) => {
              const os = filtered.filter((o) => (o.group ?? 'todo') === g);
              if (!os.length) return null;
              return <div key={g}><div className="menu-heading">{label}</div>{os.map(renderOpt)}</div>;
            })
          : filtered.map(renderOpt)}
        {canCreate && (
          <div className={`opt-row ${hl === items.length - 1 ? 'hl' : ''}`} onMouseEnter={() => setHl(items.length - 1)} onClick={create}>
            <span className="muted">Create</span> <span className={tagClass('default')}>{q.trim()}</span>
          </div>
        )}
      </div>
      {editOpt && (
        <OptionSettings dbId={dbId} prop={prop} opt={editOpt.opt} anchor={editOpt.el} onClose={() => setEditOpt(null)}
          onDeleted={(id) => setSelected((s) => s.filter((x) => x !== id))} />
      )}
    </CellOverlay>
  );
}

export function OptionSettings({ dbId, prop, opt, anchor, onClose, onDeleted }: {
  dbId: string; prop: Prop; opt: SelectOption; anchor: HTMLElement; onClose: () => void; onDeleted?: (id: string) => void;
}) {
  const [name, setName] = useState(opt.name);
  const saveOpt = (patch: Partial<SelectOption>) =>
    updateProperty(dbId, prop.id, { options: (prop.options ?? []).map((o) => (o.id === opt.id ? { ...o, ...patch } : o)) });
  return (
    <Popover anchor={anchor} open onClose={() => { if (name.trim() && name !== opt.name) saveOpt({ name: name.trim() }); onClose(); }} placement="right-start" width={220}>
      <div style={{ padding: 4 }}>
        <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { saveOpt({ name: name.trim() || opt.name }); onClose(); } }} />
      </div>
      <MenuItem icon={<Trash2 size={14} />} onClick={async () => {
        await updateProperty(dbId, prop.id, { options: (prop.options ?? []).filter((o) => o.id !== opt.id) });
        onDeleted?.(opt.id);
        onClose();
      }}>Delete</MenuItem>
      {prop.type === 'status' && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Group</div>
          {([['todo', 'To-do'], ['in_progress', 'In progress'], ['complete', 'Complete']] as const).map(([g, l]) => (
            <MenuItem key={g} onClick={() => saveOpt({ group: g })} right={(opt.group ?? 'todo') === g ? <Check size={14} /> : null}>{l}</MenuItem>
          ))}
        </>
      )}
      <div className="menu-sep" />
      <div className="menu-heading">Colors</div>
      {COLORS.map((c) => (
        <MenuItem key={c} icon={<span className={`color-swatch c-${c}`} />} onClick={() => { saveOpt({ color: c }); onClose(); }}
          right={opt.color === c ? <Check size={14} /> : null}>
          {c[0].toUpperCase() + c.slice(1)}
        </MenuItem>
      ))}
    </Popover>
  );
}

function DateEditor({ dbId, row, prop, anchor, onClose }: EditorProps) {
  const cur = rowValue(row, prop) ?? {};
  const [start, setStart] = useState<string>(cur.start ?? '');
  const [end, setEnd] = useState<string>(cur.end ?? '');
  const [hasEnd, setHasEnd] = useState(!!cur.end);
  const [time, setTime] = useState((cur.start ?? '').length > 10);
  const initialMonth = start ? new Date((start.slice(0, 10)) + 'T00:00:00') : new Date();
  const [month, setMonth] = useState(new Date(initialMonth.getFullYear(), initialMonth.getMonth(), 1));
  const [picking, setPicking] = useState<'start' | 'end'>('start');

  const save = (s: string, e: string, he: boolean) => {
    setRowValue(dbId, row.id, prop, s ? { start: s, ...(he && e ? { end: e } : {}) } : null);
  };
  const conv = (v: string, t: boolean) => (!v ? '' : t ? (v.length > 10 ? v.slice(0, 16) : `${v}T09:00`) : v.slice(0, 10));
  const pickDay = (d: Date) => {
    const ds = ymd(d);
    if (hasEnd && picking === 'end') {
      const e = time ? `${ds}T${(end || start).slice(11, 16) || '09:00'}` : ds;
      setEnd(e); save(start, e, true); setPicking('start');
    } else {
      const s = time ? `${ds}T${start.slice(11, 16) || '09:00'}` : ds;
      setStart(s); save(s, end, hasEnd); if (hasEnd) setPicking('end');
    }
  };
  const days: Date[] = [];
  const first = new Date(month);
  first.setDate(1 - first.getDay());
  for (let i = 0; i < 42; i++) days.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const sD = start.slice(0, 10), eD = end.slice(0, 10);
  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={260} below>
      <div className="date-editor">
        <div className="date-inputs">
          <input className="input sm" type={time ? 'datetime-local' : 'date'} value={conv(start, time)}
            onFocus={() => setPicking('start')} onChange={(e) => { setStart(e.target.value); save(e.target.value, end, hasEnd); }} />
          {hasEnd && (
            <input className="input sm" type={time ? 'datetime-local' : 'date'} value={conv(end, time)}
              onFocus={() => setPicking('end')} onChange={(e) => { setEnd(e.target.value); save(start, e.target.value, true); }} />
          )}
        </div>
        <div className="cal-head">
          <span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <span>
            <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
            <button className="icon-btn" onClick={() => { const t = new Date(); setMonth(new Date(t.getFullYear(), t.getMonth(), 1)); }}>•</button>
            <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
          </span>
        </div>
        <div className="mini-cal">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <span key={d} className="dow">{d}</span>)}
          {days.map((d) => {
            const ds = ymd(d);
            const inRange = hasEnd && sD && eD && ds > sD && ds < eD;
            return (
              <button key={ds} onClick={() => pickDay(d)}
                className={`day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${ds === ymd(new Date()) ? 'today' : ''} ${ds === sD || ds === eD ? 'sel' : ''} ${inRange ? 'range' : ''}`}>
                {d.getDate()}
              </button>
            );
          })}
        </div>
        <div className="menu-sep" />
        <label className="date-opt">End date <input type="checkbox" checked={hasEnd} onChange={(e) => { setHasEnd(e.target.checked); save(start, end || start, e.target.checked); if (e.target.checked && !end) setEnd(start); }} /></label>
        <label className="date-opt">Include time <input type="checkbox" checked={time} onChange={(e) => {
          const t = e.target.checked; setTime(t);
          const s = conv(start, t), en = conv(end, t);
          setStart(s); setEnd(en); save(s, en, hasEnd);
        }} /></label>
        <div className="menu-sep" />
        <MenuItem onClick={() => { setStart(''); setEnd(''); save('', '', false); onClose(); }}>Clear</MenuItem>
      </div>
    </CellOverlay>
  );
}

function PersonEditor({ dbId, row, prop, anchor, onClose, users }: EditorProps) {
  const [sel, setSel] = useState<string[]>(rowValue(row, prop) ?? []);
  const [q, setQ] = useState('');
  const list = [...users.values()].filter((u) => u.active !== false && (u.name + u.email).toLowerCase().includes(q.toLowerCase()));
  const single = prop.limit === 'one';
  const toggle = (id: string) => {
    // "Limit to one person": picking someone replaces the current person.
    const next = sel.includes(id) ? sel.filter((x) => x !== id) : single ? [id] : [...sel, id];
    setSel(next);
    setRowValue(dbId, row.id, prop, next);
    if (single && next.length) onClose();
  };
  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={280}>
      <div className="opt-input">
        {sel.map((id) => (
          <span key={id} className="tag c-default person-tag"><Avatar user={users.get(id)} size={16} /> {users.get(id)?.name}
            <button className="tag-x" onMouseDown={(e) => { e.preventDefault(); toggle(id); }}><X size={12} /></button></span>
        ))}
        <input autoFocus value={q} placeholder={sel.length ? '' : 'Search for a person...'} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="opt-list">
        {list.map((u) => (
          <div key={u.id} className="opt-row" onClick={() => toggle(u.id)}>
            <Avatar user={u} size={20} /><span style={{ flex: 1 }}>{u.name}</span>
            {sel.includes(u.id) && <Check size={14} className="faint" />}
          </div>
        ))}
        {!list.length && <div className="menu-footer">No people found</div>}
      </div>
    </CellOverlay>
  );
}

function FilesEditor({ dbId, row, prop, anchor, onClose }: EditorProps) {
  const [files, setFiles] = useState<any[]>(rowValue(row, prop) ?? []);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = (f: any[]) => { setFiles(f); setRowValue(dbId, row.id, prop, f); };
  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={300}>
      <div className="files-editor">
        {files.map((f, i) => (
          <div key={i} className="opt-row">
            <Paperclip size={13} className="faint" />
            <a href={f.url} target="_blank" rel="noreferrer" style={{ flex: 1 }} className="link">{f.name}</a>
            <button className="icon-btn" onClick={() => save(files.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
          </div>
        ))}
        <div className="files-actions">
          <button className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Upload'}</button>
          <input ref={input} type="file" multiple hidden onChange={async (e) => {
            const list = [...(e.target.files ?? [])];
            if (!list.length) return;
            setBusy(true);
            try {
              const up = await Promise.all(list.map(uploadFile));
              save([...files, ...up.map((u) => ({ name: u.name, url: u.url, mime: u.mime, size: u.size }))]);
            } finally { setBusy(false); }
          }} />
        </div>
        <div className="files-link">
          <input className="input sm" placeholder="Paste a link…" value={link} onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && link.trim()) { save([...files, { name: link.trim(), url: link.trim() }]); setLink(''); } }} />
        </div>
      </div>
    </CellOverlay>
  );
}

function RelationEditor({ dbId, row, prop, anchor, onClose, titles }: EditorProps) {
  const target = prop.relation?.databaseId;
  const [sel, setSel] = useState<string[]>(rowValue(row, prop) ?? []);
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['dbq', target, 'relation-picker', q],
    queryFn: () => post<QueryResult>(`/databases/${target}/query`, { search: q || undefined }),
    enabled: !!target,
  });
  const localTitles = useMemo(() => {
    const m: Record<string, string> = { ...titles };
    for (const r of data?.rows ?? []) m[r.id] = r.title;
    return m;
  }, [data, titles]);
  const toggle = (id: string) => {
    const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    setSel(next);
    setRowValue(dbId, row.id, prop, next);
  };
  if (!target) return <CellOverlay anchor={anchor} onClose={onClose}><div className="menu-footer">Relation is not configured.</div></CellOverlay>;
  const others = (data?.rows ?? []).filter((r) => !sel.includes(r.id));
  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={320}>
      <div className="opt-input">
        <input autoFocus value={q} placeholder="Link or search a page…" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="opt-list">
        {!!sel.length && <div className="menu-heading">Linked</div>}
        {sel.map((id) => (
          <div key={id} className="opt-row" onClick={() => toggle(id)}>
            <PageIcon icon={null} size={16} /><span style={{ flex: 1 }}>{localTitles[id] || 'Untitled'}</span><X size={13} className="faint" />
          </div>
        ))}
        <div className="menu-heading">{sel.length ? 'Link another page' : 'Select a page'}</div>
        {others.slice(0, 50).map((r) => (
          <div key={r.id} className="opt-row" onClick={() => toggle(r.id)}>
            <PageIcon icon={r.icon} size={16} /><span style={{ flex: 1 }}>{r.title || 'Untitled'}</span><Plus size={13} className="faint" />
          </div>
        ))}
        {!others.length && <div className="menu-footer">No pages</div>}
      </div>
    </CellOverlay>
  );
}

/** A clickable cell: displays a value and opens the right editor. */
export function EditableCell({ dbId, row, prop, users, titles, canEdit, wrap, className, children, style }: {
  dbId: string; row: Row; prop: Prop; users: Map<string, User>; titles: Record<string, string>; canEdit: boolean;
  wrap?: boolean; className?: string; children?: ReactNode; style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const readOnly = !canEdit || READONLY_TYPES.includes(prop.type);
  const onClick = (e: React.MouseEvent) => {
    if (readOnly) return;
    if ((e.target as HTMLElement).closest('a,.relation-chip,.row-open')) return;
    if (prop.type === 'checkbox') { setRowValue(dbId, row.id, prop, !rowValue(row, prop)); return; }
    setOpen(true);
  };
  return (
    <div ref={ref} className={`${className ?? ''} ${open ? 'editing' : ''} ${readOnly ? 'ro' : ''}`} onClick={onClick} style={style}>
      {children ?? (prop.type === 'button'
        ? <ButtonCell dbId={dbId} row={row} prop={prop} canEdit={canEdit} />
        : prop.type === 'ai'
        ? <AiCellValue dbId={dbId} row={row} prop={prop} canEdit={canEdit}><CellValue prop={prop} row={row} users={users} titles={titles} wrap={wrap} /></AiCellValue>
        : <CellValue prop={prop} row={row} users={users} titles={titles} wrap={wrap} />)}
      {open && <CellEditor dbId={dbId} row={row} prop={prop} anchor={ref.current} onClose={() => setOpen(false)} users={users} titles={titles} />}
    </div>
  );
}
