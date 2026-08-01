// voxel-arena.ts — SHARED voxel arena/packer/geometry data model (backend-neutral).
//
// Split out of the former voxel-resources.ts: structs (ChunkInfo/VisibleQuad/
// ChunkCullRecord/VisibleChunk + strides), the SegmentArena + QuadArena, the
// per-pass SectionTable, the ArenaPacker (residency, eviction, cull records),
// arena budgets, and the lightweight lifecycle helpers (clearArena, removeChunkMesh).
//
// Value-imported by BOTH backends + voxel-visuals + the offline paths. This file
// must never value-import a backend producer (gpu-frame / cpu-frame) — the WebGPU
// compute chain lives in ./gpu-frame, imported only by render/webgpu/*.

import { BufferLifecycle, DrawIndirect, d, GpuBuffer, layoutStrideOf, packTo, struct } from 'gpucat';
import type { Box3, Vec3 } from 'mathcat';
import { type ChunkMeshResult, type PassMesh, QUAD_STRIDE_U32S } from '../../../core/voxels/chunk-mesher';
import { CHUNK_SIZE } from '../../../core/voxels/voxels';
import { createOffsetAllocator, type OffsetAllocator, oaAllocate, oaFree, oaStorageReport } from '../offset-allocator';
import * as Performance from '../../../client/performance';
import type { VoxelPass } from './voxel-material';

export const PASSES: readonly VoxelPass[] = ['opaque', 'transparent', 'translucent'];

// ── ChunkInfo ───────────────────────────────────────────────────────
//
// per-section GPU side-table. one entry per occupied SectionTable slot;
// the VS reads chunkInfo[slot] to recover the chunk's worldspace origin
// and arena base. tightly packed (16B) so a workgroup-coherent read of
// adjacent slots stays in cache.
//
// arenaBase = the section's dataStart in the shared quadArena. combined
// with VisibleQuad.localIdx in the VS to produce the absolute realQuadId
// for quads / light lookups.

export const ChunkInfo = /* @__PURE__ */ struct('VoxelChunkInfo', {
    origin: d.vec3f,
    arenaBase: d.u32,
});

// ── VisibleQuad ─────────────────────────────────────────────────────
//
// per-frame GPU-built table: one entry per visible quad. VS reads
// visibleQuads[instanceIndex] → (slot, localIdx), derefs chunkInfo[slot]
// for arenaBase + origin, and computes realQuadId = arenaBase + localIdx
// to index quads / light.

export const VisibleQuad = /* @__PURE__ */ struct('VoxelVisibleQuad', {
    slot: d.u32,
    localIdx: d.u32,
});

// ── ChunkCullRecord ─────────────────────────────────────────────────
//
// GPU cull input, one entry per resident chunk, mirroring `packer.chunks`
// 1:1 (same array index). Consumed by the cull compute (frustum, once per
// chunk) and — for survivors — the emit compute (per-facing back-face cull
// + quad write).
//
// Chunk coords are INTEGERS: the cull/emit reconstruct the section center
// camera-relative (`(cx - camCx) * CHUNK_SIZE …`), keeping the frustum math
// in a small, f32-exact domain even at Minecraft world scale (absolute f32
// world coords lose precision past ~2^24).
//
// Per-pass section slots index that pass's SectionTable / metaBuffer /
// visibleQuads; -1 means the chunk has no geometry in that pass.

export const ChunkCullRecord = /* @__PURE__ */ struct('VoxelChunkCullRecord', {
    cx: d.i32,
    cy: d.i32,
    cz: d.i32,
    opaqueSlot: d.i32,
    transparentSlot: d.i32,
    translucentSlot: d.i32,
});

export const CHUNK_CULL_RECORD_STRIDE = /* @__PURE__ */ layoutStrideOf(ChunkCullRecord);
const CHUNK_CULL_RECORD_U32S = CHUNK_CULL_RECORD_STRIDE / 4;

// ── VisibleChunk ────────────────────────────────────────────────────
//
// Cull output: one entry per *surviving* chunk (compacted). Carries the
// per-pass section slots, the camera-relative section center (so the emit /
// count passes can run the per-facing back-face cone-cull without re-reading
// camera state), and the distance bucket for Level-A ordering. `relCenter.w`
// is unused padding.

