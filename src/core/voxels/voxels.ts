import type { Vec3 } from 'mathcat';
import { SetBlockFlags } from './block-flags';
import type { BlockRegistry } from './block-registry';
import { AIR, MISSING, resolveKey } from './block-registry';

export const CHUNK_BITS = 4;
export const CHUNK_SIZE = 1 << CHUNK_BITS; // 16
export const CHUNK_SIZE_SQ = CHUNK_SIZE * CHUNK_SIZE; // 256
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096

/** the air key. always "air". */
export const BLOCK_AIR = 'air';

/** flat index within a chunk for local coords (x, y, z). YZX order. */
export function voxelIndex(x: number, y: number, z: number): number {
    return (y << (CHUNK_BITS + CHUNK_BITS)) | (z << CHUNK_BITS) | x;
}

/** chunk coordinate key for use as a Map key. */
export function chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
}

/** chunk xz-column key — used by voxels.columns to group chunks that share an
 *  (cx, cz) so callers (sky-light, heightmaps, surface queries) can walk a
 *  column top-down without scanning the world bbox. */
export function chunkColumnKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
}

/** world position → chunk coordinate (floored division). */
export function toChunkCoord(worldCoord: number): number {
    return worldCoord >> CHUNK_BITS;
}

/** world position → local coordinate within chunk. */
export function toLocalCoord(worldCoord: number): number {
    return worldCoord & (CHUNK_SIZE - 1);
}

/** world position (any axis) → block index on that axis. block N occupies
 *  world `[N, N+1)`, so this is a floor. */
export function worldToBlockCoord(worldCoord: number): number {
    return Math.floor(worldCoord);
}

/** world-space point at the center of a block's top face — i.e. where
 *  feet land if standing on top of block `(x, y, z)`. block N occupies
 *  `[N, N+1)`, so the top-center is `(x + 0.5, y + 1, z + 0.5)`. */
export function blockTopCenter(out: Vec3, x: number, y: number, z: number): Vec3 {
    out[0] = x + 0.5;
    out[1] = y + 1;
    out[2] = z + 0.5;
    return out;
}

/** chunk data structure */
export type Chunk = {
    /* chunk coordinates */
    cx: number;
    cy: number;
    cz: number;

    /* world coordinates of chunk corner (cx*16, cy*16, cz*16) — cached for meshing. */
    wx: number;
    wy: number;
    wz: number;

    /** number of non-air blocks in the chunk */
    aggregate: number;

    /**
     * stable string keys per palette slot.
     * paletteKeys[0] is always "air".
     *
     * these are the persistence/network identity. survives registry
     * rebuilds, block additions/removals.
     *
     * INVARIANT: append-only across a session. compaction happens only
     * when materialising save bytes via `saveVoxels`, which produces a
     * snapshot without mutating the live chunk. discovery ships this
     * array by reference in voxel_chunk_ops; clients cache the indices
     * and assume they stay stable. shrinking/reordering mid-session
     * silently re-aliases every already-set voxel → wrong-block-type
     * drift on the next remesh.
     */
    paletteKeys: string[];

    /**
     * runtime numeric ids per palette slot (resolved from registry).
     * palette[0] is always AIR (0).
     * unresolved keys get MISSING (1).
     *
     * rebuilt from paletteKeys on registry change (hot reload).
     */
    palette: number[];

    /**
     * reverse lookup: string key → local palette index.
     * kept in sync with paletteKeys. used by setBlock to find or
     * allocate a palette slot for a given string key.
     */
    paletteMap: Map<string, number>;

    /**
     * packed voxel data. each entry is a local palette index (not a
     * global state id). length = CHUNK_VOLUME (4096).
     *
     * Uint16Array supports up to 65535 palette entries per chunk,
     * which is more than enough (MC caps at ~4096 distinct states
     * per section in practice).
     */
    data: Uint16Array;

    /**
     * per-voxel light data. length = CHUNK_VOLUME (4096).
     * each entry packs 4 channels into 16 bits:
     *   bits 15..12 = sky   (0-15)
     *   bits 11..8  = red   (0-15)
     *   bits  7..4  = green (0-15)
     *   bits  3..0  = blue  (0-15)
     *
     * written by the light propagation engine, read by the mesher.
     * initialized to 0 (full dark).
     */
    light: Uint16Array;

    /** dirty flag — set when data changes, cleared by mesher. */
    dirty: boolean;

    /** monotonically increasing version of this chunk's mesh-relevant
     *  state. bumped by every primitive mutation that would change the
     *  mesh output: block edits (setChunkBlock), light edits (setLight),
     *  boundary-neighbour edits (via markBoundaryNeighborsDirty),
     *  registry rebuilds (resolveChunk), and full-light recomputes
     *  (propagateAllLight). the worker dispatcher echoes the gen on a
     *  result; voxel-visuals compares against the live `meshGen` to
     *  decide whether the result is fresh or stale.
     *
     *  starts at 1 so that "gen 0" can sentinel "never meshed".
     *  cloneChunk carries `src.meshGen + 1` so clones force a remesh on
     *  first observation. */
    meshGen: number;

    /** monotonically increasing version of this chunk's PERSISTED data —
     *  blocks, light, and palette. bumped by every mutation that changes the
     *  bytes `saveVoxels` would write (setChunkBlock, setLight, resolveChunk,
     *  propagateAllLight) but NOT by mesh-only changes (boundary-neighbour
     *  re-mesh). incremental scene save keys its per-chunk serialized-byte
     *  cache on this: a chunk re-serializes only when its `version` moves.
     *  starts at 1; cloneChunk carries `src.version` (clone has identical data). */
    version: number;

    /** light dirty flag — set when light[] changes, cleared after network flush. */
    lightDirty: boolean;

    /**
     * per-voxel dirty mask for incremental light deltas. byte-per-voxel,
     * length = CHUNK_VOLUME. set to 1 by setLight when light[i] is written;
     * cleared (released back to EMPTY_LIGHT_MASK) at end-of-tick after
     * dispatch. only meaningful on the server (the client never calls
     * setLight). idle chunks alias the shared EMPTY_LIGHT_MASK singleton —
     * setLight COWs on first write and end-of-tick releases when count
     * drops to zero so memory stays proportional to dirty-chunk count.
     */
    lightDirtyMask: Uint8Array;

    /** number of set bytes in lightDirtyMask — cheap threshold check for
     *  the dispatchLight delta-vs-whole-chunk branch without scanning the mask. */
    lightDirtyCount: number;

    /** cached compressed snapshot for chunk_full encoding. invalidated on any data/light change. */
    compressedSnapshot: Uint8Array | null;

    /** cached palette keys at the time of snapshot. invalidated alongside compressedSnapshot. */
    snapshotPalette: string[] | null;

    /** cached compressed light streams for chunk_light encoding (sky+rgb split,
     *  each RLE'd then deflated). invalidated when light changes. */
    compressedLight: { sky: Uint8Array; rgb: Uint8Array } | null;

    /**
     * neighbor chunk refs for fast cross-chunk traversal.
     * indexed by light.ts direction convention:
     *   0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X
     * (opposites sum to 5)
     * null if neighbor chunk is not loaded.
     */
    neighbors: (Chunk | null)[];
};

