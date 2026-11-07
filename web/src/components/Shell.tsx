import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useMe, useLiveEvents } from '../lib/hooks';
import { applyTheme, useUi } from '../lib/store';
import Sidebar, { createPageAndOpen } from './Sidebar';
import PageView from './PageView';
import Home from './Home';
import QuickFind from './QuickFind';
import { InboxPanel } from './Inbox';
import { SettingsModal } from './Settings';
import { CommentsPanel } from './Comments';
import { RowPeek } from '../database/RowPeek';
import { usePage } from '../lib/hooks';
import { AiPanel } from '../ai/AiPanel';
import { useAiUi } from '../ai/store';

function CommentsSide() {
  const comments = useUi((s) => s.comments);
  const { data: page } = usePage(comments?.pageId);
  if (!comments || !page) return null;
  return <CommentsPanel key={comments.pageId} pageId={comments.pageId} level={page.level} threadId={comments.threadId} onClose={() => useUi.getState().set({ comments: null })} />;
}

export default function Shell() {
  const { data: me } = useMe();
  const ui = useUi();
  const aiOpen = useAiUi((s) => s.open);
  const nav = useNavigate();
  const loc = useLocation();
  useLiveEvents(!!me);

  useEffect(() => {
    if (me?.theme) applyTheme(me.theme);
  }, [me?.theme]);

  // Deep links from emails, e.g. /?settings=notifications
  useEffect(() => {
    const tab = new URLSearchParams(loc.search).get('settings');
    if (tab) useUi.getState().set({ settings: tab });
  }, [loc.search]);

  // Close transient panels on navigation.
  useEffect(() => {
    useUi.getState().set({ peekRowId: null });
    const c = useUi.getState().comments;
    if (c && !loc.pathname.includes(c.pageId)) useUi.getState().set({ comments: null });
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'p') && !e.shiftKey) {
        e.preventDefault();
        useUi.getState().set({ quickFind: true });
      } else if (mod && e.key.toLowerCase() === 'j' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useAiUi.getState().toggle();
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        const s = useUi.getState();
        s.setSidebarOpen(!s.sidebarOpen);
      } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createPageAndOpen(nav, {});
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
      } else if (e.key === 'Escape' && useUi.getState().peekRowId && !document.querySelector('.popover, .modal')) {
        useUi.getState().set({ peekRowId: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);

  if (!me) return null;
  return (
    <div className="app">
      <Sidebar />
      {ui.inbox && <InboxPanel onClose={() => ui.set({ inbox: false })} />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/p/:id" element={<PageView />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <CommentsSide />
      {aiOpen && <AiPanel />}
      {ui.peekRowId && <RowPeek key={ui.peekRowId} rowId={ui.peekRowId} onClose={() => ui.set({ peekRowId: null })} />}
      {ui.quickFind && <QuickFind onClose={() => ui.set({ quickFind: false })} />}
      <SettingsModal tab={ui.settings} onClose={() => ui.set({ settings: null })} />
    </div>
  );
}
