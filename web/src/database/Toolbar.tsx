import { useState } from 'react';
import {
  ArrowDownUp, Calendar, ChevronDown, Copy, Eye, EyeOff, Filter as FilterIcon, GanttChart, LayoutGrid, List, MoreHorizontal, Pencil,
  Plus, Search, Settings2, SquareKanban, Table2, Trash2, X, Layers, Check, FileText, GripVertical, Star,
  BarChart3, ClipboardList, LayoutDashboard, Map as MapIcon, Pin,
} from 'lucide-react';
import { ChartViewSettings, defaultChart } from './ChartView';
import { pinQuickFilter } from './QuickFilters';
import type { Database, DbView, Filter, FilterGroup, Prop, User } from '../lib/types';
import { del, patch, post, queryClient } from '../lib/api';
import { useUi } from '../lib/store';
import { MenuItem, PageIcon, Popover, toast } from '../components/ui';
import { TypeIcon, Tag } from './cells';
import {
  createRow, defaultFilter, GROUPABLE, NO_VALUE_OPS, operatorsFor, propsConfig, updateView, viewProps, DEFAULT_RELATIVE, relativeLabel, type RelativeValue,
} from './dbutil';

export const VIEW_TYPES: { type: DbView['type']; label: string; icon: any }[] = [
  { type: 'table', label: 'Table', icon: Table2 },
  { type: 'board', label: 'Board', icon: SquareKanban },
  { type: 'list', label: 'List', icon: List },
  { type: 'gallery', label: 'Gallery', icon: LayoutGrid },
  { type: 'calendar', label: 'Calendar', icon: Calendar },
  { type: 'timeline', label: 'Timeline', icon: GanttChart },
  { type: 'chart', label: 'Chart', icon: BarChart3 },
  { type: 'form', label: 'Form', icon: ClipboardList },
  { type: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { type: 'map', label: 'Map', icon: MapIcon },
];
export const ViewIcon = ({ type, size = 14 }: { type: DbView['type']; size?: number }) => {
  const I = VIEW_TYPES.find((v) => v.type === type)?.icon ?? Table2;
  return <I size={size} strokeWidth={1.8} />;
};

function defaultConfigFor(type: DbView['type'], schema: Prop[]) {
  const date = schema.find((p) => p.type === 'date');
  const group = schema.find((p) => p.type === 'status') ?? schema.find((p) => p.type === 'select');
  if (type === 'board') return { groupBy: group?.id ?? null };
  if (type === 'calendar') return { calendarBy: date?.id };
  if (type === 'timeline') return { timelineBy: date?.id };
  if (type === 'gallery') return { cardPreview: 'cover' as const, cardSize: 'medium' as const };
  if (type === 'chart') return { chart: defaultChart(schema) };
  if (type === 'form') {
    const title = schema.find((p) => p.type === 'title');
    return { form: { questions: title ? [{ propId: title.id, required: true }] : [], access: 'members' as const } };
  }
  if (type === 'dashboard') return { dashboard: { widgets: [] } };
  if (type === 'map') return { map: { placeProp: schema.find((p) => p.type === 'place')?.id ?? '' } };
  return {};
}

export function ViewTabs({ db, view, setViewId, canEdit }: { db: Database; view: DbView; setViewId: (id: string) => void; canEdit: boolean }) {
  const [addEl, setAddEl] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ v: DbView; el: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const addView = async (type: DbView['type']) => {
    setAddEl(null);
    const v = await post<DbView>(`/databases/${db.id}/views`, { type, name: VIEW_TYPES.find((x) => x.type === type)!.label, config: defaultConfigFor(type, db.schema), blockId: (db as any).blockId ?? null });
    await queryClient.invalidateQueries({ queryKey: ['db', db.id] });
    setViewId(v.id);
  };
  return (
    <div className="view-tabs">
      {db.views.map((v) => (
        <div key={v.id} className={`view-tab ${v.id === view.id ? 'active' : ''}`}
          onClick={(e) => (v.id === view.id && canEdit ? setMenu({ v, el: e.currentTarget }) : setViewId(v.id))}>
          <ViewIcon type={v.type} />
          {renaming === v.id ? (
            <input className="view-rename" autoFocus defaultValue={v.name} onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { updateView(db.id, v.id, { name: e.target.value || v.name }); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
          ) : <span>{v.name}</span>}
        </div>
      ))}
      {canEdit && <button className="view-tab add" onClick={(e) => setAddEl(e.currentTarget)}><Plus size={14} /></button>}
      {addEl && (
        <Popover anchor={addEl} open onClose={() => setAddEl(null)} width={220}>
          <div className="menu-heading">Add a view</div>
          {VIEW_TYPES.map((t) => <MenuItem key={t.type} icon={<t.icon size={14} />} onClick={() => addView(t.type)}>{t.label}</MenuItem>)}
        </Popover>
      )}
      {menu && (
        <Popover anchor={menu.el} open onClose={() => setMenu(null)} width={220}>
          <MenuItem icon={<Pencil size={14} />} onClick={() => { setRenaming(menu.v.id); setMenu(null); }}>Rename</MenuItem>
          <div className="menu-heading">Layout</div>
          {VIEW_TYPES.map((t) => (
            <MenuItem key={t.type} icon={<t.icon size={14} />} right={menu.v.type === t.type ? <Check size={14} /> : null}
              onClick={() => { updateView(db.id, menu.v.id, { type: t.type, config: { ...defaultConfigFor(t.type, db.schema), ...menu.v.config } }); setMenu(null); }}>
              {t.label}
            </MenuItem>
          ))}
          <div className="menu-sep" />
          <MenuItem icon={<Copy size={14} />} onClick={async () => {
            setMenu(null);
            const v = await post<DbView>(`/views/${menu.v.id}/duplicate`);
            await queryClient.invalidateQueries({ queryKey: ['db', db.id] });
            setViewId(v.id);
          }}>Duplicate view</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} danger disabled={db.views.length <= 1} onClick={async () => {
            setMenu(null);
            try {
              await del(`/views/${menu.v.id}`);
              await queryClient.invalidateQueries({ queryKey: ['db', db.id] });
              setViewId(db.views.find((x) => x.id !== menu.v.id)!.id);
            } catch (e: any) { toast(e.message); }
          }}>Delete view</MenuItem>
        </Popover>
      )}
    </div>
  );
}

// ---------- toolbar ----------

export function Toolbar({ db, view, search, setSearch, canEdit, users }: {
  db: Database; view: DbView; search: string; setSearch: (s: string) => void; canEdit: boolean; users: Map<string, User>;
}) {
  const [open, setOpen] = useState<{ k: string; el: HTMLElement } | null>(null);
  const [searching, setSearching] = useState(!!search);
  const close = () => setOpen(null);
  const nFilters = view.config.filter?.filters.length ?? 0;
  const nSorts = view.config.sorts?.length ?? 0;
  const groupable = ['table', 'board', 'list'].includes(view.type);
  const btn = (k: string, label: React.ReactNode, active = false) => (
    <button className={`tb-btn ${active ? 'active' : ''}`} onClick={(e) => setOpen({ k, el: e.currentTarget })}>{label}</button>
  );
  // "New" uses the database's default template (if any); the menu's "Empty page" skips it.
  const newRow = async (templateId?: string, blank = false) => {
    const r = await createRow(db.id, templateId ? { templateId } : { useDefaultTemplate: !blank });
    useUi.getState().set({ peekRowId: r.id });
  };
  const setDefaultTemplate = async (id: string | null) => {
    await patch(`/databases/${db.id}`, { defaultTemplateId: id });
    queryClient.invalidateQueries({ queryKey: ['db', db.id] });
  };
  return (
    <div className="db-toolbar">
      {btn('filter', <><FilterIcon size={14} /> Filter</>, nFilters > 0)}
      {btn('sort', <><ArrowDownUp size={14} /> Sort</>, nSorts > 0)}
      {groupable && btn('group', <><Layers size={14} /> Group</>, !!view.config.groupBy)}
      {btn('props', <><Eye size={14} /> Properties</>)}
      {searching ? (
        <div className="tb-search"><Search size={14} />
          <input autoFocus value={search} placeholder="Type to search…" onChange={(e) => setSearch(e.target.value)}
            onBlur={() => !search && setSearching(false)} onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearching(false); } }} />
          {search && <button className="icon-btn" onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
      ) : <button className="tb-btn icon" onClick={() => setSearching(true)} title="Search"><Search size={14} /></button>}
      {canEdit && btn('settings', <Settings2 size={14} />)}
      {canEdit && (
        <div className="new-btn">
          <button className="new-main" onClick={() => newRow()}>New</button>
          <button className="new-caret" onClick={(e) => setOpen({ k: 'new', el: e.currentTarget })}><ChevronDown size={14} /></button>
        </div>
      )}
      {open?.k === 'filter' && <FilterMenu db={db} view={view} anchor={open.el} onClose={close} users={users} />}
      {open?.k === 'sort' && <SortMenu db={db} view={view} anchor={open.el} onClose={close} />}
      {open?.k === 'group' && <GroupMenu db={db} view={view} anchor={open.el} onClose={close} />}
      {open?.k === 'props' && <PropsMenu db={db} view={view} anchor={open.el} onClose={close} canEdit={canEdit} />}
      {open?.k === 'settings' && <ViewSettings db={db} view={view} anchor={open.el} onClose={close} />}
      {open?.k === 'new' && (
        <Popover anchor={open.el} open onClose={close} placement="bottom-end" width={260}>
          <div className="menu-heading">Templates for {db.title || 'Untitled'}</div>
          {db.templates.map((t) => (
            <div key={t.id} className="tpl-row">
              <MenuItem icon={<PageIcon icon={t.icon} size={16} />} onClick={() => { close(); newRow(t.id); }}
                right={db.default_template_id === t.id ? <span className="tpl-default">Default</span> : undefined}>{t.title || 'Untitled'}</MenuItem>
              <button className="icon-btn" title={db.default_template_id === t.id ? 'Stop using as default' : 'Set as default'}
                onClick={() => setDefaultTemplate(db.default_template_id === t.id ? null : t.id)}>
                <Star size={13} fill={db.default_template_id === t.id ? 'currentColor' : 'none'} />
              </button>
              <button className="icon-btn" title="Edit template" onClick={() => { close(); useUi.getState().set({ peekRowId: t.id }); }}><MoreHorizontal size={14} /></button>
            </div>
          ))}
          <MenuItem icon={<FileText size={14} />} onClick={() => { close(); newRow(undefined, true); }}
            right={!db.default_template_id ? <span className="tpl-default">Default</span> : undefined}>Empty page</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={<Plus size={14} />} onClick={async () => {
            close();
            const r = await createRow(db.id, { isTemplate: true, title: 'New template' });
            useUi.getState().set({ peekRowId: r.id });
          }}>New template</MenuItem>
        </Popover>
      )}
    </div>
  );
}