/** create a new empty chunk (all air). */
export function createChunk(cx: number, cy: number, cz: number): Chunk {
    return {
        cx,
        cy,
        cz,
        wx: cx * CHUNK_SIZE,
        wy: cy * CHUNK_SIZE,
        wz: cz * CHUNK_SIZE,
        aggregate: 0,
        paletteKeys: [BLOCK_AIR],
        palette: [AIR],
        paletteMap: new Map([[BLOCK_AIR, 0]]),
        data: new Uint16Array(CHUNK_VOLUME),
        light: new Uint16Array(CHUNK_VOLUME),
        dirty: true,
        meshGen: 1,
        version: 1,
        lightDirty: false,
        lightDirtyMask: EMPTY_LIGHT_MASK,
        lightDirtyCount: 0,
        compressedSnapshot: null,
        snapshotPalette: null,
        compressedLight: null,
        neighbors: [null, null, null, null, null, null],
    };
}

/**
 * shared all-AIR data + light arrays used by empty-chunk stubs on the client.
 * any writer that touches `chunk.data` or `chunk.light` MUST first compare
 * identity against these and clone (copy-on-write) before mutating — these
 * arrays are aliased by every empty stub in the world.
 *
 * EMPTY_LIGHT is pre-filled with sky=15 (packed = 0xF000): an empty chunk
 * has no blocks to block sky light, so every voxel sees full sky. without
 * this, entities (model/voxel-mesh visuals) that sample voxel light at a
 * world position inside a networked-empty chunk would read sky=0 and
 * render pitch black.
 */
export const EMPTY_DATA = new Uint16Array(CHUNK_VOLUME);
export const EMPTY_LIGHT = new Uint16Array(CHUNK_VOLUME).fill(0xf000);

/**
 * shared all-zero lightDirtyMask alias for chunks with no in-flight delta
 * changes. setLight (light.ts) compares identity and COWs on first write
 * so idle chunks cost only a reference. client-side chunks (no setLight
 * calls) keep this alias forever, so the per-voxel mask never materialises
 * client-side.
 */
export const EMPTY_LIGHT_MASK = new Uint8Array(CHUNK_VOLUME);

