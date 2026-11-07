import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, BadgeAlert, BadgeX, MapPin, MousePointerClick, Plus, Trash2, ExternalLink } from 'lucide-react';
import { get, post, queryClient } from '../lib/api';
import { useMe } from '../lib/hooks';
import type { ButtonPropAction, PlaceValue, Prop, Row, User, VerificationValue } from '../lib/types';
import { toast } from '../components/ui';
import { CellOverlay } from './cells';
import { fmtDate, rowValue, setRowValue, updateProperty, verificationState } from './dbutil';

// ---------- place ----------

export function PlaceDisplay({ value }: { value: PlaceValue }) {
  return (
    <span className="cell-val place-val" title={`${value.lat}, ${value.lng}`}>
      <MapPin size={13} className="faint" />
      {value.name || value.address || `${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`}
    </span>
  );
}

export function PlaceEditor({ dbId, row, prop, anchor, onClose }: { dbId: string; row: Row; prop: Prop; anchor: HTMLElement | null; onClose: () => void }) {
  const cur = (rowValue(row, prop) ?? null) as PlaceValue | null;
  const [f, setF] = useState({ name: cur?.name ?? '', address: cur?.address ?? '', lat: cur?.lat != null ? String(cur.lat) : '', lng: cur?.lng != null ? String(cur.lng) : '' });
  const [err, setErr] = useState('');
  const save = async () => {
    if (!f.lat && !f.lng && !f.name && !f.address) { await setRowValue(dbId, row.id, prop, null); onClose(); return; }
    const lat = Number(f.lat), lng = Number(f.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || f.lat === '' || f.lng === '') {
      setErr('Enter a latitude (-90 to 90) and longitude (-180 to 180)');
      return;
    }
    try {
      await setRowValue(dbId, row.id, prop, { lat, lng, ...(f.name ? { name: f.name } : {}), ...(f.address ? { address: f.address } : {}) });
      onClose();
    } catch (e: any) { setErr(e.message); }
  };
  // Paste "lat, lng" (e.g. from a maps app) into either coordinate field.
  const onPaste = (e: React.ClipboardEvent) => {
    const m = e.clipboardData.getData('text').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) { e.preventDefault(); setF({ ...f, lat: m[1], lng: m[2] }); }
  };
  return (
    <CellOverlay anchor={anchor} onClose={save} minWidth={300}>
      <div className="place-editor" onKeyDown={(e) => { if (e.key === 'Enter') save(); }}>
        <label>Name<input className="input sm" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Cape Town office" /></label>
        <label>Address<input className="input sm" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <div className="place-coords">
          <label>Latitude<input className="input sm" inputMode="decimal" value={f.lat} onPaste={onPaste} onChange={(e) => setF({ ...f, lat: e.target.value })} placeholder="-33.9249" /></label>
          <label>Longitude<input className="input sm" inputMode="decimal" value={f.lng} onPaste={onPaste} onChange={(e) => setF({ ...f, lng: e.target.value })} placeholder="18.4241" /></label>
        </div>
        {err && <div className="auth-error" style={{ fontSize: 12 }}>{err}</div>}
        <div className="place-actions">
          {cur && <a className="link-btn" href={`https://www.openstreetmap.org/?mlat=${cur.lat}&mlon=${cur.lng}#map=15/${cur.lat}/${cur.lng}`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open map</a>}
          <span style={{ flex: 1 }} />
          {cur && <button className="btn sm" onClick={async () => { await setRowValue(dbId, row.id, prop, null); onClose(); }}>Clear</button>}
          <button className="btn sm primary" onClick={save}>Done</button>
        </div>
      </div>
    </CellOverlay>
  );
}

// ---------- verification ----------

export function VerificationBadge({ value, users, compact }: { value: VerificationValue | null | undefined; users?: Map<string, User>; compact?: boolean }) {
  const state = verificationState(value);
  if (!state) return null;
  const Icon = state === 'verified' ? BadgeCheck : state === 'expired' ? BadgeAlert : BadgeX;
  const by = value?.by ? users?.get(value.by)?.name : null;
  const title = state === 'verified'
    ? `Verified${by ? ` by ${by}` : ''}${value?.until ? ` until ${fmtDate(value.until.slice(0, 10))}` : ''}`
    : state === 'expired' ? `Verification expired${value?.until ? ` on ${fmtDate(value.until.slice(0, 10))}` : ''}` : 'Not verified';
  return (
    <span className={`verif-badge verif-${state}`} title={title}>
      <Icon size={14} />{!compact && <span>{state === 'verified' ? 'Verified' : state === 'expired' ? 'Expired' : 'Unverified'}</span>}
    </span>
  );
}

const EXPIRY_PRESETS: [string, number | null][] = [['No expiry', null], ['1 week', 7], ['1 month', 30], ['90 days', 90], ['1 year', 365]];
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

