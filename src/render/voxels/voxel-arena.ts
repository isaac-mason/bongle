import { BufferLifecycle, type Camera, DrawIndirect, d, frustum, GpuBuffer, layoutStrideOf, struct } from 'gpucat';
import { type Box3, plane3 } from 'math/shapes';
import { QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, CHUNK_VOLUME, type Chunk } from '../../core/voxels/voxels';
import { createOffsetAllocator, type OffsetAllocator, oaAllocate, oaFree, oaStorageReport } from '../offset-allocator';
import type { VoxelPass } from './voxel-material';

export const PASSES: readonly VoxelPass[] = ['opaque', 'transparent', 'translucent'];

/** a fully-opaque chunk whose 6 face-neighbors are all fully opaque has no visible surface
 *  and can skip meshing entirely, exactly like an all-air chunk. A missing neighbor counts
 *  as non-occluding; any change that could reveal a face already re-dirties this chunk. */
export function hasNoVisibleSurface(chunk: Chunk): boolean {
    if (chunk.solidCount !== CHUNK_VOLUME) return false;
    for (let dir = 0; dir < 6; dir++) {
        const neighbor = chunk.neighbors[dir];
        if (neighbor === null || neighbor.solidCount !== CHUNK_VOLUME) return false;
    }
    return true;
}

// per-section GPU side-table: one entry per occupied SectionTable slot. The VS reads
// chunkInfo[slot] to recover the chunk's worldspace origin and arena base, combining
// arenaBase with VisibleQuad.localIdx to produce the absolute realQuadId.
export const ChunkInfo = /* @__PURE__ */ struct('VoxelChunkInfo', {
    origin: d.vec3f,
    arenaBase: d.u32,
});

// per-frame GPU-built table: one entry per visible quad. VS reads visibleQuads[instanceIndex]
// to get (slot, localIdx), derefs chunkInfo[slot], and computes realQuadId = arenaBase + localIdx.
export const VisibleQuad = /* @__PURE__ */ struct('VoxelVisibleQuad', {
    slot: d.u32,
    localIdx: d.u32,
});

// GPU cull input, one entry per resident chunk, mirroring packer.chunks 1:1. Chunk coords
// are integers so cull/emit can reconstruct the section center camera-relative, keeping
// the frustum math f32-exact at world scale. Per-pass slots of -1 mean no geometry there.
export const ChunkCullRecord = /* @__PURE__ */ struct('VoxelChunkCullRecord', {
    cx: d.i32,
    cy: d.i32,
    cz: d.i32,
    opaqueSlot: d.i32,
    transparentSlot: d.i32,
    translucentSlot: d.i32,
});

// Cull output: one entry per surviving chunk (compacted), carrying the per-pass section
// slots, the camera-relative section center, and the distance bucket for ordering.
// relCenter.w is unused padding.
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
// bucket: ascending gives front-to-back (opaque/transparent, early-Z), descending
// gives back-to-front (translucent inter-section).
export const BUCKET_COUNT = 256;

export const VISIBLE_QUAD_STRIDE = /* @__PURE__ */ layoutStrideOf(VisibleQuad);
export const DRAW_INDIRECT_STRIDE = /* @__PURE__ */ layoutStrideOf(DrawIndirect);

// per-frame camera state read by the frustum + distance cull, packed as Float32 the same
// way for both backends (mirrors gpu-frame.ts's CullView struct element-for-element):
// [0..19] 5 frustum planes, camera-relative, half-extent folded into .w; [20..22] camera
// chunk coords; [23] live record count, written by the caller; [24..26] camera's sub-chunk
// offset; [27] view-radius^2 cutoff.
export const CULL_VIEW_FLOATS = 28;

const _cullViewFrustum = /* @__PURE__ */ frustum.create();

/** Writes the shared cull view into out. Does not write the live record count (out[23]);
 *  the caller owns that. viewChunkRadius is read live so a tier flip applies next frame. */
export function buildCullView(out: Float32Array, camera: Camera, viewChunkRadius: number): void {
    // clip-space convention matters: the near plane extracts differently for WebGPU
    // (z=0) vs WebGL (z=-1); the default would mis-place it mid-frustum on WebGL.
    frustum.setFromViewProjectionMatrix(
        _cullViewFrustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
        camera.coordinateSystem,
    );
    const cx = camera.position[0];
    const cy = camera.position[1];
    const cz = camera.position[2];
    const camCx = Math.floor(cx / CHUNK_SIZE);
    const camCy = Math.floor(cy / CHUNK_SIZE);
    const camCz = Math.floor(cz / CHUNK_SIZE);

    // 5 planes (far plane dropped; the view-radius test bounds it), camera-relative
    // with the section half-extent folded into .w: dot(plane.xyz, relCenter) + plane.w >= 0.
    const half = CHUNK_SIZE * 0.5;
    for (let i = 0; i < 5; i++) {
        const p = _cullViewFrustum[i]!;
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];
        // (n dot cam + constant), folded with the box support along n; all in f64.
        const w = plane3.distanceToPoint(p, camera.position) + half * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
        const base = i * 4;
        out[base + 0] = nx;
        out[base + 1] = ny;
        out[base + 2] = nz;
        out[base + 3] = w;
    }
    // camMeta = (camChunk.xyz, recordCount [caller-owned]); camFrac = (fracXYZ, viewDist squared).
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

// fixed-count, slot-indexed allocator over N lock-stepped GpuBuffer streams: each stream
// has its own perSlot element count but slot indices are shared across streams.
// Suballocator is OffsetAllocator (TLSF-style, constant-time alloc/free, <=12.5% fragmentation).
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
    /** slot offset to OffsetAllocator node index, so arenaFree(start) can
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
            label: `voxel-arena-${key}`,
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

// 40 B, geometry only; light lives in the light-volume texture. Sizes the arena
// and the tier budgets are measured against it.
const BYTES_PER_QUAD = QUAD_STRIDE_U32S * 4;

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

// GPU-resident per-slot cull metadata, the device mirror of cpuFaceOffsets + cpuFaceCounts:
// [faceOffsets[0..6], faceCounts[0..6]]. Read by the GPU cull/emit/expand computes.
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

// shared per-chunk / per-pass allocation records; each backend's producer owns its own
// packer over these, but both build the same ChunkAlloc[] residency list.
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

export type VoxelArenaBudget = {
    /** bytes for the shared quadArena (all 3 passes). */
    quadArenaBytes: number;
    /** max chunk x pass slots per SectionTable (one table per pass). */
    maxSections: number;
    /** OffsetAllocator node-pool size for the quad arena. */
    maxAllocs: number;
    /** light-volume tile slots. Sized off maxSections since a tile is needed for the
     *  1-chunk dilation of the geometry, not the geometry itself; uniform chunks need none. */
    maxLightTiles: number;
    /** chunk radius the light-volume residency grid must cover. The stream
     *  radius, not the draw radius: chunks are resident (and so lit) slightly
     *  beyond what is drawn, and a grid that does not cover a sampled chunk
     *  aliases onto another one. */
    lightGridChunkRadius: number;
};

// voxelArenaBudgetForTier lives in client/performance (tier -> budget is a
// performance concern); this module owns only the VoxelArenaBudget shape.
