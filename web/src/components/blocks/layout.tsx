import { createReactBlockSpec } from '@blocknote/react';

// Notion-style columns built on BlockNote core layout blocks (`layoutOnly`), no XL package needed.
// columnList holds 2+ column blocks; each column holds regular blocks. A list left with one
// column dissolves back into plain blocks, like Notion.

export const columnListBlock = createReactBlockSpec(
  {
    type: 'columnList',
    propSchema: {},
    content: 'none',
    layoutOnly: true,
    children: { allow: ['column'], min: 2, dissolve: true },
  } as any,
  {
    renderFrame: ({ slotRef }: any) => <div className="bn-column-list" ref={slotRef} />,
  } as any,
);

/** A column list's own column frames (the flex items; BlockNote's wrappers are display:contents). */
const columnNodes = (listEl: HTMLElement) =>
  [...listEl.querySelectorAll<HTMLElement>('.bn-column')].filter((el) => el.parentElement?.closest('.bn-column-list') === listEl);

function startResize(e: React.MouseEvent, editor: any, block: any) {
  e.preventDefault();
  e.stopPropagation();
  const parent = editor.getParentBlock(block);
  if (!parent) return;
  const cols: any[] = parent.children;
  const i = cols.findIndex((c) => c.id === block.id);
  const next = cols[i + 1];
  if (!next) return;
  const listEl = (e.currentTarget as HTMLElement).closest('.bn-column-list') as HTMLElement | null;
  const total = cols.reduce((s, c) => s + Number(c.props.width || 1), 0);
  const px = listEl?.getBoundingClientRect().width || 600;
  const a0 = Number(block.props.width || 1), b0 = Number(next.props.width || 1);
  const x0 = e.clientX;
  let a = a0, b = b0;
  const move = (ev: MouseEvent) => {
    const dw = ((ev.clientX - x0) / px) * total;
    const min = total * 0.08;
    a = Math.max(min, Math.min(a0 + b0 - min, a0 + dw));
    b = a0 + b0 - a;
    // Live preview without a document transaction per pixel.
    const mine = listEl ? columnNodes(listEl) : [];
    if (mine[i]) mine[i].style.flexGrow = String(a);
    if (mine[i + 1]) mine[i + 1].style.flexGrow = String(b);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    editor.updateBlock(block, { props: { width: Number(a.toFixed(3)) } });
    editor.updateBlock(next, { props: { width: Number(b.toFixed(3)) } });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

export const columnBlock = createReactBlockSpec(
  {
    type: 'column',
    propSchema: { width: { default: 1 } },
    content: 'none',
    layoutOnly: true,
    placeable: 'namedOnly',
    children: { allow: 'blocks', exclude: ['columnList'] },
  } as any,
  {
    renderFrame: ({ block, editor, slotRef }: any) => (
      <div className="bn-column" style={{ flexGrow: Number(block.props.width || 1) }}>
        <div className="bn-column-slot" ref={slotRef} />
        {editor.isEditable && (
          <div className="bn-column-resizer" contentEditable={false} onMouseDown={(e) => startResize(e, editor, block)} />
        )}
      </div>
    ),
  } as any,
);

/** Block JSON for a new N-column layout. */
export const columnsTemplate = (n: number) => ({
  type: 'columnList',
  children: Array.from({ length: n }, () => ({ type: 'column', props: { width: 1 }, children: [{ type: 'paragraph' }] })),
});
