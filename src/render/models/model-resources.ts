// ModelResources, client-global GPU pools backing all model rendering.
//
// Owns the texture atlas, the CPU-side mesh-info catalog (firstIndex,
// indexCount, uv, AABB per mesh), pooled vertex/index buffers, and the
// engine-global model material. One instance per `EngineClient`; shared
// across all rooms and all `ModelVisuals` consumers.
//
// Lifetime is tied to model load/unload, NOT to instance count. Polling-
// driven: each tick `update(modelResources, resources)` walks
// `resources.modelPayloads` for newly-ready models (uploads them to the
// pools and nulls `payload.model` to free the source bytes) and for
// vanished payloads (releases their pool slots).
//
// ── render pipeline ────────────────────────────────────────────────
// CPU (model-visuals.ts) per frame:
//   - walks visible MeshVisualStates, buckets each into the slot-list for
//     its mesh, then per-bucket writes slots contiguously into `slotMap`
//     and appends one `DrawIndexedIndirect` entry covering that range.
//
// GPU material VS (HW instanced):
//   - reads `posU` / `normalV` from the interleaved vertex pool by HW
//     attribute fetch.
//   - `realSlot = slotMap[instanceIndex]` (firstInstance is added by HW
//     before the VS sees it, so each draw indexes into its own range).
//   - `instanceData[realSlot]` for per-instance world matrix + params
//     (params now carries `uvOffset` / `uvScale`).
//
// One drawIndexedIndirect per visible bucket per frame. No compute
// dispatch, no vertex-pull, no triangle queue.

