// ── voxel light helpers + propagation engine ────────────────────────
//
// per-voxel light is packed into a uint16 with 4 nibbles:
//   bits 15..12 = sky   (0-15)
//   bits 11..8  = red   (0-15)
//   bits  7..4  = green (0-15)
//   bits  3..0  = blue  (0-15)
//
// sky light propagates from the sky downward (no attenuation vertically,
// -1 per step horizontally). block light (RGB) is emitted by light
// sources and propagates with -1 per step in all directions, attenuated
// by each block's lightOpacity.
//
// the algorithm closely follows minetest/luanti's voxelalgorithms.cpp:
//   - channel-generic: the same unspread/spread functions run once per
//     channel (sky, r, g, b). each channel is an independent scalar BFS.
//   - batched: updateLightBatch processes all changed nodes in one pass
//     per channel (one removal BFS + one spread BFS).
//   - source_direction: each queue entry tracks where it came from.
//     BFS skips the back-direction to avoid redundant work.
//   - init-write step: after removal but before spread, relight seed
//     values are written to the map so spread reads correct neighbors.
//
// OPTIMIZATION: all BFS queue entries carry (chunk, voxelIndex, sourceDir)
// instead of world coordinates. neighbor resolution uses chunk.neighbors[]
// for cross-chunk traversal — zero string-keyed map lookups in the hot
// path. all light/state/dirty access goes through the chunk ref directly.

import type { Vec4 } from 'mathcat';
import type { BlockRegistry } from './block-registry';
import {
    CHUNK_SIZE,
    type Chunk,
    chunkKey,
    EMPTY_LIGHT_MASK,
    rebuildColumns,
    setLight,
    toChunkCoord,
    toLocalCoord,
    type Voxels,
    voxelIndex,
} from './voxels';

// ── packing / unpacking ─────────────────────────────────────────────

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

// ── channel setters (preserves other channels) ──────────────────────

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

// ── default opacity from cull type ──────────────────────────────────
//
// CullType encoding: NONE=0, SOLID=1, SELF=2, PARTIAL=3

const DEFAULT_OPACITY_BY_CULL: readonly number[] = [
    0, // NONE (air) — fully transparent
    15, // SOLID — fully opaque
    1, // SELF (leaves, water, glass) — slight filtering
    0, // PARTIAL (stairs/slopes) — transparent to light
];

export function defaultLightOpacity(encodedCull: number): number {
    return DEFAULT_OPACITY_BY_CULL[encodedCull] ?? 15;
}

// ── emission packing ────────────────────────────────────────────────
//
// light emission stored as 0RGB in a uint16 (no sky channel).
// same bit layout as the lower 12 bits of the light value.

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

// ── trilinear voxel light sample at world position ──────────────────
//
// writes [sky, r, g, b] into `out`, each normalized to [0,1]. used by
// mesh / voxel-mesh visuals to read the light at an instance's world
// position so non-voxel geometry shades the same as adjacent voxels.
//
// trilinear: treats each voxel's light as living at its center
// (i+0.5, j+0.5, k+0.5) and blends across the 8 surrounding cells. as a
// model translates continuously through world space its light fades
// continuously too rather than snapping a full 1/15 step every voxel
// crossing. corner lookups that fall in unloaded chunks fall back to
// open sky (sky=1, no block light) — same policy as the single-voxel
// path, so far-away models don't render pitch-black before chunks stream in.

const INV_15 = 1 / 15;

function _readPackedLight(voxels: Voxels, vx: number, vy: number, vz: number): number {
    const cx = toChunkCoord(vx);
    const cy = toChunkCoord(vy);
    const cz = toChunkCoord(vz);
    const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
    if (!chunk) return 0xf000; // open sky, no block light
    const lx = toLocalCoord(vx);
    const ly = toLocalCoord(vy);
    const lz = toLocalCoord(vz);
    return chunk.light[voxelIndex(lx, ly, lz)]!;
}

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

    // unpack each channel from each of the 8 corners, weighted-sum, then
    // normalize to [0,1] in one INV_15 multiply at the end.
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

