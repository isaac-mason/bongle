import type { Vec3 } from 'mathcat';
import { SetBlockFlags } from './block-flags';
import type { BlockObserverEntry } from './block-hooks';
import { runBlockEvents, runBlockHooks } from './block-hooks';
import type { BlockRegistry } from './block-registry';
import { AIR, MISSING, resolveKey } from './block-registry';
import { CullType } from './blocks';

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

/** chunk xz-column key, used by voxels.columns to group chunks that share an
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

/** world-space point at the center of a block's top face, i.e. where
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

    /* world coordinates of chunk corner (cx*16, cy*16, cz*16), cached for meshing. */
    wx: number;
    wy: number;
    wz: number;

    /** number of non-air blocks in the chunk */
    nonAirCount: number;

    /** number of fully-occluding (CullType.SOLID) blocks in the chunk.
     *  always ≤ nonAirCount. solidCount === CHUNK_VOLUME means the chunk is
     *  entirely opaque; a chunk whose 6 neighbors are also fully opaque
     *  has no visible surface and can skip remeshing (intended consumer:
     *  the enqueue path in render/voxels/voxel-visuals.ts). */
    solidCount: number;

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

    /** dirty flag, set when data changes, cleared by mesher. */
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

    /** monotonically increasing version of this chunk's PERSISTED data,
     *  blocks, light, and palette. bumped by every mutation that changes the
     *  bytes `saveVoxels` would write (setChunkBlock, setLight, resolveChunk,
     *  propagateAllLight) but NOT by mesh-only changes (boundary-neighbour
     *  re-mesh). incremental scene save keys its per-chunk serialized-byte
     *  cache on this: a chunk re-serializes only when its `version` moves.
     *  starts at 1; cloneChunk carries `src.version` (clone has identical data). */
    version: number;

    /** light dirty flag, set when light[] changes, cleared after network flush. */
    lightDirty: boolean;

    /**
     * per-voxel dirty mask for incremental light deltas. byte-per-voxel,
     * length = CHUNK_VOLUME. set to 1 by setLight when light[i] is written;
     * cleared (released back to EMPTY_LIGHT_MASK) at end-of-tick after
     * dispatch. only meaningful on the server (the client never calls
     * setLight). idle chunks alias the shared EMPTY_LIGHT_MASK singleton,
     * setLight COWs on first write and end-of-tick releases when count
     * drops to zero so memory stays proportional to dirty-chunk count.
     */
    lightDirtyMask: Uint8Array;

    /** number of set bytes in lightDirtyMask, cheap threshold check for
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
     * neighbor chunk refs for fast cross-chunk traversal, 26 slots (the full
     * 3×3×3 apron the mesher reads for AO + smooth light).
     *   slots 0-5  = the 6 faces, in light.ts's direction convention
     *                (0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X; opposites sum to 5).
     *                light propagation touches only these.
     *   slots 6-25 = the 12 edges + 8 corners (see NEIGHBOR_D{X,Y,Z}).
     * null if that neighbor chunk is not loaded.
     */
    neighbors: (Chunk | null)[];
    /**
     * count of non-null entries in `neighbors` (0-26). Maintained by
     * link/unlinkChunkNeighbors. The streaming client defers meshing a chunk
     * until this hits 26 (full apron present) so it meshes once with correct
     * boundary AO/light instead of re-meshing as each neighbor arrives.
     */
    knownNeighbourCount: number;
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
        nonAirCount: 0,
        solidCount: 0,
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
        neighbors: newNeighbors(),
        knownNeighbourCount: 0,
    };
}

/** fresh 26-slot neighbor array, all null. */
export function newNeighbors(): (Chunk | null)[] {
    return new Array<Chunk | null>(NEIGHBOR_COUNT).fill(null);
}

