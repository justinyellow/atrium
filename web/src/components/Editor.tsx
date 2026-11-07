import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborationExtension } from '@blocknote/core/yjs';
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core/extensions';
import {
  FormattingToolbar, FormattingToolbarController, SuggestionMenuController, getDefaultReactSlashMenuItems,
  getFormattingToolbarItems, useComponentsContext, useCreateBlockNote, type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import {
  FileText, Database, Lightbulb, ListTree, AtSign, MessageSquarePlus, Link2, Columns2, Columns3, Columns4, RefreshCw,
  Bookmark, Globe, Sigma, Navigation, MousePointerClick, CalendarDays, Bell, Table2, Sparkles,
} from 'lucide-react';
import { syntaxHighlighter } from '@blocknote/code-block';
import { get, post, queryClient, uploadFile } from '../lib/api';
import { useUi } from '../lib/store';
import type { Me } from '../lib/types';
import { schema, type Editor } from './editorSchema';
import { Avatar, PageIcon, Popover, toast } from './ui';
import { EditorPageContext } from './blocks/context';
import { columnsTemplate } from './blocks/layout';
import { SYNC_CLIPBOARD_PREFIX } from './blocks/synced';
import { formatDateMention, parseNaturalDate, toIsoWithOffset, ymd } from './blocks/date';
import { getDatabaseSlashItems } from '../database/DatabaseBlock';
import { AskAi, AskAiToolbarButton, type AskAiHandle } from '../ai/AskAi';
import { useAiFeature } from '../ai/sse';

const COLORS = ['#e16259', '#d9730d', '#cb912f', '#448361', '#337ea9', '#9065b0', '#c14c8a', '#9f6b53'];
const colorFor = (id: string) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export interface PresenceUser { id: string; name: string; avatar_url: string | null; color: string }

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
}

function CommentButton({ onComment }: { onComment: () => void }) {
  const Components = useComponentsContext()!;
  return (
    <span style={{ display: "contents" }} onMouseDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); onComment(); }}>
      <Components.FormattingToolbar.Button mainTooltip="Comment" icon={<MessageSquarePlus size={16} />} onClick={() => {}} label="Comment" />
    </span>
  );
}

export function PageEditor({
  pageId, editable, canComment, me, onPresence, smallText,
}: {
  pageId: string;
  editable: boolean;
  canComment: boolean;
  me: Me;
  onPresence?: (users: PresenceUser[]) => void;
  smallText?: boolean;
}) {
  const [conn, setConn] = useState<{ doc: Y.Doc; provider: HocuspocusProvider; synced: boolean } | null>(null);

  // Doc + provider are created and destroyed together inside one effect so remounts
  // (StrictMode, hot reload) never reuse a destroyed instance.
  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: wsUrl(), name: pageId, document: doc, token: 'cookie' });
    let alive = true;
    const onSynced = () => alive && setConn({ doc, provider, synced: true });
    provider.on('synced', onSynced);
    setConn({ doc, provider, synced: provider.isSynced });
    provider.setAwarenessField('profile', { id: me.id, name: me.name, avatar_url: me.avatar_url, color: colorFor(me.id) });
    const aw = provider.awareness!;
    // Awareness can change synchronously while the editor is being created (during render), so report
    // presence on a microtask instead of setting the parent's state mid-render.
    let lastKey = '';
    const onAw = () => {
      queueMicrotask(() => {
        if (!alive) return;
        const seen = new Map<string, PresenceUser>();
        aw.getStates().forEach((s: any) => s.profile && seen.set(s.profile.id, s.profile));
        const list = [...seen.values()];
        const key = list.map((u) => `${u.id}:${u.name}:${u.color}`).join('|');
        if (key === lastKey) return;
        lastKey = key;
        onPresence?.(list);
      });
    };
    aw.on('change', onAw);
    onAw();
    return () => {
      alive = false;
      aw.off('change', onAw);
      setConn(null);
      provider.destroy();
      doc.destroy();
    };
  }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only create the editor once the server state has arrived; otherwise BlockNote seeds an
  // empty root block that races with (and duplicates) the stored document.
  if (!conn?.synced) return <div style={{ minHeight: 120 }} />;
  return <EditorInner key={conn.doc.guid} pageId={pageId} doc={conn.doc} provider={conn.provider} editable={editable} canComment={canComment} me={me} smallText={smallText} />;
}

