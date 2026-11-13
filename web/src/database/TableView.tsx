import { Fragment, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, PanelRight } from 'lucide-react';
import type { Prop, Row } from '../lib/types';
import { MenuItem, PageIcon, Popover } from '../components/ui';
import { EditableCell, Tag, TypeIcon } from './cells';
import { AddPropertyButton, HeaderMenu, PropertySettings } from './PropertyMenu';
import {
  CALC_SHORT, calcsFor, calculate, createRow, groupRows, groupValue, propsConfig, updateView, viewProps, type Group,
} from './dbutil';
import { RowMenuButton, SubpageCount, reorderRows, type ViewProps } from './shared';
import { Check } from 'lucide-react';

export function TableView(vp: ViewProps) {
  const { db, view, rows, users, canEdit } = vp;
  const list = viewProps(db.schema, view);
  const visible = list.filter((x) => x.visible);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ prop: Prop; el: HTMLElement } | null>(null);
  const [editProp, setEditProp] = useState<{ prop: Prop; el: HTMLElement } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const headRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const groupProp = view.config.groupBy ? db.schema.find((p) => p.id === view.config.groupBy) : null;
  const w = (id: string, def: number) => widths[id] ?? def;
  const totalWidth = visible.reduce((a, x) => a + w(x.prop.id, x.width), 0);

  const startResize = (e: React.MouseEvent, id: string, start: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let cur = start;
    const move = (ev: MouseEvent) => {
      cur = Math.max(80, start + ev.clientX - x0);
      setWidths((m) => ({ ...m, [id]: cur }));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      updateView(db.id, view.id, { config: { properties: propsConfig(list.map((x) => (x.prop.id === id ? { ...x, width: cur } : x))) } });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const dropColumn = (target: string) => {
    if (!dragCol || dragCol === target) return;
    const l = [...list];
    const from = l.findIndex((x) => x.prop.id === dragCol);
    const [m] = l.splice(from, 1);
    l.splice(l.findIndex((x) => x.prop.id === target), 0, m);
    updateView(db.id, view.id, { config: { properties: propsConfig(l) } });
  };

  const header = (
    <div className="tr thead" style={{ width: totalWidth + 64 }}>
      <div className="gutter" />
      {visible.map((x) => (
        <div key={x.prop.id} ref={(el) => { headRefs.current[x.prop.id] = el; }}
          className={`th ${dropCol === x.prop.id ? 'drop' : ''}`} style={{ width: w(x.prop.id, x.width) }}
          draggable={canEdit}
          onDragStart={(e) => { setDragCol(x.prop.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { if (dragCol) { e.preventDefault(); setDropCol(x.prop.id); } }}
          onDragLeave={() => setDropCol(null)}
          onDrop={() => { dropColumn(x.prop.id); setDragCol(null); setDropCol(null); }}
          onClick={(e) => canEdit && setMenu({ prop: x.prop, el: e.currentTarget })}>
          <TypeIcon type={x.prop.type} />
          <span className="th-name" title={x.prop.description || undefined}>{x.prop.name}</span>
          {x.prop.description && <span className="th-desc" title={x.prop.description} aria-label={x.prop.description}>ⓘ</span>}
          {canEdit && <span className="resizer" onMouseDown={(e) => startResize(e, x.prop.id, w(x.prop.id, x.width))} onClick={(e) => e.stopPropagation()} />}
        </div>
      ))}
      {canEdit && (
        <div className="th th-plus">
          <AddPropertyButton dbId={db.id} onCreated={(p) => {
            const el = headRefs.current[visible[visible.length - 1]?.prop.id];
            updateView(db.id, view.id, { config: { properties: propsConfig([...list.filter((x) => x.prop.id !== p.id), { prop: p, visible: true, width: 180 }]) } });
            setTimeout(() => setEditProp({ prop: p, el: el ?? document.body }), 50);
          }} />
        </div>
      )}
    </div>
  );

  const renderRows = (rs: Row[], group?: Group) => (
    <>
      {rs.map((r) => (
        <TableRow key={r.id + (group?.key ?? '')} vp={vp} row={r} visible={visible} w={w} />
      ))}
      {canEdit && (
        <div className="tr new-row" style={{ width: totalWidth + 64 }}
          onClick={async () => {
            const props = group && groupProp ? { [groupProp.id]: groupValue(groupProp, group.key, null) } : undefined;
            await createRow(db.id, { props });
          }}>
          <div className="gutter" />
          <div className="new-row-inner"><Plus size={14} /> New page</div>
        </div>
      )}
    </>
  );

  const groups = groupProp ? groupRows(rows, groupProp, users) : null;

  return (
    <div className="table-wrap">
      <div className="table" style={{ minWidth: totalWidth + 100 }}>
        {header}
        {groups ? (
          groups.filter((g) => !(view.config.hiddenGroups ?? []).includes(g.key)).map((g) => (
            <Fragment key={g.key}>
              <div className="group-head" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
                {collapsed[g.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <GroupLabel g={g} prop={groupProp!} users={users} />
                <span className="faint">{g.rows.length}</span>
              </div>
              {!collapsed[g.key] && renderRows(g.rows, g)}
            </Fragment>
          ))
        ) : renderRows(rows)}
        <CalcRow vp={vp} visible={visible} w={w} totalWidth={totalWidth} />
      </div>
      {menu && (
        <HeaderMenu db={db} view={view} prop={menu.prop} anchor={menu.el} onClose={() => setMenu(null)}
          onEdit={() => setEditProp({ prop: menu.prop, el: menu.el })} />
      )}
      {editProp && (
        <PropertySettings dbId={db.id} schema={db.schema} prop={db.schema.find((p) => p.id === editProp.prop.id) ?? editProp.prop}
          anchor={editProp.el} onClose={() => setEditProp(null)} />
      )}
    </div>
  );
}

export function GroupLabel({ g, prop, users }: { g: Group; prop: Prop; users: ViewProps['users'] }) {
  if (g.key === '__none') return <span className="group-label muted">{g.label}</span>;
  if (prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status')
    return <Tag option={prop.options?.find((o) => o.id === g.key) ?? { id: g.key, name: g.label, color: 'default' }} status={prop.type === 'status'} />;
  if (g.userId) {
    const u = users.get(g.userId);
    return <span className="group-label">{u?.name ?? g.label}</span>;
  }
  return <span className="group-label">{g.label}</span>;
}

function TableRow({ vp, row, visible, w }: {
  vp: ViewProps; row: Row; visible: ReturnType<typeof viewProps>; w: (id: string, d: number) => number;
}) {
  const { db, view, users, titles, canEdit, openRow, rows, sorted } = vp;
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const canDrag = canEdit && !sorted && !view.config.groupBy;
  return (
    <div className={`tr ${drop ? `drop-${drop}` : ''}`}
      onDragOver={(e) => {
        if (!canDrag || !e.dataTransfer.types.includes('atrium/row')) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDrop(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('atrium/row');
        setDrop(null);
        if (id && id !== row.id) reorderRows(db.id, rows, id, row.id, drop === 'after');
      }}>
      <div className="gutter">
        {canEdit && (
          <RowMenuButton db={db} row={row} openRow={openRow}
            dragProps={canDrag ? { draggable: true, onDragStart: (e: React.DragEvent) => e.dataTransfer.setData('atrium/row', row.id) } : undefined} />
        )}
      </div>
      {visible.map((x) => (
        x.prop.type === 'title' ? (
          <EditableCell key={x.prop.id} dbId={db.id} row={row} prop={x.prop} users={users} titles={titles} canEdit={canEdit}
            wrap={view.config.wrap} className="td title-cell" style={{ width: w(x.prop.id, x.width) }}>
            <span className="title-inner">
              {row.icon && <PageIcon icon={row.icon} size={16} />}
              <span className={`cell-val title ${view.config.wrap ? 'wrap' : ''}`}>{row.title || <span className="faint">Untitled</span>}</span>
              <SubpageCount n={row.subpages} />
            </span>
            <button className="row-open" onClick={(e) => { e.stopPropagation(); openRow(row.id); }}><PanelRight size={12} /> OPEN</button>
          </EditableCell>
        ) : (
          <EditableCell key={x.prop.id} dbId={db.id} row={row} prop={x.prop} users={users} titles={titles} canEdit={canEdit}
            wrap={view.config.wrap} className={`td t-${x.prop.type}`} style={{ width: w(x.prop.id, x.width) }} />
        )
      ))}
    </div>
  );
}

function CalcRow({ vp, visible, w, totalWidth }: { vp: ViewProps; visible: ReturnType<typeof viewProps>; w: (id: string, d: number) => number; totalWidth: number }) {
  const { db, view, rows, canEdit } = vp;
  const [menu, setMenu] = useState<{ prop: Prop; el: HTMLElement } | null>(null);
  const calcs = view.config.calculations ?? {};
  return (
    <div className="tr calc-row" style={{ width: totalWidth + 64 }}>
      <div className="gutter" />
      {visible.map((x) => {
        const fn = calcs[x.prop.id];
        return (
          <div key={x.prop.id} className={`calc-cell ${fn ? 'set' : ''}`} style={{ width: w(x.prop.id, x.width) }}
            onClick={(e) => canEdit && setMenu({ prop: x.prop, el: e.currentTarget })}>
            {fn && fn !== 'none' ? <><span className="calc-label">{CALC_SHORT[fn]}</span> {calculate(fn, x.prop, rows)}</> : <span className="calc-hint">Calculate <ChevronDown size={12} /></span>}
          </div>
        );
      })}
      {menu && (
        <Popover anchor={menu.el} open onClose={() => setMenu(null)} placement="top-start" width={200}>
          {calcsFor(menu.prop.type).map(([k, l]) => (
            <MenuItem key={k} right={(calcs[menu.prop.id] ?? 'none') === k ? <Check size={14} /> : null}
              onClick={() => { updateView(db.id, view.id, { config: { calculations: { ...calcs, [menu.prop.id]: k } } }); setMenu(null); }}>{l}</MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
