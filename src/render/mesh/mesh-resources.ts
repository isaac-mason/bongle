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

export const InstanceParams = struct('ModelInstanceParams', {
    // tint: rgb recolour target, a is intensity (lightness-preserving).
    tint: d.vec4f,
    // flash: rgb overlay colour, a is lerp strength.
    flash: d.vec4f,
    // glow: 0-1, additive.
    glow: d.f32,
    // unlit: 0 = lit, 1 = bypass lighting; f32 so the shader can mix() not branch.
    unlit: d.f32,
    // litMin: floor on voxel light, 0..1.
    litMin: d.f32,
    // dither: screen-door fade, 0 = solid, 1 = invisible.
    dither: d.f32,
    uvOffset: d.vec2f,
    uvScale: d.vec2f,
    outlineColor: d.vec4f,
    // outlineWidth: 0 = no outline. Units depend on outlineSpace.
    outlineWidth: d.f32,
    // outlineSpace: 1 = screen pixels (constant width), 0 = world units (shrinks with distance).
    outlineSpace: d.f32,
});

// layout: mat4x4f (64B, align 16) then InstanceParams (96B, align 16), 160B per slot.
export const ModelInstance = struct('ModelInstance', {
    worldMatrix: d.mat4x4f,
    params: InstanceParams,
});

// posU.xyz = position, posU.w = u; normalV.xyz = normal, normalV.w = v.
export const ModelVertex = struct('ModelVertex', {
    posU: d.vec4f,
    normalV: d.vec4f,
});

export const INSTANCE_PARAMS_STRIDE = layoutStrideOf(InstanceParams);
export const MODEL_INSTANCE_STRIDE = layoutStrideOf(ModelInstance);
// byte offset of `params` inside `ModelInstance` (after the mat4x4f).
export const MODEL_INSTANCE_PARAMS_OFFSET = 64;
export const MODEL_INSTANCE_PARAMS_OFFSET_F32 = MODEL_INSTANCE_PARAMS_OFFSET / 4;
export const INSTANCE_PARAMS_STRIDE_F32 = INSTANCE_PARAMS_STRIDE / 4;
export const MODEL_INSTANCE_STRIDE_F32 = MODEL_INSTANCE_STRIDE / 4;
export const MODEL_VERTEX_STRIDE = layoutStrideOf(ModelVertex);
const MODEL_VERTEX_STRIDE_F32 = MODEL_VERTEX_STRIDE / 4; // 8

const INITIAL_INSTANCE_CAPACITY = 4096;

export type GeometrySlot = {
    // whether pool.smoothNormals has been filled for this slot; only outlined meshes pay for it.
    smoothReady: boolean;
    vertexOffset: number;
    vertexCount: number;
    // in indices, not bytes.
    indexOffset: number;
    indexCount: number;
};

export type ModelGeometryUpload = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    // uint16 not supported, keeps slot math uniform across meshes.
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
    /** mesh-key -> slot. */
    slots: Map<string, GeometrySlot>;
    /** interleaved {posU, normalV} per vertex. */
    vertices: GpuBuffer<typeof ModelVertex>;
    // oct-encoded smoothed normal per vertex (4B), parallel to `vertices`; only the outline shell reads it.
    smoothNormals: GpuBuffer<d.u32>;
    indices: GpuBuffer<d.u32>;
    vertexAllocator: RangeAllocator;
    indexAllocator: RangeAllocator;
};

function createGeometryPool(
    initialVertexCapacity = INITIAL_VERTEX_CAPACITY,
    initialIndexCapacity = INITIAL_INDEX_CAPACITY,
): ModelGeometryPool {
    // MANUAL lifecycle: the pool outlives the MeshVisuals geometries that bind to it across reloads.
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
    // allocated eagerly since the outline shell binds it every frame regardless.
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

// reserves vertex+index ranges for `meshKey`, copies `geom` in, and queues GPU uploads; idempotent.
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

    // interleave into the single vertex pool: [posX, posY, posZ, u, normX, normY, normZ, v].
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

    const base = vRange.offset;
    for (let i = 0; i < indexCount; i++) {
        idxArr[iRange.offset + i] = geom.indices[i]! + base;
    }

    pool.vertices.addUpdateRange(vRange.offset * MODEL_VERTEX_STRIDE_F32, vertexCount * MODEL_VERTEX_STRIDE_F32);
    pool.indices.addUpdateRange(iRange.offset, indexCount);

    return slot;
}

// pushes `meshKey`'s ranges to the free-lists; GPU bytes are overwritten on next use, not cleared.
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

    // parallel array, same vertex indexing: must grow in lockstep with `vertices`.
    const oldSmooth = pool.smoothNormals.array as Uint32Array;
    const nextSmooth = new Uint32Array(newCapacity);
    nextSmooth.set(oldSmooth);
    pool.smoothNormals.array = nextSmooth;
    pool.smoothNormals.needsUpdate = true;
}

