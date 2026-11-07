import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { History as HistoryIcon, X } from 'lucide-react';
import { get, post, queryClient } from '../lib/api';
import { Avatar, Modal, timeAgo, toast } from './ui';
import './collab.css';

interface Version {
  id: string;
  title: string;
  created_at: string;
  author_name: string | null;
  author_avatar: string | null;
}

const DEFAULT_TYPES = new Set([
  'paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem', 'quote',
  'codeBlock', 'table', 'image', 'video', 'audio', 'file', 'divider', 'pageBreak',
]);

/** Convert custom block / inline types to default ones so a vanilla editor can render them. */
function sanitize(blocks: any[]): any[] {
  return (blocks ?? []).map((b) => {
    const children = sanitize(b.children ?? []);
    const content = Array.isArray(b.content)
      ? b.content.map((c: any) =>
          c.type === 'mention'
            ? { type: 'text', text: `${c.props?.kind === 'user' ? '@' : ''}${c.props?.label || 'Untitled'}`, styles: { bold: c.props?.kind === 'page' } }
            : c.type === 'text' && c.styles?.comment
              ? { ...c, styles: Object.fromEntries(Object.entries(c.styles).filter(([k]) => k !== 'comment')) }
              : c,
        )
      : b.content;
    if (b.type === 'subpage') return { type: 'paragraph', content: [{ type: 'text', text: `📄 ${b.props?.title || 'Untitled'}`, styles: { underline: true } }], children };
    if (b.type === 'callout') return { type: 'quote', content, children };
    if (b.type === 'toc') return { type: 'paragraph', content: [{ type: 'text', text: 'Table of contents', styles: { italic: true } }], children };
    if (!DEFAULT_TYPES.has(b.type)) return { type: 'paragraph', content: Array.isArray(content) ? content : [], children };
    return { ...b, content, children };
  });
}

function Preview({ blocks }: { blocks: any[] }) {
  const editor = useCreateBlockNote({ initialContent: blocks.length ? blocks : undefined });
  const dark = document.documentElement.classList.contains('dark');
  return <BlockNoteView editor={editor} editable={false} theme={dark ? 'dark' : 'light'} sideMenu={false} slashMenu={false} formattingToolbar={false} />;
}

export function HistoryModal({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const versions = useQuery({
    queryKey: ['versions', pageId],
    queryFn: () => get<Version[]>(`/pages/${pageId}/versions`),
    enabled: open,
  });
  useEffect(() => {
    if (open && versions.data?.length && !versions.data.some((v) => v.id === sel)) setSel(versions.data[0].id);
  }, [open, versions.data, sel]);
  const version = useQuery({
    queryKey: ['version', pageId, sel],
    queryFn: () => get<{ title: string; blocks: any[] }>(`/pages/${pageId}/versions/${sel}`),
    enabled: open && !!sel,
  });

  const restore = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await post(`/pages/${pageId}/versions/${sel}/restore`);
      toast('Version restored');
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['versions', pageId] });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      onClose();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={1100}>
      <div className="history">
        <div className="history-preview">
          {version.isLoading && <div className="spinner" />}
          {version.data && (
            <>
              <h1>{version.data.title || 'Untitled'}</h1>
              <Preview key={sel} blocks={sanitize(version.data.blocks)} />
            </>
          )}
          {!versions.isLoading && !versions.data?.length && (
            <div className="empty-state">
              <HistoryIcon size={32} strokeWidth={1.2} />
              <div style={{ marginTop: 8 }}>No versions yet</div>
              <div style={{ fontSize: 12 }}>Snapshots are saved automatically every 10 minutes while a page is being edited.</div>
            </div>
          )}
        </div>
        <div className="history-list">
          <div className="side-panel-header" style={{ fontSize: 14 }}>
            <span>Version history</span>
            <button className="icon-btn" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="items">
            {versions.data?.map((v) => (
              <button key={v.id} className={`history-item ${sel === v.id ? 'on' : ''}`} onClick={() => setSel(v.id)}>
                <div className="d">
                  {new Date(v.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
                <div className="a">
                  <Avatar user={{ name: v.author_name ?? '?', avatar_url: v.author_avatar }} size={16} />
                  {v.author_name ?? 'Unknown'} · {timeAgo(v.created_at)}
                </div>
              </button>
            ))}
          </div>
          <div className="history-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!sel || busy} onClick={restore}>Restore version</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