/**
 * create a Chunk stub representing a chunk the server has confirmed is
 * empty (all air). `data` and `light` alias module-level singletons so the
 * stub costs ~a Chunk struct + a 1-entry palette. mesher/light skip it via
 * the existing `aggregate === 0` check; getBlock returns AIR for palette
 * index 0; neighbor links work like any other chunk.
 */
export function createEmptyChunk(cx: number, cy: number, cz: number): Chunk {
    return {
        cx,
        cy,
        cz,
        wx: cx * CHUNK_SIZE,
        wy: cy * CHUNK_SIZE,
        wz: cz * CHUNK_SIZE,
        aggregate: 0,
        paletteKeys: [BLOCK_AIR],
        palette: [AIR],
        paletteMap: new Map([[BLOCK_AIR, 0]]),
        data: EMPTY_DATA,
        light: EMPTY_LIGHT,
        dirty: false,
        meshGen: 1,
        version: 1,
        lightDirty: false,
        lightDirtyMask: EMPTY_LIGHT_MASK,
        lightDirtyCount: 0,
        compressedSnapshot: null,
        snapshotPalette: null,
        compressedLight: null,
        neighbors: [null, null, null, null, null, null],
    };
}

// ── neighbor chunk linkage ──────────────────────────────────────────
//
// direction convention (matches light.ts):
//   0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X
// opposites sum to 5.

const NEIGHBOR_CX: readonly number[] = [1, 0, 0, 0, 0, -1];
const NEIGHBOR_CY: readonly number[] = [0, 1, 0, 0, -1, 0];
const NEIGHBOR_CZ: readonly number[] = [0, 0, 1, -1, 0, 0];

/** wire up bidirectional neighbor refs for a chunk that was just added to voxels.chunks. */
export function linkChunkNeighbors(voxels: Voxels, chunk: Chunk): void {
    for (let dir = 0; dir < 6; dir++) {
        const ncx = chunk.cx + NEIGHBOR_CX[dir]!;
        const ncy = chunk.cy + NEIGHBOR_CY[dir]!;
        const ncz = chunk.cz + NEIGHBOR_CZ[dir]!;
        const neighbor = voxels.chunks.get(chunkKey(ncx, ncy, ncz));
        if (neighbor) {
            chunk.neighbors[dir] = neighbor;
            neighbor.neighbors[5 - dir] = chunk;
        }
    }
}

/** null out neighbor refs when a chunk is about to be removed from voxels.chunks. */
export function unlinkChunkNeighbors(chunk: Chunk): void {
    for (let dir = 0; dir < 6; dir++) {
        const neighbor = chunk.neighbors[dir];
        if (neighbor) {
            neighbor.neighbors[5 - dir] = null;
            chunk.neighbors[dir] = null;
        }
    }
}

/**
 * get the global state id at a local position within a chunk.
 * no bounds checking — caller must ensure 0 <= x,y,z < CHUNK_SIZE.
 *
 * this is the fast path for the mesher. returns numeric runtime ids.
 */
export function getChunkBlock(chunk: Chunk, x: number, y: number, z: number): number {
    return chunk.palette[chunk.data[voxelIndex(x, y, z)]!]!;
}

/**
 * get the string key at a local position within a chunk.
 * for persistence, inspection, debugging. not hot-path.
 */
export function getChunkBlockKey(chunk: Chunk, x: number, y: number, z: number): string {
    return chunk.paletteKeys[chunk.data[voxelIndex(x, y, z)]!]!;
}

/**
 * set a block at a local position within a chunk using a string key.
 * the registry is used to resolve the key to a runtime numeric id.
 * no bounds checking — caller must ensure 0 <= x,y,z < CHUNK_SIZE.
 */
export function setChunkBlock(chunk: Chunk, x: number, y: number, z: number, key: string, registry: BlockRegistry): void {
    let paletteIdx = chunk.paletteMap.get(key);
    if (paletteIdx === undefined) {
        paletteIdx = chunk.paletteKeys.length;
        chunk.paletteKeys.push(key);
        chunk.palette.push(resolveKey(registry, key));
        chunk.paletteMap.set(key, paletteIdx);
    }

    // COW out of the shared empty-stub singletons before mutating.
    if (chunk.data === EMPTY_DATA) chunk.data = new Uint16Array(EMPTY_DATA);

    const idx = voxelIndex(x, y, z);
    const oldPaletteIdx = chunk.data[idx]!;
    chunk.data[idx] = paletteIdx;

    // update aggregate count
    const wasAir = chunk.palette[oldPaletteIdx] === AIR || chunk.palette[oldPaletteIdx] === MISSING;
    const isAir = chunk.palette[paletteIdx] === AIR || chunk.palette[paletteIdx] === MISSING;
    if (wasAir && !isAir) chunk.aggregate++;
    else if (!wasAir && isAir) chunk.aggregate--;

    chunk.dirty = true;
    chunk.meshGen++;
    chunk.version++;
}

