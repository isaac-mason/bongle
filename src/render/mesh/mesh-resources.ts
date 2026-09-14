// MeshResources, client-global GPU pools backing all model rendering.
//
// Owns the texture atlas, the CPU-side mesh-info catalog (firstIndex,
// indexCount, uv, AABB per mesh), pooled vertex/index buffers, and the
// engine-global model material. One instance per `EngineClient`; shared
// across all rooms and all `MeshVisuals` consumers.
//
// Lifetime is tied to model load/unload, NOT to instance count. Polling-
// driven: each tick `update(modelResources, resources)` walks
// `resources.modelPayloads` for newly-ready models (uploads them to the
// pools and nulls `payload.model` to free the source bytes) and for
// vanished payloads (releases their pool slots).
//
// ── render pipeline ────────────────────────────────────────────────
// CPU (mesh-visuals.ts) per frame:
//   - walks visible MeshVisualStates, buckets each into the slot-list for
//     its mesh, then per-bucket writes slots contiguously into `slotMap`
//     and appends one `MeshDraw` covering that range to `mesh.draws`.
//
// GPU material VS (HW instanced):
//   - reads `posU` / `normalV` from the interleaved vertex pool by HW
//     attribute fetch.
//   - `realSlot = slotMap[instanceIndex]` (`instanceIndex` is base-inclusive
//     on both backends, so each draw indexes into its own range).
//   - `instanceData[realSlot]` for per-instance world matrix + params
//     (params now carries `uvOffset` / `uvScale`).
//   - `slotMap` + `instanceData` are read-only `storage()` buffers — native
//     SSBO reads on WebGPU, auto-lowered to rgba32uint buffer-texture fetches
//     on WebGL2 (gpucat), so one material source serves both backends.
//
// One instanced draw per visible bucket per frame (`mesh.draws`). No compute
// dispatch, no vertex-pull, no triangle queue.

import type { IndexedMeshDraw } from 'gpucat';
import {
    abs,
    add,
    attribute,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    d,
    dot,
    f32,
    Geometry,
    GpuBuffer,
    instanceIndex,
    layoutStrideOf,
    Material,
    Mesh,
    mat3,
    max,
    mix,
    mul,
    type Node,
    normalize,
    screenSize,
    select,
    sin,
    smoothstep,
    storage,
    struct,
    sub,
    texture,
    u32,
    varying,
    vec2f,
    vec3f,
    vec4,
    vec4f,
} from 'gpucat';
import type { Model } from '../../core/models/model';
import type { ResourceLoader } from '../../core/resource-loader';
import type { ModelPayload, Resources } from '../../core/resources';
import { ditherDiscard } from '../dsl/dither';
import { shadeTinted } from '../dsl/shade';
import type { EnvironmentResources } from '../environment/environment';
import { applyFog, fogDistance } from '../environment/fog';
import { bindLightVolume, sampleWorldLight } from '../voxels/voxel-light-sample';
import * as MeshAtlas from './mesh-atlas';

// ── gpu structs ─────────────────────────────────────────────────────

export const InstanceParams = struct('ModelInstanceParams', {
    // tint: rgb is the recolour target, a the intensity (lightness-preserving).
    tint: d.vec4f,
    // flash: transient overlay, rgb is the colour, a the strength (lerp).
    flash: d.vec4f,
    // glow: emissive glow intensity 0-1, added to final color
    glow: d.f32,
    // unlit: 0 = lit, 1 = bypass all lighting (carried as f32 so the shader
    // can mix() rather than branch).
    unlit: d.f32,
    // litMin: floor on voxel light (0..1) for readability in dim areas.
    litMin: d.f32,
    // dither: screen-door fade 0..1. 0 = solid, 1 = invisible. fragment
    // discards against an interleaved-gradient threshold, opaque pipeline,
    // no sort or blend.
    dither: d.f32,
    // atlas uv rect for this instance's mesh. lives per-slot rather than
    // per-frame because it only changes when the source image lands in
    // the atlas, re-uploaded on entry-ref mismatch in mesh-visuals.
    uvOffset: d.vec2f,
    uvScale: d.vec2f,
    // outlineColor: rgba drawn by the expanded shell pass.
    outlineColor: d.vec4f,
    // outlineWidth: shell expansion, 0 = no outline. Units depend on outlineSpace.
    outlineWidth: d.f32,
    // outlineSpace: 1 = width is SCREEN pixels, held constant with distance;
    // 0 = width is WORLD units, so the outline shrinks with distance like real
    // geometry. Lands in the padding that followed `outlineWidth`, so it is free.
    outlineSpace: d.f32,
});

// Per-slot stable instance record. Merges what were two separate
// storage buffers (transforms + params) into one binding, same
// cardinality, same writer, same grow lifecycle.
//
// Layout: mat4x4f (64B, align 16) then InstanceParams (96B, align 16)
// → total 160B per slot, struct align 16.
export const ModelInstance = struct('ModelInstance', {
    worldMatrix: d.mat4x4f,
    params: InstanceParams,
});

// Interleaved vertex struct for the geometry pool.
//
// posU.xyz = position, posU.w = u
// normalV.xyz = normal, normalV.w = v
// vec4f+vec4f = 32 bytes per vertex, aligned 16. Same memory cost as
// three separate pools (vec4 + vec4 + vec2 with std430 padding) but
// only one binding, folding pos/normal/uv into one struct buffer
// drops two bindings without changing memory footprint, which the VS
// needs to stay under WebGPU's 8 storage-buffer-per-stage cap.
export const ModelVertex = struct('ModelVertex', {
    posU: d.vec4f,
    normalV: d.vec4f,
});

export const INSTANCE_PARAMS_STRIDE = layoutStrideOf(InstanceParams);
export const MODEL_INSTANCE_STRIDE = layoutStrideOf(ModelInstance);
/** byte offset of the `params` member inside `ModelInstance` (after the mat4x4f). */
export const MODEL_INSTANCE_PARAMS_OFFSET = 64;
/** f32-index offset of the `params` member inside `ModelInstance`, i.e.
 *  `MODEL_INSTANCE_PARAMS_OFFSET` in f32 units (64 bytes = 16 f32). */
export const MODEL_INSTANCE_PARAMS_OFFSET_F32 = MODEL_INSTANCE_PARAMS_OFFSET / 4;
/** f32 count of one `InstanceParams`. Derived, so it tracks struct changes. */
export const INSTANCE_PARAMS_STRIDE_F32 = INSTANCE_PARAMS_STRIDE / 4;
/** f32 count per `ModelInstance` slot. Derived, so it tracks struct changes. */
export const MODEL_INSTANCE_STRIDE_F32 = MODEL_INSTANCE_STRIDE / 4;
export const MODEL_VERTEX_STRIDE = layoutStrideOf(ModelVertex);
const MODEL_VERTEX_STRIDE_F32 = MODEL_VERTEX_STRIDE / 4; // 8

const INITIAL_INSTANCE_CAPACITY = 4096;

