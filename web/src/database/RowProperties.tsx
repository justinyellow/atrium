import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Page, Prop, QueryResult, Row } from '../lib/types';
import { post } from '../lib/api';
import { useDatabase, useUserMap } from '../lib/hooks';
import './database.css';
import { EditableCell, TypeIcon } from './cells';
import { AddPropertyButton, PropertySettings } from './PropertyMenu';
import { isEmptyValue, rowValue } from './dbutil';

const rank = { none: 0, view: 1, comment: 2, edit: 3, full: 4 } as const;

/** Notion-style property list at the top of a database row page. */
export function RowProperties({ page }: { page: Page }) {
  const dbId = page.parent_id!;
  const isRow = page.kind === 'row' && !!dbId;
  const { data: db } = useDatabase(isRow ? dbId : undefined);
  const users = useUserMap();
  const canEdit = rank[page.level] >= rank.edit;
  const [editProp, setEditProp] = useState<{ prop: Prop; el: HTMLElement } | null>(null);
  const [showEmpty, setShowEmpty] = useState(true);
  // Query the parent DB for computed values (formula/rollup) and relation titles.
  const { data: q } = useQuery({
    queryKey: ['dbq', dbId, 'row', page.id],
    queryFn: () => post<QueryResult>(`/databases/${dbId}/query`, { templates: page.is_template || undefined }),
    enabled: isRow,
  });
  const row: Row = useMemo(() => {
    const fromQ = q?.rows.find((r) => r.id === page.id);
    return {
      position: 0,
      ...(fromQ ?? {}),
      id: page.id, title: page.title, icon: page.icon, cover: page.cover,
      created_at: page.created_at, updated_at: page.updated_at, created_by: page.created_by, updated_by: page.updated_by,
      props: { ...(fromQ?.props ?? {}), ...page.props },
      computed: fromQ?.computed ?? {},
    };
  }, [q, page]);
  const schema = db?.schema ?? page.parent_schema ?? [];
  if (!isRow || !schema.length) return null;
  const titles = q?.titles ?? {};
  const props = schema.filter((p) => p.type !== 'title');
  const empty = props.filter((p) => isEmptyValue(rowValue(row, p)) && p.type !== 'checkbox');
  const shown = showEmpty ? props : props.filter((p) => !empty.includes(p));

  return (
    <div className="row-props">
      {page.is_template && <div className="tpl-banner">You're editing a template in <b>{db?.title || 'this database'}</b>.</div>}
      {shown.map((p) => (
        <div key={p.id} className="rp-row">
          <button className="rp-name" onClick={(e) => canEdit && setEditProp({ prop: p, el: e.currentTarget })}>
            <TypeIcon type={p.type} /> <span>{p.name}</span>
          </button>
          <EditableCell dbId={dbId} row={row} prop={p} users={users} titles={titles} canEdit={canEdit} wrap className="rp-value">
            {isEmptyValue(rowValue(row, p)) && p.type !== 'checkbox' ? <span className="faint">Empty</span> : undefined}
          </EditableCell>
        </div>
      ))}
      {!!empty.length && (
        <button className="add-prop-btn" onClick={() => setShowEmpty((s) => !s)}>
          {showEmpty ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {showEmpty ? 'Hide empty properties' : `${empty.length} more properties`}
        </button>
      )}
      {canEdit && <AddPropertyButton dbId={dbId} label="Add a property" />}
      {editProp && db && (
        <PropertySettings dbId={dbId} schema={db.schema} prop={db.schema.find((x) => x.id === editProp.prop.id) ?? editProp.prop}
          anchor={editProp.el} onClose={() => setEditProp(null)} />
      )}
    </div>
  );
}
