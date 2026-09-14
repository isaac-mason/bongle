import type { Vec4 } from 'math';
import type { Blocks } from './block-registry';
import {
    CHUNK_SIZE,
    type Chunk,
    chunkLight,
    EMPTY_LIGHT_MASK,
    getChunkAt,
    markLightVolumeDirty,
    markLightVolumeDirtyForCell,
    markLightVolumeUrgent,
    rebuildSpatialIndexes,
    setLight,
    toLocalCoord,
    type Voxels,
    voxelIndex,
} from './voxels';

export function packLight(sky: number, r: number, g: number, b: number): number {
    return (sky << 12) | (r << 8) | (g << 4) | b;
}

export function getSky(packed: number): number {
    return (packed >> 12) & 0xf;
}

export function getRed(packed: number): number {
    return (packed >> 8) & 0xf;
}

export function getGreen(packed: number): number {
    return (packed >> 4) & 0xf;
}

export function getBlue(packed: number): number {
    return packed & 0xf;
}

export function setSky(packed: number, val: number): number {
    return (packed & 0x0fff) | (val << 12);
}

export function setRed(packed: number, val: number): number {
    return (packed & 0xf0ff) | (val << 8);
}

export function setGreen(packed: number, val: number): number {
    return (packed & 0xff0f) | (val << 4);
}

export function setBlue(packed: number, val: number): number {
    return (packed & 0xfff0) | val;
}

// CullType encoding: NONE=0, SOLID=1, SELF=2, PARTIAL=3
const DEFAULT_OPACITY_BY_CULL: readonly number[] = [
    0, // NONE (air), fully transparent
    15, // SOLID, fully opaque
    1, // SELF (leaves, water, glass), slight filtering
    0, // PARTIAL (stairs/slopes), transparent to light
];

export function defaultLightOpacity(encodedCull: number): number {
    return DEFAULT_OPACITY_BY_CULL[encodedCull] ?? 15;
}

// light emission stored as 0RGB in a uint16 (no sky channel), same bit layout as the light value's lower 12 bits.
export function packEmission(r: number, g: number, b: number): number {
    return (r << 8) | (g << 4) | b;
}

export function getEmissionR(packed: number): number {
    return (packed >> 8) & 0xf;
}

export function getEmissionG(packed: number): number {
    return (packed >> 4) & 0xf;
}

export function getEmissionB(packed: number): number {
    return packed & 0xf;
}

const INV_15 = 1 / 15;

function _readPackedLight(voxels: Voxels, vx: number, vy: number, vz: number): number {
    const chunk = getChunkAt(voxels, vx, vy, vz);
    if (!chunk) return 0xf000; // open sky, no block light
    const lx = toLocalCoord(vx);
    const ly = toLocalCoord(vy);
    const lz = toLocalCoord(vz);
    return chunk.light[voxelIndex(lx, ly, lz)]!;
}

/** trilinear-sample voxel light at a world position into `out` as [sky, r, g, b] normalized to [0,1], blending the 8 surrounding cell centers. */
export function sampleVoxelLight(voxels: Voxels, wx: number, wy: number, wz: number, out: Vec4): void {
    const fx = wx - 0.5;
    const fy = wy - 0.5;
    const fz = wz - 0.5;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const k0 = Math.floor(fz);
    const tx = fx - i0;
    const ty = fy - j0;
    const tz = fz - k0;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    const k1 = k0 + 1;

    const p000 = _readPackedLight(voxels, i0, j0, k0);
    const p100 = _readPackedLight(voxels, i1, j0, k0);
    const p010 = _readPackedLight(voxels, i0, j1, k0);
    const p110 = _readPackedLight(voxels, i1, j1, k0);
    const p001 = _readPackedLight(voxels, i0, j0, k1);
    const p101 = _readPackedLight(voxels, i1, j0, k1);
    const p011 = _readPackedLight(voxels, i0, j1, k1);
    const p111 = _readPackedLight(voxels, i1, j1, k1);

    const ix0 = 1 - tx;
    const iy0 = 1 - ty;
    const iz0 = 1 - tz;
    const w000 = ix0 * iy0 * iz0;
    const w100 = tx * iy0 * iz0;
    const w010 = ix0 * ty * iz0;
    const w110 = tx * ty * iz0;
    const w001 = ix0 * iy0 * tz;
    const w101 = tx * iy0 * tz;
    const w011 = ix0 * ty * tz;
    const w111 = tx * ty * tz;

    // unpack each channel from all 8 corners, weighted-sum, normalize by INV_15 once at the end.
    for (let ch = 0; ch < 4; ch++) {
        const shift = 12 - ch * 4;
        const sum =
            w000 * ((p000 >> shift) & 0xf) +
            w100 * ((p100 >> shift) & 0xf) +
            w010 * ((p010 >> shift) & 0xf) +
            w110 * ((p110 >> shift) & 0xf) +
            w001 * ((p001 >> shift) & 0xf) +
            w101 * ((p101 >> shift) & 0xf) +
            w011 * ((p011 >> shift) & 0xf) +
            w111 * ((p111 >> shift) & 0xf);
        out[ch] = sum * INV_15;
    }
}

// direction index: 0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X; opposite directions sum to 5, used to skip the back-direction in BFS.
const NEIGHBOR_DLX: readonly number[] = [1, 0, 0, 0, 0, -1];
const NEIGHBOR_DLY: readonly number[] = [0, 1, 0, 0, -1, 0];
const NEIGHBOR_DLZ: readonly number[] = [0, 0, 1, -1, 0, 0];

