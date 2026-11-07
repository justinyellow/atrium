import { useEffect, useRef, useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Check, MoreHorizontal, RotateCcw, SmilePlus, X, Pencil, Trash2 } from 'lucide-react';
import { get, post, patch, del, queryClient } from '../lib/api';
import { useMe, useUsers } from '../lib/hooks';
import type { Level } from '../lib/types';
import { Avatar, MenuItem, Popover, timeAgo, toast } from './ui';
import './collab.css';

interface Comment {
  id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  reactions: Record<string, string[]>;
  author: { id: string; name: string; avatar_url: string | null };
}
interface Thread {
  id: string;
  block_id: string | null;
  quote: string | null;
  resolved: boolean;
  created_at: string;
  comments: Comment[];
}

const QUICK = ['👍', '❤️', '🎉', '😄', '👀'];

export function CommentBody({ body }: { body: string }) {
  const parts: React.ReactNode[] = [];
  const re = /@\[([^\]]*)\]\(([0-9a-f-]{36})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<span key={m.index} className="cm-mention">@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <div className="cm-text">{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</div>;
}

/** Textarea with @-mention picker. Value uses `@[Name](id)` tokens. */
export function Composer({
  placeholder, onSubmit, autoFocus, initial = '', onCancel,
}: { placeholder: string; onSubmit: (body: string) => Promise<unknown>; autoFocus?: boolean; initial?: string; onCancel?: () => void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { data: users = [] } = useUsers();
  const matches = mention ? users.filter((u) => u.active && u.name.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6) : [];

  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }, [value]);

  const detect = (v: string, caret: number) => {
    const m = /(^|\s)@([\w.-]*)$/.exec(v.slice(0, caret));
    setMention(m ? { start: caret - m[2].length - 1, q: m[2] } : null);
    setSel(0);
  };
  const pick = (u: { id: string; name: string }) => {
    if (!mention || !ref.current) return;
    const caret = ref.current.selectionStart;
    const token = `@[${u.name}](${u.id}) `;
    const start = mention.start;
    setValue(value.slice(0, start) + token + value.slice(caret));
    setMention(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      const p = start + token.length;
      ref.current?.setSelectionRange(p, p);
    });
  };
  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
      setValue('');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cm-composer-box">
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mention && matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[sel]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
          }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <button className="cm-send" disabled={!value.trim() || busy} onClick={submit} title="Send">
        <ArrowUp size={14} />
      </button>
      <Popover anchor={ref.current} open={!!mention && matches.length > 0} onClose={() => setMention(null)} width={240}>
        <div className="menu-heading">People</div>
        {matches.map((u, i) => (
          <MenuItem key={u.id} active={i === sel} icon={<Avatar user={u} size={20} />} onClick={() => pick(u)}>
            {u.name}
          </MenuItem>
        ))}
      </Popover>
    </div>
  );
}

function CommentItem({ c, pageId, canComment, canModerate }: { c: Comment; pageId: string; canComment: boolean; canModerate: boolean }) {
  const { data: me } = useMe();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [emoji, setEmoji] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
  const react = async (r: string) => {
    setEmoji(null);
    await patch(`/comments/${c.id}`, { reaction: r });
    refresh();
  };
  const mine = me?.id === c.author?.id;
  return (
    <div className="cm-comment">
      <Avatar user={c.author} size={24} />
      <div className="cm-comment-body">
        <div className="cm-meta">
          <b>{c.author?.name ?? 'Deleted user'}</b>
          <span className="t">{timeAgo(c.created_at)}{c.edited_at ? ' (edited)' : ''}</span>
        </div>
        {editing ? (
          <div className="cm-edit">
            <Composer
              placeholder="Edit comment…"
              initial={c.body}
              autoFocus
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                await patch(`/comments/${c.id}`, { body });
                setEditing(false);
                refresh();
              }}
            />
          </div>
        ) : (
          <CommentBody body={c.body} />
        )}
        {Object.keys(c.reactions ?? {}).length > 0 && (
          <div className="cm-reactions">
            {Object.entries(c.reactions).map(([e, users]) => (
              <button key={e} className={`cm-reaction ${me && users.includes(me.id) ? 'mine' : ''}`} onClick={() => canComment && react(e)}>
                <span className="emoji">{e}</span> {users.length}
              </button>
            ))}
          </div>
        )}
      </div>
      {canComment && !editing && (
        <div className="cm-actions">
          <button className="icon-btn" title="Add reaction" onClick={(e) => setEmoji(e.currentTarget)}><SmilePlus size={14} /></button>
          {(mine || canModerate) && (
            <button className="icon-btn" title="More" onClick={(e) => setMenu(e.currentTarget)}><MoreHorizontal size={14} /></button>
          )}
        </div>
      )}
      <Popover anchor={emoji} open={!!emoji} onClose={() => setEmoji(null)} placement="bottom-end">
        <div className="cm-emoji-row">
          {QUICK.map((e) => <button key={e} className="emoji" onClick={() => react(e)}>{e}</button>)}
        </div>
      </Popover>
      <Popover anchor={menu} open={!!menu} onClose={() => setMenu(null)} placement="bottom-end" width={180}>
        {mine && <MenuItem icon={<Pencil size={14} />} onClick={() => { setMenu(null); setEditing(true); }}>Edit comment</MenuItem>}
        <MenuItem
          danger
          icon={<Trash2 size={14} />}
          onClick={async () => {
            setMenu(null);
            await del(`/comments/${c.id}`);
            refresh();
          }}
        >
          Delete comment
        </MenuItem>
      </Popover>
    </div>
  );
}

