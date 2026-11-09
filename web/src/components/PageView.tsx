import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  ChevronsRight, Star, MoreHorizontal, MessageSquare, Smile, Image as ImageIcon, MessageSquarePlus, Lock, Unlock, Link2,
  Copy, CornerUpRight, Trash2, History, Download, MoveHorizontal, Type, Undo2, Link as LinkIcon,
  RefreshCw,
} from 'lucide-react';
import { del, get, patch, post, put, queryClient } from '../lib/api';
import { useMe, usePage } from '../lib/hooks';
import { useUi } from '../lib/store';
import type { Page } from '../lib/types';
import { PageEditor, type PresenceUser } from './Editor';
import { Avatar, MenuItem, PageIcon, Popover, Toggle, timeAgo, toast } from './ui';
import { CoverPicker, IconPicker, coverStyle, isImageCover } from './PagePickers';
import { ShareMenu } from './ShareMenu';
import { HistoryModal } from './History';
import { MovePicker } from './MovePicker';
import { DatabaseView } from '../database/DatabaseView';
import { RowProperties } from '../database/RowProperties';
import { PageVerification, VerifyMenuSection } from '../database/Verification';

const canEdit = (p: Page) => (p.level === 'edit' || p.level === 'full') && !p.locked;

function Title({ page, onEnter }: { page: Page; onEnter: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editable = canEdit(page);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.textContent !== page.title) ref.current.textContent = page.title;
  }, [page.title]);
  const save = (title: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await patch(`/pages/${page.id}`, { title });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      if (page.kind === 'row' && page.parent_id) queryClient.invalidateQueries({ queryKey: ['dbq', page.parent_id] });
    }, 400);
  };
  return (
    <div
      ref={ref}
      className="page-title"
      contentEditable={editable}
      suppressContentEditableWarning
      data-placeholder={page.kind === 'database' ? 'Untitled' : 'New page'}
      spellCheck
      onInput={(e) => {
        const t = (e.target as HTMLDivElement).textContent ?? '';
        queryClient.setQueryData(['page', page.id], (old: any) => (old ? { ...old, title: t } : old));
        save(t);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n/g, ' '));
      }}
    />
  );
}

function Cover({ page }: { page: Page }) {
  const [picker, setPicker] = useState(false);
  const [repo, setRepo] = useState(false);
  const [pos, setPos] = useState(page.cover_position);
  const btn = useRef<HTMLButtonElement>(null);
  const editable = canEdit(page);
  useEffect(() => setPos(page.cover_position), [page.cover_position]);
  if (!page.cover) return null;
  const img = isImageCover(page.cover);
  const save = (body: any) => patch(`/pages/${page.id}`, body).then(() => queryClient.invalidateQueries({ queryKey: ['page', page.id] }));
  return (
    <div
      className="page-cover"
      style={{ ...coverStyle(page.cover), cursor: repo ? 'move' : undefined }}
      onMouseDown={(e) => {
        if (!repo) return;
        const startY = e.clientY, start = pos, h = (e.currentTarget as HTMLElement).offsetHeight;
        const move = (ev: MouseEvent) => setPos(Math.max(0, Math.min(100, start - ((ev.clientY - startY) / h) * 100)));
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      {img && <img src={page.cover} alt="" draggable={false} style={{ objectPosition: `center ${pos}%` }} />}
      {editable && (
        <div className="cover-actions" style={repo ? { display: 'flex' } : undefined}>
          {repo ? (
            <>
              <button onClick={() => { save({ cover_position: pos }); setRepo(false); }}>Save position</button>
              <button onClick={() => { setPos(page.cover_position); setRepo(false); }}>Cancel</button>
            </>
          ) : (
            <>
              <button ref={btn} onClick={() => setPicker(true)}>Change cover</button>
              {img && <button onClick={() => setRepo(true)}>Reposition</button>}
            </>
          )}
        </div>
      )}
      <CoverPicker anchor={btn.current} open={picker} onClose={() => setPicker(false)} onPick={(c) => { save({ cover: c }); setPicker(false); }} />
    </div>
  );
}

function Backlinks({ pageId }: { pageId: string }) {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['backlinks', pageId], queryFn: () => get(`/pages/${pageId}/backlinks`) });
  if (!data?.length) return null;
  return (
    <details className="backlinks">
      <summary><LinkIcon size={14} style={{ marginTop: 4 }} />{data.length} backlink{data.length > 1 ? 's' : ''}</summary>
      {data.map((b: any) => (
        <a key={b.id} className="backlink" href={`/p/${b.id}`} onClick={(e) => { e.preventDefault(); nav(`/p/${b.id}`); }}>
          <PageIcon icon={b.icon} size={16} /> {b.title || 'Untitled'}
        </a>
      ))}
    </details>
  );
}