const DIR_UP = 1;
const DIR_DOWN = 4;

// no source direction (seed nodes)
const DIR_NONE = 6;

const CHUNK_MASK = CHUNK_SIZE - 1; // 0xf

// numeric channel ids give a single monomorphic get/set body, inlinable by v8; channel: 0=sky(shift12), 1=red(8), 2=green(4), 3=blue(0).
const CH_SKY = 0;
const CH_RED = 1;
const CH_GREEN = 2;
const CH_BLUE = 3;
const CHANNEL_SHIFT: readonly number[] = [12, 8, 4, 0];
const CHANNEL_MASK: readonly number[] = [0x0fff, 0xf0ff, 0xff0f, 0xfff0];

// emission shift: sky has no emission (always 0). rgb emission uses shifts 8/4/0.
const EMISSION_SHIFT: readonly number[] = [0, 8, 4, 0]; // index 0 unused (sky)

function chGet(packed: number, ch: number): number {
    return (packed >> CHANNEL_SHIFT[ch]!) & 0xf;
}

function chSet(packed: number, ch: number, val: number): number {
    return (packed & CHANNEL_MASK[ch]!) | (val << CHANNEL_SHIFT[ch]!);
}

function chGetEmission(emission: number, ch: number): number {
    if (ch === CH_SKY) return 0;
    return (emission >> EMISSION_SHIFT[ch]!) & 0xf;
}

// scratch variables for resolveNeighbor's result, avoids allocation.
let _nchunk: Chunk | null = null;
let _nindex = 0;

/** resolve neighbor in direction dir from (chunk, lx, ly, lz); result is in _nchunk/_nindex, _nchunk null if unloaded. */
function resolveNeighbor(chunk: Chunk, lx: number, ly: number, lz: number, dir: number): void {
    const nlx = lx + NEIGHBOR_DLX[dir]!;
    const nly = ly + NEIGHBOR_DLY[dir]!;
    const nlz = lz + NEIGHBOR_DLZ[dir]!;

    // fast path: all coords in bounds, same chunk
    if ((nlx | nly | nlz) >= 0 && nlx < CHUNK_SIZE && nly < CHUNK_SIZE && nlz < CHUNK_SIZE) {
        _nchunk = chunk;
        _nindex = voxelIndex(nlx, nly, nlz);
        return;
    }

    // crossed a chunk boundary, use neighbor ref
    _nchunk = chunk.neighbors[dir];
    if (_nchunk) {
        _nindex = voxelIndex(nlx & CHUNK_MASK, nly & CHUNK_MASK, nlz & CHUNK_MASK);
    }
}

/** write light to a chunk and invalidate cached snapshots; used by seeding code and by locally-predicted client edits so a predicted break's hole doesn't stay dark until the server's light delta arrives. */
function writeChunkLight(voxels: Voxels, chunk: Chunk, index: number, value: number): void {
    setLight(chunk, index, value);
    chunk.lightDirty = true;
    chunk.dirty = true;
    voxels.dirty.blocks.add(chunk);
    voxels.dirty.light.add(chunk);
    markLightVolumeDirtyForCell(voxels, chunk, index);
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
    chunk.compressedLight = null;
}

// two independent queues drained at different cadences; no remesh queue since quads carry geometry/AO and light is sampled from the volume.
function markChunkDirty(voxels: Voxels, chunk: Chunk): void {
    // must run before the lightDirty early-out below, or a rebake gets silently skipped when the server already drained and the renderer hadn't.
    markLightVolumeUrgent(voxels, chunk);

    // network-dispatch queue: discovery drains this per tick and resets lightDirty; idempotent while the flag is set.
    if (chunk.lightDirty) return;
    chunk.lightDirty = true;
    voxels.dirty.light.add(chunk);
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
    chunk.compressedLight = null;
}

// used by seeding code to resolve a world position to (chunk, index); the only map lookup, at seed time not in BFS.
function resolveWorldPos(voxels: Voxels, wx: number, wy: number, wz: number): Chunk | null {
    return getChunkAt(voxels, wx, wy, wz) ?? null;
}

// 16 buckets by light level, processed highest to lowest; packed[] stores index in low 12 bits and sourceDir in bits 12..14.
type BucketQueue = {
    chunks: (Chunk | null)[][];
    packed: number[][];
    highestNonEmpty: number;
};

function createBucketQueue(): BucketQueue {
    const chunks: (Chunk | null)[][] = new Array(16);
    const packed: number[][] = new Array(16);
    for (let i = 0; i < 16; i++) {
        chunks[i] = [];
        packed[i] = [];
    }
    return { chunks, packed, highestNonEmpty: -1 };
}

function bqPush(q: BucketQueue, level: number, chunk: Chunk, index: number, sourceDir: number): void {
    q.chunks[level]!.push(chunk);
    q.packed[level]!.push(index | (sourceDir << 12));
    if (level > q.highestNonEmpty) q.highestNonEmpty = level;
}

// scratch vars for bqPop result
let _popChunk: Chunk | null = null;
let _popIndex = 0;
let _popSourceDir = 0;
let _popLevel = 0;

