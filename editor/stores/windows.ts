// editor/stores/windows.ts — window-manager state (hand-rolled, zustand-backed).
//
// Per-window geometry + stacking + mode (normal/minimized/maximized), keyed
// by a stable window id. The window definitions (title, content) live in the
// app; this store only tracks their placement + state.

import { create } from 'zustand';
import { TASKBAR_W } from '../ui/components/Taskbar';

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

// rescue geometry: a window can hang off an edge, but never fully — keep at
// least this slice of the title bar grabbable (right of the taskbar, inside the
// viewport). The title bar is TITLE_H tall (see Window.tsx).
const KEEP = 48;
const TITLE_H = 26;

const clampRange = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** clamp a window's top-left so a grabbable part of its title bar stays on the
 *  desktop — right of the left taskbar and within the current viewport. */
function rescue(x: number, y: number, w: number): { x: number; y: number } {
    const viewW = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const viewH = typeof window === 'undefined' ? 800 : window.innerHeight;
    return {
        // may go negative (window hangs off the left) but keeps KEEP px past the taskbar.
        x: clampRange(x, TASKBAR_W + KEEP - w, viewW - KEEP),
        // title bar never above the top nor below the bottom edge.
        y: clampRange(y, 0, viewH - TITLE_H),
    };
}

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
    /** re-clamp every window into the current viewport (e.g. on browser resize). */
    rescueAll: () => void;
};

export const useWindows = create<WindowStore>((set) => ({
    geom: {},
    focused: null,
    topZ: 1,
    register: (id, init) =>
        set((s) => {
            if (s.geom[id]) return s;
            const z = s.topZ + 1;
            // a window declared beyond the viewport (small screen) starts on-screen.
            const { x, y } = rescue(init.x, init.y, init.w);
            return { geom: { ...s.geom, [id]: { ...init, x, y, z, mode: 'normal' } }, topZ: z, focused: id };
        }),
    focus: (id) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            const z = s.topZ + 1;
            const mode: WinMode = g.mode === 'minimized' ? 'normal' : g.mode;
            return { topZ: z, focused: id, geom: { ...s.geom, [id]: { ...g, z, mode } } };
        }),
    move: (id, x, y) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            return { geom: { ...s.geom, [id]: { ...g, ...rescue(x, y, g.w) } } };
        }),
    rescueAll: () =>
        set((s) => {
            const geom = { ...s.geom };
            for (const [id, g] of Object.entries(s.geom)) {
                const p = rescue(g.x, g.y, g.w);
                if (p.x !== g.x || p.y !== g.y) geom[id] = { ...g, ...p };
            }
            return { geom };
        }),
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
