// VoxelResources — engine-global GPU resources backing all voxel rendering.
//
// Owns the texture array atlas, the per-layer texture-animation buffer,
// the unified chunk-renderer quad materials (one per pass), the GPU
// expansion compute, and the engine-level voxel arenas + per-pass
// render scratch + geometries. Rooms own only the per-pass `Mesh`
// objects (added to their scene) and per-room dirty/voxel state.
//
// One instance per `EngineClient` (and one per offline-render task);
// shared across every room. The active room owns the arena state; on
// room swap, `packerClearAll` resets the arena and the new room's
// chunks re-mesh via the existing prioritised remesh path.
//
// Lifetime is tied to the active project module: built once on engine
// load from `module.blocks`, rebuilt on script reload (block defs and
// textures may have changed).

import type { ArrayTexture, Material, WebGPURenderer } from 'gpucat';
import {
    add,
    BufferLifecycle,
    createIndirectBuffer,
    createStorageBuffer,
    d,
    DrawIndirect,
    Fn,
    Geometry,
    GpuBuffer,
    If,
    layoutStrideOf,
    localId,
    packTo,
    Return,
    storage,
    struct,
    workgroupId,
} from 'gpucat';
import type { Box3, Vec3 } from 'mathcat';

import type { BlockRegistry } from '../../core/voxels/block-registry';
import {
    type ChunkMeshResult,
    type MeshOutput,
    type PassMesh,
    QUAD_STRIDE_U32S,
    createMeshOutput,
} from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment';
import * as Performance from '../performance';
import type { ComputeNode } from 'gpucat/dist/nodes/nodes';
import {
    createMeshDispatcher,
    disposeMeshDispatcher,
    type MeshDispatcher,
    type MeshDispatcherResult,
    setMeshRegistry,
} from './mesh-dispatcher';

import {
    createOffsetAllocator,
    oaAllocate,
    oaFree,
    oaStorageReport,
    type OffsetAllocator,
} from './offset-allocator';
import { createQuadMaterial, type VoxelPass } from './voxel-material';
import {
    type BlockTextureAtlasMetadata,
    createVoxelTextureArray,
    fetchBlockTextureAtlasMetadata,
    loadBlockTextureAtlasIntoTextureArray,
} from './voxel-texture-array';

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

// ── VisibleSlice ────────────────────────────────────────────────────
//
// per-frame CPU-cull output: one entry per visible (section, facing)
// slice (opaque/transparent) or per visible section (translucent).
// the expansion compute reads this and writes `quadCount` entries into
// visibleQuads[] starting at `instanceStart`.
//
// localBase is section-relative — it indexes into the section's slice
// of quadArena, not the arena globally:
//   opaque / transparent → faceOffsets[face]
//   translucent          → 0 (assumes quadOrder is identity; sort later)
// the VS adds chunkInfo[slot].arenaBase to localIdx to get realQuadId.

export const VisibleSlice = /* @__PURE__ */ struct('VoxelVisibleSlice', {
    instanceStart: d.u32,
    slot:          d.u32,
    quadCount:     d.u32,
    localBase:     d.u32,
});

// ── VisibleQuad ─────────────────────────────────────────────────────
//
// per-frame GPU-built table: one entry per visible quad. VS reads
// visibleQuads[instanceIndex] → (slot, localIdx), derefs chunkInfo[slot]
// for arenaBase + origin, and computes realQuadId = arenaBase + localIdx
// to index quads / light.

export const VisibleQuad = /* @__PURE__ */ struct('VoxelVisibleQuad', {
    slot:     d.u32,
    localIdx: d.u32,
});

// ── WgInfo ──────────────────────────────────────────────────────────
//
// per-frame CPU-built dispatch map: one entry per launched workgroup.
// a slice with N quads emits ceil(N/EXPAND_WG_SIZE) consecutive entries,
// each pointing at the same slice with a successive quadBase
// (0, 64, 128, …). dispatch shape becomes [wgCount, 1, 1] — eliminates
// the dispatch.y rounding waste from sizing to maxSliceQuads.

export const WgInfo = /* @__PURE__ */ struct('VoxelExpandWgInfo', {
    sliceIdx: d.u32,
    quadBase: d.u32,
});

