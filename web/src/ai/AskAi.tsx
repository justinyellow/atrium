import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useComponentsContext } from '@blocknote/react';
import {
  Sparkles, Wand2, SpellCheck, Minimize2, Maximize2, Mic2, Languages, ListCollapse, HelpCircle, PenLine,
  ListTree, Lightbulb, ListChecks, FileText, ChevronRight, ArrowUp, Square, RotateCcw, Check, CornerDownLeft, X,
} from 'lucide-react';
import { Popover } from '../components/ui';
import type { AiMenuAction, AiWriteRequest } from './contract';
import { aiErrorMessage, streamSSE, useAiFeature } from './sse';
import { Markdown } from './Markdown';
import './ai.css';

type Mode = 'selection' | 'cursor';
interface Item { id: string; label: string; icon: React.ReactNode; action?: AiMenuAction; tone?: string; language?: string; sub?: 'tone' | 'translate' }

const TONES = ['Professional', 'Casual', 'Friendly', 'Confident', 'Direct'];
const LANGS = ['English', 'Afrikaans', 'isiZulu', 'French', 'Portuguese', 'Spanish', 'German', 'Swahili', 'Arabic', 'Chinese', 'Japanese', 'Hindi'];

const SELECTION_ITEMS: Item[] = [
  { id: 'improve', label: 'Improve writing', icon: <Wand2 size={15} />, action: 'improve' },
  { id: 'fix', label: 'Fix spelling & grammar', icon: <SpellCheck size={15} />, action: 'fix' },
  { id: 'shorter', label: 'Make shorter', icon: <Minimize2 size={15} />, action: 'shorter' },
  { id: 'longer', label: 'Make longer', icon: <Maximize2 size={15} />, action: 'longer' },
  { id: 'tone', label: 'Change tone', icon: <Mic2 size={15} />, sub: 'tone' },
  { id: 'translate', label: 'Translate', icon: <Languages size={15} />, sub: 'translate' },
  { id: 'summarize', label: 'Summarize', icon: <ListCollapse size={15} />, action: 'summarize' },
  { id: 'explain', label: 'Explain this', icon: <HelpCircle size={15} />, action: 'explain' },
  { id: 'continue', label: 'Continue writing', icon: <PenLine size={15} />, action: 'continue' },
];
const CURSOR_ITEMS: Item[] = [
  { id: 'continue', label: 'Continue writing', icon: <PenLine size={15} />, action: 'continue' },
  { id: 'summarize_page', label: 'Summarize this page', icon: <ListCollapse size={15} />, action: 'summarize_page' },
  { id: 'outline', label: 'Draft an outline', icon: <ListTree size={15} />, action: 'outline' },
  { id: 'brainstorm', label: 'Brainstorm ideas', icon: <Lightbulb size={15} />, action: 'brainstorm' },
  { id: 'action_items', label: 'Find action items', icon: <ListChecks size={15} />, action: 'action_items' },
  { id: 'translate', label: 'Translate page', icon: <Languages size={15} />, sub: 'translate' },
];

/** Toolbar button. mousedown-preventDefault keeps the editor's selection, same as the Comment button. */
export function AskAiToolbarButton({ onClick }: { onClick: () => void }) {
  const Components = useComponentsContext()!;
  return (
    <span style={{ display: 'contents' }} onMouseDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>
      <Components.FormattingToolbar.Button mainTooltip="Ask AI" icon={<Sparkles size={16} className="ai-sparkle" />} onClick={() => {}} label="Ask AI" />
    </span>
  );
}

export interface AskAiHandle {
  open: (mode: Mode) => void;
}

interface Session {
  mode: Mode;
  x: number;
  y: number;
  from: number;
  to: number;
  text: string;
  blockIds: string[];
}

