// ── voxel light volume ──────────────────────────────────────────────
//
// GPU-resident per-chunk light, the storage half of `llm/plan-voxel-light-volume.md`.
// MECHANISM ONLY: this owns the arena, the slot pool and the residency grid, and
// knows nothing about who is resident. Policy lives in the backends' `consume`
// (voxel-resources-gpu.ts / voxel-resources-cpu.ts), exactly as `voxel-arena.ts`
// is driven from there.
//
// One `usage: 'storage'` buffer, sub-allocated in FIXED-SIZE tiles. Fixed size,
// so a plain slot allocator beats `OffsetAllocator`: zero fragmentation by
// construction, O(1) both ways, and `base = slot * TILE_U32S` is derivable so
// nothing stores an offset.
//
// gpucat lowers storage buffers to a buffer-texture on WebGL2
// (`webgl/textures.ts` storage read-lowering + `uploadStorageSpan`), so ONE
// buffer serves both backends. A tile is ~2457 u32 against a mirror width of
// `min(totalTexels, MAX_TEXTURE_SIZE)` (>= 2048), so a tile upload is one or two
// CONTIGUOUS horizontal runs, which is the shape drivers handle well. No
// alignment or padding needed; see the plan's "Upload shape".

import { BufferLifecycle, d, GpuBuffer } from 'gpucat';
import type { Vec3 } from 'math';
import { TILE_LIGHT_U32S, TILE_SOLID_U32S, writeChunkLightTile } from '../../core/voxels/light-lattice';
import { CHUNK_SIZE, type Chunk, NEIGHBOR_COUNT, type Voxels } from '../../core/voxels/voxels';

/** a tile is the padded cell region twice over: packed u16 light, two cells per
 *  u32, followed by one solidity BIT per cell. The consumer needs both, because
 *  a blend that cannot tell "solid" from "open but dark" leaks. */
/** light as two u16 per u32, then solidity as one bit per cell. 8704 B, exactly
 *  the chunk's own 16^3: no borrowed neighbour shell. */
export const TILE_U32S = TILE_LIGHT_U32S + TILE_SOLID_U32S; // 2176
export { TILE_LIGHT_U32S };

// ── residency grid ──────────────────────────────────────────────────
//
// Dense WRAPPING grid over absolute chunk coords. Wrapping (rather than a
// centred window) means the grid NEVER needs re-centring: a chunk's cell is
// fixed by its absolute coord, so chunks entering the window simply overwrite
// the cells of chunks that left.
//
// The dimension is a POWER OF TWO so the index is three ANDs, two shifts and two
// ORs, with no modulo or division, and `&` is correct for negative coords in
// two's complement where `%` is not.
//
// ALIASING: the map is many-to-one globally (chunk 0 and chunk `dim` share a
// cell), so a lookup for a chunk OUTSIDE the window reads whatever chunk owns
// that cell. That is plausible-looking WRONG light, not a miss. Every entry
// therefore carries its chunk coord and the lookup verifies before trusting it.

/**
 * ONE i32 per entry, not an ivec4 of {cx, cy, cz, payload}.
 *
 * A lookup is the hottest read in the engine - every terrain and entity vertex
 * does several - and storing the coords verbatim made each one FOUR storage
 * reads. Packing the slot and a coord CHECK into a single int makes it one, and
 * shrinks the grid 4x.
 *
 * Layout: 0 = absent. Otherwise bits 0..11 are `slot + 1`, bits 12..29 are six
 * bits per axis of `floor(c / dim)`.
 *
 * Six bits is enough because the check only has to separate ALIASES. Two chunks
 * share a grid cell exactly when their coords differ by a multiple of `dim`, so
 * `floor(c / dim)` differs between them; the check disambiguates a window 32
 * dims wide, far beyond any plausible eviction lag.
 */
const ENTRY_INTS = 1;
const ENTRY_SLOT_BITS = 12;
const ENTRY_SLOT_MASK = (1 << ENTRY_SLOT_BITS) - 1;
const PAYLOAD_ABSENT = 0;

/** six bits per axis of `floor(c / dim)`, packed. `>> shift` is floor-division
 *  for a power-of-two dim and is correct for negative coords. */
function coordCheck(v: LightVolume, cx: number, cy: number, cz: number): number {
    const s = v.shift;
    return ((cx >> s) & 0x3f) | (((cy >> s) & 0x3f) << 6) | (((cz >> s) & 0x3f) << 12);
}