export const VISIBLE_SLICE_STRIDE = /* @__PURE__ */ layoutStrideOf(VisibleSlice);
export const VISIBLE_QUAD_STRIDE  = /* @__PURE__ */ layoutStrideOf(VisibleQuad);
export const WG_INFO_STRIDE       = /* @__PURE__ */ layoutStrideOf(WgInfo);
export const DRAW_INDIRECT_STRIDE = /* @__PURE__ */ layoutStrideOf(DrawIndirect);

const VISIBLE_SLICE_U32S = VISIBLE_SLICE_STRIDE / 4;
const WG_INFO_U32S = WG_INFO_STRIDE / 4;

// ── expansion compute ──────────────────────────────────────────────
//
// dispatch shape: [wgCount, 1, 1], where wgCount = sum over visible
// slices of ceil(quadCount / EXPAND_WG_SIZE).
//
// each WG reads wgInfo[workgroupId.x] → (sliceIdx, quadBase). within
// the WG, quadIdx = quadBase + localId.x. tail invocations of the last
// WG for a slice may early-return when quadIdx >= slice.quadCount, but
// that waste is bounded to <EXPAND_WG_SIZE per slice (vs. previous
// dispatch.y scheme which wasted ~(maxSliceQuads - quadCount) per slice).
//
// no atomics. each output slot is written by exactly one invocation.

export const EXPAND_WG_SIZE = 64;

function createExpandSlicesCompute(): ComputeNode {
    return Fn(() => {
        const wgInfo        = storage('wgInfo',        d.array(WgInfo),        'read');
        const visibleSlices = storage('visibleSlices', d.array(VisibleSlice), 'read');
        const visibleQuads  = storage('visibleQuads',  d.array(VisibleQuad),  'read_write');

        const info = wgInfo.element(workgroupId.x);
        const sliceIdx = info.field('sliceIdx').toVar('sliceIdx');
        const quadBase = info.field('quadBase').toVar('quadBase');
        const quadIdx  = add(quadBase, localId.x).toVar('quadIdx');

        const slice = visibleSlices.element(sliceIdx);
        const quadCount = slice.field('quadCount').toVar('quadCount');
        If(quadIdx.greaterThanEqual(quadCount), () => { Return(); });

        const instanceStart = slice.field('instanceStart').toVar('instanceStart');
        const localBase     = slice.field('localBase').toVar('localBase');
        const slot          = slice.field('slot').toVar('slot');

        const outIdx = add(instanceStart, quadIdx).toVar('outIdx');
        const out = visibleQuads.element(outIdx).fields();
        out.slot.assign(slot);
        out.localIdx.assign(add(localBase, quadIdx));
    }).compute({ workgroupSize: [EXPAND_WG_SIZE, 1, 1] });
}

// ── PassRender ──────────────────────────────────────────────────────
//
// per-pass render-side resources rebuilt each frame by `cullCPU` and
// consumed by the expansion compute + draw. one engine-global instance
// per pass, populated by whichever room is active.

export type PassRender = {
    /** CPU-cull output. one entry per visible (section, facing) slice
     *  (opaque/transparent) or per visible section (translucent).
     *  contiguous prefix [0, visibleSliceCount). */
    visibleSlicesBuffer: GpuBuffer;
    visibleSlicesData: Uint32Array;
    /** GPU-expansion output. one entry per visible quad; instance i of
     *  the draw reads visibleQuads[i]. sized to a worst-case bound. */
    visibleQuadsBuffer: GpuBuffer;
    /** CPU-built per-WG dispatch map. one entry per launched workgroup
     *  ({sliceIdx, quadBase}); a slice with N quads emits ceil(N/64)
     *  entries. drives `dispatch=[wgCount,1,1]` — tail-only waste. */
    wgInfoBuffer: GpuBuffer;
    wgInfoData: Uint32Array;
    /** single-entry indirect: vertexCount=6, instanceCount=visibleQuadCount. */
    indirectBuffer: GpuBuffer;
    indirectData: Uint32Array;
    /** number of valid entries in visibleSlicesBuffer this frame. */
    visibleSliceCount: number;
    /** number of valid entries in wgInfoBuffer this frame — also the
     *  expansion compute's dispatch.x. */
    wgCount: number;
    /** sum of quadCount across all visible slices this frame. */
    visibleQuadCount: number;
};

// ── SegmentArena ────────────────────────────────────────────────────
//
// fixed-count, slot-indexed allocator over N lock-stepped GpuBuffer
// streams. each stream has its own `perSlot` element count but slot
// indices are shared — allocating slot range [s, s+k) gives you the
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