/** Everything below the top bar: cover, icon, title, properties, body. Used by full pages and the row side peek. */
export function PageContent({ pageId, peek, onPresence }: { pageId: string; peek?: boolean; onPresence?: (u: PresenceUser[]) => void }) {
  const { data: page, error } = usePage(pageId);
  const { data: me } = useMe();
  const [iconPicker, setIconPicker] = useState(false);
  const [coverPicker, setCoverPicker] = useState(false);
  const iconRef = useRef<HTMLDivElement>(null);
  const addIconRef = useRef<HTMLButtonElement>(null);
  const addCoverRef = useRef<HTMLButtonElement>(null);
  const editorWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (page && !peek) post(`/pages/${pageId}/visit`).catch(() => {});
  }, [pageId, !!page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="empty-state">{(error as Error).message === 'Page not found' ? "This page doesn't exist or you don't have access to it." : (error as Error).message}</div>;
  if (!page || !me) return <div className="empty-state"><div className="spinner" style={{ margin: '0 auto' }} /></div>;

  const editable = canEdit(page);
  const save = (body: any) => patch(`/pages/${page.id}`, body).then(() => {
    queryClient.invalidateQueries({ queryKey: ['page', page.id] });
    queryClient.invalidateQueries({ queryKey: ['tree'] });
    if (page.kind === 'row' && page.parent_id) queryClient.invalidateQueries({ queryKey: ['dbq', page.parent_id] });
  });
  const focusEditor = () => (editorWrap.current?.querySelector('.bn-editor') as HTMLElement | null)?.focus();
  const isDb = page.kind === 'database';

  return (
    <div className={page.small_text ? 'small-text' : ''}>
      <Cover page={page} />
      <div className={`page-inner ${page.full_width || isDb ? 'full' : ''}`} style={peek ? { padding: '0 48px' } : isDb ? { padding: '0 96px' } : undefined}>
        <div className={`page-header ${page.cover ? 'has-cover' : ''} ${page.icon ? 'has-icon' : ''}`} style={!page.cover && peek ? { paddingTop: 32 } : !page.cover && isDb ? { paddingTop: 48 } : page.cover && !page.icon ? { paddingTop: 24 } : undefined}>
          {page.icon && (
            <div ref={iconRef} className="page-icon-big" onClick={() => editable && setIconPicker(true)} style={isDb ? { fontSize: 40, width: 48, height: 48 } : undefined}>
              <PageIcon icon={page.icon} size={isDb ? 44 : 78} />
            </div>
          )}
          {editable && (
            <div className="page-controls">
              {!page.icon && <button ref={addIconRef} onClick={() => setIconPicker(true)}><Smile size={15} /> Add icon</button>}
              {!page.cover && <button ref={addCoverRef} onClick={() => save({ cover: `gradient:${Math.floor(Math.random() * 12)}` })}><ImageIcon size={15} /> Add cover</button>}
              {page.level !== 'view' && <button onClick={() => useUi.getState().set({ comments: { pageId: page.id } })}><MessageSquarePlus size={15} /> Add comment</button>}
            </div>
          )}
          {page.locked && <div className="locked-banner"><Lock size={12} /> Locked — unlock from the ⋯ menu to edit</div>}
          {(page as any).notion_sync && (
            <div className="locked-banner notion-sync">
              <RefreshCw size={12} />
              <span>
                {(page as any).notion_sync.paused ? 'Copied from Notion (sync paused)' : 'Synced from Notion'} · last copied {timeAgo((page as any).notion_sync.synced_at).toLowerCase()}
                {page.level !== 'view' && !(page as any).notion_sync.paused ? ' · edits made here are replaced when the page changes in Notion' : ''}
                {' · '}<a href={(page as any).notion_sync.url} target="_blank" rel="noreferrer">Open in Notion</a>
              </span>
            </div>
          )}
          <Title page={page} onEnter={focusEditor} />
          <PageVerification page={page} />
          <IconPicker anchor={page.icon ? iconRef.current : addIconRef.current} open={iconPicker} onClose={() => setIconPicker(false)} onPick={(icon) => { save({ icon }); setIconPicker(false); }} />
          <CoverPicker anchor={addCoverRef.current} open={coverPicker} onClose={() => setCoverPicker(false)} onPick={(cover) => { save({ cover }); setCoverPicker(false); }} />
        </div>
        {page.kind === 'row' && <RowProperties page={page} />}
        {!isDb && <Backlinks pageId={page.id} />}
      </div>
      {isDb ? (
        <div style={{ padding: peek ? '0 48px' : '0 96px' }}><DatabaseView databaseId={page.id} /></div>
      ) : (
        <div className={`page-inner page-body ${page.full_width ? 'full' : ''}`} style={peek ? { padding: '0 48px' } : undefined} ref={editorWrap}>
          <PageEditor
            key={page.id}
            pageId={page.id}
            editable={editable}
            canComment={page.level !== 'view'}
            me={me}
            onPresence={onPresence}
            smallText={page.small_text}
          />
        </div>
      )}
    </div>
  );
}

