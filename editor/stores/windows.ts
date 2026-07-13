// editor/stores/windows.ts — window-manager state (hand-rolled, zustand-backed).
//
// Per-window geometry + stacking + mode (normal/minimized/maximized), keyed
// by a stable window id. The window definitions (title, content) live in the
// app; this store only tracks their placement + state.

import { create } from 'zustand';

export type WinMode = 'normal' | 'minimized' | 'maximized';

export type WinGeom = {
    x: number;
    y: number;
    w: number;
    h: number;
    /** stacking order; higher = on top. */
    z: number;
    mode: WinMode;
};

const MIN_W = 200;
const MIN_H = 120;

type WindowStore = {
    geom: Record<string, WinGeom>;
    focused: string | null;
    topZ: number;
    /** register a window with initial geometry. Idempotent — an existing
     *  window keeps its placement across React remounts. */
    register: (id: string, init: { x: number; y: number; w: number; h: number }) => void;
    /** raise + focus a window; restores it if minimized. */
    focus: (id: string) => void;
    move: (id: string, x: number, y: number) => void;
    resize: (id: string, w: number, h: number) => void;
    setMode: (id: string, mode: WinMode) => void;
    toggleMax: (id: string) => void;
};

export const useWindows = create<WindowStore>((set) => ({
    geom: {},
    focused: null,
    topZ: 1,
    register: (id, init) =>
        set((s) => {
            if (s.geom[id]) return s;
            const z = s.topZ + 1;
            return { geom: { ...s.geom, [id]: { ...init, z, mode: 'normal' } }, topZ: z, focused: id };
        }),
    focus: (id) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            const z = s.topZ + 1;
            const mode: WinMode = g.mode === 'minimized' ? 'normal' : g.mode;
            return { topZ: z, focused: id, geom: { ...s.geom, [id]: { ...g, z, mode } } };
        }),
    move: (id, x, y) => set((s) => (s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, x, y } } } : s)),
    resize: (id, w, h) =>
        set((s) =>
            s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) } } } : s,
        ),
    setMode: (id, mode) => set((s) => (s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, mode } } } : s)),
    toggleMax: (id) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            return { geom: { ...s.geom, [id]: { ...g, mode: g.mode === 'maximized' ? 'normal' : 'maximized' } } };
        }),
}));
