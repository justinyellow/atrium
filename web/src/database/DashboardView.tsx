import { useMemo, useRef, useState } from 'react';
import { GripHorizontal, LayoutDashboard, MoreHorizontal, Pencil, Plus, Trash2, Check, Filter as FilterIcon } from 'lucide-react';
import type { ChartConfig, DashboardWidget, Database, DbView, Filter } from '../lib/types';
import { MenuItem, Popover } from '../components/ui';
import { defaultFilter, effectiveFilter, shortId, updateView, useDbQuery } from './dbutil';
import { ChartRender, ChartSettings, defaultChart, useAggregate } from './ChartView';
import { FilterRow } from './Toolbar';
import { TableView } from './TableView';
import { BoardView } from './BoardView';
import { ListView } from './OtherViews';
import type { ViewProps } from './shared';

const ROW_H = 64;
const COLS = 12;
const KIND_LABEL: Record<DashboardWidget['kind'], string> = { chart: 'Chart', number: 'Number', table: 'Table', list: 'List', board: 'Board' };

function widgetFilter(view: DbView, w: DashboardWidget) {
  const own = w.viewConfig.filter?.filters?.length ? [w.viewConfig.filter as any] : [];
  const base = view.config.filter;
  if (!own.length) return base;
  return { op: 'and', filters: [...(base && (base as any).filters?.length ? [base] : []), ...own] };
}

function WidgetBody({ vp, w, height }: { vp: ViewProps; w: DashboardWidget; height: number }) {
  const { db, view } = vp;
  const filter = widgetFilter(view, w);
  if (w.kind === 'chart' || w.kind === 'number') {
    const chart: ChartConfig = w.kind === 'number' ? { ...(w.viewConfig.chart ?? { aggregate: { fn: 'count' } }), kind: 'number' } as ChartConfig : w.viewConfig.chart ?? defaultChart(db.schema);
    return <WidgetChart dbId={db.id} chart={chart} filter={filter} schema={db.schema} height={height} search={vp.search} />;
  }
  return <WidgetRows vp={vp} w={w} filter={filter} />;
}

function WidgetChart({ dbId, chart, filter, schema, height, search }: { dbId: string; chart: ChartConfig; filter: any; schema: Database['schema']; height: number; search?: string }) {
  const { data } = useAggregate(dbId, undefined, chart, filter, search);
  if (!data) return <div className="db-loading"><div className="spinner" /></div>;
  return <ChartRender data={data} cfg={chart} schema={schema} height={Math.max(120, height)} compact />;
}

function WidgetRows({ vp, w, filter }: { vp: ViewProps; w: DashboardWidget; filter: any }) {
  // Embedded views are read-only (their layout belongs to the widget, not a saved view).
  const pseudo: DbView = useMemo(() => ({ ...vp.view, id: `${vp.view.id}:${w.id}`, type: w.kind as DbView['type'], config: { ...w.viewConfig, filter } }), [vp.view, w, filter]);
  const { data } = useDbQuery(vp.db.id, pseudo, vp.search ?? '');
  const rows = (data?.rows ?? []).slice(0, w.viewConfig.limit ?? 100);
  const props: ViewProps = { ...vp, view: pseudo, rows, canEdit: false, sorted: true };
  const V = w.kind === 'board' ? BoardView : w.kind === 'list' ? ListView : TableView;
  return <div className="widget-rows"><V {...props} /></div>;
}

