import { create } from 'zustand';

const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`atrium:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`atrium:${k}`, JSON.stringify(v));
    } catch {}
  },
};

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  expanded: Record<string, boolean>;
  quickFind: boolean;
  settings: string | null; // open tab name
  inbox: boolean;
  peekRowId: string | null;
  comments: { pageId: string; threadId?: string | null } | null;
  setSidebarOpen: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  toggleExpanded: (id: string, v?: boolean) => void;
  set: (p: Partial<UiState>) => void;
}

export const useUi = create<UiState>((set, get) => ({
  sidebarOpen: ls.get('sidebarOpen', true),
  sidebarWidth: ls.get('sidebarWidth', 248),
  expanded: ls.get('expanded', {}),
  quickFind: false,
  settings: null,
  inbox: false,
  peekRowId: null,
  comments: null,
  setSidebarOpen: (v) => {
    ls.set('sidebarOpen', v);
    set({ sidebarOpen: v });
  },
  setSidebarWidth: (w) => {
    ls.set('sidebarWidth', w);
    set({ sidebarWidth: w });
  },
  toggleExpanded: (id, v) => {
    const expanded = { ...get().expanded, [id]: v ?? !get().expanded[id] };
    ls.set('expanded', expanded);
    set({ expanded });
  },
  set: (p) => set(p),
}));

export function applyTheme(theme: string) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  ls.set('theme', theme);
}
applyTheme(ls.get('theme', 'system'));
