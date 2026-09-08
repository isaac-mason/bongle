/**
 * global editor store, fields that are NOT tied to a specific edit room.
 * per-player-session state (active tool, selection, transform options,
 * inventory session state, undo mirror, etc.) lives on per-player stores in
 * `edit-room-store.ts`, registered here under `playerEditStores`.
 *
 * Maps that vary across joined players (edit state, lens view, edit store)
 * are keyed by `PlayerId`, not `roomId`, a single roomId can have both a
 * play-mode and an edit-mode ClientRoom joined simultaneously, each with
 * its own independent editor state.
 *
 * UI components read global concerns from `useEditor` and per-player
 * concerns via `useEditRoom`, which derives the active player's store from
 * `useEditor.room.playerId` + `useEditor.playerEditStores`.
 */

import { create } from 'zustand';
import type { ClientRoom } from '../client/rooms';
import { useClient } from '../client/ui/stores/client-store';
import type { PlayerId } from '../core/client';
import type { ScenePayload } from '../core/content/scene-store';
import type { PlayerMode } from '../core/protocol';
import type { Resources } from '../core/resources';
import type { EditRoomStoreApi } from './edit-room-store';
import { defaultHotbar, HOTBAR_SIZE, type HotbarSlot } from './inventory';
import { hasStoredHotbar, loadHotbar, saveHotbar } from './preferences';

/** Slim record of a Player held by the client, for store/UI consumption. */
export type JoinedPlayer = {
    playerId: PlayerId;
    roomId: string;
    mode: PlayerMode;
};

export type EditorStore = {
    /* ── active player / room pointers (describe *which* room is focused) ── */
    mode: 'edit' | 'play';
    /** the active room's authoritative mode. may differ from `mode` (player
     *  view mode) when the user joins a play room with playerMode='edit'. */
    roomMode: 'edit' | 'play';
    /** true between a Play request (Tab / Play button) being sent and the
     *  spawned play room activating. drives the Play button's loading state.
     *  set by `edit-room-store.play()`, cleared deterministically when the
     *  play room activates (`setRoomMode`), with a timeout fallback in
     *  `setPlayPending` so a silent spawn failure can't leave it stuck. */
    playPending: boolean;
    roomId: string | null;
    sceneId: string | null;
    room: ClientRoom | null;

    /* ── room registries ── */
    /** one entry per ClientRoom the client holds; derived from `useClient.rooms`
     *  by the subscription at the bottom of this file. */
    joinedPlayers: JoinedPlayer[];
    /** per-player edit stores, keyed by PlayerId. populated from
     *  EditorScript onInit; the active store is `playerEditStores[room.playerId]`.
     *  keyed by player so play- and edit-mode joins to the same roomId hold
     *  independent stores. */
    playerEditStores: Record<PlayerId, EditRoomStoreApi>;

    /* ── shared resources ── */
    /** the engine's resource bag, bound by `loadEditorAssets` (icons.ts); the icon
     *  loaders read the byte loader off it. */
    resources: Resources | null;

    /* ── blueprints (editor-only) ──
     * Payloads pulled in by `blueprints.ts` from the injected scene source
     * (the browser editor's OPFS). Keyed by scene id (always `blueprints/...`);
     * read by the inventory + placement tool to look up node trees without
     * consulting the runtime scene registry. */
    blueprints: Map<string, ScenePayload>;
    setBlueprint: (id: string, payload: ScenePayload) => void;
    removeBlueprint: (id: string) => void;

    /* ── scene list (editor-only) ──
     * The authoritative scene set, listed by `blueprints.ts` from the injected
     * scene source. Includes every `scene()`-declared id and (in edit mode)
     * every `blueprints/...` file on disk. Read by the scenes drawer, inventory,
     * and the blueprint sync loop itself. */
    sceneList: string[];
    setSceneList: (sceneList: string[]) => void;

    /* ── voxel icon atlas ── */
    blockIconAtlasUrl: string | null;
    blockIconCoords: Record<string, [number, number]>;
    blockIconPx: number;
    blockIconCols: number;
    blockIconRows: number;
    /** prefab icons, rendered per-prefab in-browser on demand. prefabId → object
     *  URL. absent = not yet rendered (the inventory triggers a render on first
     *  display); cleared + revoked on registry change. */
    prefabIconUrls: Record<string, string>;

    /* ── per-player scene-view (tabs) ── */
    // which perspective the user is viewing the scene through. only present
    // while a play-mode player has a lens, entries are seeded by
    // enterLocalEditorView (writes 'edit') and cleared by exitLocalEditorView.
    // Tabs in the toolbar subscribe here; click handlers in lens.ts call
    // `setRoomView` after running the imperative POV swap.
    playerToView: Map<PlayerId, 'edit' | 'play'>;

    /* ── network latency simulation (editor dev only) ──
     * When enabled, edit-client's RAF loop holds outbound + inbound WS
     * frames to simulate round-trip latency; `netSimRttMs` is split in
     * half across each direction. `netSimJitterMs` adds a per-frame uniform
     * random [0, jitter] on top, so releases are unevenly spaced — the
     * variable-latency condition that exercises snapshot interpolation and
     * the server-clock estimator (a constant delay alone spaces releases
     * evenly and hides jitter). Read by the edit-client realm via
     * `useEditor.getState()` each frame. Per-session, never persisted. */
    netSimEnabled: boolean;
    netSimRttMs: number;
    netSimJitterMs: number;
    /** occasional head-of-line stall size (ms) and its per-frame probability. This
     *  is the bursty, correlated delay a real WAN link produces — the shape that
     *  actually breaks remote interpolation (freeze-and-snap), which steady rtt/jitter
     *  can't reproduce. 0 stall disables it. */
    netSimBurstMs: number;
    netSimBurstChance: number;

    /* ── debug view toggles, global (shared across rooms). read by the editor's
     *  per-room update loop (client.ts) + the orientation-cube overlay. per-session,
     *  never persisted. ── */
    showPhysicsColliders: boolean;
    showGrid: boolean;
    showOrientationCube: boolean;
    showChunkBoundaries: boolean;

    /* ── hotbar (localStorage-persisted user palette, shared across rooms) ── */
    hotbar: HotbarSlot[]; // length === HOTBAR_SIZE

    /* ── room registry actions ── */
    /** register the per-player edit store on a ClientRoom. Mirrors the store
     *  onto `room.editorStore` (for non-React script consumers) and into the
     *  `playerEditStores` map (for the `useEditRoom` React hook). Keyed by
     *  `room.playerId`. Pass `null` on dispose. */
    registerEditRoomStore: (room: ClientRoom, store: EditRoomStoreApi | null) => void;

    /* ── setters ── */
    setMode: (mode: 'edit' | 'play') => void;
    setRoomMode: (roomMode: 'edit' | 'play') => void;
    setPlayPending: (pending: boolean) => void;
    setRoomId: (roomId: string | null) => void;
    setSceneId: (sceneId: string | null) => void;
    setRoom: (room: ClientRoom | null) => void;
    setJoinedPlayers: (players: JoinedPlayer[]) => void;
    setRoomView: (playerId: PlayerId, view: 'edit' | 'play') => void;
    clearRoomView: (playerId: PlayerId) => void;

    /* ── hotbar ── */
    setHotbarSlot: (index: number, item: HotbarSlot) => void;

    /* ── net sim ── */
    setNetSimEnabled: (enabled: boolean) => void;
    setNetSimRttMs: (ms: number) => void;
    setNetSimJitterMs: (ms: number) => void;
    setNetSimBurstMs: (ms: number) => void;
    setNetSimBurstChance: (chance: number) => void;
    setShowPhysicsColliders: (show: boolean) => void;
    setShowGrid: (show: boolean) => void;
    setShowOrientationCube: (show: boolean) => void;
    setShowChunkBoundaries: (show: boolean) => void;
};

