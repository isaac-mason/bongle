import { pack } from './scene/pack';
import { REGION_VOLUME } from './voxels/voxels';

/** room kind, edit rooms have a live scene editor, play rooms are snapshots */
export type RoomMode = 'edit' | 'play';

/** how a Player engages with a room, distinct from RoomMode: a play-mode room can host edit-mode Players and vice versa. */
export type PlayerMode = 'edit' | 'play';

export type RoomInfo = {
    id: string;
    sceneId: string;
    roomMode: RoomMode;
    clientCount: number;
    sourceRoomId: string | null;
    namespace: string;
};

/** a single field entry in per-field wire format: stable field index + packcat-encoded data */
export const BinaryField = pack.object({
    index: pack.varuint(),
    data: pack.uint8Array(),
});

export type BinaryField = pack.SchemaType<typeof BinaryField>;

/** a trait's full state packed for transfer; exactly one of netIndex/id is set on the sender, receiver tries netIndex first. */
export const BinaryTrait = pack.object({
    netIndex: pack.optional(pack.varuint()),
    id: pack.optional(pack.string()),
    fields: pack.list(BinaryField),
    syncs: pack.list(BinaryField),
});

export type BinaryTrait = pack.SchemaType<typeof BinaryTrait>;

export const NodeCreatedUpdate = pack.object({
    type: pack.literal('node_created'),
    id: pack.varuint(),
    name: pack.optional(pack.string()),
    parentId: pack.varuint(),
    index: pack.varuint(),
    persist: pack.optional(pack.boolean()),
    owner: pack.optional(pack.varint()),
    traits: pack.list(BinaryTrait),
    /** json-encoded PrefabConfig, only present in edit-mode replication. */
    prefab: pack.optional(pack.string()),
});
export type NodeCreatedUpdate = pack.SchemaType<typeof NodeCreatedUpdate>;

export const NodeStructureUpdate = pack.object({
    type: pack.literal('node_structure'),
    id: pack.varuint(),
    parentId: pack.varuint(),
    index: pack.varuint(),
});
export type NodeStructureUpdate = pack.SchemaType<typeof NodeStructureUpdate>;

export const NodeNameUpdate = pack.object({
    type: pack.literal('node_name'),
    id: pack.varuint(),
    name: pack.optional(pack.string()),
});
export type NodeNameUpdate = pack.SchemaType<typeof NodeNameUpdate>;

export const NodeOwnerUpdate = pack.object({
    type: pack.literal('node_owner'),
    id: pack.varuint(),
    owner: pack.optional(pack.varint()),
});
export type NodeOwnerUpdate = pack.SchemaType<typeof NodeOwnerUpdate>;

/** per-field trait update, only changed fields; trait ref is wire-index only since this only fires for traits with a live instance. */
export const NodeTraitFieldsUpdate = pack.object({
    type: pack.literal('node_trait_fields'),
    id: pack.varuint(),
    traitNetIndex: pack.varuint(),
    fields: pack.list(BinaryField),
});
export type NodeTraitFieldsUpdate = pack.SchemaType<typeof NodeTraitFieldsUpdate>;

export const NodeTraitAddedUpdate = pack.object({
    type: pack.literal('node_trait_added'),
    id: pack.varuint(),
    traitNetIndex: pack.optional(pack.varuint()),
    traitId: pack.optional(pack.string()),
    fields: pack.list(BinaryField),
    syncs: pack.list(BinaryField),
});
export type NodeTraitAddedUpdate = pack.SchemaType<typeof NodeTraitAddedUpdate>;

export const NodeTraitRemovedUpdate = pack.object({
    type: pack.literal('node_trait_removed'),
    id: pack.varuint(),
    traitNetIndex: pack.optional(pack.varuint()),
    traitId: pack.optional(pack.string()),
});
export type NodeTraitRemovedUpdate = pack.SchemaType<typeof NodeTraitRemovedUpdate>;