/**
 * shared all-AIR data + light arrays used by empty-chunk stubs on the client.
 * any writer that touches `chunk.data` or `chunk.light` MUST first compare
 * identity against these and clone (copy-on-write) before mutating, these
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
 * the existing `nonAirCount === 0` check; getBlock returns AIR for palette
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
        nonAirCount: 0,
        solidCount: 0,
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
        neighbors: newNeighbors(),
        knownNeighbourCount: 0,
    };
}

// ── neighbor chunk linkage ──────────────────────────────────────────
//
// 26-slot neighbourhood (the mesher's 3×3×3 apron). slots 0-5 are the 6 faces
// in light.ts's direction convention (0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X;
// opposites sum to 5) so light propagation keeps indexing them directly; slots
// 6-25 are the 12 edges + 8 corners. NEIGHBOR_OPPOSITE[i] is the slot in the
// neighbour that points back (its negated offset), for the bidirectional link.

const { NEIGHBOR_DX, NEIGHBOR_DY, NEIGHBOR_DZ, NEIGHBOR_OPPOSITE, NEIGHBOR_SLOT_OF } = /* @__PURE__ */ (() => {
    // faces first, in the light.ts order, then every edge/corner (manhattan ≥ 2).
    const off: [number, number, number][] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [0, -1, 0],
        [-1, 0, 0],
    ];
    for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 2) continue; // skip center + the 6 faces
                off.push([dx, dy, dz]);
            }
    // inverse: 3×3×3 offset (packed (dz+1)*9+(dy+1)*3+(dx+1)) → slot, -1 for the centre.
    const slotOf = new Int8Array(27).fill(-1);
    off.forEach(([x, y, z], i) => {
        slotOf[(z + 1) * 9 + (y + 1) * 3 + (x + 1)] = i;
    });
    return {
        NEIGHBOR_DX: off.map((o) => o[0]),
        NEIGHBOR_DY: off.map((o) => o[1]),
        NEIGHBOR_DZ: off.map((o) => o[2]),
        NEIGHBOR_OPPOSITE: off.map(([x, y, z]) => off.findIndex(([a, b, c]) => a === -x && b === -y && c === -z)),
        NEIGHBOR_SLOT_OF: slotOf,
    };
})();

/** number of neighbour slots on `Chunk.neighbors` (full 3×3×3 minus self). */
export const NEIGHBOR_COUNT = NEIGHBOR_DX.length;

/** slot index in `neighbors[]` for the neighbour at chunk-offset (dx,dy,dz),
 *  each in [-1,1]. -1 for (0,0,0) / out of range. lets the mesher follow
 *  neighbour pointers instead of rebuilding chunk keys. */
export function neighbourSlot(dx: number, dy: number, dz: number): number {
    return NEIGHBOR_SLOT_OF[(dz + 1) * 9 + (dy + 1) * 3 + (dx + 1)]!;
}

/** wire up bidirectional neighbor refs for a chunk that was just added to
 *  voxels.chunks, and bump the `knownNeighbourCount` on both sides. */
export function linkChunkNeighbors(voxels: Voxels, chunk: Chunk): void {
    for (let i = 0; i < NEIGHBOR_COUNT; i++) {
        const neighbor = voxels.chunks.get(
            chunkKey(chunk.cx + NEIGHBOR_DX[i]!, chunk.cy + NEIGHBOR_DY[i]!, chunk.cz + NEIGHBOR_DZ[i]!),
        );
        if (neighbor) {
            chunk.neighbors[i] = neighbor;
            neighbor.neighbors[NEIGHBOR_OPPOSITE[i]!] = chunk;
            chunk.knownNeighbourCount++;
            neighbor.knownNeighbourCount++;
        }
    }
}

/** null out neighbor refs when a chunk is about to be removed from
 *  voxels.chunks, decrementing each surviving neighbour's count. */
export function unlinkChunkNeighbors(chunk: Chunk): void {
    for (let i = 0; i < NEIGHBOR_COUNT; i++) {
        const neighbor = chunk.neighbors[i];
        if (neighbor) {
            neighbor.neighbors[NEIGHBOR_OPPOSITE[i]!] = null;
            neighbor.knownNeighbourCount--;
            chunk.neighbors[i] = null;
        }
    }
}

/** insert (or update in place) a chunk from already-decoded parts — the mesh
 *  worker's mirror uses this to load chunks from a packet. a new chunk aliases
 *  the shared empty arrays then takes the given data/light/palette and links
 *  into the neighbour graph; an existing chunk is updated in place so its links
 *  survive. does NOT touch columns/dirty/light-seeding (this is a raw mirror
 *  load, not an authored/streamed edit). */
export function loadChunk(
    voxels: Voxels,
    cx: number,
    cy: number,
    cz: number,
    version: number,
    data: Uint16Array,
    light: Uint16Array,
    palette: number[],
): Chunk {
    const key = chunkKey(cx, cy, cz);
    const existing = voxels.chunks.get(key);
    if (existing) {
        existing.version = version;
        existing.data = data;
        existing.light = light;
        existing.palette = palette;
        return existing;
    }
    const chunk = createEmptyChunk(cx, cy, cz);
    chunk.version = version;
    chunk.data = data;
    chunk.light = light;
    chunk.palette = palette;
    voxels.chunks.set(key, chunk);
    linkChunkNeighbors(voxels, chunk);
    return chunk;
}

