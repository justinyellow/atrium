import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronsRight, Maximize2, Link as LinkIcon } from 'lucide-react';
import { PageContent } from '../components/PageView';
import { toast } from '../components/ui';
import './database.css';

/** Notion-style side peek for a database row. */
export function RowPeek({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try { return Number(localStorage.getItem('atrium:peekWidth')) || Math.min(760, window.innerWidth * 0.5); } catch { return 640; }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      // Let editors/popovers handle Escape first.
      if (document.querySelector('.popover, .cell-overlay, .bn-suggestion-menu')) return;
      if (t.closest?.('.bn-editor') && window.getSelection()?.toString()) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let w = w0;
    const move = (ev: MouseEvent) => { w = Math.max(380, Math.min(window.innerWidth - 120, w0 - (ev.clientX - x0))); setWidth(w); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('atrium:peekWidth', String(w)); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  return (
    <div className="row-peek" ref={ref} style={{ width }}>
      <div className="peek-resizer" onMouseDown={startResize} />
      <div className="peek-top">
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><ChevronsRight size={18} /></button>
        <button className="icon-btn" title="Open as full page" onClick={() => { onClose(); navigate(`/p/${rowId}`); }}><Maximize2 size={15} /></button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Copy link" onClick={() => {
          navigator.clipboard?.writeText(`${location.origin}/p/${rowId}`);
          toast('Link copied');
        }}><LinkIcon size={15} /></button>
      </div>
      <div className="peek-scroll">
        <PageContent pageId={rowId} peek />
      </div>
    </div>
  );
}
