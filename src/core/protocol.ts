import { pack } from './scene/pack';

/** room kind, edit rooms have a live scene editor, play rooms are snapshots */
export type RoomMode = 'edit' | 'play';

/**
 * how a Player engages with a room. Distinct from RoomMode (the room's
 * intrinsic character): a play-mode room can host edit-mode Players (a
 * developer tweaking while observing) and vice versa. Shares values with
 * RoomMode today but is free to grow independently (e.g. 'spectator').
 */
export type PlayerMode = 'edit' | 'play';

/** room metadata sent in room_list messages */
export type RoomInfo = {
    id: string;
    sceneId: string;
    roomMode: RoomMode;
    clientCount: number;
    sourceRoomId: string | null;
    /** namespace this room belongs to ('main' / 'editor' / 'play-<uuid>'). */
    namespace: string;
};

/* ── binary trait data for scene sync ── */

/** a single field entry in per-field wire format: stable field index + packcat-encoded data */
export const BinaryField = pack.object({
    /** stable field index (alphabetical among replicable fields) */
    index: pack.varuint(),
    /** packcat-encoded field value */
    data: pack.uint8Array(),
});

export type BinaryField = pack.SchemaType<typeof BinaryField>;

/**
 * a trait's full state packed for transfer. trait ref uses the wire-index
 * channel, `netIndex` (varuint) for resolved traits, `id` (string) as the
 * fallback for unresolved traits (scene file mentions an id with no local
 * def). exactly one is set on the sender; receiver tries netIndex first.
 */
export const BinaryTrait = pack.object({
    netIndex: pack.optional(pack.varuint()),
    id: pack.optional(pack.string()),
    /** per-control binary entries. each entry is (controlIndex, data). */
    fields: pack.list(BinaryField),
    /** per-sync binary entries. each entry is (syncIndex, data). seeds initial replicated state. */
    syncs: pack.list(BinaryField),
});

export type BinaryTrait = pack.SchemaType<typeof BinaryTrait>;

/* ── scene sync update schemas (fully binary via packcat union) ── */

/** a node was created (or is newly visible to a client). full state. */
export const NodeCreatedUpdate = pack.object({
    type: pack.literal('node_created'),
    id: pack.varuint(),
    name: pack.optional(pack.string()),
    parentId: pack.varuint(),
    index: pack.varuint(),
    persist: pack.optional(pack.boolean()),
    owner: pack.optional(pack.varint()),
    traits: pack.list(BinaryTrait),
    /**
     * json-encoded PrefabConfig. only present in edit-mode replication,
     * play mode instantiates children server-side and replicates them as
     * normal nodes, so the client never needs the raw config.
     */
    prefab: pack.optional(pack.string()),
});
export type NodeCreatedUpdate = pack.SchemaType<typeof NodeCreatedUpdate>;

/** node structural change: parent and/or child index changed. */
export const NodeStructureUpdate = pack.object({
    type: pack.literal('node_structure'),
    id: pack.varuint(),
    parentId: pack.varuint(),
    index: pack.varuint(),
});
export type NodeStructureUpdate = pack.SchemaType<typeof NodeStructureUpdate>;

/** node name changed. */
export const NodeNameUpdate = pack.object({
    type: pack.literal('node_name'),
    id: pack.varuint(),
    name: pack.optional(pack.string()),
});
export type NodeNameUpdate = pack.SchemaType<typeof NodeNameUpdate>;

/** node owner changed. */
export const NodeOwnerUpdate = pack.object({
    type: pack.literal('node_owner'),
    id: pack.varuint(),
    owner: pack.optional(pack.varint()),
});
export type NodeOwnerUpdate = pack.SchemaType<typeof NodeOwnerUpdate>;

/**
 * per-field trait update. only changed fields are included. trait ref
 * is the wire-index only, `node_trait_fields` only fires for traits
 * with a live instance, which by definition have a registry entry and a
 * wire-index slot. unresolved traits (no live instance) cannot reach
 * this path.
 */