/** remove a chunk from `voxels.chunks`, unlinking it from the neighbour graph. */
export function removeChunk(voxels: Voxels, cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    const chunk = voxels.chunks.get(key);
    if (chunk) {
        unlinkChunkNeighbors(chunk);
        voxels.chunks.delete(key);
    }
}

/**
 * get the global state id at a local position within a chunk.
 * no bounds checking, caller must ensure 0 <= x,y,z < CHUNK_SIZE.
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

/** get-or-allocate the chunk-local palette index for a block key. tier-1
 *  callers grab a slot once, then write `chunkData(chunk)[idx] = slot` directly. */
export function ensureChunkPaletteSlot(chunk: Chunk, key: string, registry: BlockRegistry): number {
    let slot = chunk.paletteMap.get(key);
    if (slot === undefined) {
        slot = chunk.paletteKeys.length;
        chunk.paletteKeys.push(key);
        chunk.palette.push(resolveKey(registry, key));
        chunk.paletteMap.set(key, slot);
    }
    return slot;
}

/** the chunk's writable voxel-data array, COWing out of the shared EMPTY_DATA
 *  stub first so a direct write can't corrupt the singleton. for tier-1 raw
 *  fills: grab this, write/`.fill()` slots into it, then call invalidateChunk. */
export function chunkData(chunk: Chunk): Uint16Array {
    if (chunk.data === EMPTY_DATA) chunk.data = new Uint16Array(EMPTY_DATA);
    return chunk.data;
}

/**
 * set a block at a chunk-local position — the meat of a voxel write. resolves
 * the palette slot, writes the cell, maintains nonAir/solid counts + mesh gen,
 * registers the chunk mesh-dirty, and (when `voxels` is authoritative) records
 * the op and routes lighting by flag:
 *   DEFAULT → per-block incremental (pendingLight) + inline hook drain
 *   BULK    → whole-chunk relight (staleLightChunks) + skip inline hooks
 * All authority-side work no-ops when `voxels.authority` is null (client mirror,
 * bare test fixtures) — those get just the data + palette + counts.
 *
 * `setBlock` is a thin wrapper over this that resolves world coords → chunk.
 * no bounds checking, caller ensures 0 <= x,y,z < CHUNK_SIZE.
 */
export function setChunkBlock(
    voxels: Voxels,
    chunk: Chunk,
    x: number,
    y: number,
    z: number,
    key: string,
    flags: number = SetBlockFlags.DEFAULT,
): void {
    const registry = voxels.registry;
    const slot = ensureChunkPaletteSlot(chunk, key, registry);
    const data = chunkData(chunk);

    const idx = voxelIndex(x, y, z);
    const oldStateId = chunk.palette[data[idx]!]!;
    data[idx] = slot;
    const newStateId = chunk.palette[slot]!;

    // nonAir count delta
    const wasAir = oldStateId === AIR || oldStateId === MISSING;
    const isAir = newStateId === AIR || newStateId === MISSING;
    if (wasAir && !isAir) chunk.nonAirCount++;
    else if (!wasAir && isAir) chunk.nonAirCount--;

    // fully-occluding (SOLID) count delta (air/missing are CullType.NONE)
    const wasSolid = registry.cull[oldStateId] === CullType.SOLID;
    const isSolid = registry.cull[newStateId] === CullType.SOLID;
    if (!wasSolid && isSolid) chunk.solidCount++;
    else if (wasSolid && !isSolid) chunk.solidCount--;

    chunk.dirty = true;
    chunk.meshGen++;
    chunk.version++;
    voxels.dirty.blocks.add(chunk);

    // boundary edits affect AO + smooth lighting in up to 7 neighbour chunks.
    markBoundaryNeighborsDirty(voxels, chunk.cx, chunk.cy, chunk.cz, x, y, z);

    const auth = voxels.authority;
    if (!auth) return;

    auth.changes.ops.push({
        kind: 0,
        cx: chunk.cx,
        cy: chunk.cy,
        cz: chunk.cz,
        index: idx,
        data: slot,
        wx: chunk.wx + x,
        wy: chunk.wy + y,
        wz: chunk.wz + z,
        oldStateId,
        newStateId,
    });

    if (!auth.floodFillLighting.enabled) {
        // flood-fill disabled (flat / fullbright): inline sky-seed + block
        // emission, no propagation — for BULK and DEFAULT alike. must NOT queue
        // a relight; flushPendingLight does no propagation in this mode.
        const emission = registry.lightEmission[newStateId] ?? 0;
        const sky = auth.floodFillLighting.minLevel & 0xf;
        setLight(chunk, idx, (sky << 12) | (emission & 0xfff));
        markChunkLightDirty(voxels, chunk);
    } else if (flags === SetBlockFlags.BULK) {
        // whole-chunk relight at tick end (scoped bake over the touched set).
        auth.changes.light.chunks.add(chunk);
    } else {
        auth.changes.light.blocks.push({ wx: chunk.wx + x, wy: chunk.wy + y, wz: chunk.wz + z, oldStateId });
    }

    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;

    // settle this write's hooks inline. BLOCK_HOOKS → block-def recompute (fences
    // join, chains recurse); BLOCK_EVENTS → script observers, after the recompute
    // so they see settled state. BULK sets the former, not the latter.
    const wwx = chunk.wx + x;
    const wwy = chunk.wy + y;
    const wwz = chunk.wz + z;
    if (flags & SetBlockFlags.BLOCK_HOOKS) runBlockHooks(voxels, wwx, wwy, wwz);
    if (flags & SetBlockFlags.BLOCK_EVENTS) runBlockEvents(voxels, wwx, wwy, wwz, oldStateId, newStateId);
}