function scrollToMark(threadId: string) {
  const nodes = document.querySelectorAll(`[data-thread-id="${threadId}"]`);
  if (!nodes.length) return;
  (nodes[0] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
  nodes.forEach((n) => n.classList.add('active'));
  setTimeout(() => nodes.forEach((n) => n.classList.remove('active')), 1600);
}

export function CommentsPanel({ pageId, level, threadId, onClose }: { pageId: string; level: Level; threadId?: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [highlight, setHighlight] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: threads = [], isLoading } = useQuery({
    queryKey: ['comments', pageId],
    queryFn: () => get<Thread[]>(`/pages/${pageId}/comments`),
  });
  const canComment = level === 'comment' || level === 'edit' || level === 'full';
  const canModerate = level === 'full';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['comments', pageId] });

  useEffect(() => {
    if (!threadId || !threads.length) return;
    const t = threads.find((x) => x.id === threadId);
    if (!t) return;
    setTab(t.resolved ? 'resolved' : 'open');
    setHighlight(threadId);
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-thread="${threadId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const id = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(id);
  }, [threadId, threads.length]);

  const shown = threads.filter((t) => t.resolved === (tab === 'resolved'));
  const openCount = threads.filter((t) => !t.resolved).length;

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span>Comments</span>
        <button className="icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
      </div>
      <div className="cm-tabs">
        <button className={`cm-tab ${tab === 'open' ? 'on' : ''}`} onClick={() => setTab('open')}>Open{openCount ? ` · ${openCount}` : ''}</button>
        <button className={`cm-tab ${tab === 'resolved' ? 'on' : ''}`} onClick={() => setTab('resolved')}>Resolved</button>
      </div>
      <div className="cm-list" ref={listRef}>
        {canComment && tab === 'open' && (
          <div className="cm-new">
            <Composer
              placeholder="Add a comment…"
              onSubmit={async (body) => {
                await post(`/pages/${pageId}/comments`, { body });
                refresh();
              }}
            />
          </div>
        )}
        {isLoading && <div className="empty-state"><div className="spinner" style={{ margin: '0 auto' }} /></div>}
        {!isLoading && !shown.length && (
          <div className="empty-state">{tab === 'open' ? 'No open comments yet' : 'No resolved comments'}</div>
        )}
        {shown.map((t) => (
          <div key={t.id} data-thread={t.id} className={`cm-thread ${highlight === t.id ? 'highlight' : ''}`}>
            {t.quote && (
              <div className="cm-quote" title={t.quote} onClick={() => scrollToMark(t.id)}>{t.quote}</div>
            )}
            {t.comments.map((c) => (
              <CommentItem key={c.id} c={c} pageId={pageId} canComment={canComment} canModerate={canModerate} />
            ))}
            {canComment && !t.resolved && (
              <div className="cm-composer">
                <Composer
                  placeholder="Reply…"
                  onSubmit={async (body) => {
                    await post(`/pages/${pageId}/comments`, { body, threadId: t.id });
                    refresh();
                  }}
                />
              </div>
            )}
            {canComment && (
              <div className="cm-thread-footer">
                <button
                  className="btn sm"
                  onClick={async () => {
                    await patch(`/threads/${t.id}`, { resolved: !t.resolved });
                    refresh();
                  }}
                >
                  {t.resolved ? <><RotateCcw size={13} /> Re-open</> : <><Check size={13} /> Resolve</>}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
