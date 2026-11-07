import { useState } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import type { Prop } from '../lib/types';
import { Toggle, MenuItem } from '../components/ui';
import { updateProperty } from '../database/dbutil';
import { requestAiFill } from './AiCell';
import { useAiFeature } from './sse';
import './ai.css';

type AiConfig = NonNullable<Prop['ai']>;
export const DEFAULT_AI_PROP: AiConfig = { kind: 'summary', instruction: '', outputType: 'text', autoUpdate: false };

const KINDS: { id: AiConfig['kind']; label: string; hint: string }[] = [
  { id: 'summary', label: 'Summary', hint: 'A short summary of each page' },
  { id: 'keywords', label: 'Keywords', hint: 'Key topics from each page' },
  { id: 'translate', label: 'Translation', hint: 'Translate a property or the page' },
  { id: 'custom', label: 'Custom autofill', hint: 'Anything you describe' },
];
const LANGS = ['English', 'Afrikaans', 'isiZulu', 'French', 'Portuguese', 'Spanish', 'German', 'Swahili', 'Arabic', 'Chinese'];

/** Type-specific section of the property settings popover for AI autofill properties. */
export function AiPropSettings({ dbId, prop }: { dbId: string; prop: Prop }) {
  const ai: AiConfig = { ...DEFAULT_AI_PROP, ...prop.ai };
  const [instruction, setInstruction] = useState(ai.instruction);
  const enabled = useAiFeature('autofill');
  const save = (patch: Partial<AiConfig>) => updateProperty(dbId, prop.id, { ai: { ...ai, ...patch } });
  const selectStyle = { margin: '0 4px', width: 'calc(100% - 8px)' };

  return (
    <>
      <div className="menu-sep" />
      <div className="menu-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Sparkles size={12} className="ai-sparkle" /> AI autofill</div>
      {!enabled && <div className="menu-footer">Atrium AI is off for this workspace, so values won’t be generated.</div>}
      <select className="input sm" style={selectStyle} value={ai.kind} aria-label="What to generate" onChange={(e) => save({ kind: e.target.value as AiConfig['kind'] })}>
        {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label} — {k.hint}</option>)}
      </select>
      {ai.kind === 'translate' && (
        <>
          <div className="menu-heading">Language</div>
          <select className="input sm" style={selectStyle} value={ai.language ?? 'English'} onChange={(e) => save({ language: e.target.value })}>
            {LANGS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </>
      )}
      <div className="menu-heading">{ai.kind === 'custom' ? 'Instructions' : 'Extra instructions (optional)'}</div>
      <div style={{ padding: '0 4px 4px' }}>
        <textarea
          className="input"
          rows={3}
          value={instruction}
          placeholder={ai.kind === 'custom' ? 'e.g. Classify the risk as Low, Medium or High' : 'e.g. One sentence, plain English'}
          onChange={(e) => setInstruction(e.target.value)}
          onBlur={() => instruction !== ai.instruction && save({ instruction })}
        />
      </div>
      <div className="menu-heading">Output</div>
      <select className="input sm" style={{ ...selectStyle, marginBottom: 4 }} value={ai.outputType} onChange={(e) => save({ outputType: e.target.value as AiConfig['outputType'] })}>
        <option value="text">Text</option>
        <option value="select">Select (one option)</option>
        <option value="multi_select">Multi-select (several options)</option>
      </select>
      <div className="opt-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px' }}>
        <span style={{ fontSize: 13 }}>Auto-update when the page changes</span>
        <Toggle checked={ai.autoUpdate} onChange={(v) => save({ autoUpdate: v })} />
      </div>
      {enabled && (
        <>
          <MenuItem icon={<Sparkles size={14} />} onClick={() => requestAiFill(dbId, prop.id, [], { all: true, onlyEmpty: true })}>Fill empty rows</MenuItem>
          <MenuItem icon={<RefreshCw size={14} />} onClick={() => requestAiFill(dbId, prop.id, [], { all: true })}>Update all rows</MenuItem>
        </>
      )}
    </>
  );
}
