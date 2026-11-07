import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborationExtension } from '@blocknote/core/yjs';
import { createReactBlockSpec, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { Copy, RefreshCw, Unlink } from 'lucide-react';
import { get, uploadFile } from '../../lib/api';
import { schema } from '../editorSchema';
import { toast } from '../ui';
import { EditorPageContext, isolate, useEditorPage } from './context';

// A synced block's content lives in its own hidden page (kind 'synced') with its own Yjs document.
// Every copy renders a nested live editor bound to that document, so edits show up everywhere.

export const SYNC_CLIPBOARD_PREFIX = 'atrium-synced:';

interface SyncedInfo {
  id: string;
  parent_id: string;
  parent_title: string;
  level: string;
  refs: { id: string; title: string; icon: string | null }[];
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
const COLORS = ['#e16259', '#d9730d', '#cb912f', '#448361', '#337ea9', '#9065b0', '#c14c8a', '#9f6b53'];
const colorFor = (id: string) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const stripIds = (blocks: any[]): any[] => blocks.map(({ id: _id, children, ...b }) => ({ ...b, children: stripIds(children ?? []) }));

function NestedEditor({ sourceId, doc, provider, editable }: { sourceId: string; doc: Y.Doc; provider: HocuspocusProvider; editable: boolean }) {
  const ctx = useEditorPage();
  const editor = useCreateBlockNote(
    {
      schema,
      extensions: [
        CollaborationExtension({
          fragment: doc.getXmlFragment('document-store'),
          user: { name: ctx.me?.name ?? 'Someone', color: colorFor(ctx.me?.id ?? 'x') },
          provider: provider as any,
          showCursorLabels: 'activity',
        }),
      ],
      uploadFile: async (file: File) => (await uploadFile(file)).url,
    } as any,
    [sourceId],
  );
  return (
    <EditorPageContext.Provider value={{ ...ctx, editable, syncedAncestors: [...ctx.syncedAncestors, sourceId] }}>
      <BlockNoteView editor={editor as any} editable={editable} theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'} />
    </EditorPageContext.Provider>
  );
}

function SyncedView({ block, editor }: { block: any; editor: any }) {
  const ctx = useEditorPage();
  const sid: string = block.props.sourceId;
  const info = useQuery({ queryKey: ['synced', sid], queryFn: () => get<SyncedInfo>(`/blocks/synced/${sid}`), enabled: !!sid, retry: false, staleTime: 10_000 });
  const [conn, setConn] = useState<{ doc: Y.Doc; provider: HocuspocusProvider; synced: boolean } | null>(null);
  const loop = ctx.syncedAncestors.includes(sid);

  useEffect(() => {
    if (!sid || loop || info.isError) return;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: wsUrl(), name: sid, document: doc, token: 'cookie' });
    let alive = true;
    provider.on('synced', () => alive && setConn({ doc, provider, synced: true }));
    setConn({ doc, provider, synced: provider.isSynced });
    return () => {
      alive = false;
      setConn(null);
      provider.destroy();
      doc.destroy();
    };
  }, [sid, loop, info.isError]);

  if (!sid) return <div className="synced-block empty" contentEditable={false}>Empty synced block</div>;
  if (loop) return <div className="synced-block empty" contentEditable={false}>A synced block can't contain itself.</div>;
  if (info.isError) return <div className="synced-block empty" contentEditable={false}>You don't have access to this synced block's original.</div>;

  const isOriginal = info.data?.parent_id === ctx.pageId;
  const canEdit = ctx.editable && ['edit', 'full'].includes(info.data?.level ?? '');
  const others = (info.data?.refs ?? []).filter((r) => r.id !== ctx.pageId);

  return (
    <div className="synced-block" contentEditable={false} ref={isolate}>
      <div className="synced-toolbar">
        <span className="synced-label"><RefreshCw size={12} /> {isOriginal ? 'Original' : <>Synced from <b>{info.data?.parent_title || 'Untitled'}</b></>}</span>
        <span className="synced-count" title={others.map((r) => r.title || 'Untitled').join(', ')}>
          Editing in {(info.data?.refs.length ?? 1)} page{(info.data?.refs.length ?? 1) === 1 ? '' : 's'}
        </span>
        <button onClick={() => { navigator.clipboard.writeText(`${SYNC_CLIPBOARD_PREFIX}${sid}`); toast('Copied — paste into any page to add a synced copy'); }}>
          <Copy size={12} /> Copy and sync
        </button>
        {!isOriginal && ctx.editable && (
          <button onClick={async () => {
            const { blocks } = await get(`/pages/${sid}/content`);
            const plain = stripIds(blocks).filter((b: any) => !(b.type === 'paragraph' && !b.content?.length && !b.children?.length));
            if (plain.length) editor.replaceBlocks([block], plain);
            else editor.removeBlocks([block]);
            toast('Unsynced — this copy is now independent');
          }}>
            <Unlink size={12} /> Unsync
          </button>
        )}
      </div>
      {conn?.synced ? <NestedEditor key={conn.doc.guid} sourceId={sid} doc={conn.doc} provider={conn.provider} editable={canEdit} /> : <div style={{ minHeight: 40 }} />}
    </div>
  );
}

export const syncedBlock = createReactBlockSpec(
  { type: 'syncedBlock', propSchema: { sourceId: { default: '' } }, content: 'none' },
  { render: ({ block, editor }) => <SyncedView block={block} editor={editor} /> },
);