function WidgetEditor({ db, w, anchor, onClose, onSave }: { db: Database; w: DashboardWidget; anchor: HTMLElement; onClose: () => void; onSave: (w: DashboardWidget) => void }) {
  const [draft, setDraft] = useState<DashboardWidget>(w);
  const filters: Filter[] = (draft.viewConfig.filter?.filters as Filter[]) ?? [];
  const setFilters = (f: Filter[]) => setDraft({ ...draft, viewConfig: { ...draft.viewConfig, filter: { op: 'and', filters: f } } });
  const close = () => { onSave(draft); onClose(); };
  return (
    <Popover anchor={anchor} open onClose={close} width={340} placement="bottom-end">
      <div className="menu-heading">Widget</div>
      <input className="input sm" placeholder="Title" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value || undefined })} />
      <div className="vs-row"><span>Type</span>
        <select className="input sm" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as DashboardWidget['kind'] })}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {(draft.kind === 'chart' || draft.kind === 'number') && (
        <ChartSettings schema={db.schema} value={{ ...(draft.viewConfig.chart ?? defaultChart(db.schema)), ...(draft.kind === 'number' ? { kind: 'number' as const } : {}) }}
          onChange={(chart) => setDraft({ ...draft, kind: chart.kind === 'number' ? 'number' : draft.kind === 'number' ? 'chart' : draft.kind, viewConfig: { ...draft.viewConfig, chart } })} />
      )}
      {draft.kind === 'board' && (
        <div className="vs-row"><span>Group by</span>
          <select className="input sm" value={draft.viewConfig.groupBy ?? ''} onChange={(e) => setDraft({ ...draft, viewConfig: { ...draft.viewConfig, groupBy: e.target.value || null } })}>
            {db.schema.filter((p) => ['select', 'status', 'person', 'checkbox', 'multi_select'].includes(p.type)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="menu-heading"><FilterIcon size={12} /> Filters</div>
      {filters.map((f, i) => (
        <FilterRow key={i} db={db} filter={f} users={new Map()} onChange={(nf) => setFilters(filters.map((x, j) => (j === i ? nf : x)))} onRemove={() => setFilters(filters.filter((_, j) => j !== i))} />
      ))}
      <select className="input sm" value="" aria-label="Add filter" onChange={(e) => { const p = db.schema.find((x) => x.id === e.target.value); if (p) setFilters([...filters, defaultFilter(p)]); }}>
        <option value="">+ Add filter…</option>
        {db.schema.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button className="btn sm primary" onClick={close}><Check size={13} /> Done</button></div>
    </Popover>
  );
}

export function DashboardView(vp: ViewProps) {
  const { db, view, canEdit } = vp;
  const widgets = view.config.dashboard?.widgets ?? [];
  const gridRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [edit, setEdit] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'resize'; dx: number; dy: number } | null>(null);
  const save = (list: DashboardWidget[]) => updateView(db.id, view.id, { config: { dashboard: { widgets: list } } });
  const rowsUsed = Math.max(4, ...widgets.map((w) => w.y + w.h)) + (editing ? 4 : 0);

  const addWidget = (kind: DashboardWidget['kind']) => {
    const y = Math.max(0, ...widgets.map((w) => w.y + w.h));
    const w: DashboardWidget = {
      id: shortId(), kind, x: 0, y, w: kind === 'number' ? 3 : 6, h: kind === 'number' ? 2 : 5,
      viewConfig: kind === 'chart' ? { chart: defaultChart(db.schema) } : kind === 'number' ? { chart: { kind: 'number', aggregate: { fn: 'count' } } } : kind === 'board' ? { groupBy: db.schema.find((p) => p.type === 'status' || p.type === 'select')?.id ?? null } : {},
    };
    save([...widgets, w]);
  };

  const onPointerDown = (e: React.PointerEvent, w: DashboardWidget, mode: 'move' | 'resize') => {
    if (!editing) return;
    e.preventDefault();
    const grid = gridRef.current!;
    const colW = grid.clientWidth / COLS;
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => setDrag({ id: w.id, mode, dx: Math.round((ev.clientX - start.x) / colW), dy: Math.round((ev.clientY - start.y) / ROW_H) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const dx = Math.round((ev.clientX - start.x) / colW), dy = Math.round((ev.clientY - start.y) / ROW_H);
      setDrag(null);
      if (!dx && !dy) return;
      save(widgets.map((x) => (x.id !== w.id ? x : mode === 'move'
        ? { ...x, x: Math.max(0, Math.min(COLS - x.w, x.x + dx)), y: Math.max(0, x.y + dy) }
        : { ...x, w: Math.max(2, Math.min(COLS - x.x, x.w + dx)), h: Math.max(2, x.h + dy) })));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const keyMove = (e: React.KeyboardEvent, w: DashboardWidget) => {
    if (!editing) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    save(widgets.map((x) => (x.id !== w.id ? x : e.shiftKey
      ? { ...x, w: Math.max(2, Math.min(COLS - x.x, x.w + v[0])), h: Math.max(2, x.h + v[1]) }
      : { ...x, x: Math.max(0, Math.min(COLS - x.w, x.x + v[0])), y: Math.max(0, x.y + v[1]) })));
  };

  return (
    <div className={`dashboard ${editing ? 'editing' : ''}`}>
      {canEdit && (
        <div className="dash-bar">
          <button className={`btn sm ${editing ? 'primary' : ''}`} onClick={() => setEditing(!editing)}>{editing ? <><Check size={13} /> Done</> : <><Pencil size={13} /> Edit dashboard</>}</button>
          {editing && Object.entries(KIND_LABEL).map(([k, l]) => <button key={k} className="btn sm" onClick={() => addWidget(k as DashboardWidget['kind'])}><Plus size={13} /> {l}</button>)}
          {editing && <span className="faint" style={{ fontSize: 12 }}>Drag a widget's header to move it, its corner to resize (or focus it and use arrow keys, Shift+arrows to resize).</span>}
        </div>
      )}
      {!widgets.length ? (
        <div className="empty-state"><LayoutDashboard size={28} /><div>No widgets yet.{canEdit ? ' Click “Edit dashboard” to add charts, numbers and lists.' : ''}</div></div>
      ) : (
        <div className="dash-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridAutoRows: ROW_H, minHeight: rowsUsed * ROW_H }}>
          {widgets.map((w) => {
            const d = drag?.id === w.id ? drag : null;
            const x = d?.mode === 'move' ? Math.max(0, Math.min(COLS - w.w, w.x + d.dx)) : w.x;
            const y = d?.mode === 'move' ? Math.max(0, w.y + d.dy) : w.y;
            const ww = d?.mode === 'resize' ? Math.max(2, Math.min(COLS - w.x, w.w + d.dx)) : w.w;
            const hh = d?.mode === 'resize' ? Math.max(2, w.h + d.dy) : w.h;
            return (
              <section key={w.id} className={`dash-widget ${d ? 'dragging' : ''}`} tabIndex={editing ? 0 : -1} onKeyDown={(e) => keyMove(e, w)}
                style={{ gridColumn: `${x + 1} / span ${ww}`, gridRow: `${y + 1} / span ${hh}` }} aria-label={w.title || KIND_LABEL[w.kind]}>
                <header className="dash-widget-head" onPointerDown={(e) => onPointerDown(e, w, 'move')}>
                  {editing && <GripHorizontal size={14} className="faint" />}
                  <span className="dash-widget-title">{w.title || KIND_LABEL[w.kind]}</span>
                  {canEdit && <button className="icon-btn" aria-label="Widget options" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => setMenu({ id: w.id, el: e.currentTarget })}><MoreHorizontal size={14} /></button>}
                </header>
                <div className="dash-widget-body"><WidgetBody vp={vp} w={w} height={hh * ROW_H - 48} /></div>
                {editing && <div className="dash-resize" onPointerDown={(e) => onPointerDown(e, w, 'resize')} aria-hidden />}
              </section>
            );
          })}
        </div>
      )}
      {menu && (
        <Popover anchor={menu.el} open onClose={() => setMenu(null)} width={200}>
          <MenuItem icon={<Pencil size={14} />} onClick={() => { setEdit(menu); setMenu(null); }}>Edit widget</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { save(widgets.filter((x) => x.id !== menu.id)); setMenu(null); }}>Remove widget</MenuItem>
        </Popover>
      )}
      {edit && (() => {
        const w = widgets.find((x) => x.id === edit.id);
        return w ? <WidgetEditor db={db} w={w} anchor={edit.el} onClose={() => setEdit(null)} onSave={(nw) => save(widgets.map((x) => (x.id === nw.id ? nw : x)))} /> : null;
      })()}
    </div>
  );
}

export { effectiveFilter };
