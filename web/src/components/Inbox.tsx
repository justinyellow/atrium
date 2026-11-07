import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Archive, ArchiveRestore, CheckCheck, Inbox as InboxIcon, X } from 'lucide-react';
import { get, post, queryClient } from '../lib/api';
import { useUi } from '../lib/store';
import { Avatar, PageIcon, timeAgo } from './ui';
import './collab.css';

interface Notification {
  id: string;
  type: 'mention' | 'comment' | 'reply' | 'share' | 'assigned' | 'reminder';
  data: { threadId?: string; commentId?: string; body?: string; level?: string };
  read_at: string | null;
  created_at: string;
  archived: boolean;
  page_id: string | null;
  actor: { id: string | null; name: string | null; avatar_url: string | null };
  page_title: string | null;
  page_icon: string | null;
}

const VERB: Record<Notification['type'], string> = {
  mention: 'mentioned you in',
  comment: 'commented on',
  reply: 'replied in',
  share: 'shared',
  assigned: 'assigned you to',
  reminder: 'reminder in',
};

const plain = (s: string) => s.replace(/@\[([^\]]*)\]\([0-9a-f-]{36}\)/g, '@$1');

export function InboxPanel({ onClose }: { onClose: () => void }) {
  const [archived, setArchived] = useState(false);
  const nav = useNavigate();
  const { data = [], isLoading } = useQuery({
    queryKey: ['notifications', archived],
    queryFn: () => get<Notification[]>(`/notifications?archived=${archived}`),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['unread'] });
  };
  const mark = async (body: any) => {
    await post('/notifications/read', body);
    refresh();
  };
  const open = (n: Notification) => {
    if (!n.read_at) mark({ ids: [n.id] });
    if (!n.page_id) return;
    nav(`/p/${n.page_id}`);
    if (n.data?.threadId || n.type === 'comment' || n.type === 'reply') {
      useUi.getState().set({ comments: { pageId: n.page_id, threadId: n.data?.threadId ?? null } });
    }
  };

  return (
    <div className="inbox-panel">
      <div className="side-panel-header">
        <span>{archived ? 'Archived' : 'Inbox'}</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {!archived && (
            <button className="icon-btn" title="Mark all as read" onClick={() => mark({ all: true })}><CheckCheck size={16} /></button>
          )}
          <button className="icon-btn" title={archived ? 'Show inbox' : 'Show archived'} onClick={() => setArchived(!archived)}>
            {archived ? <InboxIcon size={16} /> : <ArchiveRestore size={16} />}
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading && <div className="empty-state"><div className="spinner" style={{ margin: '0 auto' }} /></div>}
        {!isLoading && !data.length && (
          <div className="empty-state">
            <InboxIcon size={32} strokeWidth={1.2} style={{ marginBottom: 8 }} />
            <div>{archived ? 'No archived notifications' : "You're all caught up"}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Mentions, comments and invites will show up here.</div>
          </div>
        )}
        {data.map((n) => (
          <div key={n.id} className="inbox-item" onClick={() => open(n)}>
            {!n.read_at && <span className="dot" />}
            <Avatar user={n.actor?.name ? { id: n.actor.id ?? undefined, name: n.actor.name, avatar_url: n.actor.avatar_url } : { name: '?' }} size={28} />
            <div className="body">
              <div>
                {n.type === 'reminder' ? <b>⏰ Reminder in</b> : <><b>{n.actor?.name ?? 'Someone'}</b> {VERB[n.type] ?? n.type}</>}{' '}
                <span className="page">
                  <PageIcon icon={n.page_icon} size={14} /> {n.page_title || 'Untitled'}
                </span>
                {n.type === 'share' && ' with you'}
              </div>
              {n.data?.body && <div className="snippet">{plain(n.data.body)}</div>}
              <div className="t">{timeAgo(n.created_at)}</div>
            </div>
            {!archived && (
              <button
                className="icon-btn archive"
                title="Archive"
                onClick={(e) => {
                  e.stopPropagation();
                  mark({ ids: [n.id], archive: true });
                }}
              >
                <Archive size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