export function arenaAlloc<S extends Record<string, StreamSpec>>(
    a: SegmentArena<S>,
    slots: number,
): number {
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
        // by a matching arenaFree — bookkeeping drift. (See [voxel-drift].)
        throw new Error(
            `[voxel-drift][alloc-collision] arenaAlloc returned offset=${h.offset} but slotToNode still holds node=${prev}; new node=${h.node}, slots=${slots}`,
        );
    }
    a.slotToNode.set(h.offset, h.node);
    return h.offset;
}

export function arenaFree<S extends Record<string, StreamSpec>>(
    a: SegmentArena<S>,
    start: number,
): void {
    const node = a.slotToNode.get(start);
    if (node === undefined) {
        // forensic dump: nearest 5 live offsets on either side.
        const offsets = [...a.slotToNode.keys()].sort((x, y) => x - y);
        let pivot = 0;
        while (pivot < offsets.length && offsets[pivot]! < start) pivot++;
        const lo = Math.max(0, pivot - 5);
        const hi = Math.min(offsets.length, pivot + 5);
        const near = offsets.slice(lo, hi).map((o) => `${o}=>node${a.slotToNode.get(o)}`).join(',');
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

export const QUAD_ORDER_U32S_PER_SLOT = 1;

const BYTES_PER_QUAD = QUAD_STRIDE_U32S * 4; // 56 — interleaved header (40 B) + light (16 B)
const BYTES_PER_ORDER = QUAD_ORDER_U32S_PER_SLOT * 4; // 4

export type QuadArenaStreams = {
    quads: { schema: d.u32; perSlot: number };
};

export type QuadOrderArenaStreams = {
    quadOrder: { schema: d.u32; perSlot: number };
};

export type QuadArena = SegmentArena<QuadArenaStreams>;
export type QuadOrderArena = SegmentArena<QuadOrderArenaStreams>;

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

export function createQuadOrderArena(byteBudget: number, maxAllocs?: number): QuadOrderArena {
    const slots = Math.max(1024, Math.floor(byteBudget / BYTES_PER_ORDER));
    return createSegmentArena({
        slotCount: slots,
        maxAllocs,
        streams: {
            quadOrder: { schema: d.u32, perSlot: QUAD_ORDER_U32S_PER_SLOT },
        },
    });
}

// ── SectionTable ────────────────────────────────────────────────────

export type SectionEntryFields = {
    originX: number; originY: number; originZ: number;
    dataStart: number; dataCount: number;
    quadOrderStart: number;
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
     *  (shared across passes) — frustum cull runs once per chunk now. */
    readonly cpuDataCount: Uint32Array;    // 1 per slot (translucent slice quadCount)
    readonly cpuFaceOffsets: Uint32Array;  // 7 per slot (opaque/transparent localBase per facing)
    readonly cpuFaceCounts: Uint32Array;   // 7 per slot
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
        for (let i = 0; i < 7; i++) { cpuFaceOffsets[facingBase + i] = 0; cpuFaceCounts[facingBase + i] = 0; }

        freeStack.push(slot);
        used--;
    }

    function writeEntry(slot: number, entry: SectionEntryFields): void {
        const base = slot * entryU32s;
        // GPU side-table only carries origin + arenaBase. cull mirrors
        // below hold faceOffsets / faceCounts / dataCount /
        // quadOrderStart — none of which the VS needs at draw time.
        packTo(ChunkInfo, dataU32, base * 4, {
            origin: [entry.originX, entry.originY, entry.originZ],
            arenaBase: entry.dataStart,
        });
        buffer.addUpdateRange(base, entryU32s);

        cpuDataCount[slot] = entry.dataCount;
        const facingBase = slot * 7;
        for (let i = 0; i < 7; i++) {
            cpuFaceOffsets[facingBase + i] = entry.faceOffsets[i]!;
            cpuFaceCounts[facingBase + i]  = entry.faceCounts[i]!;
        }
    }

    function dispose(): void { buffer.dispose(); }

    return {
        slotCount,
        buffer,
        entryU32s,
        cpuDataCount,
        cpuFaceOffsets,
        cpuFaceCounts,
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
    quadOrderStart: number;
    quadOrderCount: number;
};

export type ChunkAlloc = {
    opaque: PassAlloc | null;
    transparent: PassAlloc | null;
    translucent: PassAlloc | null;
    /** chunk-level AABB, shared across all 3 passes. cullCPU iterates
     *  ChunkAllocs and frustum-tests this once — emit slices into each
     *  pass that has a non-null PassAlloc. */
    aabb: Box3;
};

export type ArenaPacker = {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
    allocs: Map<string, ChunkAlloc>;
    /** dense list of currently-held ChunkAllocs, in insertion order.
     *  cullCPU iterates this for the frustum + back-face pass.
     *  swap-pop on evict, push on first upsert. */
    chunks: ChunkAlloc[];
    /** per-chunk origin (worldspace min corner). populated on upsertChunk;
     *  consumed by OOM eviction policy (farthest-from-camera). */
    origins: Map<string, [number, number, number]>;
    orderScratch: Uint32Array;
    cameraPos: Vec3 | null;
};

export function createArenaPacker(opts: {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
}): ArenaPacker {
    return {
        quadArena: opts.quadArena,
        quadOrderArena: opts.quadOrderArena,
        tables: opts.tables,
        allocs: new Map(),
        chunks: [],
        origins: new Map(),
        orderScratch: new Uint32Array(4096),
        cameraPos: null,
    };
}

function packerFreePass(packer: ArenaPacker, pass: VoxelPass, a: PassAlloc): void {
    arenaFree(packer.quadArena, a.dataStart);
    if (pass === 'translucent' && a.quadOrderCount > 0) {
        arenaFree(packer.quadOrderArena, a.quadOrderStart);
    }
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
    };
    const meshAabb = mesh.aabb;
    if (meshAabb) {
        next.aabb[0] = meshAabb.min[0]; next.aabb[1] = meshAabb.min[1]; next.aabb[2] = meshAabb.min[2];
        next.aabb[3] = meshAabb.max[0]; next.aabb[4] = meshAabb.max[1]; next.aabb[5] = meshAabb.max[2];
    } else {
        next.aabb[0] = 0; next.aabb[1] = 0; next.aabb[2] = 0;
        next.aabb[3] = 0; next.aabb[4] = 0; next.aabb[5] = 0;
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

        if (cur) {
            arenaFree(packer.quadArena, cur.dataStart);
            if (pass === 'translucent' && cur.quadOrderCount > 0) {
                arenaFree(packer.quadOrderArena, cur.quadOrderStart);
            }
        }
        const dataStart = packerAllocWithEviction(packer, chunkKey, needQuads);
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        let quadOrderStart = 0;
        let quadOrderCount = 0;
        if (pass === 'translucent') {
            quadOrderCount = needQuads;
            quadOrderStart = packerAllocOrderWithEviction(packer, chunkKey, needQuads);
            if (packer.orderScratch.length < needQuads) {
                packer.orderScratch = new Uint32Array(Math.max(needQuads, packer.orderScratch.length * 2));
            }
            for (let i = 0; i < needQuads; i++) packer.orderScratch[i] = dataStart + i;
            arenaWrite(packer.quadOrderArena, 'quadOrder', quadOrderStart, needQuads, packer.orderScratch);
        }

        const table = packer.tables[pass];
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, chunkKey, pass);

        table.writeEntry(sectionSlot, {
            originX: origin[0], originY: origin[1], originZ: origin[2],
            dataStart, dataCount: needQuads,
            quadOrderStart,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });

        next[pass] = { sectionSlot, dataStart, dataCount: needQuads, quadOrderStart, quadOrderCount };
    }

    const empty = !next.opaque && !next.transparent && !next.translucent;
    if (empty) {
        if (prev) {
            const idx = packer.chunks.indexOf(prev);
            if (idx >= 0) {
                const last = packer.chunks.pop()!;
                if (idx < packer.chunks.length) packer.chunks[idx] = last;
            }
        }
        packer.allocs.delete(chunkKey);
        packer.origins.delete(chunkKey);
    } else {
        if (!prev) packer.chunks.push(next);
        packer.allocs.set(chunkKey, next);
        packer.origins.set(chunkKey, origin);
    }
}

