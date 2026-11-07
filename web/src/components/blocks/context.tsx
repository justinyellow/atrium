import { createContext, useContext } from 'react';
import type { Me } from '../../lib/types';

/** Page-level info that custom blocks need (they render inside BlockNote node views). */
export interface EditorPage {
  pageId: string;
  editable: boolean;
  me: Me | null;
  /** Synced-block source ids above this editor, to stop a block embedding itself. */
  syncedAncestors: string[];
}

export const EditorPageContext = createContext<EditorPage>({ pageId: '', editable: false, me: null, syncedAncestors: [] });
export const useEditorPage = () => useContext(EditorPageContext);

/** Native-event isolation for interactive UI inside a block, so ProseMirror ignores it. */
export function isolate(el: HTMLElement | null) {
  if (!el || el.dataset.isolated) return;
  el.dataset.isolated = '1';
  for (const t of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'mousedown', 'paste', 'copy', 'cut', 'drop', 'dragstart', 'compositionstart', 'compositionend']) {
    el.addEventListener(t, (e) => e.stopPropagation());
  }
}
