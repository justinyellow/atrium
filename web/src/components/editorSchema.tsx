import { BlockNoteSchema, createCodeBlockSpec, createHeadingBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { createReactBlockSpec, createReactInlineContentSpec, createReactStyleSpec } from '@blocknote/react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useTree } from '../lib/hooks';
import { PageIcon } from './ui';
import { IconPicker } from './PagePickers';
import { columnBlock, columnListBlock } from './blocks/layout';
import { syncedBlock } from './blocks/synced';
import { bookmarkBlock, embedBlock } from './blocks/media';
import { equationBlock, inlineEquation } from './blocks/equation';
import { breadcrumbBlock } from './blocks/breadcrumb';
import { buttonBlock } from './blocks/button';
import { DateMention } from './blocks/date';
import { databaseBlock } from '../database/DatabaseBlock';

// NOTE: type names + prop schemas must match server/src/markdown.ts.

function usePageMeta(id: string) {
  const { data: tree } = useTree();
  const fromTree = tree?.pages.find((p) => p.id === id);
  const q = useQuery({
    queryKey: ['pagemeta', id],
    queryFn: () => get(`/pages/${id}`).catch(() => null),
    enabled: !!id && !fromTree,
    staleTime: 60_000,
  });
  return fromTree ?? q.data ?? null;
}

function SubPage({ pageId, fallback }: { pageId: string; fallback: string }) {
  const nav = useNavigate();
  const meta = usePageMeta(pageId);
  return (
    <a className="subpage-block" contentEditable={false} href={`/p/${pageId}`} onClick={(e) => { e.preventDefault(); nav(`/p/${pageId}`); }}>
      <PageIcon icon={meta?.icon} kind={meta?.kind} size={20} />
      <span className="t">{meta ? meta.title || 'Untitled' : fallback || 'Untitled'}</span>
    </a>
  );
}

export const subpageBlock = createReactBlockSpec(
  { type: 'subpage', propSchema: { pageId: { default: '' }, title: { default: '' } }, content: 'none' },
  { render: ({ block }) => <SubPage pageId={block.props.pageId} fallback={block.props.title} /> },
);

/** Callout icon: an emoji, or an image URL (Notion allows uploaded/custom icons). Click opens the icon picker. */
function CalloutIcon({ block, editor }: { block: any; editor: any }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const icon: string = block.props.emoji || '💡';
  const isImage = icon.startsWith('/') || /^https?:\/\//.test(icon);
  return (
    <>
      <span
        ref={ref}
        className="callout-emoji emoji"
        contentEditable={false}
        role={editor.isEditable ? 'button' : undefined}
        aria-label={editor.isEditable ? 'Change callout icon' : undefined}
        tabIndex={editor.isEditable ? 0 : -1}
        onClick={() => editor.isEditable && setOpen(true)}
        onKeyDown={(e) => { if (editor.isEditable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}
      >
        {isImage ? <img src={icon} alt="" className="callout-icon-img" /> : icon}
      </span>
      {open && (
        <IconPicker anchor={ref.current} open onClose={() => setOpen(false)}
          onPick={(v) => { editor.updateBlock(block, { props: { emoji: v || '💡' } }); setOpen(false); }} />
      )}
    </>
  );
}

export const calloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: { emoji: { default: '💡' }, backgroundColor: { default: 'gray' }, textColor: { default: 'default' } },
    content: 'inline',
  },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="callout" style={block.props.backgroundColor !== 'default' ? { background: `var(--c-${block.props.backgroundColor}-bg)`, borderColor: 'transparent' } : undefined}>
        <CalloutIcon block={block} editor={editor} />
        <div className="callout-content" ref={contentRef} />
      </div>
    ),
  },
);

function Toc({ editor }: { editor: any }) {
  const [heads, setHeads] = useState<{ id: string; text: string; level: number }[]>([]);
  useEffect(() => {
    const collect = () => {
      const out: { id: string; text: string; level: number }[] = [];
      const walk = (blocks: any[]) => {
        for (const b of blocks) {
          if (b.type === 'heading') out.push({ id: b.id, level: b.props.level, text: (b.content ?? []).map((c: any) => c.text ?? c.props?.label ?? '').join('') });
          if (b.children?.length) walk(b.children);
        }
      };
      walk(editor.document);
      setHeads(out);
    };
    collect();
    return editor.onChange(collect);
  }, [editor]);
  return (
    <div className="toc" contentEditable={false}>
      {heads.length ? heads.map((h) => (
        <a key={h.id} href={`#${h.id}`} style={{ paddingLeft: 4 + (h.level - 1) * 18 }} onClick={(e) => {
          e.preventDefault();
          document.querySelector(`[data-id="${h.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}>{h.text || 'Untitled'}</a>
      )) : <span className="faint" style={{ fontSize: 14 }}>Add headings to create a table of contents.</span>}
    </div>
  );
}

export const tocBlock = createReactBlockSpec(
  { type: 'toc', propSchema: {}, content: 'none' },
  { render: ({ editor }) => <Toc editor={editor} /> },
);

function Mention({ kind, id, label }: { kind: string; id: string; label: string }) {
  const nav = useNavigate();
  const meta = kind === 'page' ? usePageMeta(id) : null;
  if (kind === 'user') return <span className="mention user">@{label}</span>;
  return (
    <a className="mention page" href={`/p/${id}`} onClick={(e) => { e.preventDefault(); nav(`/p/${id}`); }}>
      <PageIcon icon={meta?.icon} kind={meta?.kind} size={15} />
      {meta ? meta.title || 'Untitled' : label || 'Untitled'}
    </a>
  );
}

export const mentionInline = createReactInlineContentSpec(
  {
    type: 'mention',
    // kind: 'user' | 'page' | 'date'. Date mentions use `date` + `reminder` (see blocks/date.tsx).
    propSchema: { kind: { default: 'page' }, id: { default: '' }, label: { default: '' }, date: { default: '' }, reminder: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => {
      const p = inlineContent.props as any;
      if (p.kind === 'date') {
        return (
          <DateMention
            date={p.date}
            reminder={p.reminder}
            editable={editor.isEditable}
            onChange={(v) => updateInlineContent({ type: 'mention', props: { ...p, ...v } } as any)}
          />
        );
      }
      return <Mention {...p} />;
    },
  },
);

export const commentStyle = createReactStyleSpec(
  { type: 'comment', propSchema: 'string' },
  {
    render: ({ value, contentRef }) => (
      <span
        className="comment-mark"
        data-thread-id={value}
        ref={contentRef}
        onClick={(e) => e.currentTarget.dispatchEvent(new CustomEvent('atrium-comment', { bubbles: true, detail: value }))}
      />
    ),
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // Headings 1–4 (Notion has H4; imported workspaces use it). Must match between web and server schemas.
    heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4] }),
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    subpage: subpageBlock(),
    callout: calloutBlock(),
    toc: tocBlock(),
    columnList: columnListBlock(),
    column: columnBlock(),
    syncedBlock: syncedBlock(),
    bookmark: bookmarkBlock(),
    embed: embedBlock(),
    equation: equationBlock(),
    breadcrumb: breadcrumbBlock(),
    button: buttonBlock(),
    database: databaseBlock(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInline, inlineEquation },
  styleSpecs: { ...defaultStyleSpecs, comment: commentStyle },
});

export type Editor = typeof schema.BlockNoteEditor;