export const NodeTraitFieldsUpdate = pack.object({
    type: pack.literal('node_trait_fields'),
    id: pack.varuint(),
    traitNetIndex: pack.varuint(),
    /** per-field binary entries. each entry is (fieldIndex, data). */
    fields: pack.list(BinaryField),
});
export type NodeTraitFieldsUpdate = pack.SchemaType<typeof NodeTraitFieldsUpdate>;

/** a trait was added to a node. full state, controls + syncs. */
export const NodeTraitAddedUpdate = pack.object({
    type: pack.literal('node_trait_added'),
    id: pack.varuint(),
    traitNetIndex: pack.optional(pack.varuint()),
    traitId: pack.optional(pack.string()),
    /** per-control binary entries (controlIndex, data). */
    fields: pack.list(BinaryField),
    /** per-sync binary entries (syncIndex, data), seeds initial replicated state. */
    syncs: pack.list(BinaryField),
});
export type NodeTraitAddedUpdate = pack.SchemaType<typeof NodeTraitAddedUpdate>;

/** a trait was removed from a node. */
export const NodeTraitRemovedUpdate = pack.object({
    type: pack.literal('node_trait_removed'),
    id: pack.varuint(),
    traitNetIndex: pack.optional(pack.varuint()),
    traitId: pack.optional(pack.string()),
});
export type NodeTraitRemovedUpdate = pack.SchemaType<typeof NodeTraitRemovedUpdate>;

/** a node was destroyed (or is no longer visible to a client). */
export const NodeDestroyedUpdate = pack.object({
    type: pack.literal('node_destroyed'),
    id: pack.varuint(),
});
export type NodeDestroyedUpdate = pack.SchemaType<typeof NodeDestroyedUpdate>;

/** node prefab config changed (edit mode only). */
export const NodePrefabUpdate = pack.object({
    type: pack.literal('node_prefab'),
    id: pack.varuint(),
    /** json-encoded PrefabConfig. absent = prefab removed. */
    prefab: pack.optional(pack.string()),
});
export type NodePrefabUpdate = pack.SchemaType<typeof NodePrefabUpdate>;

export const SceneSyncUpdateSchema = pack.union('type', [
    NodeCreatedUpdate,
    NodeStructureUpdate,
    NodeNameUpdate,
    NodeOwnerUpdate,
    NodeTraitFieldsUpdate,
    NodeTraitAddedUpdate,
    NodeTraitRemovedUpdate,
    NodeDestroyedUpdate,
    NodePrefabUpdate,
]);

export type SceneSyncUpdate = pack.SchemaType<typeof SceneSyncUpdateSchema>;

/* ── packed scene graph (binary, for network transfer) ── */

/**
 * a single node in a packed scene graph. same shape as NodeCreatedUpdate
 * but without the union discriminant. nodes are stored parent-first so
 * the receiver can reconstruct the tree in one pass.
 */
export const PackedNode = pack.object({
    id: pack.varuint(),
    name: pack.optional(pack.string()),
    parentId: pack.varuint(),
    index: pack.varuint(),
    persist: pack.optional(pack.boolean()),
    owner: pack.optional(pack.varint()),
    traits: pack.list(BinaryTrait),
    /**
     * json-encoded PrefabConfig. only present in edit-mode replication,
     * play mode instantiates children server-side, clients just see normal nodes.
     */
    prefab: pack.optional(pack.string()),
});

export type PackedNode = pack.SchemaType<typeof PackedNode>;

/**
 * full binary scene tree for network transfer (join_room, play snapshot).
 * includes ALL nodes regardless of persist flag. trait field data is
 * packcat-encoded via getControlSerDes.
 *
 * root is the first node in the list with parentId: 0.
 * remaining nodes are flat parent-first.
 */
export const PackedSceneTree = pack.object({
    nodes: pack.list(PackedNode),
});

