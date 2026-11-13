import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight, ChevronsLeft, Search, Home, Inbox, Settings, Plus, MoreHorizontal, Trash2, Star, StarOff, Copy,
  Link2, PenLine, CornerUpRight, LogOut, Sun, Moon, Users, FileText, Database, ChevronDown, FileUp,
} from 'lucide-react';
import { del, patch, post, put, queryClient } from '../lib/api';
import { useMe, useTree, useUnread } from '../lib/hooks';
import { applyTheme, useUi } from '../lib/store';
import type { Teamspace, Tree, TreePage } from '../lib/types';
import { MenuItem, PageIcon, Popover, toast } from './ui';
import { TrashPopover } from './Trash';
import { MovePicker } from './MovePicker';
import { AiNavItem } from '../ai/AiNavItem';

export async function createPageAndOpen(nav: (p: string) => void, body: { parentId?: string | null; teamspaceId?: string | null; kind?: string; title?: string }) {
  const p = await post('/pages', body);
  if (body.parentId) useUi.getState().toggleExpanded(body.parentId, true);
  await queryClient.invalidateQueries({ queryKey: ['tree'] });
  nav(`/p/${p.id}`);
  return p;
}

type DropPos = 'before' | 'after' | 'inside';
let dragId: string | null = null;
const DB_ROWS_SHOWN = 10;