export const VisibleChunk = /* @__PURE__ */ struct('VoxelVisibleChunk', {
    opaqueSlot: d.i32,
    transparentSlot: d.i32,
    translucentSlot: d.i32,
    /** coarse distance bucket [0, BUCKET_COUNT): 0 = nearest. */
    bucket: d.u32,
    relCenter: d.vec4f,
});

// Coarse distance buckets for section ordering. Chunks are bucketed by distance
// (even in distance, via sqrt), then instance ranges are assigned bucket-by-
// bucket: ascending → front-to-back (opaque/transparent, early-Z), descending →
// back-to-front (translucent inter-section).
export const BUCKET_COUNT = 256;

export const VISIBLE_QUAD_STRIDE = /* @__PURE__ */ layoutStrideOf(VisibleQuad);
export const DRAW_INDIRECT_STRIDE = /* @__PURE__ */ layoutStrideOf(DrawIndirect);

// ── SegmentArena ────────────────────────────────────────────────────
//
// fixed-count, slot-indexed allocator over N lock-stepped GpuBuffer
// streams. each stream has its own `perSlot` element count but slot
// indices are shared, allocating slot range [s, s+k) gives you the
// same range in every stream.
//
// suballocator is OffsetAllocator (TLSF-style, 256 bins, 3-bit
// mantissa). constant-time alloc/free, ≤12.5% per-allocation internal
// fragmentation. handles are stored in `slotToNode` so callers keep
// using the slot index as the alloc identity (no API ripple).

export type StreamSpec = {
    schema: d.Any;
    perSlot: number;
};

const DEFAULT_MAX_ALLOCS = 16_384;

export type SegmentArena<S extends Record<string, StreamSpec>> = {
    slotCount: number;
    streams: S;
    buffers: { [K in keyof S]: GpuBuffer };
    allocator: OffsetAllocator;
    /** slot offset → OffsetAllocator node index, so arenaFree(start) can
     *  rebuild the handle without callers tracking it. */
    slotToNode: Map<number, number>;
};

export function createSegmentArena<S extends Record<string, StreamSpec>>(opts: {
    slotCount: number;
    streams: S;
    maxAllocs?: number;
}): SegmentArena<S> {
    const { slotCount, streams } = opts;
    const buffers = {} as { [K in keyof S]: GpuBuffer };
    for (const key in streams) {
        const spec = streams[key]!;
        // gpucat's `count:` path picks Float32Array for `d.array(d.u32)`,
        // which silently rounds u32 writes to f32. provide an explicit
        // Uint32Array via `data:` so .set(Uint32...) is a bit-exact copy.
        const elementCount = slotCount * spec.perSlot;
        buffers[key] = new GpuBuffer(d.array(spec.schema), {
            data: new Uint32Array(elementCount) as d.TypedArrayFor<d.Any>,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });
    }

    return {
        slotCount,
        streams,
        buffers,
        allocator: createOffsetAllocator(slotCount, opts.maxAllocs ?? DEFAULT_MAX_ALLOCS),
        slotToNode: new Map(),
    };
}

export function arenaAlloc<S extends Record<string, StreamSpec>>(a: SegmentArena<S>, slots: number): number {
    if (slots <= 0) throw new Error('SegmentArena.alloc: slots must be > 0');
    const h = oaAllocate(a.allocator, slots);
    if (!h) {
        const r = oaStorageReport(a.allocator);
        throw new Error(
            `SegmentArena OOM: need ${slots}, totalFree ${r.totalFree}, largestFree ${r.largestFree} (/${a.slotCount})`,
        );
    }
    const prev = a.slotToNode.get(h.offset);
    if (prev !== undefined) {
        // OA handed back an offset whose slotToNode entry was never cleared
        // by a matching arenaFree, bookkeeping drift. (See [voxel-drift].)
        throw new Error(
            `[voxel-drift][alloc-collision] arenaAlloc returned offset=${h.offset} but slotToNode still holds node=${prev}; new node=${h.node}, slots=${slots}`,
        );
    }
    a.slotToNode.set(h.offset, h.node);
    return h.offset;
}