export const NodeDestroyedUpdate = pack.object({
    type: pack.literal('node_destroyed'),
    id: pack.varuint(),
});
export type NodeDestroyedUpdate = pack.SchemaType<typeof NodeDestroyedUpdate>;

export const NodePrefabUpdate = pack.object({
    type: pack.literal('node_prefab'),
    id: pack.varuint(),
    /** json-encoded PrefabConfig; absent = prefab removed. */
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

/** a single node in a packed scene graph, same shape as NodeCreatedUpdate minus the union discriminant; stored parent-first. */
export const PackedNode = pack.object({
    id: pack.varuint(),
    name: pack.optional(pack.string()),
    parentId: pack.varuint(),
    index: pack.varuint(),
    persist: pack.optional(pack.boolean()),
    owner: pack.optional(pack.varint()),
    traits: pack.list(BinaryTrait),
    /** json-encoded PrefabConfig, only present in edit-mode replication. */
    prefab: pack.optional(pack.string()),
});

export type PackedNode = pack.SchemaType<typeof PackedNode>;

/** full binary scene tree for network transfer, all nodes regardless of persist flag; root is the first node, parentId: 0. */
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

export const Ping = pack.object({
    type: pack.literal('ping'),
});

/** echoes the latest `NetPing.serverStamp` seen so the server can measure this client's RTT in its own clock; 0 = none seen yet. */
export const NetPingAck = pack.object({
    type: pack.literal('net_ping_ack'),
    serverStampAck: pack.uint32(),
});
export type NetPingAck = pack.SchemaType<typeof NetPingAck>;

export const SetActiveRoom = pack.object({
    type: pack.literal('set_active_room'),
    playerId: pack.varuint(),
});

/** client toggles server-side frame profiling; when enabled, pushes `room_frames` for every room the client holds a Player in. */
export const MetricsSubscribe = pack.object({
    type: pack.literal('metrics_subscribe'),
    enabled: pack.boolean(),
});

export type MetricsSubscribe = pack.SchemaType<typeof MetricsSubscribe>;

export const DebugSubscribe = pack.object({
    type: pack.literal('debug_subscribe'),
    enabled: pack.boolean(),
});

export type DebugSubscribe = pack.SchemaType<typeof DebugSubscribe>;

/** client sends sync updates for authority:'owner' fields on owned nodes, play mode only. */
export const SyncUpdate = pack.object({
    type: pack.literal('sync_update'),
    roomId: pack.string(),
    nodeId: pack.varuint(),
    traitNetIndex: pack.varuint(),
    fields: pack.list(BinaryField),
});

/** user-defined network command between client and server, always scoped to a room; `commandIndex` is sort-by-id. */
export const NetMessage = pack.object({
    type: pack.literal('net_message'),
    direction: pack.enumeration(['to_server', 'to_client'] as const),
    roomId: pack.string(),
    commandIndex: pack.varuint(),
    payload: pack.uint8Array(),
});

export type NetMessage = pack.SchemaType<typeof NetMessage>;

/** client submits a single chat input line for a room; a server-side listener that consumes it stops it, otherwise it broadcasts. */
export const ChatInput = pack.object({
    type: pack.literal('chat_input'),
    roomId: pack.string(),
    line: pack.string(),
});

export type ChatInput = pack.SchemaType<typeof ChatInput>;

// room-CRUD ops targeting the server's room registry, no room context on the wire, dispatched directly from `processInbox`.

/** dual-purpose: editor Play passes `sceneId`+`sourceRoomId` and mints a fresh namespace; matchmake passes `options`+`joinData`. */
export const Play = pack.object({
    type: pack.literal('play'),
    sceneId: pack.optional(pack.string()),
    sourceRoomId: pack.optional(pack.string()),
    /** JSON-encoded Record<string, string|number|boolean>. */
    options: pack.optional(pack.string()),
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

export const JoinRoomAs = pack.object({
    type: pack.literal('join_room_as'),
    roomId: pack.string(),
    mode: pack.enumeration(['edit', 'play'] as const),
});
export type JoinRoomAs = pack.SchemaType<typeof JoinRoomAs>;

/** sent by either peer after an HMR flush that may have changed its outbound wire-index tables, ordered in-band with regular traffic. */
export const WireTable = pack.object({
    type: pack.literal('wire_table'),
    /** trait ids in sort-by-id order (same order the sender encodes against). */
    traits: pack.list(pack.string()),
    commands: pack.list(pack.string()),
    /** per-trait sync ids in the sender's own slot order, parallel to `traits`; lets the receiver remap by id. */
    syncs: pack.list(pack.list(pack.string())),
    controls: pack.list(pack.list(pack.string())),
});

export type WireTable = pack.SchemaType<typeof WireTable>;

/** server announces a runtime-source model entry to a client, before any scene_sync/join_room referencing the modelId. */
export const RegisterModel = pack.object({
    type: pack.literal('register_model'),
    id: pack.string(),
    clientUrl: pack.string(),
    hash: pack.optional(pack.string()),
    size: pack.optional(pack.varuint()),
});

export type RegisterModel = pack.SchemaType<typeof RegisterModel>;

export const UnregisterModel = pack.object({
    type: pack.literal('unregister_model'),
    id: pack.string(),
});

export type UnregisterModel = pack.SchemaType<typeof UnregisterModel>;

export const ChatBroadcast = pack.object({
    type: pack.literal('chat_broadcast'),
    roomId: pack.string(),
    from: pack.string(),
    text: pack.string(),
    kind: pack.enumeration(['message', 'system', 'error', 'input'] as const),
});

export type ChatBroadcast = pack.SchemaType<typeof ChatBroadcast>;

/** client acknowledges chunks/regions decoded and applied this frame, freeing the server's per-player in-flight slots. */
export const VoxelAck = pack.object({
    type: pack.literal('voxel_ack'),
    playerId: pack.varuint(),
    /** promotion channel only: an already-known chunk re-sent as voxel_chunk_full. */
    full: pack.list(
        pack.object({
            cx: pack.int32(),
            cy: pack.int32(),
            cz: pack.int32(),
        }),
    ),
    /** discovery channel: regions decoded as voxel_region_full since the last ack. */
    regions: pack.list(
        pack.object({
            rx: pack.int32(),
            ry: pack.int32(),
            rz: pack.int32(),
        }),
    ),
    /** smoothed estimate of decodable voxel_region_full regions per SECOND; server clamps
     *  defensively and converts to its own per-tick budget. Per-second because the client
     *  budgets against its render frame and the server spends against its tick, and the
     *  two rates are independent. */
    desiredRegionsPerSecond: pack.float32(),
});

export type VoxelAck = pack.SchemaType<typeof VoxelAck>;

export const ClientMessage = pack.union('type', [
    Ping,
    NetPingAck,
    SetActiveRoom,
    MetricsSubscribe,
    DebugSubscribe,
    SyncUpdate,
    NetMessage,
    WireTable,
    Play,
    StopRoom,
    LeaveRoom,
    JoinRoomAs,
    ChatInput,
    VoxelAck,
]);

export type ClientMessage = pack.SchemaType<typeof ClientMessage>;

const ClientMessageSerDes = pack.build(ClientMessage);

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

export const Pong = pack.object({
    type: pack.literal('pong'),
});

/** server clock-sync push, batched into the per-tick packet; each arrival is a fresh sample the client slews its clock onto. */
export const ServerClock = pack.object({
    type: pack.literal('server_clock'),
    roomId: pack.string(),
    /** the room's authoritative `server` clock, in seconds. */
    serverClock: pack.float64(),
});

export type ServerClock = pack.SchemaType<typeof ServerClock>;

/** `serverStamp` for the client to echo back via `NetPingAck`; `pingMs` is the server's smoothed RTT for the client's net HUD. */
export const NetPing = pack.object({
    type: pack.literal('net_ping'),
    serverStamp: pack.uint32(),
    pingMs: pack.uint16(),
});
export type NetPing = pack.SchemaType<typeof NetPing>;

/** server instructs client to join a room, on initial join, scene switch, play start, and play stop. */
export const JoinRoom = pack.object({
    type: pack.literal('join_room'),
    playerId: pack.varuint(),
    playerMode: pack.enumeration(['edit', 'play'] as const),
    /** the room's native mode, may differ from the Player's mode. */
    roomMode: pack.enumeration(['edit', 'play'] as const),
    roomId: pack.string(),
    sceneId: pack.string(),
    /** packcat-encoded PackedNodes. */
    packedNodes: pack.uint8Array(),
    clientId: pack.varuint(),
    namespace: pack.string(),
    /** the server room clock in seconds at send time; the client seeds its own clock from this. */
    serverClockTime: pack.float64(),
});

export type JoinRoom = pack.SchemaType<typeof JoinRoom>;

/** server instructs the client to activate a Player it already observes, always after the corresponding JoinRoom. */
export const ActivateRoom = pack.object({
    type: pack.literal('activate_room'),
    playerId: pack.varuint(),
});

export type ActivateRoom = pack.SchemaType<typeof ActivateRoom>;

export const RoomList = pack.object({
    type: pack.literal('room_list'),
    /** JSON-encoded RoomInfo[] */
    rooms: pack.string(),
});

export type RoomList = pack.SchemaType<typeof RoomList>;

export const SceneSync = pack.object({
    type: pack.literal('scene_sync'),
    /** an edit-Player and a play-Player in the same room receive different snapshot subsets, so this is per-Player. */
    playerId: pack.varuint(),
    updates: pack.list(SceneSyncUpdateSchema),
});

export type SceneSync = pack.SchemaType<typeof SceneSync>;

export const RoomLeft = pack.object({
    type: pack.literal('room_left'),
    playerId: pack.varuint(),
});

export type RoomLeft = pack.SchemaType<typeof RoomLeft>;

/** one occupied chunk's payload, shared shape between VoxelChunkFull and VoxelRegionFull's dense chunk list. */
const VoxelChunkPayload = pack.object({
    /** per-slot global state ids; `compressed` stores local slot indices into this list, so a fence variant is one varuint. */
    palette: pack.list(pack.varuint()),
    /** fflate-compressed RLE of interleaved data+light (uint16) */
    compressed: pack.uint8Array(),
});

/** server re-sends one already-known chunk in full, the promotion channel only; a newly-discovered region ships via VoxelRegionFull. */
export const VoxelChunkFull = pack.object({
    type: pack.literal('voxel_chunk_full'),
    playerId: pack.varuint(),
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
    ...VoxelChunkPayload.fields,
});

export type VoxelChunkFull = pack.SchemaType<typeof VoxelChunkFull>;

/** server bundles a newly-discovered region into one message: a presence bitmask plus a dense list of only the occupied payloads. */
export const VoxelRegionFull = pack.object({
    type: pack.literal('voxel_region_full'),
    playerId: pack.varuint(),
    rx: pack.int32(),
    ry: pack.int32(),
    rz: pack.int32(),
    occupied: pack.tuple(Array.from({ length: REGION_VOLUME }, () => pack.boolean())),
    chunks: pack.list(VoxelChunkPayload),
});

export type VoxelRegionFull = pack.SchemaType<typeof VoxelRegionFull>;

export const VoxelChunkOps = pack.object({
    type: pack.literal('voxel_chunk_ops'),
    playerId: pack.varuint(),
    chunks: pack.list(
        pack.object({
            cx: pack.int32(),
            cy: pack.int32(),
            cz: pack.int32(),
            /** references the shared registry's global state id directly (no palette), so a diverged client re-interns cleanly. */
            changes: pack.list(
                pack.object({
                    /** flat voxel index (0..4095) */
                    index: pack.uint16(),
                    stateId: pack.varuint(),
                }),
            ),
        }),
    ),
});

export type VoxelChunkOps = pack.SchemaType<typeof VoxelChunkOps>;

export const VoxelChunkLight = pack.object({
    type: pack.literal('voxel_chunk_light'),
    playerId: pack.varuint(),
    cx: pack.int32(),
    cy: pack.int32(),
    cz: pack.int32(),
    /** RLE'd sky channel (4 bits per voxel). */
    sky: pack.uint8Array(),
    /** RLE'd rgb channel (12 bits per voxel). */
    rgb: pack.uint8Array(),
});

export type VoxelChunkLight = pack.SchemaType<typeof VoxelChunkLight>;

/** server sends per-voxel light changes for chunks with bounded dirty count; above the fallback threshold voxel_chunk_light is sent instead. */
export const VoxelChunkLightDelta = pack.object({
    type: pack.literal('voxel_chunk_light_delta'),
    playerId: pack.varuint(),
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

/** server tells the client to remove an entire region's worth of chunks, the eviction counterpart to VoxelRegionFull. */
export const VoxelRegionDel = pack.object({
    type: pack.literal('voxel_region_del'),
    playerId: pack.varuint(),
    rx: pack.int32(),
    ry: pack.int32(),
    rz: pack.int32(),
});

export type VoxelRegionDel = pack.SchemaType<typeof VoxelRegionDel>;

/** server pushes one profiled tick for a room to subscribers, on its own throttle: the worst frame since the last push. */
export const RoomFrames = pack.object({
    type: pack.literal('room_frames'),
    roomId: pack.string(),
    /** newly interned key names, in id order, appended to what the client holds. */
    keys: pack.list(pack.string()),
    /** display unit per new key ('' when unset), parallel to `keys`. */
    units: pack.list(pack.string()),
    /** wall duration of the whole server tick (ms). */
    duration: pack.float32(),
    /** span columns: interned key id, nesting depth, start/end in ms from tick start; flattened preorder, so a subtree is the run of greater-depth entries. */
    spanKey: pack.uint16Array(),
    spanDepth: pack.uint8Array(),
    spanStart: pack.float32Array(),
    spanEnd: pack.float32Array(),
    /** scalars recorded during the tick: interned key id to value. */
    counterKey: pack.uint16Array(),
    counterValue: pack.float32Array(),
});

export type RoomFrames = pack.SchemaType<typeof RoomFrames>;

/** source attribution for a single log entry; absent for engine-internal logs captured without a script context. */
export const DebugLogSource = pack.object({
    traitId: pack.string(),
    nodeId: pack.varuint(),
    nodeName: pack.optional(pack.string()),
    mode: pack.enumeration(['edit', 'play'] as const),
    side: pack.enumeration(['client', 'server'] as const),
});

export type DebugLogSource = pack.SchemaType<typeof DebugLogSource>;

export const DebugLogEntry = pack.object({
    /** unix-ms timestamp; float64 because Date.now() exceeds varuint range. */
    ts: pack.float64(),
    level: pack.enumeration(['log', 'warn', 'error'] as const),
    msg: pack.string(),
    source: pack.optional(DebugLogSource),
});

export type DebugLogEntry = pack.SchemaType<typeof DebugLogEntry>;

/** server pushes a delta of room logs since the last cursor, only for subscribed rooms and only when non-empty. */
export const DebugLogs = pack.object({
    type: pack.literal('debug_logs'),
    roomId: pack.string(),
    entries: pack.list(DebugLogEntry),
    /** number of entries that fell off the ring buffer between cursors. */
    dropped: pack.varuint(),
});

export type DebugLogs = pack.SchemaType<typeof DebugLogs>;

/** message types billed to the "debug" bucket, so opening the debug panel doesn't inflate the metric it shows. */
export const DEBUG_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>([
    // client to server
    'metrics_subscribe',
    'debug_subscribe',
    // server to client
    'room_frames',
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
    VoxelRegionFull,
    VoxelChunkOps,
    VoxelChunkLight,
    VoxelChunkLightDelta,
    VoxelRegionDel,
    RoomFrames,
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