function useChildren(tree: Tree | undefined) {
  return useMemo(() => {
    const m = new Map<string | null, TreePage[]>();
    const ids = new Set(tree?.pages.map((p) => p.id));
    for (const p of tree?.pages ?? []) {
      const key = p.parent_id && ids.has(p.parent_id) ? p.parent_id : `root:${p.teamspace_id ?? (p.private ? 'private' : 'shared')}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(p);
    }
    for (const list of m.values()) list.sort((a, b) => a.position - b.position);
    return m;
  }, [tree]);
}

async function movePage(id: string, target: TreePage, pos: DropPos, siblings: TreePage[]) {
  if (id === target.id) return;
  let body: any;
  if (pos === 'inside') {
    body = { parentId: target.id };
    useUi.getState().toggleExpanded(target.id, true);
  } else {
    const i = siblings.findIndex((s) => s.id === target.id);
    const neighbor = siblings[pos === 'before' ? i - 1 : i + 1];
    const a = target.position;
    const b = neighbor && neighbor.id !== id ? neighbor.position : pos === 'before' ? a - 2 : a + 2;
    const position = (a + b) / 2;
    body = target.parent_id ? { parentId: target.parent_id, position } : { parentId: null, teamspaceId: target.teamspace_id, position };
  }
  try {
    await post(`/pages/${id}/move`, body);
    queryClient.invalidateQueries({ queryKey: ['tree'] });
  } catch (e: any) {
    toast(e.message);
  }
}

function PageMenu({ page, anchor, onClose, onRename, favorite }: { page: TreePage; anchor: HTMLElement | null; onClose: () => void; onRename: () => void; favorite: boolean }) {
  const nav = useNavigate();
  const [moving, setMoving] = useState(false);
  const canFull = page.level === 'full';
  return (
    <>
      <Popover anchor={anchor} open={!moving} onClose={onClose} width={240}>
        <MenuItem icon={favorite ? <StarOff size={16} /> : <Star size={16} />} onClick={async () => {
          await (favorite ? del(`/favorites/${page.id}`) : put(`/favorites/${page.id}`));
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          queryClient.invalidateQueries({ queryKey: ['page', page.id] });
          onClose();
        }}>{favorite ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
        <div className="menu-sep" />
        <MenuItem icon={<Link2 size={16} />} onClick={() => { navigator.clipboard.writeText(`${location.origin}/p/${page.id}`); toast('Link copied'); onClose(); }}>Copy link</MenuItem>
        <MenuItem icon={<Copy size={16} />} right="Ctrl+D" onClick={async () => {
          const p = await post(`/pages/${page.id}/duplicate`);
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          onClose();
          nav(`/p/${p.id}`);
        }}>Duplicate</MenuItem>
        <MenuItem icon={<PenLine size={16} />} disabled={!['edit', 'full'].includes(page.level)} onClick={() => { onRename(); onClose(); }}>Rename</MenuItem>
        <MenuItem icon={<CornerUpRight size={16} />} disabled={!canFull} onClick={() => setMoving(true)}>Move to</MenuItem>
        <MenuItem icon={<Trash2 size={16} />} danger disabled={!canFull} onClick={async () => {
          await del(`/pages/${page.id}`);
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          toast(`Moved "${page.title || 'Untitled'}" to Trash`);
          onClose();
        }}>Move to Trash</MenuItem>
      </Popover>
      {moving && <MovePicker pageId={page.id} anchor={anchor} onClose={() => { setMoving(false); onClose(); }} />}
    </>
  );
}

function TreeItem({ page, depth, children, siblings, favorites }: { page: TreePage; depth: number; children: Map<string | null, TreePage[]>; siblings: TreePage[]; favorites: Set<string> }) {
  const nav = useNavigate();
  const { id: activeId } = useParams();
  const expanded = useUi((s) => !!s.expanded[page.id]);
  const toggle = useUi((s) => s.toggleExpanded);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [drop, setDrop] = useState<DropPos | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [showAll, setShowAll] = useState(false);
  const kids = children.get(page.id) ?? [];
  const canEdit = page.level === 'edit' || page.level === 'full';
  const isDb = page.kind === 'database';
  const isRow = page.kind === 'row';
  // A database only expands to list the rows that hold sub-pages; it has none otherwise.
  const expandable = !isDb || kids.length > 0;
  const shown = isDb && !showAll ? kids.slice(0, DB_ROWS_SHOWN) : kids;

  const onDragOver = (e: DragEvent) => {
    if (!dragId || dragId === page.id) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    // Rows can't take siblings from the sidebar (that would drop a page into the database itself).
    setDrop(isRow ? 'inside' : y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : isDb ? 'after' : 'inside');
  };
  return (
    <>
      <div
        className={`tree-item ${activeId === page.id ? 'active' : ''} ${menu ? 'menu-open' : ''} ${drop ? `drop-${drop}` : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => nav(`/p/${page.id}`)}
        draggable={!renaming && !isRow}
        onDragStart={(e) => { dragId = page.id; e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { dragId = null; }}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => { e.preventDefault(); const d = drop; setDrop(null); if (dragId && d) movePage(dragId, page, d, siblings); }}
      >
        <span
          className={`tree-icon-wrap ${expandable ? 'has-toggle' : ''}`}
          onClick={(e) => { if (!expandable) return; e.stopPropagation(); toggle(page.id); }}
        >
          <span className="ico"><PageIcon icon={page.icon} kind={page.kind} /></span>
          <span className="chev tree-toggle"><ChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} /></span>
        </span>
        {renaming ? (
          <input
            className="input" autoFocus defaultValue={page.title} style={{ height: 24, marginLeft: 4 }}
            onClick={(e) => e.stopPropagation()}
            onBlur={async (e) => { setRenaming(false); await patch(`/pages/${page.id}`, { title: e.target.value }); queryClient.invalidateQueries({ queryKey: ['tree'] }); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <span className="tree-title">{page.title || 'Untitled'}</span>
        )}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          {!isRow && <button ref={menuBtn} className="icon-btn" title="Delete, duplicate, and more…" onClick={() => setMenu(true)}><MoreHorizontal size={16} /></button>}
          {canEdit && !isDb && (
            <button className="icon-btn" title="Add a page inside" onClick={() => createPageAndOpen(nav, { parentId: page.id })}><Plus size={16} /></button>
          )}
        </span>
      </div>
      {menu && <PageMenu page={page} anchor={menuBtn.current} onClose={() => setMenu(false)} onRename={() => setRenaming(true)} favorite={favorites.has(page.id)} />}
      {expanded && expandable && (
        kids.length ? shown.map((k) => <TreeItem key={k.id} page={k} depth={depth + 1} children={children} siblings={kids} favorites={favorites} />)
          : <div className="tree-empty" style={{ paddingLeft: 30 + depth * 12 }}>No pages inside</div>
      )}
      {expanded && shown.length < kids.length && (
        <div className="tree-empty tree-more" style={{ paddingLeft: 30 + depth * 12 }} onClick={() => setShowAll(true)}>
          {kids.length - shown.length} more with pages inside
        </div>
      )}
    </>
  );
}

function Section({ label, children, actions, storageKey }: { label: string; children: React.ReactNode; actions?: React.ReactNode; storageKey: string }) {
  const open = useUi((s) => s.expanded[storageKey] !== false);
  const toggle = useUi((s) => s.toggleExpanded);
  return (
    <div>
      <div className="section-label" onClick={() => toggle(storageKey, !open)}>
        <span>{label}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open && children}
    </div>
  );
}

function TeamspaceBlock({ ts, children, favorites }: { ts: Teamspace; children: Map<string | null, TreePage[]>; favorites: Set<string> }) {
  const nav = useNavigate();
  const key = `ts:${ts.id}`;
  const open = useUi((s) => s.expanded[key] !== false);
  const toggle = useUi((s) => s.toggleExpanded);
  const roots = children.get(`root:${ts.id}`) ?? [];
  return (
    <div>
      <div className="tree-item" style={{ paddingLeft: 8 }} onClick={() => toggle(key, !open)}>
        <span className="tree-icon-wrap"><span className="emoji">{ts.icon ?? '📁'}</span></span>
        <span className="tree-title">{ts.name}</span>
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Teamspace settings" onClick={() => useUi.getState().set({ settings: 'teamspaces' })}><MoreHorizontal size={16} /></button>
          <button className="icon-btn" title="Add a page" onClick={() => createPageAndOpen(nav, { teamspaceId: ts.id })}><Plus size={16} /></button>
        </span>
      </div>
      {open && (roots.length
        ? roots.map((p) => <TreeItem key={p.id} page={p} depth={1} children={children} siblings={roots} favorites={favorites} />)
        : <div className="tree-empty" style={{ paddingLeft: 30 }}>No pages yet</div>)}
    </div>
  );
}

export default function Sidebar() {
  const nav = useNavigate();
  const { data: me } = useMe();
  const { data: tree } = useTree();
  const { data: unread } = useUnread();
  const ui = useUi();
  const children = useChildren(tree);
  const [wsMenu, setWsMenu] = useState(false);
  const [trash, setTrash] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const wsBtn = useRef<HTMLButtonElement>(null);
  const trashBtn = useRef<HTMLButtonElement>(null);
  const newBtn = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const favorites = new Set(tree?.favorites.map((f) => f.id));
  const byId = new Map(tree?.pages.map((p) => [p.id, p]));
  const privateRoots = children.get('root:private') ?? [];
  const sharedRoots = (tree?.shared ?? []).map((id) => byId.get(id)!).filter(Boolean);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) => ui.setSidebarWidth(Math.max(200, Math.min(480, ev.clientX)));
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const isDark = document.documentElement.classList.contains('dark');

  return (
    <aside className={`sidebar ${ui.sidebarOpen ? '' : 'collapsed'}`} style={{ width: ui.sidebarWidth, ['--sw' as any]: `${ui.sidebarWidth}px` }}>
      <div className="sidebar-top">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button ref={wsBtn} className="ws-switcher" onClick={() => setWsMenu(true)}>
            <span className="ws-icon">{me?.workspace.icon || me?.workspace.name?.[0]?.toUpperCase()}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me?.workspace.name}</span>
            <ChevronDown size={14} className="faint" />
          </button>
          <button className="icon-btn" title="Close sidebar (Ctrl+\)" onClick={() => ui.setSidebarOpen(false)}><ChevronsLeft size={18} /></button>
          <button className="icon-btn" title="New page" onClick={() => createPageAndOpen(nav, {})}><PenLine size={16} /></button>
        </div>
        <Popover anchor={wsBtn.current} open={wsMenu} onClose={() => setWsMenu(false)} width={280}>
          <div className="menu-heading">{me?.email}</div>
          <MenuItem icon={<Settings size={16} />} onClick={() => { ui.set({ settings: 'workspace' }); setWsMenu(false); }}>Settings</MenuItem>
          <MenuItem icon={<Users size={16} />} onClick={() => { ui.set({ settings: 'members' }); setWsMenu(false); }}>Invite members</MenuItem>
          <MenuItem icon={isDark ? <Sun size={16} /> : <Moon size={16} />} onClick={async () => {
            const t = isDark ? 'light' : 'dark';
            applyTheme(t);
            patch('/me', { theme: t });
            setWsMenu(false);
          }}>{isDark ? 'Light mode' : 'Dark mode'}</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={<LogOut size={16} />} onClick={async () => { const r = await post('/auth/logout'); queryClient.clear(); location.href = r?.redirect || '/login'; }}>Log out</MenuItem>
        </Popover>
        <div style={{ marginTop: 4 }}>
          <button className="nav-item" onClick={() => ui.set({ quickFind: true })}><span className="nav-icon"><Search size={17} /></span>Search<span className="kbd" style={{ marginLeft: 'auto' }}>Ctrl+K</span></button>
          <button className="nav-item" onClick={() => nav('/')}><span className="nav-icon"><Home size={17} /></span>Home</button>
          <AiNavItem />
          <button className={`nav-item ${ui.inbox ? 'active' : ''}`} onClick={() => ui.set({ inbox: !ui.inbox })}>
            <span className="nav-icon"><Inbox size={17} /></span>Inbox
            {!!unread?.count && <span className="badge">{unread.count}</span>}
          </button>
          <button className="nav-item" onClick={() => ui.set({ settings: 'account' })}><span className="nav-icon"><Settings size={17} /></span>Settings</button>
        </div>
      </div>
      <div className="sidebar-scroll">
        {!!tree?.favorites.length && (
          <Section label="Favorites" storageKey="sec:fav">
            {tree.favorites.map((f) => {
              const p = byId.get(f.id) ?? ({ ...f, parent_id: null, teamspace_id: null, position: 0, level: 'view', private: false } as TreePage);
              return <TreeItem key={f.id} page={p} depth={0} children={children} siblings={[]} favorites={favorites} />;
            })}
          </Section>
        )}
        {!!tree?.teamspaces.length && (
          <Section label="Teamspaces" storageKey="sec:ts" actions={me?.role !== 'guest' && <button className="icon-btn" title="Create a teamspace" onClick={() => ui.set({ settings: 'teamspaces' })}><Plus size={14} /></button>}>
            {tree.teamspaces.map((t) => <TeamspaceBlock key={t.id} ts={t} children={children} favorites={favorites} />)}
          </Section>
        )}
        {!!sharedRoots.length && (
          <Section label="Shared" storageKey="sec:shared">
            {sharedRoots.map((p) => <TreeItem key={p.id} page={p} depth={0} children={children} siblings={sharedRoots} favorites={favorites} />)}
          </Section>
        )}
        {me?.role !== 'guest' && (
          <Section label="Private" storageKey="sec:private" actions={<button className="icon-btn" title="Add a page" onClick={() => createPageAndOpen(nav, {})}><Plus size={14} /></button>}>
            {privateRoots.length
              ? privateRoots.map((p) => <TreeItem key={p.id} page={p} depth={0} children={children} siblings={privateRoots} favorites={favorites} />)
              : <div className="tree-empty">No pages inside</div>}
          </Section>
        )}
        <div style={{ marginTop: 12 }}>
          <button ref={newBtn} className="nav-item" onClick={() => setNewMenu(true)}><span className="nav-icon"><Plus size={17} /></span>New page</button>
          <button className="nav-item" onClick={() => importInput.current?.click()}><span className="nav-icon"><FileUp size={16} /></span>Import</button>
          <button ref={trashBtn} className="nav-item" onClick={() => setTrash(true)}><span className="nav-icon"><Trash2 size={16} /></span>Trash</button>
          <input ref={importInput} type="file" accept=".md,.markdown,.txt" hidden multiple onChange={async (e) => {
            for (const file of Array.from(e.target.files ?? [])) {
              const markdown = await file.text();
              const p = await post('/import/markdown', { markdown, title: markdown.match(/^#\s/) ? undefined : file.name.replace(/\.(md|markdown|txt)$/, '') });
              nav(`/p/${p.id}`);
            }
            queryClient.invalidateQueries({ queryKey: ['tree'] });
            toast('Imported');
            e.target.value = '';
          }} />
        </div>
        <Popover anchor={newBtn.current} open={newMenu} onClose={() => setNewMenu(false)} width={220}>
          <MenuItem icon={<FileText size={16} />} onClick={() => { setNewMenu(false); createPageAndOpen(nav, {}); }}>Page</MenuItem>
          <MenuItem icon={<Database size={16} />} onClick={() => { setNewMenu(false); createPageAndOpen(nav, { kind: 'database', title: '' }); }}>Database</MenuItem>
        </Popover>
        <TrashPopover anchor={trashBtn.current} open={trash} onClose={() => setTrash(false)} />
      </div>
      <div className={`sidebar-resizer ${dragging ? 'dragging' : ''}`} onMouseDown={startResize} onDoubleClick={() => ui.setSidebarWidth(248)} />
    </aside>
  );
}