// octahedral-encodes a unit vector into 8:8 fixed point packed in a u32.
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

// fills pool.smoothNormals for one slot by averaging normals of vertices sharing a position; lazy, idempotent.
export function ensureSmoothNormals(pool: ModelGeometryPool, slot: GeometrySlot): void {
    if (slot.smoothReady) return;
    slot.smoothReady = true;

    const vertArr = pool.vertices.array as Float32Array;
    const out = pool.smoothNormals.array as Uint32Array;
    const base = slot.vertexOffset * MODEL_VERTEX_STRIDE_F32;
    const count = slot.vertexCount;

    // quantised so vertices meant to be coincident collide even after a lossy export.
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
        // a degenerate fan cancels to zero; fall back to this vertex's own normal.
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

// CPU-only per-mesh metadata, read by mesh-visuals each frame and by offline camera fitting.

export type MeshInfoEntry = {
    uvOffset: [number, number];
    uvScale: [number, number];
    firstIndex: number;
    indexCount: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    // lets the write loop trigger the lazy smoothed-normal bake the first time something outlines this mesh.
    geometry: GeometrySlot;
};

export type MeshInfoCatalog = {
    indexByKey: Map<string, number>;
    // dense array; index === slot. Holes (nulls) filled lazily from `freeList`.
    entries: (MeshInfoEntry | null)[];
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

// client-global instance batch: reused across room swaps rather than freed and reallocated.

// free-list allocator over the instance buffers; reset per room via `resetMeshBatch`.
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
    // added to the active room's scene on `enter`, removed on `exit`; never disposed on a room swap.
    mesh: Mesh;
    geometry: Geometry;
    // the outline shell, sharing this batch's geometry, buffers and draw list.
    outlineMesh: Mesh;
    // stable per-slot {worldMatrix, params}, 160B/slot; read-only storage.
    instanceDataBuf: GpuBufferType;
    // per-frame u32[] sized to `instanceCapacity`; slotMap[instanceIndex] -> slot.
    slotMapBuf: GpuBufferType;
    // shared by identity with `mesh.draws`.
    draws: IndexedMeshDraw[];
    // meshSlot -> array of stable slots, reused across frames.
    _bucketScratch: Map<number, number[]>;
    // empty arrays freed by stale-bucket sweeps, reused on next insert.
    _freeBuckets: number[][];
    // gates `instanceDataBuf` + `slotMapBuf`; grows 2x.
    instanceCapacity: number;
    instanceAllocator: Allocator;

    // last frame's instance-upload shape; dirtySpan >> dirtyInstances means scattered slots are dragging neighbours along.
    aliveInstances: number;
    dirtyInstances: number;
    dirtySpan: number;
};

// builds the client-global instance batch; not added to any scene until a room enters.
function createMeshBatch(pool: ModelGeometryPool, material: Material, outlineMaterial: Material): MeshBatch {
    const instanceCapacity = INITIAL_INSTANCE_CAPACITY;

    const geometry = new Geometry();
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

    // shares geometry, buffers, and draw list; instances with outlineWidth 0 collapse outside the frustum.
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

// readies the batch for a fresh room: empties the allocator, scratch, and draw list; buffers untouched.
export function resetMeshBatch(batch: MeshBatch): void {
    batch.instanceAllocator.head = 0;
    batch.instanceAllocator.freeList.length = 0;
    batch._bucketScratch.clear();
    batch._freeBuckets.length = 0;
    batch.draws.length = 0;
}

// webgpu buffers are immutable in size, so growing allocates a fresh GpuBuffer and copies.
export function growMeshBatch(batch: MeshBatch, newCapacity: number): void {
    const geometry = batch.geometry;

    // preserve per-slot bytes; transforms + params are versioned and won't re-upload until changed.
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

// called once at client shutdown, never on room swap.
function disposeMeshBatch(batch: MeshBatch): void {
    // pool vertex/index buffers are MANUAL, so geometry.dispose() is a no-op on them.
    batch.geometry.dispose();
    batch.instanceDataBuf.dispose();
    batch.slotMapBuf.dispose();
}

type UploadRecord = {
    // mesh names uploaded for this model; releases pool slots by name.
    meshNames: string[];
    // image count from the model; releases atlas regions by index.
    imageCount: number;
    // resolves once every image for this model has decoded and patched its meshes' UVs.
    texturesReady: Promise<void>;
};

export type MeshResources = {
    atlas: MeshAtlas.MeshAtlas;
    meshInfo: MeshInfoCatalog;
    geometry: ModelGeometryPool;
    // modelId -> upload record; presence means "uploaded", drives release-on-removal.
    uploaded: Map<string, UploadRecord>;
    // UV of the reserved white pixel, fallback for untextured meshes.
    whiteUv: [number, number];
    // engine-global model material, HW instanced.
    material: Material;
    // client-global instance batch, reused across room swaps; per-room MeshVisuals drive it via enter/exit.
    batch: MeshBatch;
};

const WHITE_PIXEL_KEY = '__white__';

export function init(env: EnvironmentResources): MeshResources {
    const atlas = MeshAtlas.create();

    // reserve a 1x1 white pixel so untextured meshes sample white (times tint) instead of black.
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

// per-tick sync: uploads any ready payload not yet uploaded, and releases any tracked modelId whose payload vanished.
export function update(modelResources: MeshResources, resources: Resources): void {
    for (const [modelId, payload] of resources.modelPayloads) {
        if (payload.state !== 'ready') continue;
        if (modelResources.uploaded.has(modelId)) continue;
        if (!payload.model) continue;
        upload(modelResources, resources.loader, modelId, payload.model, payload);
        payload.model = null;
    }

    for (const modelId of modelResources.uploaded.keys()) {
        if (!resources.modelPayloads.has(modelId)) {
            release(modelResources, modelId);
        }
    }
}

// resolves once `modelId`'s textures are resident in the atlas, or immediately if untextured/not uploaded.
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

// uploads all meshes + images for a model; meshes land immediately, textures patch in once decoded.
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

    // allocates the atlas region, blits, and patches the UVs of every mesh referencing this image.
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

    // a decode failure resolves too (logged, white fallback kept), so `texturesReady` never hangs.
    const decodeChains: Promise<void>[] = [];
    for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const atlasKey = `${modelId}/img/${i}`;
        const decodeImage = loader.decodeImage;
        if (decodeImage) {
            // asset pipeline: injected decoder (sharp) -> RGBA, blit raw bytes.
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

// blits a decoded ImageBitmap into the atlas's CPU pixel buffer via an offscreen canvas.
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

// headless counterpart of `blitBitmapToAtlas`; blits tightly-packed RGBA8 pixels with no canvas readback.
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

// binds the per-room read-only storage buffers slotMap + instanceData by name through each room's geometry.
function createModelMaterial(atlas: MeshAtlas.MeshAtlas, env: EnvironmentResources): Material {
    // both attributes share the same vertex buffer; gpucat groups same-named attribute() calls into one layout.
    const posU = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const normalV = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const aPosition = posU.xyz.toVar('mvPos');
    const aNormal = normalV.xyz.toVar('mvNormal');
    const aUv = vec2f(posU.w, normalV.w).toVar('mvUv');

    // WebGPU adds firstInstance to instanceIndex, so each draw indexes its own range mesh-visuals wrote.
    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const realSlot = slotMap.element(instanceIndex).toVar('mvSlot');

    const instanceData = storage('instanceData', d.array(ModelInstance), 'read');
    const instRec = instanceData.element(realSlot);
    const worldMatrix = instRec.field('worldMatrix').toVar('mvWorldMatrix');
    const instParams = instRec.field('params').toVar('mvInstParams');

    const worldPos = mul(worldMatrix, vec4f(aPosition, f32(1.0))).toVar('mvWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos)).toVar('mvClipPos');

    // no non-uniform scale support, uses mat3 of world directly.
    const col0 = worldMatrix.element(u32(0)).xyz.toVar('mvCol0');
    const col1 = worldMatrix.element(u32(1)).xyz.toVar('mvCol1');
    const col2 = worldMatrix.element(u32(2)).xyz.toVar('mvCol2');
    const normalMat = mat3(col0, col1, col2).toVar('mvNormalMat');
    const worldNormal = normalize(mul(normalMat, aNormal)).toVar('mvWorldNormal');

    const uvOffset = instParams.field('uvOffset').toVar('mvUvOffset');
    const uvScale = instParams.field('uvScale').toVar('mvUvScale');
    const atlasUv = add(mul(aUv, uvScale), uvOffset).toVar('mvAtlasUv');

    const vUv = varying(atlasUv, 'mvUv').setInterpolation('perspective', 'centroid');
    const vNormal = varying(worldNormal, 'mvNormalV');
    const vTint = varying(instParams.field('tint'), 'mvTint');
    const vFlash = varying(instParams.field('flash'), 'mvFlash');
    // sampled per vertex at its own world position, so a mesh half in shadow renders half lit.
    const vInstLight = varying(sampleWorldLight(bindLightVolume(env), worldPos.xyz), 'mvInstLight');
    const vGlow = varying(instParams.field('glow'), 'mvGlow');
    const vUnlit = varying(instParams.field('unlit'), 'mvUnlit').setInterpolation('flat');
    const vLitMin = varying(instParams.field('litMin'), 'mvLitMin').setInterpolation('flat');
    const vDither = varying(instParams.field('dither'), 'mvDither').setInterpolation('flat');

    const atlasNode = texture(atlas.texture);
    const texColor = atlasNode.sample(vUv).toVar('mvTexColor');

    const cfg = env.cfgNode;
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(env.timeNode.time, f32(0.25)), TAU).toVar('mvSunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('mvSunDirection');
    const sunIntensity = cfg.sunIntensity.toVar('mvSunIntensity');
    const ambientMinimum = vec3f(f32(0.04), f32(0.04), f32(0.06)).toVar('mvAmbientMin');

    // matches voxel-material's sky-brightness curve so models shade identically to voxels around them.
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

// shader-side inverse of `octEncodeNormal`.
function octDecodeNormal(packed: Node<d.u32>): Node<d.vec3f> {
    const qx = packed.bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1));
    const qy = packed.shiftRight(u32(8)).bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1));
    const z = f32(1).sub(abs(qx)).sub(abs(qy)).toVar('octZ');
    // undo the lower hemisphere's fold across the octahedron's diagonals before normalising.
    const t = max(z.mul(f32(-1)), f32(0)).toVar('octT');
    const x = qx.sub(t.mul(select(f32(-1), f32(1), qx.greaterThanEqual(f32(0)))));
    const y = qy.sub(t.mul(select(f32(-1), f32(1), qy.greaterThanEqual(f32(0)))));
    return normalize(vec3f(x, y, z));
}

// the outline shell: same instances drawn again, expanded along the normal, masked to the rim by depth.
function createMeshOutlineMaterial(atlas: MeshAtlas.MeshAtlas): Material {
    const posU = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const normalV = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const aPosition = posU.xyz.toVar('moPos');
    const aUv = vec2f(posU.w, normalV.w).toVar('moUv');
    // the smoothed normal, not the shading one; shading normals split at hard edges and tear the shell.
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
    // normalised basis columns drop non-uniform scale; correct for both a face normal and a corner diagonal.
    const rot = mat3(normalize(col0), normalize(col1), normalize(col2)).toVar('moRot');
    const worldGrow = normalize(mul(rot, aSmoothNormal)).toVar('moWorldGrow');

    // expand in world space, not clip-space: a vertex growing toward the camera has near-zero clip-space xy.
    const viewPos = mul(cameraViewMatrix, worldPos).toVar('moViewPos');
    const viewDepth = max(viewPos.z.mul(f32(-1)), f32(0.001)).toVar('moViewDepth');
    const screen = max(screenSize, vec2f(f32(1), f32(1))).toVar('moScreen');
    const projYY = max(cameraProjectionMatrix.element(u32(1)).y, f32(0.001)).toVar('moProjYY');
    const worldPerPixel = f32(2).div(projYY.mul(screen.y)).mul(viewDepth).toVar('moWorldPerPixel');
    // world-space mode is the same expansion with the depth term dropped, one multiply apart.
    const perUnit = mix(f32(1), worldPerPixel, space).toVar('moPerUnit');

    const grownWorld = worldPos.xyz.add(worldGrow.mul(width).mul(perUnit)).toVar('moGrownWorld');
    const viewProj = mul(cameraProjectionMatrix, cameraViewMatrix).toVar('moViewProj');
    const grown = mul(viewProj, vec4f(grownWorld, f32(1.0))).toVar('moGrown');
    // width 0: push the whole triangle outside the frustum instead of relying on a zero-size shell.
    const OFF = vec4f(f32(2), f32(2), f32(2), f32(1));
    const vertex = select(OFF, grown, width.greaterThan(f32(0))).toVar('moVertex');

    const uvOffset = instParams.field('uvOffset');
    const uvScale = instParams.field('uvScale');
    const vUv = varying(add(mul(aUv, uvScale), uvOffset), 'moAtlasUv').setInterpolation('perspective', 'centroid');
    const vColor = varying(instParams.field('outlineColor'), 'moColor');

    // honour the mesh's own cutout so a leaf or hair card outlines its actual silhouette, not its quad.
    const texAlpha = texture(atlas.texture).sample(vUv).a.toVar('moTexAlpha');
    const fragment = ditherDiscard(vColor, texAlpha, f32(0)).toVar('moFragment');

    return new Material({
        name: 'model-outline',
        vertex,
        fragment: fragment,
        cullMode: 'front', // shell's back faces, occluded by the mesh's own front faces
        depthTest: true,
        // writing depth makes overlapping outlines resolve by distance rather than draw order.
        depthWrite: true,
        // transparent would sort into the no-depth-write bucket and paint over water behind it.
        transparent: false,
    });
}