// ── geometry pool ───────────────────────────────────────────────────
// Pooled interleaved vertex + index buffers, slot-allocated per uploaded
// mesh. One big GpuBuffer per pool, bound to the Geometry as vertex /
// index buffers; the VS reads `posU` / `normalV` via HW attribute fetch
// and indices are consumed by HW (one instanced draw per visible bucket
// via `mesh.draws`). UVs ride in the `.w` lanes of the interleaved attributes.

export type GeometrySlot = {
    /** whether `pool.smoothNormals` has been filled for this slot. The bake is
     *  LAZY: only a mesh something actually outlines ever pays for it, and it is
     *  read back out of the interleaved pool so no source arrays are retained. */
    smoothReady: boolean;
    /** vertex index into the pooled vertex buffer. */
    vertexOffset: number;
    /** vertex count. */
    vertexCount: number;
    /** index offset into the pooled index buffer (in indices, not bytes). */
    indexOffset: number;
    /** index count. */
    indexCount: number;
};

export type ModelGeometryUpload = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** uint32 indices; uint16 not supported for the pool to keep slot math uniform. */
    indices: Uint32Array;
};

const INITIAL_VERTEX_CAPACITY = 64 * 1024;
const INITIAL_INDEX_CAPACITY = 192 * 1024;

type Range = { offset: number; count: number };

type RangeAllocator = {
    capacity: number;
    head: number;
    freeRanges: Range[];
};

function createRangeAllocator(capacity: number): RangeAllocator {
    return { capacity, head: 0, freeRanges: [] };
}

function allocRange(a: RangeAllocator, count: number): Range {
    // first-fit on free-list
    for (let i = 0; i < a.freeRanges.length; i++) {
        const r = a.freeRanges[i]!;
        if (r.count >= count) {
            const out: Range = { offset: r.offset, count };
            if (r.count === count) {
                a.freeRanges.splice(i, 1);
            } else {
                r.offset += count;
                r.count -= count;
            }
            return out;
        }
    }
    // bump
    if (a.head + count > a.capacity) a.capacity = Math.max(a.capacity * 2, a.head + count);
    const out: Range = { offset: a.head, count };
    a.head += count;
    return out;
}

function freeRange(a: RangeAllocator, range: Range): void {
    let i = 0;
    for (; i < a.freeRanges.length; i++) {
        if (a.freeRanges[i]!.offset > range.offset) break;
    }
    a.freeRanges.splice(i, 0, { offset: range.offset, count: range.count });

    const r = a.freeRanges;
    for (let j = 0; j < r.length - 1; ) {
        const cur = r[j]!;
        const next = r[j + 1]!;
        if (cur.offset + cur.count === next.offset) {
            cur.count += next.count;
            r.splice(j + 1, 1);
        } else {
            j++;
        }
    }
}

export type ModelGeometryPool = {
    /** mesh-key → slot. */
    slots: Map<string, GeometrySlot>;
    /** interleaved {posU, normalV} per vertex. */
    vertices: GpuBuffer<typeof ModelVertex>;
    /** oct-encoded SMOOTHED normal per vertex, parallel to `vertices` and indexed
     *  by the same vertex offset. Only the outline shell reads it, so the base
     *  pass's vertex fetch is untouched and `ModelVertex` stays 32 B.
     *
     *  Smoothed, not the shading normal: a box carries three different normals at
     *  each corner, and expanding a shell along those pulls the faces apart and
     *  tears it open. Averaging the normals of every vertex that shares a position
     *  gives a direction field that is both continuous across edges and actually
     *  perpendicular to the surface, which is the only thing that works on an
     *  arbitrary mesh. This is what Guilty Gear and Genshin bake into their assets;
     *  we can derive it at upload instead, because we own that path.
     *
     *  4 bytes a vertex, allocated with the pool and filled lazily per mesh. */
    smoothNormals: GpuBuffer<d.u32>;
    indices: GpuBuffer<d.u32>;
    vertexAllocator: RangeAllocator;
    indexAllocator: RangeAllocator;
};

