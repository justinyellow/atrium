import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { Sparkles } from 'lucide-react';
import { post, queryClient } from '../lib/api';
import type { Prop, Row } from '../lib/types';
import { toast } from '../components/ui';
import { aiErrorMessage, useAiFeature } from './sse';
import './ai.css';

/** Display-type for an AI property's stored value (text / select / multi-select). */
export function aiDisplayProp(prop: Prop): Prop {
  const t = prop.ai?.outputType ?? 'text';
  return { ...prop, type: t === 'text' ? 'text' : t };
}

/** Rows with an AI fill in flight: key `${propId}:${rowId}` → time requested. */
const useAiFill = create<{ pending: Record<string, number>; mark: (propId: string, rowIds: string[]) => void; clear: (key: string) => void }>((set) => ({
  pending: {},
  mark: (propId, rowIds) => set((s) => ({ pending: { ...s.pending, ...Object.fromEntries(rowIds.map((r) => [`${propId}:${r}`, Date.now()])) } })),
  clear: (key) => set((s) => {
    const { [key]: _, ...rest } = s.pending;
    return { pending: rest };
  }),
}));

/** Ask the server to (re)fill an AI property for some rows, or all rows when rowIds is omitted. */
export async function requestAiFill(dbId: string, propId: string, rowIds: string[], opts: { onlyEmpty?: boolean; all?: boolean } = {}) {
  // `*` marks every still-empty cell of the property as filling.
  useAiFill.getState().mark(propId, opts.all ? ['*'] : rowIds);
  if (opts.all) setTimeout(() => useAiFill.getState().clear(`${propId}:*`), 60_000);
  try {
    const r = await post<{ queued: number }>(`/databases/${dbId}/ai-fill`, { propId, ...(opts.all ? {} : { rowIds }), onlyEmpty: !!opts.onlyEmpty });
    if (opts.all) toast(r.queued ? `Filling ${r.queued} row${r.queued === 1 ? '' : 's'} with AI…` : 'Nothing to fill');
    // Values arrive through the live db event; poll a few times in case events are delayed.
    for (const ms of [1500, 4000, 9000]) setTimeout(() => queryClient.invalidateQueries({ queryKey: ['dbq', dbId] }), ms);
  } catch (e) {
    for (const r of opts.all ? ['*'] : rowIds) useAiFill.getState().clear(`${propId}:${r}`);
    toast(aiErrorMessage(e));
  }
}

/** Cell content for an AI autofill property: value with a sparkle, Generate button when empty, shimmer while filling. */
export function AiCellValue({ dbId, row, prop, canEdit, children }: { dbId: string; row: Row; prop: Prop; canEdit: boolean; children: ReactNode }) {
  const key = `${prop.id}:${row.id}`;
  const since = useAiFill((s) => s.pending[key]);
  const allPending = useAiFill((s) => !!s.pending[`${prop.id}:*`]);
  const enabled = useAiFeature('autofill');
  const value = row.props[prop.id];
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  const initial = useRef(JSON.stringify(value));

  // Clear the pending marker once the value changes (or after a minute).
  useEffect(() => {
    if (!since) {
      initial.current = JSON.stringify(value);
      return;
    }
    if (JSON.stringify(value) !== initial.current) {
      initial.current = JSON.stringify(value);
      useAiFill.getState().clear(key);
      return;
    }
    const t = setTimeout(() => useAiFill.getState().clear(key), Math.max(0, 60_000 - (Date.now() - since)));
    return () => clearTimeout(t);
  }, [since, value, key]);

  if (since || (allPending && empty)) return <span className="ai-shimmer" aria-label="AI is filling this cell" />;
  if (empty) {
    return canEdit && enabled ? (
      <button className="ai-gen-btn" onClick={(e) => { e.stopPropagation(); requestAiFill(dbId, prop.id, [row.id]); }}>
        <Sparkles size={12} /> Generate
      </button>
    ) : null;
  }
  return <span className="ai-cell"><Sparkles size={11} className="ai-sparkle" />{children}</span>;
}