// ── 6-neighbor offsets (local coord deltas) ─────────────────────────
//
// direction index: 0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X
// two directions are opposite iff their indices sum to 5.
// this matches minetest's convention for source_direction skipping.

const NEIGHBOR_DLX: readonly number[] = [1, 0, 0, 0, 0, -1];
const NEIGHBOR_DLY: readonly number[] = [0, 1, 0, 0, -1, 0];
const NEIGHBOR_DLZ: readonly number[] = [0, 0, 1, -1, 0, 0];

// direction index for +Y (up) and -Y (down)
const DIR_UP = 1;
const DIR_DOWN = 4;

// no source direction (seed nodes)
const DIR_NONE = 6;

const CHUNK_MASK = CHUNK_SIZE - 1; // 0xf

// ── channel ids + inline shift/mask ─────────────────────────────────
//
// numeric channel ids instead of polymorphic ChannelAccessor objects.
// single monomorphic function body for get/set, trivially inlinable by v8.
//
// channel: 0=sky(shift 12), 1=red(shift 8), 2=green(shift 4), 3=blue(shift 0)

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

// ── neighbor resolution (zero map lookups) ──────────────────────────
//
// given a chunk + local coords + direction, resolves to the neighbor
// chunk + neighbor voxel index. uses chunk.neighbors[] for cross-chunk
// traversal. returns null chunk if neighbor is unloaded.
//
// scratch variables for the result — avoids any allocation.

let _nchunk: Chunk | null = null;
let _nindex = 0;

/** resolve neighbor in direction dir from (chunk, lx, ly, lz).
 *  result is in _nchunk and _nindex. _nchunk is null if unloaded. */
function resolveNeighbor(chunk: Chunk, lx: number, ly: number, lz: number, dir: number): void {
    const nlx = lx + NEIGHBOR_DLX[dir]!;
    const nly = ly + NEIGHBOR_DLY[dir]!;
    const nlz = lz + NEIGHBOR_DLZ[dir]!;

    // fast path: all coords in bounds → same chunk
    if ((nlx | nly | nlz) >= 0 && nlx < CHUNK_SIZE && nly < CHUNK_SIZE && nlz < CHUNK_SIZE) {
        _nchunk = chunk;
        _nindex = voxelIndex(nlx, nly, nlz);
        return;
    }

    // crossed a chunk boundary — use neighbor ref
    _nchunk = chunk.neighbors[dir];
    if (_nchunk) {
        _nindex = voxelIndex(nlx & CHUNK_MASK, nly & CHUNK_MASK, nlz & CHUNK_MASK);
    }
}

// ── local coord extraction from voxelIndex ──────────────────────────
//
// voxelIndex(x,y,z) = (y << 8) | (z << 4) | x
// so: lx = idx & 0xf, lz = (idx >> 4) & 0xf, ly = idx >> 8

// ── chunk light write helper ────────────────────────────────────────
//
// writes light to a chunk and invalidates cached snapshots.
// used by seeding code. BFS inner loops write chunk.light[] directly
// for speed, with markChunkDirty handling invalidation separately.

function writeChunkLight(voxels: Voxels, chunk: Chunk, index: number, value: number): void {
    setLight(chunk, index, value);
    // markChunkDirty is guarded, but writeChunkLight is only called during
    // seeding (small number of calls), so inline the dirty bits here too.
    chunk.lightDirty = true;
    chunk.dirty = true;
    voxels.dirty.blocks.add(chunk);
    voxels.dirty.light.add(chunk);
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
    chunk.compressedLight = null;
}

// ── chunk dirty marking ─────────────────────────────────────────────

function markChunkDirty(voxels: Voxels, chunk: Chunk): void {
    if (chunk.lightDirty) return; // already dirty — skip redundant stores
    chunk.lightDirty = true;
    chunk.dirty = true;
    voxels.dirty.blocks.add(chunk);
    voxels.dirty.light.add(chunk);
    chunk.compressedSnapshot = null;
    chunk.snapshotPalette = null;
    chunk.compressedLight = null;
}

// ── world coord → chunk + index resolution ──────────────────────────
//
// used by seeding code to resolve a world position to (chunk, index).
// this is the ONE place we do a map lookup — at seed time, not in BFS.