function createGeometryPool(
    initialVertexCapacity = INITIAL_VERTEX_CAPACITY,
    initialIndexCapacity = INITIAL_INDEX_CAPACITY,
): ModelGeometryPool {
    // MANUAL lifecycle: this pool owns the buffers across script-reload, many
    // MeshVisuals geometries bind to and dispose them per reload, but the pool
    // itself outlives them. REF_COUNTED would let the last `geometry.dispose()`
    // destroy the GPU buffer while the pool still hands the JS object out.
    const vertices = new GpuBuffer(ModelVertex, {
        data: new Float32Array(initialVertexCapacity * MODEL_VERTEX_STRIDE_F32),
        usage: 'vertex',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const indices = new GpuBuffer(d.u32, {
        data: new Uint32Array(initialIndexCapacity),
        usage: 'index',
        lifecycle: BufferLifecycle.MANUAL,
    });
    // one u32 a vertex, so it costs ~0.4 MB at 100k vertices. Allocated up front
    // rather than on first use: the outline shell binds it every frame regardless,
    // and a later allocation would have to preserve every slot's vertex offset
    // anyway, which is all the eager cost buys back.
    const smoothNormals = new GpuBuffer(d.u32, {
        data: new Uint32Array(initialVertexCapacity),
        usage: 'vertex',
        lifecycle: BufferLifecycle.MANUAL,
    });

    return {
        slots: new Map(),
        vertices,
        smoothNormals,
        indices,
        vertexAllocator: createRangeAllocator(initialVertexCapacity),
        indexAllocator: createRangeAllocator(initialIndexCapacity),
    };
}

/**
 * Reserve vertex + index ranges for `meshKey`, copy `geom` into the
 * pools, and queue partial GPU uploads. Returns the slot for downstream
 * mesh-info writes. Indices are rebased by `vertexOffset` so the VS
 * reads pool indices directly.
 *
 * Idempotent, re-uploading the same `meshKey` returns the existing slot
 * without copying. Caller releases-then-uploads to replace.
 */
function uploadGeometry(pool: ModelGeometryPool, meshKey: string, geom: ModelGeometryUpload): GeometrySlot {
    const existing = pool.slots.get(meshKey);
    if (existing) return existing;

    const vertexCount = geom.positions.length / 3;
    const indexCount = geom.indices.length;

    const vRange = allocRange(pool.vertexAllocator, vertexCount);
    if (vRange.offset + vRange.count > getVertexCapacity(pool)) growVertex(pool, pool.vertexAllocator.capacity);

    const iRange = allocRange(pool.indexAllocator, indexCount);
    if (iRange.offset + iRange.count > getIndexCapacity(pool)) growIndex(pool, pool.indexAllocator.capacity);

    const slot: GeometrySlot = {
        smoothReady: false,
        vertexOffset: vRange.offset,
        vertexCount,
        indexOffset: iRange.offset,
        indexCount,
    };
    pool.slots.set(meshKey, slot);

    // interleave into the single vertex pool: [posX, posY, posZ, u,
    // normX, normY, normZ, v] per vertex.
    const vertArr = pool.vertices.array as Float32Array;
    const idxArr = pool.indices.array as Uint32Array;

    const posSrc = geom.positions;
    const normSrc = geom.normals;
    const uvSrc = geom.uvs;
    const vDstBase = vRange.offset * MODEL_VERTEX_STRIDE_F32;
    for (let i = 0; i < vertexCount; i++) {
        const s3 = i * 3;
        const s2 = i * 2;
        const d8 = i * MODEL_VERTEX_STRIDE_F32;
        vertArr[vDstBase + d8 + 0] = posSrc[s3 + 0]!;
        vertArr[vDstBase + d8 + 1] = posSrc[s3 + 1]!;
        vertArr[vDstBase + d8 + 2] = posSrc[s3 + 2]!;
        vertArr[vDstBase + d8 + 3] = uvSrc[s2 + 0]!;
        vertArr[vDstBase + d8 + 4] = normSrc[s3 + 0]!;
        vertArr[vDstBase + d8 + 5] = normSrc[s3 + 1]!;
        vertArr[vDstBase + d8 + 6] = normSrc[s3 + 2]!;
        vertArr[vDstBase + d8 + 7] = uvSrc[s2 + 1]!;
    }

    // rebase indices to absolute vertex positions in the pool
    const base = vRange.offset;
    for (let i = 0; i < indexCount; i++) {
        idxArr[iRange.offset + i] = geom.indices[i]! + base;
    }

    pool.vertices.addUpdateRange(vRange.offset * MODEL_VERTEX_STRIDE_F32, vertexCount * MODEL_VERTEX_STRIDE_F32);
    pool.indices.addUpdateRange(iRange.offset, indexCount);

    return slot;
}

/**
 * Free the ranges for `meshKey`. Pushed to free-lists; pool stays the
 * same size. The GPU bytes are NOT cleared, they're overwritten on the
 * next upload that lands in the same range.
 */
function releaseGeometry(pool: ModelGeometryPool, meshKey: string): void {
    const slot = pool.slots.get(meshKey);
    if (!slot) return;
    pool.slots.delete(meshKey);
    freeRange(pool.vertexAllocator, { offset: slot.vertexOffset, count: slot.vertexCount });
    freeRange(pool.indexAllocator, { offset: slot.indexOffset, count: slot.indexCount });
}

function disposeGeometryPool(pool: ModelGeometryPool): void {
    pool.vertices.dispose();
    pool.indices.dispose();
    pool.slots.clear();
}

function getVertexCapacity(pool: ModelGeometryPool): number {
    return (pool.vertices.array as Float32Array).length / MODEL_VERTEX_STRIDE_F32;
}

function getIndexCapacity(pool: ModelGeometryPool): number {
    return (pool.indices.array as Uint32Array).length;
}

function growVertex(pool: ModelGeometryPool, newCapacity: number): void {
    const old = pool.vertices.array as Float32Array;
    const next = new Float32Array(newCapacity * MODEL_VERTEX_STRIDE_F32);
    next.set(old);
    pool.vertices.array = next;
    pool.vertices.needsUpdate = true;

    // parallel array, same vertex indexing: it has to grow in lockstep or a slot
    // allocated after the grow indexes past the end of it.
    const oldSmooth = pool.smoothNormals.array as Uint32Array;
    const nextSmooth = new Uint32Array(newCapacity);
    nextSmooth.set(oldSmooth);
    pool.smoothNormals.array = nextSmooth;
    pool.smoothNormals.needsUpdate = true;
}

/** octahedral-encode a unit vector into 8:8 fixed point, packed in a u32. Two
 *  bytes is ample for a direction that only steers an outline. */
function octEncodeNormal(x: number, y: number, z: number): number {
    const invL1 = 1 / (Math.abs(x) + Math.abs(y) + Math.abs(z) || 1);
    let ox = x * invL1;
    let oy = y * invL1;
    if (z < 0) {
        const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
        const ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
        ox = tx;
        oy = ty;
    }
    const qx = Math.round((ox * 0.5 + 0.5) * 255) & 0xff;
    const qy = Math.round((oy * 0.5 + 0.5) * 255) & 0xff;
    return (qx | (qy << 8)) >>> 0;
}

/**
 * Fill `pool.smoothNormals` for one slot, averaging the normals of every vertex
 * that shares a position. Idempotent and lazy: called the first time something
 * actually outlines this mesh, so a game that never uses outlines never pays.
 *
 * Reads positions and normals back out of the interleaved pool rather than
 * keeping the source arrays alive - they are already sitting there at this
 * slot's vertex offset.
 */
export function ensureSmoothNormals(pool: ModelGeometryPool, slot: GeometrySlot): void {
    if (slot.smoothReady) return;
    slot.smoothReady = true;

    const vertArr = pool.vertices.array as Float32Array;
    const out = pool.smoothNormals.array as Uint32Array;
    const base = slot.vertexOffset * MODEL_VERTEX_STRIDE_F32;
    const count = slot.vertexCount;

    // quantised so vertices meant to be coincident actually collide. Split
    // vertices come from the same source position, so exact bits usually match,
    // but a rounded key costs nothing and survives a lossy export.
    const sums = new Map<string, [number, number, number]>();
    const keys: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const o = base + i * MODEL_VERTEX_STRIDE_F32;
        const key = `${Math.round(vertArr[o]! * 4096)},${Math.round(vertArr[o + 1]! * 4096)},${Math.round(vertArr[o + 2]! * 4096)}`;
        keys[i] = key;
        const acc = sums.get(key);
        if (acc === undefined) sums.set(key, [vertArr[o + 4]!, vertArr[o + 5]!, vertArr[o + 6]!]);
        else {
            acc[0] += vertArr[o + 4]!;
            acc[1] += vertArr[o + 5]!;
            acc[2] += vertArr[o + 6]!;
        }
    }

    for (let i = 0; i < count; i++) {
        const o = base + i * MODEL_VERTEX_STRIDE_F32;
        const acc = sums.get(keys[i]!)!;
        let [nx, ny, nz] = acc;
        const len = Math.hypot(nx, ny, nz);
        // normals cancelling to nothing means a degenerate fan; fall back to this
        // vertex's own normal rather than emitting a zero direction.
        if (len < 1e-6) {
            nx = vertArr[o + 4]!;
            ny = vertArr[o + 5]!;
            nz = vertArr[o + 6]!;
        } else {
            nx /= len;
            ny /= len;
            nz /= len;
        }
        out[slot.vertexOffset + i] = octEncodeNormal(nx, ny, nz);
    }

    pool.smoothNormals.addUpdateRange(slot.vertexOffset, count);
    pool.smoothNormals.needsUpdate = true;
}

function growIndex(pool: ModelGeometryPool, newCapacity: number): void {
    const old = pool.indices.array as Uint32Array;
    const next = new Uint32Array(newCapacity);
    next.set(old);
    pool.indices.array = next;
    pool.indices.needsUpdate = true;
}

// ── mesh info catalog ───────────────────────────────────────────────
// CPU-only per-mesh metadata. Was a GPU storage buffer back when the
// material chased meshSlot per fragment; now CPU hoists everything into
// the compacted entry, so this is pure bookkeeping (slot index, UV,
// firstIndex/indexCount, local AABB) read by mesh-visuals each frame
// and by offline tasks for camera fitting.

export type MeshInfoEntry = {
    uvOffset: [number, number];
    uvScale: [number, number];
    firstIndex: number;
    indexCount: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    /** the pool geometry slot, so the write loop can trigger the lazy smoothed
     *  normal bake the first time something outlines this mesh. */
    geometry: GeometrySlot;
};

export type MeshInfoCatalog = {
    /** mesh-key → slot index. */
    indexByKey: Map<string, number>;
    /** dense array; index === slot. Holes (nulls) filled lazily from `freeList`. */
    entries: (MeshInfoEntry | null)[];
    /** indices vacated by release, reused before extending `entries`. */
    freeList: number[];
};

function createMeshCatalog(): MeshInfoCatalog {
    return { indexByKey: new Map(), entries: [], freeList: [] };
}

export function meshInfoIndexOf(cat: MeshInfoCatalog, meshKey: string): number | null {
    return cat.indexByKey.get(meshKey) ?? null;
}

function writeMeshInfo(cat: MeshInfoCatalog, meshKey: string, entry: MeshInfoEntry): number {
    let slot = cat.indexByKey.get(meshKey);
    if (slot === undefined) {
        slot = cat.freeList.length > 0 ? cat.freeList.pop()! : cat.entries.length;
        cat.indexByKey.set(meshKey, slot);
    }
    cat.entries[slot] = entry;
    return slot;
}

function releaseMeshInfo(cat: MeshInfoCatalog, meshKey: string): void {
    const slot = cat.indexByKey.get(meshKey);
    if (slot === undefined) return;
    cat.indexByKey.delete(meshKey);
    cat.entries[slot] = null;
    cat.freeList.push(slot);
}

// ── instance batch (client-global, persistent GPU allocation) ───────
// The per-slot instance buffers + slotMap + draw list + their Mesh/Geometry
// live here, NOT on per-room MeshVisuals: exactly one room renders at a time,
// so a room swap REUSES this allocation (reset counts + re-add the Mesh) instead
// of freeing + reallocating it. `MeshVisuals` keeps only this-room's use — the
// alive-state list, cull registrations, and scene-tree query.

/** single-slot free-list allocator over the instance buffers. Slots index
 *  `instanceDataBuf`; the free-list + head reset per room via `resetMeshBatch`. */
export type Allocator = { capacity: number; head: number; freeList: number[] };

function createAllocator(capacity: number): Allocator {
    return { capacity, head: 0, freeList: [] };
}

export function allocateSlot(a: Allocator): number {
    if (a.freeList.length > 0) return a.freeList.pop()!;
    if (a.head >= a.capacity) a.capacity *= 2;
    return a.head++;
}

export function freeSlot(a: Allocator, slot: number): void {
    a.freeList.push(slot);
}

type GpuBufferType = GpuBuffer<any>;

export type MeshBatch = {
    /** one Mesh(geometry, material); added to the active room's scene on `enter`,
     *  removed on `exit`. Never disposed on a room swap. */
    mesh: Mesh;
    /** binds the pool vertex/index buffers (MANUAL, owned by the pool) + this
     *  batch's own `instanceData`/`slotMap` storage buffers. */
    geometry: Geometry;
    /** stable per-slot {worldMatrix, params}, 144B/slot; read-only storage,
     *  auto-lowered to a buffer-texture fetch on WebGL2 (gpucat). */
    /** the outline shell, sharing this batch's geometry, buffers and draw list. */
    outlineMesh: Mesh;
    instanceDataBuf: GpuBufferType;
    /** per-frame u32[] sized to `instanceCapacity`; slotMap[instanceIndex] → slot. */
    slotMapBuf: GpuBufferType;
    /** per-frame batched draw list, shared by identity with `mesh.draws`. */
    draws: IndexedMeshDraw[];
    /** scratch buckets reused across frames: meshSlot → array of stable slots. */
    _bucketScratch: Map<number, number[]>;
    /** stack of empty arrays freed by stale-bucket sweeps, reused on next insert. */
    _freeBuckets: number[][];
    /** capacity gating `instanceDataBuf` + `slotMapBuf`; grows 2×. */
    instanceCapacity: number;
    /** slot free-list into the instance buffer. */
    instanceAllocator: Allocator;

    /** last frame's instance-upload shape, read by the render backend into the frame profiler.
     *  `dirtyInstances` is what changed; `dirtySpan` is what the one min..max range actually
     *  uploads. A span much larger than the dirty count means scattered slots are dragging
     *  untouched neighbours along for the ride. */
    aliveInstances: number;
    dirtyInstances: number;
    dirtySpan: number;
};

/** Build the client-global instance batch: its Geometry binds the pool vertex/
 *  index buffers + fresh instanceData/slotMap storage, and the Mesh wraps it with
 *  the engine-global material. Not added to any scene until a room `enter`s. */
function createMeshBatch(pool: ModelGeometryPool, material: Material, outlineMaterial: Material): MeshBatch {
    const instanceCapacity = INITIAL_INSTANCE_CAPACITY;

    const geometry = new Geometry();
    // pool buffers, engine-global, interleaved {posU, normalV} (uv in the .w
    // lanes) + index buffer. HW vertex fetch + HW indexing.
    geometry.setBuffer('vertex', pool.vertices);
    geometry.setBuffer('smoothNormal', pool.smoothNormals);
    geometry.setIndex(pool.indices);

    const instanceDataBuf = new GpuBuffer(d.array(ModelInstance), {
        data: new Float32Array(instanceCapacity * MODEL_INSTANCE_STRIDE_F32),
        usage: 'storage',
    });
    const slotMapBuf = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(instanceCapacity),
        usage: 'storage',
    });
    geometry.setBuffer('instanceData', instanceDataBuf);
    geometry.setBuffer('slotMap', slotMapBuf);

    const draws: IndexedMeshDraw[] = [];

    const mesh = new Mesh(geometry, material);
    mesh.name = 'mesh-visuals';
    mesh.frustumCulled = false; // per-mesh CPU cull via Visibility
    mesh.draws = draws;

    // the outline shell shares the geometry, the instance buffers AND the draw
    // list by reference, so it is the same instances drawn a second time with a
    // different material. Instances with outlineWidth 0 collapse outside the
    // frustum in the vertex stage, so this costs a draw call and no fragments
    // when nothing is outlined. renderOrder puts it after the mesh, which is
    // what the stencil test depends on.
    const outlineMesh = new Mesh(geometry, outlineMaterial);
    outlineMesh.name = 'mesh-visuals-outline';
    outlineMesh.frustumCulled = false;
    outlineMesh.draws = draws;
    outlineMesh.renderOrder = 1;

    return {
        mesh,
        outlineMesh,
        geometry,
        instanceDataBuf,
        slotMapBuf,
        aliveInstances: 0,
        dirtyInstances: 0,
        dirtySpan: 0,
        draws,
        _bucketScratch: new Map(),
        _freeBuckets: [],
        instanceCapacity,
        instanceAllocator: createAllocator(instanceCapacity),
    };
}

