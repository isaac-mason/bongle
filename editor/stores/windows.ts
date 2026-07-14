// editor/stores/windows.ts — window-manager state (hand-rolled, zustand-backed).
//
// Per-window geometry + stacking + mode (normal/minimized), keyed by a stable
// window id. Windows can also be SNAPPED to a screen zone (full / left / right /
// quarter) à la Aero snap: a snapped window stores its zone and re-derives its
// pixel rect from the live viewport, so splits survive a browser resize. The
// window definitions (title, content) live in the app; this store only tracks
// placement + state.

import { create } from 'zustand';
import { TASKBAR_W } from '../ui/components/Taskbar';

export type WinMode = 'normal' | 'minimized';

/** a snap target. `full` is maximize; the rest tile the desktop area. */
export type SnapZone = 'full' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br';

type Rect = { x: number; y: number; w: number; h: number };

export type WinGeom = {
    x: number;
    y: number;
    w: number;
    h: number;
    /** stacking order; higher = on top. */
    z: number;
    mode: WinMode;
    /** which screen zone this window is snapped to, or null when floating. When
     *  set, x/y/w/h hold the zone's derived pixel rect (recomputed on resize). */
    snap: SnapZone | null;
    /** the floating rect to restore to when un-snapping; null while floating. */
    float: Rect | null;
};

export const MIN_W = 200;
export const MIN_H = 120;

const viewportW = (): number => (typeof window === 'undefined' ? 1280 : window.innerWidth);
const viewportH = (): number => (typeof window === 'undefined' ? 800 : window.innerHeight);

const clampRange = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** push the window fully into the viewport — both edges, right of the taskbar. */
function rescue(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const viewW = viewportW();
    const viewH = viewportH();
    return {
        x: clampRange(x, TASKBAR_W, Math.max(TASKBAR_W, viewW - w)),
        y: clampRange(y, 0, Math.max(0, viewH - h)),
    };
}

/** the pixel rect for a snap zone in the current (or given) viewport. The desktop
 *  area is everything right of the taskbar; halves/quarters tile it, right-anchored
 *  zones hug the right edge so a left+right pair meets with no gap. */
export function snapRect(zone: SnapZone, vw = viewportW(), vh = viewportH()): Rect {
    const x0 = TASKBAR_W;
    const fullW = Math.max(MIN_W, vw - x0);
    const halfW = Math.max(MIN_W, Math.floor(fullW / 2));
    const halfH = Math.max(MIN_H, Math.floor(vh / 2));
    const rightX = x0 + (fullW - halfW);
    const botY = vh - halfH;
    switch (zone) {
        case 'full':
            return { x: x0, y: 0, w: fullW, h: vh };
        case 'left':
            return { x: x0, y: 0, w: halfW, h: vh };
        case 'right':
            return { x: rightX, y: 0, w: halfW, h: vh };
        case 'tl':
            return { x: x0, y: 0, w: halfW, h: halfH };
        case 'tr':
            return { x: rightX, y: 0, w: halfW, h: halfH };
        case 'bl':
            return { x: x0, y: botY, w: halfW, h: halfH };
        case 'br':
            return { x: rightX, y: botY, w: halfW, h: halfH };
    }
}

/** which snap zone (if any) a pointer at (px,py) is hovering, by proximity to the
 *  desktop edges. Corners win over edges: near a horizontal edge, being within
 *  CORNER of a side makes it a quarter; likewise near a vertical edge. */
export function zoneAt(px: number, py: number, vw = viewportW(), vh = viewportH()): SnapZone | null {
    const EDGE = 26;
    const CORNER = 150;
    const x0 = TASKBAR_W;
    if (py <= EDGE) {
        if (px <= x0 + CORNER) return 'tl';
        if (px >= vw - CORNER) return 'tr';
        return 'full';
    }
    if (px <= x0 + EDGE) {
        if (py <= CORNER) return 'tl';
        if (py >= vh - CORNER) return 'bl';
        return 'left';
    }
    if (px >= vw - EDGE) {
        if (py <= CORNER) return 'tr';
        if (py >= vh - CORNER) return 'br';
        return 'right';
    }
    if (py >= vh - EDGE) {
        if (px <= x0 + CORNER) return 'bl';
        if (px >= vw - CORNER) return 'br';
        return null;
    }
    return null;
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
    /** drop focus if this window holds it (e.g. it just closed). */
    blur: (id: string) => void;
    move: (id: string, x: number, y: number) => void;
    resize: (id: string, w: number, h: number) => void;
    /** set full geometry at once (corner resize moves the anchored edge). */
    setBox: (id: string, x: number, y: number, w: number, h: number) => void;
    setMode: (id: string, mode: WinMode) => void;
    /** snap a window to a screen zone, remembering its floating rect to restore. */
    snapTo: (id: string, zone: SnapZone) => void;
    /** release a snap back to the floating rect, optionally repositioned. */
    unsnap: (id: string, x?: number, y?: number) => void;
    /** toggle maximize (the `full` snap zone). */
    toggleMax: (id: string) => void;
    /** re-derive layout for the current viewport: snapped windows re-tile, floating
     *  windows re-clamp on-screen. Call on browser resize. */
    relayout: () => void;
};