function resolveWorldPos(voxels: Voxels, wx: number, wy: number, wz: number): Chunk | null {
    const chunk = voxels.chunks.get(chunkKey(toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz)));
    return chunk ?? null;
}

// ── bucket priority queue ───────────────────────────────────────────
//
// 16 buckets (one per light level 0-15). process from highest to lowest.
// each bucket has two parallel arrays: chunks[] and packed[] (= index
// in low 12 bits | sourceDir in bits 12..14). 12 bits is enough because
// voxelIndex(x,y,z) ∈ [0, CHUNK_SIZE^3) = [0, 4096); sourceDir ∈ [0, 6]
// (incl. DIR_NONE=6) fits in 3 bits. packing halves the push/pop array
// op count vs three separate arrays.
//
// bqPop writes result into module-scope scratch vars (_popChunk, _popIndex,
// _popSourceDir, _popLevel). returns false when empty.

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

// ── reusable queues ─────────────────────────────────────────────────

const _removalQueue = createBucketQueue();
const _relightQueue = createBucketQueue();
const _spreadQueue = createBucketQueue();

// ── channel-generic removal BFS (port of minetest's unspread_light) ──
//
// processes removalQueue, populating relightQueue with border seeds.
//
// for each removed node (popped at its old light level):
//   - check all 6 neighbors (skip source direction)
//   - if neighbor propagates (opacity < 15) and level < oldLevel: zero it, push to removal
//   - else: it's a border. boost to at least its emission, track the brightest.
//   - after checking all neighbors: if brightest_neighbor > 1, push the
//     current (removed) node to relightQueue at (brightest_neighbor - 1)
//     with direction = opposite of brightest neighbor dir.
//     this is minetest's approach — the removed node becomes the relight
//     seed, not the bright neighbor.
//
// no sky-specific logic here. sky column handling is entirely in the
// pre-step in updateLightBatch (matching minetest's design).