/** pop highest-priority entry. returns true if an entry was popped (result in scratch vars). */
function bqPop(q: BucketQueue): boolean {
    while (q.highestNonEmpty >= 0) {
        const lvl = q.highestNonEmpty;
        const cArr = q.chunks[lvl]!;
        if (cArr.length > 0) {
            const tail = cArr.length - 1;
            _popChunk = cArr[tail]!;
            const p = q.packed[lvl]![tail]!;
            _popIndex = p & 0xfff;
            _popSourceDir = p >> 12;
            _popLevel = lvl;
            cArr.length = tail;
            q.packed[lvl]!.length = tail;
            return true;
        }
        q.highestNonEmpty--;
    }
    return false;
}

function bqClear(q: BucketQueue): void {
    for (let i = 0; i < 16; i++) {
        q.chunks[i]!.length = 0;
        q.packed[i]!.length = 0;
    }
    q.highestNonEmpty = -1;
}

const _removalQueue = createBucketQueue();
const _relightQueue = createBucketQueue();
const _spreadQueue = createBucketQueue();

/** channel-generic removal BFS: zeroes dimmer neighbors and re-seeds via the brightest border neighbor at (brightest - 1); sky columns are handled separately in updateLightBatch. */
function unspreadChannel(
    voxels: Voxels,
    registry: Blocks,
    ch: number,
    removalQueue: BucketQueue,
    relightQueue: BucketQueue,
): void {
    const { lightOpacity, lightEmission } = registry;
    // hoist shift/mask once per BFS since ch is fixed for the whole pop loop.
    const shift = CHANNEL_SHIFT[ch]!;
    const mask = CHANNEL_MASK[ch]!;

    while (bqPop(removalQueue)) {
        const chunk = _popChunk!;
        const index = _popIndex;
        const sourceDir = _popSourceDir;
        const oldLevel = _popLevel;

        // extract local coords from voxel index
        const lx = index & CHUNK_MASK;
        const lz = (index >> 4) & CHUNK_MASK;
        const ly = index >> 8;

        const nodeState = chunk.palette[chunk.data[index]!]!;
        const nodeEmission = chGetEmission(lightEmission[nodeState]!, ch);

        // start at emission+1 so brightest-1 yields emission for self-emitting nodes.
        let brightestNeighbor = nodeEmission + 1;
        let bestDir = DIR_NONE;

        for (let dir = 0; dir < 6; dir++) {
            // skip the direction we came from
            if (dir + sourceDir === 5) continue;

            resolveNeighbor(chunk, lx, ly, lz, dir);
            if (!_nchunk) continue;
            const nchunk = _nchunk;
            const nindex = _nindex;

            const neighborState = nchunk.palette[nchunk.data[nindex]!]!;
            const neighborOpacity = lightOpacity[neighborState]!;

            const neighborPacked = nchunk.light[nindex]!;
            let neighborLevel = (neighborPacked >> shift) & 0xf;

            // strictly-less-than is sound because every propagation step decays by at least 1, except full-strength sky descending, which never leaves a sub-15 neighbour at this level.
            if (neighborOpacity < 15 && neighborLevel < oldLevel) {
                if (neighborLevel > 0) {
                    setLight(nchunk, nindex, neighborPacked & mask);
                    markChunkDirty(voxels, nchunk);
                    bqPush(removalQueue, neighborLevel, nchunk, nindex, dir);
                }
            } else {
                // border: neighbor has light from elsewhere (or is opaque); boost it to at least its own emission.
                const neighborEmission = chGetEmission(lightEmission[neighborState]!, ch);
                if (neighborLevel < neighborEmission) {
                    neighborLevel = neighborEmission;
                }

                if (neighborLevel > brightestNeighbor) {
                    brightestNeighbor = neighborLevel;
                    bestDir = dir;
                }
            }
        }

        // a bright neighbor (or self-emission) re-seeds this node at brightest - 1.
        const relightLevel = brightestNeighbor - 1;
        if (relightLevel > 0) {
            const nodeOpacity = lightOpacity[nodeState]!;
            if (nodeOpacity < 15) {
                // direction: opposite of best neighbor dir, prevents backward spread
                const relightDir = bestDir === DIR_NONE ? DIR_NONE : 5 - bestDir;
                bqPush(relightQueue, relightLevel, chunk, index, relightDir);
            }
        }
    }
}

/** channel-generic spread BFS: propagates light outward; full-strength sky (15) spreading down through opacity=0 blocks doesn't decay, so a lower sky value is never mistaken for an independent source. */
function spreadChannel(voxels: Voxels, registry: Blocks, ch: number, sourceQueue: BucketQueue): void {
    const { lightOpacity } = registry;
    const isSky = ch === CH_SKY;
    const shift = CHANNEL_SHIFT[ch]!;
    const mask = CHANNEL_MASK[ch]!;

    while (bqPop(sourceQueue)) {
        const chunk = _popChunk!;
        const index = _popIndex;
        const sourceDir = _popSourceDir;
        const level = _popLevel;

        // extract local coords from voxel index
        const lx = index & CHUNK_MASK;
        const lz = (index >> 4) & CHUNK_MASK;
        const ly = index >> 8;

        for (let dir = 0; dir < 6; dir++) {
            // skip the direction we came from
            if (dir + sourceDir === 5) continue;

            resolveNeighbor(chunk, lx, ly, lz, dir);
            if (!_nchunk) continue;
            const nchunk = _nchunk;
            const nindex = _nindex;

            const neighborState = nchunk.palette[nchunk.data[nindex]!]!;
            const neighborOpacity = lightOpacity[neighborState]!;

            if (neighborOpacity >= 15) continue;

            const noDecay = isSky && dir === DIR_DOWN && neighborOpacity === 0 && level === 15;
            const decay = noDecay ? 0 : neighborOpacity < 1 ? 1 : neighborOpacity;
            const spreadingLight = level - decay;
            if (spreadingLight <= 0) continue;

            const neighborPacked = nchunk.light[nindex]!;
            const neighborLevel = (neighborPacked >> shift) & 0xf;

            if (neighborLevel < spreadingLight) {
                setLight(nchunk, nindex, (neighborPacked & mask) | (spreadingLight << shift));
                markChunkDirty(voxels, nchunk);
                bqPush(sourceQueue, spreadingLight, nchunk, nindex, dir);
            }
        }
    }
}