/**
 * reconcile a chunk after tier-1 raw writes into `chunkData(chunk)`: rescans
 * nonAir/solid counts from the data + palette, marks the chunk mesh-dirty and
 * schedules its light (a tick-end whole-chunk relight, or an inline flat seed
 * when flood-fill is disabled). No ops, no hooks — the raw-write path trades
 * those away for speed. no-op past the rescan when `voxels.authority` is null.
 */
export function invalidateChunk(voxels: Voxels, chunk: Chunk): void {
    const registry = voxels.registry;
    const data = chunk.data;
    const palette = chunk.palette;
    const cull = registry.cull;
    let nonAir = 0;
    let solid = 0;
    for (let i = 0; i < data.length; i++) {
        const state = palette[data[i]!]!;
        if (state === AIR || state === MISSING) continue;
        nonAir++;
        if (cull[state] === CullType.SOLID) solid++;
    }
    chunk.nonAirCount = nonAir;
    chunk.solidCount = solid;
    chunk.dirty = true;
    chunk.meshGen++;
    chunk.version++;
    voxels.dirty.blocks.add(chunk);

    const auth = voxels.authority;
    if (!auth) return;
    if (auth.floodFillLighting.enabled) {
        auth.changes.light.chunks.add(chunk);
    } else {
        // flood-fill disabled (flat / fullbright): the raw writes bypassed inline
        // seeding, so flat-seed the chunk here (sky base + per-cell emission).
        const skyPacked = (auth.floodFillLighting.minLevel & 0xf) << 12;
        chunk.light.fill(skyPacked);
        const emissionTable = registry.lightEmission;
        for (let i = 0; i < data.length; i++) {
            const emission = emissionTable[palette[data[i]!]!] ?? 0;
            if (emission > 0) setLight(chunk, i, skyPacked | (emission & 0xfff));
        }
        markChunkLightDirty(voxels, chunk);
    }
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
}

/**
 * write a packed light value at a chunk-local voxel index, marking the
 * voxel in the per-chunk dirty mask used by dispatchLight to emit
 * per-block deltas. COWs the mask out of the shared EMPTY_LIGHT_MASK
 * singleton on first write. callers must still flag the chunk via
 * markChunkLightDirty (or the light.ts writeChunkLight helper that
 * folds both) to wire the chunk into the per-tick dispatch queue,
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
 * O(palette size), typically < 50 entries per chunk.
 * unresolved keys → MISSING. newly resolved keys → live again.
 */