export function arenaFree<S extends Record<string, StreamSpec>>(a: SegmentArena<S>, start: number): void {
    const node = a.slotToNode.get(start);
    if (node === undefined) {
        // forensic dump: nearest 5 live offsets on either side.
        const offsets = [...a.slotToNode.keys()].sort((x, y) => x - y);
        let pivot = 0;
        while (pivot < offsets.length && offsets[pivot]! < start) pivot++;
        const lo = Math.max(0, pivot - 5);
        const hi = Math.min(offsets.length, pivot + 5);
        const near = offsets
            .slice(lo, hi)
            .map((o) => `${o}=>node${a.slotToNode.get(o)}`)
            .join(',');
        throw new Error(
            `[voxel-drift][free-miss] SegmentArena.free: no live alloc at slot ${start} (nearbyLive=[${near}], totalLive=${offsets.length})`,
        );
    }
    a.slotToNode.delete(start);
    oaFree(a.allocator, { offset: start, node });
}

export type SegmentArenaReport = {
    slotCount: number;
    used: number;
    totalFree: number;
    largestFree: number;
    allocs: number;
};

export function arenaReport<S extends Record<string, StreamSpec>>(a: SegmentArena<S>): SegmentArenaReport {
    const r = oaStorageReport(a.allocator);
    return {
        slotCount: a.slotCount,
        used: a.slotCount - r.totalFree,
        totalFree: r.totalFree,
        largestFree: r.largestFree,
        allocs: a.slotToNode.size,
    };
}

export function arenaWrite<S extends Record<string, StreamSpec>, K extends keyof S>(
    a: SegmentArena<S>,
    stream: K,
    slotStart: number,
    slots: number,
    src: d.TypedArrayFor<d.Any>,
): void {
    const buf = a.buffers[stream];
    const perSlot = a.streams[stream]!.perSlot;
    const elementOffset = slotStart * perSlot;
    const elementCount = slots * perSlot;
    const dst = buf.array as d.TypedArrayFor<d.Any>;
    dst.set(src.subarray(0, elementCount), elementOffset);
    buf.addUpdateRange(elementOffset, elementCount);
}

export function arenaDispose<S extends Record<string, StreamSpec>>(a: SegmentArena<S>): void {
    for (const key in a.buffers) a.buffers[key].dispose();
}

// ── arena factories ─────────────────────────────────────────────────

const BYTES_PER_QUAD = QUAD_STRIDE_U32S * 4; // 56, interleaved header (40 B) + light (16 B)

export type QuadArenaStreams = {
    quads: { schema: d.u32; perSlot: number };
};

export type QuadArena = SegmentArena<QuadArenaStreams>;

export function createQuadArena(byteBudget: number, maxAllocs?: number): QuadArena {
    const slots = Math.max(1024, Math.floor(byteBudget / BYTES_PER_QUAD));
    return createSegmentArena({
        slotCount: slots,
        maxAllocs,
        streams: {
            quads: { schema: d.u32, perSlot: QUAD_STRIDE_U32S },
        },
    });
}

// ── SectionTable ────────────────────────────────────────────────────

// GPU-resident per-slot cull metadata, the device mirror of
// `cpuFaceOffsets` + `cpuFaceCounts`:
//   [faceOffsets[0..6], faceCounts[0..6]].
// Read by the GPU cull/emit/expand computes to size + back-face-cull each of the
// 7 facing slices (and, for translucent, to total the section's quads). Unused by
// the VS (which reads ChunkInfo for origin + arenaBase instead).
export const SECTION_META_U32S = 14;

export type SectionEntryFields = {
    originX: number;
    originY: number;
    originZ: number;
    dataStart: number;
    dataCount: number;
    faceOffsets: ArrayLike<number>;
    faceCounts: ArrayLike<number>;
    flags: number;
};

export type SectionTable = {
    readonly slotCount: number;
    readonly buffer: GpuBuffer;
    readonly entryU32s: number;
    /** CPU mirrors of the per-slot fields cullCPU needs to size + emit
     *  slices. AABB + iteration order live on the per-chunk `ChunkAlloc`
     *  (shared across passes), frustum cull runs once per chunk now. */
    readonly cpuDataCount: Uint32Array; // 1 per slot (translucent slice quadCount)
    readonly cpuFaceOffsets: Uint32Array; // 7 per slot (opaque/transparent localBase per facing)
    readonly cpuFaceCounts: Uint32Array; // 7 per slot
    /** GPU mirror of cpuFaceOffsets+cpuFaceCounts, SECTION_META_U32S per slot.
     *  Read by the GPU cull compute; never touched by the draw-time VS. */
    readonly metaBuffer: GpuBuffer;
    allocSlot(): number;
    freeSlot(slot: number): void;
    writeEntry(slot: number, entry: SectionEntryFields): void;
    dispose(): void;
    readonly used: () => number;
};