/** drop every chunk from the packer. frees per-pass arena ranges + section
 *  slots, then empties the bookkeeping maps. used on room activation to
 *  hand the engine-global arena over to the new active room without
 *  reallocating any GpuBuffers. */
export function packerClearAll(packer: ArenaPacker): void {
    for (const alloc of packer.allocs.values()) {
        for (const pass of PASSES) {
            const a = alloc[pass];
            if (a) packerFreePass(packer, pass, a);
        }
    }
    packer.allocs.clear();
    packer.origins.clear();
    packer.chunks.length = 0;
}

export function packerEvictChunk(packer: ArenaPacker, chunkKey: string): void {
    const cur = packer.allocs.get(chunkKey);
    if (!cur) return;
    for (const pass of PASSES) {
        const a = cur[pass];
        if (a) packerFreePass(packer, pass, a);
    }
    const idx = packer.chunks.indexOf(cur);
    if (idx >= 0) {
        const last = packer.chunks.pop()!;
        if (idx < packer.chunks.length) packer.chunks[idx] = last;
    }
    packer.allocs.delete(chunkKey);
    packer.origins.delete(chunkKey);
}

export function packerHas(packer: ArenaPacker, chunkKey: string): boolean {
    return packer.allocs.has(chunkKey);
}

export function packerKeys(packer: ArenaPacker): IterableIterator<string> {
    return packer.allocs.keys();
}