export function resolveChunk(chunk: Chunk, registry: BlockRegistry): void {
    let nonAirCount = 0;
    let solidCount = 0;
    for (let i = 0; i < chunk.paletteKeys.length; i++) {
        const key = chunk.paletteKeys[i]!;
        const globalId = resolveKey(registry, key);
        chunk.palette[i] = globalId;
    }
    // recount nonAirCount + solidCount by scanning data. cull can change on a
    // registry rebuild, so both are recomputed from scratch here.
    for (let i = 0; i < CHUNK_VOLUME; i++) {
        const globalId = chunk.palette[chunk.data[i]!]!;
        if (globalId !== AIR && globalId !== MISSING) nonAirCount++;
        if (registry.cull[globalId] === CullType.SOLID) solidCount++;
    }
    chunk.nonAirCount = nonAirCount;
    chunk.solidCount = solidCount;
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
 * the live palette mid-session is a protocol violation, discovery's
 * voxel_chunk_ops ships the live paletteKeys to clients by reference and
 * relies on indices staying stable.
 *
 * O(CHUNK_VOLUME + oldPaletteSize).
 */
export function repackChunkSnapshot(chunk: Chunk): { paletteKeys: string[]; data: Uint16Array } {
    const oldLen = chunk.paletteKeys.length;
    if (oldLen <= 1) {
        // only air, nothing to compact. still copy data so callers may
        // own/serialize it without aliasing the live chunk.
        return { paletteKeys: chunk.paletteKeys.slice(), data: new Uint16Array(chunk.data) };
    }

    const used = new Uint8Array(oldLen);
    for (let i = 0; i < CHUNK_VOLUME; i++) used[chunk.data[i]!] = 1;
    used[0] = 1; // always keep air

    let usedCount = 0;
    for (let i = 0; i < oldLen; i++) if (used[i]) usedCount++;

    // nothing to drop, return copies so caller owns the buffers.
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
    cx: number;
    cy: number;
    cz: number;
    index: number;
    /** chunk-local palette index, what the network sends to clients. */
    data: number;
    /** world coords, saves recomputing per delta for hook dispatch. */
    wx: number;
    wy: number;
    wz: number;
    /** global state id before this op. */
    oldStateId: number;
    /** global state id after this op. */
    newStateId: number;
};
export type VoxelDeleteOp = { kind: 2; cx: number; cy: number; cz: number };

export type VoxelOp = VoxelBlockOp | VoxelDeleteOp;

/**
 * per-tick accumulator of authoritative voxel mutations, grouped by the
 * consumer that drains each part:
 *   - `ops`         → block-hooks (settle, inline per write) + discovery (network)
 *   - `addedChunks` → discovery (streaming)
 *   - `light`       → flushPendingLight (relight)
 */
export type VoxelChanges = {
    /** append-only log of block ops this tick. block-hooks settles each op's
     *  hooks inline as it's written; discovery ships the log to clients. */
    ops: VoxelOp[];
    /** chunks created this tick, for streaming. drained by discovery, which
     *  rewinds each player's cursor so newly-existing chunks get streamed
     *  without re-walking the whole view sphere. holds the Chunk ref so
     *  consumers don't have to re-lookup. */
    addedChunks: Set<Chunk>;
    /** light-recompute work queued this tick, drained by flushPendingLight. */
    light: {
        /** blocks changed by DEFAULT writes → per-block incremental relight. */
        blocks: Array<{ wx: number; wy: number; wz: number; oldStateId: number }>;
        /** chunks changed by BULK writes / invalidateChunk → scoped whole-chunk
         *  relight (relightChunks) instead of the per-block path. */
        chunks: Set<Chunk>;
        /** new chunks needing sky light seeded before incremental updates run. */
        newChunks: Chunk[];
        /** monotonically increasing; bumped by propagateAllLight (a full
         *  recompute), so clients discard buffered incremental ops. NOT
         *  per-tick — it outlives a tick. */
        epoch: number;
    };
};

export function createVoxelChanges(): VoxelChanges {
    return {
        ops: [],
        addedChunks: new Set(),
        light: { blocks: [], chunks: new Set(), newChunks: [], epoch: 0 },
    };
}

/**
 * clear the network per-tick state after end-of-tick dispatch. the `light`
 * queues are cleared by their own consumer (flushPendingLight, which runs
 * earlier in the tick); `light.epoch` is monotonic and never cleared.
 */
export function clearVoxelChanges(changes: VoxelChanges): void {
    changes.ops.length = 0;
    changes.addedChunks.clear();
}

/**
 * flood-fill light-propagation config. when `enabled` is false,
 * `flushPendingLight` is short-circuited and `setBlock` / `ensureChunk`
 * write a flat seed value instead of queueing for BFS. `minLevel` is the
 * sky-channel seed for inline writes, `15` keeps the world fully lit,
 * `0` is pitch black except where blocks emit their own light.
 *
 * lives inside `VoxelsAuthority`, only meaningful when this Voxels owns
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
 * these just like the server does, no type split, no env probe.
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
    observers: Map<number, BlockObserverEntry> | null;
    /** flood-fill light-propagation config. see type doc. */
    floodFillLighting: FloodFillLightingState;
    /** current block-hook recursion depth. a hook that issues a chained setBlock
     *  recurses through runBlockHooks; this bounds a runaway cascade. */
    hookDepth: number;
};