export function createSectionTable(opts: { name: string; slotCount: number }): SectionTable {
    const { slotCount } = opts;
    // GPU buffer holds tight ChunkInfo (16B/entry): origin + arenaBase.
    // everything else cull needs (faceOffsets, faceCounts, dataCount,
    // dataStart) lives in CPU mirrors below. AABB lives on ChunkAlloc.
    const buffer = new GpuBuffer(d.array(ChunkInfo), {
        count: slotCount,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const arrF32 = buffer.array as Float32Array;
    const dataU32 = new Uint32Array(arrF32.buffer, arrF32.byteOffset, arrF32.length);
    const entryU32s = arrF32.length / slotCount;

    // GPU mirror of the face offsets/counts (14 u32/slot) for the GPU cull
    // compute. Explicit `data:` (not `count:`) so the backing store is a
    // Uint32Array, keeping u32 writes bit-exact (the `count:` path would pick
    // Float32Array and round them).
    const metaBuffer = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(slotCount * SECTION_META_U32S),
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const metaU32 = metaBuffer.array as Uint32Array;

    const freeStack: number[] = new Array(slotCount);
    for (let i = 0; i < slotCount; i++) freeStack[i] = slotCount - 1 - i;
    const cpuDataCount = new Uint32Array(slotCount);
    const cpuFaceOffsets = new Uint32Array(slotCount * 7);
    const cpuFaceCounts = new Uint32Array(slotCount * 7);
    let used = 0;

    function allocSlot(): number {
        const slot = freeStack.pop();
        if (slot === undefined) throw new Error(`SectionTable OOM at ${slotCount}`);
        used++;
        return slot;
    }

    function freeSlot(slot: number): void {
        const base = slot * entryU32s;
        for (let i = 0; i < entryU32s; i++) dataU32[base + i] = 0;
        buffer.addUpdateRange(base, entryU32s);

        // zero CPU mirrors so a stale read can't sneak through.
        cpuDataCount[slot] = 0;
        const facingBase = slot * 7;
        for (let i = 0; i < 7; i++) {
            cpuFaceOffsets[facingBase + i] = 0;
            cpuFaceCounts[facingBase + i] = 0;
        }

        // zero the GPU cull mirror too (a freed slot must contribute nothing).
        const metaBase = slot * SECTION_META_U32S;
        for (let i = 0; i < SECTION_META_U32S; i++) metaU32[metaBase + i] = 0;
        metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);

        freeStack.push(slot);
        used--;
    }

    function writeEntry(slot: number, entry: SectionEntryFields): void {
        const base = slot * entryU32s;
        // GPU side-table only carries origin + arenaBase. cull mirrors below
        // hold faceOffsets / faceCounts / dataCount, none of which the VS needs
        // at draw time.
        packTo(ChunkInfo, dataU32, base * 4, {
            origin: [entry.originX, entry.originY, entry.originZ],
            arenaBase: entry.dataStart,
        });
        buffer.addUpdateRange(base, entryU32s);

        cpuDataCount[slot] = entry.dataCount;
        const facingBase = slot * 7;
        const metaBase = slot * SECTION_META_U32S;
        for (let i = 0; i < 7; i++) {
            const off = entry.faceOffsets[i]!;
            const cnt = entry.faceCounts[i]!;
            cpuFaceOffsets[facingBase + i] = off;
            cpuFaceCounts[facingBase + i] = cnt;
            // GPU mirror layout: [faceOffsets[0..6], faceCounts[0..6]].
            metaU32[metaBase + i] = off;
            metaU32[metaBase + 7 + i] = cnt;
        }
        metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);
    }

    function dispose(): void {
        buffer.dispose();
        metaBuffer.dispose();
    }

    return {
        slotCount,
        buffer,
        entryU32s,
        cpuDataCount,
        cpuFaceOffsets,
        cpuFaceCounts,
        metaBuffer,
        allocSlot,
        freeSlot,
        writeEntry,
        dispose,
        used: () => used,
    };
}

// ── ArenaPacker ─────────────────────────────────────────────────────

