// Inline database / linked database view embedded in a page.
// Contract: block type 'database', props { databaseId, linked }. A linked block's views are scoped to the block id.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createReactBlockSpec, type DefaultReactSuggestionItem } from '@blocknote/react';
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core/extensions';
import { ArrowUpRight, Database as DbIcon, ExternalLink, Link2, Lock, MoreHorizontal, Search, Table2, Trash2, Undo2, Unlink } from 'lucide-react';
import { ApiError, del, get, patch, post, queryClient } from '../lib/api';
import { MenuItem, PageIcon, Popover, toast } from '../components/ui';
import { DatabaseView } from './DatabaseView';
import { useDbMeta } from './dbutil';
import './database.css';

const rank = { none: 0, view: 1, comment: 2, edit: 3, full: 4 } as const;

/**
 * ProseMirror listens on the editor root, so typing/pasting/dragging inside an embedded database would be
 * handled as document edits. Stop those native events at the block boundary (portalled popovers are unaffected).
 */
function useIsolateEvents(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const types = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend', 'compositionstart', 'compositionend'];
    types.forEach((t) => el.addEventListener(t, stop));
    return () => types.forEach((t) => el.removeEventListener(t, stop));
  });
}

function TitleInput({ id, title, editable }: { id: string; title: string; editable: boolean }) {
  const [v, setV] = useState(title);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!focused.current) setV(title);
  }, [title]);
  if (!editable) return <span className="dbb-title-text">{title || 'Untitled'}</span>;
  return (
    <input
      className="dbb-title-input"
      value={v}
      placeholder="Untitled"
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        setV(e.target.value);
        clearTimeout(timer.current);
        const t = e.target.value;
        timer.current = setTimeout(async () => {
          await patch(`/pages/${id}`, { title: t });
          queryClient.invalidateQueries({ queryKey: ['db', id] });
          queryClient.invalidateQueries({ queryKey: ['tree'] });
        }, 400);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function SourcePicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['databases'], queryFn: () => get<{ id: string; title: string; icon: string | null }[]>('/databases') });
  const list = (data ?? []).filter((d) => (d.title || 'Untitled').toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="dbb-picker">
      <div className="dbb-picker-head"><Link2 size={15} /> Select a data source for this linked view</div>
      <div className="dbb-picker-search"><Search size={14} /><input autoFocus placeholder="Search for a database…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="dbb-picker-list">
        {list.map((d) => (
          <button key={d.id} className="menu-item" onClick={() => onPick(d.id)}>
            <span className="menu-icon"><PageIcon icon={d.icon} kind="database" size={16} /></span>
            <span className="menu-label">{d.title || 'Untitled'}</span>
          </button>
        ))}
        {data && !list.length && <div className="menu-footer">No databases found</div>}
      </div>
    </div>
  );
}