export type LightVolume = {
    /** the shared tile arena, `TILE_U32S` u32 per slot. */
    buffer: GpuBuffer<d.Any>;
    /** CPU mirror; `buffer.array` aliases this. */
    data: Uint32Array;
    /** u16 view of the SAME buffer, so the tile write goes straight in rather
     *  than into scratch that then has to be packed. */
    dataU16: Uint16Array;
    /** fixed-size slot pool. */
    capacity: number;
    head: number;
    freeList: number[];
    /** slot -> the chunk coord occupying it, 3 ints per slot. Lets a full pool
     *  find its furthest occupant by scanning `capacity` entries rather than the
     *  whole residency grid. */
    slotChunk: Int32Array;
    /** wrapping residency grid, one packed i32 per cell. `gridBuffer.array`
     *  aliases this. */
    grid: Int32Array;
    /** the grid on the GPU: every consumer resolves a world cell through it. */
    gridBuffer: GpuBuffer<d.Any>;
    /** power-of-two grid edge. The shader reads `mask` / `dim` / `dim*dim`
     *  through the `LightVolumeConfig` uniform (voxel-light-sample). */
    dim: number;
    /** chunk radius the grid can represent. A chunk outside it ALIASES onto a
     *  cell a nearer chunk owns: the coord check turns the lookup into a clean
     *  miss, but the two keep clobbering each other's entry, so admission has to
     *  be bounded by this and not merely by the tile pool. */
    radius: number;
    mask: number;
    shift: number;
};

/** next power of two >= n. */
function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * `viewChunkRadius` sizes the residency grid (it must cover everything sampled);
 * `maxTiles` is a HARD bound on resident tiles: admitting a chunk into a full
 * pool evicts the furthest, so the pool never refuses and the chunks nearest the
 * action always hold light.
 */