export type PassAlloc = {
    sectionSlot: number;
    dataStart: number;
    dataCount: number;
};

export type ChunkAlloc = {
    opaque: PassAlloc | null;
    transparent: PassAlloc | null;
    translucent: PassAlloc | null;
    /** chunk-level AABB, shared across all 3 passes. */
    aabb: Box3;
    /** chunk coord key, kept so eviction can drop this chunk from
     *  `packer.residentKeys` without re-deriving it. */
    key: string;
    /** this alloc's index in `packer.chunks` (== its cull-record index).
     *  Maintained across push/swap-pop so record updates + eviction are O(1).
     *  -1 until first push. */
    chunkIndex: number;
};

export type ArenaPacker = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, SectionTable>;
    /** keyed by bare chunk coord key. The arena holds one world at a time (the
     *  active room), so coords are unique — no namespacing. */
    allocs: Map<string, ChunkAlloc>;
    /** the resident chunk keys, so the caller's reconcile + clearArena can iterate
     *  residency without walking `allocs`' insertion order. */
    residentKeys: Set<string>;
    /** dense list of currently-held ChunkAllocs, in insertion order.
     *  cullCPU iterates this for the frustum + back-face pass.
     *  swap-pop on evict, push on first upsert. */
    chunks: ChunkAlloc[];
    /** per-chunk origin (worldspace min corner). populated on upsertChunk;
     *  consumed by OOM eviction policy (farthest-from-camera). */
    origins: Map<string, [number, number, number]>;
    /** the camera position, so eviction measures distance in world space. null in
     *  the offline path (no camera -> evict-first). */
    camera: Vec3 | null;
    /** true if translucent geometry mutated since the sort last ran. The
     *  translucent counting-sort persists its output between gated re-runs, so a
     *  mutation must force a re-sort — else the persisted `{slot, localIdx}` dangle
     *  onto reallocated/zeroed arena data. Read + cleared by `updateCull`'s gate. */
    translucentDirty: boolean;
    /** translucent sort re-run gate: the (WebGPU) sort output persists across
     *  frames and only re-runs when the order could change (translation /
     *  rotation / arena mutation). `valid` false forces the first run (e.g. after
     *  `packerClearAll` cleared the arena on a room swap). Written by the WebGPU
     *  frame graph (`updateTranslucentSortGate`); cleared here so the arena owns
     *  the "must re-sort" signal regardless of backend. */
    tsortGate: { valid: boolean; camX: number; camY: number; camZ: number; fwdX: number; fwdY: number; fwdZ: number };
    /** chunk keys evicted under memory pressure this frame, so the caller
     *  re-dirties them (self-heal) instead of leaving a hole. */
    evicted: Set<string>;
    /** GPU cull input, one `ChunkCullRecord` per resident chunk, kept in
     *  lockstep with `chunks` by array index (push/swap-pop mirror below).
     *  Dispatched over `chunks.length` by the cull compute. */
    cullRecordsBuffer: GpuBuffer;
    /** u32 view over `cullRecordsBuffer.array` for bit-exact int writes. */
    cullRecordsU32: Uint32Array;
};

