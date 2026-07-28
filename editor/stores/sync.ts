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

/** what a log line is about, so the panel can colour it. `push` = editor→folder,
 *  `pull` = folder→editor, `remove` = a delete on either side, `warn` = a skipped
 *  file, `info` = reconcile progress + lifecycle. */
export type SyncLogKind = 'info' | 'push' | 'pull' | 'remove' | 'warn';
/** one line in the panel's activity log. `t` is a wall-clock stamp for display;
 *  `seq` is a stable, monotonic React key (survives the ring trimming its head). */
export type SyncLogEntry = { seq: number; t: number; kind: SyncLogKind; message: string };

/** the activity log is a bounded ring — a long session mustn't grow it unbounded. */
const MAX_LOG = 200;
let logSeq = 0;

type SyncStore = {
    phase: SyncPhase;
    /** picked folder name, once chosen. */
    folder: string | null;
    error: string | null;
    /** bumped each time a file actually crosses (either direction) — a real
     *  "files synced" count, not per-poll. Drives the icon's activity pulse. */
    activity: number;
    /** rolling operation log the panel renders, so you can see reconcile progress
     *  and each file crossing (or being skipped) rather than a bare spinner. */
    logs: SyncLogEntry[];
    /** wall-clock of the last completed disk poll — a heartbeat proving the loop is
     *  alive even when nothing is crossing. Null until the first poll. */
    lastPoll: number | null;
    /** the status modal (Close / Stop syncing) is open. */
    panelOpen: boolean;
    beginChoose: () => void;
    cancel: () => void;
    connecting: (folder: string) => void;
    connected: (folder: string) => void;
    tick: () => void;
    log: (kind: SyncLogKind, message: string) => void;
    polled: () => void;
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
    logs: [],
    lastPoll: null,
    panelOpen: false,
    beginChoose: () => set({ phase: 'choosing', error: null }),
    cancel: () => set((s) => (s.phase === 'choosing' ? { phase: 'idle' } : s)),
    // a fresh session clears the prior log + heartbeat so the panel starts empty.
    connecting: (folder) => set({ phase: 'connecting', folder, error: null, logs: [], lastPoll: null }),
    connected: (folder) => set({ phase: 'connected', folder }),
    tick: () => set((s) => ({ activity: s.activity + 1 })),
    log: (kind, message) =>
        set((s) => {
            const next = [...s.logs, { seq: ++logSeq, t: Date.now(), kind, message }];
            if (next.length > MAX_LOG) next.splice(0, next.length - MAX_LOG);
            return { logs: next };
        }),
    polled: () => set({ lastPoll: Date.now() }),
    fail: (error) => set({ phase: 'error', error }),
    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),
    reset: () => set({ phase: 'idle', folder: null, error: null, panelOpen: false, logs: [], lastPoll: null }),
}));