/**
 * write a packed light value at a chunk-local voxel index, marking the
 * voxel in the per-chunk dirty mask used by dispatchLight to emit
 * per-block deltas. COWs the mask out of the shared EMPTY_LIGHT_MASK
 * singleton on first write. callers must still flag the chunk via
 * markChunkLightDirty (or the light.ts writeChunkLight helper that
 * folds both) to wire the chunk into the per-tick dispatch queue —
 * setLight only owns the data + mask, not the dirty-set membership.
 */
export function setLight(chunk: Chunk, index: number, value: number): void {
    chunk.light[index] = value;
    chunk.meshGen++;
    chunk.version++;
    if (chunk.lightDirtyMask === EMPTY_LIGHT_MASK) {
        chunk.lightDirtyMask = new Uint8Array(CHUNK_VOLUME);
    }
    if (chunk.lightDirtyMask[index] === 0) {
        chunk.lightDirtyMask[index] = 1;
        chunk.lightDirtyCount++;
    }
}

/**
 * re-resolve all palette keys against a new registry.
 * call this on hot reload when the registry rebuilds.
 *
 * O(palette size) — typically < 50 entries per chunk.
 * unresolved keys → MISSING. newly resolved keys → live again.
 */
export function resolveChunk(chunk: Chunk, registry: BlockRegistry): void {
    let aggregate = 0;
    for (let i = 0; i < chunk.paletteKeys.length; i++) {
        const key = chunk.paletteKeys[i]!;
        const globalId = resolveKey(registry, key);
        chunk.palette[i] = globalId;
    }
    // recount aggregate by scanning data
    for (let i = 0; i < CHUNK_VOLUME; i++) {
        const globalId = chunk.palette[chunk.data[i]!]!;
        if (globalId !== AIR && globalId !== MISSING) aggregate++;
    }
    chunk.aggregate = aggregate;
    chunk.dirty = true;
    chunk.meshGen++;
    chunk.version++;
}

/**
 * compute a compacted snapshot of a chunk's palette + data, without
 * mutating the chunk. used by the save path (saveVoxels) to write a
 * dense on-disk form while the live chunk keeps its append-only palette.
 *
 * INVARIANT: chunk.paletteKeys is append-only across a session. compaction
 * happens only when materialising save bytes via `saveVoxels`. mutating
 * the live palette mid-session is a protocol violation — discovery's
 * voxel_chunk_ops ships the live paletteKeys to clients by reference and
 * relies on indices staying stable.
 *
 * O(CHUNK_VOLUME + oldPaletteSize).
 */
export function repackChunkSnapshot(chunk: Chunk): { paletteKeys: string[]; data: Uint16Array } {
    const oldLen = chunk.paletteKeys.length;
    if (oldLen <= 1) {
        // only air — nothing to compact. still copy data so callers may
        // own/serialize it without aliasing the live chunk.
        return { paletteKeys: chunk.paletteKeys.slice(), data: new Uint16Array(chunk.data) };
    }

    const used = new Uint8Array(oldLen);
    for (let i = 0; i < CHUNK_VOLUME; i++) used[chunk.data[i]!] = 1;
    used[0] = 1; // always keep air

    let usedCount = 0;
    for (let i = 0; i < oldLen; i++) if (used[i]) usedCount++;

    // nothing to drop — return copies so caller owns the buffers.
    if (usedCount === oldLen) {
        return { paletteKeys: chunk.paletteKeys.slice(), data: new Uint16Array(chunk.data) };
    }

    const remap = new Uint16Array(oldLen);
    const newPaletteKeys: string[] = [];
    for (let i = 0; i < oldLen; i++) {
        if (used[i]) {
            remap[i] = newPaletteKeys.length;
            newPaletteKeys.push(chunk.paletteKeys[i]!);
        }
    }

    const newData = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++) newData[i] = remap[chunk.data[i]!]!;

    return { paletteKeys: newPaletteKeys, data: newData };
}

export type VoxelBlockOp = {
    kind: 0;
    cx: number; cy: number; cz: number;
    index: number;
    /** chunk-local palette index — what the network sends to clients. */
    data: number;
    /** world coords — saves recomputing per delta for hook dispatch. */
    wx: number; wy: number; wz: number;
    /** global state id before this op. */
    oldStateId: number;
    /** global state id after this op. */
    newStateId: number;
};
export type VoxelDeleteOp = { kind: 2; cx: number; cy: number; cz: number };

