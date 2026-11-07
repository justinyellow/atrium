import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, Check, ChevronRight, Copy, EyeOff, Filter as FilterIcon, Plus, Settings2, Trash2,
  WrapText,
} from 'lucide-react';
import type { Database, DbView, Prop, PropType, SelectOption } from '../lib/types';
import { get } from '../lib/api';
import { useDatabase } from '../lib/hooks';
import { MenuItem, PageIcon, Popover, Toggle, toast } from '../components/ui';
import { TypeIcon, Tag, OptionSettings } from './cells';
import { AiPropSettings, DEFAULT_AI_PROP } from '../ai/AiPropSettings';
import { requestAiFill } from '../ai/AiCell';
import { ButtonPropSettings } from './newprops';
import { useUsers } from '../lib/hooks';
import { Sparkles, RefreshCw } from 'lucide-react';
import {
  addProperty, CREATABLE_TYPES, defaultFilter, deleteProperty, NUMBER_FORMATS, propsConfig, randomColor, shortId, TYPE_LABELS,
  updateProperty, updateView, viewProps,
} from './dbutil';

export function TypeList({ onPick, current }: { onPick: (t: PropType) => void; current?: PropType }) {
  return (
    <>
      <div className="menu-heading">Type</div>
      {CREATABLE_TYPES.map((t) => (
        <MenuItem key={t} icon={<TypeIcon type={t} />} onClick={() => onPick(t)} right={current === t ? <Check size={14} /> : null}>
          {TYPE_LABELS[t]}
        </MenuItem>
      ))}
    </>
  );
}

function DbPicker({ onPick, exclude }: { onPick: (id: string) => void; exclude?: string }) {
  const { data } = useQuery({ queryKey: ['databases'], queryFn: () => get<{ id: string; title: string; icon: string | null }[]>('/databases') });
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((d) => (d.title || 'Untitled').toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div style={{ padding: 4 }}><input className="input sm" autoFocus placeholder="Search for a database…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="menu-heading">Related to</div>
      {list.map((d) => (
        <MenuItem key={d.id} icon={<PageIcon icon={d.icon} kind="database" size={16} />} onClick={() => onPick(d.id)}>
          {d.title || 'Untitled'}{d.id === exclude ? ' (this database)' : ''}
        </MenuItem>
      ))}
    </>
  );
}

/** "+" in the header: choose a type (and DB for relations), create the property. */
export function AddPropertyMenu({ dbId, anchor, onClose, onCreated }: {
  dbId: string; anchor: HTMLElement | null; onClose: () => void; onCreated?: (p: Prop) => void;
}) {
  const [step, setStep] = useState<'type' | 'relation'>('type');
  const create = async (body: Partial<Prop>) => {
    try {
      const p = await addProperty(dbId, body);
      onCreated?.(p);
    } catch (e: any) { toast(e.message); }
    onClose();
  };
  return (
    <Popover anchor={anchor} open onClose={onClose} width={260}>
      {step === 'type' ? (
        <TypeList onPick={(t) => (t === 'relation' ? setStep('relation') : t === 'ai' ? create({ name: 'AI summary', type: 'ai', ai: DEFAULT_AI_PROP }) : create({ name: TYPE_LABELS[t], type: t }))} />
      ) : (
        <DbPicker exclude={dbId} onPick={(id) => create({ name: 'Related', type: 'relation', relation: { databaseId: id } })} />
      )}
    </Popover>
  );
}