/** The floating "Ask AI" menu + streamed preview, mounted once per editor. */
export const AskAi = forwardRef<AskAiHandle, { editor: any; pageId: string; enabled: boolean }>(function AskAi({ editor, pageId, enabled }, ref) {
  const [s, setS] = useState<Session | null>(null);
  const [query, setQuery] = useState('');
  const [sub, setSub] = useState<'tone' | 'translate' | null>(null);
  const [hi, setHi] = useState(0);
  const [out, setOut] = useState('');
  const [phase, setPhase] = useState<'menu' | 'streaming' | 'done' | 'error'>('menu');
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const lastReq = useRef<AiWriteRequest | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const writeOn = useAiFeature('write');

  const reset = () => {
    abort.current?.abort();
    setS(null);
    setQuery('');
    setSub(null);
    setHi(0);
    setOut('');
    setPhase('menu');
    setError('');
  };

  const open = (mode: Mode) => {
    if (!enabled || !writeOn) return;
    const sel = editor.prosemirrorState.selection;
    if (mode === 'selection' && sel.empty) return;
    const view = editor.prosemirrorView;
    const start = view.coordsAtPos(sel.from);
    const end = view.coordsAtPos(sel.to);
    const blocks = (mode === 'selection' ? editor.getSelection()?.blocks : null) ?? [editor.getTextCursorPosition().block];
    setS({
      mode, x: start.left, y: end.bottom + 6, from: sel.from, to: sel.to,
      text: mode === 'selection' ? editor.getSelectedText() : '',
      blockIds: blocks.map((b: any) => b.id),
    });
    setQuery('');
    setSub(null);
    setHi(0);
    setOut('');
    setPhase('menu');
    setTimeout(() => input.current?.focus(), 80);
  };
  useImperativeHandle(ref, () => ({ open }));

  // Space on an empty line opens the menu (Notion behaviour); only when AI writing is available.
  useEffect(() => {
    if (!enabled || !writeOn) return;
    const dom: HTMLElement | undefined = editor.prosemirrorView?.dom;
    if (!dom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const sel = editor.prosemirrorState.selection;
      if (!sel.empty) return;
      const b = editor.getTextCursorPosition().block;
      if (b.type !== 'paragraph' || (Array.isArray(b.content) && b.content.length)) return;
      e.preventDefault();
      open('cursor');
    };
    dom.addEventListener('keydown', onKey, true);
    return () => dom.removeEventListener('keydown', onKey, true);
  }, [editor, enabled, writeOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    if (!s) return [];
    if (sub === 'tone') return TONES.map((t): Item => ({ id: `tone-${t}`, label: t, icon: <Mic2 size={15} />, action: 'tone', tone: t.toLowerCase() }));
    if (sub === 'translate') return LANGS.map((l): Item => ({ id: `lang-${l}`, label: l, icon: <Languages size={15} />, action: 'translate', language: l }));
    const base = s.mode === 'selection' ? SELECTION_ITEMS : CURSOR_ITEMS;
    const q = query.trim().toLowerCase();
    return q ? base.filter((i) => i.label.toLowerCase().includes(q)) : base;
  }, [s, sub, query]);

  const run = async (req: AiWriteRequest) => {
    lastReq.current = req;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setOut('');
    setError('');
    setPhase('streaming');
    let acc = '';
    try {
      await streamSSE('/ai/write', req, (event, data) => {
        if (event === 'delta' && typeof data?.text === 'string') {
          acc += data.text;
          setOut(acc);
        }
      }, ctrl.signal);
      setPhase(acc.trim() ? 'done' : 'error');
      if (!acc.trim()) setError('The AI returned an empty response. Try again.');
    } catch (e) {
      if ((e as any)?.name === 'AbortError') {
        setPhase(acc.trim() ? 'done' : 'menu');
        return;
      }
      setError(aiErrorMessage(e));
      setPhase('error');
    }
  };

  const start = async (item: Item | null) => {
    if (!s) return;
    if (item?.sub) {
      setSub(item.sub);
      setHi(0);
      return;
    }
    let page = '';
    if (s.mode === 'cursor') {
      try {
        page = (await editor.blocksToMarkdownLossy(editor.document)).slice(0, 60_000);
      } catch {}
    }
    const extra = query.trim();
    const base = { pageId, tone: item?.tone, language: item?.language };
    const action = item?.action ?? 'custom';
    // Map menu items onto the server's write actions. The server adds the saved page as context for
    // continue / custom / explain; for whole-page actions the live page text is sent as the text to transform.
    const PROMPTS: Partial<Record<string, string>> = {
      outline: 'Draft a clear outline for this page as Markdown headings and bullet points.',
      brainstorm: 'Brainstorm 5–8 useful ideas related to this page, as a bullet list.',
      action_items: 'List the action items in this page as a Markdown checklist (- [ ] item). If there are none, suggest sensible next steps.',
    };
    let req: AiWriteRequest;
    if (s.mode === 'selection') req = { ...base, action: item ? (action as AiWriteRequest['action']) : 'custom', text: s.text, prompt: item ? extra || undefined : extra };
    else if (action === 'summarize_page') req = { ...base, action: 'summarize', text: page };
    else if (action === 'translate') req = { ...base, action: 'translate', text: page };
    else if (action === 'continue') req = { ...base, action: 'continue', text: page.slice(-4000) };
    else if (PROMPTS[action]) req = { ...base, action: 'custom', text: '', prompt: `${PROMPTS[action]}${extra ? ` ${extra}` : ''}` };
    else req = { ...base, action: 'custom', text: '', prompt: extra };
    run(req);
  };

  const parse = async (md: string) => {
    const blocks = await editor.tryParseMarkdownToBlocks(md.trim());
    return blocks.length ? blocks : [{ type: 'paragraph', content: md.trim() }];
  };

  const restoreSelection = () => {
    if (!s) return;
    editor._tiptapEditor?.commands.setTextSelection({ from: s.from, to: s.to });
  };

  const replaceSelection = async () => {
    if (!s) return;
    const blocks = await parse(out);
    restoreSelection();
    if (blocks.length === 1 && blocks[0].type === 'paragraph' && Array.isArray(blocks[0].content)) {
      editor.insertInlineContent(blocks[0].content);
    } else {
      editor._tiptapEditor?.commands.deleteSelection();
      const cur = editor.getTextCursorPosition().block;
      const empty = cur.type === 'paragraph' && Array.isArray(cur.content) && !cur.content.length;
      if (empty) editor.replaceBlocks([cur], blocks);
      else editor.insertBlocks(blocks, cur, 'after');
    }
    reset();
    editor.focus();
  };

  const insertBelow = async () => {
    if (!s) return;
    const blocks = await parse(out);
    const anchorId = s.blockIds[s.blockIds.length - 1];
    const anchor = editor.getBlock(anchorId) ?? editor.getTextCursorPosition().block;
    const empty = s.mode === 'cursor' && anchor.type === 'paragraph' && Array.isArray(anchor.content) && !anchor.content.length;
    if (empty) editor.replaceBlocks([anchor], blocks);
    else if (s.mode === 'cursor' && lastReq.current?.action === 'continue' && anchor.type === 'paragraph' && blocks.length === 1 && Array.isArray(blocks[0].content)) {
      editor.setTextCursorPosition(anchor, 'end');
      editor.insertInlineContent(blocks[0].content);
    } else editor.insertBlocks(blocks, anchor, 'after');
    reset();
    editor.focus();
  };

  if (!s) return null;
  const busy = phase === 'streaming';
  return (
    <Popover anchor={{ x: s.x, y: s.y }} open onClose={reset} width={440} className="ai-pop">
      {(phase !== 'menu') && (
        <div className="ai-preview">
          {out ? <Markdown text={out} /> : busy ? <div className="ai-thinking"><Sparkles size={14} className="ai-sparkle" /> AI is writing…</div> : null}
          {phase === 'error' && <div className="ai-error">{error}</div>}
        </div>
      )}
      <div className="ai-input-row">
        <Sparkles size={16} className="ai-sparkle" />
        <input
          ref={input}
          className="ai-input"
          placeholder={busy ? 'AI is writing…' : phase === 'done' ? 'Tell AI what to change…' : sub ? (sub === 'tone' ? 'Choose a tone…' : 'Choose a language…') : 'Ask AI to edit or generate…'}
          value={query}
          disabled={busy}
          onChange={(e) => { setQuery(e.target.value); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Backspace' && !query && sub) setSub(null);
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (phase === 'done' && query.trim()) run({ ...(lastReq.current as AiWriteRequest), action: 'custom', text: out, prompt: query.trim() });
              else if (phase === 'menu' && query.trim() && !items.length) start(null);
              else if (phase === 'menu' && items[hi]) start(items[hi]);
              else if (phase === 'menu' && query.trim()) start(null);
            }
          }}
        />
        {busy ? (
          <button className="ai-icon-btn" title="Stop" onClick={() => abort.current?.abort()}><Square size={13} fill="currentColor" /></button>
        ) : (
          <button className="ai-icon-btn" title="Send" disabled={!query.trim()} onClick={() => (phase === 'done' ? run({ ...(lastReq.current as AiWriteRequest), action: 'custom', text: out, prompt: query.trim() }) : start(null))}>
            <ArrowUp size={14} />
          </button>
        )}
      </div>
      {phase === 'menu' && (
        <div className="ai-menu" role="listbox">
          {sub && <div className="menu-heading">{sub === 'tone' ? 'Change tone' : 'Translate to'}</div>}
          {items.map((it, i) => (
            <button key={it.id} role="option" aria-selected={i === hi} className={`menu-item ${i === hi ? 'active' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => start(it)}>
              <span className="menu-icon">{it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.sub && <span className="menu-right"><ChevronRight size={14} /></span>}
            </button>
          ))}
          {!items.length && query.trim() && (
            <button className="menu-item active" onClick={() => start(null)}>
              <span className="menu-icon"><Sparkles size={15} /></span>
              <span className="menu-label">Ask AI: “{query.trim()}”</span>
              <span className="menu-right"><CornerDownLeft size={13} /></span>
            </button>
          )}
        </div>
      )}
      {phase === 'done' && (
        <div className="ai-menu">
          {s.mode === 'selection' && <button className="menu-item" onClick={replaceSelection}><span className="menu-icon"><Check size={15} /></span><span className="menu-label">Replace selection</span></button>}
          <button className="menu-item" onClick={insertBelow}><span className="menu-icon"><FileText size={15} /></span><span className="menu-label">{s.mode === 'cursor' ? 'Insert' : 'Insert below'}</span></button>
          <button className="menu-item" onClick={() => lastReq.current && run(lastReq.current)}><span className="menu-icon"><RotateCcw size={15} /></span><span className="menu-label">Try again</span></button>
          <button className="menu-item" onClick={reset}><span className="menu-icon"><X size={15} /></span><span className="menu-label">Discard</span></button>
        </div>
      )}
      {phase === 'error' && (
        <div className="ai-menu">
          <button className="menu-item" onClick={() => lastReq.current && run(lastReq.current)}><span className="menu-icon"><RotateCcw size={15} /></span><span className="menu-label">Try again</span></button>
          <button className="menu-item" onClick={reset}><span className="menu-icon"><X size={15} /></span><span className="menu-label">Close</span></button>
        </div>
      )}
      <div className="ai-foot">AI responses can be inaccurate. Review before keeping.</div>
    </Popover>
  );
});