export type VoxelOp = VoxelBlockOp | VoxelDeleteOp;

export type VoxelChanges = {
    ops: VoxelOp[];
    lightEpoch: number; // bumped by propagateAllLight, monotonically increasing
    /** blocks changed this tick that need light recomputed. drained by flushPendingLight. */
    pendingLight: Array<{ wx: number; wy: number; wz: number; oldStateId: number }>;
    /** chunks created this tick that need sky light seeded. drained by flushPendingLight. */
    pendingNewChunks: Chunk[];
    /** chunks created this tick. drained by discovery — lets each player's
     *  cursor rewind so newly-existing chunks get streamed without
     *  re-walking the whole view sphere each tick. holds the Chunk ref so
     *  consumers don't have to re-lookup. */
    addedChunks: Set<Chunk>;
    /** index of the next op the NOTIFY_NEIGHBOURS pass should consider.
     *  runBlockHooks() advances this past every op it processes, so subsequent
     *  drains skip the already-fired prefix — keeps the inline-drain path
     *  O(n) total across n setBlock calls instead of O(n²). */
    notifyNeighboursCursor: number;
    /** same as above, for the FIRE_EVENTS pass. tracked separately because
     *  runNeighbourRecompute (editor) only advances the neighbours cursor;
     *  end-of-tick runBlockEventHooks needs to fire events from index 0. */
    fireEventsCursor: number;
    /** re-entrancy guard for runBlockHooks. set while it runs so a chained
     *  setBlock from inside a hook just appends and lets the outer
     *  while-loop pick it up. */
    _draining: boolean;
};

export function createVoxelChanges(): VoxelChanges {
    return {
        ops: [],
        lightEpoch: 0,
        pendingLight: [],
        pendingNewChunks: [],
        addedChunks: new Set(),
        notifyNeighboursCursor: 0,
        fireEventsCursor: 0,
        _draining: false,
    };
}

/** clear ops after flush. lightEpoch is NOT cleared — it's monotonic. */
export function clearVoxelChanges(changes: VoxelChanges): void {
    changes.ops.length = 0;
    changes.addedChunks.clear();
    changes.notifyNeighboursCursor = 0;
    changes.fireEventsCursor = 0;
}

/** registered by block-hooks.ts at module init to break the import cycle:
 *  block-hooks needs setBlock (for chained recomputes), and setBlock needs
 *  to drain hooks inline. avoids a true ESM value cycle. */
let _runBlockHooks: ((voxels: Voxels, mask: number) => void) | null = null;
export function _registerBlockHooksDriver(fn: (voxels: Voxels, mask: number) => void): void {
    _runBlockHooks = fn;
}

/**
 * flood-fill light-propagation config. when `enabled` is false,
 * `flushPendingLight` is short-circuited and `setBlock` / `ensureChunk`
 * write a flat seed value instead of queueing for BFS. `minLevel` is the
 * sky-channel seed for inline writes — `15` keeps the world fully lit,
 * `0` is pitch black except where blocks emit their own light.
 *
 * lives inside `VoxelsAuthority` — only meaningful when this Voxels owns
 * the truth and drives light propagation.
 */
export type FloodFillLightingState = {
    enabled: boolean;
    minLevel: number;
};

/**
 * authoritative-emission bundle. populated when this Voxels owns the
 * truth: writes record ops, fire block-hook observers, and drive
 * flood-fill light propagation. null on a read-only mirror (today's
 * clients). a future client-side authoritative room allocates one of
 * these just like the server does — no type split, no env probe.
 */
export type VoxelsAuthority = {
    /** per-tick change log for block ops, light updates, and new chunks. */
    changes: VoxelChanges;
    /**
     * per-room observer registry for onBuild / onBreak / onStateChange
     * handlers registered via script-scope APIs. lazy-init on first
     * registration. null until any handler is registered. keyed by
     * block-type index. see block-hooks.ts for the entry shape.
     */
    observers: Map<number, import('./block-hooks').BlockObserverEntry> | null;
    /** flood-fill light-propagation config. see type doc. */
    floodFillLighting: FloodFillLightingState;
};

export function createVoxelsAuthority(): VoxelsAuthority {
    return {
        changes: createVoxelChanges(),
        observers: null,
        floodFillLighting: { enabled: true, minLevel: 15 },
    };
}

