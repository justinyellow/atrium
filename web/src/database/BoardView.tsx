import { useState } from 'react';
import { EyeOff, MoreHorizontal, Plus, Eye } from 'lucide-react';
import type { Prop, Row } from '../lib/types';
import { MenuItem, PageIcon, Popover } from '../components/ui';
import { CellValue } from './cells';
import { canGroupWrite, createRow, GROUPABLE, groupRows, groupValue, isEmptyValue, rowValue, setRowValue, updateView, viewProps } from './dbutil';
import { SubpageCount, reorderRows, type ViewProps } from './shared';
import { GroupLabel } from './TableView';

export function Card({ vp, row, showCover }: { vp: ViewProps; row: Row; showCover?: boolean }) {
  const { db, view, users, titles, openRow } = vp;
  const props = viewProps(db.schema, view).filter((x) => x.visible && x.prop.type !== 'title');
  return (
    <div className="card" onClick={() => openRow(row.id)}>
      {showCover && row.cover && <div className="card-cover" style={coverStyle(row.cover)} />}
      <div className="card-body">
        <div className="card-title">
          {row.icon && <PageIcon icon={row.icon} size={16} />}
          <span>{row.title || <span className="faint">Untitled</span>}</span>
          <SubpageCount n={row.subpages} />
        </div>
        {props.map((x) => isEmptyValue(rowValue(row, x.prop)) && x.prop.type !== 'checkbox' ? null : (
          <div key={x.prop.id} className="card-prop"><CellValue prop={x.prop} row={row} users={users} titles={titles} wrap /></div>
        ))}
      </div>
    </div>
  );
}

export function coverStyle(cover: string): React.CSSProperties {
  if (cover.startsWith('/') || cover.startsWith('http')) return { backgroundImage: `url("${cover}")` };
  return { background: cover };
}

export function BoardView(vp: ViewProps) {
  const { db, view, rows, users, canEdit, sorted } = vp;
  const groupProp = db.schema.find((p) => p.id === view.config.groupBy);
  const [over, setOver] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState<{ key: string; el: HTMLElement } | null>(null);
  const [hiddenEl, setHiddenEl] = useState<HTMLElement | null>(null);

  if (!groupProp) {
    const opts = db.schema.filter((p) => GROUPABLE.includes(p.type));
    return (
      <div className="empty-state">
        Board views are grouped by a property.
        {canEdit && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
            {opts.map((p) => <button key={p.id} className="btn sm" onClick={() => updateView(db.id, view.id, { config: { groupBy: p.id } })}>Group by {p.name}</button>)}
          </div>
        )}
      </div>
    );
  }
  const hidden = view.config.hiddenGroups ?? [];
  const groups = groupRows(rows, groupProp, users);
  const writable = canEdit && canGroupWrite(groupProp);

  const moveTo = async (rowId: string, fromKey: string, toKey: string, beforeId?: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    if (fromKey !== toKey && writable) {
      let v = groupValue(groupProp, toKey, rowValue(row, groupProp));
      if (groupProp.type === 'multi_select' || groupProp.type === 'person') {
        const cur: string[] = rowValue(row, groupProp) ?? [];
        v = toKey === '__none' ? [] : [...cur.filter((x) => x !== fromKey && x !== toKey), toKey];
      }
      await setRowValue(db.id, rowId, groupProp, v);
    }
    if (beforeId && beforeId !== rowId && !sorted) await reorderRows(db.id, rows, rowId, beforeId, false);
  };

  return (
    <div className="board">
      {groups.filter((g) => !hidden.includes(g.key)).map((g) => (
        <div key={g.key} className={`board-col ${over === g.key ? 'over' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('atrium/card')) { e.preventDefault(); setOver(g.key); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
          onDrop={(e) => {
            setOver(null);
            const [id, from] = e.dataTransfer.getData('atrium/card').split('|');
            const beforeEl = (e.target as HTMLElement).closest('[data-card]') as HTMLElement | null;
            moveTo(id, from, g.key, beforeEl?.dataset.card);
          }}>
          <div className="board-col-head">
            <GroupLabel g={g} prop={groupProp} users={users} />
            <span className="faint">{g.rows.length}</span>
            <span style={{ flex: 1 }} />
            {canEdit && (
              <>
                <button className="icon-btn" onClick={(e) => setColMenu({ key: g.key, el: e.currentTarget })}><MoreHorizontal size={14} /></button>
                <button className="icon-btn" onClick={() => createRow(db.id, { props: { [groupProp.id]: groupValue(groupProp, g.key, null) } })}><Plus size={14} /></button>
              </>
            )}
          </div>
          <div className="board-cards">
            {g.rows.map((r) => (
              <div key={r.id} data-card={r.id} draggable={canEdit}
                onDragStart={(e) => e.dataTransfer.setData('atrium/card', `${r.id}|${g.key}`)}>
                <Card vp={vp} row={r} showCover={view.config.cardPreview === 'cover'} />
              </div>
            ))}
            {canEdit && (
              <button className="board-new" onClick={() => createRow(db.id, { props: { [groupProp.id]: groupValue(groupProp, g.key, null) } })}>
                <Plus size={14} /> New page
              </button>
            )}
          </div>
        </div>
      ))}
      {!!hidden.length && (
        <div className="board-hidden">
          <button className="tb-btn" onClick={(e) => setHiddenEl(e.currentTarget)}><EyeOff size={14} /> {hidden.length} hidden</button>
        </div>
      )}
      {colMenu && (
        <Popover anchor={colMenu.el} open onClose={() => setColMenu(null)} width={200}>
          <MenuItem icon={<EyeOff size={14} />} onClick={() => { updateView(db.id, view.id, { config: { hiddenGroups: [...hidden, colMenu.key] } }); setColMenu(null); }}>Hide group</MenuItem>
        </Popover>
      )}
      {hiddenEl && (
        <Popover anchor={hiddenEl} open onClose={() => setHiddenEl(null)} width={240}>
          <div className="menu-heading">Hidden groups</div>
          {groups.filter((g) => hidden.includes(g.key)).map((g) => (
            <MenuItem key={g.key} icon={<Eye size={14} />} right={g.rows.length}
              onClick={() => updateView(db.id, view.id, { config: { hiddenGroups: hidden.filter((k) => k !== g.key) } })}>
              <GroupLabel g={g} prop={groupProp as Prop} users={users} />
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