// fallback release for the Play spinner. the play room normally activates in
// well under a second; this only fires if the spawn fails silently (there's no
// `play_failed` protocol message), so the button can't get stuck spinning.
const PLAY_PENDING_TIMEOUT_MS = 15_000;
let playPendingTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditor = create<EditorStore>((set, _get) => ({
    /* ── initial state ── */
    mode: 'edit',
    roomMode: 'edit',
    playPending: false,
    roomId: null,
    sceneId: null,
    room: null,

    joinedPlayers: [],
    playerEditStores: {},

    resources: null,

    blueprints: new Map(),
    setBlueprint: (id, payload) =>
        set((s) => {
            const next = new Map(s.blueprints);
            next.set(id, payload);
            return { blueprints: next };
        }),
    removeBlueprint: (id) =>
        set((s) => {
            if (!s.blueprints.has(id)) return s;
            const next = new Map(s.blueprints);
            next.delete(id);
            return { blueprints: next };
        }),

    sceneList: [],
    setSceneList: (sceneList) => set({ sceneList }),

    blockIconAtlasUrl: null,
    blockIconCoords: {},
    blockIconPx: 0,
    blockIconCols: 0,
    blockIconRows: 0,
    prefabIconUrls: {},

    playerToView: new Map(),

    netSimEnabled: false,
    netSimRttMs: 100,
    netSimJitterMs: 0,
    netSimBurstMs: 0,
    netSimBurstChance: 0.02,

    showPhysicsColliders: false,
    showGrid: false,
    showOrientationCube: false,
    showChunkBoundaries: false,

    hotbar: loadHotbar(),

    /* ── room registry ── */
    registerEditRoomStore: (room, store) => {
        room.editorStore = store;
        set((s) => {
            const next = { ...s.playerEditStores };
            if (store === null) delete next[room.playerId];
            else next[room.playerId] = store;
            return { playerEditStores: next };
        });
    },

    /* ── setters ── */
    setMode: (mode) => set({ mode }),
    setRoomMode: (roomMode) => {
        // room activation is the deterministic "Play resolved" signal: a
        // successful play spawns + activates the play room, flipping roomMode
        // to 'play'. clear the pending spinner on any activation (switching to
        // another room while a play is in flight abandons it too).
        useEditor.getState().setPlayPending(false);
        set({ roomMode });
    },
    setPlayPending: (pending) => {
        if (playPendingTimer !== null) {
            clearTimeout(playPendingTimer);
            playPendingTimer = null;
        }
        if (pending) {
            playPendingTimer = setTimeout(() => {
                playPendingTimer = null;
                set({ playPending: false });
            }, PLAY_PENDING_TIMEOUT_MS);
        }
        set({ playPending: pending });
    },
    setRoomId: (roomId) => set({ roomId }),
    setSceneId: (sceneId) => set({ sceneId }),
    setRoom: (room) => {
        // lazy first-run hotbar seed. loadHotbar() runs at module init, before
        // the block registry is populated, so the default can't be computed
        // there; the first activated room is our "registry is ready" signal.
        // seeds only when nothing was ever persisted, and the write persists
        // (via the subscribe below), so a hotbar the user later empties is left
        // alone. no-op on subsequent room switches once a hotbar exists.
        if (room && !hasStoredHotbar()) {
            const seed = defaultHotbar();
            if (seed.some((slot) => slot !== null)) {
                set({ room, hotbar: seed });
                return;
            }
        }
        set({ room });
    },
    setJoinedPlayers: (joinedPlayers) => set({ joinedPlayers }),
    setRoomView: (playerId, view) =>
        set((s) => {
            if (s.playerToView.get(playerId) === view) return {};
            const next = new Map(s.playerToView);
            next.set(playerId, view);
            return { playerToView: next };
        }),
    clearRoomView: (playerId) =>
        set((s) => {
            if (!s.playerToView.has(playerId)) return {};
            const next = new Map(s.playerToView);
            next.delete(playerId);
            return { playerToView: next };
        }),

    setHotbarSlot: (index, item) =>
        set((s) => {
            if (index < 0 || index >= HOTBAR_SIZE) return {};
            const hotbar = s.hotbar.slice();
            hotbar[index] = item;
            return { hotbar };
        }),

    setNetSimEnabled: (netSimEnabled) => set({ netSimEnabled }),
    setNetSimRttMs: (netSimRttMs) => set({ netSimRttMs }),
    setNetSimJitterMs: (netSimJitterMs) => set({ netSimJitterMs }),
    setNetSimBurstMs: (netSimBurstMs) => set({ netSimBurstMs }),
    setNetSimBurstChance: (netSimBurstChance) => set({ netSimBurstChance }),
    setShowPhysicsColliders: (showPhysicsColliders) => set({ showPhysicsColliders }),
    setShowGrid: (showGrid) => set({ showGrid }),
    setShowOrientationCube: (showOrientationCube) => set({ showOrientationCube }),
    setShowChunkBoundaries: (showChunkBoundaries) => set({ showChunkBoundaries }),
}));