function DatabaseBlockView({ block, editor }: { block: any; editor: any }) {
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useIsolateEvents(ref);
  const { databaseId, linked } = block.props as { databaseId: string; linked: boolean };
  const blockId = linked ? (block.id as string) : null;
  const { data: db, error } = useDbMeta(databaseId, blockId);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  if (!databaseId) {
    return (
      <div ref={ref} className="db-block" contentEditable={false}>
        {linked && editor.isEditable ? (
          <SourcePicker onPick={(id) => editor.updateBlock(block, { props: { databaseId: id } })} />
        ) : (
          <div className="dbb-placeholder"><DbIcon size={16} /> Empty database block</div>
        )}
      </div>
    );
  }
  if (error) {
    const status = (error as ApiError).status;
    return (
      <div ref={ref} className="db-block" contentEditable={false}>
        <div className="dbb-placeholder"><Lock size={15} /> {status === 404 || status === 403 ? 'No access to this database' : "Couldn't load this database"}</div>
      </div>
    );
  }
  if (!db) return <div ref={ref} className="db-block" contentEditable={false}><div className="db-loading"><div className="spinner" /></div></div>;

  const level = db.level as keyof typeof rank;
  const canEditDb = rank[level] >= rank.edit;
  const deleted = !!(db as any).deleted_at;
  const openFull = () => nav(`/p/${databaseId}`);

  if (deleted) {
    return (
      <div ref={ref} className="db-block" contentEditable={false}>
        <div className="dbb-placeholder">
          <Trash2 size={15} /> {db.title || 'Untitled'} is in Trash.
          {rank[level] >= rank.full && (
            <button className="btn sm" onClick={async () => { await post(`/pages/${databaseId}/restore`); queryClient.invalidateQueries({ queryKey: ['db', databaseId] }); queryClient.invalidateQueries({ queryKey: ['tree'] }); }}>
              <Undo2 size={13} /> Restore
            </button>
          )}
          {editor.isEditable && <button className="btn sm" onClick={() => editor.removeBlocks([block])}>Remove block</button>}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={`db-block ${linked ? 'linked' : ''}`} contentEditable={false}>
      <div className="dbb-header">
        <span className="dbb-icon"><PageIcon icon={db.icon} kind="database" size={22} /></span>
        {linked ? (
          <a className="dbb-title-link" href={`/p/${databaseId}`} onClick={(e) => { e.preventDefault(); openFull(); }} title="Open source database">
            <span className="dbb-title-text">{db.title || 'Untitled'}</span><ArrowUpRight size={16} />
          </a>
        ) : (
          <TitleInput id={databaseId} title={db.title} editable={canEditDb && !db.locked} />
        )}
        <span style={{ flex: 1 }} />
        <button className="icon-btn dbb-action" title="Open as full page" onClick={openFull}><ExternalLink size={15} /></button>
        <button className="icon-btn dbb-action" title="More" onClick={(e) => setMenu(e.currentTarget)}><MoreHorizontal size={16} /></button>
      </div>
      <DatabaseView databaseId={databaseId} inline blockId={blockId} />
      {menu && (
        <Popover anchor={menu} open onClose={() => setMenu(null)} placement="bottom-end" width={240}>
          <MenuItem icon={<ExternalLink size={15} />} onClick={() => { setMenu(null); openFull(); }}>Open as full page</MenuItem>
          <MenuItem icon={<Link2 size={15} />} onClick={() => { navigator.clipboard.writeText(`${location.origin}/p/${databaseId}`); toast('Link copied'); setMenu(null); }}>Copy link to database</MenuItem>
          {editor.isEditable && <div className="menu-sep" />}
          {editor.isEditable && linked && (
            <MenuItem icon={<Unlink size={15} />} onClick={() => { setMenu(null); editor.removeBlocks([block]); }}>Remove linked view</MenuItem>
          )}
          {editor.isEditable && !linked && rank[level] >= rank.full && (
            <MenuItem icon={<Trash2 size={15} />} danger onClick={async () => {
              setMenu(null);
              try {
                await del(`/pages/${databaseId}`);
                editor.removeBlocks([block]);
                queryClient.invalidateQueries({ queryKey: ['tree'] });
                queryClient.invalidateQueries({ queryKey: ['db', databaseId] });
                toast(`Moved "${db.title || 'Untitled'}" to Trash`);
              } catch (e: any) { toast(e.message); }
            }}>Delete database</MenuItem>
          )}
        </Popover>
      )}
    </div>
  );
}

export const databaseBlock = createReactBlockSpec(
  { type: 'database', propSchema: { databaseId: { default: '' }, linked: { default: false } }, content: 'none' },
  { render: ({ block, editor }) => <DatabaseBlockView block={block} editor={editor} /> },
);

/** Slash-menu items for inline databases and linked views. `pageId` is the page that hosts the editor. */
export function getDatabaseSlashItems(editor: any, pageId: string): DefaultReactSuggestionItem[] {
  return [
    {
      title: 'Database - Inline',
      subtext: 'Add an inline database to this page.',
      aliases: ['database', 'inline', 'table', 'db', 'board'],
      group: 'Database',
      icon: <Table2 size={18} />,
      onItemClick: async () => {
        try {
          const p = await post('/pages', { parentId: pageId, kind: 'database' });
          insertOrUpdateBlockForSlashMenu(editor, { type: 'database', props: { databaseId: p.id, linked: false } } as any);
          queryClient.invalidateQueries({ queryKey: ['tree'] });
        } catch (e: any) { toast(e.message); }
      },
    },
    {
      title: 'Linked view of database',
      subtext: 'Show a view of an existing database.',
      aliases: ['linked', 'view', 'database', 'db'],
      group: 'Database',
      icon: <Link2 size={18} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'database', props: { databaseId: '', linked: true } } as any),
    },
  ];
}