/** full light recompute: zeros all light, seeds sky columns + emitters, then spreads each channel; used on initial load or a drastic world change. */
export function propagateAllLight(voxels: Voxels): void {
    const registry = voxels.registry;
    const { lightEmission, lightOpacity } = registry;

    // defensive: test/bench paths that bypass ensureChunk can leave voxels.columns/regions stale, so rebuild them from the authoritative chunks map.
    rebuildSpatialIndexes(voxels);

    // zero all light + clear dirty masks; the BFS rebuild below re-marks via setLight.
    for (const chunk of voxels.chunks.values()) {
        chunkLight(chunk).fill(0);
        if (chunk.lightDirtyMask !== EMPTY_LIGHT_MASK) {
            chunk.lightDirtyMask.fill(0);
        }
        chunk.lightDirtyCount = 0;
    }

    if (voxels.chunks.size === 0) {
        voxels.lighting.epoch++;
        return;
    }

    // sky channel: seed sky=15 top-down in transparent columns, then run the unspread(noop) -> spread pipeline.
    bqClear(_removalQueue);
    bqClear(_relightQueue);
    bqClear(_spreadQueue);

    // walk each xz-column top-down (chunks sorted cy descending) and stop at the first opaque voxel.
    for (const column of voxels.columns.values()) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                let skyAlive = true;
                for (let ci = 0; ci < column.length && skyAlive; ci++) {
                    const chunk = column[ci]!;
                    for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
                        const idx = voxelIndex(lx, ly, lz);
                        const state = chunk.palette[chunk.data[idx]!]!;
                        const opacity = lightOpacity[state]!;
                        if (opacity > 0) {
                            skyAlive = false;
                            break;
                        }
                        setLight(chunk, idx, setSky(chunk.light[idx]!, 15));
                        bqPush(_spreadQueue, 15, chunk, idx, DIR_NONE);
                    }
                }
            }
        }
    }

    unspreadChannel(voxels, voxels.registry, CH_SKY, _removalQueue, _relightQueue);
    spreadChannel(voxels, voxels.registry, CH_SKY, _spreadQueue);

    // rgb channels: same seed -> unspread(noop) -> spread pipeline, seeded from emitters.
    for (const ch of [CH_RED, CH_GREEN, CH_BLUE]) {
        bqClear(_removalQueue);
        bqClear(_relightQueue);
        bqClear(_spreadQueue);

        const shift = CHANNEL_SHIFT[ch]!;
        const mask = CHANNEL_MASK[ch]!;

        for (const chunk of voxels.chunks.values()) {
            // palette pre-check: skip the 4096-cell scan when no palette state emits on this channel (typical palettes are 1-10 entries).
            const palette = chunk.palette;
            let hasEmitter = false;
            for (let p = 0; p < palette.length; p++) {
                if (chGetEmission(lightEmission[palette[p]!]!, ch) > 0) {
                    hasEmitter = true;
                    break;
                }
            }
            if (!hasEmitter) continue;

            const data = chunk.data;
            const light = chunk.light;
            for (let idx = 0; idx < data.length; idx++) {
                const emission = chGetEmission(lightEmission[palette[data[idx]!]!]!, ch);
                if (emission <= 0) continue;

                const cur = light[idx]!;
                const current = (cur >> shift) & 0xf;
                if (emission > current) {
                    setLight(chunk, idx, (cur & mask) | (emission << shift));
                    bqPush(_spreadQueue, emission, chunk, idx, DIR_NONE);
                }
            }
        }

        unspreadChannel(voxels, voxels.registry, ch, _removalQueue, _relightQueue);
        spreadChannel(voxels, voxels.registry, ch, _spreadQueue);
    }

    for (const chunk of voxels.chunks.values()) {
        chunk.dirty = true;
        chunk.meshGen++;
        // full rebake rewrites light[] for every chunk (bypassing setLight above), so bump version here to mark every chunk save-dirty.
        chunk.version++;
        voxels.dirty.blocks.add(chunk);
    }

    voxels.lighting.epoch++;
    if (voxels.authority) {
        for (const chunk of voxels.chunks.values()) {
            chunk.compressedSnapshot = null;
            chunk.snapshotPalette = null;
            chunk.compressedLight = null;
        }
    }
}