export type PackedSceneTree = pack.SchemaType<typeof PackedSceneTree>;

const PackedSceneTreeSerDes = pack.build(PackedSceneTree);

export function packPackedSceneTree(data: PackedSceneTree): Uint8Array {
    return PackedSceneTreeSerDes.pack(data);
}

export function unpackPackedSceneTree(data: Uint8Array): PackedSceneTree {
    try {
        return PackedSceneTreeSerDes.unpack(data);
    } catch (e) {
        console.error('[bongle] failed to unpack scene tree:', e);
        throw e;
    }
}

/* ── Client → Server ────────────────────────────────────────────── */

export const Ping = pack.object({
    type: pack.literal('ping'),
});

/** Client → server: echoes the latest `NetPing.serverStamp` seen, so the server can measure
 *  this client's RTT in its own clock (Quake `SV_CalcPings`-style). rides the per-tick packet
 *  — no dedicated ping/pong exchange. 0 = none seen yet. */
export const NetPingAck = pack.object({
    type: pack.literal('net_ping_ack'),
    serverStampAck: pack.uint32(),
});
export type NetPingAck = pack.SchemaType<typeof NetPingAck>;

/** Client tells the server which Player is their active focus. */
export const SetActiveRoom = pack.object({
    type: pack.literal('set_active_room'),
    playerId: pack.varuint(),
});

/** Client requests the latest metrics snapshot for a room. only sent when the debug panel is open. */
export const RequestMetrics = pack.object({
    type: pack.literal('request_metrics'),
    roomId: pack.string(),
});

export type RequestMetrics = pack.SchemaType<typeof RequestMetrics>;

/**
 * Client toggles server-side debug streaming (logs + future debug feeds).
 * when enabled, the server pushes `debug_logs` deltas for every room the
 * client holds a Player in. flat per-client bit, no per-room granularity.
 */
export const DebugSubscribe = pack.object({
    type: pack.literal('debug_subscribe'),
    enabled: pack.boolean(),
});

export type DebugSubscribe = pack.SchemaType<typeof DebugSubscribe>;

/**
 * Client sends sync updates for authority:'owner' fields on owned nodes.
 * Play mode only. each field is packcat-encoded using its per-field serdes.
 */
export const SyncUpdate = pack.object({
    type: pack.literal('sync_update'),
    /** which room this update targets */
    roomId: pack.string(),
    /** runtime node id */
    nodeId: pack.varuint(),
    /**
     * trait wire-index. owner-authority sync only fires for traits with
     * a live instance, unresolved traits cannot reach this path, so no
     * string fallback is needed.
     */
    traitNetIndex: pack.varuint(),
    /** per-field binary entries. only changed owner-authority fields. */
    fields: pack.list(BinaryField),
});

/**
 * User-defined network command between client and server. always scoped to
 * a room, room-less editor lifecycle ops live as first-class messages
 * (open_scene / play / stop_room / leave_room / join_room_as /
 * rename_scene / delete_scene) rather than going through this channel.
 *
 * `commandIndex` is a position into the wire-index table both sides
 * compute locally from `commandsRegistry`, see
 * `ProjectModule.commandWireIndex`. Ordering is sort-by-id; the
 * no-asymmetric-imports convention guarantees both sides see the same id
 * set and therefore the same indices.
 */
export const NetMessage = pack.object({
    type: pack.literal('net_message'),
    direction: pack.enumeration(['to_server', 'to_client'] as const),
    roomId: pack.string(),
    commandIndex: pack.varuint(),
    payload: pack.uint8Array(),
});

export type NetMessage = pack.SchemaType<typeof NetMessage>;

/**
 * Client submits a single chat input line for a room. The server parses it
 * against the room's chat: if a server-side listener consumes it, it stops
 * here; otherwise the server broadcasts a ChatBroadcast to every client in
 * the room. Plain chat messages (no leading '/') follow the same path.
 */