export function createLightVolume(viewChunkRadius: number, maxTiles: number): LightVolume {
    if (maxTiles >= ENTRY_SLOT_MASK)
        throw new Error(`light volume: ${maxTiles} tiles exceeds the ${ENTRY_SLOT_BITS}-bit slot field`);
    const dim = nextPow2(viewChunkRadius * 2 + 1);
    const data = new Uint32Array(maxTiles * TILE_U32S);
    // gpucat's `count:` path picks Float32Array for `d.array(d.u32)`, which
    // silently rounds u32 writes to f32. pass an explicit Uint32Array via
    // `data:` so writes are bit-exact. (Same trap as voxel-arena.ts.)
    const buffer = new GpuBuffer(d.array(d.u32), {
        data: data as d.TypedArrayFor<d.Any>,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const grid = new Int32Array(dim * dim * dim * ENTRY_INTS);
    const gridBuffer = new GpuBuffer(d.array(d.i32), {
        data: grid as d.TypedArrayFor<d.Any>,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    return {
        buffer,
        data,
        dataU16: new Uint16Array(data.buffer),
        capacity: maxTiles,
        head: 0,
        freeList: [],
        slotChunk: new Int32Array(maxTiles * 3),
        grid,
        gridBuffer,
        dim,
        radius: viewChunkRadius,
        mask: dim - 1,
        shift: Math.log2(dim),
    };
}

/** branchless wrapping index. `&` is correct for negative coords. */
function gridIndex(v: LightVolume, cx: number, cy: number, cz: number): number {
    const m = v.mask;
    const b = v.shift;
    return (((cx & m) | ((cy & m) << b) | ((cz & m) << (2 * b))) * ENTRY_INTS) | 0;
}

// ── slot pool ───────────────────────────────────────────────────────

/**
 * A slot for the chunk at `(cx, cy, cz)`. The pool is a HARD BOUND that gives up
 * its furthest chunk rather than refusing a nearer one, so this never fails.
 *
 * Refusing was the bug it replaces. `allocateTile` used to return -1 on a full
 * pool, which made the pool first-come-first-served: whichever chunks happened
 * to arrive first held their slots forever and everything after them, including
 * the chunk under the camera, never got light at all. Because light gates
 * meshing, those chunks also never left `dirty.blocks`, so the AOI re-sorted a
 * permanently growing set every frame.
 */
export function allocateTile(v: LightVolume, cx: number, cy: number, cz: number): number {
    if (v.freeList.length > 0) return v.freeList.pop()!;
    if (v.head < v.capacity) return v.head++;

    // full: evict the occupant furthest from the chunk being admitted.
    let worst = -1;
    let worstDist = -1;
    for (let slot = 0; slot < v.capacity; slot++) {
        const i = slot * 3;
        const dx = v.slotChunk[i]! - cx;
        const dy = v.slotChunk[i + 1]! - cy;
        const dz = v.slotChunk[i + 2]! - cz;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist > worstDist) {
            worstDist = dist;
            worst = slot;
        }
    }
    if (worst < 0) return -1; // capacity 0
    clearResident(v, v.slotChunk[worst * 3]!, v.slotChunk[worst * 3 + 1]!, v.slotChunk[worst * 3 + 2]!);
    return worst;
}

export function freeTile(v: LightVolume, slot: number): void {
    if (slot >= 0) v.freeList.push(slot);
}

// ── residency ───────────────────────────────────────────────────────

/** queue one entry's four ints. Entries are touched a handful of times per frame
 *  (a drained chunk, an eviction), so per-entry ranges keep the grid upload
 *  proportional to churn instead of re-sending 64 kB - 512 kB every frame. */
function dirtyEntry(v: LightVolume, i: number): void {
    v.gridBuffer.addUpdateRange(i, ENTRY_INTS);
    v.gridBuffer.needsUpdate = true;
}

/** publish a chunk that owns a tile. */
export function setResidentTile(v: LightVolume, cx: number, cy: number, cz: number, slot: number): void {
    v.slotChunk[slot * 3] = cx;
    v.slotChunk[slot * 3 + 1] = cy;
    v.slotChunk[slot * 3 + 2] = cz;
    const i = gridIndex(v, cx, cy, cz);
    v.grid[i] = (slot + 1) | (coordCheck(v, cx, cy, cz) << ENTRY_SLOT_BITS);
    dirtyEntry(v, i);
}

/** only clears the cell if this chunk still owns it (another chunk may have
 *  wrapped onto it since). */
export function clearResident(v: LightVolume, cx: number, cy: number, cz: number): void {
    const i = gridIndex(v, cx, cy, cz);
    const entry = v.grid[i]!;
    if (entry === PAYLOAD_ABSENT || entry >>> ENTRY_SLOT_BITS !== coordCheck(v, cx, cy, cz)) return;
    v.grid[i] = PAYLOAD_ABSENT;
    dirtyEntry(v, i);
}

/** whether the grid can represent this chunk at all, given the camera. Outside
 *  the radius the wrapping index aliases onto a nearer chunk's cell. */
export function withinLightGrid(v: LightVolume, cx: number, cy: number, cz: number, camChunk: Vec3): boolean {
    return (
        Math.abs(cx - camChunk[0]) <= v.radius && Math.abs(cy - camChunk[1]) <= v.radius && Math.abs(cz - camChunk[2]) <= v.radius
    );
}

/** the verified payload, or 0 when this chunk is not resident. Verification is
 *  what turns an aliased read into a clean miss instead of wrong light. */
export function lookupPayload(v: LightVolume, cx: number, cy: number, cz: number): number {
    const entry = v.grid[gridIndex(v, cx, cy, cz)]!;
    if (entry === PAYLOAD_ABSENT || entry >>> ENTRY_SLOT_BITS !== coordCheck(v, cx, cy, cz)) return PAYLOAD_ABSENT;
    return entry & ENTRY_SLOT_MASK;
}

export function payloadSlot(payload: number): number {
    return payload - 1;
}

// ── upload ──────────────────────────────────────────────────────────

/** where a slot's light cells start, as a u16 index. */
export function tileLightBase(slot: number): number {
    return slot * TILE_U32S * 2;
}

/** where a slot's solidity bitset starts, as a u32 index. */
export function tileSolidBase(slot: number): number {
    return slot * TILE_U32S + TILE_LIGHT_U32S;
}

/** read one cell's packed light back, for tests and validation. */
export function readCell(v: LightVolume, slot: number, cellIdx: number): number {
    return v.dataU16[tileLightBase(slot) + cellIdx]!;
}

/** read one cell's solidity back, for tests and validation. */
export function readCellSolid(v: LightVolume, slot: number, cellIdx: number): number {
    return (v.data[tileSolidBase(slot) + (cellIdx >>> 5)]! >>> (cellIdx & 31)) & 1;
}

// ── drain ───────────────────────────────────────────────────────────
//
// The "what is in the slot" half of the ownership split (see the plan). This
// rewrites slots that already exist and publishes residency; it NEVER decides
// who is resident. Allocation on admission and release on eviction belong to
// each backend's `consume`.
//
// Budgeted per frame, and the budget is the ONLY bound: there is no probe and no
// priority pass, so per-frame cost is `bakeBudget` bakes and nothing else.

/**
 * Rebake and upload light tiles from `voxels.dirty.lightVolume` until
 * `budgetMs` is spent. Returns the number baked.
 *
 * A TIME budget rather than a tile count. One bake measured ~0.29 ms on this
 * machine, but that is one machine: the same fixed count is a comfortable
 * fraction of a frame on a desktop and a stall on the Chromebook this engine
 * targets. Time self-calibrates. A fixed count is the same idea pre-divided by
 * an assumed cost.
 *
 * Always bakes at least one, so the queue cannot livelock on a frame that has
 * already overspent elsewhere.
 *
 * Iterates the dirty Set and deletes as it goes, so the cost is O(baked), not
 * O(queue). An earlier version built and SORTED a nearest-first array over the
 * whole queue every frame, on top of an unbounded uniform probe: with a backlog
 * of N that is O(N log N) of sorting plus O(N) probes per frame while only a
 * handful of chunks left the queue, which is what stalled large maps.
 *
 * Insertion order rather than distance order. Priority only
 * mattered while the queue was hopeless; a queue that drains does not need it.
 */
/** frames a chunk waits for its full 26-neighbourhood before baking anyway.
 *  Mirrors the AOI's `NEIGHBOURHOOD_GRACE_FRAMES`: the view frontier never
 *  completes (its outer neighbours are past the stream radius), so a pure
 *  completeness gate would leave that ring permanently unlit, and light gates
 *  meshing. */
const NEIGHBOURHOOD_GRACE_FRAMES = 4;

/** nearest-first shortlist, reused across drains. Fixed size, so selecting the
 *  nearest candidates is one O(queue) pass with a cheap compare, rather than an
 *  O(queue log queue) sort plus an allocation per entry every frame. */
const SHORTLIST = 32;
const _shortChunk: (Chunk | null)[] = new Array(SHORTLIST).fill(null);
const _shortScore = new Float64Array(SHORTLIST);
let _shortCount = 0;

function shortlistReset(): void {
    _shortCount = 0;
}

/** insert if nearer than the worst kept. Most candidates fail the first compare,
 *  so the common cost is one comparison per queue entry. */
function shortlistOffer(chunk: Chunk, score: number): void {
    if (_shortCount === SHORTLIST && score >= _shortScore[_shortCount - 1]!) return;
    let i = _shortCount < SHORTLIST ? _shortCount++ : SHORTLIST - 1;
    while (i > 0 && _shortScore[i - 1]! > score) {
        _shortScore[i] = _shortScore[i - 1]!;
        _shortChunk[i] = _shortChunk[i - 1]!;
        i--;
    }
    _shortScore[i] = score;
    _shortChunk[i] = chunk;
}

/**
 * Rebake and upload light tiles until `budgetMs` is spent. Returns the number
 * baked.
 *
 * TWO QUEUES, because a long queue and a latency-critical edit cannot share an
 * order. `lightVolumeUrgent` holds chunks whose OWN light changed - a block the
 * player just placed - and drains first and entirely. The bulk queue is
 * apron work (a neighbour arrived) and drains NEAREST FIRST.
 *
 * Insertion order was tried, on the reasoning that a queue which drains does
 * not need priority. That is false on world join, where
 * the queue is thousands deep and an edit lands at the back of it.
 *
 * A TIME budget rather than a tile count: the same fixed count is a comfortable
 * fraction of a frame on a desktop and a stall on the Chromebook this engine
 * targets. Always bakes at least one, so the queue cannot livelock on a frame
 * that has already overspent elsewhere.
 */
export function drainLightVolume(v: LightVolume, voxels: Voxels, cameraPos: Vec3, budgetMs: number, frame: number): number {
    const urgent = voxels.dirty.lightVolumeUrgent;
    const dirty = voxels.dirty.lightVolume;
    if (urgent.size === 0 && dirty.size === 0) return 0;

    const deadline = performance.now() + budgetMs;
    let baked = 0;

    for (const chunk of urgent) {
        urgent.delete(chunk);
        dirty.delete(chunk);
        if (bakeOne(v, voxels, chunk, frame) === 1) baked++;
        if (performance.now() >= deadline) return baked;
    }

    while (dirty.size > 0) {
        if (baked > 0 && performance.now() >= deadline) break;
        shortlistReset();
        for (const chunk of dirty) {
            const dx = chunk.wx + CHUNK_SIZE * 0.5 - cameraPos[0];
            const dy = chunk.wy + CHUNK_SIZE * 0.5 - cameraPos[1];
            const dz = chunk.wz + CHUNK_SIZE * 0.5 - cameraPos[2];
            shortlistOffer(chunk, dx * dx + dy * dy + dz * dz);
        }
        if (_shortCount === 0) break;
        let progressed = false;
        for (let i = 0; i < _shortCount; i++) {
            const chunk = _shortChunk[i]!;
            if (!dirty.has(chunk)) continue;
            const outcome = bakeOne(v, voxels, chunk, frame);
            if (outcome === -1) {
                dirty.delete(chunk); // never admitted, so never retried
                progressed = true;
                continue;
            }
            if (outcome === 0) continue; // deferred: stays queued
            dirty.delete(chunk);
            baked++;
            progressed = true;
            if (performance.now() >= deadline) return baked;
        }
        if (!progressed) break;
    }
    return baked;
}

/** 1 baked, 0 deferred (stays queued), -1 refused (drop from the queue). */
function bakeOne(v: LightVolume, voxels: Voxels, chunk: Chunk, frame: number): number {
    const { cx, cy, cz } = chunk;
    const prev = lookupPayload(v, cx, cy, cz);

    // ADMISSION is the AOI's alone. A chunk with no tile that the AOI has not
    // asked for is not rendered, so giving it a slot only takes one from a chunk
    // that is - which is how a full pool starts evicting chunks it immediately
    // needs back.
    if (prev === 0 && !chunk.lightWanted) return -1;

    // DEFER a RE-bake while the 26-neighbourhood is still filling in. The apron
    // re-dirties a chunk on every neighbour arrival, so a streaming chunk would
    // bake up to 27 times before settling; waiting collapses that to two. The
    // FIRST bake is never deferred, because light gates meshing and a chunk with
    // no tile at all would be invisible. Nor is an urgent one: a deferred edit is
    // a visible delay on the block the player just broke.
    if (!chunk.lightUrgent && prev > 0 && chunk.knownNeighbourCount < NEIGHBOR_COUNT) {
        if (chunk.lightWaitSince < 0) chunk.lightWaitSince = frame;
        if (frame - chunk.lightWaitSince <= NEIGHBOURHOOD_GRACE_FRAMES) return 0;
    }
    chunk.lightWaitSince = -1;
    chunk.lightUrgent = false;

    const slot = prev > 0 ? payloadSlot(prev) : allocateTile(v, cx, cy, cz);
    if (slot < 0) return 0; // capacity 0 only

    // straight into the tile: no scratch, no pack step, and no neighbours -
    // a tile is exactly this chunk's cells.
    writeChunkLightTile(voxels, chunk, v.dataU16, tileLightBase(slot), v.data, tileSolidBase(slot));
    v.buffer.addUpdateRange(slot * TILE_U32S, TILE_U32S);
    v.buffer.needsUpdate = true;
    setResidentTile(v, cx, cy, cz, slot);
    return 1;
}

/** release whatever a chunk holds and unpublish it. Called from each backend's
 *  eviction path, AFTER its mesh is gone (light is the root residency fact). */
export function evictChunkLight(v: LightVolume, cx: number, cy: number, cz: number): void {
    const payload = lookupPayload(v, cx, cy, cz);
    if (payload > 0) freeTile(v, payloadSlot(payload));
    clearResident(v, cx, cy, cz);
}

/** key-addressed eviction, for the producers' `consume` which works in
 *  `"cx,cy,cz"` chunk keys. */
export function evictChunkLightByKey(v: LightVolume, key: string): void {
    const a = key.indexOf(',');
    const b = key.indexOf(',', a + 1);
    if (a < 0 || b < 0) return;
    evictChunkLight(v, +key.slice(0, a), +key.slice(a + 1, b), +key.slice(b + 1));
}