export function packerSetCameraPos(packer: ArenaPacker, pos: Vec3 | null): void {
    packer.cameraPos = pos;
}

// ── OOM eviction ────────────────────────────────────────────────────
//
// when one of the underlying arenas / section tables runs out of room,
// evict the chunk farthest from the current camera (excluding the one
// being upserted) and retry. without a camera reference, evict an
// arbitrary chunk (offline path — should never OOM in practice).

function farthestChunkKey(packer: ArenaPacker, excludeKey: string): string | null {
    let bestKey: string | null = null;
    const cam = packer.cameraPos;
    if (!cam) {
        for (const key of packer.allocs.keys()) {
            if (key !== excludeKey) return key;
        }
        return null;
    }
    let bestDistSq = -1;
    for (const [key, origin] of packer.origins) {
        if (key === excludeKey) continue;
        const dx = origin[0] + CHUNK_SIZE * 0.5 - cam[0];
        const dy = origin[1] + CHUNK_SIZE * 0.5 - cam[1];
        const dz = origin[2] + CHUNK_SIZE * 0.5 - cam[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > bestDistSq) { bestDistSq = distSq; bestKey = key; }
    }
    return bestKey;
}

function packerAllocWithEviction(packer: ArenaPacker, upsertKey: string, slots: number): number {
    for (;;) {
        try { return arenaAlloc(packer.quadArena, slots); }
        catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocOrderWithEviction(packer: ArenaPacker, upsertKey: string, slots: number): number {
    for (;;) {
        try { return arenaAlloc(packer.quadOrderArena, slots); }
        catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocSlotWithEviction(packer: ArenaPacker, upsertKey: string, pass: VoxelPass): number {
    for (;;) {
        try { return packer.tables[pass].allocSlot(); }
        catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

// ── arena tier sizing ───────────────────────────────────────────────

export type VoxelArenaBudget = {
    /** bytes for the shared quadArena (sum of both streams). */
    quadArenaBytes: number;
    /** bytes for the translucent-only quadOrderArena. */
    quadOrderBytes: number;
    /** max chunk×pass slots per SectionTable (one table per pass). */
    maxSections: number;
    /** OffsetAllocator node-pool size for both quad arenas. */
    maxAllocs: number;
};

export function voxelArenaBudgetForTier(profile: Performance.Profile): VoxelArenaBudget {
    const s = Performance.settingsForTier(profile);
    const cap = Math.floor(profile.limits.maxArenaBytes * 0.25);
    const desired = s.voxelArenaDesiredMB * 1024 * 1024;
    const total = Math.min(desired, cap);
    return {
        quadArenaBytes: Math.floor(total * 0.95),
        quadOrderBytes: Math.floor(total * 0.05),
        maxSections: s.voxelMaxSections,
        maxAllocs: s.voxelArenaMaxAllocs,
    };
}

// ── VoxelArenaResources ─────────────────────────────────────────────

export type VoxelArenaResources = {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
    packer: ArenaPacker;
};

export function createVoxelArenaResources(budget: VoxelArenaBudget): VoxelArenaResources {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    const quadOrderArena = createQuadOrderArena(budget.quadOrderBytes, budget.maxAllocs);
    const tables: Record<VoxelPass, SectionTable> = {
        opaque: createSectionTable({ name: 'sectionTable-opaque', slotCount: budget.maxSections }),
        transparent: createSectionTable({ name: 'sectionTable-transparent', slotCount: budget.maxSections }),
        translucent: createSectionTable({ name: 'sectionTable-translucent', slotCount: budget.maxSections }),
    };
    const packer = createArenaPacker({ quadArena, quadOrderArena, tables });
    return { quadArena, quadOrderArena, tables, packer };
}

function createPassRender(arenas: VoxelArenaResources, budget: VoxelArenaBudget): Record<VoxelPass, PassRender> {
    // worst-case per-pass slice caps. opaque/transparent fan out into
    // 7 facings per section (+X,-X,+Y,-Y,+Z,-Z,UNASSIGNED); translucent
    // is one slice per section.
    const sliceCaps: Record<VoxelPass, number> = {
        opaque:      budget.maxSections * 7,
        transparent: budget.maxSections * 7,
        translucent: budget.maxSections,
    };
    // worst-case per-pass visible-quad cap. each quad in the arena
    // belongs to exactly one (chunk, pass), so per-pass total visible
    // ≤ arena.slotCount. sized once; never grown.
    const visibleQuadCap = arenas.quadArena.slotCount;
    // worst-case wgInfo entries per pass: sum over slices of
    // ceil(quadCount / EXPAND_WG_SIZE) ≤ ceil(visibleQuadCap/64) +
    // visibleSlices (one tail WG per slice).
    const wgInfoCaps: Record<VoxelPass, number> = {
        opaque:      Math.ceil(visibleQuadCap / EXPAND_WG_SIZE) + sliceCaps.opaque,
        transparent: Math.ceil(visibleQuadCap / EXPAND_WG_SIZE) + sliceCaps.transparent,
        translucent: Math.ceil(visibleQuadCap / EXPAND_WG_SIZE) + sliceCaps.translucent,
    };

    const out = {} as Record<VoxelPass, PassRender>;
    for (const pass of PASSES) {
        const visibleSlicesData = new Uint32Array(sliceCaps[pass] * VISIBLE_SLICE_U32S);
        const visibleSlicesBuffer = new GpuBuffer(d.array(VisibleSlice), {
            data: visibleSlicesData,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });

        // compute-written, never CPU-touched: skip MANUAL lifecycle so
        // gpucat auto-allocates on first use. matches voxel-mesh-visuals'
        // instanceTransformsBuf pattern.
        const visibleQuadsBuffer = new GpuBuffer(d.array(VisibleQuad), {
            data: new Uint32Array(visibleQuadCap * (VISIBLE_QUAD_STRIDE / 4)),
            usage: 'storage',
        });

        const wgInfoData = new Uint32Array(wgInfoCaps[pass] * WG_INFO_U32S);
        const wgInfoBuffer = new GpuBuffer(d.array(WgInfo), {
            data: wgInfoData,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });

        const indirectData = new Uint32Array(DRAW_INDIRECT_STRIDE / 4);
        // pre-seed vertexCount=6 (6 verts per instance, 1 quad each).
        indirectData[0] = 6;
        const indirectBuffer = createIndirectBuffer(d.array(DrawIndirect), indirectData);

        out[pass] = {
            visibleSlicesBuffer,
            visibleSlicesData,
            visibleQuadsBuffer,
            wgInfoBuffer,
            wgInfoData,
            indirectBuffer,
            indirectData,
            visibleSliceCount: 0,
            wgCount: 0,
            visibleQuadCount: 0,
        };
    }
    return out;
}

function createGeometries(
    arenas: VoxelArenaResources,
    passRender: Record<VoxelPass, PassRender>,
    env: EnvironmentResources,
): Record<VoxelPass, Geometry> {
    const out = {} as Record<VoxelPass, Geometry>;
    for (const pass of PASSES) {
        const g = new Geometry();
        // shared quadArena bound by name — same buffers across all 3 passes.
        g.setBuffer('quads', arenas.quadArena.buffers.quads);
        // engine-global GPU-built visible-quad table; VS reads
        // visibleQuads[instanceIndex] → (slot, localIdx).
        g.setBuffer('visibleQuads', passRender[pass].visibleQuadsBuffer);
        // ChunkInfo: per-slot {origin, arenaBase}. VS uses chunkInfo[slot]
        // to resolve worldspace origin and the arena base for realQuadId.
        g.setBuffer('chunkInfo', arenas.tables[pass].buffer);
        // env (envConfig) bound by name so the engine-global material
        // resolves the engine-global env config (the active room's
        // shadow is flushed into this buffer by Environment.tick).
        g.setBuffer('env', env.envConfigBuffer);
        g.indirect = passRender[pass].indirectBuffer;
        out[pass] = g;
    }
    return out;
}

// ── VoxelResources ──────────────────────────────────────────────────

export type VoxelResources = {
    /** gpucat array texture atlas */
    atlas: ArrayTexture;
    /** per-layer animation metadata storage buffer */
    texAnimBuffer: GpuBuffer;
    /** unified chunk-renderer quad materials (quad-pull VS), one per pass.
     *  bound on per-room `Mesh` along with the engine-shared `geometries`. */
    quadMaterials: Record<VoxelPass, Material>;
    /** engine-global expansion compute. one node, dispatched 3× per frame
     *  (once per pass) with different visibleSlices/visibleQuads buffers
     *  bound by name. */
    expandSlices: ComputeNode;
    /** engine-global arenas (quadArena + quadOrderArena + per-pass
     *  section tables + packer). active room owns the contents at any
     *  given time; `packerClearAll` resets on activation. */
    arenas: VoxelArenaResources;
    /** engine-global per-frame cull/expand scratch + indirect buffers.
     *  populated by the active room's `cullCPU`. */
    passRender: Record<VoxelPass, PassRender>;
    /** engine-global per-pass Geometry. all bindings are engine-global
     *  buffers — bound once at construction, never rebound on room swap. */
    geometries: Record<VoxelPass, Geometry>;
    /** resolves when the texture atlas has been fully loaded into the array texture */
    atlasReady: Promise<void>;
    /** @internal — settled by VoxelResources.load() once atlas pixels finish uploading. */
    _resolveAtlasReady: () => void;
    /** atlas manifest hash this struct was built against (null if the
     *  manifest fetch failed). */
    atlasHash: string | null;
    /** registry.texAnimData this struct was built against. */
    texAnimData: Float32Array;
    /** off-thread mesh worker pool. null on offline-renderer paths where
     *  the synchronous remesh loop is preferred (callers pass workerCount=0). */
    meshDispatcher: MeshDispatcher | null;
    /** queue of completed worker jobs, drained at the top of
     *  `voxel-visuals.update()`. Populated by `meshDispatcher`'s onResult. */
    pendingMeshResults: MeshDispatcherResult[];
    /** chunk keys whose in-flight worker jobs were lost to a worker
     *  crash. Drained at the top of `voxel-visuals.update()` — each is
     *  put back on `voxels.dirty.blocks` so the chunk gets re-dispatched
     *  next frame. */
    pendingLostChunkKeys: string[];
    /** scratch `MeshOutput` shared by every main-thread sync remesh. One
     *  instance is enough because each `meshChunk` call is consumed
     *  (copied into the arena) before the next call begins. */
    meshOutput: MeshOutput;
};

export function init(
    registry: BlockRegistry,
    env: EnvironmentResources,
    budget: VoxelArenaBudget,
): VoxelResources {
    console.log(
        `[voxel-resources] init, ${registry.textures.length} textures, ${registry.totalStates} states`,
    );

    const atlas = createVoxelTextureArray(registry.textures.length);

    const texAnimBuffer = createStorageBuffer(d.array(d.vec4f), registry.texAnimData);

    const { promise: atlasReady, resolve: _resolveAtlasReady } = Promise.withResolvers<void>();

    const quadMaterials: Record<VoxelPass, Material> = {
        opaque: createQuadMaterial({ atlas, texAnimBuffer, pass: 'opaque' }),
        transparent: createQuadMaterial({ atlas, texAnimBuffer, pass: 'transparent' }),
        translucent: createQuadMaterial({ atlas, texAnimBuffer, pass: 'translucent' }),
    };

    const expandSlices = createExpandSlicesCompute();

    const arenas = createVoxelArenaResources(budget);
    const passRender = createPassRender(arenas, budget);
    const geometries = createGeometries(arenas, passRender, env);

    return {
        atlas,
        texAnimBuffer,
        quadMaterials,
        expandSlices,
        arenas,
        passRender,
        geometries,
        atlasReady,
        _resolveAtlasReady,
        atlasHash: null,
        texAnimData: registry.texAnimData,
        meshDispatcher: null,
        pendingMeshResults: [],
        pendingLostChunkKeys: [],
        meshOutput: createMeshOutput(),
    };
}

/** Async side of construction: pre-warms the expansion compute pipeline,
 *  fetches the atlas manifest, kicks off the atlas pixel upload (settles
 *  `res.atlasReady`), and spawns the mesh worker pool. `meta` may be passed
 *  in by `refresh` (which already fetched it to compare hashes); otherwise
 *  `load` fetches it itself. Mutates `res` in place. */
export async function load(
    res: VoxelResources,
    registry: BlockRegistry,
    workerCount: number,
    workerQueueDepth: number,
    renderer?: WebGPURenderer,
    meta?: BlockTextureAtlasMetadata | null,
): Promise<void> {
    if (renderer) {
        // pre-warm — non-blocking from the caller's POV (compileCompute is a
        // gpucat pre-warm; the node is usable immediately, this just primes
        // the pipeline cache).
        void renderer.compileCompute(res.expandSlices);
    }

    const resolvedMeta = meta !== undefined ? meta : await fetchBlockTextureAtlasMetadata();
    res.atlasHash = resolvedMeta?.hash ?? null;
    if (resolvedMeta) {
        loadBlockTextureAtlasIntoTextureArray(res.atlas, registry.textures, resolvedMeta)
            .then(() => {
                console.log('[voxel-resources] atlas loaded successfully');
                res._resolveAtlasReady();
            })
            .catch((e) => {
                console.warn('[voxel-resources] atlas load failed:', e);
                res._resolveAtlasReady();
            });
    } else {
        res._resolveAtlasReady();
    }

    if (workerCount > 0 && typeof Worker !== 'undefined') {
        // Dynamic import so environments that don't support workers
        // don't reach the `?worker&inline` query suffix that lives inside
        // mesh-worker-spawn.ts. Vite resolves it at bundle time.
        // The Worker guard lets node/happy-dom test harnesses run without
        // a worker shim — they fall through to inline meshing.
        const { spawnMeshWorker } = await import('./mesh-worker-spawn');
        const meshDispatcher = createMeshDispatcher({
            workerFactory: spawnMeshWorker,
            workerCount,
            queueDepth: workerQueueDepth,
            onResult: (r) => res.pendingMeshResults.push(r),
            onLost: (key) => res.pendingLostChunkKeys.push(key),
        });
        setMeshRegistry(meshDispatcher, registry);
        res.meshDispatcher = meshDispatcher;
    }
}

/** Build new resources, or reuse `prev` if the atlas + animation metadata
 *  are unchanged. */
export async function refresh(
    prev: VoxelResources | null,
    registry: BlockRegistry,
    env: EnvironmentResources,
    budget: VoxelArenaBudget,
    workerCount: number,
    workerQueueDepth: number,
    renderer?: WebGPURenderer,
): Promise<{ resources: VoxelResources; changed: boolean }> {
    const meta = await fetchBlockTextureAtlasMetadata();
    if (
        prev &&
        meta !== null &&
        prev.atlasHash !== null &&
        meta.hash === prev.atlasHash &&
        f32Equal(prev.texAnimData, registry.texAnimData)
    ) {
        // atlas + texAnim unchanged → reuse. But the BlockRegistry itself
        // may have been rebuilt (block tables, shape ids, ...), so push
        // the new registry to the workers; existing in-flight jobs will
        // finish with the old registry and get gen-dropped by callers.
        if (prev.meshDispatcher) setMeshRegistry(prev.meshDispatcher, registry);
        return { resources: prev, changed: false };
    }
    if (prev) dispose(prev);
    const resources = init(registry, env, budget);
    await load(resources, registry, workerCount, workerQueueDepth, renderer, meta);
    return { resources, changed: true };
}

function f32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function dispose(state: VoxelResources): void {
    state.atlas.dispose();
    state.texAnimBuffer.dispose();
    state.quadMaterials.opaque.dispose();
    state.quadMaterials.transparent.dispose();
    state.quadMaterials.translucent.dispose();
    for (const pass of PASSES) {
        state.geometries[pass].dispose();
        const r = state.passRender[pass];
        r.visibleSlicesBuffer.dispose();
        r.visibleQuadsBuffer.dispose();
        r.wgInfoBuffer.dispose();
        r.indirectBuffer.dispose();
    }
    arenaDispose(state.arenas.quadArena);
    arenaDispose(state.arenas.quadOrderArena);
    for (const pass of PASSES) state.arenas.tables[pass].dispose();
    if (state.meshDispatcher) disposeMeshDispatcher(state.meshDispatcher);
    state.pendingMeshResults.length = 0;
    state.pendingLostChunkKeys.length = 0;
}