/** Ready the batch for a fresh room: empty the allocator + scratch + draw list.
 *  Buffers are NOT touched — reused slots re-upload on version mismatch, and a
 *  cleared allocator means the next refill writes from slot 0. */
export function resetMeshBatch(batch: MeshBatch): void {
    batch.instanceAllocator.head = 0;
    batch.instanceAllocator.freeList.length = 0;
    batch._bucketScratch.clear();
    batch._freeBuckets.length = 0;
    batch.draws.length = 0;
}

// growth: webgpu buffers are immutable in size, so growing means allocating a
// fresh GpuBuffer, copying, and destroying the old one. gpucat tracks buffer
// swaps by GpuBuffer identity; `geometry.setBuffer(name, newBuf)` re-binds the
// material to the new buffer and bumps geometry.version automatically.
export function growMeshBatch(batch: MeshBatch, newCapacity: number): void {
    const geometry = batch.geometry;

    // instance data, preserve per-slot bytes (transforms + params are both
    // versioned and won't re-upload until their trait changes).
    {
        const oldArr = batch.instanceDataBuf.array as Float32Array;
        const newArr = new Float32Array(newCapacity * MODEL_INSTANCE_STRIDE_F32);
        newArr.set(oldArr.subarray(0, Math.min(oldArr.length, newArr.length)));
        const newBuf = new GpuBuffer(d.array(ModelInstance), { data: newArr, usage: 'storage' });
        geometry.setBuffer('instanceData', newBuf);
        batch.instanceDataBuf.dispose();
        batch.instanceDataBuf = newBuf;
    }

    // slotMap, rebuilt every frame, no need to preserve.
    {
        const newArr = new Uint32Array(newCapacity);
        const newBuf = new GpuBuffer(d.array(d.u32), { data: newArr, usage: 'storage' });
        geometry.setBuffer('slotMap', newBuf);
        batch.slotMapBuf.dispose();
        batch.slotMapBuf = newBuf;
    }

    batch.instanceCapacity = newCapacity;
}