/** seed sky columns of one chunk top-down into _spreadQueue, reading the chunk above (or the void) as the sky boundary; the seed half of seedNewChunkSky without the trailing spread. */
function seedChunkSkyColumns(voxels: Voxels, chunk: Chunk): void {
    const { lightOpacity } = voxels.registry;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            let aboveIsSky: boolean;
            const aboveChunk = chunk.neighbors[DIR_UP];
            if (aboveChunk) {
                const aboveIdx = voxelIndex(lx, 0, lz);
                const aboveSky = chGet(aboveChunk.light[aboveIdx]!, CH_SKY);
                const aboveState = aboveChunk.palette[aboveChunk.data[aboveIdx]!]!;
                aboveIsSky = aboveSky === 15 && lightOpacity[aboveState]! === 0;
            } else {
                aboveIsSky = true; // no chunk above, the void is the sky
            }
            for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
                if (!aboveIsSky) break;
                const idx = voxelIndex(lx, ly, lz);
                const state = chunk.palette[chunk.data[idx]!]!;
                if (lightOpacity[state]! > 0) break;
                setLight(chunk, idx, setSky(chunk.light[idx]!, 15));
                bqPush(_spreadQueue, 15, chunk, idx, DIR_NONE);
            }
        }
    }
}

/** seed one boundary face's lit neighbour cells as spread sources so light outside the working set flows back in. */
function seedBoundaryInflowFace(chunk: Chunk, dir: number, shift: number): void {
    const S = CHUNK_SIZE;
    if (dir === 0 || dir === 5) {
        const lx = dir === 0 ? S - 1 : 0;
        for (let ly = 0; ly < S; ly++) for (let lz = 0; lz < S; lz++) inflowCell(chunk, lx, ly, lz, dir, shift);
    } else if (dir === 1 || dir === 4) {
        const ly = dir === 1 ? S - 1 : 0;
        for (let lx = 0; lx < S; lx++) for (let lz = 0; lz < S; lz++) inflowCell(chunk, lx, ly, lz, dir, shift);
    } else {
        const lz = dir === 2 ? S - 1 : 0;
        for (let lx = 0; lx < S; lx++) for (let ly = 0; ly < S; ly++) inflowCell(chunk, lx, ly, lz, dir, shift);
    }
}

function inflowCell(chunk: Chunk, lx: number, ly: number, lz: number, dir: number, shift: number): void {
    resolveNeighbor(chunk, lx, ly, lz, dir);
    if (!_nchunk) return;
    const level = (_nchunk.light[_nindex]! >> shift) & 0xf;
    if (level > 0) bqPush(_spreadQueue, level, _nchunk, _nindex, DIR_NONE);
}

/** scoped light recompute over a chunk set plus a one-ring neighbour margin, treating chunks outside the working set as a fixed boundary; driven by the batch-edit commit path so bulk edits relight in one pass instead of per-block incremental BFS. */
export function relightChunks(voxels: Voxels, dirty: Set<Chunk>): void {
    if (dirty.size === 0) return;
    const registry = voxels.registry;
    const { lightEmission } = registry;

    // working set = dirty + 6-face neighbours, so darkening that flows out of dirty gets rebuilt in the neighbour too.
    const working = new Set<Chunk>(dirty);
    for (const c of dirty) {
        for (let dir = 0; dir < 6; dir++) {
            const n = c.neighbors[dir];
            if (n) working.add(n);
        }
    }

    // zero light in the working set only (preserves every other chunk).
    for (const c of working) {
        chunkLight(c).fill(0);
        if (c.lightDirtyMask !== EMPTY_LIGHT_MASK) c.lightDirtyMask.fill(0);
        c.lightDirtyCount = 0;
    }

    // removal queue stays empty (we zero + re-seed, never unspread); cleared once so unspreadChannel is a proven no-op.
    bqClear(_removalQueue);
    bqClear(_relightQueue);

    // sky channel: seed columns top-down + boundary in-flow, then spread.
    bqClear(_spreadQueue);
    // descending cy so a working chunk above is seeded before the one below reads its floor as the sky boundary.
    const sorted = [...working].sort((a, b) => b.cy - a.cy);
    for (const c of sorted) seedChunkSkyColumns(voxels, c);
    seedBoundaryInflow(working, CH_SKY);
    unspreadChannel(voxels, registry, CH_SKY, _removalQueue, _relightQueue);
    spreadChannel(voxels, registry, CH_SKY, _spreadQueue);

    // rgb channels: seed emitters + boundary in-flow, then spread.
    for (const ch of [CH_RED, CH_GREEN, CH_BLUE]) {
        bqClear(_spreadQueue);
        const shift = CHANNEL_SHIFT[ch]!;
        const mask = CHANNEL_MASK[ch]!;
        for (const c of working) {
            const palette = c.palette;
            let hasEmitter = false;
            for (let p = 0; p < palette.length; p++) {
                if (chGetEmission(lightEmission[palette[p]!]!, ch) > 0) {
                    hasEmitter = true;
                    break;
                }
            }
            if (!hasEmitter) continue;
            const data = c.data;
            const light = c.light;
            for (let idx = 0; idx < data.length; idx++) {
                const emission = chGetEmission(lightEmission[palette[data[idx]!]!]!, ch);
                if (emission <= 0) continue;
                const cur = light[idx]!;
                if (emission > ((cur >> shift) & 0xf)) {
                    setLight(c, idx, (cur & mask) | (emission << shift));
                    bqPush(_spreadQueue, emission, c, idx, DIR_NONE);
                }
            }
        }
        seedBoundaryInflow(working, ch);
        unspreadChannel(voxels, registry, ch, _removalQueue, _relightQueue);
        spreadChannel(voxels, registry, ch, _spreadQueue);
    }

    // mark working chunks mesh + light dirty for network; no global lightEpoch bump since per-chunk suffices.
    for (const c of working) {
        c.dirty = true;
        c.lightDirty = true;
        c.meshGen++;
        c.version++;
        voxels.dirty.blocks.add(c);
        voxels.dirty.light.add(c);
        markLightVolumeDirty(voxels, c);
        c.compressedSnapshot = null;
        c.snapshotPalette = null;
        c.compressedLight = null;
    }
}

