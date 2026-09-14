import { create } from 'zustand';
import type { ClientRoom } from '../client/rooms';
import { useClient } from '../client/ui/stores/client-store';
import type { PlayerId } from '../core/client';
import type { ScenePayload } from '../core/content/scene-store';
import type { PlayerMode } from '../core/protocol';
import type { Resources } from '../core/resources';
import type { EditRoomStoreApi } from './edit-room-store';
import { defaultHotbar, HOTBAR_SIZE, type HotbarSlot } from './inventory';
import type { Lens } from './lens';
import { hasStoredHotbar, loadHotbar, saveHotbar } from './preferences';

/** Slim record of a Player held by the client, for store/UI consumption. */
export type JoinedPlayer = {
    playerId: PlayerId;
    roomId: string;
    mode: PlayerMode;
};

export type EditorStore = {
    mode: 'edit' | 'play';
    /** the active room's authoritative mode; may differ from `mode` when the user joins a play room with playerMode='edit'. */
    roomMode: 'edit' | 'play';
    /** true between a Play request being sent and the spawned play room activating; drives the Play button's loading state.
     *  cleared by `setRoomMode` on activation, with a timeout fallback in `setPlayPending` for a silent spawn failure. */
    playPending: boolean;
    roomId: string | null;
    sceneId: string | null;
    room: ClientRoom | null;

    /** one entry per ClientRoom the client holds; derived from `useClient.rooms` by the subscription at the bottom of this file. */
    joinedPlayers: JoinedPlayer[];
    /** keyed by PlayerId (not roomId) so play- and edit-mode joins to the same roomId hold independent stores. */
    playerEditStores: Record<PlayerId, EditRoomStoreApi>;

    /** the engine's resource bag, bound by `loadEditorAssets` (icons.ts); icon loaders read the byte loader off it. */
    resources: Resources | null;

    /** payloads pulled in by `blueprints.ts` from the injected scene source, keyed by scene id (always `blueprints/...`). */
    blueprints: Map<string, ScenePayload>;
    setBlueprint: (id: string, payload: ScenePayload) => void;
    removeBlueprint: (id: string) => void;

    /** every `scene()`-declared id plus, in edit mode, every `blueprints/...` file on disk. */
    sceneList: string[];
    setSceneList: (sceneList: string[]) => void;

    blockIconAtlasUrl: string | null;
    blockIconCoords: Record<string, [number, number]>;
    blockIconPx: number;
    blockIconCols: number;
    blockIconRows: number;
    /** prefabId -> object URL, rendered per-prefab in-browser on demand. absent = not yet rendered. */
    prefabIconUrls: Record<string, string>;

    /** which perspective the user is viewing the scene through; only present while a play-mode
     *  player has a lens, seeded by enterLocalEditorView and cleared by exitLocalEditorView. */
    playerToView: Map<PlayerId, 'edit' | 'play'>;
    /** the local editor lens on each play-mode player's room (lens.ts), keyed by player. */
    lenses: Map<PlayerId, Lens>;

    /** editor dev only: edit-client's RAF loop holds WS frames to simulate round-trip latency,
     *  split in half across each direction. */
    netSimEnabled: boolean;
    netSimRttMs: number;
    /** per-frame uniform random [0, jitter] added on top of netSimRttMs. */
    netSimJitterMs: number;
    /** occasional head-of-line stall size (ms) and its per-frame probability, the bursty WAN
     *  delay shape that breaks remote interpolation (freeze-and-snap). 0 disables it. */
    netSimBurstMs: number;
    netSimBurstChance: number;

    showPhysicsColliders: boolean;
    showGrid: boolean;
    showOrientationCube: boolean;
    showChunkBoundaries: boolean;

    hotbar: HotbarSlot[]; // length === HOTBAR_SIZE

    /** registers the per-player edit store for a ClientRoom into `playerEditStores`, keyed by `room.playerId`. pass `null` on dispose. */
    registerEditRoomStore: (room: ClientRoom, store: EditRoomStoreApi | null) => void;

    setMode: (mode: 'edit' | 'play') => void;
    setRoomMode: (roomMode: 'edit' | 'play') => void;
    setPlayPending: (pending: boolean) => void;
    setRoomId: (roomId: string | null) => void;
    setSceneId: (sceneId: string | null) => void;
    setRoom: (room: ClientRoom | null) => void;
    setJoinedPlayers: (players: JoinedPlayer[]) => void;
    setRoomView: (playerId: PlayerId, view: 'edit' | 'play') => void;
    clearRoomView: (playerId: PlayerId) => void;
    setLens: (playerId: PlayerId, lens: Lens | null) => void;

    setHotbarSlot: (index: number, item: HotbarSlot) => void;

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

// fallback release for the Play spinner if the spawn fails silently (no `play_failed` protocol message).
const PLAY_PENDING_TIMEOUT_MS = 15_000;
let playPendingTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditor = create<EditorStore>((set, _get) => ({
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
    lenses: new Map(),

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

    registerEditRoomStore: (room, store) => {
        set((s) => {
            const next = { ...s.playerEditStores };
            if (store === null) delete next[room.playerId];
            else next[room.playerId] = store;
            return { playerEditStores: next };
        });
    },

    setMode: (mode) => set({ mode }),
    setRoomMode: (roomMode) => {
        // any room activation clears the pending spinner, including switching rooms mid-play-request.
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
        // loadHotbar() runs at module init before the block registry is populated, so the
        // default seeds here instead, on the first activated room; no-op once a hotbar exists.
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
    setLens: (playerId, lens) =>
        set((s) => {
            if ((s.lenses.get(playerId) ?? null) === lens) return {};
            const next = new Map(s.lenses);
            if (lens === null) next.delete(playerId);
            else next.set(playerId, lens);
            return { lenses: next };
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

// only fires when the array reference changes (setHotbarSlot makes a new array).
let lastSavedHotbar = useEditor.getState().hotbar;
useEditor.subscribe((state) => {
    if (state.hotbar !== lastSavedHotbar) {
        lastSavedHotbar = state.hotbar;
        saveHotbar(state.hotbar);
    }
});

function applyClientRooms(rooms: Map<PlayerId, ClientRoom>, activePlayerId: PlayerId | null): void {
    const editor = useEditor.getState();
    const players: JoinedPlayer[] = [];
    for (const room of rooms.values()) players.push({ playerId: room.playerId, roomId: room.roomId, mode: room.playerMode });
    editor.setJoinedPlayers(players);

    // drop per-player editor state for a room the client no longer holds.
    for (const playerId of editor.lenses.keys()) if (!rooms.has(playerId)) editor.setLens(playerId, null);
    for (const playerId of editor.playerToView.keys()) if (!rooms.has(playerId)) editor.clearRoomView(playerId);

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
