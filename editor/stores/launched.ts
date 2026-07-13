// editor/stores/launched.ts — dynamically-launched app windows. The fixed
// windows (files, code, pipeline…) live in main.tsx; these are spawned on
// demand when the file tree opens a file whose app handles it. One window per
// (app, path) — re-opening the same file just focuses the existing window,
// which keeps its placement (window geometry is keyed by the same id).

import { create } from 'zustand';
import type { AppDef } from '../ui/apps';
import { useWindows } from './windows';

export type LaunchedWindow = { id: string; appId: string; path: string; title: string };

let launchCount = 0;

type LaunchStore = {
    windows: LaunchedWindow[];
    /** per-window unsaved flag, keyed by window id; an app publishes its own. */
    dirty: Record<string, boolean>;
    /** open (or focus) a window running `app` on `path`. */
    launch: (app: AppDef, path: string) => void;
    /** close a launched window (its geometry is kept for a later re-open). */
    close: (id: string) => void;
    /** an app reporting its unsaved state (shown as a title-bar dot). */
    setDirty: (id: string, dirty: boolean) => void;
};

export const useLaunched = create<LaunchStore>((set, get) => ({
    windows: [],
    dirty: {},
    launch: (app, path) => {
        const id = `${app.id}:${path}`;
        if (!get().windows.some((w) => w.id === id)) {
            const off = (launchCount++ % 6) * 26;
            useWindows.getState().register(id, { x: 150 + off, y: 60 + off, w: app.initial.w, h: app.initial.h });
            const name = path.split('/').pop() ?? path;
            set((s) => ({
                windows: [...s.windows, { id, appId: app.id, path, title: `${app.title} — ${name}` }],
            }));
        }
        useWindows.getState().focus(id);
    },
    close: (id) =>
        set((s) => {
            const { [id]: _drop, ...dirty } = s.dirty;
            return { windows: s.windows.filter((w) => w.id !== id), dirty };
        }),
    setDirty: (id, dirty) => set((s) => (s.dirty[id] === dirty ? s : { dirty: { ...s.dirty, [id]: dirty } })),
}));