function PageMenu({ page, anchor, onClose, onHistory }: { page: Page; anchor: HTMLElement | null; onClose: () => void; onHistory: () => void }) {
  const nav = useNavigate();
  const [moving, setMoving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const full = page.level === 'full';
  const save = async (body: any) => {
    await patch(`/pages/${page.id}`, body);
    queryClient.invalidateQueries({ queryKey: ['page', page.id] });
  };
  if (moving) return <MovePicker pageId={page.id} anchor={anchor} onClose={() => { setMoving(false); onClose(); }} />;
  if (verifying) return <VerifyMenuSection page={page} anchor={anchor} onDone={() => { setVerifying(false); onClose(); }} />;
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="bottom-end" width={260}>
      {page.kind !== 'database' && (
        <>
          <MenuItem icon={<Type size={16} />} right={<Toggle checked={page.small_text} onChange={(v) => save({ small_text: v })} />} onClick={() => save({ small_text: !page.small_text })}>Small text</MenuItem>
          <MenuItem icon={<MoveHorizontal size={16} />} right={<Toggle checked={page.full_width} onChange={(v) => save({ full_width: v })} />} onClick={() => save({ full_width: !page.full_width })}>Full width</MenuItem>
          <div className="menu-sep" />
        </>
      )}
      <MenuItem icon={page.locked ? <Unlock size={16} /> : <Lock size={16} />} disabled={!full} onClick={() => save({ locked: !page.locked })}>{page.locked ? 'Unlock page' : 'Lock page'}</MenuItem>
      {page.kind !== 'row' && <MenuItem icon={<BadgeCheck size={16} />} disabled={!full} onClick={() => setVerifying(true)}>{page.props?.__verification ? 'Verification…' : 'Verify page'}</MenuItem>}
      <MenuItem icon={<Star size={16} />} onClick={async () => {
        await (page.favorite ? del(`/favorites/${page.id}`) : put(`/favorites/${page.id}`));
        queryClient.invalidateQueries({ queryKey: ['page', page.id] });
        queryClient.invalidateQueries({ queryKey: ['tree'] });
        onClose();
      }}>{page.favorite ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
      <MenuItem icon={<Link2 size={16} />} onClick={() => { navigator.clipboard.writeText(`${location.origin}/p/${page.id}`); toast('Link copied'); onClose(); }}>Copy link</MenuItem>
      <MenuItem icon={<Copy size={16} />} onClick={async () => { const p = await post(`/pages/${page.id}/duplicate`); queryClient.invalidateQueries({ queryKey: ['tree'] }); onClose(); nav(`/p/${p.id}`); }}>Duplicate</MenuItem>
      <MenuItem icon={<CornerUpRight size={16} />} disabled={!full || page.kind === 'row'} onClick={() => setMoving(true)}>Move to</MenuItem>
      <MenuItem icon={<Trash2 size={16} />} danger disabled={!full} onClick={async () => {
        await del(`/pages/${page.id}`);
        queryClient.invalidateQueries({ queryKey: ['tree'] });
        queryClient.invalidateQueries({ queryKey: ['page', page.id] });
        onClose();
      }}>Move to Trash</MenuItem>
      <div className="menu-sep" />
      {page.kind !== 'database' && <MenuItem icon={<History size={16} />} onClick={() => { onHistory(); onClose(); }}>Version history</MenuItem>}
      {page.kind !== 'database' && <MenuItem icon={<Download size={16} />} onClick={() => { window.open(`/api/v1/pages/${page.id}/export`); onClose(); }}>Export as Markdown</MenuItem>}
      <div className="menu-sep" />
      <div className="menu-footer">
        {page.updated_by_user && <>Last edited by {page.updated_by_user.name}<br /></>}
        {new Date(page.updated_at).toLocaleString()}
        {page.created_by_user && <><br />Created by {page.created_by_user.name}</>}
      </div>
    </Popover>
  );
}

function TrashedBanner({ page }: { page: Page }) {
  const nav = useNavigate();
  const deleted = !!(page as any).deleted_at;
  // Only trashed pages need the "deleted by" lookup; null (not undefined) when it isn't found.
  const { data } = useQuery({ queryKey: ['deleted', page.id], enabled: deleted, queryFn: () => get(`/trash`).then((r: any[]) => r.find((x) => x.id === page.id) ?? null) });
  if (!(page as any).deleted_at) return null;
  return (
    <div className="trash-banner">
      This page is in Trash.
      {page.level === 'full' && (
        <>
          <button className="btn sm" onClick={async () => { await post(`/pages/${page.id}/restore`); queryClient.invalidateQueries(); }}><Undo2 size={14} /> Restore page</button>
          <button className="btn sm" onClick={async () => { await del(`/pages/${page.id}/permanent`); queryClient.invalidateQueries({ queryKey: ['tree'] }); nav('/'); }}>Delete permanently</button>
        </>
      )}
      {data?.deleted_by_name && <span style={{ opacity: 0.8 }}>Deleted by {data.deleted_by_name}</span>}
    </div>
  );
}

export default function PageView() {
  const { id } = useParams();
  const nav = useNavigate();
  const ui = useUi();
  const { data: page } = usePage(id);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [history, setHistory] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const shareBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = page ? `${page.icon && !page.icon.startsWith('/') ? page.icon + ' ' : ''}${page.title || 'Untitled'}` : 'Atrium';
  }, [page?.title, page?.icon]);
  useEffect(() => setPresence([]), [id]);

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
      <div className="main">
        <div className="topbar">
          {!ui.sidebarOpen && <button className="icon-btn" onClick={() => ui.setSidebarOpen(true)} title="Open sidebar"><ChevronsRight size={18} /></button>}
          <div className="breadcrumbs">
            {page?.teamspace && (
              <>
                <span className="crumb"><span className="emoji">{page.teamspace.icon}</span>{page.teamspace.name}</span>
                <span className="crumb-sep">/</span>
              </>
            )}
            {page?.breadcrumbs.map((c, i) => (
              <span key={c.id} style={{ display: 'contents' }}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <span className="crumb" onClick={() => nav(`/p/${c.id}`)}>
                  <PageIcon icon={c.icon} kind={c.kind} size={16} />
                  {c.title || 'Untitled'}
                </span>
              </span>
            ))}
            {page && !page.teamspace_id && page.level === 'full' && <span className="crumb faint" style={{ cursor: 'default' }}><Lock size={12} /> Private</span>}
          </div>
          {page && (
            <div className="topbar-actions">
              <span className="edited">Edited {timeAgo(page.updated_at)}</span>
              <div className="presence">
                {presence.slice(0, 5).map((u) => <span key={u.id} title={u.name} style={{ borderRadius: '50%', boxShadow: `0 0 0 2px ${u.color}` }}><Avatar user={u} size={24} /></span>)}
              </div>
              <button ref={shareBtn} className="topbar-btn" onClick={() => setShare(true)}>Share</button>
              <button className="icon-btn" title="View all comments" onClick={() => ui.set({ comments: ui.comments ? null : { pageId: page.id } })}><MessageSquare size={18} /></button>
              <button className="icon-btn" title={page.favorite ? 'Remove from Favorites' : 'Add to Favorites'} onClick={async () => {
                await (page.favorite ? del(`/favorites/${page.id}`) : put(`/favorites/${page.id}`));
                queryClient.invalidateQueries({ queryKey: ['page', page.id] });
                queryClient.invalidateQueries({ queryKey: ['tree'] });
              }}><Star size={18} fill={page.favorite ? '#f5c518' : 'none'} color={page.favorite ? '#f5c518' : undefined} /></button>
              <button ref={menuBtn} className="icon-btn" onClick={() => setMenu(true)}><MoreHorizontal size={18} /></button>
            </div>
          )}
        </div>
        {page && <TrashedBanner page={page} />}
        <div className="scroller">{id && <PageContent key={id} pageId={id} onPresence={setPresence} />}</div>
        {page && menu && <PageMenu page={page} anchor={menuBtn.current} onClose={() => setMenu(false)} onHistory={() => setHistory(true)} />}
        {page && <ShareMenu page={page} anchor={shareBtn.current} open={share} onClose={() => setShare(false)} />}
        {page && history && <HistoryModal pageId={page.id} open={history} onClose={() => setHistory(false)} />}
      </div>
    </div>
  );
}
