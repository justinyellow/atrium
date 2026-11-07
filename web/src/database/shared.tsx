import { useState } from 'react';
import { Copy, ExternalLink, GripVertical, PanelRight, Trash2 } from 'lucide-react';
import type { Database, DbView, Row, User } from '../lib/types';
import { del, post, queryClient } from '../lib/api';
import { MenuItem, Popover, toast } from '../components/ui';

export interface ViewProps {
  db: Database;
  view: DbView;
  rows: Row[];
  titles: Record<string, string>;
  users: Map<string, User>;
  canEdit: boolean;
  openRow: (id: string, mode?: 'side' | 'full') => void;
  sorted: boolean;
  /** Current toolbar search text (chart/dashboard views query the server with it). */
  search?: string;
}

export async function deleteRow(dbId: string, rowId: string) {
  await del(`/pages/${rowId}`);
  queryClient.invalidateQueries({ queryKey: ['dbq', dbId] });
  toast('Moved to trash');
}
export async function duplicateRow(dbId: string, rowId: string) {
  await post(`/pages/${rowId}/duplicate`);
  queryClient.invalidateQueries({ queryKey: ['dbq', dbId] });
}

export function RowMenuButton({ db, row, openRow, dragProps }: { db: Database; row: Row; openRow: ViewProps['openRow']; dragProps?: any }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className="row-handle" onClick={(e) => { e.stopPropagation(); setEl(e.currentTarget); }} {...dragProps}>
        <GripVertical size={14} />
      </button>
      {el && (
        <Popover anchor={el} open onClose={() => setEl(null)} width={220}>
          <MenuItem icon={<PanelRight size={14} />} onClick={() => { setEl(null); openRow(row.id, 'side'); }}>Open in side peek</MenuItem>
          <MenuItem icon={<ExternalLink size={14} />} onClick={() => { setEl(null); openRow(row.id, 'full'); }}>Open as full page</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={<Copy size={14} />} onClick={() => { setEl(null); duplicateRow(db.id, row.id); }}>Duplicate</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { setEl(null); deleteRow(db.id, row.id); }}>Delete</MenuItem>
        </Popover>
      )}
    </>
  );
}

export async function reorderRows(dbId: string, allRows: Row[], dragId: string, targetId: string, after: boolean) {
  const ids = allRows.map((r) => r.id).filter((id) => id !== dragId);
  const i = ids.indexOf(targetId);
  ids.splice(after ? i + 1 : i, 0, dragId);
  queryClient.setQueriesData<any>({ queryKey: ['dbq', dbId] }, (old: any) => {
    if (!old?.rows) return old;
    const byId = new Map(old.rows.map((r: Row) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = old.rows.filter((r: Row) => !ids.includes(r.id));
    return { ...old, rows: [...ordered, ...rest] };
  });
  await post(`/databases/${dbId}/rows/reorder`, { order: ids });
}
