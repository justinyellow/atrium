import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { RotateCcw, Search, Trash2 } from 'lucide-react';
import { del, get, post, queryClient } from '../lib/api';
import { PageIcon, Popover, timeAgo, toast } from './ui';
import './collab.css';

interface TrashItem {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  deleted_at: string;
  parent_title: string | null;
  deleted_by_name: string | null;
}

export function TrashPopover({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const nav = useNavigate();
  const { data = [], isLoading } = useQuery({
    queryKey: ['trash', q],
    queryFn: () => get<TrashItem[]>(`/trash${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    enabled: open,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['trash'] });
    queryClient.invalidateQueries({ queryKey: ['tree'] });
  };
  const restore = async (it: TrashItem) => {
    try {
      await post(`/pages/${it.id}/restore`);
      queryClient.invalidateQueries({ queryKey: ['page', it.id] });
      toast(`Restored ${it.title || 'Untitled'}`);
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const destroy = async (it: TrashItem) => {
    try {
      await del(`/pages/${it.id}/permanent`);
      setConfirm(null);
      toast('Deleted permanently');
      refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="right-start" width={420}>
      <div className="trash-search">
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 28 }} autoFocus placeholder="Search pages in Trash" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {isLoading && <div className="spinner" style={{ margin: 16 }} />}
        {!isLoading && !data.length && (
          <div className="empty-state" style={{ padding: 30 }}>
            <Trash2 size={28} strokeWidth={1.2} />
            <div style={{ marginTop: 6 }}>{q ? 'No matches in Trash' : 'Trash is empty'}</div>
          </div>
        )}
        {data.map((it) => (
          <div
            key={it.id}
            className="trash-item"
            onClick={() => {
              onClose();
              nav(`/p/${it.id}`);
            }}
          >
            <PageIcon icon={it.icon} kind={it.kind} size={18} />
            <div className="info">
              <div className="n">{it.title || 'Untitled'}</div>
              <div className="s">
                {it.parent_title ? `${it.parent_title} · ` : ''}Deleted {timeAgo(it.deleted_at).toLowerCase()}
                {it.deleted_by_name ? ` by ${it.deleted_by_name}` : ''}
              </div>
            </div>
            {confirm === it.id ? (
              <div className="trash-confirm" onClick={(e) => e.stopPropagation()}>
                <span className="faint">Delete forever?</span>
                <button className="btn sm danger" onClick={() => destroy(it)}>Delete</button>
                <button className="btn sm" onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            ) : (
              <>
                <button className="icon-btn" title="Restore" onClick={(e) => { e.stopPropagation(); restore(it); }}>
                  <RotateCcw size={15} />
                </button>
                <button className="icon-btn" title="Delete permanently" onClick={(e) => { e.stopPropagation(); setConfirm(it.id); }}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="menu-footer" style={{ borderTop: '1px solid var(--border)', marginTop: 4 }}>
        Pages in Trash keep their sub-pages. Restoring brings them back to their original location.
      </div>
    </Popover>
  );
}
