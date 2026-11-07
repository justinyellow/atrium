import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, CornerDownLeft, Plus, Sparkles } from 'lucide-react';
import { useAiFeature } from '../ai/sse';
import { useAiUi } from '../ai/store';
import { get } from '../lib/api';
import { Modal, PageIcon, timeAgo } from './ui';
import { createPageAndOpen } from './Sidebar';

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export default function QuickFind({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 120);
    return () => clearTimeout(t);
  }, [q]);
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => get('/recent'), staleTime: 0 });
  const results = useQuery({ queryKey: ['search', debounced], queryFn: () => get(`/search?q=${encodeURIComponent(debounced)}`), enabled: !!debounced });
  const items: any[] = debounced ? results.data ?? [] : recent.data ?? [];
  useEffect(() => setSel(0), [debounced]);

  const open = (id: string) => {
    onClose();
    nav(`/p/${id}`);
  };
  const aiOn = useAiFeature('chat');
  const aiIdx = debounced && aiOn ? items.length : -1;
  const newIdx = debounced ? items.length + (aiIdx >= 0 ? 1 : 0) : -1;
  const total = items.length + (debounced ? 1 : 0) + (aiIdx >= 0 ? 1 : 0);
  const askAi = () => { onClose(); useAiUi.getState().openPanel(q.trim()); };
  return (
    <Modal open onClose={onClose} width={620} className="quickfind">
      <div className="qf-input">
        <Search size={18} className="faint" />
        <input
          autoFocus
          placeholder="Search or jump to…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, total - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (sel < items.length) items[sel] && open(items[sel].id);
              else if (sel === aiIdx) askAi();
              else if (sel === newIdx) { onClose(); createPageAndOpen(nav, { title: q }); }
            }
          }}
        />
        {results.isFetching && <div className="spinner" />}
      </div>
      <div className="qf-results">
        <div className="menu-heading">{debounced ? 'Best matches' : 'Recent'}</div>
        {items.map((r, i) => (
          <div key={r.id} className={`qf-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(r.id)}>
            <PageIcon icon={r.icon} kind={r.kind} size={20} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="qf-title">
                {highlight(r.title || 'Untitled', debounced)}
                {r.parent_title && <span className="faint" style={{ fontWeight: 400 }}> — {r.parent_title}</span>}
              </div>
              {r.snippet && <div className="qf-snippet">{highlight(r.snippet, debounced)}</div>}
            </div>
            <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{timeAgo(r.visited_at ?? r.updated_at)}</span>
            {i === sel && <CornerDownLeft size={14} className="faint" />}
          </div>
        ))}
        {debounced && !results.isFetching && !items.length && <div className="menu-footer" style={{ padding: '8px 12px' }}>No results</div>}
        {aiIdx >= 0 && (
          <div className={`qf-item ${sel === aiIdx ? 'sel' : ''}`} onMouseEnter={() => setSel(aiIdx)} onClick={askAi}>
            <Sparkles size={18} style={{ color: 'var(--ai, #8b5cf6)' }} />
            <div className="qf-title">Ask AI: “{q.trim()}”</div>
          </div>
        )}
        {debounced && (
          <div className={`qf-item ${sel === newIdx ? 'sel' : ''}`} onMouseEnter={() => setSel(newIdx)} onClick={() => { onClose(); createPageAndOpen(nav, { title: q }); }}>
            <Plus size={18} className="faint" />
            <div className="qf-title">New page "{q}"</div>
          </div>
        )}
      </div>
      <div className="qf-footer"><span>↑↓ Select</span><span>↵ Open</span><span>Esc Close</span></div>
    </Modal>
  );
}
