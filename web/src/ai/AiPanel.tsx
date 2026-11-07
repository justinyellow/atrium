import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Sparkles, X, Plus, History, ArrowUp, Square, Copy, FileDown, Check, Loader2, AlertCircle, ChevronDown, ChevronRight,
  FileText, Trash2, Bot, MessageCircle,
} from 'lucide-react';
import { del, get, put, queryClient } from '../lib/api';
import { usePage } from '../lib/hooks';
import { useUi } from '../lib/store';
import { PageIcon, timeAgo, toast } from '../components/ui';
import type { AiCitation, AiConversation, AiConversationSummary, AiToolCall, AiToolResult } from './contract';
import { aiErrorMessage, AiError, streamSSE, useAiStatus } from './sse';
import { Markdown } from './Markdown';
import { useAiUi } from './store';
import './ai.css';

interface Step { call: AiToolCall; result?: AiToolResult }
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  citations?: AiCitation[];
  steps?: Step[];
  confirm?: AiToolCall & { status: 'pending' | 'approved' | 'denied' };
  error?: string;
  streaming?: boolean;
}

const SUGGESTIONS: Record<'ask' | 'agent', string[]> = {
  ask: ['Summarize this page', 'What are the open action items across my pages?', 'What did we decide about the roadmap?', 'Explain this page to a new team member'],
  agent: ['Create a meeting notes page for tomorrow’s stand-up', 'Turn this page into a checklist of tasks', 'Draft a project brief from this page'],
};

function useCurrentPageId() {
  const loc = useLocation();
  return loc.pathname.match(/^\/p\/([0-9a-f-]{36})/)?.[1] ?? null;
}