export function createArenaPacker(opts: { quadArena: QuadArena; tables: Record<VoxelPass, SectionTable> }): ArenaPacker {
    // A chunk occupies ≥1 section slot across the 3 tables, so the live chunk
    // count is bounded by the sum of table capacities.
    const maxChunks = opts.tables.opaque.slotCount + opts.tables.transparent.slotCount + opts.tables.translucent.slotCount;
    const cullRecordsBuffer = new GpuBuffer(d.array(ChunkCullRecord), {
        count: maxChunks,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const recF32 = cullRecordsBuffer.array as Float32Array;
    const cullRecordsU32 = new Uint32Array(recF32.buffer, recF32.byteOffset, recF32.length);
    return {
        quadArena: opts.quadArena,
        tables: opts.tables,
        allocs: new Map(),
        residentKeys: new Set(),
        chunks: [],
        origins: new Map(),
        camera: null,
        translucentDirty: false,
        tsortGate: { valid: false, camX: 0, camY: 0, camZ: 0, fwdX: 0, fwdY: 0, fwdZ: 0 },
        evicted: new Set(),
        cullRecordsBuffer,
        cullRecordsU32,
    };
}

/** Write the cull record for the chunk currently at `index` in `packer.chunks`
 *  (records mirror that array 1:1). `origin` is the chunk's world min-corner;
 *  chunk coords are `origin / CHUNK_SIZE`. Signed slots (-1 = pass absent) round-
 *  trip through the u32 view bit-exactly. */
function writeChunkCullRecord(packer: ArenaPacker, index: number, origin: [number, number, number], alloc: ChunkAlloc): void {
    const base = index * CHUNK_CULL_RECORD_U32S;
    const u = packer.cullRecordsU32;
    u[base + 0] = origin[0] / CHUNK_SIZE;
    u[base + 1] = origin[1] / CHUNK_SIZE;
    u[base + 2] = origin[2] / CHUNK_SIZE;
    u[base + 3] = alloc.opaque ? alloc.opaque.sectionSlot : -1;
    u[base + 4] = alloc.transparent ? alloc.transparent.sectionSlot : -1;
    u[base + 5] = alloc.translucent ? alloc.translucent.sectionSlot : -1;
    packer.cullRecordsBuffer.addUpdateRange(base, CHUNK_CULL_RECORD_U32S);
}

/** Copy the cull record at `from` to `to` (mirrors a swap-pop in `chunks`). */
function moveChunkCullRecord(packer: ArenaPacker, from: number, to: number): void {
    const u = packer.cullRecordsU32;
    const fromBase = from * CHUNK_CULL_RECORD_U32S;
    const toBase = to * CHUNK_CULL_RECORD_U32S;
    for (let i = 0; i < CHUNK_CULL_RECORD_U32S; i++) u[toBase + i] = u[fromBase + i];
    packer.cullRecordsBuffer.addUpdateRange(toBase, CHUNK_CULL_RECORD_U32S);
}

function packerFreePass(packer: ArenaPacker, pass: VoxelPass, a: PassAlloc): void {
    arenaFree(packer.quadArena, a.dataStart);
    if (pass === 'translucent') packer.translucentDirty = true;
    packer.tables[pass].freeSlot(a.sectionSlot);
}

export function packerUpsertChunk(
    packer: ArenaPacker,
    chunkKey: string,
    origin: [number, number, number],
    mesh: ChunkMeshResult,
): void {
    const prev = packer.allocs.get(chunkKey);
    // reuse the prev alloc object (and its slot in packer.chunks) on
    // re-upsert; aabb is overwritten below from mesh.aabb.
    const next: ChunkAlloc = prev ?? {
        opaque: null,
        transparent: null,
        translucent: null,
        aabb: [0, 0, 0, 0, 0, 0],
        key: chunkKey,
        chunkIndex: -1,
    };
    const meshAabb = mesh.aabb;
    if (meshAabb) {
        next.aabb[0] = meshAabb.min[0];
        next.aabb[1] = meshAabb.min[1];
        next.aabb[2] = meshAabb.min[2];
        next.aabb[3] = meshAabb.max[0];
        next.aabb[4] = meshAabb.max[1];
        next.aabb[5] = meshAabb.max[2];
    } else {
        next.aabb[0] = 0;
        next.aabb[1] = 0;
        next.aabb[2] = 0;
        next.aabb[3] = 0;
        next.aabb[4] = 0;
        next.aabb[5] = 0;
    }

    for (const pass of PASSES) {
        const passMesh: PassMesh | null = mesh[pass];
        const cur = next[pass];

        if (!passMesh || passMesh.quadCount === 0) {
            if (cur) {
                packerFreePass(packer, pass, cur);
                next[pass] = null;
            }
            continue;
        }

        const needQuads = passMesh.quadCount;

        // free cur's prior quad range up front (re-upsert reallocates it below).
        if (cur) arenaFree(packer.quadArena, cur.dataStart);
        const dataStart = packerAllocWithEviction(packer, chunkKey, needQuads);
        // graceful degrade: arena full and nothing evictable. drop this pass rather
        // than throw; only lands here if a single chunk exceeds the whole arena.
        // cur's quad range is already freed above; release its section slot too.
        if (dataStart < 0) {
            if (cur) {
                packer.tables[pass].freeSlot(cur.sectionSlot);
                if (pass === 'translucent') packer.translucentDirty = true;
            }
            next[pass] = null;
            continue;
        }
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        const table = packer.tables[pass];
        // cur (re-upsert) reuses its section slot; only a fresh chunk allocates,
        // so a -1 here implies cur was null — just release the quad range.
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, chunkKey, pass);
        if (sectionSlot < 0) {
            arenaFree(packer.quadArena, dataStart);
            next[pass] = null;
            continue;
        }

        table.writeEntry(sectionSlot, {
            originX: origin[0],
            originY: origin[1],
            originZ: origin[2],
            dataStart,
            dataCount: needQuads,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });

        // a fresh translucent mesh reallocates arena data → the persisted sort
        // permutation is stale; flag it so the gate forces a re-sort.
        if (pass === 'translucent') packer.translucentDirty = true;
        next[pass] = { sectionSlot, dataStart, dataCount: needQuads };
    }

    const empty = !next.opaque && !next.transparent && !next.translucent;
    if (empty) {
        if (prev) removeChunkAt(packer, prev.chunkIndex);
        packer.allocs.delete(chunkKey);
        packer.origins.delete(chunkKey);
        packer.residentKeys.delete(chunkKey);
    } else {
        if (!prev) {
            next.chunkIndex = packer.chunks.length;
            packer.chunks.push(next);
        }
        // (re)write the record: a re-upsert may have moved section slots.
        writeChunkCullRecord(packer, next.chunkIndex, origin, next);
        packer.allocs.set(chunkKey, next);
        packer.origins.set(chunkKey, origin);
        packer.residentKeys.add(chunkKey);
    }
}

/** Swap-pop the chunk at `idx` out of `packer.chunks` and mirror the move in
 *  the cull-record buffer. The last chunk backfills the hole (its `chunkIndex`
 *  and record follow). O(1). */
function removeChunkAt(packer: ArenaPacker, idx: number): void {
    if (idx < 0) return;
    const last = packer.chunks.pop()!;
    const lastIdx = packer.chunks.length; // index `last` occupied before pop
    if (idx < lastIdx) {
        packer.chunks[idx] = last;
        last.chunkIndex = idx;
        moveChunkCullRecord(packer, lastIdx, idx);
    }
}

/** drop every chunk from the packer: free per-pass arena ranges + section slots,
 *  then empty the bookkeeping. No GpuBuffers realloc. */
export function packerClearAll(packer: ArenaPacker): void {
    for (const alloc of packer.allocs.values()) {
        for (const pass of PASSES) {
            const a = alloc[pass];
            if (a) packerFreePass(packer, pass, a);
        }
    }
    packer.allocs.clear();
    packer.origins.clear();
    packer.residentKeys.clear();
    packer.chunks.length = 0;
    // hard reset: nothing resident, so no live sort or pending self-heal. The
    // persisted translucent permutation is now stale — force a re-sort (this is
    // what the former `clearArena` did directly on `tsortGate`).
    packer.translucentDirty = false;
    packer.tsortGate.valid = false;
    packer.evicted.clear();
}

export function packerEvictChunk(packer: ArenaPacker, chunkKey: string): void {
    const cur = packer.allocs.get(chunkKey);
    if (!cur) return;
    for (const pass of PASSES) {
        const a = cur[pass];
        if (a) packerFreePass(packer, pass, a);
    }
    removeChunkAt(packer, cur.chunkIndex);
    packer.allocs.delete(chunkKey);
    packer.origins.delete(chunkKey);
    packer.residentKeys.delete(chunkKey);
}

export function packerHas(packer: ArenaPacker, chunkKey: string): boolean {
    return packer.allocs.has(chunkKey);
}

/** Resident chunk keys. The caller's reconcile checks each against its own
 *  `voxels.chunks`. */
export function packerKeys(packer: ArenaPacker): IterableIterator<string> {
    return packer.residentKeys.values();
}

export function packerSetCameraPos(packer: ArenaPacker, pos: Vec3 | null): void {
    packer.camera = pos;
}

// ── OOM eviction ────────────────────────────────────────────────────
//
// when an arena / section table runs out of room, evict the chunk farthest from
// the camera, then retry. GRACEFUL: if nothing else is resident, allocation
// returns -1 (the caller drops that pass) rather than throwing. Evicted chunks
// are queued in `evicted` so the caller re-dirties them (self-heal) rather than
// leaving a permanent hole.

/** Pick the chunk farthest from the camera to evict (excluding the one being
 *  upserted). Returns null when nothing else is resident → graceful degrade. */
function evictionVictim(packer: ArenaPacker, excludeKey: string): string | null {
    const cam = packer.camera;
    let bestKey: string | null = null;
    let bestDistSq = -1;
    for (const [key, origin] of packer.origins) {
        if (key === excludeKey) continue;
        const distSq = cam
            ? (origin[0] + CHUNK_SIZE * 0.5 - cam[0]) ** 2 +
              (origin[1] + CHUNK_SIZE * 0.5 - cam[1]) ** 2 +
              (origin[2] + CHUNK_SIZE * 0.5 - cam[2]) ** 2
            : Number.POSITIVE_INFINITY; // no camera (offline) → evict-first
        if (distSq > bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey;
}

/** Queue a pressure-evicted chunk to re-mesh next frame. Only the forced-eviction
 *  path records here; deliberate evicts (reconcile, clearAll) are correct removals
 *  and must NOT self-heal. */
function recordEviction(packer: ArenaPacker, chunkKey: string): void {
    if (packer.allocs.has(chunkKey)) packer.evicted.add(chunkKey);
}

function packerAllocWithEviction(packer: ArenaPacker, upsertKey: string, slots: number): number {
    for (;;) {
        try {
            return arenaAlloc(packer.quadArena, slots);
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocSlotWithEviction(packer: ArenaPacker, upsertKey: string, pass: VoxelPass): number {
    for (;;) {
        try {
            return packer.tables[pass].allocSlot();
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

/** Drain and return the chunk keys evicted under pressure since the last drain,
 *  so the caller can re-dirty them (self-heal). */
export function packerDrainEvicted(packer: ArenaPacker): string[] {
    if (packer.evicted.size === 0) return EMPTY_KEYS_ARRAY;
    const out = Array.from(packer.evicted);
    packer.evicted.clear();
    return out;
}

const EMPTY_KEYS_ARRAY: string[] = [];

// ── arena tier sizing ───────────────────────────────────────────────

export type VoxelArenaBudget = {
    /** bytes for the shared quadArena (all 3 passes). */
    quadArenaBytes: number;
    /** max chunk×pass slots per SectionTable (one table per pass). */
    maxSections: number;
    /** OffsetAllocator node-pool size for the quad arena. */
    maxAllocs: number;
};

export function voxelArenaBudgetForTier(profile: Performance.Profile): VoxelArenaBudget {
    const s = Performance.settingsForTier(profile);
    const cap = Math.floor(profile.limits.maxArenaBytes * 0.25);
    const desired = s.voxelArenaDesiredMB * 1024 * 1024;
    const total = Math.min(desired, cap);
    return {
        quadArenaBytes: total,
        maxSections: s.voxelMaxSections,
        maxAllocs: s.voxelArenaMaxAllocs,
    };
}

// ── VoxelArenaResources ─────────────────────────────────────────────

export type VoxelArenaResources = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, SectionTable>;
    packer: ArenaPacker;
};

export function createVoxelArenaResources(budget: VoxelArenaBudget): VoxelArenaResources {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    const tables: Record<VoxelPass, SectionTable> = {
        opaque: createSectionTable({ name: 'sectionTable-opaque', slotCount: budget.maxSections }),
        transparent: createSectionTable({ name: 'sectionTable-transparent', slotCount: budget.maxSections }),
        translucent: createSectionTable({ name: 'sectionTable-translucent', slotCount: budget.maxSections }),
    };
    const packer = createArenaPacker({ quadArena, tables });
    return { quadArena, tables, packer };
}

// ── lifecycle helpers ───────────────────────────────────────────────

/** Clear the arena: free every resident chunk (and, via packerClearAll, reset
 *  the translucent sort gate), so the next world remeshes from scratch and
 *  re-sorts. Voxel DATA is untouched (`voxels.chunks`), so re-mounting simply
 *  remeshes it. Call on a room swap (the arena holds one world at a time) or
 *  teardown. */
export function clearArena(arenas: VoxelArenaResources): void {
    packerClearAll(arenas.packer);
}

/** remove a specific chunk from the engine-global arena packer (e.g. when
 *  the chunk is unloaded from `voxels`). */
export function removeChunkMesh(arenas: VoxelArenaResources, key: string): void {
    const packer = arenas.packer;
    if (packerHas(packer, key)) {
        packerEvictChunk(packer, key);
    }
}