export const ChatInput = pack.object({
    type: pack.literal('chat_input'),
    roomId: pack.string(),
    line: pack.string(),
});

export type ChatInput = pack.SchemaType<typeof ChatInput>;

/* ── editor lifecycle (client → server) ─────────────────────────────
 *
 * Room-CRUD ops that target the server's room registry rather than any
 * single room. First-class messages, no room context on the wire, no
 * Rpc.listen indirection. Dispatched directly from `processInbox`. The
 * `play` message is dual-purpose: editor "Play" button + game-runtime
 * `client.matchmake` (works in non-editor builds too).
 */

export const OpenScene = pack.object({
    type: pack.literal('open_scene'),
    sceneId: pack.string(),
});
export type OpenScene = pack.SchemaType<typeof OpenScene>;

/**
 * Dual-purpose. Editor "Play" button passes `sceneId` + `sourceRoomId`
 * and mints a fresh `play-<uuid>` namespace. Game runtime
 * `client.matchmake` passes `gameOptions` + `joinData` and
 * find-or-creates a room keyed on `canonicalJson(gameOptions)`.
 * `sceneId`/`sourceRoomId` are optional so the game-runtime caller can
 * omit them (falls back to default scene).
 */
export const Play = pack.object({
    type: pack.literal('play'),
    sceneId: pack.optional(pack.string()),
    sourceRoomId: pack.optional(pack.string()),
    /** JSON-encoded Record<string, string|number|boolean>. */
    gameOptions: pack.optional(pack.string()),
    /** JSON-encoded Record<string, JsonValue>. */
    joinData: pack.optional(pack.string()),
});
export type Play = pack.SchemaType<typeof Play>;

export const StopRoom = pack.object({
    type: pack.literal('stop_room'),
    roomId: pack.string(),
});
export type StopRoom = pack.SchemaType<typeof StopRoom>;

export const LeaveRoom = pack.object({
    type: pack.literal('leave_room'),
    roomId: pack.string(),
    mode: pack.enumeration(['edit', 'play'] as const),
});
export type LeaveRoom = pack.SchemaType<typeof LeaveRoom>;

/**
 * Join an existing room in a specific mode. Used by the tab UI's
 * right-click "Join in edit / Join in play mode" actions to add a
 * (client, room, mode) membership without creating a new room.
 */
export const JoinRoomAs = pack.object({
    type: pack.literal('join_room_as'),
    roomId: pack.string(),
    mode: pack.enumeration(['edit', 'play'] as const),
});
export type JoinRoomAs = pack.SchemaType<typeof JoinRoomAs>;

export const RenameScene = pack.object({
    type: pack.literal('rename_scene'),
    oldSceneId: pack.string(),
    newSceneId: pack.string(),
});
export type RenameScene = pack.SchemaType<typeof RenameScene>;

export const DeleteScene = pack.object({
    type: pack.literal('delete_scene'),
    sceneId: pack.string(),
});
export type DeleteScene = pack.SchemaType<typeof DeleteScene>;

export const SaveScene = pack.object({
    type: pack.literal('save_scene'),
    sceneId: pack.string(),
});
export type SaveScene = pack.SchemaType<typeof SaveScene>;

/**
 * Sent by either peer after an HMR flush that may have changed its
 * outbound wire-index tables. Carries the full sorted id lists for traits
 * and commands; the receiver rebuilds its INBOUND wire-index tables from
 * them and adopts them for every subsequent decode.
 *
 * Ordered in-band with regular traffic: WS preserves message order, so
 * messages before the table refresh decode against the old inbound table
 * and messages after decode against the new one. No connection-time
 * handshake, no per-message version stamp, the message itself is the
 * boundary.
 */
export const WireTable = pack.object({
    type: pack.literal('wire_table'),
    /** trait ids in sort-by-id order (same order the sender encodes against). */
    traits: pack.list(pack.string()),
    /** command ids in sort-by-id order. */
    commands: pack.list(pack.string()),
});

