import { useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import { Popover } from '../ui';

function render(latex: string, displayMode: boolean) {
  try {
    return { html: katex.renderToString(latex, { displayMode, throwOnError: true, strict: 'ignore' }), error: null };
  } catch (e: any) {
    return { html: '', error: String(e.message ?? e).replace(/^KaTeX parse error: /, '') };
  }
}

function LatexEditor({ anchor, value, display, onSave, onClose }: { anchor: HTMLElement | null; value: string; display: boolean; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  const preview = render(v, display);
  return (
    <Popover anchor={anchor} open onClose={() => { onSave(v); onClose(); }} width={420}>
      <div className="latex-editor">
        <textarea
          className="input"
          // BlockNote refocuses the editor after a node click; grab focus just after it does.
          ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; setTimeout(() => { el.focus(); el.select(); }, 80); } }}
          spellCheck={false}
          value={v}
          rows={display ? 4 : 2}
          placeholder={display ? 'E = mc^2' : 'x^2'}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !display)) {
              e.preventDefault();
              onSave(v);
              onClose();
            }
          }}
        />
        {preview.error && v && <div className="latex-error">{preview.error}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>LaTeX · {display ? 'Ctrl+Enter' : 'Enter'} to save</span>
          <button className="btn primary sm" onClick={() => { onSave(v); onClose(); }}>Done</button>
        </div>
      </div>
    </Popover>
  );
}

function Equation({ latex, display, editable, onChange }: { latex: string; display: boolean; editable: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLSpanElement & HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const r = render(latex, display);
  const Tag = (display ? 'div' : 'span') as 'div';
  return (
    <>
      <Tag
        ref={ref}
        className={`${display ? 'equation-block' : 'equation-inline'} ${editable ? 'editable' : ''} ${!latex || r.error ? 'empty' : ''}`}
        contentEditable={false}
        onClick={() => editable && setEditing(true)}
      >
        {!latex ? (display ? 'Add a TeX equation' : 'New equation') : r.error ? <span className="latex-error-inline">{latex}</span> : <span dangerouslySetInnerHTML={{ __html: r.html }} />}
      </Tag>
      {editing && <LatexEditor anchor={ref.current} value={latex} display={display} onSave={onChange} onClose={() => setEditing(false)} />}
    </>
  );
}

export const equationBlock = createReactBlockSpec(
  { type: 'equation', propSchema: { latex: { default: '' } }, content: 'none' },
  {
    render: ({ block, editor }) => (
      <Equation latex={block.props.latex} display editable={editor.isEditable} onChange={(latex) => latex !== block.props.latex && editor.updateBlock(block, { props: { latex } })} />
    ),
  },
);

export const inlineEquation = createReactInlineContentSpec(
  { type: 'inlineEquation', propSchema: { latex: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <Equation
        latex={inlineContent.props.latex}
        display={false}
        editable={editor.isEditable}
        onChange={(latex) => latex !== inlineContent.props.latex && updateInlineContent({ type: 'inlineEquation', props: { latex } } as any)}
      />
    ),
  },
);
