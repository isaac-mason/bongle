import type { Vec3 } from 'math';
import { SetBlockFlags } from './block-flags';
import type { BlockObserverEntry } from './block-hooks';
import { runBlockEvents, runBlockHooks } from './block-hooks';
import type { Blocks } from './block-registry';
import { AIR, MISSING, resolveKey } from './block-registry';
import { CullType } from './blocks';

export const CHUNK_BITS = 4;
export const CHUNK_SIZE = 1 << CHUNK_BITS; // 16
export const CHUNK_SIZE_SQ = CHUNK_SIZE * CHUNK_SIZE; // 256
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096

// region = the AOI/streaming unit, a cube of REGION_CHUNKS_PER_AXIS^3 chunks, decoupled from CHUNK_SIZE so discovery/eviction/entity-presence can walk regions and scale per-tick cost to a smaller sphere.
export const REGION_CHUNK_SHIFT = 2; // log2(chunks per region axis) = log2(4)
export const REGION_CHUNKS_PER_AXIS = 1 << REGION_CHUNK_SHIFT; // 4
export const REGION_BITS = CHUNK_BITS + REGION_CHUNK_SHIFT; // 6
export const REGION_SIZE = 1 << REGION_BITS; // 64 (blocks/axis)

export const REGION_VOLUME = REGION_CHUNKS_PER_AXIS ** 3; // chunk slots in one region cube; length of a voxel_region_full `occupied` tuple

// every local (dx,dy,dz) chunk offset inside one region cube, in a fixed raster order; a voxel_region_full message's `occupied`/`chunks` positions are implicit indices into this same order.
export const REGION_LOCAL_CHUNK_OFFSETS: [number, number, number][] = (() => {
    const offsets: [number, number, number][] = [];
    for (let lz = 0; lz < REGION_CHUNKS_PER_AXIS; lz++)
        for (let ly = 0; ly < REGION_CHUNKS_PER_AXIS; ly++)
            for (let lx = 0; lx < REGION_CHUNKS_PER_AXIS; lx++) offsets.push([lx, ly, lz]);
    return offsets;
})();

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

/** chunk xz-column key, groups chunks sharing (cx, cz) so callers can walk a column top-down without scanning the world bbox. */
export function chunkColumnKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
}

/** region coordinate key, same string convention as chunkKey, one level coarser. */
export function regionKey(rx: number, ry: number, rz: number): string {
    return `${rx},${ry},${rz}`;
}

/** block coordinate -> chunk coordinate; caller floors first, since this truncates toward zero. */
export function toChunkCoord(worldCoord: number): number {
    return worldCoord >> CHUNK_BITS;
}

/** chunk coordinate -> region coordinate (floored division by REGION_CHUNKS_PER_AXIS). */
export function chunkToRegionCoord(chunkCoord: number): number {
    return chunkCoord >> REGION_CHUNK_SHIFT;
}

/** world position -> region coordinate directly, without the intermediate chunk coordinate; caller floors first. */
export function toRegionCoord(worldCoord: number): number {
    return worldCoord >> REGION_BITS;
}

/** world position -> local coordinate within chunk. */
export function toLocalCoord(worldCoord: number): number {
    return worldCoord & (CHUNK_SIZE - 1);
}

/** world position (any axis) -> block index on that axis; block N occupies world [N, N+1), so this is a floor. */
export function worldToBlockCoord(worldCoord: number): number {
    return Math.floor(worldCoord);
}

/** world-space point at the center of a block's top face, i.e. where feet land standing on top of `block`. */
export function blockTopCenter(out: Vec3, block: Vec3): Vec3 {
    out[0] = block[0] + 0.5;
    out[1] = block[1] + 1;
    out[2] = block[2] + 0.5;
    return out;
}