export type WireTable = pack.SchemaType<typeof WireTable>;

/**
 * Server announces a runtime-source model entry to a client. Carries only
 * the client-facing fetch URL, the server keeps its own URL locally and
 * never needs the receiver to learn it. Refcount lives server-side; the
 * client treats each register as a one-shot setModel and pairs it with a
 * single unregister_model on release.
 *
 * Ordering: emitted before any scene_sync / join_room that references the
 * modelId, so the client's `ensureModel` finds a URL entry when the trait
 * field carrying the modelId lands.
 */
export const RegisterModel = pack.object({
    type: pack.literal('register_model'),
    /** user-chosen model id (e.g. `avatar:<uuid>`). */
    id: pack.string(),
    /** client-side fetch URL for the payload bytes. */
    clientUrl: pack.string(),
    /** content hash for cache busting; optional, informational. */
    hash: pack.optional(pack.string()),
    /** payload size in bytes; optional, informational. */
    size: pack.optional(pack.varuint()),
});

export type RegisterModel = pack.SchemaType<typeof RegisterModel>;

/**
 * Server tells a client the runtime-source model entry is no longer needed.
 * Client drops the URL entry + releases any loaded payload. Pairs 1:1 with
 * a prior `register_model` for the same id.
 */
export const UnregisterModel = pack.object({
    type: pack.literal('unregister_model'),
    id: pack.string(),
});

export type UnregisterModel = pack.SchemaType<typeof UnregisterModel>;

/**
 * Server broadcasts a chat line to every client in a room. Emitted either
 * from a plain chat message (no slash-command consumer) or from a script
 * that called `chat.message(ctx, text)` on the server side. Clients append
 * the line to their per-room Chat and fan out to message listeners.
 */
export const ChatBroadcast = pack.object({
    type: pack.literal('chat_broadcast'),
    roomId: pack.string(),
    from: pack.string(),
    text: pack.string(),
    kind: pack.enumeration(['message', 'system', 'error', 'input'] as const),
});

export type ChatBroadcast = pack.SchemaType<typeof ChatBroadcast>;

/**
 * Client acknowledges chunks it has decoded + applied this frame, freeing the
 * server's per-player in-flight slots (voxel backpressure). Keyed by playerId
 * because one client can hold multiple players, each with its own in-flight
 * window. Pure pacing, TCP guarantees delivery; the ack throttles the server
 * to the client's decode rate. Only the full channel is slot-tracked today.
 */
export const VoxelAck = pack.object({
    type: pack.literal('voxel_ack'),
    playerId: pack.varuint(),
    /** chunk coords decoded + applied since the last ack. */
    full: pack.list(
        pack.object({
            cx: pack.int32(),
            cy: pack.int32(),
            cz: pack.int32(),
        }),
    ),
});

export type VoxelAck = pack.SchemaType<typeof VoxelAck>;

export const ClientMessage = pack.union('type', [
    Ping,
    NetPingAck,
    SetActiveRoom,
    RequestMetrics,
    DebugSubscribe,
    SyncUpdate,
    NetMessage,
    WireTable,
    OpenScene,
    Play,
    StopRoom,
    LeaveRoom,
    JoinRoomAs,
    RenameScene,
    DeleteScene,
    SaveScene,
    ChatInput,
    VoxelAck,
]);

export type ClientMessage = pack.SchemaType<typeof ClientMessage>;

const ClientMessageSerDes = pack.build(ClientMessage);

/**
 * pack a single ClientMessage to its on-wire bytes. used by Net.send to
 * pre-encode messages at queue time so per-message size + category are
 * known without re-encoding at flush.
 */
export function packClientMessage(message: ClientMessage): Uint8Array {
    return ClientMessageSerDes.pack(message);
}

export function unpackClientMessage(data: Uint8Array): ClientMessage | null {
    try {
        return ClientMessageSerDes.unpack(data);
    } catch (e) {
        console.error('[bongle] failed to unpack client message:', e);
        return null;
    }
}


