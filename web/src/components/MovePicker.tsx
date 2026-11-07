import { useState } from 'react';
import { Lock } from 'lucide-react';
import { post, queryClient } from '../lib/api';
import { useTree } from '../lib/hooks';
import { MenuItem, PageIcon, Popover, toast } from './ui';

export function MovePicker({ pageId, anchor, onClose }: { pageId: string; anchor: HTMLElement | null; onClose: () => void }) {
  const { data: tree } = useTree();
  const [q, setQ] = useState('');
  const move = async (body: any, label: string) => {
    try {
      await post(`/pages/${pageId}/move`, body);
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      toast(`Moved to ${label}`);
    } catch (e: any) {
      toast(e.message);
    }
    onClose();
  };
  const term = q.toLowerCase();
  const pages = (tree?.pages ?? []).filter(
    (p) => p.id !== pageId && p.kind === 'page' && ['edit', 'full'].includes(p.level) && (p.title || 'Untitled').toLowerCase().includes(term),
  );
  return (
    <Popover anchor={anchor} open onClose={onClose} width={320}>
      <input className="input" autoFocus placeholder="Move page to…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 4 }} />
      {!q && (
        <>
          <div className="menu-heading">Spaces</div>
          <MenuItem icon={<Lock size={15} />} onClick={() => move({ parentId: null }, 'Private')}>Private</MenuItem>
          {tree?.teamspaces.map((t) => (
            <MenuItem key={t.id} icon={<span className="emoji">{t.icon}</span>} onClick={() => move({ parentId: null, teamspaceId: t.id }, t.name)}>{t.name}</MenuItem>
          ))}
          <div className="menu-heading">Pages</div>
        </>
      )}
      {pages.slice(0, 50).map((p) => (
        <MenuItem key={p.id} icon={<PageIcon icon={p.icon} kind={p.kind} size={16} />} onClick={() => move({ parentId: p.id }, p.title || 'Untitled')}>{p.title || 'Untitled'}</MenuItem>
      ))}
      {!pages.length && <div className="menu-footer">No matching pages</div>}
    </Popover>
  );
}
