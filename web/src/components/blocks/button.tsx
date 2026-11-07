import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createReactBlockSpec } from '@blocknote/react';
import { MousePointerClick, Settings2, Trash2, Plus, ListPlus, DatabaseZap, ExternalLink } from 'lucide-react';
import { get, post, queryClient } from '../../lib/api';
import { useDatabase, useUsers } from '../../lib/hooks';
import type { Prop } from '../../lib/types';
import { MenuItem, Popover, toast } from '../ui';
import { isolate, useEditorPage } from './context';
import { toIsoWithOffset } from './date';

export type ButtonAction =
  | { type: 'insert'; markdown: string; blocks: any[] }
  | { type: 'addRow'; databaseId: string; title: string; props: Record<string, any> }
  | { type: 'open'; target: string };

const parseActions = (s: string): ButtonAction[] => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const stripIds = (blocks: any[]): any[] => blocks.map(({ id: _id, children, ...b }) => ({ ...b, children: stripIds(children ?? []) }));

/** Resolve placeholder values ("me", "today", "now") at click time. */
function resolveProps(props: Record<string, any>, meId: string) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === '@today') out[k] = { start: toIsoWithOffset(new Date()).slice(0, 10) };
    else if (v === '@now') out[k] = { start: toIsoWithOffset(new Date()) };
    else if (Array.isArray(v)) out[k] = v.map((x) => (x === '@me' ? meId : x));
    else out[k] = v;
  }
  return out;
}

const SETTABLE = ['text', 'number', 'select', 'status', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'date'];

function PresetEditor({ databaseId, value, onChange }: { databaseId: string; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const { data: db } = useDatabase(databaseId);
  const { data: users } = useUsers();
  if (!db) return null;
  const props = db.schema.filter((p: Prop) => SETTABLE.includes(p.type));
  const set = (id: string, v: any) => {
    const next = { ...value };
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete next[id];
    else next[id] = v;
    onChange(next);
  };
  return (
    <div className="btn-presets">
      {props.map((p) => {
        const v = value[p.id];
        let input: React.ReactNode;
        if (p.type === 'checkbox') input = <input type="checkbox" checked={!!v} onChange={(e) => set(p.id, e.target.checked || '')} />;
        else if (['select', 'status'].includes(p.type))
          input = <select className="input" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)}><option value="">—</option>{p.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
        else if (p.type === 'multi_select')
          input = <select className="input" value={v?.[0] ?? ''} onChange={(e) => set(p.id, e.target.value ? [e.target.value] : '')}><option value="">—</option>{p.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
        else if (p.type === 'person')
          input = <select className="input" value={v?.[0] ?? ''} onChange={(e) => set(p.id, e.target.value ? [e.target.value] : '')}><option value="">—</option><option value="@me">Person who clicks</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
        else if (p.type === 'date')
          input = <select className="input" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)}><option value="">—</option><option value="@today">Today (date clicked)</option><option value="@now">Now (time clicked)</option></select>;
        else if (p.type === 'number') input = <input className="input" type="number" value={v ?? ''} onChange={(e) => set(p.id, e.target.value === '' ? '' : Number(e.target.value))} />;
        else input = <input className="input" value={v ?? ''} onChange={(e) => set(p.id, e.target.value)} />;
        return <label key={p.id} className="btn-preset"><span>{p.name}</span>{input}</label>;
      })}
    </div>
  );
}