/* ── Server → Client ────────────────────────────────────────────── */

export const Pong = pack.object({
    type: pack.literal('pong'),
});

/** Server → client clock-sync push. The server stamps a room's authoritative
 *  `server` clock and batches this into the per-tick packet it already sends, so
 *  every arrival is a fresh sample the client slews its own `server` onto (one-way
 *  latency behind, see core/clock ClockSync). Per-room: a server hosts many rooms,
 *  each with its own clock, so the sample carries the `roomId` it belongs to. */
export const ServerClock = pack.object({
    type: pack.literal('server_clock'),
    /** the room this `server` clock value belongs to. */
    roomId: pack.string(),
    /** the room's authoritative `server` clock (seconds) at send. */
    serverClock: pack.float64(),
});

export type ServerClock = pack.SchemaType<typeof ServerClock>;

/** Server → client: `serverStamp` (server monotonic ms at send) for the client to echo back
 *  via `NetPingAck`; `pingMs` is the server's smoothed RTT measurement, sent down for the
 *  client's net HUD. rides the per-tick packet. both 0 until known. */
export const NetPing = pack.object({
    type: pack.literal('net_ping'),
    serverStamp: pack.uint32(),
    pingMs: pack.uint16(),
});
export type NetPing = pack.SchemaType<typeof NetPing>;

/**
 * Server instructs client to join a room. Sent on initial join, scene
 * switch, play start, and play stop. The client tears down current state
 * and rebuilds from the provided scene graph payload.
 */
export const JoinRoom = pack.object({
    type: pack.literal('join_room'),
    /** Server-allocated Player id for this (client, room, mode). The client
     *  keys its ClientRoom map by this id. */
    playerId: pack.varuint(),
    /** The Player's mode in the room. */
    playerMode: pack.enumeration(['edit', 'play'] as const),
    /** The room's native mode. May differ from the Player's mode (e.g. an
     *  edit Player attached to a play room). */
    roomMode: pack.enumeration(['edit', 'play'] as const),
    /** Runtime room ID. */
    roomId: pack.string(),
    /** Scene file path (e.g. "scenes/main.scene.json"). */
    sceneId: pack.string(),
    /** packcat-encoded PackedNodes. */
    packedNodes: pack.uint8Array(),
    /** our client id for this room */
    clientId: pack.varuint(),
    /** Namespace this room belongs to (e.g. 'editor', 'main', 'play-<uuid>'). */
    namespace: pack.string(),
    /** The server room clock (seconds) at send time. The client seeds its own
     *  clock from this so the two sides share a time base (modulo join latency).
     *  See `Clock.init`. */
    serverClockTime: pack.float64(),
});

export type JoinRoom = pack.SchemaType<typeof JoinRoom>;

/**
 * Server instructs the client to activate a Player it already observes.
 * Always emitted after the corresponding JoinRoom over the same per-client
 * outbox to preserve ordering.
 */
export const ActivateRoom = pack.object({
    type: pack.literal('activate_room'),
    playerId: pack.varuint(),
});

export type ActivateRoom = pack.SchemaType<typeof ActivateRoom>;

/**
 * Server sends the list of active rooms.
 * Sent on client join and whenever rooms change (created, destroyed, client joins/leaves).
 * rooms is a JSON-encoded RoomInfo[].
 */
export const RoomList = pack.object({
    type: pack.literal('room_list'),
    /** JSON-encoded RoomInfo[] */
    rooms: pack.string(),
});

export type RoomList = pack.SchemaType<typeof RoomList>;

/**
 * Server sends incremental scene updates to a client.
 * Each update describes a change to a single node (created, destroyed,
 * structural change, trait change, etc.). fully binary via packcat.
 */