import {
    add,
    attribute,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    d,
    dot,
    f32,
    GpuBuffer,
    instanceIndex,
    layoutStrideOf,
    Material,
    mat3,
    max,
    mix,
    mul,
    normalize,
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
import { EnvConfig } from '../environment';
import { ditherDiscard, shadeTinted } from '../visuals/dsl';
import * as ModelAtlas from './model-atlas';

// ── gpu structs ─────────────────────────────────────────────────────

export const InstanceParams = struct('ModelInstanceParams', {
    // tint: rgb is the recolour target, a the intensity (lightness-preserving).
    tint: d.vec4f,
    // flash: transient overlay, rgb is the colour, a the strength (lerp).
    flash: d.vec4f,
    light: d.vec4f,
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
    // the atlas, re-uploaded on entry-ref mismatch in model-visuals.
    uvOffset: d.vec2f,
    uvScale: d.vec2f,
});

// Per-slot stable instance record. Merges what were two separate
// storage buffers (transforms + params) into one binding, same
// cardinality, same writer, same grow lifecycle.
//
// Layout: mat4x4f (64B, align 16) then InstanceParams (80B, align 16)
// → total 144B per slot, struct align 16, no internal padding.
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
/** f32-index offset of the `params` member inside `ModelInstance`. Used by
 *  the inlined params writer in model-visuals, keep in sync with
 *  `MODEL_INSTANCE_PARAMS_OFFSET` (64 bytes = 16 f32). */
export const MODEL_INSTANCE_PARAMS_OFFSET_F32 = 16;
export const MODEL_VERTEX_STRIDE = layoutStrideOf(ModelVertex);
const MODEL_VERTEX_STRIDE_F32 = MODEL_VERTEX_STRIDE / 4; // 8

// ── geometry pool ───────────────────────────────────────────────────
// Pooled interleaved vertex + index buffers, slot-allocated per uploaded
// mesh. One big GpuBuffer per pool, bound to the Geometry as vertex /
// index buffers; the VS reads `posU` / `normalV` via HW attribute fetch
// and indices are consumed by HW (one drawIndexedIndirect per visible
// bucket). UVs ride in the `.w` lanes of the interleaved attributes.

export type GeometrySlot = {
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
    indices: GpuBuffer<d.u32>;
    vertexAllocator: RangeAllocator;
    indexAllocator: RangeAllocator;
};

function createGeometryPool(
    initialVertexCapacity = INITIAL_VERTEX_CAPACITY,
    initialIndexCapacity = INITIAL_INDEX_CAPACITY,
): ModelGeometryPool {
    // MANUAL lifecycle: this pool owns the buffers across script-reload, many
    // ModelVisuals geometries bind to and dispose them per reload, but the pool
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

    return {
        slots: new Map(),
        vertices,
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
// firstIndex/indexCount, local AABB) read by model-visuals each frame
// and by offline tasks for camera fitting.

export type MeshInfoEntry = {
    uvOffset: [number, number];
    uvScale: [number, number];
    firstIndex: number;
    indexCount: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
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

export type ModelResources = {
    atlas: ModelAtlas.ModelAtlas;
    meshInfo: MeshInfoCatalog;
    geometry: ModelGeometryPool;
    /** modelId → upload record. presence = "uploaded"; drives release-on-removal. */
    uploaded: Map<string, UploadRecord>;
    /** UV of the reserved white pixel, fallback for untextured meshes. */
    whiteUv: [number, number];
    /** engine-global model material, HW instanced. Per-room buffers
     *  (slotMap, instanceData, env) bind by name through each room's
     *  geometry; the interleaved vertex pool binds as a vertex buffer
     *  named `vertex`, the index pool as the geometry index. */
    material: Material;
};

const WHITE_PIXEL_KEY = '__white__';

export function init(): ModelResources {
    const atlas = ModelAtlas.create();

    // reserve a 1×1 white pixel so untextured meshes can sample white
    // (multiplied by tint) instead of zero-init black.
    const whiteRegion = ModelAtlas.allocate(atlas, 1, 1, WHITE_PIXEL_KEY);
    if (!whiteRegion) throw new Error('ModelResources.init: atlas overflow on white-pixel reserve');
    const stride = atlas.size * 4;
    const off = whiteRegion.y * stride + whiteRegion.x * 4;
    atlas.pixels[off + 0] = 255;
    atlas.pixels[off + 1] = 255;
    atlas.pixels[off + 2] = 255;
    atlas.pixels[off + 3] = 255;
    ModelAtlas.markDirty(atlas);
    const whiteUv: [number, number] = [(whiteRegion.x + 0.5) / atlas.size, (whiteRegion.y + 0.5) / atlas.size];

    const meshInfo = createMeshCatalog();
    const geometry = createGeometryPool();

    const material = createModelMaterial(atlas);

    return {
        atlas,
        meshInfo,
        geometry,
        uploaded: new Map(),
        whiteUv,
        material,
    };
}

/**
 * Per-tick sync. Uploads any `ready` payload that hasn't been uploaded
 * yet (and nulls `payload.model` to free the source bytes); releases any
 * tracked modelId whose payload has been removed from
 * `resources.modelPayloads`.
 */
export function update(modelResources: ModelResources, resources: Resources): void {
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
export function modelTexturesReady(modelResources: ModelResources, modelId: string): Promise<void> {
    return modelResources.uploaded.get(modelId)?.texturesReady ?? Promise.resolve();
}

export function dispose(modelResources: ModelResources): void {
    ModelAtlas.dispose(modelResources.atlas);
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
function upload(resources: ModelResources, loader: ResourceLoader, modelId: string, model: Model, _payload: ModelPayload): void {
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
        const region = ModelAtlas.allocate(resources.atlas, width, height, atlasKey);
        if (!region) {
            console.warn(`[ModelResources] atlas overflow uploading "${modelId}" image`);
            return;
        }
        blit(region);
        ModelAtlas.markDirty(resources.atlas);

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
                        console.error(`[ModelResources] decodeImage failed for "${modelId}" image ${i}:`, err);
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
                        console.error(`[ModelResources] image decode failed for "${modelId}" image ${i}:`, err);
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

function release(resources: ModelResources, modelId: string): void {
    const record = resources.uploaded.get(modelId);
    if (!record) return;
    for (const meshName of record.meshNames) {
        const meshKey = `${modelId}/${meshName}`;
        releaseGeometry(resources.geometry, meshKey);
        releaseMeshInfo(resources.meshInfo, meshKey);
    }
    for (let i = 0; i < record.imageCount; i++) {
        ModelAtlas.release(resources.atlas, `${modelId}/img/${i}`);
    }
    resources.uploaded.delete(modelId);
}

/**
 * Blit a decoded ImageBitmap into the atlas's CPU pixel buffer at `region`.
 * Uses an offscreen canvas to extract rgba8, there's no direct bitmap →
 * Uint8Array path in the web platform.
 */
function blitBitmapToAtlas(
    atlas: ModelAtlas.ModelAtlas,
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
    atlas: ModelAtlas.ModelAtlas,
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
// Binds the per-room slotMap + instanceData + env by name through each
// room's geometry; the interleaved vertex pool binds as a real vertex
// buffer named `vertex` and the index pool as the geometry index.
// Atlas texture is engine-global, so it's bound by value here.

function createModelMaterial(atlas: ModelAtlas.ModelAtlas): Material {
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
    // range that model-visuals wrote contiguously.
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
    const vInstLight = varying(instParams.field('light'), 'mvInstLight');
    const vGlow = varying(instParams.field('glow'), 'mvGlow');
    const vUnlit = varying(instParams.field('unlit'), 'mvUnlit').setInterpolation('flat');
    const vLitMin = varying(instParams.field('litMin'), 'mvLitMin').setInterpolation('flat');
    const vDither = varying(instParams.field('dither'), 'mvDither').setInterpolation('flat');

    // fragment
    const atlasNode = texture(atlas.texture);
    const texColor = atlasNode.sample(vUv).toVar('mvTexColor');

    // lighting from shared env: sunDirection derives from envTime in-shader;
    // sunIntensity reads envConfig; ambientMinimum is a hardcoded constant.
    const cfg = storage('env', EnvConfig, 'read').fields();
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('mvSunAngle');
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
    const fragColor = vec4(litRgb, texColor.a).toVar('mvFragColor');

    // cutout + screen-door fade: the dither knob feeds the shared discard.
    const fragment = ditherDiscard(fragColor, texColor.a, vDither).toVar('mvFragment');

    return new Material({
        name: 'model',
        vertex: clipPos,
        fragment,
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
    });
}