function Steps({ steps }: { steps: Step[] }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const running = steps.some((s) => !s.result);
  return (
    <div className="ai-steps">
      <button className="ai-steps-toggle" onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {running ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
        {running ? steps[steps.length - 1].call.summary : `${steps.length} step${steps.length > 1 ? 's' : ''}`}
      </button>
      {open && steps.map((s) => (
        <div key={s.call.id} className={`ai-step ${s.result && !s.result.ok ? 'err' : ''}`}>
          {!s.result ? <Loader2 size={12} className="spin" /> : s.result.ok ? <Check size={12} /> : <AlertCircle size={12} />}
          <span>{s.result?.summary ?? s.call.summary}</span>
          {s.result?.pageId && (
            <a href={`/p/${s.result.pageId}`} onClick={(e) => { e.preventDefault(); nav(`/p/${s.result!.pageId}`); }}>Open</a>
          )}
        </div>
      ))}
    </div>
  );
}

export function AiPanel() {
  const nav = useNavigate();
  const { data: status, isLoading } = useAiStatus();
  const { pendingQuestion, close } = useAiUi();
  const pageId = useCurrentPageId();
  const { data: page } = usePage(pageId ?? undefined);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [mode, setMode] = useState<'ask' | 'agent'>('ask');
  const [usePageCtx, setUsePageCtx] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const agentsOn = !!status?.features?.agents;
  const chatOn = !!status?.enabled && !!status.features?.chat;
  const budgetOut = !!status?.budget && ((status.budget.limitUsd != null && status.budget.usedUsd >= status.budget.limitUsd) || (status.budget.userLimitUsd != null && status.budget.userUsedUsd >= status.budget.userLimitUsd));

  const history = useQuery({ queryKey: ['ai-conversations'], queryFn: () => get<AiConversationSummary[]>('/ai/conversations'), enabled: view === 'history' && chatOn });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs]);
  useEffect(() => {
    setTimeout(() => ta.current?.focus(), 50);
  }, [view]);
  // Close when another right-hand panel opens.
  useEffect(() => useUi.subscribe((s, prev) => {
    if ((s.comments && !prev.comments) || (s.peekRowId && !prev.peekRowId)) close();
  }), [close]);

  const patchLast = (fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));

  const handle = (event: string, data: any) => {
    switch (event) {
      case 'conversation':
        setConvId(data.id);
        queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
        break;
      case 'delta':
        patchLast((m) => ({ ...m, content: m.content + (data.text ?? '') }));
        break;
      case 'tool_call':
        patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { call: data }] }));
        break;
      case 'tool_result':
        patchLast((m) => ({ ...m, steps: (m.steps ?? []).some((s) => s.call.id === data.id) ? (m.steps ?? []).map((s) => (s.call.id === data.id ? { ...s, result: data } : s)) : [...(m.steps ?? []), { call: { id: data.id, name: 'action', summary: data.summary }, result: data }] }));
        if (data.pageId) queryClient.invalidateQueries({ queryKey: ['tree'] });
        break;
      case 'confirm':
        patchLast((m) => ({ ...m, confirm: { ...data, status: 'pending' } }));
        break;
      case 'citations':
        patchLast((m) => ({ ...m, citations: data.pages ?? [] }));
        break;
      case 'done':
        queryClient.invalidateQueries({ queryKey: ['ai-status'] });
        break;
    }
  };

  const runStream = async (path: string, body: unknown) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    try {
      await streamSSE(path, body, handle, ctrl.signal);
    } catch (e) {
      if ((e as any)?.name !== 'AbortError') patchLast((m) => ({ ...m, error: aiErrorMessage(e) }));
      if (e instanceof AiError && e.status === 402) queryClient.invalidateQueries({ queryKey: ['ai-status'] });
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setDraft('');
    setView('chat');
    setMsgs((all) => [...all, { role: 'user', content: message }, { role: 'assistant', content: '', streaming: true }]);
    runStream('/ai/chat', { conversationId: convId, message, pageId: usePageCtx ? pageId : null, mode: agentsOn ? mode : 'ask' });
  };

  const confirm = (approve: boolean) => {
    const last = msgs[msgs.length - 1];
    if (!last?.confirm || !convId) return;
    patchLast((m) => ({ ...m, confirm: { ...m.confirm!, status: approve ? 'approved' : 'denied' }, streaming: true }));
    runStream(`/ai/chat/${convId}/confirm`, { toolCallId: last.confirm.id, approve });
  };

  // Ctrl+K "Ask AI: …" hands a question over.
  useEffect(() => {
    if (pendingQuestion && chatOn) {
      useAiUi.setState({ pendingQuestion: null });
      newChat();
      setTimeout(() => send(pendingQuestion), 0);
    }
  }, [pendingQuestion, chatOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = () => {
    abort.current?.abort();
    setMsgs([]);
    setConvId(null);
    setView('chat');
  };

  const openConversation = async (id: string) => {
    try {
      const c = await get<AiConversation & { pending?: AiToolCall[] }>(`/ai/conversations/${id}`);
      setConvId(c.id);
      setMode(c.mode);
      const restored: Msg[] = c.messages.map((m) => ({ role: m.role, content: m.content, citations: m.citations, steps: m.steps }));
      // Tool calls still awaiting approval show as a confirm card on the last answer.
      if (c.pending?.length) {
        if (restored[restored.length - 1]?.role !== 'assistant') restored.push({ role: 'assistant', content: '' });
        restored[restored.length - 1] = { ...restored[restored.length - 1], confirm: { ...c.pending[0], status: 'pending' } };
      }
      setMsgs(restored);
      setView('chat');
    } catch (e: any) {
      toast(e.message);
    }
  };

  const insertIntoPage = async (markdown: string) => {
    if (!pageId) return;
    try {
      await put(`/pages/${pageId}/content`, { markdown, mode: 'append' });
      toast('Added to the end of the page');
    } catch (e: any) {
      toast(e.message);
    }
  };

  const canInsert = !!pageId && !!page && ['edit', 'full'].includes(page.level) && !page.locked && page.kind !== 'database';

  let notice: React.ReactNode = null;
  if (!isLoading && !status) notice = <>Atrium AI isn’t available on this server yet.</>;
  else if (status && !status.enabled) notice = <>Atrium AI is turned off for this workspace{status.reason ? ` — ${status.reason}` : ''}. An admin can enable it in Settings → AI.</>;
  else if (status && !status.features?.chat) notice = <>AI chat is turned off for this workspace.</>;

  return (
    <aside className="side-panel ai-panel" aria-label="Atrium AI">
      <div className="side-panel-header">
        <span className="ai-panel-title"><Sparkles size={16} className="ai-sparkle" /> Atrium AI</span>
        {chatOn && <button className={`icon-btn ${view === 'history' ? 'active' : ''}`} title="Chat history" onClick={() => setView(view === 'history' ? 'chat' : 'history')}><History size={16} /></button>}
        {chatOn && <button className="icon-btn" title="New chat" onClick={newChat}><Plus size={16} /></button>}
        <button className="icon-btn" title="Close (Ctrl+J)" onClick={close}><X size={16} /></button>
      </div>

      {notice ? (
        <div className="ai-scroll"><div className="ai-notice"><Sparkles size={22} className="ai-sparkle" />{notice}{status?.enabled === false && <button className="btn sm" onClick={() => useUi.getState().set({ settings: 'ai' })}>Open AI settings</button>}</div></div>
      ) : view === 'history' ? (
        <div className="ai-history">
          {history.isLoading && <div className="menu-footer">Loading…</div>}
          {history.data && !history.data.length && <div className="menu-footer">No conversations yet.</div>}
          {history.data?.map((c) => (
            <div key={c.id} className="ai-history-item" role="button" tabIndex={0} onClick={() => openConversation(c.id)} onKeyDown={(e) => e.key === 'Enter' && openConversation(c.id)}>
              {c.mode === 'agent' ? <Bot size={15} className="ai-sparkle" /> : <MessageCircle size={15} className="ai-sparkle" />}
              <span className="t">{c.title || 'Untitled chat'}</span>
              <span className="faint" style={{ fontSize: 12 }}>{timeAgo(c.updated_at)}</span>
              <button className="icon-btn" title="Delete" onClick={async (e) => { e.stopPropagation(); await del(`/ai/conversations/${c.id}`); if (c.id === convId) newChat(); history.refetch(); }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="ai-scroll" ref={scroller}>
          {!msgs.length && (
            <div className="ai-empty">
              <h3><Sparkles size={18} className="ai-sparkle" /> How can I help?</h3>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                {mode === 'agent' ? 'Agent mode can create and edit pages for you. It asks before deleting anything.' : 'Ask about anything in your workspace — answers link to the pages they come from.'}
              </div>
              {SUGGESTIONS[mode].filter((q) => pageId || !/this page/i.test(q)).map((q) => (
                <button key={q} className="ai-suggest" onClick={() => send(q)}>{q}</button>
              ))}
            </div>
          )}
          {msgs.map((m, i) => m.role === 'user' ? (
            <div key={i} className="ai-msg-user">{m.content}</div>
          ) : (
            <div key={i} className="ai-msg-ai">
              <Steps steps={m.steps ?? []} />
              {m.content ? <Markdown text={m.content} /> : m.streaming && !m.confirm ? <div className="ai-thinking"><Sparkles size={14} className="ai-sparkle" /> Thinking…</div> : null}
              {m.confirm && (
                <div className="ai-confirm">
                  <div><strong>Approval needed:</strong> {m.confirm.summary}</div>
                  {m.confirm.status === 'pending' ? (
                    <div className="ai-confirm-actions">
                      <button className="btn sm primary" disabled={busy} onClick={() => confirm(true)}>Approve</button>
                      <button className="btn sm" disabled={busy} onClick={() => confirm(false)}>Deny</button>
                    </div>
                  ) : <div className="faint">{m.confirm.status === 'approved' ? 'Approved' : 'Denied'}</div>}
                </div>
              )}
              {m.error && <div className="ai-error"><AlertCircle size={13} style={{ verticalAlign: -2 }} /> {m.error}</div>}
              {!!m.citations?.length && (
                <div className="ai-cites">
                  {m.citations.map((c) => (
                    <span key={c.id} className="ai-cite" role="link" tabIndex={0} title={c.title} onClick={() => nav(`/p/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/p/${c.id}`)}>
                      <PageIcon icon={c.icon ?? null} size={13} /><span>{c.title || 'Untitled'}</span>
                    </span>
                  ))}
                </div>
              )}
              {!m.streaming && m.content && (
                <div className="ai-msg-actions">
                  <button className="icon-btn" title="Copy" onClick={() => { navigator.clipboard?.writeText(m.content); toast('Copied'); }}><Copy size={14} /></button>
                  {canInsert && <button className="icon-btn" title={`Insert into “${page?.title || 'Untitled'}”`} onClick={() => insertIntoPage(m.content)}><FileDown size={14} /></button>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!notice && view === 'chat' && (
        <div className="ai-compose">
          {budgetOut && <div className="ai-error">The AI budget for this month has been used up.</div>}
          <div className="ai-compose-box">
            <textarea
              ref={ta}
              rows={1}
              placeholder={mode === 'agent' ? 'Ask the agent to do something…' : 'Ask anything about your workspace…'}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              aria-label="Message Atrium AI"
            />
            <div className="ai-compose-row">
              {pageId && page && (
                <button className={`ai-chip ${usePageCtx ? 'on' : ''}`} title={usePageCtx ? 'The current page is included as context' : 'Include the current page'} onClick={() => setUsePageCtx(!usePageCtx)}>
                  <FileText size={12} /><span>{page.title || 'Untitled'}</span>{usePageCtx && <X size={11} />}
                </button>
              )}
              <span style={{ flex: 1 }} />
              {agentsOn && (
                <div className="ai-mode" role="radiogroup" aria-label="Mode">
                  <button role="radio" aria-checked={mode === 'ask'} className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>Ask</button>
                  <button role="radio" aria-checked={mode === 'agent'} className={mode === 'agent' ? 'on' : ''} onClick={() => setMode('agent')}>Agent</button>
                </div>
              )}
              {busy ? (
                <button className="ai-icon-btn" title="Stop" onClick={() => abort.current?.abort()}><Square size={12} fill="currentColor" /></button>
              ) : (
                <button className="ai-icon-btn" title="Send" disabled={!draft.trim() || budgetOut} onClick={() => send(draft)}><ArrowUp size={14} /></button>
              )}
            </div>
          </div>
          {status?.budget?.userLimitUsd != null && (
            <div className="ai-budget">${(status.budget.userUsedUsd ?? 0).toFixed(2)} of ${status.budget.userLimitUsd.toFixed(2)} used this month</div>
          )}
        </div>
      )}
    </aside>
  );
}