function ButtonConfig({ anchor, label, actions, onSave, onClose, editor }: { anchor: HTMLElement | null; label: string; actions: ButtonAction[]; onSave: (label: string, actions: ButtonAction[]) => void; onClose: () => void; editor: any }) {
  const [name, setName] = useState(label);
  const [list, setList] = useState<ButtonAction[]>(actions);
  const [adding, setAdding] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const dbs = useQuery({ queryKey: ['databases'], queryFn: () => get<{ id: string; title: string; icon: string | null }[]>('/databases') });
  const update = (i: number, a: ButtonAction) => setList(list.map((x, j) => (j === i ? a : x)));
  const save = async () => {
    // Convert insert-action markdown into block JSON once, at save time.
    const out: ButtonAction[] = [];
    for (const a of list) {
      if (a.type === 'insert') out.push({ ...a, blocks: stripIds(await editor.tryParseMarkdownToBlocks(a.markdown || '')) });
      else out.push(a);
    }
    onSave(name || 'Button', out);
    onClose();
  };
  return (
    <Popover anchor={anchor} open onClose={save} width={420}>
      <div className="btn-config">
        <div className="menu-heading">Button name</div>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; setTimeout(() => { el.focus(); el.select(); }, 80); } }}
        />
        <div className="menu-heading">When clicked</div>
        {list.map((a, i) => (
          <div key={i} className="btn-action">
            <div className="btn-action-head">
              {a.type === 'insert' ? <><ListPlus size={14} /> Insert blocks below</> : a.type === 'addRow' ? <><DatabaseZap size={14} /> Add page to</> : <><ExternalLink size={14} /> Open page or URL</>}
              <button className="icon-btn" title="Remove action" onClick={() => setList(list.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
            {a.type === 'insert' && (
              <textarea className="input" rows={4} placeholder={'Markdown to insert, e.g.\n## Meeting notes\n- [ ] Action item'} value={a.markdown} onChange={(e) => update(i, { ...a, markdown: e.target.value })} />
            )}
            {a.type === 'addRow' && (
              <>
                <select className="input" value={a.databaseId} onChange={(e) => update(i, { ...a, databaseId: e.target.value, props: {} })}>
                  <option value="">Choose a database…</option>
                  {dbs.data?.map((d) => <option key={d.id} value={d.id}>{d.icon ? `${d.icon} ` : ''}{d.title || 'Untitled'}</option>)}
                </select>
                {a.databaseId && (
                  <>
                    <input className="input" placeholder="Page title (optional)" value={a.title} onChange={(e) => update(i, { ...a, title: e.target.value })} />
                    <PresetEditor databaseId={a.databaseId} value={a.props} onChange={(props) => update(i, { ...a, props })} />
                  </>
                )}
              </>
            )}
            {a.type === 'open' && <input className="input" placeholder="https://… or a page link" value={a.target} onChange={(e) => update(i, { ...a, target: e.target.value })} />}
          </div>
        ))}
        <button ref={addBtn} className="btn sm" onClick={() => setAdding(true)}><Plus size={14} /> Add action</button>
        <Popover anchor={addBtn.current} open={adding} onClose={() => setAdding(false)} width={240}>
          <MenuItem icon={<ListPlus size={15} />} onClick={() => { setList([...list, { type: 'insert', markdown: '', blocks: [] }]); setAdding(false); }}>Insert blocks</MenuItem>
          <MenuItem icon={<DatabaseZap size={15} />} onClick={() => { setList([...list, { type: 'addRow', databaseId: '', title: '', props: {} }]); setAdding(false); }}>Add page to database</MenuItem>
          <MenuItem icon={<ExternalLink size={15} />} onClick={() => { setList([...list, { type: 'open', target: '' }]); setAdding(false); }}>Open page or URL</MenuItem>
        </Popover>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button className="btn primary sm" onClick={save}>Done</button></div>
      </div>
    </Popover>
  );
}

function ButtonView({ block, editor }: { block: any; editor: any }) {
  const ctx = useEditorPage();
  const nav = useNavigate();
  const [config, setConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const actions = parseActions(block.props.actions);
  const run = async () => {
    if (!actions.length) {
      if (editor.isEditable) setConfig(true);
      return;
    }
    setBusy(true);
    try {
      for (const a of actions) {
        if (a.type === 'insert') {
          if (!editor.isEditable) { toast('You need edit access to use this button'); continue; }
          if (a.blocks.length) editor.insertBlocks(stripIds(a.blocks), block, 'after');
        } else if (a.type === 'addRow' && a.databaseId) {
          const row = await post(`/databases/${a.databaseId}/rows`, { title: a.title, props: resolveProps(a.props, ctx.me?.id ?? '') });
          queryClient.invalidateQueries({ queryKey: ['dbq', a.databaseId] });
          toast(`Added "${row.title || 'Untitled'}"`);
        } else if (a.type === 'open' && a.target) {
          const m = a.target.match(/\/p\/([0-9a-f-]{36})/);
          if (m && (a.target.startsWith('/') || a.target.startsWith(location.origin))) nav(`/p/${m[1]}`);
          else window.open(/^https?:\/\//.test(a.target) ? a.target : `https://${a.target}`, '_blank', 'noopener');
        }
      }
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="button-block" ref={ref} contentEditable={false}>
      <button className="atrium-button" onClick={run} disabled={busy}>
        <MousePointerClick size={15} /> {block.props.label || 'Button'}
      </button>
      {editor.isEditable && <button className="icon-btn button-gear" title="Edit button" onClick={() => setConfig(true)}><Settings2 size={15} /></button>}
      {config && (
        <div ref={isolate} style={{ display: 'contents' }}>
          <ButtonConfig
            anchor={ref.current}
            label={block.props.label}
            actions={actions}
            editor={editor}
            onClose={() => setConfig(false)}
            onSave={(label, list) => editor.updateBlock(block, { props: { label, actions: JSON.stringify(list) } })}
          />
        </div>
      )}
    </div>
  );
}

export const buttonBlock = createReactBlockSpec(
  { type: 'button', propSchema: { label: { default: 'New button' }, actions: { default: '[]' } }, content: 'none' },
  { render: ({ block, editor }) => <ButtonView block={block} editor={editor} /> },
);