function unspreadChannel(
    voxels: Voxels,
    registry: BlockRegistry,
    ch: number,
    removalQueue: BucketQueue,
    relightQueue: BucketQueue,
): void {
    const { lightOpacity, lightEmission } = registry;
    // hoist channel shift/mask once per BFS — ch is fixed for the entire
    // pop loop, so the per-cell chGet/chSet array indexing collapses to
    // direct shifts.
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

        // this node's state — needed for emission check
        const nodeState = chunk.palette[chunk.data[index]!]!;
        const nodeEmission = chGetEmission(lightEmission[nodeState]!, ch);

        // track brightest border neighbor that can re-seed this node.
        // start at emission+1 so that brightest-1 yields emission for
        // self-emitting nodes (matches minetest's f.light_source + 1).
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

            // minetest: if (propagates && level < oldLevel) → removal, else → border.
            // opaque neighbors (!propagates) always go to the border branch.
            if (neighborOpacity < 15 && neighborLevel < oldLevel) {
                // this neighbor propagates light and got its light from us — remove it
                if (neighborLevel > 0) {
                    setLight(nchunk, nindex, neighborPacked & mask);
                    markChunkDirty(voxels, nchunk);
                    bqPush(removalQueue, neighborLevel, nchunk, nindex, dir);
                }
            } else {
                // border — this neighbor has light from elsewhere (or is opaque).
                // boost to at least its own emission (minetest:
                // if neighbor_light < neighbor_f.light_source then
                //   neighbor_light = neighbor_f.light_source)
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

        // if there's a bright neighbor (or self-emission), re-seed this node.
        // brightest-1 is the relight level (minetest: light = max - 1).
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

// ── channel-generic spread BFS (port of minetest's spread_light) ────
//
// processes sourceQueue, spreading light outward.
// each entry is popped at its light level. we compute spreading_light
// = level - 1, then check all 6 neighbors (skip source direction).
// if the neighbor's current channel value < spreading_light and the
// neighbor can propagate (opacity < 15), set it and push.
//
// sky special case: when spreading downward through opacity=0 blocks,
// sky light doesn't decay (stays at the current level, not level-1).

function spreadChannel(voxels: Voxels, registry: BlockRegistry, ch: number, sourceQueue: BucketQueue): void {
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

            // opaque blocks don't propagate
            if (neighborOpacity >= 15) continue;

            // compute the light level after crossing into this neighbor
            // sky going down through transparent (opacity=0) blocks: no decay
            const decay = isSky && dir === DIR_DOWN && neighborOpacity === 0 ? 0 : neighborOpacity < 1 ? 1 : neighborOpacity;
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

// ── propagateAllLight (full recompute) ──────────────────────────────
//
// zeros all light, seeds sky columns + emitters, then runs spreadChannel
// for each channel. used on initial load or when the world changes
// drastically (e.g. chunk load).

export function propagateAllLight(voxels: Voxels): void {
    const registry = voxels.registry;
    const { lightEmission, lightOpacity } = registry;

    // defensive reconcile — test/bench code paths bypass ensureChunk and
    // drop chunks straight into voxels.chunks, so voxels.columns can be
    // stale. cheap rebuild from the authoritative chunks map.
    rebuildColumns(voxels);

    // zero all light + clear per-chunk dirty masks. BFS rebuild below
    // will re-mark via setLight for chunks that end up with light.
    for (const chunk of voxels.chunks.values()) {
        chunk.light.fill(0);
        if (chunk.lightDirtyMask !== EMPTY_LIGHT_MASK) {
            chunk.lightDirtyMask.fill(0);
        }
        chunk.lightDirtyCount = 0;
    }

    if (voxels.chunks.size === 0) {
        if (voxels.authority) voxels.authority.changes.lightEpoch++;
        return;
    }

    // ── sky channel: seed → unspread (noop) → init-write → spread ───
    //
    // seed sky=15 in transparent columns top-down. writes go direct to
    // chunk.light[] (no ops). since everything starts at 0, unspread
    // queue is empty — but we run the same pipeline anyway.

    bqClear(_removalQueue);
    bqClear(_relightQueue);
    bqClear(_spreadQueue);

    // iterate each xz-column of loaded chunks (sorted cy descending), then
    // for each (lx, lz) pillar walk top-down through the column's chunks
    // and stop at the first opaque voxel.
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

    // unspread (noop — removal queue empty) → init-write (noop) → spread
    unspreadChannel(voxels, voxels.registry, CH_SKY, _removalQueue, _relightQueue);
    spreadChannel(voxels, voxels.registry, CH_SKY, _spreadQueue);

    // ── rgb channels: seed → unspread (noop) → init-write → spread ──

    for (const ch of [CH_RED, CH_GREEN, CH_BLUE]) {
        bqClear(_removalQueue);
        bqClear(_relightQueue);
        bqClear(_spreadQueue);

        const shift = CHANNEL_SHIFT[ch]!;
        const mask = CHANNEL_MASK[ch]!;

        for (const chunk of voxels.chunks.values()) {
            // palette pre-check: if no state in this chunk's palette emits
            // for this channel, skip the 4096-cell scan entirely. typical
            // chunks have a small palette (1-10 entries) so this is a big
            // win over the per-cell branch.
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

        // unspread (noop) → init-write (noop) → spread
        unspreadChannel(voxels, voxels.registry, ch, _removalQueue, _relightQueue);
        spreadChannel(voxels, voxels.registry, ch, _spreadQueue);
    }

    // mark all chunks dirty for meshing
    for (const chunk of voxels.chunks.values()) {
        chunk.dirty = true;
        chunk.meshGen++;
        // full rebake rewrites light[] for every chunk (incl. the fill(0) clear
        // above, which bypasses setLight) — so bump the persisted-data version
        // here to mark every chunk save-dirty.
        chunk.version++;
        voxels.dirty.blocks.add(chunk);
    }

    // bump light epoch (full recompute — clients discard incremental ops)
    if (voxels.authority) {
        voxels.authority.changes.lightEpoch++;
        // invalidate all snapshots
        for (const chunk of voxels.chunks.values()) {
            chunk.compressedSnapshot = null;
            chunk.snapshotPalette = null;
            chunk.compressedLight = null;
        }
    }
}

// ── seedNewChunkSky (internal) ──────────────────────────────────────
//
// seeds sky light into a newly-created chunk. called by flushPendingLight
// before processing block changes, so the incremental update sees
// correct sky state.
//
// walks each column top-down: if the block above (either in the chunk
// above or the void) has sky=15 and is transparent, continues the sky
// column into this chunk. for an all-air chunk at the top of the
// world, every voxel gets sky=15. for an all-air chunk below a fully-
// lit chunk, the sky also passes straight through.
//
// pushes seeded positions into the provided spread queue for
// subsequent horizontal spreading.

function seedNewChunkSky(voxels: Voxels, chunk: Chunk): void {
    const { lightOpacity } = voxels.registry;

    bqClear(_spreadQueue);

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            // check above: is the block above this column sky-lit?
            // for the topmost local y, look at the chunk above.
            let aboveIsSky = false;
            const aboveChunk = chunk.neighbors[DIR_UP];
            if (aboveChunk) {
                const aboveIdx = voxelIndex(lx, 0, lz);
                const aboveSky = chGet(aboveChunk.light[aboveIdx]!, CH_SKY);
                const aboveState = aboveChunk.palette[aboveChunk.data[aboveIdx]!]!;
                const aboveOpacity = lightOpacity[aboveState]!;
                aboveIsSky = aboveSky === 15 && aboveOpacity === 0;
            } else {
                // no chunk above — the void IS the sky
                aboveIsSky = true;
            }

            // walk top-down through this chunk's column
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

    // spread sky light horizontally from the seeded positions.
    // this handles cases where sky columns in this chunk illuminate
    // neighbors (including across chunk boundaries).
    spreadChannel(voxels, voxels.registry, CH_SKY, _spreadQueue);
}

// ── updateLightBatch (batched incremental update) ───────────────────
//
// processes multiple block changes in one pass per channel.
// this is the core incremental API, ported from minetest's
// update_lighting_nodes().
//
// for each channel:
//   1. seed removal queue with nodes that lost light
//   2. seed relight queue with nodes that gained light
//   3. sky pre-step: column removal / column seeding
//   4. unspreadChannel (removal BFS → collects border seeds)
//   5. init-write: write relight seed values to the map
//   6. spreadChannel (propagation BFS)

export type LightChange = {
    wx: number;
    wy: number;
    wz: number;
    oldStateId: number;
};

export function updateLightBatch(voxels: Voxels, changes: LightChange[]): void {
    if (changes.length === 0) return;

    const registry = voxels.registry;
    const { lightOpacity } = registry;

    for (let ch = 0; ch < 4; ch++) {
        const isSky = ch === CH_SKY;
        bqClear(_removalQueue);
        bqClear(_relightQueue);

        // ── min_safe_light pre-pass (minetest step 0) ──────────────
        //
        // any neighbor with light >= minSafeLight could NOT have gotten
        // its light from any of the changed nodes, so its value is stable.
        // below this threshold, the neighbor's light might be stale
        // (about to be zeroed by unspread). this avoids over-seeding
        // the relight queue with incorrect values from batched changes.
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

            // resolve chunk + index once for this change
            const chunk = resolveWorldPos(voxels, wx, wy, wz);
            if (!chunk) continue;
            const lx = toLocalCoord(wx);
            const ly = toLocalCoord(wy);
            const lz = toLocalCoord(wz);
            const index = voxelIndex(lx, ly, lz);

            const newStateId = chunk.palette[chunk.data[index]!]!;

            // compute old and new opacity for this channel
            const oldOpacity = lightOpacity[oldStateId]!;
            const newOpacity = lightOpacity[newStateId]!;

            const packed = chunk.light[index]!;
            const currentLevel = chGet(packed, ch);

            // ── sky column pre-step ─────────────────────────────────
            if (isSky) {
                const oldBlocksSky = oldOpacity > 0;
                const newBlocksSky = newOpacity > 0;

                if (!oldBlocksSky && newBlocksSky) {
                    // opaque block placed in a sky column — remove sky below
                    // first remove sky at this node
                    if (currentLevel > 0) {
                        writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
                        bqPush(_removalQueue, currentLevel, chunk, index, DIR_NONE);
                    }

                    // walk down removing sky=15 column light using neighbor refs
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
                        // dir=DIR_DOWN: light traveled downward to reach this node,
                        // so skip spreading back UP (matches minetest source_direction=4)
                        bqPush(_removalQueue, belowSky, curChunk, belowIdx, DIR_DOWN);
                        curLy--;
                    }
                } else if (oldBlocksSky && !newBlocksSky) {
                    // opaque block removed — check if sky can now reach here
                    // look up: is the block above sky-lit at 15?
                    // if no chunk above exists, the void IS the sky — treat as sky=15.
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
                            // dir=DIR_DOWN: light traveled downward, skip spreading UP
                            bqPush(_relightQueue, 15, curChunk, belowIdx, DIR_DOWN);
                            curLy--;
                        }
                    } else {
                        // no sky column above, but neighbors might provide sky light.
                        // compute new level from neighbors below.
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
                // if opacity didn't change w.r.t. sky blocking, no sky column work needed.
                // but there may still be sky light changes from opacity changes.
                // that's handled by the generic removal/relight below if needed.
                if (oldBlocksSky === newBlocksSky) {
                    // non-sky-blocking change — handle like block light
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
                // ── block light (r, g, b) ───────────────────────────
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

        // step 3: removal BFS
        unspreadChannel(voxels, registry, ch, _removalQueue, _relightQueue);

        // step 4: init-write — write relight seed values to the map
        // iterate _relightQueue and write each seed's level to the map.
        // we don't pop them — we need them for spreading. so we iterate
        // the parallel arrays directly.
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

        // step 5: spread BFS
        spreadChannel(voxels, registry, ch, _relightQueue);
    }
}

// ── helper: handle a non-sky channel change at a single node ────────

function handleChannelChange(
    voxels: Voxels,
    chunk: Chunk,
    index: number,
    lx: number,
    ly: number,
    lz: number,
    registry: BlockRegistry,
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

    // the node's new emission for this channel
    const newState = chunk.palette[chunk.data[index]!]!;
    const newEmission = chGetEmission(lightEmission[newState]!, ch);

    if (newOpacity >= 15) {
        // block is fully opaque — light cannot enter or be stored here.
        // zero any residual light first (push removal so neighbors re-evaluate).
        if (currentLevel > 0) {
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
            bqPush(removalQueue, currentLevel, chunk, index, DIR_NONE);
        }
        // opaque blocks can still emit (e.g. glowstone). write emission
        // into the node and seed spread so neighbors get lit.
        if (newEmission > 0) {
            writeChunkLight(voxels, chunk, index, chSet(chunk.light[index]!, ch, newEmission));
            bqPush(relightQueue, newEmission, chunk, index, DIR_NONE);
        }
    } else if (newOpacity < 15) {
        // block is transparent — figure out if light increased or decreased.
        // compute what the light level should be from neighbors + emission.
        const newLevel = computeNewLevel(chunk, lx, ly, lz, registry, ch, minSafeLight);

        if (currentLevel > 0 && newLevel < currentLevel) {
            // light decreased — zero and push to removal.
            // unspread will find the correct border seeds.
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, 0));
            bqPush(removalQueue, currentLevel, chunk, index, DIR_NONE);

            // if the node itself still emits, seed relight at emission
            // (NOT at newLevel — neighbors have stale light values that
            // unspread will clean up. only self-emission is trustworthy.)
            if (newEmission > 0) {
                bqPush(relightQueue, newEmission, chunk, index, DIR_NONE);
            }
        } else if (newLevel > currentLevel) {
            // light increased — seed directly
            writeChunkLight(voxels, chunk, index, chSet(packed, ch, newLevel));
            bqPush(relightQueue, newLevel, chunk, index, DIR_NONE);
        } else if (oldOpacity !== newOpacity && currentLevel === 0) {
            // opacity decreased (e.g. opaque → transparent), might now propagate.
            // neighbors are stable, so computeNewLevel is correct here.
            if (newLevel > 0) {
                bqPush(relightQueue, newLevel, chunk, index, DIR_NONE);
            }
        }
    }
}

// ── helper: compute what a node's light level should be ─────────────
//
// checks emission + max of (neighbor_level - decay) for all 6 neighbors.
// uses chunk refs for neighbor resolution — zero map lookups.
//
// minSafeLight (minetest step 0): neighbors with light below this
// threshold may have stale values from other batch changes. only
// neighbors at or above this threshold are trusted for seeding.
// for single-block changes this is 0 (all neighbors trusted).

function computeNewLevel(
    chunk: Chunk,
    lx: number,
    ly: number,
    lz: number,
    registry: BlockRegistry,
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

    // start with emission
    let best = chGetEmission(lightEmission[state]!, ch);

    // check sky column: if sky and block above has sky=15 and we're transparent
    if (isSky && opacity === 0) {
        resolveNeighbor(chunk, lx, ly, lz, DIR_UP);
        if (_nchunk) {
            const abovePacked = _nchunk.light[_nindex]!;
            const aboveSky = chGet(abovePacked, ch);
            if (aboveSky === 15) {
                // check above block's opacity — if transparent, we're in a sky column
                const aboveState = _nchunk.palette[_nchunk.data[_nindex]!]!;
                const aboveOpacity = lightOpacity[aboveState]!;
                if (aboveOpacity === 0) {
                    best = 15; // sky column continues
                }
            }
        } else {
            // no chunk above — the void IS the sky. sky column continues.
            best = 15;
        }
    }

    // check all 6 neighbors
    for (let dir = 0; dir < 6; dir++) {
        resolveNeighbor(chunk, lx, ly, lz, dir);
        if (!_nchunk) continue;

        const neighborPacked = _nchunk.light[_nindex]!;
        const neighborLevel = chGet(neighborPacked, ch);
        if (neighborLevel <= 1) continue;

        // min_safe_light filter: reject neighbors whose light might be
        // stale from other changes in the same batch
        if (neighborLevel < minSafeLight) continue;

        // sky going down through transparent: no decay
        const isSkyDown = isSky && dir === DIR_DOWN && opacity === 0;
        const decay = isSkyDown ? 0 : opacity < 1 ? 1 : opacity;
        const incoming = neighborLevel - decay;
        if (incoming > best) best = incoming;
    }

    return best < 0 ? 0 : best > 15 ? 15 : best;
}

// ── flushPendingLight ───────────────────────────────────────────────
//
// drains voxels.authority.changes.pendingNewChunks and pendingLight.
// new chunks get sky light seeded first (so the incremental block-change
// update sees correct sky state), then block changes are processed in
// batch. called by the engine between tick and network flush.

export function flushPendingLight(voxels: Voxels): void {
    const auth = voxels.authority;
    if (!auth) return;

    const changes = auth.changes;
    // when flood-fill lighting is disabled, setBlock / ensureChunk write
    // seed values inline and never enqueue. defensive: drop anything that
    // slipped through (e.g. if the toggle flipped mid-tick).
    if (!auth.floodFillLighting.enabled) {
        changes.pendingNewChunks.length = 0;
        changes.pendingLight.length = 0;
        return;
    }

    // seed sky light into any newly-created chunks before processing
    // block changes, so the incremental update operates on correct state.
    const newChunks = changes.pendingNewChunks;
    for (let i = 0; i < newChunks.length; i++) {
        seedNewChunkSky(voxels, newChunks[i]!);
    }
    newChunks.length = 0;

    const pending = changes.pendingLight;
    if (pending.length === 0) return;
    updateLightBatch(voxels, pending);
    pending.length = 0;
}

// ── updateLightOnBlockChange (single-block wrapper) ─────────────────
//
// thin wrapper around updateLightBatch for backward compatibility.
// callers that change multiple blocks at once should use updateLightBatch
// directly for better performance.

// TODO: just kill entirely?????? why do we have this?
export function updateLightOnBlockChange(voxels: Voxels, wx: number, wy: number, wz: number, oldStateId: number): void {
    updateLightBatch(voxels, [{ wx, wy, wz, oldStateId }]);
}
