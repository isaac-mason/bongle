/**
 * client-store, engine-essential UI state. Imported by both play and editor
 * builds (the editor reads/writes these alongside its own editor-store).
 * Lives outside `editor/` so engine-client.ts and play-ui can touch it
 * without pulling editor code into play bundles.
 */

import { create } from 'zustand';
import type { PlayerId } from '../../../core/client';
import type * as Debug from '../../../core/debug';
import type { InputManager } from '../../input';
import type { ClientRoom } from '../../rooms';

/** which input the user is driving with RIGHT NOW ("last input wins"). Gates pointer
 *  lock (a finger can't be locked) and on-screen touch controls. Distinct from static
 *  touch CAPABILITY (`device.deviceType`): a mouse user on a touchscreen laptop is
 *  `mouse`, and a hybrid flips as they switch. */
export type InputMode = 'mouse' | 'touch';

export type ClientStore = {
    /** the viewport div that room canvases are appended to */
    viewportElement: HTMLElement | null;
    setViewportElement: (el: HTMLElement | null) => void;

    /** viewport pixel dims, written by the Viewport component (mount + ResizeObserver),
     *  read by the engine. The store is the source of truth so engine boot ordering
     *  (mountPlayUI then load) can't race the initial size. */
    viewportWidth: number;
    viewportHeight: number;
    setViewportSize: (width: number, height: number) => void;

    /** reactive MIRROR of the input modality for touch UI (the chat opener). The source
     *  of truth is `InputManager.inputMode` (React-free); engine-client projects it here
     *  each tick. UI reads this; the engine reads the source directly. */
    inputMode: InputMode;
    setInputMode: (mode: InputMode) => void;

    // debug dashboard, backtick toggles `debugOpen`. the dashboard itself is
    // vanilla dashcat (client/ui/dashboard.ts), driven off this bit; the
    // gpucat Inspector overlay is shown alongside it while open.
    debugOpen: boolean;
    setDebugOpen: (open: boolean) => void;
    toggleDebugOpen: () => void;

    /** gpucat Inspector overlay (GPU timing), gated behind the options-tab toggle;
     *  only shown when the debug dashboard is open AND this is on. */
    showGpucatInspector: boolean;
    setShowGpucatInspector: (show: boolean) => void;

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

    /** the focused room, mirrors `Rooms.activePlayerId`. */
    activePlayerId: PlayerId | null;
    setActivePlayerId: (id: PlayerId | null) => void;

    /** the client-level InputManager, so React overlays can free the cursor while
     *  open via `useReleasePointer`. Set at boot, cleared on teardown. */
    inputManager: InputManager | null;
    setInputManager: (m: InputManager | null) => void;
};

export const useClient = create<ClientStore>((set) => ({
    viewportElement: null,
    setViewportElement: (el) => set({ viewportElement: el }),
    viewportWidth: 0,
    viewportHeight: 0,
    setViewportSize: (viewportWidth, viewportHeight) => set({ viewportWidth, viewportHeight }),

    // seeded + kept current by engine-client from the InputManager source; this default
    // only holds pre-boot.
    inputMode: 'mouse',
    setInputMode: (inputMode) => set({ inputMode }),

    debugOpen: false,
    setDebugOpen: (debugOpen) => set({ debugOpen }),
    toggleDebugOpen: () => set((s) => ({ debugOpen: !s.debugOpen })),

    showGpucatInspector: false,
    setShowGpucatInspector: (showGpucatInspector) => set({ showGpucatInspector }),

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

    inputManager: null,
    setInputManager: (inputManager) => set({ inputManager }),
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
