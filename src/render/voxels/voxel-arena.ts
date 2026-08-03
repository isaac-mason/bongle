// voxel-arena.ts — SHARED voxel arena TOOLS (backend-neutral leaf primitives).
//
// The backend-neutral pieces both voxel producers build on: the GPU structs
// (ChunkInfo / VisibleQuad / ChunkCullRecord / VisibleChunk + strides), the
// `SegmentArena` + `QuadArena` suballocator, the shared cull-view math
// (`buildCullView`), the arena residency SHAPES (`PassAlloc` / `ChunkAlloc` /
// `SectionEntryFields`), the `hasNoVisibleSurface` predicate, and the arena
// budgets. Each backend builds its own section table + residency/eviction packer +
// consume over these (voxel-resources-cpu / voxel-resources-gpu); those are
// intentionally not shared, so neither backend carries the other's buffers.
//
// Value-imported by BOTH producers + voxel-visuals + the offline paths. This file
// must never value-import a backend producer — the WebGPU compute chain lives in
// voxel-resources-gpu, imported only by render/webgpu/*.

import { BufferLifecycle, type Camera, DrawIndirect, d, frustum, GpuBuffer, layoutStrideOf, struct } from 'gpucat';
import type { Box3 } from 'mathcat';
import { plane3 } from 'mathcat';
import * as Performance from '../../client/performance';
import { QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, CHUNK_VOLUME, type Chunk } from '../../core/voxels/voxels';
import { createOffsetAllocator, type OffsetAllocator, oaAllocate, oaFree, oaStorageReport } from '../offset-allocator';
import type { VoxelPass } from './voxel-material';

export const PASSES: readonly VoxelPass[] = ['opaque', 'transparent', 'translucent'];

/** a fully-opaque chunk whose 6 face-neighbors are all fully opaque has no
 *  visible surface: every boundary face is culled against a solid neighbor
 *  and the interior self-culls. Such a chunk can skip meshing entirely and
 *  have its arena entry evicted, exactly like an all-air chunk.
 *
 *  A missing neighbor (unloaded, or the world edge) counts as non-occluding,
 *  so the exposed face still meshes. This is safe because any state change
 *  that could reveal a face already re-dirties this chunk: a boundary block
 *  edit in a neighbor (applyVoxelChunkOps) and a neighbor chunk load/update
 *  (dirtyAllNeighborChunks) both mark it dirty for face-cull reasons, so the
 *  occlusion test is re-evaluated before the newly-exposed face could show. */
export function hasNoVisibleSurface(chunk: Chunk): boolean {
    if (chunk.solidCount !== CHUNK_VOLUME) return false;
    for (let dir = 0; dir < 6; dir++) {
        const neighbor = chunk.neighbors[dir];
        if (neighbor === null || neighbor.solidCount !== CHUNK_VOLUME) return false;
    }
    return true;
}

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

// ── cull view (shared frustum math) ─────────────────────────────────
//
// The per-frame camera state the frustum + distance cull reads, packed as
// Float32 the same way for both backends (the WebGPU `CullView` struct in
// gpu-frame.ts mirrors this layout element-for-element):
//   [0..19]  plane0..4      5 frustum planes (far dropped; the view-radius test
//                           bounds it), camera-relative with the section half-
//                           extent folded into .w so the test is
//                           `dot(plane.xyz, rel) + plane.w >= 0`.
//   [20..22] camMeta.xyz    camera chunk coords (integers, f32-exact past MC range)
//   [23]     camMeta.w      live record count — NOT written here; the caller sets
//                           it (WebGPU: cull dispatch bound; the CPU producer
//                           walks the packer directly and ignores it).
//   [24..26] camFrac.xyz    camera offset within its chunk [0, CHUNK_SIZE)
//   [27]     camFrac.w      squared view-radius cutoff (camera-relative distance²)
//
// Everything is camera-relative + integer chunk coords so the frustum test stays
// in a small f32-exact domain even at Minecraft world scale.
export const CULL_VIEW_FLOATS = 28;

const _cullViewFrustum = /* @__PURE__ */ frustum.create();

/** Write the shared cull view (5 pre-shifted camera-relative frustum planes +
 *  camMeta chunk coords + camFrac sub-chunk offset + view-radius²) into `out`.
 *  Backend-neutral: `gpu-frame.updateCull` writes it into its GPU-buffer-backed
 *  Float32Array, `cpu-frame.cullEmit` into a plain CPU scratch. Does NOT write
 *  the live record count (`out[23]`); the caller owns that. `viewChunkRadius` is
 *  read live so a tier flip applies next frame. */
export function buildCullView(out: Float32Array, camera: Camera, viewChunkRadius: number): void {
    frustum.setFromViewProjectionMatrix(_cullViewFrustum, camera.projectionMatrix, camera.matrixWorldInverse);
    const cx = camera.position[0];
    const cy = camera.position[1];
    const cz = camera.position[2];
    const camCx = Math.floor(cx / CHUNK_SIZE);
    const camCy = Math.floor(cy / CHUNK_SIZE);
    const camCz = Math.floor(cz / CHUNK_SIZE);

    // 5 planes (drop the far plane, index 5 — the view-radius test bounds it),
    // camera-relative with the section half-extent folded into `.w`:
    //   dot(plane.xyz, relCenter) + plane.w >= 0  keeps the section.
    const half = CHUNK_SIZE * 0.5;
    for (let i = 0; i < 5; i++) {
        const p = _cullViewFrustum[i]!;
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];
        // (n·cam + constant), folded with the box support along n; all in f64.
        const w = plane3.distanceToPoint(p, camera.position) + half * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
        const base = i * 4;
        out[base + 0] = nx;
        out[base + 1] = ny;
        out[base + 2] = nz;
        out[base + 3] = w;
    }
    // camMeta = (camChunk.xyz, recordCount [caller-owned]); camFrac = (fracXYZ, viewDist²).
    const viewDist = viewChunkRadius * CHUNK_SIZE;
    out[20] = camCx;
    out[21] = camCy;
    out[22] = camCz;
    // out[23] (live count) is written by the caller.
    out[24] = cx - camCx * CHUNK_SIZE;
    out[25] = cy - camCy * CHUNK_SIZE;
    out[26] = cz - camCz * CHUNK_SIZE;
    out[27] = viewDist * viewDist;
}

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

// ── arena residency shapes ──────────────────────────────────────────
//
// The shared per-chunk / per-pass allocation records. Each backend's producer
// (`voxel-resources-cpu` / `voxel-resources-gpu`) owns its own packer over these;
// the shapes stay here because both build the same `ChunkAlloc[]` residency list.

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