export const useWindows = create<WindowStore>((set, get) => ({
    geom: {},
    focused: null,
    topZ: 1,
    register: (id, init) =>
        set((s) => {
            if (s.geom[id]) return s;
            const z = s.topZ + 1;
            // a window declared beyond the viewport (small screen) starts on-screen.
            const { x, y } = rescue(init.x, init.y, init.w, init.h);
            return {
                geom: { ...s.geom, [id]: { ...init, x, y, z, mode: 'normal', snap: null, float: null } },
                topZ: z,
                focused: id,
            };
        }),
    focus: (id) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            const z = s.topZ + 1;
            const mode: WinMode = g.mode === 'minimized' ? 'normal' : g.mode;
            return { topZ: z, focused: id, geom: { ...s.geom, [id]: { ...g, z, mode } } };
        }),
    blur: (id) => set((s) => (s.focused === id ? { focused: null } : s)),
    move: (id, x, y) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            return { geom: { ...s.geom, [id]: { ...g, ...rescue(x, y, g.w, g.h) } } };
        }),
    resize: (id, w, h) =>
        set((s) =>
            s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) } } } : s,
        ),
    setBox: (id, x, y, w, h) => set((s) => (s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, x, y, w, h } } } : s)),
    setMode: (id, mode) => set((s) => (s.geom[id] ? { geom: { ...s.geom, [id]: { ...s.geom[id]!, mode } } } : s)),
    snapTo: (id, zone) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            // remember the floating rect on first snap; a re-snap keeps the original.
            const float = g.snap ? g.float : { x: g.x, y: g.y, w: g.w, h: g.h };
            return { geom: { ...s.geom, [id]: { ...g, ...snapRect(zone), snap: zone, float, mode: 'normal' } } };
        }),
    unsnap: (id, x, y) =>
        set((s) => {
            const g = s.geom[id];
            if (!g) return s;
            // fall back to a sane floating size if none was remembered.
            const fl = g.float ?? {
                x: g.x,
                y: g.y,
                w: Math.max(MIN_W, Math.min(g.w, 640)),
                h: Math.max(MIN_H, Math.min(g.h, 480)),
            };
            const p = rescue(x ?? fl.x, y ?? fl.y, fl.w, fl.h);
            return { geom: { ...s.geom, [id]: { ...g, x: p.x, y: p.y, w: fl.w, h: fl.h, snap: null, float: null } } };
        }),
    toggleMax: (id) => {
        const g = get().geom[id];
        if (!g) return;
        if (g.snap === 'full') get().unsnap(id);
        else get().snapTo(id, 'full');
    },
    relayout: () =>
        set((s) => {
            const geom = { ...s.geom };
            for (const [id, g] of Object.entries(s.geom)) {
                if (g.snap) {
                    const r = snapRect(g.snap);
                    if (r.x !== g.x || r.y !== g.y || r.w !== g.w || r.h !== g.h) geom[id] = { ...g, ...r };
                } else {
                    const p = rescue(g.x, g.y, g.w, g.h);
                    if (p.x !== g.x || p.y !== g.y) geom[id] = { ...g, ...p };
                }
            }
            return { geom };
        }),
}));

/** transient drag-time snap preview: the zone the dragged window would snap to on
 *  release, or null. Kept out of the geom store so updating it every pointermove
 *  only re-renders the overlay, not every window. */
export const useSnapPreview = create<{ zone: SnapZone | null; setZone: (z: SnapZone | null) => void }>((set) => ({
    zone: null,
    setZone: (zone) => set((s) => (s.zone === zone ? s : { zone })),
}));