/** Shared verify/unverify control (cells + page badge). */
export function VerificationControls({ value, onSet, onClear }: { value: VerificationValue | null | undefined; onSet: (v: { state: 'verified' | 'unverified'; until?: string | null }) => void; onClear?: () => void }) {
  const state = verificationState(value);
  const [custom, setCustom] = useState('');
  return (
    <div className="verif-controls">
      <div className="menu-heading">{state === 'verified' ? 'Re-verify for' : 'Verify for'}</div>
      {EXPIRY_PRESETS.map(([label, days]) => (
        <button key={label} className="menu-item" onClick={() => onSet({ state: 'verified', until: days == null ? null : plusDays(days) })}>
          <span className="menu-icon"><BadgeCheck size={14} /></span><span className="menu-label">{label}</span>
        </button>
      ))}
      <div className="verif-custom">
        <input className="input sm" type="date" value={custom} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setCustom(e.target.value)} aria-label="Verified until" />
        <button className="btn sm" disabled={!custom} onClick={() => onSet({ state: 'verified', until: new Date(`${custom}T23:59:59`).toISOString() })}>Verify until</button>
      </div>
      {state && <div className="menu-sep" />}
      {state === 'verified' && (
        <button className="menu-item" onClick={() => onSet({ state: 'unverified' })}><span className="menu-icon"><BadgeX size={14} /></span><span className="menu-label">Mark as unverified</span></button>
      )}
      {state && onClear && (
        <button className="menu-item danger" onClick={onClear}><span className="menu-icon"><Trash2 size={14} /></span><span className="menu-label">Remove verification</span></button>
      )}
    </div>
  );
}

export function VerificationEditor({ dbId, row, prop, anchor, onClose }: { dbId: string; row: Row; prop: Prop; anchor: HTMLElement | null; onClose: () => void }) {
  const { data: me } = useMe();
  const cur = rowValue(row, prop) as VerificationValue | null;
  return (
    <CellOverlay anchor={anchor} onClose={onClose} minWidth={240}>
      <VerificationControls
        value={cur}
        onSet={async ({ state, until }) => {
          await setRowValue(dbId, row.id, prop, { state, by: me?.id, at: new Date().toISOString(), ...(until ? { until } : {}) });
          onClose();
        }}
        onClear={async () => { await setRowValue(dbId, row.id, prop, null); onClose(); }}
      />
    </CellOverlay>
  );
}

// ---------- button property ----------

export function ButtonCell({ dbId, row, prop, canEdit }: { dbId: string; row: Row; prop: Prop; canEdit: boolean }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!prop.button?.actions?.length) { toast('This button has no actions yet — set them up in the property settings'); return; }
    setBusy(true);
    try {
      const r = await post<{ open?: string; created?: { id: string; title: string }[] }>(`/databases/${dbId}/rows/${row.id}/button/${prop.id}`);
      queryClient.invalidateQueries({ queryKey: ['dbq', dbId] });
      queryClient.invalidateQueries({ queryKey: ['page', row.id] });
      if (r.created?.length) toast(`Added "${r.created[0].title || 'Untitled'}"`);
      if (r.open) {
        const m = r.open.match(/\/p\/([0-9a-f-]{36})/);
        if (m && (r.open.startsWith('/') || r.open.startsWith(location.origin))) nav(`/p/${m[1]}`);
        else window.open(/^https?:\/\//.test(r.open) ? r.open : `https://${r.open}`, '_blank', 'noopener');
      }
    } catch (err: any) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  void canEdit;
  return (
    <button className="prop-button" onClick={run} disabled={busy}>
      <MousePointerClick size={13} /> {prop.button?.label || prop.name}
    </button>
  );
}

const SETTABLE = ['text', 'number', 'select', 'status', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'date'];

function PresetFields({ schema, users, value, onChange }: { schema: Prop[]; users: User[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const set = (id: string, v: any) => {
    const next = { ...value };
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete next[id];
    else next[id] = v;
    onChange(next);
  };
  return (
    <div className="btn-presets">
      {schema.filter((p) => SETTABLE.includes(p.type)).map((p) => {
        const v = value[p.id];
        let input: React.ReactNode;
        if (p.type === 'checkbox') input = <select className="input sm" value={v === undefined ? '' : String(v)} onChange={(e) => set(p.id, e.target.value === '' ? '' : e.target.value === 'true')}><option value="">—</option><option value="true">Checked</option><option value="false">Unchecked</option></select>;
        else if (['select', 'status'].includes(p.type)) input = <select className="input sm" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)}><option value="">—</option>{p.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
        else if (p.type === 'multi_select') input = <select className="input sm" value={v?.[0] ?? ''} onChange={(e) => set(p.id, e.target.value ? [e.target.value] : '')}><option value="">—</option>{p.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
        else if (p.type === 'person') input = <select className="input sm" value={v?.[0] ?? ''} onChange={(e) => set(p.id, e.target.value ? [e.target.value] : '')}><option value="">—</option><option value="@me">Person who clicks</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
        else if (p.type === 'date') input = <select className="input sm" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)}><option value="">—</option><option value="@today">Today (date clicked)</option><option value="@now">Now (time clicked)</option></select>;
        else if (p.type === 'number') input = <input className="input sm" type="number" value={v ?? ''} onChange={(e) => set(p.id, e.target.value === '' ? '' : Number(e.target.value))} />;
        else input = <input className="input sm" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)} />;
        return <label key={p.id} className="btn-preset"><span>{p.name}</span>{input}</label>;
      })}
    </div>
  );
}