function disposeMeshBatch(batch: MeshBatch): void {
    // pool vertex/index buffers are MANUAL (owned by the pool), so
    // geometry.dispose()'s decreaseUsages() is a no-op on them; the instance +
    // slotMap buffers we own here. Called once at client shutdown, never on swap.
    batch.geometry.dispose();
    batch.instanceDataBuf.dispose();
    batch.slotMapBuf.dispose();
}

// ── module surface ──────────────────────────────────────────────────

type UploadRecord = {
    /** mesh names uploaded for this model, used to release pool slots. */
    meshNames: string[];
    /** image count from the model, used to release atlas regions. */
    imageCount: number;
    /** resolves once every image for this model has decoded, blitted into the
     *  atlas, and patched its meshes' UVs. Meshes upload synchronously but their
     *  textures land async (see `upload`), so one-shot offscreen renders (icons)
     *  must await this before drawing or they capture placeholder UVs. */
    texturesReady: Promise<void>;
};

export type MeshResources = {
    atlas: MeshAtlas.MeshAtlas;
    meshInfo: MeshInfoCatalog;
    geometry: ModelGeometryPool;
    /** modelId → upload record. presence = "uploaded"; drives release-on-removal. */
    uploaded: Map<string, UploadRecord>;
    /** UV of the reserved white pixel, fallback for untextured meshes. */
    whiteUv: [number, number];
    /** engine-global model material, HW instanced. Per-room read-only storage
     *  buffers (slotMap, instanceData) bind by name through each room's geometry
     *  (native SSBO on WebGPU, auto-lowered to buffer-texture reads on WebGL2);
     *  env is the shared uniform captured by the material; the interleaved vertex
     *  pool binds as a vertex buffer named `vertex`, the index pool as the index. */
    material: Material;
    /** client-global instance batch (Mesh/Geometry + per-slot buffers + allocator).
     *  Reused across room swaps; per-room `MeshVisuals` drive it via `enter`/`exit`. */
    batch: MeshBatch;
};

const WHITE_PIXEL_KEY = '__white__';

export function init(env: EnvironmentResources): MeshResources {
    const atlas = MeshAtlas.create();

    // reserve a 1×1 white pixel so untextured meshes can sample white
    // (multiplied by tint) instead of zero-init black.
    const whiteRegion = MeshAtlas.allocate(atlas, 1, 1, WHITE_PIXEL_KEY);
    if (!whiteRegion) throw new Error('MeshResources.init: atlas overflow on white-pixel reserve');
    const stride = atlas.size * 4;
    const off = whiteRegion.y * stride + whiteRegion.x * 4;
    atlas.pixels[off + 0] = 255;
    atlas.pixels[off + 1] = 255;
    atlas.pixels[off + 2] = 255;
    atlas.pixels[off + 3] = 255;
    MeshAtlas.markDirty(atlas);
    const whiteUv: [number, number] = [(whiteRegion.x + 0.5) / atlas.size, (whiteRegion.y + 0.5) / atlas.size];

    const meshInfo = createMeshCatalog();
    const geometry = createGeometryPool();

    const material = createModelMaterial(atlas, env);
    const outlineMaterial = createMeshOutlineMaterial(atlas);
    const batch = createMeshBatch(geometry, material, outlineMaterial);

    return {
        atlas,
        meshInfo,
        geometry,
        uploaded: new Map(),
        whiteUv,
        material,
        batch,
    };
}

/**
 * Per-tick sync. Uploads any `ready` payload that hasn't been uploaded
 * yet (and nulls `payload.model` to free the source bytes); releases any
 * tracked modelId whose payload has been removed from
 * `resources.modelPayloads`.
 */
export function update(modelResources: MeshResources, resources: Resources): void {
    // upload newly-ready payloads
    for (const [modelId, payload] of resources.modelPayloads) {
        if (payload.state !== 'ready') continue;
        if (modelResources.uploaded.has(modelId)) continue;
        if (!payload.model) continue;
        upload(modelResources, resources.loader, modelId, payload.model, payload);
        payload.model = null;
    }

    // release vanished payloads
    for (const modelId of modelResources.uploaded.keys()) {
        if (!resources.modelPayloads.has(modelId)) {
            release(modelResources, modelId);
        }
    }
}

/** Resolves once `modelId`'s textures are resident in the atlas (or immediately
 *  if the model is untextured / not yet uploaded). One-shot offscreen renders
 *  await this after `update` so they don't capture placeholder UVs; the live
 *  loop ignores it (textures pop in within a frame or two, invisibly). */
export function modelTexturesReady(modelResources: MeshResources, modelId: string): Promise<void> {
    return modelResources.uploaded.get(modelId)?.texturesReady ?? Promise.resolve();
}

export function dispose(modelResources: MeshResources): void {
    disposeMeshBatch(modelResources.batch);
    MeshAtlas.dispose(modelResources.atlas);
    disposeGeometryPool(modelResources.geometry);
    modelResources.material.dispose();
    modelResources.uploaded.clear();
}

// ── upload / release ────────────────────────────────────────────────

/**
 * Upload all meshes + images for a model. Image decode is async via
 * `createImageBitmap` (browser API at the I/O boundary, parallel decodes
 * are fine). Atlas regions are keyed by `${modelId}/img/${imageIndex}`.
 *
 * Meshes upload immediately; their meshInfo is written with full-UV-space
 * placeholders and patched once the referenced image lands in the atlas.
 * Untextured meshes (no `image`) are pinned to the reserved white pixel
 * so tint + lighting still apply.
 */