/** clear per-tick state inside the authority bundle. observer registry
 *  and lighting config are NOT cleared — they outlive a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void {
    clearVoxelChanges(authority.changes);
}

export type Voxels = {
    chunks: Map<string, Chunk>;
    /** dirty index — sidecar to chunk.dirty / chunk.lightDirty flags.
     *
     *  `blocks` is the renderer tier — populated by `markChunkDirty` and
     *  (post Stage 2b) also by `markChunkLightDirty` since meshChunk emits
     *  geometry+light in one pass. consumed by voxel-visuals.update().
     *
     *  `light` is the server network tier — populated by
     *  `markChunkLightDirty` only. consumed by discovery's per-client
     *  chunk_light streaming. kept separate from `blocks` so the server
     *  doesn't have to filter a growing `blocks` set every tick to find
     *  light-only changes. */
    dirty: { blocks: Set<Chunk>; light: Set<Chunk> };
    /** xz-column index — chunks at the same (cx, cz) sorted by cy descending.
     *  maintained by `ensureChunk` and rebuilt by `loadVoxels`. lets
     *  sky-light / heightmap / surface code walk only chunks that actually
     *  exist, instead of scanning a world bbox. */
    columns: Map<string, Chunk[]>;
    /** block registry — flat lookup tables for block type/state info.
     *  stored here so setBlock/resolveAllChunks don't need a trailing registry arg.
     *  on hot reload, registry-dispatch reassigns this field directly and
     *  calls resolveAllChunks() per room. */
    registry: BlockRegistry;
    /** authoritative-emission bundle. null on read-only mirrors. see
     *  `VoxelsAuthority` doc. */
    authority: VoxelsAuthority | null;
};

export function createVoxels(registry: BlockRegistry): Voxels {
    return {
        chunks: new Map(),
        dirty: { blocks: new Set(), light: new Set() },
        columns: new Map(),
        registry,
        authority: null,
    };
}

/** mark `chunk` as needing a remesh. routes through here (instead of
 *  setting `chunk.dirty = true` directly) so the renderer's per-frame
 *  scan can iterate `voxels.dirty.blocks` instead of the whole Map. */
export function markChunkDirty(voxels: Voxels, chunk: Chunk): void {
    chunk.dirty = true;
    voxels.dirty.blocks.add(chunk);
}

/** mark `chunk` as needing a relight. adds to BOTH `dirty.blocks` (so the
 *  client renderer remeshes — meshChunk emits geometry+light in one pass)
 *  AND `dirty.light` (so the server's chunk_light streaming path can find
 *  light-only changes without filtering a growing blocks set). */
export function markChunkLightDirty(voxels: Voxels, chunk: Chunk): void {
    chunk.lightDirty = true;
    voxels.dirty.blocks.add(chunk);
    voxels.dirty.light.add(chunk);
}

/** insert `chunk` into its xz-column array, keeping the array sorted by
 *  cy descending. duplicate cy is a no-op (caller already had the chunk). */
function addChunkToColumn(voxels: Voxels, chunk: Chunk): void {
    const key = chunkColumnKey(chunk.cx, chunk.cz);
    let column = voxels.columns.get(key);
    if (!column) {
        column = [chunk];
        voxels.columns.set(key, column);
        return;
    }
    // binary search for insert position (descending by cy)
    let lo = 0;
    let hi = column.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (column[mid]!.cy > chunk.cy) lo = mid + 1;
        else hi = mid;
    }
    if (column[lo]?.cy === chunk.cy) return;
    column.splice(lo, 0, chunk);
}

/** rebuild `voxels.columns` from `voxels.chunks`. used by deserialize and as
 *  a defensive reconcile when callers bypass `ensureChunk` (tests/benches). */
export function rebuildColumns(voxels: Voxels): void {
    voxels.columns.clear();
    for (const chunk of voxels.chunks.values()) {
        addChunkToColumn(voxels, chunk);
    }
}

/** get or create a chunk at the given chunk coordinates. */
export function ensureChunk(voxels: Voxels, cx: number, cy: number, cz: number): Chunk {
    const key = chunkKey(cx, cy, cz);

    let chunk = voxels.chunks.get(key);

    if (!chunk) {
        chunk = createChunk(cx, cy, cz);
        voxels.chunks.set(key, chunk);
        voxels.dirty.blocks.add(chunk);
        addChunkToColumn(voxels, chunk);
        linkChunkNeighbors(voxels, chunk);

        // queue this chunk for sky light seeding so flushPendingLight
        // can seed it before processing any block changes. when flood-fill
        // is disabled, fill light inline with a flat sky-level seed instead.
        const authority = voxels.authority;

        if (authority) {
            if (authority.floodFillLighting.enabled) {
                authority.changes.pendingNewChunks.push(chunk);
            } else {
                const sky = authority.floodFillLighting.minLevel & 0xf;
                chunk.light.fill(sky << 12);
                // no markChunkLightDirty here — initial light ships with
                // voxel_chunk_full via addedChunks, and the bulk fill bypasses
                // setLight (mask stays empty). entering the dirty queue with
                // dirtyCount=0 would only create a ghost the dispatch fallback
                // would re-ship as a redundant full-light payload.
            }
            authority.changes.addedChunks.add(chunk);
        }
    }
    return chunk;
}

