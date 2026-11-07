import { useState } from 'react';
import { Pin, X } from 'lucide-react';
import type { Database, DbView, Filter, Prop, User } from '../lib/types';
import { TypeIcon } from './cells';
import { NO_VALUE_OPS, operatorsFor, relativeLabel, updateView, type RelativeValue } from './dbutil';

/** Per-user on/off state of a view's quick filters (Notion keeps these personal; stored locally). */
export function useQuickFilterState(view: DbView | undefined) {
  const key = view ? `atrium:qf:${view.id}` : '';
  const read = (): number[] => {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
  };
  const [active, setActive] = useState<number[]>(read);
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) { setForKey(key); setActive(read()); }
  const list = view?.config.quickFilters ?? [];
  const toggle = (i: number) => {
    const next = active.includes(i) ? active.filter((x) => x !== i) : [...active, i];
    setActive(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  };
  const filters: Filter[] = active.filter((i) => i < list.length).map((i) => list[i]);
  return { list, active, toggle, filters };
}

export function quickFilterLabel(p: Prop, f: Filter, users: Map<string, User>) {
  const opLabel = operatorsFor(p.type).find(([k]) => k === f.op)?.[1] ?? f.op;
  if (NO_VALUE_OPS.includes(f.op)) return `${p.name}: ${opLabel.toLowerCase()}`;
  if (f.op === 'within') return `${p.name}: ${relativeLabel(f.value as RelativeValue)}`;
  const vals = Array.isArray(f.value) ? f.value : f.value == null ? [] : [f.value];
  const names = vals.map((v: any) => {
    if (p.options) return p.options.find((o) => o.id === v)?.name ?? v;
    if (['person', 'created_by', 'last_edited_by'].includes(p.type)) return v === 'me' ? 'Me' : users.get(v)?.name ?? v;
    if (typeof v === 'boolean') return v ? 'Checked' : 'Unchecked';
    return String(v);
  });
  return `${p.name}${names.length ? `: ${['is', 'contains'].includes(f.op) ? '' : opLabel.toLowerCase() + ' '}${names.join(', ')}` : ''}`;
}

/** Toggle chips shown above a view. Editors can unpin. */
export function QuickFilterBar({ db, view, users, state, canEdit }: {
  db: Database; view: DbView; users: Map<string, User>; state: ReturnType<typeof useQuickFilterState>; canEdit: boolean;
}) {
  if (!state.list.length) return null;
  return (
    <div className="quick-filters" role="group" aria-label="Quick filters">
      {state.list.map((f, i) => {
        const p = db.schema.find((x) => x.id === f.prop);
        if (!p) return null;
        const on = state.active.includes(i);
        return (
          <span key={i} className={`qf-chip ${on ? 'on' : ''}`}>
            <button className="qf-chip-main" aria-pressed={on} onClick={() => state.toggle(i)}>
              <TypeIcon type={p.type} size={12} /> {quickFilterLabel(p, f, users)}
            </button>
            {canEdit && (
              <button className="qf-chip-x" title="Unpin quick filter" aria-label="Unpin quick filter"
                onClick={() => updateView(db.id, view.id, { config: { quickFilters: state.list.filter((_, j) => j !== i) } })}>
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function pinQuickFilter(db: Database, view: DbView, f: Filter) {
  const list = view.config.quickFilters ?? [];
  if (list.some((x) => JSON.stringify(x) === JSON.stringify(f))) return;
  updateView(db.id, view.id, { config: { quickFilters: [...list, { prop: f.prop, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) }] } });
}

export const PinIcon = Pin;