function upload(resources: MeshResources, loader: ResourceLoader, modelId: string, model: Model, _payload: ModelPayload): void {
    const meshNames: string[] = [];
    const meshes = Array.from(model.meshesByName.values());

    for (const m of meshes) {
        const meshKey = `${modelId}/${m.name}`;
        meshNames.push(m.name);
        const geomSlot = uploadGeometry(resources.geometry, meshKey, {
            positions: m.positions,
            normals: m.normals,
            uvs: m.uvs,
            indices: m.indices,
        });
        const hasImage = m.image !== null;
        writeMeshInfo(resources.meshInfo, meshKey, {
            uvOffset: hasImage ? [0, 0] : resources.whiteUv,
            uvScale: hasImage ? [1, 1] : [0, 0],
            firstIndex: geomSlot.indexOffset,
            indexCount: geomSlot.indexCount,
            geometry: geomSlot,
            aabbMin: [m.aabb[0], m.aabb[1], m.aabb[2]],
            aabbMax: [m.aabb[3], m.aabb[4], m.aabb[5]],
        });
    }

    const images = model.images;

    if (images.length === 0) {
        resources.uploaded.set(modelId, { meshNames, imageCount: 0, texturesReady: Promise.resolve() });
        return;
    }

    // decode + blit images in parallel, then patch UVs of meshes whose
    // image ref points at this entry.
    // allocate the atlas region, blit, mark dirty, and patch the UVs of every
    // mesh that references this image. Shared by the browser (createImageBitmap)
    // and headless (injected decoder) decode paths.
    const place = (
        img: (typeof images)[number],
        atlasKey: string,
        width: number,
        height: number,
        blit: (region: { x: number; y: number; w: number; h: number }) => void,
    ): void => {
        const region = MeshAtlas.allocate(resources.atlas, width, height, atlasKey);
        if (!region) {
            console.warn(`[MeshResources] atlas overflow uploading "${modelId}" image`);
            return;
        }
        blit(region);
        MeshAtlas.markDirty(resources.atlas);

        const size = resources.atlas.size;
        const uvOffset: [number, number] = [region.x / size, region.y / size];
        const uvScale: [number, number] = [region.w / size, region.h / size];
        for (const m of meshes) {
            if (m.image !== img) continue;
            const meshKey = `${modelId}/${m.name}`;
            const slot = meshInfoIndexOf(resources.meshInfo, meshKey);
            if (slot === null) continue;
            const existing = resources.meshInfo.entries[slot];
            if (!existing) continue;
            writeMeshInfo(resources.meshInfo, meshKey, { ...existing, uvOffset, uvScale });
        }
    };

    // each chain resolves once its image has been placed (decoded, blitted, UVs
    // patched); a decode failure resolves too (logged, mesh keeps the white
    // fallback) so `texturesReady` never hangs the render on a bad image.
    const decodeChains: Promise<void>[] = [];
    for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const atlasKey = `${modelId}/img/${i}`;
        const decodeImage = loader.decodeImage;
        if (decodeImage) {
            // asset pipeline: injected decoder (sharp) → RGBA, blit raw bytes.
            decodeChains.push(
                decodeImage(img.bytes, img.mimeType)
                    .then(({ width, height, rgba }) => {
                        place(img, atlasKey, width, height, (region) => blitRgbaToAtlas(resources.atlas, region, rgba));
                    })
                    .catch((err) => {
                        console.error(`[MeshResources] decodeImage failed for "${modelId}" image ${i}:`, err);
                    }),
            );
        } else {
            const blob = new Blob([img.bytes as BlobPart], { type: img.mimeType });
            decodeChains.push(
                createImageBitmap(blob)
                    .then((bitmap) => {
                        place(img, atlasKey, bitmap.width, bitmap.height, (region) =>
                            blitBitmapToAtlas(resources.atlas, region, bitmap),
                        );
                        bitmap.close();
                    })
                    .catch((err) => {
                        console.error(`[MeshResources] image decode failed for "${modelId}" image ${i}:`, err);
                    }),
            );
        }
    }

    resources.uploaded.set(modelId, {
        meshNames,
        imageCount: images.length,
        texturesReady: Promise.all(decodeChains).then(() => {}),
    });
}

function release(resources: MeshResources, modelId: string): void {
    const record = resources.uploaded.get(modelId);
    if (!record) return;
    for (const meshName of record.meshNames) {
        const meshKey = `${modelId}/${meshName}`;
        releaseGeometry(resources.geometry, meshKey);
        releaseMeshInfo(resources.meshInfo, meshKey);
    }
    for (let i = 0; i < record.imageCount; i++) {
        MeshAtlas.release(resources.atlas, `${modelId}/img/${i}`);
    }
    resources.uploaded.delete(modelId);
}

/**
 * Blit a decoded ImageBitmap into the atlas's CPU pixel buffer at `region`.
 * Uses an offscreen canvas to extract rgba8, there's no direct bitmap →
 * Uint8Array path in the web platform.
 */
function blitBitmapToAtlas(
    atlas: MeshAtlas.MeshAtlas,
    region: { x: number; y: number; w: number; h: number },
    bitmap: ImageBitmap,
): void {
    const canvas = new OffscreenCanvas(region.w, region.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, region.w, region.h);
    const stride = atlas.size * 4;
    for (let row = 0; row < region.h; row++) {
        const srcOff = row * region.w * 4;
        const dstOff = (region.y + row) * stride + region.x * 4;
        atlas.pixels.set(imgData.data.subarray(srcOff, srcOff + region.w * 4), dstOff);
    }
}

/**
 * Blit tightly-packed RGBA8 pixels (region.w × region.h) into the atlas's CPU
 * pixel buffer at `region`. The headless counterpart of `blitBitmapToAtlas`,
 * the injected decoder already returns raw bytes, so no canvas readback.
 */
function blitRgbaToAtlas(
    atlas: MeshAtlas.MeshAtlas,
    region: { x: number; y: number; w: number; h: number },
    data: Uint8Array,
): void {
    const stride = atlas.size * 4;
    const rowBytes = region.w * 4;
    for (let row = 0; row < region.h; row++) {
        const srcOff = row * rowBytes;
        const dstOff = (region.y + row) * stride + region.x * 4;
        atlas.pixels.set(data.subarray(srcOff, srcOff + rowBytes), dstOff);
    }
}

// ── material ────────────────────────────────────────────────────────
//
// Binds the per-room read-only storage buffers slotMap + instanceData by name
// through each room's geometry (native SSBO reads on WebGPU; gpucat lowers them
// to rgba32uint buffer-texture fetches on WebGL2 — one material source, both
// backends). The interleaved vertex pool binds as a real vertex buffer named
// `vertex` and the index pool as the geometry index. Env is the shared uniform;
// the atlas texture is engine-global, so both are bound by value here.