/** Chips row shown below the toolbar when filters/sorts are active. */
export function FilterChips({ db, view, users, canEdit }: { db: Database; view: DbView; users: Map<string, User>; canEdit: boolean }) {
  const [open, setOpen] = useState<{ i: number | 'sort'; el: HTMLElement } | null>(null);
  const filters = view.config.filter?.filters ?? [];
  const sorts = view.config.sorts ?? [];
  if (!filters.length && !sorts.length) return null;
  return (
    <div className="filter-chips">
      {!!sorts.length && (
        <button className="chip" onClick={(e) => setOpen({ i: 'sort', el: e.currentTarget })}>
          <ArrowDownUp size={12} /> {sorts.length === 1 ? db.schema.find((p) => p.id === sorts[0].prop)?.name ?? 'Sort' : `${sorts.length} sorts`} <ChevronDown size={12} />
        </button>
      )}
      {!!sorts.length && !!filters.length && <span className="chip-sep" />}
      {filters.map((f, i) => {
        const p = db.schema.find((x) => x.id === f.prop);
        if (!p) return null;
        return (
          <button key={i} className={`chip ${hasValue(f) ? 'set' : ''}`} onClick={(e) => setOpen({ i, el: e.currentTarget })}>
            <TypeIcon type={p.type} size={12} /> {p.name}{hasValue(f) ? `: ${filterLabel(p, f, users)}` : ''} <ChevronDown size={12} />
          </button>
        );
      })}
      {open?.i === 'sort' && <SortMenu db={db} view={view} anchor={open.el} onClose={() => setOpen(null)} />}
      {typeof open?.i === 'number' && filters[open.i] && (
        <Popover anchor={open.el} open onClose={() => setOpen(null)} width={340}>
          <FilterRow db={db} filter={filters[open.i]} users={users} disabled={!canEdit}
            onChange={(f) => saveFilters(db, view, filters.map((x, j) => (j === open.i ? f : x)))}
            onRemove={() => { saveFilters(db, view, filters.filter((_, j) => j !== open.i)); setOpen(null); }} />
        </Popover>
      )}
    </div>
  );
}