export const SceneSync = pack.object({
    type: pack.literal('scene_sync'),
    /**
     * which Player these updates target. The client routes the message to
     * the matching ClientRoom by playerId, content is mode-aware (an
     * edit-Player and a play-Player in the same room receive different
     * snapshot subsets), so per-Player addressing is required.
     */
    playerId: pack.varuint(),
    /** packcat-encoded list of SceneSyncUpdate */
    updates: pack.list(SceneSyncUpdateSchema),
});

export type SceneSync = pack.SchemaType<typeof SceneSync>;

/**
 * Server tells a client a Player has been removed.
 * The client drops the corresponding ClientRoom.
 */
export const RoomLeft = pack.object({
    type: pack.literal('room_left'),
    playerId: pack.varuint(),
});

export type RoomLeft = pack.SchemaType<typeof RoomLeft>;

/** server sends a full chunk to a client (initial load or resync). */
export const VoxelChunkFull = pack.object({
    type: pack.literal('voxel_chunk_full'),
    /** Player this chunk targets, keyed per-Player for isolation. */
    playerId: pack.varuint(),
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
    paletteKeys: pack.list(pack.string()),
    /** fflate-compressed RLE of interleaved data+light (uint16) */
    compressed: pack.uint8Array(),
});

export type VoxelChunkFull = pack.SchemaType<typeof VoxelChunkFull>;

/** server sends incremental block state changes (no light). */
export const VoxelChunkOps = pack.object({
    type: pack.literal('voxel_chunk_ops'),
    /** Player this update targets. */
    playerId: pack.varuint(),
    chunks: pack.list(
        pack.object({
            cx: pack.int32(),
            cy: pack.int32(),
            cz: pack.int32(),
            /** full palette keys (may have grown since last send) */
            paletteKeys: pack.list(pack.string()),
            changes: pack.list(
                pack.object({
                    /** flat voxel index (0..4095) */
                    index: pack.uint16(),
                    /** new local palette index */
                    data: pack.uint16(),
                }),
            ),
        }),
    ),
});

export type VoxelChunkOps = pack.SchemaType<typeof VoxelChunkOps>;

/** server sends full light arrays for dirty chunks (no block data). */
export const VoxelChunkLight = pack.object({
    type: pack.literal('voxel_chunk_light'),
    /** Player these light updates target. */
    playerId: pack.varuint(),
    /** one chunk per message, the transport coalesces a tick's messages into
     *  one frame, so per-chunk costs only a few bytes of framing while keeping
     *  the dispatch/in-flight unit uniform with voxel_chunk_full. */
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
    /** RLE'd sky channel (4 bits per voxel). */
    sky: pack.uint8Array(),
    /** RLE'd rgb channel (12 bits per voxel). */
    rgb: pack.uint8Array(),
});

export type VoxelChunkLight = pack.SchemaType<typeof VoxelChunkLight>;

/**
 * server sends per-voxel light changes for chunks with bounded dirty count.
 * mirrors voxel_chunk_ops, but for light. used when lightDirtyCount is below
 * the whole-chunk fallback threshold, otherwise voxel_chunk_light is sent.
 */
export const VoxelChunkLightDelta = pack.object({
    type: pack.literal('voxel_chunk_light_delta'),
    /** Player these light updates target. */
    playerId: pack.varuint(),
    /** one chunk per message (see VoxelChunkLight). */
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
    changes: pack.list(
        pack.object({
            /** flat voxel index (0..4095) */
            index: pack.uint16(),
            /** packed light value (sky + rgb) */
            light: pack.uint16(),
        }),
    ),
});

export type VoxelChunkLightDelta = pack.SchemaType<typeof VoxelChunkLightDelta>;

/** server tells client to remove a chunk. */
export const VoxelChunkDel = pack.object({
    type: pack.literal('voxel_chunk_del'),
    /** Player whose voxel view this removal applies to. */
    playerId: pack.varuint(),
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
});

export type VoxelChunkDel = pack.SchemaType<typeof VoxelChunkDel>;