function createModelMaterial(atlas: MeshAtlas.MeshAtlas, env: EnvironmentResources): Material {
    // HW vertex fetch from the interleaved pool, posU.xyz = pos,
    // posU.w = u; normalV.xyz = normal, normalV.w = v. Stride 32B.
    // Both attributes share the same vertex buffer; gpucat groups
    // same-named attribute() calls into one VertexBufferLayout.
    const posU = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const normalV = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const aPosition = posU.xyz.toVar('mvPos');
    const aNormal = normalV.xyz.toVar('mvNormal');
    const aUv = vec2f(posU.w, normalV.w).toVar('mvUv');

    // slotMap[instanceIndex] resolves to the stable per-slot index in
    // instanceData. WebGPU adds firstInstance to instanceIndex before the
    // VS sees it, so each draw indexes into its own [firstInstance ..]
    // range that mesh-visuals wrote contiguously.
    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const realSlot = slotMap.element(instanceIndex).toVar('mvSlot');

    // per-slot transform + params bundled into one binding.
    const instanceData = storage('instanceData', d.array(ModelInstance), 'read');
    const instRec = instanceData.element(realSlot);
    const worldMatrix = instRec.field('worldMatrix').toVar('mvWorldMatrix');
    const instParams = instRec.field('params').toVar('mvInstParams');

    // transform position
    const worldPos = mul(worldMatrix, vec4f(aPosition, f32(1.0))).toVar('mvWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos)).toVar('mvClipPos');

    // transform normal (no non-uniform scale support, using mat3 of world)
    const col0 = worldMatrix.element(u32(0)).xyz.toVar('mvCol0');
    const col1 = worldMatrix.element(u32(1)).xyz.toVar('mvCol1');
    const col2 = worldMatrix.element(u32(2)).xyz.toVar('mvCol2');
    const normalMat = mat3(col0, col1, col2).toVar('mvNormalMat');
    const worldNormal = normalize(mul(normalMat, aNormal)).toVar('mvWorldNormal');

    // atlas uv: aUv * uvScale + uvOffset (both per-slot in instParams).
    const uvOffset = instParams.field('uvOffset').toVar('mvUvOffset');
    const uvScale = instParams.field('uvScale').toVar('mvUvScale');
    const atlasUv = add(mul(aUv, uvScale), uvOffset).toVar('mvAtlasUv');

    // varyings
    const vUv = varying(atlasUv, 'mvUv').setInterpolation('perspective', 'centroid');
    const vNormal = varying(worldNormal, 'mvNormalV');
    const vTint = varying(instParams.field('tint'), 'mvTint');
    const vFlash = varying(instParams.field('flash'), 'mvFlash');
    // one sample per instance at its light anchor, replacing the per-frame CPU
    // sample + per-instance upload. Grouping (the old `Up(ModelTrait)` shared
    // value) is unnecessary here: the corner lattice blends the 8 cells at each
    // corner with `blendChannelMinNonZero`, so a bone clipping into a wall still
    // reads the open cells beside it instead of going black, which is the pop-dark
    // that grouping existed to prevent.
    // PER VERTEX, at the vertex's own world position, so a mesh half in shadow
    // renders half lit. This used to sample a per-instance anchor, which meant
    // every vertex of an instance recomputed one identical value - the flat look
    // `ModelTrait` grouping used to enforce, and pure redundant work besides.
    const vInstLight = varying(sampleWorldLight(bindLightVolume(env), worldPos.xyz), 'mvInstLight');
    const vGlow = varying(instParams.field('glow'), 'mvGlow');
    const vUnlit = varying(instParams.field('unlit'), 'mvUnlit').setInterpolation('flat');
    const vLitMin = varying(instParams.field('litMin'), 'mvLitMin').setInterpolation('flat');
    const vDither = varying(instParams.field('dither'), 'mvDither').setInterpolation('flat');

    // fragment
    const atlasNode = texture(atlas.texture);
    const texColor = atlasNode.sample(vUv).toVar('mvTexColor');

    // lighting from shared env: sunDirection derives from envTime in-shader;
    // sunIntensity reads envConfig; ambientMinimum is a hardcoded constant.
    const cfg = env.cfgNode;
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(env.timeNode.time, f32(0.25)), TAU).toVar('mvSunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('mvSunDirection');
    const sunIntensity = cfg.sunIntensity.toVar('mvSunIntensity');
    const ambientMinimum = vec3f(f32(0.04), f32(0.04), f32(0.06)).toVar('mvAmbientMin');

    // sky-brightness curve, matches voxel-material so a model and the
    // voxels around it shade identically under the same sky.
    const sunY = sunDirection.y.toVar('mvSunY');
    const dayCurve = smoothstep(f32(-0.1), f32(0.15), sunY).toVar('mvDayCurve');
    const skyBrightnessActive = mix(f32(0.05), f32(0.9), dayCurve).toVar('mvSkyBrightActive');
    const enabledMask = cfg.enabled.toF32().toVar('mvEnabledMask');
    const skyBrightness = mix(f32(1.0), skyBrightnessActive, enabledMask).toVar('mvSkyBright');

    const ndotl = max(dot(vNormal, sunDirection), f32(0.0)).toVar('mvNdotL');
    const sunShade = mix(sub(f32(1.0), sunIntensity), f32(1.0), ndotl).toVar('mvSunShade');

    const skyContrib = vec3f(
        mul(vInstLight.x, skyBrightness),
        mul(vInstLight.x, skyBrightness),
        mul(vInstLight.x, skyBrightness),
    ).toVar('mvSkyContrib');
    const litMinFloor = vec3f(vLitMin, vLitMin, vLitMin).toVar('mvLitMinFloor');
    const voxelLight = max(max(vInstLight.yzw, skyContrib), litMinFloor).toVar('mvVoxelLight');
    const light = max(mul(voxelLight, sunShade), ambientMinimum).toVar('mvLight');

    const litRgb = shadeTinted(texColor.rgb, vTint, vFlash, light, vGlow, vUnlit);
    const foggedRgb = applyFog(env, litRgb, fogDistance(worldPos.xyz, 'mvFogDist'));
    const fragColor = vec4(foggedRgb, texColor.a).toVar('mvFragColor');

    // cutout + screen-door fade: the dither knob feeds the shared discard.
    const fragment = ditherDiscard(fragColor, texColor.a, vDither).toVar('mvFragment');

    return new Material({
        name: 'model',
        vertex: clipPos,
        fragment: fragment,
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
    });
}

/** shader-side inverse of `octEncodeNormal`. */
function octDecodeNormal(packed: Node<d.u32>): Node<d.vec3f> {
    const qx = packed.bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1));
    const qy = packed.shiftRight(u32(8)).bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1));
    const z = f32(1).sub(abs(qx)).sub(abs(qy)).toVar('octZ');
    // the lower hemisphere is folded across the octahedron's diagonals, so undo
    // that fold before normalising.
    const t = max(z.mul(f32(-1)), f32(0)).toVar('octT');
    const x = qx.sub(t.mul(select(f32(-1), f32(1), qx.greaterThanEqual(f32(0)))));
    const y = qy.sub(t.mul(select(f32(-1), f32(1), qy.greaterThanEqual(f32(0)))));
    return normalize(vec3f(x, y, z));
}

