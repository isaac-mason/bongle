// editor/stores/open-file.ts — open editor tabs + active file + per-file
// dirty state. Shared by the code pane (sidebar, tabs, Monaco) and the
// standalone file browser (which can open tabs too).

import { create } from 'zustand';

type OpenFileStore = {
    /** open file paths, in tab order. */
    tabs: string[];
    /** the focused tab, or null when none are open. */
    active: string | null;
    /** unsaved flag per path. */
    dirty: Record<string, boolean>;
    /** open a file: add a tab if new, then focus it. */
    open: (path: string) => void;
    /** focus an already-open tab. */
    activate: (path: string) => void;
    /** close a tab; focus a neighbor if it was active. */
    close: (path: string) => void;
    setDirty: (path: string, dirty: boolean) => void;
};

export const useOpenFile = create<OpenFileStore>((set) => ({
    tabs: [],
    active: null,
    dirty: {},
    open: (path) =>
        set((s) => ({
            tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
            active: path,
        })),
    activate: (path) => set({ active: path }),
    close: (path) =>
        set((s) => {
            const i = s.tabs.indexOf(path);
            const tabs = s.tabs.filter((t) => t !== path);
            const { [path]: _drop, ...dirty } = s.dirty;
            const active = s.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active;
            return { tabs, active, dirty };
        }),
    setDirty: (path, dirty) => set((s) => ({ dirty: { ...s.dirty, [path]: dirty } })),
}));
