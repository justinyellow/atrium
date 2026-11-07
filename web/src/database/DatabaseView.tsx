import { useEffect, useMemo, useRef, useState } from 'react';
import { patch, queryClient } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { useUserMap } from '../lib/hooks';
import { useUi } from '../lib/store';
import './database.css';
import { useDbMeta, useDbQuery } from './dbutil';
import { FilterChips, Toolbar, ViewTabs } from './Toolbar';
import { TableView } from './TableView';
import { BoardView } from './BoardView';
import { CalendarView, GalleryView, ListView, TimelineView } from './OtherViews';
import { ChartView } from './ChartView';
import { FormView } from './FormView';
import { DashboardView } from './DashboardView';
import { MapView } from './MapView';
import { QuickFilterBar, useQuickFilterState } from './QuickFilters';
import { effectiveFilter } from './dbutil';
import type { ViewProps } from './shared';

const rank = { none: 0, view: 1, comment: 2, edit: 3, full: 4 } as const;

function useStoredView(dbId: string, blockId?: string | null) {
  const key = `atrium:view:${dbId}${blockId ? `:${blockId}` : ''}`;
  const [id, setId] = useState<string | null>(() => {
    try { return localStorage.getItem(key); } catch { return null; }
  });
  const set = (v: string) => {
    setId(v);
    try { localStorage.setItem(key, v); } catch {}
  };
  return [id, set] as const;
}

/**
 * Renders a database's views. `inline` = embedded in a page (compact, scrolls inside a fixed height).
 * `blockId` = a linked-database block: uses that block's own views instead of the database's.
 */
export function DatabaseView({ databaseId, inline, blockId }: { databaseId: string; inline?: boolean; blockId?: string | null }) {
  const { data: db, error } = useDbMeta(databaseId, blockId);
  const [viewId, setViewId] = useStoredView(databaseId, blockId);
  const [search, setSearch] = useState('');
  const users = useUserMap();
  const navigate = useNavigate();
  const view = db?.views.find((v) => v.id === viewId) ?? db?.views[0];
  const quick = useQuickFilterState(view);
  const filter = view ? effectiveFilter(view, quick.filters) : undefined;
  // Views render against the effective filter (saved filter + active quick filters); toolbars edit the saved view.
  const effView = useMemo(() => (view ? { ...view, config: { ...view.config, filter } } : undefined), [view, JSON.stringify(filter)]); // eslint-disable-line react-hooks/exhaustive-deps
  const serverAggregated = view?.type === 'chart' || view?.type === 'dashboard' || view?.type === 'form';
  const { data, isLoading } = useDbQuery(databaseId, serverAggregated ? undefined : view, search, filter ?? null);

  useEffect(() => {
    if (db && view && view.id !== viewId) setViewId(view.id);
  }, [db, view?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const titles = useMemo(() => {
    const m: Record<string, string> = { ...(data?.titles ?? {}) };
    for (const r of data?.rows ?? []) m[r.id] = r.title;
    return m;
  }, [data]);

  if (error) return <div className="empty-state">Couldn't load this database.</div>;
  if (!db || !view) return <div className="db-loading"><div className="spinner" /></div>;

  const canEdit = rank[db.level as keyof typeof rank] >= rank.edit;
  const openRow: ViewProps['openRow'] = (id, mode) => {
    const m = mode ?? view.config.openIn ?? 'side';
    if (m === 'full') navigate(`/p/${id}`);
    else useUi.getState().set({ peekRowId: id });
  };
  const vp: ViewProps = {
    db, view: effView ?? view, rows: data?.rows ?? [], titles, users, canEdit, openRow,
    sorted: !!view.config.sorts?.length, search,
  };
  const View = {
    table: TableView, board: BoardView, list: ListView, gallery: GalleryView, calendar: CalendarView, timeline: TimelineView,
    chart: ChartView, form: FormView, dashboard: DashboardView, map: MapView,
  }[view.type] ?? TableView;

  return (
    <div className={`database ${inline ? 'inline' : ''}`}>
      {!blockId && <DbDescription dbId={db.id} value={db.description ?? ''} canEdit={canEdit} />}
      <div className="db-bar">
        <ViewTabs db={db} view={view} setViewId={setViewId} canEdit={canEdit} />
        <Toolbar db={db} view={view} search={search} setSearch={setSearch} canEdit={canEdit} users={users} />
      </div>
      <FilterChips db={db} view={view} users={users} canEdit={canEdit} />
      <QuickFilterBar db={db} view={view} users={users} state={quick} canEdit={canEdit} />
      <div className={`db-content ${isLoading ? 'loading' : ''}`}>
        <View {...vp} />
      </div>
    </div>
  );
}

/** Database description shown under the title (Notion's "Show description"). Saves on blur. */
function DbDescription({ dbId, value, canEdit }: { dbId: string; value: string; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.textContent = value;
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  if (!value && !editing) {
    return canEdit ? <button className="db-desc-add" onClick={() => setEditing(true)}>Add a description</button> : null;
  }
  const save = async () => {
    const next = (ref.current?.textContent ?? '').trim();
    setEditing(false);
    if (next === value) return;
    await patch(`/databases/${dbId}`, { description: next || null });
    queryClient.invalidateQueries({ queryKey: ['db', dbId] });
  };
  return (
    <div
      ref={ref}
      className="db-desc"
      contentEditable={canEdit}
      suppressContentEditableWarning
      data-placeholder="Add a description…"
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLElement).blur(); }
        if (e.key === 'Escape') { if (ref.current) ref.current.textContent = value; (e.target as HTMLElement).blur(); }
      }}
    />
  );
}