const hasValue = (f: Filter) => NO_VALUE_OPS.includes(f.op) || !(f.value == null || f.value === '' || (Array.isArray(f.value) && !f.value.length));

function filterLabel(p: Prop, f: Filter, users: Map<string, User>) {
  const opLabel = operatorsFor(p.type).find(([k]) => k === f.op)?.[1] ?? f.op;
  if (NO_VALUE_OPS.includes(f.op)) return opLabel;
  if (f.op === 'within') return `Within ${relativeLabel(f.value as RelativeValue)}`;
  const vals = Array.isArray(f.value) ? f.value : [f.value];
  const names = vals.map((v: any) => {
    if (p.options) return p.options.find((o) => o.id === v)?.name ?? v;
    if (['person', 'created_by', 'last_edited_by'].includes(p.type)) return v === 'me' ? 'Me' : users.get(v)?.name ?? v;
    return String(v);
  });
  return `${['contains', 'is'].includes(f.op) ? '' : opLabel + ' '}${names.join(', ')}`;
}

function saveFilters(db: Database, view: DbView, filters: Filter[], op?: 'and' | 'or') {
  updateView(db.id, view.id, { config: { filter: { op: op ?? view.config.filter?.op ?? 'and', filters } as FilterGroup } });
}

export function FilterRow({ db, filter, onChange, onRemove, users, disabled }: {
  db: Database; filter: Filter; onChange: (f: Filter) => void; onRemove: () => void; users: Map<string, User>; disabled?: boolean;
}) {
  const p = db.schema.find((x) => x.id === filter.prop);
  if (!p) return null;
  const ops = operatorsFor(p.type);
  const val = filter.value;
  const multiVal = ['select', 'status', 'multi_select', 'person', 'created_by', 'last_edited_by'].includes(p.type);
  const toggle = (id: string) => {
    const cur: string[] = Array.isArray(val) ? val : val ? [val] : [];
    onChange({ ...filter, value: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const arr: string[] = Array.isArray(val) ? val : val ? [val] : [];
  return (
    <div className="filter-row">
      <div className="filter-row-head">
        <select className="input sm" value={p.id} disabled={disabled} onChange={(e) => onChange(defaultFilter(db.schema.find((x) => x.id === e.target.value)!))}>
          {db.schema.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className="input sm" value={filter.op} disabled={disabled} onChange={(e) => onChange({ ...filter, op: e.target.value, value: e.target.value === 'group' ? [] : e.target.value === 'within' ? DEFAULT_RELATIVE : filter.op === 'within' ? undefined : filter.value })}>
          {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {!disabled && <button className="icon-btn" onClick={onRemove} title="Delete filter"><Trash2 size={14} /></button>}
      </div>
      {!NO_VALUE_OPS.includes(filter.op) && (
        <div className="filter-value">
          {p.type === 'checkbox' ? (
            <select className="input sm" value={String(val ?? true)} disabled={disabled} onChange={(e) => onChange({ ...filter, value: e.target.value === 'true' })}>
              <option value="true">Checked</option><option value="false">Unchecked</option>
            </select>
          ) : p.type === 'status' && filter.op === 'group' ? (
            ([['todo', 'To-do'], ['in_progress', 'In progress'], ['complete', 'Complete']] as const).map(([g, l]) => (
              <MenuItem key={g} onClick={() => toggle(g)} right={arr.includes(g) ? <Check size={14} /> : null}>{l}</MenuItem>
            ))
          ) : multiVal && p.options ? (
            p.options.map((o) => (
              <div key={o.id} className="opt-row" onClick={() => !disabled && toggle(o.id)}>
                <Tag option={o} status={p.type === 'status'} />{arr.includes(o.id) && <Check size={14} className="faint" style={{ marginLeft: 'auto' }} />}
              </div>
            ))
          ) : multiVal ? (
            [{ id: 'me', name: 'Me' } as User, ...users.values()].map((u) => (
              <MenuItem key={u.id} onClick={() => !disabled && toggle(u.id)} right={arr.includes(u.id) ? <Check size={14} /> : null}>{u.name}</MenuItem>
            ))
          ) : ['date', 'created_time', 'last_edited_time'].includes(p.type) && filter.op === 'within' ? (
            <RelativeEditor value={(val as RelativeValue) ?? DEFAULT_RELATIVE} disabled={disabled} onChange={(v) => onChange({ ...filter, value: v })} />
          ) : ['date', 'created_time', 'last_edited_time'].includes(p.type) ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <select className="input sm" disabled={disabled}
                value={['today', 'tomorrow', 'yesterday', 'one_week_ago', 'one_week_from_now', 'one_month_ago', 'one_month_from_now'].includes(val) ? val : 'exact'}
                onChange={(e) => onChange({ ...filter, value: e.target.value === 'exact' ? new Date().toISOString().slice(0, 10) : e.target.value })}>
                <option value="exact">Exact date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option>
                <option value="yesterday">Yesterday</option><option value="one_week_ago">One week ago</option>
                <option value="one_week_from_now">One week from now</option><option value="one_month_ago">One month ago</option>
                <option value="one_month_from_now">One month from now</option>
              </select>
              {/^\d{4}-/.test(val ?? '') && <input className="input sm" type="date" value={val} disabled={disabled} onChange={(e) => onChange({ ...filter, value: e.target.value })} />}
            </div>
          ) : (
            <input className="input sm" autoFocus placeholder="Type a value…" value={val ?? ''} disabled={disabled}
              type={['number', 'unique_id'].includes(p.type) ? 'number' : 'text'}
              onChange={(e) => onChange({ ...filter, value: e.target.value })} />
          )}
        </div>
      )}
    </div>
  );
}

function FilterMenu({ db, view, anchor, onClose, users }: { db: Database; view: DbView; anchor: HTMLElement; onClose: () => void; users: Map<string, User> }) {
  const filters = view.config.filter?.filters ?? [];
  const op = view.config.filter?.op ?? 'and';
  const [adding, setAdding] = useState(!filters.length);
  return (
    <Popover anchor={anchor} open onClose={onClose} width={360}>
      {adding ? (
        <>
          <div className="menu-heading">Filter by</div>
          {db.schema.map((p) => (
            <MenuItem key={p.id} icon={<TypeIcon type={p.type} />} onClick={() => { saveFilters(db, view, [...filters, defaultFilter(p)]); setAdding(false); }}>{p.name}</MenuItem>
          ))}
        </>
      ) : (
        <>
          {filters.map((f, i) => (
            <div key={i} className="filter-block">
              <div className="filter-conj">
                {i === 0 ? 'Where' : i === 1 ? (
                  <select className="input sm" value={op} onChange={(e) => saveFilters(db, view, filters, e.target.value as 'and' | 'or')}>
                    <option value="and">And</option><option value="or">Or</option>
                  </select>
                ) : op === 'and' ? 'And' : 'Or'}
              </div>
              <FilterRow db={db} filter={f} users={users}
                onChange={(nf) => saveFilters(db, view, filters.map((x, j) => (j === i ? nf : x)))}
                onRemove={() => saveFilters(db, view, filters.filter((_, j) => j !== i))} />
              <button className="link-btn pin-qf" title="Show this filter as a toggle above the view" onClick={() => { pinQuickFilter(db, view, f); saveFilters(db, view, filters.filter((_, j) => j !== i)); toast('Pinned as a quick filter'); }}>
                <Pin size={12} /> Pin as quick filter
              </button>
            </div>
          ))}
          <MenuItem icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add filter rule</MenuItem>
          {!!filters.length && <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { saveFilters(db, view, []); onClose(); }}>Delete filters</MenuItem>}
        </>
      )}
    </Popover>
  );
}

function SortMenu({ db, view, anchor, onClose }: { db: Database; view: DbView; anchor: HTMLElement; onClose: () => void }) {
  const sorts = view.config.sorts ?? [];
  const [adding, setAdding] = useState(!sorts.length);
  const save = (s: typeof sorts) => updateView(db.id, view.id, { config: { sorts: s } });
  return (
    <Popover anchor={anchor} open onClose={onClose} width={360}>
      {adding ? (
        <>
          <div className="menu-heading">Sort by</div>
          {db.schema.filter((p) => !sorts.some((s) => s.prop === p.id)).map((p) => (
            <MenuItem key={p.id} icon={<TypeIcon type={p.type} />} onClick={() => { save([...sorts, { prop: p.id, dir: 'asc' }]); setAdding(false); }}>{p.name}</MenuItem>
          ))}
        </>
      ) : (
        <>
          {sorts.map((s, i) => (
            <div key={i} className="sort-row">
              <GripVertical size={14} className="faint" />
              <select className="input sm" value={s.prop} onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, prop: e.target.value } : x)))}>
                {db.schema.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select className="input sm" value={s.dir} onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))}>
                <option value="asc">Ascending</option><option value="desc">Descending</option>
              </select>
              <button className="icon-btn" onClick={() => save(sorts.filter((_, j) => j !== i))}><X size={14} /></button>
            </div>
          ))}
          <MenuItem icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add sort</MenuItem>
          {!!sorts.length && <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { save([]); onClose(); }}>Delete sort</MenuItem>}
        </>
      )}
    </Popover>
  );
}

