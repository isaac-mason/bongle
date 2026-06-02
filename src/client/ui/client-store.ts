/**
 * client-store — engine-essential UI state. Imported by both play and editor
 * builds (the editor reads/writes these alongside its own editor-store).
 * Lives outside `editor/` so engine-client.ts and play-ui can touch it
 * without pulling editor code into play bundles.
 */

import { create } from 'zustand';
import { env } from '../../api/env';
import type * as Debug from '../../core/debug';
import type { PlayerId } from '../../core/client';
import type { ClientRoom } from '../rooms';

/** debug panel tab. 'logs' and 'deps' are editor-only and filtered out of
 *  the tab strip in non-editor builds. 'renderer' shows the gpucat
 *  Inspector overlay; the panel's own content area is empty in that mode. */
export type DebugTab = 'perf' | 'logs' | 'renderer' | 'deps';

/** Tabs visible in the current build. Lives here (not in debug-panel.tsx)
 *  so the keyboard handler in edit-ui.tsx can map `` ` + N `` to a tab
 *  without pulling the lazy DebugPanel chunk eagerly. */
export function availableDebugTabs(): DebugTab[] {
    return env.editor ? ['perf', 'logs', 'renderer', 'deps'] : ['perf', 'renderer'];
}

export type ClientStore = {
    /** the viewport div that room canvases are appended to */
    viewportElement: HTMLElement | null;
    setViewportElement: (el: HTMLElement | null) => void;

    /** viewport pixel dims — written by the Viewport component (mount + ResizeObserver),
     *  read by the engine. The store is the source of truth so engine boot ordering
     *  (mountPlayUI then load) can't race the initial size. */
    viewportWidth: number;
    viewportHeight: number;
    setViewportSize: (width: number, height: number) => void;

    // debug panel — backtick toggles `debugOpen`; the panel's top tab strip
    // switches `debugTab`. 'renderer' surfaces the gpucat Inspector overlay
    // (driven from engine-client.ts via setInspectorVisible), which is
    // intentionally available in play builds too.
    debugOpen: boolean;
    setDebugOpen: (open: boolean) => void;
    toggleDebugOpen: () => void;
    debugTab: DebugTab;
    setDebugTab: (tab: DebugTab) => void;

    /** global client-tick metrics (state.metrics on EngineClient).
     *  measured across all rooms, useful for spotting whole-frame regressions. */
    clientGlobalMetrics: Debug.Metrics | null;
    setClientGlobalMetrics: (m: Debug.Metrics | null) => void;

    /** every ClientRoom the engine is currently observing, keyed by playerId.
     *  mirrored from `Rooms.rooms` via `setRoom` / `removeRoom`. The map identity
     *  changes on each write so zustand selectors over the map (size, entries)
     *  invalidate; per-room selectors via `useRoom` read through `activePlayerId`. */
    rooms: Map<PlayerId, ClientRoom>;
    setRoom: (playerId: PlayerId, room: ClientRoom) => void;
    removeRoom: (playerId: PlayerId) => void;

    /** the focused room — mirrors `Rooms.activePlayerId`. */
    activePlayerId: PlayerId | null;
    setActivePlayerId: (id: PlayerId | null) => void;
};

export const useClient = create<ClientStore>((set) => ({
    viewportElement: null,
    setViewportElement: (el) => set({ viewportElement: el }),
    viewportWidth: 0,
    viewportHeight: 0,
    setViewportSize: (viewportWidth, viewportHeight) => set({ viewportWidth, viewportHeight }),

    debugOpen: false,
    setDebugOpen: (debugOpen) => set({ debugOpen }),
    toggleDebugOpen: () => set((s) => ({ debugOpen: !s.debugOpen })),
    debugTab: 'perf',
    setDebugTab: (debugTab) => set({ debugTab }),

    clientGlobalMetrics: null,
    setClientGlobalMetrics: (clientGlobalMetrics) => set({ clientGlobalMetrics }),

    rooms: new Map(),
    setRoom: (playerId, room) =>
        set((s) => {
            const next = new Map(s.rooms);
            next.set(playerId, room);
            return { rooms: next };
        }),
    removeRoom: (playerId) =>
        set((s) => {
            if (!s.rooms.has(playerId)) return s;
            const next = new Map(s.rooms);
            next.delete(playerId);
            return { rooms: next };
        }),

    activePlayerId: null,
    setActivePlayerId: (activePlayerId) => set({ activePlayerId }),
}));

/**
 * select a value from the currently active ClientRoom, or null if no room is
 * active. re-renders when `activePlayerId` flips or when the active room's
 * reference changes in the rooms map. Per-field reactivity (e.g. chat lines)
 * lives on the room's own subscribable substores (e.g. `ClientChat.subscribe`).
 */
export function useRoom<T>(selector: (room: ClientRoom) => T): T | null {
    return useClient((s) => {
        const id = s.activePlayerId;
        if (id == null) return null;
        const room = s.rooms.get(id);
        return room ? selector(room) : null;
    });
}