/** seed lit cells from chunks bordering the working set so their light flows back in during spread. */
function seedBoundaryInflow(working: Set<Chunk>, ch: number): void {
    const shift = CHANNEL_SHIFT[ch]!;
    for (const c of working) {
        for (let dir = 0; dir < 6; dir++) {
            const n = c.neighbors[dir];
            if (!n || working.has(n)) continue;
            seedBoundaryInflowFace(c, dir, shift);
        }
    }
}

/** seed sky light into a newly-created chunk before block changes are processed, walking each column top-down from the chunk above (or the void). */
function seedNewChunkSky(voxels: Voxels, chunk: Chunk): void {
    const { lightOpacity } = voxels.registry;

    bqClear(_spreadQueue);

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            // is the block above this column sky-lit?
            let aboveIsSky = false;
            const aboveChunk = chunk.neighbors[DIR_UP];
            if (aboveChunk) {
                const aboveIdx = voxelIndex(lx, 0, lz);
                const aboveSky = chGet(aboveChunk.light[aboveIdx]!, CH_SKY);
                const aboveState = aboveChunk.palette[aboveChunk.data[aboveIdx]!]!;
                const aboveOpacity = lightOpacity[aboveState]!;
                aboveIsSky = aboveSky === 15 && aboveOpacity === 0;
            } else {
                // no chunk above, the void IS the sky
                aboveIsSky = true;
            }

            for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
                if (!aboveIsSky) break;

                const idx = voxelIndex(lx, ly, lz);
                const state = chunk.palette[chunk.data[idx]!]!;
                const opacity = lightOpacity[state]!;
                if (opacity > 0) break;

                setLight(chunk, idx, setSky(chunk.light[idx]!, 15));
                bqPush(_spreadQueue, 15, chunk, idx, DIR_NONE);
            }
        }
    }

    // spread sky light horizontally from the seeded positions, including across chunk boundaries.
    spreadChannel(voxels, voxels.registry, CH_SKY, _spreadQueue);
}

export type LightChange = {
    wx: number;
    wy: number;
    wz: number;
    oldStateId: number;
};