/** get the string key at a world position. returns "air" if chunk doesn't exist. */
export function getBlock(voxels: Voxels, wx: number, wy: number, wz: number): string {
    const cx = toChunkCoord(wx);
    const cy = toChunkCoord(wy);
    const cz = toChunkCoord(wz);
    const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
    if (!chunk) return BLOCK_AIR;
    return getChunkBlockKey(chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
}

/** get the global state id at a world position. returns AIR if chunk doesn't exist. */
export function getBlockState(voxels: Voxels, wx: number, wy: number, wz: number): number {
    const cx = toChunkCoord(wx);
    const cy = toChunkCoord(wy);
    const cz = toChunkCoord(wz);
    const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
    if (!chunk) return AIR;
    return getChunkBlock(chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
}

export function getBlockStateRelative(voxels: Voxels, chunk: Chunk, lx: number, ly: number, lz: number): number {
    // if local coords are out of bounds, delegate to getBlock which will find the correct chunk
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
        const wx = chunk.wx + lx;
        const wy = chunk.wy + ly;
        const wz = chunk.wz + lz;
        return getBlockState(voxels, wx, wy, wz);
    }

    return getChunkBlock(chunk, lx, ly, lz);
}

/** iterate every non-air block in a voxels instance, yielding world coords and string key. */
export function forEachBlock(voxels: Voxels, cb: (wx: number, wy: number, wz: number, key: string) => void): void {
    for (const chunk of voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                    const key = chunk.paletteKeys[paletteIdx];
                    if (!key || key === BLOCK_AIR) continue;
                    cb(chunk.wx + lx, chunk.wy + ly, chunk.wz + lz, key);
                }
            }
        }
    }
}

/**
 * mark the chunks bordering an edit dirty. for edits in the chunk interior
 * this is a no-op. for edits on a face boundary, 1 neighbor; on an edge, 3;
 * on a corner, 7. the mesher reads voxels from these chunks when building
 * the slab borders, so AO + smooth lighting stay stale unless we remesh them.
 */
function markBoundaryNeighborsDirty(
    voxels: Voxels,
    cx: number,
    cy: number,
    cz: number,
    lx: number,
    ly: number,
    lz: number,
): void {
    const dx = lx === 0 ? -1 : lx === CHUNK_SIZE - 1 ? 1 : 0;
    const dy = ly === 0 ? -1 : ly === CHUNK_SIZE - 1 ? 1 : 0;
    const dz = lz === 0 ? -1 : lz === CHUNK_SIZE - 1 ? 1 : 0;
    if (dx === 0 && dy === 0 && dz === 0) return;

    const xs: readonly number[] = dx === 0 ? [0] : [0, dx];
    const ys: readonly number[] = dy === 0 ? [0] : [0, dy];
    const zs: readonly number[] = dz === 0 ? [0] : [0, dz];

    for (const ox of xs) {
        for (const oy of ys) {
            for (const oz of zs) {
                if (ox === 0 && oy === 0 && oz === 0) continue;
                const n = voxels.chunks.get(chunkKey(cx + ox, cy + oy, cz + oz));
                if (n) {
                    n.meshGen++;
                    markChunkDirty(voxels, n);
                }
            }
        }
    }
}

/**
 * set a block at a world position. creates the chunk if it doesn't exist.
 *
 * `flags` controls which hook passes fire inline before this call returns —
 * default is gameplay-coherent (`SetBlockFlags.DEFAULT` = NOTIFY_NEIGHBOURS
 * + FIRE_EVENTS), so a place-then-read sees settled state. bulk paths
 * (editor command drain, worldgen, prefab paste) should pass
 * `SetBlockFlags.BULK` and drain explicitly via runNeighbourRecompute or
 * runBlockEventHooks once at the end. inline drains from inside a hook
 * handler are guarded against re-entry — see block-hooks.runBlockHooks.
 */