function GroupMenu({ db, view, anchor, onClose }: { db: Database; view: DbView; anchor: HTMLElement; onClose: () => void }) {
  const cur = view.config.groupBy;
  return (
    <Popover anchor={anchor} open onClose={onClose} width={260}>
      <div className="menu-heading">Group by</div>
      {view.type !== 'board' && (
        <MenuItem onClick={() => { updateView(db.id, view.id, { config: { groupBy: null } }); onClose(); }} right={!cur ? <Check size={14} /> : null}>None</MenuItem>
      )}
      {db.schema.filter((p) => GROUPABLE.includes(p.type)).map((p) => (
        <MenuItem key={p.id} icon={<TypeIcon type={p.type} />} right={cur === p.id ? <Check size={14} /> : null}
          onClick={() => { updateView(db.id, view.id, { config: { groupBy: p.id, hiddenGroups: [] } }); onClose(); }}>{p.name}</MenuItem>
      ))}
    </Popover>
  );
}

function PropsMenu({ db, view, anchor, onClose, canEdit }: { db: Database; view: DbView; anchor: HTMLElement; onClose: () => void; canEdit: boolean }) {
  const list = viewProps(db.schema, view);
  const [drag, setDrag] = useState<number | null>(null);
  const save = (l: typeof list) => updateView(db.id, view.id, { config: { properties: propsConfig(l) } });
  const toggle = (id: string) => save(list.map((x) => (x.prop.id === id && x.prop.type !== 'title' ? { ...x, visible: !x.visible } : x)));
  const anyHidden = list.some((x) => !x.visible);
  return (
    <Popover anchor={anchor} open onClose={onClose} width={290}>
      <div className="menu-heading" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Properties</span>
        {canEdit && <button className="link-btn" style={{ fontSize: 12 }} onClick={() => save(list.map((x) => ({ ...x, visible: anyHidden || x.prop.type === 'title' })))}>{anyHidden ? 'Show all' : 'Hide all'}</button>}
      </div>
      {list.map((x, i) => (
        <div key={x.prop.id} className="prop-vis-row" draggable={canEdit}
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag == null || drag === i) return;
            const l = [...list];
            const [m] = l.splice(drag, 1);
            l.splice(i, 0, m);
            save(l);
            setDrag(null);
          }}>
          <GripVertical size={14} className="faint" />
          <TypeIcon type={x.prop.type} />
          <span style={{ flex: 1 }}>{x.prop.name}</span>
          {x.prop.type !== 'title' && canEdit && (
            <button className="icon-btn" onClick={() => toggle(x.prop.id)}>{x.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          )}
        </div>
      ))}
    </Popover>
  );
}