function EditorInner({
  pageId, doc, provider, editable, canComment, me, smallText,
}: { pageId: string; doc: Y.Doc; provider: HocuspocusProvider; editable: boolean; canComment: boolean; me: Me; smallText?: boolean }) {
  const nav = useNavigate();
  const [composer, setComposer] = useState<{ x: number; y: number; from: number; to: number; quote: string; blockId: string } | null>(null);
  const [draft, setDraft] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const askAi = useRef<AskAiHandle>(null);
  const aiWrite = useAiFeature('write') && editable;
  const synced = true;

  const editor = useCreateBlockNote(
    {
      schema,
      extensions: [
        CollaborationExtension({
          fragment: doc.getXmlFragment('document-store'),
          user: { name: me.name, color: colorFor(me.id) },
          provider: provider as any,
          showCursorLabels: 'activity',
        }),
        syntaxHighlighter,
      ],
      uploadFile: async (file: File) => (await uploadFile(file)).url,
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }: any) => {
        // "Copy and sync" puts a marker on the clipboard; pasting it adds a live copy of the synced block.
        const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
        const m = text.match(new RegExp(`^${SYNC_CLIPBOARD_PREFIX}([0-9a-f-]{36})$`));
        if (m) {
          const cur = ed.getTextCursorPosition().block;
          const blank = cur.type === 'paragraph' && !cur.content?.length;
          const block = { type: 'syncedBlock', props: { sourceId: m[1] } };
          if (blank) ed.replaceBlocks([cur], [block]);
          else ed.insertBlocks([block], cur, 'after');
          return true;
        }
        return defaultPasteHandler();
      },
    } as any,
    [pageId],
  ) as unknown as Editor;

  // Comment marks dispatch a DOM event when clicked.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const h = (e: Event) => useUi.getState().set({ comments: { pageId, threadId: (e as CustomEvent).detail } });
    el.addEventListener('atrium-comment', h);
    return () => el.removeEventListener('atrium-comment', h);
  }, [pageId]);

  const createChild = async (kind: 'page' | 'database') => {
    const p = await post('/pages', { parentId: pageId, kind });
    insertOrUpdateBlockForSlashMenu(editor as any, { type: 'subpage', props: { pageId: p.id, title: '' } } as any);
    useUi.getState().toggleExpanded(pageId, true);
    queryClient.invalidateQueries({ queryKey: ['tree'] });
    setTimeout(() => nav(`/p/${p.id}`), 300); // let the doc sync first
  };

  const insertBlock = (b: any) => insertOrUpdateBlockForSlashMenu(editor as any, b);
  const insertColumns = (n: number) => {
    const cur = editor.getTextCursorPosition().block as any;
    const blank = cur.type === 'paragraph' && !cur.content?.length;
    const tpl = columnsTemplate(n) as any;
    const inserted: any[] = blank ? (editor.replaceBlocks([cur], [tpl]) as any).insertedBlocks : (editor.insertBlocks([tpl], cur, 'after') as any);
    const first = inserted?.[0]?.children?.[0]?.children?.[0];
    if (first) editor.setTextCursorPosition(first, 'start'); // Notion starts you in the first column
  };
  const createSynced = async () => {
    try {
      const s = await post('/blocks/synced', { pageId });
      insertBlock({ type: 'syncedBlock', props: { sourceId: s.id } });
    } catch (e: any) {
      toast(e.message);
    }
  };
  const insertDate = (d: Date, timed = false, reminder = '') =>
    editor.insertInlineContent([{ type: 'mention', props: { kind: 'date', date: timed ? toIsoWithOffset(d) : ymd(d), reminder } } as any, ' ']);

  const slashItems = (): DefaultReactSuggestionItem[] => {
    const custom: DefaultReactSuggestionItem[] = [
      ...(aiWrite ? [{ title: 'Ask AI', subtext: 'Write, summarize, brainstorm and more.', aliases: ['ai', 'ask', 'write', 'generate', 'summarize', 'gpt', 'claude'], group: 'AI', icon: <Sparkles size={18} />, onItemClick: () => setTimeout(() => askAi.current?.open('cursor'), 0) } as DefaultReactSuggestionItem] : []),
      { title: 'Bookmark', subtext: 'Save a link as a visual bookmark.', aliases: ['bookmark', 'link', 'url', 'preview'], group: 'Media', icon: <Bookmark size={18} />, onItemClick: () => insertBlock({ type: 'bookmark' }) },
      { title: 'Embed', subtext: 'YouTube, Figma, Google Docs, Maps, Loom and more.', aliases: ['embed', 'iframe', 'youtube', 'figma', 'video', 'maps', 'loom', 'miro', 'codepen', 'gist'], group: 'Media', icon: <Globe size={18} />, onItemClick: () => insertBlock({ type: 'embed' }) },
      { title: '2 columns', subtext: 'Create two columns of blocks.', aliases: ['columns', 'col', 'layout', 'two'], group: 'Layout', icon: <Columns2 size={18} />, onItemClick: () => insertColumns(2) },
      { title: '3 columns', subtext: 'Create three columns of blocks.', aliases: ['columns', 'col', 'layout', 'three'], group: 'Layout', icon: <Columns3 size={18} />, onItemClick: () => insertColumns(3) },
      { title: '4 columns', subtext: 'Create four columns of blocks.', aliases: ['columns', 'col', 'layout', 'four'], group: 'Layout', icon: <Columns4 size={18} />, onItemClick: () => insertColumns(4) },
      { title: '5 columns', subtext: 'Create five columns of blocks.', aliases: ['columns', 'col', 'layout', 'five'], group: 'Layout', icon: <Columns4 size={18} />, onItemClick: () => insertColumns(5) },
      { title: 'Synced block', subtext: 'Sync content across multiple pages.', aliases: ['synced', 'sync', 'transclusion', 'reuse'], group: 'Advanced blocks', icon: <RefreshCw size={18} />, onItemClick: createSynced },
      { title: 'Block equation', subtext: 'Display a standalone math equation.', aliases: ['equation', 'math', 'latex', 'tex', 'formula'], group: 'Advanced blocks', icon: <Sigma size={18} />, onItemClick: () => insertBlock({ type: 'equation' }) },
      { title: 'Inline equation', subtext: 'Insert mathematical symbols in text.', aliases: ['equation', 'math', 'latex', 'inline'], group: 'Inline', icon: <Sigma size={18} />, onItemClick: () => editor.insertInlineContent([{ type: 'inlineEquation', props: { latex: '' } } as any, ' ']) },
      { title: 'Breadcrumb', subtext: 'Show where this page sits.', aliases: ['breadcrumb', 'path', 'navigation'], group: 'Advanced blocks', icon: <Navigation size={18} />, onItemClick: () => insertBlock({ type: 'breadcrumb' }) },
      { title: 'Button', subtext: 'Insert blocks, add pages, or open links in one click.', aliases: ['button', 'action', 'automation', 'template'], group: 'Advanced blocks', icon: <MousePointerClick size={18} />, onItemClick: () => insertBlock({ type: 'button' }) },
      { title: 'Date or reminder', subtext: "Insert a date, or set a reminder.", aliases: ['date', 'reminder', 'today', 'remind', 'deadline'], group: 'Inline', icon: <CalendarDays size={18} />, onItemClick: () => insertDate(new Date()) },
      ...getDatabaseSlashItems(editor, pageId),
      { title: 'Page', subtext: 'Embed a sub-page inside this page.', aliases: ['page', 'subpage', 'new'], group: 'Basic blocks', icon: <FileText size={18} />, onItemClick: () => createChild('page') },
      { title: 'Callout', subtext: 'Make writing stand out.', aliases: ['callout', 'note', 'info'], group: 'Basic blocks', icon: <Lightbulb size={18} />, onItemClick: () => insertOrUpdateBlockForSlashMenu(editor as any, { type: 'callout' } as any) },
      { title: 'Database - Full page', subtext: 'Add a database as a sub-page.', aliases: ['database', 'table', 'db', 'board'], group: 'Database', icon: <Database size={18} />, onItemClick: () => createChild('database') },
      { title: 'Link to page', subtext: 'Link to an existing page.', aliases: ['link', 'page', 'mention'], group: 'Basic blocks', icon: <Link2 size={18} />, onItemClick: () => (editor as any).getExtension('suggestionMenu')?.openSuggestionMenu('@') },
      { title: 'Mention a person', subtext: 'Ping someone so they get a notification.', aliases: ['mention', 'person', 'user', '@'], group: 'Inline', icon: <AtSign size={18} />, onItemClick: () => (editor as any).getExtension('suggestionMenu')?.openSuggestionMenu('@') },
      { title: 'Table of contents', subtext: 'Show an outline of your page.', aliases: ['toc', 'outline', 'contents'], group: 'Advanced blocks', icon: <ListTree size={18} />, onItemClick: () => insertOrUpdateBlockForSlashMenu(editor as any, { type: 'toc' } as any) },
    ];
    const defaults = getDefaultReactSlashMenuItems(editor as any);
    // Put our basic items right after the default basic blocks.
    const lastBasic = defaults.map((d) => d.group).lastIndexOf('Basic blocks');
    return [...custom.filter((c) => c.group === 'AI'), ...defaults.slice(0, lastBasic + 1), ...custom.filter((c) => c.group === 'Basic blocks'), ...defaults.slice(lastBasic + 1), ...custom.filter((c) => c.group !== 'Basic blocks' && c.group !== 'AI')];
  };

  const mentionItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const r = await get(`/mentions?q=${encodeURIComponent(query)}`);
    const insert = (props: any) => editor.insertInlineContent([{ type: 'mention', props } as any, ' ']);
    const remindMatch = query.match(/^remind(?:er)?\s*(?:me\s*)?(.*)$/i);
    const natural = parseNaturalDate(remindMatch ? remindMatch[1] || 'today' : query);
    const dateItems: DefaultReactSuggestionItem[] = [];
    if (natural) {
      const at9 = new Date(natural);
      at9.setHours(9, 0, 0, 0);
      dateItems.push(
        { title: formatDateMention(ymd(natural)), subtext: 'Date', group: 'Date', icon: <CalendarDays size={18} />, onItemClick: () => insertDate(natural) },
        { title: `Remind me ${formatDateMention(toIsoWithOffset(at9))}`, subtext: 'Reminder', group: 'Remind', icon: <Bell size={18} />, onItemClick: () => insertDate(at9, true, 'at') },
      );
    } else if (!query) {
      const t = new Date();
      dateItems.push({ title: 'Today', subtext: formatDateMention(ymd(t)), group: 'Date', icon: <CalendarDays size={18} />, onItemClick: () => insertDate(t) });
    }
    return [
      ...dateItems,
      ...r.users.map((u: any) => ({
        title: u.name, subtext: u.email, group: 'People', icon: <Avatar user={u} size={20} />,
        onItemClick: () => insert({ kind: 'user', id: u.id, label: u.name }),
      })),
      ...r.pages.map((p: any) => ({
        title: p.title || 'Untitled', group: 'Link to page', icon: <PageIcon icon={p.icon} kind={p.kind} size={18} />,
        onItemClick: () => insert({ kind: 'page', id: p.id, label: p.title }),
      })),
      ...(query ? [{
        title: `New "${query}" sub-page`, group: 'New page', icon: <FileText size={18} />,
        onItemClick: async () => {
          const p = await post('/pages', { parentId: pageId, title: query });
          queryClient.invalidateQueries({ queryKey: ['tree'] });
          insert({ kind: 'page', id: p.id, label: query });
        },
      }] : []),
    ];
  };

  const startComment = () => {
    const sel = editor.prosemirrorState.selection;
    if (sel.empty) return;
    const start = editor.prosemirrorView.coordsAtPos(sel.from);
    const end = editor.prosemirrorView.coordsAtPos(sel.to);
    setDraft('');
    setComposer({
      x: start.left, y: end.bottom + 6, from: sel.from, to: sel.to,
      quote: editor.getSelectedText().slice(0, 500), blockId: editor.getTextCursorPosition().block.id,
    });
  };

  const submitComment = async () => {
    if (!composer || !draft.trim()) return;
    try {
      const c = await post(`/pages/${pageId}/comments`, { body: draft, quote: composer.quote, blockId: composer.blockId });
      if (editable) {
        editor.transact((tr: any) => {
          const mark = tr.doc.type.schema.marks.comment;
          if (mark) tr.addMark(composer.from, composer.to, mark.create({ stringValue: c.thread_id }));
        });
      }
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      useUi.getState().set({ comments: { pageId, threadId: c.thread_id } });
    } catch (e: any) {
      toast(e.message);
    }
    setComposer(null);
  };

  const dark = document.documentElement.classList.contains('dark');
  return (
    <div ref={wrap} className={smallText ? 'small-text' : ''} style={{ opacity: synced ? 1 : 0.4, transition: 'opacity 150ms' }}>
      <EditorPageContext.Provider value={{ pageId, editable, me, syncedAncestors: [] }}>
      <BlockNoteView
        editor={editor as any}
        editable={editable}
        theme={dark ? 'dark' : 'light'}
        slashMenu={false}
        formattingToolbar={false}
      >
        <SuggestionMenuController {...({ triggerCharacter: "/", getItems: async (q: string) => filterSuggestionItems(slashItems() as any, q) } as any)} />
        <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {aiWrite && <AskAiToolbarButton key="ask-ai" onClick={() => askAi.current?.open('selection')} />}
              {...getFormattingToolbarItems()}
              {canComment && <CommentButton key="comment" onComment={startComment} />}
            </FormattingToolbar>
          )}
        />
      </BlockNoteView>
      </EditorPageContext.Provider>
      <AskAi ref={askAi} editor={editor} pageId={pageId} enabled={aiWrite} />
      {composer && (
        <Popover anchor={{ x: composer.x, y: composer.y }} open onClose={() => setComposer(null)} width={360}>
          <div style={{ display: 'flex', gap: 8, padding: 4, alignItems: 'flex-start' }}>
            <Avatar user={me} size={24} />
            <textarea
              className="input" ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = "1"; setTimeout(() => el.focus(), 80); } }} placeholder="Add a comment…" value={draft} rows={2}
              style={{ minHeight: 36 }}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(); } }}
            />
            <button className="btn primary sm" onClick={submitComment} disabled={!draft.trim()}>Send</button>
          </div>
        </Popover>
      )}
    </div>
  );
}