export function createVoxelsAuthority(): VoxelsAuthority {
    return {
        changes: createVoxelChanges(),
        observers: null,
        floodFillLighting: { enabled: true, minLevel: 15 },
        hookDepth: 0,
    };
}

/** clear per-tick state inside the authority bundle. observer registry
 *  and lighting config are NOT cleared, they outlive a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void {
    clearVoxelChanges(authority.changes);
}

export type Voxels = {
    chunks: Map<string, Chunk>;
    /** dirty index, sidecar to chunk.dirty / chunk.lightDirty flags.
     *
     *  `blocks` is the renderer tier, populated by `markChunkDirty` and
     *  (post Stage 2b) also by `markChunkLightDirty` since meshChunk emits
     *  geometry+light in one pass. consumed by voxel-visuals.update().
     *
     *  `light` is the server network tier, populated by
     *  `markChunkLightDirty` only. consumed by discovery's per-client
     *  chunk_light streaming. kept separate from `blocks` so the server
     *  doesn't have to filter a growing `blocks` set every tick to find
     *  light-only changes. */
    dirty: { blocks: Set<Chunk>; light: Set<Chunk> };
    /** xz-column index, chunks at the same (cx, cz) sorted by cy descending.
     *  maintained by `ensureChunk` and rebuilt by `loadVoxels`. lets
     *  sky-light / heightmap / surface code walk only chunks that actually
     *  exist, instead of scanning a world bbox. */
    columns: Map<string, Chunk[]>;
    /** block registry, flat lookup tables for block type/state info.
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
 *  client renderer remeshes, meshChunk emits geometry+light in one pass)
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
                authority.changes.light.newChunks.push(chunk);
            } else {
                const sky = authority.floodFillLighting.minLevel & 0xf;
                chunk.light.fill(sky << 12);
                // no markChunkLightDirty here, initial light ships with
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
        if (chunk.nonAirCount === 0) continue;
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
 * every write settles its block-def hooks (onNeighbourUpdate/onNeighbourChanged)
 * inline before returning, so a place-then-read sees settled state. `flags`
 * only controls script observers: `DEFAULT` fires them, `BULK` (worldgen, paste,
 * editor brush) does not. chained setBlocks from inside a hook are guarded
 * against re-entry, see block-hooks.runBlockHooks.
 */
export function setBlock(
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    key: string,
    flags: number = SetBlockFlags.DEFAULT,
): void {
    // thin convenience wrapper: resolve world coords → chunk, then delegate the
    // whole write (palette, counts, dirty, op, light, hooks) to setChunkBlock.
    const chunk = ensureChunk(voxels, toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz));
    setChunkBlock(voxels, chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz), key, flags);
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

/** deep-copy a single chunk. neighbors are NOT copied, caller wires those. */
function cloneChunk(src: Chunk): Chunk {
    return {
        cx: src.cx,
        cy: src.cy,
        cz: src.cz,
        wx: src.wx,
        wy: src.wy,
        wz: src.wz,
        nonAirCount: src.nonAirCount,
        solidCount: src.solidCount,
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
        neighbors: newNeighbors(),
        knownNeighbourCount: 0,
    };
}

/**
 * deep-copy a Voxels instance into a fresh one. the new instance owns its
 * chunk data, mutations don't affect the source. registry is shared by
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
 * copy all non-air blocks from `src` into `out`. preserves source coords,
 * blocks land at the same world positions in `out`. existing blocks in
 * `out` at those positions are overwritten; blocks at positions not
 * present in the source are left alone.
 */
export function copyVoxels(out: Voxels, src: Voxels): void {
    for (const chunk of src.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        // resolve the destination chunk once per source chunk (source coords are
        // preserved), then fill via setChunkBlock — skips the per-cell chunk-key
        // lookup. BULK: bulk copy is a transport primitive, not a place-action;
        // light settles as a scoped relight when the destination is drained.
        const dest = ensureChunk(out, chunk.cx, chunk.cy, chunk.cz);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                    const key = chunk.paletteKeys[paletteIdx];
                    if (!key || key === BLOCK_AIR) continue;
                    setChunkBlock(out, dest, lx, ly, lz, key, SetBlockFlags.BULK);
                }
            }
        }
    }
}