/** Property menu section for button properties: label + action list. */
export function ButtonPropSettings({ dbId, prop, schema, users }: { dbId: string; prop: Prop; schema: Prop[]; users: User[] }) {
  const [label, setLabel] = useState(prop.button?.label ?? prop.name);
  const [actions, setActions] = useState<ButtonPropAction[]>(prop.button?.actions ?? []);
  const dirty = useRef(false);
  const { data: dbs } = useQuery({ queryKey: ['databases'], queryFn: () => get<{ id: string; title: string }[]>('/databases') });
  const save = (next: { label?: string; actions?: ButtonPropAction[] }) => {
    dirty.current = false;
    updateProperty(dbId, prop.id, { button: { label: next.label ?? label, actions: next.actions ?? actions } });
  };
  useEffect(() => () => { if (dirty.current) updateProperty(dbId, prop.id, { button: { label, actions } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setAt = (i: number, a: ButtonPropAction) => { const next = actions.map((x, j) => (j === i ? a : x)); setActions(next); save({ actions: next }); };
  return (
    <div className="btnprop-settings">
      <div className="menu-heading">Button</div>
      <input className="input sm" value={label} aria-label="Button label" onChange={(e) => { setLabel(e.target.value); dirty.current = true; }} onBlur={() => save({ label })} />
      <div className="menu-heading">When clicked</div>
      {actions.map((a, i) => (
        <div key={i} className="btnprop-action">
          <div className="btnprop-action-head">
            <select className="input sm" value={a.type} onChange={(e) => {
              const t = e.target.value as ButtonPropAction['type'];
              setAt(i, t === 'setProps' ? { type: 'setProps', props: {} } : t === 'addRow' ? { type: 'addRow', databaseId: dbId, props: {} } : t === 'insert' ? { type: 'insert', markdown: '', blocks: [] } : { type: 'open', target: '' });
            }}>
              <option value="setProps">Edit this page's properties</option>
              <option value="addRow">Add a page to a database</option>
              <option value="insert">Add content to this page</option>
              <option value="open">Open a page or link</option>
            </select>
            <button className="icon-btn" title="Remove action" onClick={() => { const next = actions.filter((_, j) => j !== i); setActions(next); save({ actions: next }); }}><Trash2 size={14} /></button>
          </div>
          {a.type === 'setProps' && <PresetFields schema={schema} users={users} value={a.props} onChange={(props) => setAt(i, { ...a, props })} />}
          {a.type === 'addRow' && (
            <>
              <select className="input sm" value={a.databaseId} onChange={(e) => setAt(i, { ...a, databaseId: e.target.value, props: {} })}>
                {(dbs ?? []).map((d) => <option key={d.id} value={d.id}>{d.title || 'Untitled'}</option>)}
              </select>
              <input className="input sm" placeholder="New page title" defaultValue={a.title ?? ''} onBlur={(e) => setAt(i, { ...a, title: e.target.value })} />
              {a.databaseId === dbId && <PresetFields schema={schema} users={users} value={a.props} onChange={(props) => setAt(i, { ...a, props })} />}
            </>
          )}
          {a.type === 'insert' && (
            <textarea className="input sm" rows={3} placeholder="Markdown to append, e.g. - [ ] Follow up" defaultValue={a.markdown ?? ''}
              onBlur={(e) => setAt(i, { type: 'insert', markdown: e.target.value, blocks: [] })} />
          )}
          {a.type === 'open' && (
            <input className="input sm" placeholder="https://… or /p/<page id>" defaultValue={a.target} onBlur={(e) => setAt(i, { ...a, target: e.target.value })} />
          )}
        </div>
      ))}
      <button className="menu-item" onClick={() => { const next = [...actions, { type: 'setProps', props: {} } as ButtonPropAction]; setActions(next); save({ actions: next }); }}>
        <span className="menu-icon"><Plus size={14} /></span><span className="menu-label">Add action</span>
      </button>
    </div>
  );
}