function ViewSettings({ db, view, anchor, onClose }: { db: Database; view: DbView; anchor: HTMLElement; onClose: () => void }) {
  const set = (config: any) => updateView(db.id, view.id, { config });
  const dates = db.schema.filter((p) => ['date', 'created_time', 'last_edited_time'].includes(p.type));
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="bottom-end" width={view.type === 'chart' ? 340 : 280}>
      <div className="menu-heading">View options</div>
      <div className="vs-row"><span>Layout</span>
        <select className="input sm" value={view.type} onChange={(e) => updateView(db.id, view.id, { type: e.target.value, config: { ...defaultConfigFor(e.target.value as any, db.schema), ...view.config } })}>
          {VIEW_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </div>
      {view.type === 'chart' && <ChartViewSettings db={db} view={view} />}
      {view.type === 'map' && (
        <div className="vs-row"><span>Show map by</span>
          <select className="input sm" value={view.config.map?.placeProp ?? ''} onChange={(e) => set({ map: { placeProp: e.target.value } })}>
            <option value="">—</option>
            {db.schema.filter((p) => p.type === 'place').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {view.type === 'calendar' && (
        <div className="vs-row"><span>Show calendar by</span>
          <select className="input sm" value={view.config.calendarBy ?? ''} onChange={(e) => set({ calendarBy: e.target.value })}>
            {dates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {view.type === 'timeline' && (
        <div className="vs-row"><span>Show timeline by</span>
          <select className="input sm" value={view.config.timelineBy ?? ''} onChange={(e) => set({ timelineBy: e.target.value })}>
            {dates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {view.type === 'gallery' && (
        <>
          <div className="vs-row"><span>Card preview</span>
            <select className="input sm" value={view.config.cardPreview ?? 'cover'} onChange={(e) => set({ cardPreview: e.target.value })}>
              <option value="none">None</option><option value="cover">Page cover</option>
            </select>
          </div>
          <div className="vs-row"><span>Card size</span>
            <select className="input sm" value={view.config.cardSize ?? 'medium'} onChange={(e) => set({ cardSize: e.target.value })}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </select>
          </div>
        </>
      )}
      {view.type === 'board' && (
        <div className="vs-row"><span>Card preview</span>
          <select className="input sm" value={view.config.cardPreview ?? 'none'} onChange={(e) => set({ cardPreview: e.target.value })}>
            <option value="none">None</option><option value="cover">Page cover</option>
          </select>
        </div>
      )}
      <div className="vs-row"><span>Wrap all content</span>
        <input type="checkbox" checked={!!view.config.wrap} onChange={(e) => set({ wrap: e.target.checked })} />
      </div>
      <div className="vs-row"><span>Open pages in</span>
        <select className="input sm" value={view.config.openIn ?? 'side'} onChange={(e) => set({ openIn: e.target.value })}>
          <option value="side">Side peek</option><option value="full">Full page</option>
        </select>
      </div>
    </Popover>
  );
}

/** "Is within": past/next N days|weeks|months|years, or this week|month|year (Notion's relative date filter). */
function RelativeEditor({ value, onChange, disabled }: { value: RelativeValue; onChange: (v: RelativeValue) => void; disabled?: boolean }) {
  const units: RelativeValue['unit'][] = ['day', 'week', 'month', 'year'];
  return (
    <div className="rel-editor">
      <select className="input sm" value={value.direction} disabled={disabled}
        onChange={(e) => {
          const direction = e.target.value as RelativeValue['direction'];
          onChange(direction === 'this' ? { direction, unit: value.unit === 'day' ? 'week' : value.unit } : { direction, unit: value.unit, count: value.count ?? 1 });
        }}>
        <option value="past">Past</option><option value="next">Next</option><option value="this">This</option>
      </select>
      {value.direction !== 'this' && (
        <input className="input sm rel-count" type="number" min={1} max={3650} value={value.count ?? 1} disabled={disabled}
          onChange={(e) => onChange({ ...value, count: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) })} />
      )}
      <select className="input sm" value={value.unit} disabled={disabled} onChange={(e) => onChange({ ...value, unit: e.target.value as RelativeValue['unit'] })}>
        {units.filter((u) => value.direction !== 'this' || u !== 'day').map((u) => (
          <option key={u} value={u}>{value.direction === 'this' ? u : `${u}${(value.count ?? 1) === 1 ? '' : 's'}`}</option>
        ))}
      </select>
    </div>
  );
}
