import { Sparkles } from 'lucide-react';
import { useAiStatus } from './sse';
import { useAiUi } from './store';

/** Sidebar entry for the Atrium AI panel (hidden when the server has no AI routes). */
export function AiNavItem() {
  const { data: status } = useAiStatus();
  const open = useAiUi((s) => s.open);
  if (!status) return null;
  return (
    <button className={`nav-item ${open ? 'active' : ''}`} onClick={() => useAiUi.getState().toggle()}>
      <span className="nav-icon"><Sparkles size={17} style={{ color: 'var(--ai, #8b5cf6)' }} /></span>
      Atrium AI
      <span className="kbd" style={{ marginLeft: 'auto' }}>Ctrl+J</span>
    </button>
  );
}