export function setBlock(
    voxels: Voxels,
    wx: number, wy: number, wz: number,
    key: string,
    flags: number = SetBlockFlags.DEFAULT,
): void {
    const cx = toChunkCoord(wx);
    const cy = toChunkCoord(wy);
    const cz = toChunkCoord(wz);
    const chunk = ensureChunk(voxels, cx, cy, cz);
    const lx = toLocalCoord(wx);
    const ly = toLocalCoord(wy);
    const lz = toLocalCoord(wz);

    // capture old state id before overwrite (for light batching + hooks)
    const index = voxelIndex(lx, ly, lz);
    const oldStateId = chunk.palette[chunk.data[index]!]!;

    setChunkBlock(chunk, lx, ly, lz, key, voxels.registry);
    // setChunkBlock sets the bool; mirror into the renderer index.
    voxels.dirty.blocks.add(chunk);

    // boundary edits affect AO + smooth lighting in neighbor chunks: the mesher
    // builds an 18^3 slab that samples face, edge, and corner neighbors. mark
    // up to 7 surrounding chunks dirty so their meshes rebuild.
    markBoundaryNeighborsDirty(voxels, cx, cy, cz, lx, ly, lz);

    const auth = voxels.authority;
    if (auth) {
        const newStateId = chunk.palette[chunk.data[index]!]!;
        auth.changes.ops.push({
            kind: 0,
            cx, cy, cz,
            index,
            data: chunk.data[index]!,
            wx, wy, wz,
            oldStateId,
            newStateId,
        });
        if (auth.floodFillLighting.enabled) {
            auth.changes.pendingLight.push({ wx, wy, wz, oldStateId });
        } else {
            // flood-fill disabled: inline-seed light from block emission +
            // the configured minLevel sky channel. matches the bit layout in
            // light.ts packLight (sky<<12 | r<<8 | g<<4 | b).
            const emission = voxels.registry.lightEmission[newStateId] ?? 0;
            const sky = auth.floodFillLighting.minLevel & 0xf;
            setLight(chunk, index, (sky << 12) | (emission & 0xfff));
            markChunkLightDirty(voxels, chunk);
        }
        chunk.compressedSnapshot = null;
        chunk.snapshotPalette = null;

        // inline-drain whichever hook passes the caller asked for. bulk paths
        // pass SetBlockFlags.BULK (0) and skip this entirely; the re-entrancy
        // guard in runBlockHooks makes chained-from-hook calls a no-op.
        if (flags !== 0 && _runBlockHooks) {
            _runBlockHooks(voxels, flags);
        }
    }
}

/**
 * re-resolve all chunks against the current registry.
 * call this on hot reload when the registry rebuilds.
 */
export function resolveAllChunks(voxels: Voxels): void {
    for (const chunk of voxels.chunks.values()) {
        resolveChunk(chunk, voxels.registry);
        // resolveChunk sets dirty=true; mirror into the renderer index.
        voxels.dirty.blocks.add(chunk);
    }
}

/** deep-copy a single chunk. neighbors are NOT copied — caller wires those. */
function cloneChunk(src: Chunk): Chunk {
    return {
        cx: src.cx,
        cy: src.cy,
        cz: src.cz,
        wx: src.wx,
        wy: src.wy,
        wz: src.wz,
        aggregate: src.aggregate,
        paletteKeys: src.paletteKeys.slice(),
        palette: src.palette.slice(),
        paletteMap: new Map(src.paletteMap),
        data: new Uint16Array(src.data),
        light: new Uint16Array(src.light),
        dirty: true,
        meshGen: src.meshGen + 1,
        version: src.version,
        lightDirty: false,
        lightDirtyMask: new Uint8Array(src.lightDirtyMask),
        lightDirtyCount: src.lightDirtyCount,
        compressedSnapshot: null,
        snapshotPalette: null,
        compressedLight: null,
        neighbors: [null, null, null, null, null, null],
    };
}

/**
 * deep-copy a Voxels instance into a fresh one. the new instance owns its
 * chunk data — mutations don't affect the source. registry is shared by
 * reference; if you need a different registry, reassign `.registry` and
 * call resolveAllChunks() on the result.
 */
export function cloneVoxels(src: Voxels): Voxels {
    const out = createVoxels(src.registry);
    for (const [key, chunk] of src.chunks) {
        const cloned = cloneChunk(chunk);
        out.chunks.set(key, cloned);
        if (cloned.dirty) out.dirty.blocks.add(cloned);
        if (cloned.lightDirty) {
            out.dirty.blocks.add(cloned);
            out.dirty.light.add(cloned);
        }
        linkChunkNeighbors(out, cloned);
    }
    return out;
}

/**
 * copy all non-air blocks from `src` into `out`. preserves source coords —
 * blocks land at the same world positions in `out`. existing blocks in
 * `out` at those positions are overwritten; blocks at positions not
 * present in the source are left alone.
 */
export function copyVoxels(out: Voxels, src: Voxels): void {
    for (const chunk of src.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                    const key = chunk.paletteKeys[paletteIdx];
                    if (!key || key === BLOCK_AIR) continue;
                    // BULK — bulk copy is a transport primitive, not a place-action.
                    // caller drains if the destination has change tracking enabled.
                    setBlock(out, chunk.wx + lx, chunk.wy + ly, chunk.wz + lz, key, SetBlockFlags.BULK);
                }
            }
        }
    }
}