export type Chunk = {
    cx: number;
    cy: number;
    cz: number;

    wx: number; // world coordinates of chunk corner (cx*16, cy*16, cz*16), cached for meshing
    wy: number;
    wz: number;

    nonAirCount: number;
    solidCount: number; // fully-occluding (CullType.SOLID) blocks, always <= nonAirCount; === CHUNK_VOLUME means fully opaque

    // stable string keys per palette slot; paletteKeys[0] is always "air", the persistence/network identity, survives registry rebuilds; append-only across a session or shrinking/reordering would silently re-alias set voxels.
    paletteKeys: string[];

    palette: number[]; // runtime numeric ids per palette slot (resolved from registry); rebuilt from paletteKeys on registry change
    paletteMap: Map<string, number>; // reverse lookup: string key -> local palette index, kept in sync with paletteKeys
    data: Uint16Array; // packed voxel data, one local palette index (not a global state id) per entry, length CHUNK_VOLUME

    // per-voxel light, length CHUNK_VOLUME; each entry packs 4 channels into 16 bits: 15..12 sky, 11..8 red, 7..4 green, 3..0 blue.
    light: Uint16Array;

    dirty: boolean; // set when data changes, cleared by mesher

    // monotonically increasing version of this chunk's mesh-relevant state, bumped by every mutation that would change the mesh output; the worker dispatcher echoes it back so voxel-visuals can detect a stale result. starts at 1.
    meshGen: number;

    // monotonically increasing version of this chunk's persisted data (blocks, light, palette), bumped by every mutation that changes the bytes saveVoxels would write, but NOT by mesh-only changes. starts at 1.
    version: number;

    lightDirty: boolean; // set when light[] changes, cleared after network flush

    // per-voxel dirty mask for incremental light deltas, byte-per-voxel, length CHUNK_VOLUME, server-only. idle chunks alias the shared EMPTY_LIGHT_MASK singleton; setLight COWs on first write.
    lightDirtyMask: Uint8Array;
    lightDirtyCount: number; // set bytes in lightDirtyMask, a cheap threshold check without scanning the mask

    compressedSnapshot: Uint8Array | null; // cached compressed snapshot for chunk_full encoding; invalidated on data/light change
    snapshotPalette: number[] | null; // cached per-slot global state ids at snapshot time (the wire palette for voxel_chunk_full)
    compressedLight: { sky: Uint8Array; rgb: Uint8Array } | null; // cached compressed light streams for chunk_light encoding

    // neighbor chunk refs for cross-chunk traversal, 26 slots (the mesher's 3x3x3 apron): slots 0-5 are the 6 faces in light.ts's direction convention, slots 6-25 are the 12 edges + 8 corners. null if that neighbor isn't loaded.
    neighbors: (Chunk | null)[];
    knownNeighbourCount: number; // non-null entries in `neighbors` (0-26); streaming defers meshing until the full apron is present
    lightWaitSince: number; // frame the light volume first wanted to re-bake this chunk while its neighbourhood was incomplete, or -1
    lightWanted: boolean; // the AOI wants this chunk rendered, so it may hold a light tile
    lightUrgent: boolean; // this chunk's own light changed (vs apron-dirtied by a neighbour); urgent rebakes are never deferred
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
        lightWaitSince: -1,
        lightWanted: false,
        lightUrgent: false,
    };
}

/** fresh 26-slot neighbor array, all null. */
export function newNeighbors(): (Chunk | null)[] {
    return new Array<Chunk | null>(NEIGHBOR_COUNT).fill(null);
}

// shared all-AIR data + light arrays used by empty-chunk stubs; any writer touching chunk.data/chunk.light must compare identity against these and clone (copy-on-write) before mutating. EMPTY_LIGHT is pre-filled with sky=15 (0xF000) so entities sampling light inside a networked-empty chunk see full sky instead of pitch black.
export const EMPTY_DATA = new Uint16Array(CHUNK_VOLUME);
export const EMPTY_LIGHT = new Uint16Array(CHUNK_VOLUME).fill(0xf000);

// shared all-zero lightDirtyMask alias for chunks with no in-flight delta changes; setLight COWs on first write.
export const EMPTY_LIGHT_MASK = new Uint8Array(CHUNK_VOLUME);

/** Create a Chunk stub for a chunk the server confirmed is empty; `data`/`light` alias module-level singletons to stay cheap. */
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
        lightWaitSince: -1,
        lightWanted: false,
        lightUrgent: false,
    };
}