/** process multiple block changes in one pass per channel: seed removal/relight from changed nodes, a sky pre-step, removal BFS, an init-write of relight seeds, then spread BFS. */
export function updateLightBatch(voxels: Voxels, changes: LightChange[]): void {
    if (changes.length === 0) return;

    const registry = voxels.registry;
    const { lightOpacity } = registry;

    for (let ch = 0; ch < 4; ch++) {
        const isSky = ch === CH_SKY;
        bqClear(_removalQueue);
        bqClear(_relightQueue);

        // a neighbor at or above this threshold couldn't have gotten its light from any changed node, so it's trusted; below it, the value might be stale.
        let minSafeLight = 0;
        if (changes.length > 1) {
            for (let ci = 0; ci < changes.length; ci++) {
                const { wx, wy, wz } = changes[ci]!;
                const c = resolveWorldPos(voxels, wx, wy, wz);
                if (!c) continue;
                const idx = voxelIndex(toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
                const oldLevel = chGet(c.light[idx]!, ch);
                if (oldLevel > minSafeLight) minSafeLight = oldLevel;
            }
            // +1 because changed nodes could have been sources for each other
            minSafeLight += 1;
        }

        for (let ci = 0; ci < changes.length; ci++) {
            const { wx, wy, wz, oldStateId } = changes[ci]!;

            const chunk = resolveWorldPos(voxels, wx, wy, wz);
            if (!chunk) continue;
            const lx = toLocalCoord(wx);
            const ly = toLocalCoord(wy);
            const lz = toLocalCoord(wz);
            const index = voxelIndex(lx, ly, lz);

            const newStateId = chunk.palette[chunk.data[index]!]!;

            const oldOpacity = lightOpacity[oldStateId]!;
            const newOpacity = lightOpacity[newStateId]!;

            const packed = chunk.light[index]!;
            const currentLevel = chGet(packed, ch);

            // sky column pre-step
            if (isSky) {
                const oldBlocksSky = oldOpacity > 0;
                const newBlocksSky = newOpacity > 0;

                if (!oldBlocksSky && newBlocksSky) {
                    // opaque block placed in a sky column: remove sky here, then walk down removing sky=15 column light.
                    if (currentLevel > 0) {
                        writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
                        bqPush(_removalQueue, currentLevel, chunk, index, DIR_NONE);
                    }

                    let curChunk = chunk;
                    let curLy = ly - 1;
                    const curLx = lx;
                    const curLz = lz;
                    while (true) {
                        // cross chunk boundary downward if needed
                        if (curLy < 0) {
                            const below = curChunk.neighbors[DIR_DOWN];
                            if (!below) break;
                            curChunk = below;
                            curLy = CHUNK_SIZE - 1;
                        }

                        const belowIdx = voxelIndex(curLx, curLy, curLz);
                        const belowState = curChunk.palette[curChunk.data[belowIdx]!]!;
                        const belowOpacity = lightOpacity[belowState]!;
                        if (belowOpacity > 0) break;

                        const belowPacked = curChunk.light[belowIdx]!;
                        const belowSky = chGet(belowPacked, ch);
                        if (belowSky === 0) break;

                        writeChunkLight(voxels, curChunk, belowIdx, chSet(belowPacked, ch, 0));
                        // dir=DIR_DOWN: light traveled downward, so skip spreading back up.
                        bqPush(_removalQueue, belowSky, curChunk, belowIdx, DIR_DOWN);
                        curLy--;
                    }
                } else if (oldBlocksSky && !newBlocksSky) {
                    // opaque block removed: check whether sky can now reach here from above (void counts as sky=15).
                    resolveNeighbor(chunk, lx, ly, lz, DIR_UP);
                    const aboveSky = _nchunk ? chGet(_nchunk.light[_nindex]!, ch) : 15;

                    if (aboveSky === 15) {
                        // seed sky=15 at this node and walk down
                        writeChunkLight(voxels, chunk, index, chSet(packed, ch, 15));
                        bqPush(_relightQueue, 15, chunk, index, DIR_NONE);

                        let curChunk = chunk;
                        let curLy = ly - 1;
                        const curLx = lx;
                        const curLz = lz;
                        while (true) {
                            if (curLy < 0) {
                                const below = curChunk.neighbors[DIR_DOWN];
                                if (!below) break;
                                curChunk = below;
                                curLy = CHUNK_SIZE - 1;
                            }

                            const belowIdx = voxelIndex(curLx, curLy, curLz);
                            const belowState = curChunk.palette[curChunk.data[belowIdx]!]!;
                            const belowOpacity = lightOpacity[belowState]!;
                            if (belowOpacity > 0) break;

                            const belowPacked = curChunk.light[belowIdx]!;
                            const belowSky = chGet(belowPacked, ch);
                            if (belowSky >= 15) break; // already lit

                            writeChunkLight(voxels, curChunk, belowIdx, chSet(belowPacked, ch, 15));
                            // dir=DIR_DOWN: light traveled downward, so skip spreading back up.
                            bqPush(_relightQueue, 15, curChunk, belowIdx, DIR_DOWN);
                            curLy--;
                        }
                    } else {
                        // no sky column above; neighbors below might still provide sky light via computeNewLevel.
                        const newLevel = computeNewLevel(chunk, lx, ly, lz, registry, ch, minSafeLight);
                        if (newLevel > currentLevel) {
                            writeChunkLight(voxels, chunk, index, chSet(packed, ch, newLevel));
                            bqPush(_relightQueue, newLevel, chunk, index, DIR_NONE);
                        } else if (currentLevel > newLevel && currentLevel > 0) {
                            writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
                            bqPush(_removalQueue, currentLevel, chunk, index, DIR_NONE);
                        }
                    }
                }
                if (oldBlocksSky === newBlocksSky) {
                    // non-sky-blocking change, handle like block light
                    handleChannelChange(
                        voxels,
                        chunk,
                        index,
                        lx,
                        ly,
                        lz,
                        registry,
                        ch,
                        oldOpacity,
                        newOpacity,
                        packed,
                        currentLevel,
                        minSafeLight,
                        _removalQueue,
                        _relightQueue,
                    );
                }
            } else {
                // block light (r, g, b)
                handleChannelChange(
                    voxels,
                    chunk,
                    index,
                    lx,
                    ly,
                    lz,
                    registry,
                    ch,
                    oldOpacity,
                    newOpacity,
                    packed,
                    currentLevel,
                    minSafeLight,
                    _removalQueue,
                    _relightQueue,
                );
            }
        }

        unspreadChannel(voxels, registry, ch, _removalQueue, _relightQueue);

        // write relight seed values without popping; spreadChannel below still needs them.
        const initShift = CHANNEL_SHIFT[ch]!;
        const initMask = CHANNEL_MASK[ch]!;
        for (let lvl = 15; lvl >= 0; lvl--) {
            const seedChunks = _relightQueue.chunks[lvl]!;
            const seedPackedArr = _relightQueue.packed[lvl]!;
            for (let i = 0; i < seedChunks.length; i++) {
                const seedChunk = seedChunks[i]!;
                const seedIndex = seedPackedArr[i]! & 0xfff;
                const seedPacked = seedChunk.light[seedIndex]!;
                const current = (seedPacked >> initShift) & 0xf;
                if (current < lvl) {
                    setLight(seedChunk, seedIndex, (seedPacked & initMask) | (lvl << initShift));
                    markChunkDirty(voxels, seedChunk);
                }
            }
        }

        spreadChannel(voxels, registry, ch, _relightQueue);
    }
}

function handleChannelChange(
    voxels: Voxels,
    chunk: Chunk,
    index: number,
    lx: number,
    ly: number,
    lz: number,
    registry: Blocks,
    ch: number,
    oldOpacity: number,
    newOpacity: number,
    packed: number,
    currentLevel: number,
    minSafeLight: number,
    removalQueue: BucketQueue,
    relightQueue: BucketQueue,
): void {
    const { lightEmission } = registry;

    const newState = chunk.palette[chunk.data[index]!]!;
    const newEmission = chGetEmission(lightEmission[newState]!, ch);

    if (newOpacity >= 15) {
        // fully opaque: light can't enter or be stored; zero any residual light so neighbors re-evaluate.
        if (currentLevel > 0) {
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
            bqPush(removalQueue, currentLevel, chunk, index, DIR_NONE);
        }
        // opaque blocks can still emit (e.g. glowstone): write emission and seed spread.
        if (newEmission > 0) {
            writeChunkLight(voxels, chunk, index, chSet(chunk.light[index]!, ch, newEmission));
            bqPush(relightQueue, newEmission, chunk, index, DIR_NONE);
        }
    } else if (newOpacity < 15) {
        // transparent: compute the level implied by neighbors + emission and compare to current.
        const newLevel = computeNewLevel(chunk, lx, ly, lz, registry, ch, minSafeLight);

        if (currentLevel > 0 && newLevel < currentLevel) {
            // light decreased: zero and push to removal; unspread finds the correct border seeds.
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
            bqPush(removalQueue, currentLevel, chunk, index, DIR_NONE);

            // seed relight at emission, not newLevel: neighbors may have stale values that only unspread will clean up.
            if (newEmission > 0) {
                bqPush(relightQueue, newEmission, chunk, index, DIR_NONE);
            }
        } else if (newLevel > currentLevel) {
            // light increased, seed directly
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, newLevel));
            bqPush(relightQueue, newLevel, chunk, index, DIR_NONE);
        } else if (oldOpacity !== newOpacity && currentLevel === 0) {
            // opacity decreased and this node held no light: neighbors are stable, so computeNewLevel is trustworthy here.
            if (newLevel > 0) {
                bqPush(relightQueue, newLevel, chunk, index, DIR_NONE);
            }
        }
    }
}

