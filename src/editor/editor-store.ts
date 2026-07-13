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
import type { ClientRoom, RoomView, RoomViewId } from '../client/rooms';
import type { PlayerId } from '../core/client';
import type { ScenePayload } from '../core/content/scene-store';
import type { PlayerMode, RoomInfo } from '../core/protocol';
import type { Resources } from '../core/resources';
import type { EditRoomStoreApi } from './edit-room-store';
import { HOTBAR_SIZE, type HotbarSlot } from './inventory';
import { loadHotbar, saveHotbar } from './preferences';

/** Transient HMR / status notification shown briefly in the top-left of
 *  the editor viewport. Pushed from `applyRegistryChanges` for each
 *  registry kind that had pending changes; auto-dismissed by the row. */
export type Toast = {
    id: string;
    /** registry kind or other source label (used for keying + dedupe). */
    kind: string;
    message: string;
    createdAt: number;
};

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
    roomId: string | null;
    sceneId: string | null;
    room: ClientRoom | null;

    /* ── room registries ── */
    roomList: RoomInfo[];
    joinedPlayers: JoinedPlayer[];
    /** every ClientRoom the client holds, kept in sync with engine state.
     *  used by the debug panel to show per-room metrics. */
    allRooms: ClientRoom[];
    /** addressable RoomViews keyed by RoomViewId. one entry per ClientRoom's
     *  player POV (id = String(playerId)), plus one extra entry per
     *  `room.editor` (id = editor uuid). recomputed by `buildRoomViews` in
     *  rooms.ts and pushed in via `setRoomViews` whenever the room set or
     *  any room.editor pointer changes. */
    roomViews: Map<RoomViewId, RoomView>;
    /** per-player edit stores, keyed by PlayerId. populated from
     *  EditorScript onInit; the active store is `playerEditStores[room.playerId]`.
     *  keyed by player so play- and edit-mode joins to the same roomId hold
     *  independent stores. */
    playerEditStores: Record<PlayerId, EditRoomStoreApi>;

    /* ── shared resources ── */
    resources: Resources | null;

    /* ── blueprints (editor-only) ──
     * Payloads pulled in by `blueprints.ts` off the kit's
     * `bongle:scene-update` HMR channel (edit-mode dev only). Keyed by scene
     * id (always `blueprints/...`); read by the inventory + placement tool
     * to look up node trees without consulting the runtime scene registry. */
    blueprints: Map<string, ScenePayload>;
    setBlueprint: (id: string, payload: ScenePayload) => void;
    removeBlueprint: (id: string) => void;

    /* ── scene list (editor-only) ──
     * Mirror of the kit plugin's authoritative scene set, pulled in by
     * `blueprints.ts` off the `bongle:scene-list` HMR channel +
     * an initial `/__bongle/scenes` cold-fetch. Includes every
     * `scene()`-declared id and (in edit mode) every `blueprints/...`
     * file on disk. Read by the scenes drawer, inventory, and the
     * blueprint sync loop itself. */
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
    // Tabs in the toolbar subscribe here; click handlers in client/editor.ts
    // call `setRoomView` after running the imperative POV swap.
    playerToView: Map<PlayerId, 'edit' | 'play'>;

    /* ── transient toasts (top-left HMR notifications) ── */
    toasts: Toast[];

    /* ── network latency simulation (editor dev only) ──
     * When enabled, edit-client's RAF loop holds outbound + inbound WS
     * frames to simulate round-trip latency; `netSimRttMs` is split in
     * half across each direction. `netSimJitterMs` adds a per-frame uniform
     * random [0, jitter] on top, so releases are unevenly spaced — the
     * variable-latency condition that exercises snapshot interpolation and
     * the server-clock estimator (a constant delay alone spaces releases
     * evenly and hides jitter). Read by kit/runtime/edit-client.ts via
     * `useEditor.getState()` each frame. Per-session, never persisted. */
    netSimEnabled: boolean;
    netSimRttMs: number;
    netSimJitterMs: number;

    /* ── hotbar (localStorage-persisted user palette, shared across rooms) ── */
    hotbar: HotbarSlot[]; // length === HOTBAR_SIZE

    /* ── room registry actions ── */
    /** register the per-player edit store on a ClientRoom. Mirrors the store
     *  onto `room.editorStore` (for non-React script consumers) and into the
     *  `playerEditStores` map (for the `useEditRoom` React hook). Keyed by
     *  `room.playerId`. Pass `null` on dispose. */
    registerEditRoomStore: (room: ClientRoom, store: EditRoomStoreApi | null) => void;

    /* ── room-management actions (bound once at registerClient, never re-wired) ── */
    switchRoom: (roomId: string, mode: PlayerMode) => void;
    joinRoom: (roomId: string, mode: PlayerMode) => void;
    leaveRoom: (roomId: string, mode: PlayerMode) => void;
    stopRoom: (roomId: string) => void;

    /* ── setters ── */
    setMode: (mode: 'edit' | 'play') => void;
    setRoomMode: (roomMode: 'edit' | 'play') => void;
    setRoomId: (roomId: string | null) => void;
    setSceneId: (sceneId: string | null) => void;
    setRoom: (room: ClientRoom | null) => void;
    setRoomList: (rooms: RoomInfo[]) => void;
    setJoinedPlayers: (players: JoinedPlayer[]) => void;
    setAllRooms: (rooms: ClientRoom[]) => void;
    setRoomViews: (m: Map<RoomViewId, RoomView>) => void;
    setRoomView: (playerId: PlayerId, view: 'edit' | 'play') => void;
    clearRoomView: (playerId: PlayerId) => void;

    /* ── hotbar ── */
    setHotbarSlot: (index: number, item: HotbarSlot) => void;

    /* ── toasts ── */
    pushToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void;
    dismissToast: (id: string) => void;

    /* ── net sim ── */
    setNetSimEnabled: (enabled: boolean) => void;
    setNetSimRttMs: (ms: number) => void;
    setNetSimJitterMs: (ms: number) => void;
};

export const useEditor = create<EditorStore>((set, _get) => ({
    /* ── initial state ── */
    mode: 'edit',
    roomMode: 'edit',
    roomId: null,
    sceneId: null,
    room: null,

    roomList: [],
    joinedPlayers: [],
    allRooms: [],
    roomViews: new Map(),
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

    toasts: [],

    netSimEnabled: false,
    netSimRttMs: 100,
    netSimJitterMs: 0,

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

    /* ── room-management actions, bound by registerClient (engine-client.ts). ── */
    switchRoom: () => {},
    joinRoom: () => {},
    leaveRoom: () => {},
    stopRoom: () => {},

    /* ── setters ── */
    setMode: (mode) => set({ mode }),
    setRoomMode: (roomMode) => set({ roomMode }),
    setRoomId: (roomId) => set({ roomId }),
    setSceneId: (sceneId) => set({ sceneId }),
    setRoom: (room) => set({ room }),
    setRoomList: (roomList) => set({ roomList }),
    setJoinedPlayers: (joinedPlayers) => set({ joinedPlayers }),
    setAllRooms: (allRooms) => set({ allRooms }),
    setRoomViews: (roomViews) => set({ roomViews }),
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

    pushToast: (toast) =>
        set((s) => ({
            toasts: [...s.toasts, { ...toast, id: crypto.randomUUID(), createdAt: performance.now() }],
        })),

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    setNetSimEnabled: (netSimEnabled) => set({ netSimEnabled }),
    setNetSimRttMs: (netSimRttMs) => set({ netSimRttMs }),
    setNetSimJitterMs: (netSimJitterMs) => set({ netSimJitterMs }),
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