// 26-slot neighbourhood (the mesher's 3x3x3 apron): slots 0-5 are the 6 faces in light.ts's direction convention (opposites sum to 5), slots 6-25 are the 12 edges + 8 corners. NEIGHBOR_OPPOSITE[i] is the slot pointing back.
const { NEIGHBOR_DX, NEIGHBOR_DY, NEIGHBOR_DZ, NEIGHBOR_OPPOSITE, NEIGHBOR_SLOT_OF } = /* @__PURE__ */ (() => {
    // faces first, in the light.ts order, then every edge/corner (manhattan >= 2).
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
    // inverse: 3x3x3 offset (packed (dz+1)*9+(dy+1)*3+(dx+1)) -> slot, -1 for the centre.
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

/** number of neighbour slots on `Chunk.neighbors` (full 3x3x3 minus self). */
export const NEIGHBOR_COUNT = NEIGHBOR_DX.length;

/** slot index in `neighbors[]` for the neighbour at chunk-offset (dx,dy,dz), each in [-1,1]; -1 for (0,0,0) / out of range. */
export function neighbourSlot(dx: number, dy: number, dz: number): number {
    return NEIGHBOR_SLOT_OF[(dz + 1) * 9 + (dy + 1) * 3 + (dx + 1)]!;
}

/** wire up bidirectional neighbor refs for a chunk just added to voxels.chunks, bumping `knownNeighbourCount` on both sides. */
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

/** null out neighbor refs when a chunk is about to be removed from voxels.chunks, decrementing each surviving neighbour's count. */
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

/** Insert (or update in place) a chunk from already-decoded parts, for the mesh worker's mirror loading a packet. */
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

/** Remove a chunk from `voxels.chunks`, unlinking the neighbour graph and its `voxels.regions` entry (`columns` has no removal path, left alone). */
export function removeChunk(voxels: Voxels, cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    const chunk = voxels.chunks.get(key);
    if (chunk) {
        unlinkChunkNeighbors(chunk);
        voxels.chunks.delete(key);
        removeChunkFromRegion(voxels, chunk);
    }
}

/** get the global state id at a local position within a chunk, the mesher's fast path; no bounds checking. */
export function getChunkBlock(chunk: Chunk, x: number, y: number, z: number): number {
    return chunk.palette[chunk.data[voxelIndex(x, y, z)]!]!;
}

/** get the string key at a local position within a chunk, for persistence/inspection/debugging; not hot-path. */
export function getChunkBlockKey(chunk: Chunk, x: number, y: number, z: number): string {
    return chunk.paletteKeys[chunk.data[voxelIndex(x, y, z)]!]!;
}

/** get-or-allocate the chunk-local palette index for a block key. */
export function ensureChunkPaletteSlot(chunk: Chunk, key: string, registry: Blocks): number {
    let slot = chunk.paletteMap.get(key);
    if (slot === undefined) {
        slot = chunk.paletteKeys.length;
        chunk.paletteKeys.push(key);
        chunk.palette.push(resolveKey(registry, key));
        chunk.paletteMap.set(key, slot);
    }
    return slot;
}

/** the chunk's writable voxel-data array, COWing out of the shared EMPTY_DATA stub first so a direct write can't corrupt it. */
export function chunkData(chunk: Chunk): Uint16Array {
    if (chunk.data === EMPTY_DATA) chunk.data = new Uint16Array(EMPTY_DATA);
    return chunk.data;
}

/** Writable light for a chunk, copy-on-write off `EMPTY_LIGHT` (every empty stub aliases that one buffer). */
export function chunkLight(chunk: Chunk): Uint16Array {
    if (chunk.light === EMPTY_LIGHT) chunk.light = new Uint16Array(EMPTY_LIGHT);
    return chunk.light;
}

/** true when swapping `oldStateId` for `newStateId` can change light (emission or opacity differs). */
function hasDifferentLightProperties(registry: Blocks, oldStateId: number, newStateId: number): boolean {
    if (oldStateId === newStateId) return false;
    return (
        registry.lightEmission[oldStateId] !== registry.lightEmission[newStateId] ||
        registry.lightOpacity[oldStateId] !== registry.lightOpacity[newStateId]
    );
}

/** Set a block at a chunk-local position: writes the cell, maintains counts/mesh gen, routes lighting; op/hook recording is authority-side. */
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

    const wasAir = oldStateId === AIR || oldStateId === MISSING;
    const isAir = newStateId === AIR || newStateId === MISSING;
    if (wasAir && !isAir) chunk.nonAirCount++;
    else if (!wasAir && isAir) chunk.nonAirCount--;

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

    // light is derived from the blocks this Voxels holds, so it schedules on mirrors too (server-driven changes never reach here).
    const lighting = voxels.lighting;
    if (!lighting.floodFill.enabled) {
        // flood-fill disabled: inline sky-seed + block emission, no propagation, must not queue a relight.
        const emission = registry.lightEmission[newStateId] ?? 0;
        const sky = lighting.floodFill.minLevel & 0xf;
        setLight(chunk, idx, (sky << 12) | (emission & 0xfff));
        markChunkLightDirty(voxels, chunk);
    } else if (flags === SetBlockFlags.BULK) {
        lighting.chunks.add(chunk); // whole-chunk relight at tick end
    } else if (hasDifferentLightProperties(registry, oldStateId, newStateId)) {
        lighting.blocks.push({ wx: chunk.wx + x, wy: chunk.wy + y, wz: chunk.wz + z, oldStateId });
    }

    const auth = voxels.authority;
    if (!auth) return;

    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;

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

    // BLOCK_HOOKS -> block-def recompute (fences join, chains recurse); BLOCK_EVENTS -> script observers, after the recompute.
    const wwx = chunk.wx + x;
    const wwy = chunk.wy + y;
    const wwz = chunk.wz + z;
    if (flags & SetBlockFlags.BLOCK_HOOKS) runBlockHooks(voxels, wwx, wwy, wwz);
    if (flags & SetBlockFlags.BLOCK_EVENTS) runBlockEvents(voxels, wwx, wwy, wwz, oldStateId, newStateId);
}

/** Reconcile a chunk after tier-1 raw writes into `chunkData(chunk)`: rescans counts, marks mesh-dirty, schedules light. No ops, no hooks. */
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

    const lighting = voxels.lighting;
    if (lighting.floodFill.enabled) {
        lighting.chunks.add(chunk);
    } else {
        // flood-fill disabled: the raw writes bypassed inline seeding, so flat-seed the chunk here.
        const skyPacked = (lighting.floodFill.minLevel & 0xf) << 12;
        chunkLight(chunk).fill(skyPacked);
        const emissionTable = registry.lightEmission;
        for (let i = 0; i < data.length; i++) {
            const emission = emissionTable[palette[data[i]!]!] ?? 0;
            if (emission > 0) setLight(chunk, i, skyPacked | (emission & 0xfff));
        }
        markChunkLightDirty(voxels, chunk);
    }

    if (!voxels.authority) return; // snapshot caches only ever populate on an authority
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
}

