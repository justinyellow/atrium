import { create } from 'zustand';
import { useUi } from '../lib/store';

interface AiUiState {
  open: boolean;
  /** Question to send as soon as the panel opens (from Ctrl+K "Ask AI"). */
  pendingQuestion: string | null;
  openPanel: (question?: string) => void;
  close: () => void;
  toggle: () => void;
}

/** Only one right-hand panel at a time: opening AI closes comments / row peek (and vice versa, see AiPanelHost). */
export const useAiUi = create<AiUiState>((set, get) => ({
  open: false,
  pendingQuestion: null,
  openPanel: (question) => {
    useUi.getState().set({ comments: null, peekRowId: null, quickFind: false });
    set({ open: true, pendingQuestion: question ?? null });
  },
  close: () => set({ open: false, pendingQuestion: null }),
  toggle: () => (get().open ? get().close() : get().openPanel()),
}));
