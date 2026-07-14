// editor/stores/sync.ts — UI-facing status for the folder-sync feature. The
// reconciler (editor/sync/folder-sync.ts) owns the actual bytes + disk handle
// and reports its state here; the taskbar + chooser modal read it. Kept thin:
// no fs/handle references live here.

import { create } from 'zustand';

export type SyncPhase =
    | 'idle' // not connected
    | 'choosing' // direction modal open, awaiting a folder pick
    | 'connecting' // reconciling the initial seed
    | 'connected' // live two-way sync running
    | 'error';

type SyncStore = {
    phase: SyncPhase;
    /** picked folder name, once chosen. */
    folder: string | null;
    error: string | null;
    /** bumped each time a file actually crosses (either direction) — a real
     *  "files synced" count, not per-poll. Drives the icon's activity pulse. */
    activity: number;
    /** the status modal (Close / Stop syncing) is open. */
    panelOpen: boolean;
    beginChoose: () => void;
    cancel: () => void;
    connecting: (folder: string) => void;
    connected: (folder: string) => void;
    tick: () => void;
    fail: (error: string) => void;
    openPanel: () => void;
    closePanel: () => void;
    reset: () => void;
};

export const useSync = create<SyncStore>((set) => ({
    phase: 'idle',
    folder: null,
    error: null,
    activity: 0,
    panelOpen: false,
    beginChoose: () => set({ phase: 'choosing', error: null }),
    cancel: () => set((s) => (s.phase === 'choosing' ? { phase: 'idle' } : s)),
    connecting: (folder) => set({ phase: 'connecting', folder, error: null }),
    connected: (folder) => set({ phase: 'connected', folder }),
    tick: () => set((s) => ({ activity: s.activity + 1 })),
    fail: (error) => set({ phase: 'error', error }),
    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),
    reset: () => set({ phase: 'idle', folder: null, error: null, panelOpen: false }),
}));