/** Write a packed light value at a chunk-local voxel index, marking the per-chunk dirty mask; callers must still call markChunkLightDirty. */
export function setLight(chunk: Chunk, index: number, value: number): void {
    chunkLight(chunk)[index] = value;
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

/** Re-resolve all palette keys against a new registry (unresolved keys become MISSING); call on hot reload. */
export function resolveChunk(chunk: Chunk, registry: Blocks): void {
    let nonAirCount = 0;
    let solidCount = 0;
    for (let i = 0; i < chunk.paletteKeys.length; i++) {
        const key = chunk.paletteKeys[i]!;
        const globalId = resolveKey(registry, key);
        chunk.palette[i] = globalId;
    }
    // cull can change on a registry rebuild, so both counts are recomputed from scratch here.
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

/** Compute a compacted snapshot of a chunk's palette + data without mutating the chunk (the save path; the live chunk keeps its append-only palette). */
export function repackChunkSnapshot(chunk: Chunk): { paletteKeys: string[]; data: Uint16Array } {
    const oldLen = chunk.paletteKeys.length;
    if (oldLen <= 1) {
        return { paletteKeys: chunk.paletteKeys.slice(), data: new Uint16Array(chunk.data) };
    }

    const used = new Uint8Array(oldLen);
    for (let i = 0; i < CHUNK_VOLUME; i++) used[chunk.data[i]!] = 1;
    used[0] = 1; // always keep air

    let usedCount = 0;
    for (let i = 0; i < oldLen; i++) if (used[i]) usedCount++;

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
    data: number; // chunk-local palette index, what the network sends to clients
    wx: number; // world coords, saves recomputing per delta for hook dispatch
    wy: number;
    wz: number;
    oldStateId: number; // global state id before this op
    newStateId: number; // global state id after this op
};
export type VoxelDeleteOp = { kind: 2; cx: number; cy: number; cz: number };

export type VoxelOp = VoxelBlockOp | VoxelDeleteOp;

/** Per-tick accumulator of authoritative voxel mutations; light-recompute work lives separately in `Voxels.lighting`. */
export type VoxelChanges = {
    ops: VoxelOp[]; // append-only log of block ops this tick; block-hooks settles hooks inline, discovery ships the log
    addedChunks: Set<Chunk>; // chunks created this tick; discovery rewinds each player's cursor to stream them without a full re-walk
};

export function createVoxelChanges(): VoxelChanges {
    return {
        ops: [],
        addedChunks: new Set(),
    };
}

export function clearVoxelChanges(changes: VoxelChanges): void {
    changes.ops.length = 0;
    changes.addedChunks.clear();
}

// flood-fill light-propagation config; when `enabled` is false, writes use a flat seed instead of queueing for BFS. `minLevel` is the sky-channel seed for inline writes. must agree between server and client: not replicated.
export type FloodFillLightingState = {
    enabled: boolean;
    minLevel: number; // 15 = fully lit, 0 = pitch black except emitters
};

// light-recompute scheduling + config, present on every Voxels including read-only mirrors, so a networked client can propagate light locally for blocks it writes itself instead of waiting on the server's baked light.
export type VoxelsLighting = {
    floodFill: FloodFillLightingState;
    blocks: Array<{ wx: number; wy: number; wz: number; oldStateId: number }>; // DEFAULT writes -> per-block incremental relight
    chunks: Set<Chunk>; // BULK writes / invalidateChunk -> scoped whole-chunk relight
    newChunks: Chunk[]; // new chunks needing sky light seeded before incremental updates run
    epoch: number; // bumped by propagateAllLight (a full recompute) so clients discard buffered incremental ops; outlives a tick
};

export function createVoxelsLighting(): VoxelsLighting {
    return {
        floodFill: { enabled: true, minLevel: 15 },
        blocks: [],
        chunks: new Set(),
        newChunks: [],
        epoch: 0,
    };
}

/** Authoritative-emission bundle, populated when this Voxels owns the truth; null on a read-only mirror (today's clients). */
export type VoxelsAuthority = {
    changes: VoxelChanges; // per-tick change log for block ops, light updates, and new chunks
    observers: Map<number, BlockObserverEntry> | null; // per-room onBuild/onBreak/onStateChange registry, keyed by block-type index; lazy-init
    hookDepth: number; // current block-hook recursion depth, bounds a runaway chained-setBlock cascade
};

export function createVoxelsAuthority(): VoxelsAuthority {
    return {
        changes: createVoxelChanges(),
        observers: null,
        hookDepth: 0,
    };
}

/** clear per-tick state inside the authority bundle; the observer registry is NOT cleared, it outlives a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void {
    clearVoxelChanges(authority.changes);
}

export type Voxels = {
    chunks: Map<string, Chunk>;

    // dirty index, sidecar to chunk.dirty/chunk.lightDirty flags. `blocks` is the renderer tier, consumed by voxel-visuals.update(). `light` is the server network tier, consumed by discovery's chunk_light streaming (kept separate so the server doesn't filter a growing `blocks` set). `removed` is dropped chunk keys.
    dirty: {
        blocks: Set<Chunk>;
        light: Set<Chunk>;
        lightVolume: Set<Chunk>;
        lightVolumeUrgent: Set<Chunk>;
        removed: Set<string>;
    };

    columns: Map<string, Chunk[]>; // xz-column index, chunks at (cx, cz) sorted by cy descending; lets sky-light/heightmap code walk without scanning the world bbox
    regions: Map<string, Set<Chunk>>; // AOI region occupancy index; an emptied region's entry is deleted so churn doesn't leave stale Sets behind
    registry: Blocks; // block registry, flat lookup tables; hot reload reassigns this field and calls resolveAllChunks() per room
    authority: VoxelsAuthority | null;
    lighting: VoxelsLighting;
};

export function createVoxels(registry: Blocks): Voxels {
    return {
        chunks: new Map(),
        dirty: { blocks: new Set(), light: new Set(), lightVolume: new Set(), lightVolumeUrgent: new Set(), removed: new Set() },
        columns: new Map(),
        regions: new Map(),
        registry,
        authority: null,
        lighting: createVoxelsLighting(),
    };
}

/** mark `chunk` as needing a remesh, so the renderer's per-frame scan can iterate `voxels.dirty.blocks` instead of the whole Map. */
export function markChunkDirty(voxels: Voxels, chunk: Chunk): void {
    chunk.dirty = true;
    voxels.dirty.blocks.add(chunk);
}

/** queue `chunk` for a light-volume rebake at bulk priority (nearest-first, may defer for an incomplete neighbourhood); use for streaming/whole-world relights. */
export function markLightVolumeDirty(voxels: Voxels, chunk: Chunk): void {
    voxels.dirty.lightVolume.add(chunk);
}

/** queue `chunk` at urgent priority (skips the neighbourhood deferral); reserve for edits, since marking a bulk relight urgent would starve the nearest-first order. */
export function markLightVolumeUrgent(voxels: Voxels, chunk: Chunk): void {
    chunk.lightUrgent = true;
    voxels.dirty.lightVolumeUrgent.add(chunk);
    voxels.dirty.lightVolume.add(chunk);
}

/** Queue the rebake implied by one cell of `chunk` changing. Just the chunk: no other tile holds a copy of that cell. */
export function markLightVolumeDirtyForCell(voxels: Voxels, chunk: Chunk, index: number): void {
    void index;
    markLightVolumeUrgent(voxels, chunk);
}

/** mark `chunk` as needing a relight (dirty.light + light volume), deliberately not dirty.blocks since a light-only change never alters the mesh. */
export function markChunkLightDirty(voxels: Voxels, chunk: Chunk): void {
    chunk.lightDirty = true;
    voxels.dirty.light.add(chunk);
    markLightVolumeDirty(voxels, chunk);
}

/** insert `chunk` into its xz-column array, keeping the array sorted by cy descending; duplicate cy is a no-op. */
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

/** add `chunk` to its region's occupancy set, creating the set if this is the region's first known chunk. */
function addChunkToRegion(voxels: Voxels, chunk: Chunk): void {
    const key = regionKey(chunkToRegionCoord(chunk.cx), chunkToRegionCoord(chunk.cy), chunkToRegionCoord(chunk.cz));
    let region = voxels.regions.get(key);
    if (!region) {
        region = new Set();
        voxels.regions.set(key, region);
    }
    region.add(chunk);
}

/** remove `chunk` from its region's occupancy set, deleting the region entry entirely once empty. */
function removeChunkFromRegion(voxels: Voxels, chunk: Chunk): void {
    const key = regionKey(chunkToRegionCoord(chunk.cx), chunkToRegionCoord(chunk.cy), chunkToRegionCoord(chunk.cz));
    const region = voxels.regions.get(key);
    if (!region) return;
    region.delete(chunk);
    if (region.size === 0) voxels.regions.delete(key);
}

/** rebuild `voxels.columns` and `voxels.regions` from `voxels.chunks`; used by deserialize and as a defensive reconcile when callers bypass `ensureChunk`. */
export function rebuildSpatialIndexes(voxels: Voxels): void {
    voxels.columns.clear();
    voxels.regions.clear();
    for (const chunk of voxels.chunks.values()) {
        addChunkToColumn(voxels, chunk);
        addChunkToRegion(voxels, chunk);
    }
}

/** get the loaded chunk at the given chunk coordinates, or undefined. */
export function getChunk(voxels: Voxels, cx: number, cy: number, cz: number): Chunk | undefined {
    return voxels.chunks.get(chunkKey(cx, cy, cz));
}

/** get the loaded chunk containing a block coordinate, or undefined; block coordinates, not chunk ones. */
export function getChunkAt(voxels: Voxels, wx: number, wy: number, wz: number): Chunk | undefined {
    return getChunk(voxels, toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz));
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
        addChunkToRegion(voxels, chunk);
        linkChunkNeighbors(voxels, chunk);

        // queue for sky light seeding before any block changes; flood-fill disabled fills inline with a flat seed instead.
        const lighting = voxels.lighting;
        if (lighting.floodFill.enabled) {
            lighting.newChunks.push(chunk);
        } else {
            const sky = lighting.floodFill.minLevel & 0xf;
            chunkLight(chunk).fill(sky << 12);
            // no markChunkLightDirty: the bulk fill bypasses setLight, so the mask stays empty.
        }

        voxels.authority?.changes.addedChunks.add(chunk);
    }
    return chunk;
}