// persist hotbar slot changes to localStorage. only fires when the array
// reference changes (setHotbarSlot makes a new array), so other state
// updates don't trigger writes.
let lastSavedHotbar = useEditor.getState().hotbar;
useEditor.subscribe((state) => {
    if (state.hotbar !== lastSavedHotbar) {
        lastSavedHotbar = state.hotbar;
        saveHotbar(state.hotbar);
    }
});

// the engine writes the room set + active player into the client store; the
// editor's active-room pointers and the joined-player list derive from those.
function applyClientRooms(rooms: Map<PlayerId, ClientRoom>, activePlayerId: PlayerId | null): void {
    const editor = useEditor.getState();
    const players: JoinedPlayer[] = [];
    for (const room of rooms.values()) players.push({ playerId: room.playerId, roomId: room.roomId, mode: room.playerMode });
    editor.setJoinedPlayers(players);

    // `room.playerId` keys the active per-player store for useEditRoom (which
    // derives from `playerEditStores[room.playerId]`).
    const room = activePlayerId != null ? (rooms.get(activePlayerId) ?? null) : null;
    if (room) {
        editor.setMode(room.playerMode);
        editor.setRoomMode(room.roomMode);
        editor.setRoomId(room.roomId);
        editor.setSceneId(room.sceneId);
        editor.setRoom(room);
    } else if (editor.room) {
        editor.setRoomId(null);
        editor.setSceneId(null);
        editor.setRoom(null);
    }
}
useClient.subscribe((s, prev) => {
    if (s.rooms === prev.rooms && s.activePlayerId === prev.activePlayerId) return;
    applyClientRooms(s.rooms, s.activePlayerId);
});