/** Edit a property's name, type and type-specific configuration. */
export function PropertySettings({ dbId, prop, anchor, onClose, schema }: {
  dbId: string; prop: Prop; anchor: HTMLElement | null; onClose: () => void; schema: Prop[];
}) {
  const [name, setName] = useState(prop.name);
  const [desc, setDesc] = useState(prop.description ?? '');
  const [typeOpen, setTypeOpen] = useState<HTMLElement | null>(null);
  const [expr, setExpr] = useState(prop.formula?.expression ?? '');
  const [optEdit, setOptEdit] = useState<{ opt: SelectOption; el: HTMLElement } | null>(null);
  const [newOpt, setNewOpt] = useState('');
  const close = () => {
    if (name.trim() && name !== prop.name) updateProperty(dbId, prop.id, { name: name.trim() });
    if (prop.type === 'formula' && expr !== (prop.formula?.expression ?? '')) updateProperty(dbId, prop.id, { formula: { expression: expr } });
    if (desc.trim() !== (prop.description ?? '')) updateProperty(dbId, prop.id, { description: desc.trim() });
    onClose();
  };
  const relProps = schema.filter((p) => p.type === 'relation');
  const rollupRel = schema.find((p) => p.id === prop.rollup?.relationPropId);
  const { data: target } = useDatabase(prop.type === 'rollup' ? rollupRel?.relation?.databaseId : undefined);
  const setRollup = (patch: Partial<NonNullable<Prop['rollup']>>) =>
    updateProperty(dbId, prop.id, { rollup: { relationPropId: '', targetPropId: '', fn: 'show_original', ...prop.rollup, ...patch } });

  return (
    <Popover anchor={anchor} open onClose={close} width={290}>
      <div style={{ padding: '4px 4px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="prop-icon-box"><TypeIcon type={prop.type} /></span>
        <input className="input sm" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && close()} />
      </div>
      <div style={{ padding: '0 4px 6px' }}>
        <textarea className="input sm prop-desc-input" rows={2} placeholder="Add a description…" value={desc} maxLength={1000}
          onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); close(); } }} />
      </div>
      {prop.type !== 'title' && (
        <MenuItem icon={<Settings2 size={14} />} right={<>{TYPE_LABELS[prop.type]} <ChevronRight size={14} /></>} onClick={(e) => setTypeOpen(e.currentTarget as HTMLElement)}>
          Type
        </MenuItem>
      )}
      {typeOpen && (
        <Popover anchor={typeOpen} open onClose={() => setTypeOpen(null)} placement="right-start" width={240}>
          <TypeList current={prop.type} onPick={async (t) => {
            setTypeOpen(null);
            if (t === 'relation') { toast('Create a new Relation property from the + menu to choose a database'); return; }
            await updateProperty(dbId, prop.id, { type: t, ...(t === 'ai' && !prop.ai ? { ai: DEFAULT_AI_PROP } : {}) });
          }} />
        </Popover>
      )}

      {prop.type === 'person' && (
        <>
          <div className="menu-sep" />
          <MenuItem icon={<Settings2 size={14} />} right={<Toggle checked={prop.limit === 'one'} onChange={(v) => updateProperty(dbId, prop.id, { limit: v ? 'one' : 'many' })} />}
            onClick={() => updateProperty(dbId, prop.id, { limit: prop.limit === 'one' ? 'many' : 'one' })}>
            Limit to one person
          </MenuItem>
        </>
      )}

      {prop.type === 'number' && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Number format</div>
          {NUMBER_FORMATS.map(([k, l]) => (
            <MenuItem key={k} onClick={() => updateProperty(dbId, prop.id, { number_format: k })} right={(prop.number_format ?? 'number') === k ? <Check size={14} /> : null}>{l}</MenuItem>
          ))}
        </>
      )}

      {(prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status') && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Options</div>
          {(prop.options ?? []).map((o) => (
            <div key={o.id} className="opt-row" onClick={(e) => setOptEdit({ opt: o, el: e.currentTarget })}>
              <Tag option={o} status={prop.type === 'status'} />
              {prop.type === 'status' && <span className="faint" style={{ fontSize: 12, marginLeft: 'auto' }}>{{ todo: 'To-do', in_progress: 'In progress', complete: 'Complete' }[o.group ?? 'todo']}</span>}
            </div>
          ))}
          <div style={{ padding: 4 }}>
            <input className="input sm" placeholder="+ Add an option" value={newOpt} onChange={(e) => setNewOpt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newOpt.trim()) {
                  updateProperty(dbId, prop.id, { options: [...(prop.options ?? []), { id: shortId(), name: newOpt.trim(), color: randomColor(), ...(prop.type === 'status' ? { group: 'todo' as const } : {}) }] });
                  setNewOpt('');
                }
              }} />
          </div>
          {optEdit && <OptionSettings dbId={dbId} prop={prop} opt={optEdit.opt} anchor={optEdit.el} onClose={() => setOptEdit(null)} />}
        </>
      )}

      {prop.type === 'formula' && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Formula</div>
          <div style={{ padding: 4 }}>
            <textarea className="input formula-input" rows={3} value={expr} onChange={(e) => setExpr(e.target.value)}
              placeholder={'prop("Price") * prop("Qty")'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) close(); }} />
            <div className="menu-footer">
              Notion Formula 2.0 syntax. Reference properties with <code>prop("Name")</code>; chain methods like{' '}
              <code>prop("Tags").map(current + "!")</code> or <code>prop("Tasks").map(current.prop("Points")).sum()</code>.
              Use <code>let</code>/<code>lets</code>, <code>if</code>/<code>ifs</code>, lists <code>[1, 2]</code>, and
              text, number, date (<code>dateAdd</code>, <code>dateBetween</code>, <code>formatDate</code>), list (<code>filter</code>,{' '}
              <code>find</code>, <code>sort</code>, <code>unique</code>) and people (<code>name</code>, <code>email</code>) functions. ⌘/Ctrl+Enter to save.
            </div>
            <div className="formula-props">
              {schema.filter((p) => p.id !== prop.id).map((p) => (
                <button key={p.id} className="tag c-default" onClick={() => setExpr((x) => `${x}prop("${p.name}")`)}>{p.name}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {prop.type === 'ai' && <AiPropSettings dbId={dbId} prop={prop} />}
      {prop.type === 'button' && <ButtonPropSettingsWithUsers dbId={dbId} prop={prop} schema={schema} />}

      {prop.type === 'relation' && (
        <>
          <div className="menu-sep" />
          <RelationInfo prop={prop} />
        </>
      )}

      {prop.type === 'rollup' && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Relation</div>
          <select className="input sm" style={{ margin: '0 4px', width: 'calc(100% - 8px)' }} value={prop.rollup?.relationPropId ?? ''}
            onChange={(e) => setRollup({ relationPropId: e.target.value, targetPropId: '' })}>
            <option value="">Select a relation…</option>
            {relProps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="menu-heading">Property</div>
          <select className="input sm" style={{ margin: '0 4px', width: 'calc(100% - 8px)' }} value={prop.rollup?.targetPropId ?? ''}
            onChange={(e) => setRollup({ targetPropId: e.target.value })} disabled={!target}>
            <option value="">Select a property…</option>
            {(target?.schema ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="menu-heading">Calculate</div>
          <select className="input sm" style={{ margin: '0 4px 6px', width: 'calc(100% - 8px)' }} value={prop.rollup?.fn ?? 'show_original'}
            onChange={(e) => setRollup({ fn: e.target.value })}>
            {[['show_original', 'Show original'], ['count', 'Count all'], ['count_values', 'Count values'], ['unique', 'Count unique values'],
              ['empty', 'Count empty'], ['sum', 'Sum'], ['average', 'Average'], ['min', 'Min'], ['max', 'Max'], ['percent_checked', 'Percent checked']]
              .map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </>
      )}

      {prop.type === 'unique_id' && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Prefix</div>
          <div style={{ padding: 4 }}>
            <input className="input sm" defaultValue={prop.id_prefix ?? ''} placeholder="e.g. TASK"
              onBlur={(e) => updateProperty(dbId, prop.id, { id_prefix: e.target.value.trim() })} />
          </div>
        </>
      )}
    </Popover>
  );
}

function RelationInfo({ prop }: { prop: Prop }) {
  const { data } = useDatabase(prop.relation?.databaseId);
  return (
    <div className="menu-footer">
      Related to <b><PageIcon icon={data?.icon ?? null} kind="database" size={13} /> {data?.title || 'Untitled'}</b>
      {prop.relation?.syncedPropId ? ' · two-way' : ''}
    </div>
  );
}

/** Column header menu. */
export function HeaderMenu({ db, view, prop, anchor, onClose, onEdit }: {
  db: Database; view: DbView; prop: Prop; anchor: HTMLElement | null; onClose: () => void; onEdit: () => void;
}) {
  const props = viewProps(db.schema, view);
  const setSort = (dir: 'asc' | 'desc') => {
    const sorts = [...(view.config.sorts ?? []).filter((s) => s.prop !== prop.id), { prop: prop.id, dir }];
    updateView(db.id, view.id, { config: { sorts } });
    onClose();
  };
  const addFilter = () => {
    const filter = view.config.filter ?? { op: 'and', filters: [] };
    updateView(db.id, view.id, { config: { filter: { ...filter, filters: [...filter.filters, defaultFilter(prop)] } } });
    onClose();
  };
  const hide = () => {
    const list = props.map((x) => (x.prop.id === prop.id ? { ...x, visible: false } : x));
    updateView(db.id, view.id, { config: { properties: propsConfig(list) } });
    onClose();
  };
  const insert = async (side: 'left' | 'right') => {
    onClose();
    const p = await addProperty(db.id, { name: 'Property', type: 'text' });
    const list = props.filter((x) => x.prop.id !== p.id);
    const i = list.findIndex((x) => x.prop.id === prop.id);
    list.splice(side === 'left' ? i : i + 1, 0, { prop: p, visible: true, width: 180 });
    updateView(db.id, view.id, { config: { properties: propsConfig(list) } });
  };
  const duplicate = async () => {
    onClose();
    const { id, ...rest } = prop;
    void id;
    if (prop.type === 'relation') { toast('Relations cannot be duplicated'); return; }
    await addProperty(db.id, { ...rest, name: `${prop.name} (1)` });
  };
  return (
    <Popover anchor={anchor} open onClose={onClose} width={240}>
      <MenuItem icon={<Settings2 size={14} />} onClick={() => { onClose(); onEdit(); }}>Edit property</MenuItem>
      {prop.type === 'ai' && (
        <>
          <MenuItem icon={<Sparkles size={14} />} onClick={() => { onClose(); requestAiFill(db.id, prop.id, [], { all: true, onlyEmpty: true }); }}>Fill empty with AI</MenuItem>
          <MenuItem icon={<RefreshCw size={14} />} onClick={() => { onClose(); requestAiFill(db.id, prop.id, [], { all: true }); }}>Update all with AI</MenuItem>
        </>
      )}
      <div className="menu-sep" />
      <MenuItem icon={<FilterIcon size={14} />} onClick={addFilter}>Filter</MenuItem>
      <MenuItem icon={<ArrowUp size={14} />} onClick={() => setSort('asc')}>Sort ascending</MenuItem>
      <MenuItem icon={<ArrowDown size={14} />} onClick={() => setSort('desc')}>Sort descending</MenuItem>
      {prop.type !== 'title' && <MenuItem icon={<EyeOff size={14} />} onClick={hide}>Hide in view</MenuItem>}
      <MenuItem icon={<WrapText size={14} />} onClick={() => { updateView(db.id, view.id, { config: { wrap: !view.config.wrap } }); onClose(); }}
        right={view.config.wrap ? <Check size={14} /> : null}>Wrap text</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon={<ArrowLeftToLine size={14} />} onClick={() => insert('left')}>Insert left</MenuItem>
      <MenuItem icon={<ArrowRightToLine size={14} />} onClick={() => insert('right')}>Insert right</MenuItem>
      {prop.type !== 'title' && (
        <>
          <MenuItem icon={<Copy size={14} />} onClick={duplicate}>Duplicate property</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} danger onClick={async () => {
            onClose();
            if (confirmDelete(prop)) await deleteProperty(db.id, prop.id);
          }}>Delete property</MenuItem>
        </>
      )}
    </Popover>
  );
}

function confirmDelete(prop: Prop) {
  // window.confirm is avoided in favour of a quick undo-less delete with a toast; keep it explicit for relations
  toast(`Deleted property “${prop.name}”`);
  return true;
}

export function AddPropertyButton({ dbId, onCreated, label }: { dbId: string; onCreated?: (p: Prop) => void; label?: string }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className={label ? 'add-prop-btn' : 'th-add'} onClick={(e) => setEl(e.currentTarget)}><Plus size={14} />{label}</button>
      {el && <AddPropertyMenu dbId={dbId} anchor={el} onClose={() => setEl(null)} onCreated={onCreated} />}
    </>
  );
}

function ButtonPropSettingsWithUsers({ dbId, prop, schema }: { dbId: string; prop: Prop; schema: Prop[] }) {
  const { data: users } = useUsers();
  return <><div className="menu-sep" /><ButtonPropSettings dbId={dbId} prop={prop} schema={schema} users={users ?? []} /></>;
}