/** get the string key at a world position. returns "air" if chunk doesn't exist. */
export function getBlock(voxels: Voxels, wx: number, wy: number, wz: number): string {
    const chunk = getChunkAt(voxels, wx, wy, wz);
    if (!chunk) return BLOCK_AIR;
    return getChunkBlockKey(chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
}

/** get the global state id at a world position. returns AIR if chunk doesn't exist. */
export function getBlockState(voxels: Voxels, wx: number, wy: number, wz: number): number {
    const chunk = getChunkAt(voxels, wx, wy, wz);
    if (!chunk) return AIR;
    return getChunkBlock(chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
}

export function getBlockStateRelative(voxels: Voxels, chunk: Chunk, lx: number, ly: number, lz: number): number {
    // out-of-bounds local coords delegate to getBlock to find the correct chunk.
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

/** Mark the chunks bordering an edit dirty (0 for interior, 1 on a face, 3 on an edge, 7 on a corner) so AO/smooth lighting don't stay stale. */
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
                const n = getChunk(voxels, cx + ox, cy + oy, cz + oz);
                if (n) {
                    n.meshGen++;
                    markChunkDirty(voxels, n);
                }
            }
        }
    }
}

/** Set a block at a world position, creating the chunk if needed; `flags` controls script observers (`DEFAULT` fires them, `BULK` does not). */
export function setBlock(
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    key: string,
    flags: number = SetBlockFlags.DEFAULT,
): void {
    const chunk = ensureChunk(voxels, toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz));
    setChunkBlock(voxels, chunk, toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz), key, flags);
}