/**
 * server tells the client which chunks within its discovery range are
 * empty (all air, no data). lets the client distinguish "known empty" from
 * "haven't heard about it yet", collision treats the latter as solid.
 *
 * batched: many coords per packet, since each entry is just 12 bytes.
 */
export const VoxelChunkEmpty = pack.object({
    type: pack.literal('voxel_chunk_empty'),
    /** Player whose voxel view this applies to. */
    playerId: pack.varuint(),
    chunks: pack.list(
        pack.object({
            cx: pack.int32(),
            cy: pack.int32(),
            cz: pack.int32(),
        }),
    ),
});

export type VoxelChunkEmpty = pack.SchemaType<typeof VoxelChunkEmpty>;

/** server sends latest metrics snapshot for a room, in response to request_metrics. */
export const RoomMetrics = pack.object({
    type: pack.literal('room_metrics'),
    roomId: pack.string(),
    /** flat record of metric id → latest value */
    values: pack.record(pack.float32()),
});

export type RoomMetrics = pack.SchemaType<typeof RoomMetrics>;

/**
 * source attribution for a single log entry. mirrors core/debug.LogSource.
 * absent for engine-internal logs captured without a script context.
 */
export const DebugLogSource = pack.object({
    traitId: pack.string(),
    nodeId: pack.varuint(),
    nodeName: pack.optional(pack.string()),
    mode: pack.enumeration(['edit', 'play'] as const),
    side: pack.enumeration(['client', 'server'] as const),
});

export type DebugLogSource = pack.SchemaType<typeof DebugLogSource>;

export const DebugLogEntry = pack.object({
    /** unix-ms timestamp; float64 because Date.now() exceeds varuint range comfortably. */
    ts: pack.float64(),
    level: pack.enumeration(['log', 'warn', 'error'] as const),
    msg: pack.string(),
    source: pack.optional(DebugLogSource),
});

export type DebugLogEntry = pack.SchemaType<typeof DebugLogEntry>;

/**
 * server pushes a delta of room logs since the last cursor. only sent for
 * rooms the client has subscribed to (via `debug_subscribe`) and only when
 * the delta is non-empty.
 */
export const DebugLogs = pack.object({
    type: pack.literal('debug_logs'),
    roomId: pack.string(),
    entries: pack.list(DebugLogEntry),
    /** number of entries that fell off the ring buffer between cursors. */
    dropped: pack.varuint(),
});

export type DebugLogs = pack.SchemaType<typeof DebugLogs>;

/**
 * message types whose bytes are billed to the "debug" bucket. used to keep
 * the headline ingress/egress numbers honest, opening the debug panel
 * itself shouldn't inflate the metric it shows. anything not in this set
 * is treated as "game" traffic.
 */
export const DEBUG_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>([
    // client → server
    'request_metrics',
    'debug_subscribe',
    // server → client
    'room_metrics',
    'debug_logs',
]);

export const ServerMessage = pack.union('type', [
    Pong,
    ServerClock,
    NetPing,
    JoinRoom,
    ActivateRoom,
    RoomList,
    SceneSync,
    RoomLeft,
    VoxelChunkFull,
    VoxelChunkOps,
    VoxelChunkLight,
    VoxelChunkLightDelta,
    VoxelChunkDel,
    VoxelChunkEmpty,
    RoomMetrics,
    DebugLogs,
    NetMessage,
    WireTable,
    RegisterModel,
    UnregisterModel,
    ChatBroadcast,
]);

export type ServerMessage = pack.SchemaType<typeof ServerMessage>;

const ServerMessageSerDes = pack.build(ServerMessage);

export function packServerMessage(message: ServerMessage): Uint8Array {
    return ServerMessageSerDes.pack(message);
}

export function unpackServerMessage(data: Uint8Array): ServerMessage | null {
    try {
        return ServerMessageSerDes.unpack(data);
    } catch (e) {
        console.error('[bongle] failed to unpack server message:', e);
        return null;
    }
}