// computes emission plus the max of (neighbor level - decay) across all 6 neighbors; minSafeLight rejects neighbors that might be stale from other batch changes.
function computeNewLevel(
    chunk: Chunk,
    lx: number,
    ly: number,
    lz: number,
    registry: Blocks,
    ch: number,
    minSafeLight: number,
): number {
    const { lightEmission, lightOpacity } = registry;
    const isSky = ch === CH_SKY;
    const index = voxelIndex(lx, ly, lz);
    const state = chunk.palette[chunk.data[index]!]!;
    const opacity = lightOpacity[state]!;

    // fully opaque blocks can't hold light
    if (opacity >= 15) return 0;

    let best = chGetEmission(lightEmission[state]!, ch);

    // sky column: inherit 15 if the block above is sky-lit and transparent.
    if (isSky && opacity === 0) {
        resolveNeighbor(chunk, lx, ly, lz, DIR_UP);
        if (_nchunk) {
            const abovePacked = _nchunk.light[_nindex]!;
            const aboveSky = chGet(abovePacked, ch);
            if (aboveSky === 15) {
                const aboveState = _nchunk.palette[_nchunk.data[_nindex]!]!;
                const aboveOpacity = lightOpacity[aboveState]!;
                if (aboveOpacity === 0) {
                    best = 15; // sky column continues
                }
            }
        } else {
            // no chunk above, the void IS the sky. sky column continues.
            best = 15;
        }
    }

    for (let dir = 0; dir < 6; dir++) {
        resolveNeighbor(chunk, lx, ly, lz, dir);
        if (!_nchunk) continue;

        const neighborPacked = _nchunk.light[_nindex]!;
        const neighborLevel = chGet(neighborPacked, ch);
        if (neighborLevel <= 1) continue;

        // min_safe_light filter: reject neighbors whose light might be stale from other changes in the same batch.
        if (neighborLevel < minSafeLight) continue;

        // full-strength sky going down through transparent: no decay
        const isSkyDown = isSky && dir === DIR_DOWN && opacity === 0 && neighborLevel === 15;
        const decay = isSkyDown ? 0 : opacity < 1 ? 1 : opacity;
        const incoming = neighborLevel - decay;
        if (incoming > best) best = incoming;
    }

    return best < 0 ? 0 : best > 15 ? 15 : best;
}

/** drain the per-tick light-recompute queues in voxels.lighting: new chunks get sky seeded first, then per-block incremental updates, then scoped whole-chunk relights; runs on mirrors too since these queues only ever hold self-written work. */
export function flushPendingLight(voxels: Voxels): void {
    const light = voxels.lighting;
    const stale = light.chunks;
    // defensive: drop anything that slipped through when flood-fill lighting is disabled (e.g. the toggle flipped mid-tick).
    if (!light.floodFill.enabled) {
        light.newChunks.length = 0;
        light.blocks.length = 0;
        stale.clear();
        return;
    }

    // seed sky into new chunks before processing block changes; chunks already scheduled for a bulk relight are skipped (relightChunks rebakes them wholesale).
    const newChunks = light.newChunks;
    for (let i = 0; i < newChunks.length; i++) {
        const c = newChunks[i]!;
        if (!stale.has(c)) seedNewChunkSky(voxels, c);
    }
    newChunks.length = 0;

    // incremental light runs before the bulk relight so it sees settled state; entries in a stale chunk are redundant and filtered out.
    const pending = light.blocks;
    if (pending.length > 0) {
        if (stale.size === 0) {
            updateLightBatch(voxels, pending);
        } else {
            const filtered = pending.filter((p) => {
                const c = resolveWorldPos(voxels, p.wx, p.wy, p.wz);
                return !c || !stale.has(c);
            });
            if (filtered.length > 0) updateLightBatch(voxels, filtered);
        }
        pending.length = 0;
    }

    // bulk light: one scoped whole-chunk relight over the touched set, reading untouched (incl. disk-cached) neighbours as boundary conditions.
    if (stale.size > 0) {
        relightChunks(voxels, stale);
        stale.clear();
    }
}

// TODO: just kill entirely?????? why do we have this?
export function updateLightOnBlockChange(voxels: Voxels, wx: number, wy: number, wz: number, oldStateId: number): void {
    updateLightBatch(voxels, [{ wx, wy, wz, oldStateId }]);
}