/** re-resolve all chunks against the current registry; call on hot reload when the registry rebuilds. */
export function resolveAllChunks(voxels: Voxels): void {
    for (const chunk of voxels.chunks.values()) {
        resolveChunk(chunk, voxels.registry);
        voxels.dirty.blocks.add(chunk); // resolveChunk sets dirty=true; mirror into the renderer index
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
        lightWaitSince: -1,
        lightWanted: false,
        lightUrgent: false,
    };
}

/** Deep-copy a Voxels instance into a fresh one whose chunk data mutations won't affect the source; registry is shared by reference. */
export function cloneVoxels(src: Voxels): Voxels {
    const out = createVoxels(src.registry);
    for (const [key, chunk] of src.chunks) {
        const cloned = cloneChunk(chunk);
        out.chunks.set(key, cloned);
        if (cloned.dirty) out.dirty.blocks.add(cloned);
        if (cloned.lightDirty) {
            out.dirty.blocks.add(cloned);
            out.dirty.light.add(cloned);
            out.dirty.lightVolume.add(cloned);
        }
        linkChunkNeighbors(out, cloned);
    }
    return out;
}

/** Copy all non-air blocks from `src` into `out` at the same world positions; existing blocks in `out` elsewhere are left alone. */
export function copyVoxels(out: Voxels, src: Voxels): void {
    for (const chunk of src.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        // BULK: bulk copy is a transport primitive, not a place-action.
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