/**
 * The outline shell: the same instances drawn again, expanded along the normal,
 * flat-coloured, and stencil-masked to the rim.
 *
 * Masked by DEPTH, drawing the shell's BACK faces (`cull: 'front'`). Those sit
 * behind the mesh's own front faces, so the depth test rejects them wherever the
 * mesh is and only the rim survives.
 *
 * Godot masks with a stencil instead (STENCIL_MODE_OUTLINE), which survives
 * concave geometry better - but a stencil reference is set per DRAW CALL, and we
 * draw every instance in one call, so every mesh necessarily shares one value.
 * That meant any mesh suppressed any outline it overlapped: a character standing
 * behind another erased the nearer one's rim. Depth masks per object for free,
 * because the far character's depth simply loses.
 *
 * Width is in SCREEN pixels. The expansion happens in clip space along the
 * projected normal, scaled by `w`, so perspective divide leaves a constant pixel
 * thickness at any distance. A world-space expansion instead goes sub-pixel far
 * away and the outline quietly disappears, which is the opposite of the point.
 */
function createMeshOutlineMaterial(atlas: MeshAtlas.MeshAtlas): Material {
    const posU = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const normalV = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const aPosition = posU.xyz.toVar('moPos');
    const aUv = vec2f(posU.w, normalV.w).toVar('moUv');
    // the SMOOTHED normal, not the shading one. See `smoothNormals` on the pool:
    // face normals split at every hard edge and tear the shell open.
    const aSmoothNormal = octDecodeNormal(attribute('smoothNormal', d.u32)).toVar('moSmoothNormal');

    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const realSlot = slotMap.element(instanceIndex).toVar('moSlot');
    const instanceData = storage('instanceData', d.array(ModelInstance), 'read');
    const instRec = instanceData.element(realSlot);
    const worldMatrix = instRec.field('worldMatrix').toVar('moWorldMatrix');
    const instParams = instRec.field('params').toVar('moInstParams');
    const width = instParams.field('outlineWidth').toVar('moWidth');
    const space = instParams.field('outlineSpace').toVar('moSpace');

    const worldPos = mul(worldMatrix, vec4f(aPosition, f32(1.0))).toVar('moWorldPos');

    const col0 = worldMatrix.element(u32(0)).xyz;
    const col1 = worldMatrix.element(u32(1)).xyz;
    const col2 = worldMatrix.element(u32(2)).xyz;
    // ROTATION ONLY: normalise the basis columns, dropping the part's scale.
    // Character parts are unit boxes scaled non-uniformly into limbs, and the
    // choice of transform here is the whole ball game.
    //
    //   raw matrix           - a position delta gets stretched by the scale, so on
    //                          an arm scaled long in Y every direction tilts toward
    //                          Y. Taller than it is wide.
    //   inverse-transpose    - right for a FACE normal, wrong for the corner
    //                          diagonal: it yields (1/sx, 1/sy, 1/sz) when the true
    //                          answer is the average of the three world face
    //                          normals, which axis-aligned scale leaves untouched.
    //   normalised columns   - correct for both, because it is exactly that average.
    const rot = mat3(normalize(col0), normalize(col1), normalize(col2)).toVar('moRot');
    const worldGrow = normalize(mul(rot, aSmoothNormal)).toVar('moWorldGrow');

    // EXPAND IN 3D, in world space, exactly like Godot's `VERTEX += NORMAL * grow`.
    // Projecting the direction into clip space and renormalising it in 2D looks
    // equivalent and is not: a vertex growing mostly toward or away from the camera
    // has a near-zero xy component, and renormalising that blows the vertex out to
    // full width in an arbitrary screen direction. That is uneven expansion, and it
    // is the reason to stay in 3D.
    //
    // Screen-constant thickness then comes from scaling the world DISTANCE by view
    // depth, never from touching the direction. `proj[1][1]` is `1 / tan(fovY/2)`,
    // so one pixel at one unit of depth spans `2 / (proj[1][1] * screenHeight)`
    // world units; times the view depth is what a pixel is worth at this vertex.
    const viewPos = mul(cameraViewMatrix, worldPos).toVar('moViewPos');
    const viewDepth = max(viewPos.z.mul(f32(-1)), f32(0.001)).toVar('moViewDepth');
    const screen = max(screenSize, vec2f(f32(1), f32(1))).toVar('moScreen');
    const projYY = max(cameraProjectionMatrix.element(u32(1)).y, f32(0.001)).toVar('moProjYY');
    const worldPerPixel = f32(2).div(projYY.mul(screen.y)).mul(viewDepth).toVar('moWorldPerPixel');
    // world space is the same expansion with the depth term dropped, so the two
    // modes are one multiply apart rather than two code paths.
    const perUnit = mix(f32(1), worldPerPixel, space).toVar('moPerUnit');

    const grownWorld = worldPos.xyz.add(worldGrow.mul(width).mul(perUnit)).toVar('moGrownWorld');
    const viewProj = mul(cameraProjectionMatrix, cameraViewMatrix).toVar('moViewProj');
    const grown = mul(viewProj, vec4f(grownWorld, f32(1.0))).toVar('moGrown');
    // width 0 means no outline. Push the whole triangle outside the frustum
    // rather than relying on a zero-size shell: every vertex of a triangle shares
    // one instance, so all three collapse identically and the clipper drops it
    // before any fragment work happens.
    const OFF = vec4f(f32(2), f32(2), f32(2), f32(1));
    const vertex = select(OFF, grown, width.greaterThan(f32(0))).toVar('moVertex');

    const uvOffset = instParams.field('uvOffset');
    const uvScale = instParams.field('uvScale');
    const vUv = varying(add(mul(aUv, uvScale), uvOffset), 'moAtlasUv').setInterpolation('perspective', 'centroid');
    const vColor = varying(instParams.field('outlineColor'), 'moColor');

    // honour the mesh's own cutout so a leaf or a hair card outlines its actual
    // silhouette rather than its quad.
    const texAlpha = texture(atlas.texture).sample(vUv).a.toVar('moTexAlpha');
    const fragment = ditherDiscard(vColor, texAlpha, f32(0)).toVar('moFragment');

    return new Material({
        name: 'model-outline',
        vertex,
        fragment: fragment,
        // FRONT-culled: we want the shell's back faces, which the mesh's own front
        // faces then occlude. See above.
        cullMode: 'front',
        depthTest: true,
        // WRITES DEPTH, unlike Godot's, which only skips it because it is alpha
        // transparent. This shell is opaque, so the rim is real covering geometry:
        // writing depth makes overlapping outlines resolve by distance instead of by
        // draw order, and lets anything drawn later sort against the rim. Safe where
        // it matters, because over the mesh itself the stencil rejects first and a
        // stencil failure writes no depth - only the rim ever writes.
        depthWrite: true,
        // OPAQUE, despite drawing after the mesh. `transparent: true` sorts the
        // shell into the same bucket as the voxel translucent pass, which writes no
        // depth - so water and outlines end up ordered by renderOrder rather than by
        // depth, and the shell (renderOrder 1) paints straight over water it is
        // actually behind. It also gives every instance ONE sort position, since the
        // shell is a single Mesh with many draws, so instances cannot order against
        // each other either. The cost is that `outline.color`'s alpha no longer
        // blends; renderOrder still puts this after the mesh, which is all the
        // stencil needs.
        transparent: false,
    });
}
