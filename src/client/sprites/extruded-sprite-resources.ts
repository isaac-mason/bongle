// ExtrudedSpriteResources — engine-global extruded-sprite material +
// shared geometry pool.
//
// One instance per `EngineClient`, shared across rooms. The atlas Texture
// is owned by `SpriteResources` — this struct holds a TextureNode bound at
// build time and exposes `rebindAtlas()` so the registry-dispatch atlas
// swap can retarget it without rebuilding the compiled pipeline.
//
// The geometry pool is also engine-global: a sprite's silhouette mesh
// bakes once and is reused across every room that references it.
// `clearGeometryPool` wipes slots + resets allocators (without disposing
// the underlying GpuBuffers) so atlas-swap invalidation doesn't break
// per-room geometry bindings.
//
// Material binds per-room buffers by name (`instanceData`, `slotMap`,
// `env`); the engine-global pool's interleaved vertex buffer binds as the
// HW `vertex` attribute and the pool's index buffer as the geometry index.
//
// ── render pipeline ────────────────────────────────────────────────
// CPU (extruded-sprite-visuals.ts) per frame:
//   - walks visible aliveStates, buckets each by `geomSlot` identity,
//     then per-bucket writes the bucket's stable slots contiguously
//     into `slotMap` and appends one DrawIndexedIndirect entry covering
//     that range.
//
// GPU material VS (HW instanced):
//   - reads `posU` / `v` from the interleaved vertex pool by HW
//     attribute fetch.
//   - `realSlot = slotMap[instanceIndex]` (firstInstance is added by HW
//     before the VS sees it, so each draw indexes into its own range).
//   - `instanceData[realSlot]` for per-instance world matrix + material
//     (uvRect/tint/light/glow/unlit/litMin).
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
    Discard,
    Fn,
    f32,
    GpuBuffer,
    If,
    instanceIndex,
    layoutStrideOf,
    Material,
    max,
    mix,
    mul,
    sin,
    smoothstep,
    storage,
    struct,
    sub,
    type Texture,
    texture,
    varying,
    vec2f,
    vec3f,
    vec4f,
} from 'gpucat';
import type { TextureNode } from 'gpucat/dist/nodes/nodes';
import { EnvConfig } from '../environment';
import { bakeExtrudedSpriteMesh } from './sprite-extrusion';
import type { SpriteResources } from './sprite-resources';

// ── shared gpu structs ──────────────────────────────────────────────
//
// Exported so per-room ExtrudedSpriteVisuals can pack into the matching
// layout.

export const InstanceMaterial = struct('ExtrudedSpriteInstanceMaterial', {
    uvRect: d.vec4f,
    tint: d.vec4f,
    light: d.vec4f,
    glow: d.f32,
    unlit: d.f32,
    litMin: d.f32,
});

// Per-slot stable instance record. Merges transform + material into one
// binding — mirrors ModelInstance so downstream visuals shares its update
// shape.
//
// Layout: mat4x4f (64B, align 16) then InstanceMaterial (64B, align 16)
// → total 128B per slot, struct align 16, no internal padding.
export const ExtrudedInstance = struct('ExtrudedInstance', {
    worldMatrix: d.mat4x4f,
    material: InstanceMaterial,
});

// Interleaved vertex for the geometry pool.
//
// posU.xyz = position, posU.w = u
// v = v
//
// Std430 stride rounds the struct to 32B (struct align 16). The trailing
// 12B are padding — sprites have no per-vertex normals to fill them with;
// reserved for future use (e.g. face normals for ndotl shading).
export const ExtrudedVertex = struct('ExtrudedVertex', {
    posU: d.vec4f,
    v: d.f32,
});

export const INSTANCE_MATERIAL_STRIDE = layoutStrideOf(InstanceMaterial);
export const EXTRUDED_INSTANCE_STRIDE = layoutStrideOf(ExtrudedInstance);
/** byte offset of the `material` member inside `ExtrudedInstance` (after the mat4x4f). */
export const EXTRUDED_INSTANCE_MATERIAL_OFFSET = 64;
export const EXTRUDED_VERTEX_STRIDE = layoutStrideOf(ExtrudedVertex);
const EXTRUDED_VERTEX_STRIDE_F32 = EXTRUDED_VERTEX_STRIDE / 4;

const INITIAL_VERTEX_CAPACITY = 8 * 1024;
const INITIAL_INDEX_CAPACITY = 24 * 1024;

// ── range allocator (free-list with adjacent-merge) ─────────────────

type Range = { offset: number; count: number };

type RangeAllocator = {
    capacity: number;
    head: number;
    freeRanges: Range[];
};

function createRangeAllocator(capacity: number): RangeAllocator {
    return { capacity, head: 0, freeRanges: [] };
}

function resetRangeAllocator(a: RangeAllocator): void {
    a.head = 0;
    a.freeRanges.length = 0;
}

function allocRange(a: RangeAllocator, count: number): Range {
    for (let i = 0; i < a.freeRanges.length; i++) {
        const r = a.freeRanges[i]!;
        if (r.count >= count) {
            const out: Range = { offset: r.offset, count };
            if (r.count === count) a.freeRanges.splice(i, 1);
            else {
                r.offset += count;
                r.count -= count;
            }
            return out;
        }
    }
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
        } else j++;
    }
}

// ── geometry pool ───────────────────────────────────────────────────

export type GeometrySlot = {
    vertexOffset: number;
    vertexCount: number;
    indexOffset: number;
    indexCount: number;
    /** mesh AABB in source-pixel units (Z = -0.5..+0.5); per-instance
     *  scaled into the instance's `cull.aabb` at install. */
    pixelWidth: number;
    pixelHeight: number;
    /** dense bucket index used by the per-frame loop to group instances
     *  by sprite asset for multi-draw. Assigned on first acquire, reused
     *  across acquire/release as long as the pool slot is alive. */
    bucketKey: number;
    refcount: number;
};

export type GeometryPool = {
    /** interleaved ExtrudedVertex (posU + v, 32B/vertex). HW vertex usage. */
    vertices: GpuBuffer<typeof ExtrudedVertex>;
    /** rebased absolute u32 indices into the vertex pool. HW index usage. */
    indices: GpuBuffer<d.u32>;
    vertexAllocator: RangeAllocator;
    indexAllocator: RangeAllocator;
    slots: Map<string, GeometrySlot>;
    /** monotonically-increasing bucket-key counter; each pool slot gets a
     *  fresh id on first acquire. */
    nextBucketKey: number;
};

function createGeometryPool(): GeometryPool {
    // MANUAL lifecycle: this pool owns the buffers across geometry rebuilds.
    // Per-room ExtrudedSpriteVisuals bind these via setBuffer/setIndex; a
    // REF_COUNTED scheme would let the last `geometry.dispose()` destroy
    // the GPU buffer while the pool still hands the JS object out.
    const vertices = new GpuBuffer(ExtrudedVertex, {
        data: new Float32Array(INITIAL_VERTEX_CAPACITY * EXTRUDED_VERTEX_STRIDE_F32),
        usage: 'vertex',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const indices = new GpuBuffer(d.u32, {
        data: new Uint32Array(INITIAL_INDEX_CAPACITY),
        usage: 'index',
        lifecycle: BufferLifecycle.MANUAL,
    });
    return {
        vertices,
        indices,
        vertexAllocator: createRangeAllocator(INITIAL_VERTEX_CAPACITY),
        indexAllocator: createRangeAllocator(INITIAL_INDEX_CAPACITY),
        slots: new Map(),
        nextBucketKey: 0,
    };
}

function disposeGeometryPool(pool: GeometryPool): void {
    pool.vertices.dispose();
    pool.indices.dispose();
    pool.slots.clear();
}

/** Acquire (bake-if-needed) the geometry slot for `spriteId`, bumping
 *  refcount. Returns null if the bake can't run yet (atlas pixels not
 *  ready). Engine-global: shared across rooms. */
export function acquireGeometry(res: ExtrudedSpriteResources, spriteId: string): GeometrySlot | null {
    const pool = res.geometryPool;
    const existing = pool.slots.get(spriteId);
    if (existing) {
        existing.refcount++;
        return existing;
    }

    const baked = bakeExtrudedSpriteMesh(res.spriteResources, spriteId);
    if (!baked) return null;

    const vertexCount = baked.positions.length / 3;
    const indexCount = baked.indices.length;

    const vRange = allocRange(pool.vertexAllocator, vertexCount);
    if (vRange.offset + vRange.count > getVertexCapacity(pool)) growVertex(pool, pool.vertexAllocator.capacity);

    const iRange = allocRange(pool.indexAllocator, indexCount);
    if (iRange.offset + iRange.count > getIndexCapacity(pool)) growIndex(pool, pool.indexAllocator.capacity);

    // interleave into the single vertex pool: ExtrudedVertex {posU, v}
    // — posU.xyz = position, posU.w = u, then v + 12B padding.
    const vertArr = pool.vertices.array as Float32Array;
    const idxArr = pool.indices.array as Uint32Array;

    const posSrc = baked.positions;
    const uvSrc = baked.uvs;
    const vDstBase = vRange.offset * EXTRUDED_VERTEX_STRIDE_F32;
    for (let i = 0; i < vertexCount; i++) {
        const s3 = i * 3;
        const s2 = i * 2;
        const d8 = i * EXTRUDED_VERTEX_STRIDE_F32;
        vertArr[vDstBase + d8 + 0] = posSrc[s3 + 0]!;
        vertArr[vDstBase + d8 + 1] = posSrc[s3 + 1]!;
        vertArr[vDstBase + d8 + 2] = posSrc[s3 + 2]!;
        vertArr[vDstBase + d8 + 3] = uvSrc[s2 + 0]!;
        vertArr[vDstBase + d8 + 4] = uvSrc[s2 + 1]!;
        // [d8+5..d8+7] are the trailing 12B padding — left zero.
    }

    // rebase indices to absolute vertex positions in the pool — VS
    // consumes the index buffer via HW indexing with no baseVertex offset.
    const base = vRange.offset;
    for (let i = 0; i < indexCount; i++) {
        idxArr[iRange.offset + i] = baked.indices[i]! + base;
    }

    pool.vertices.addUpdateRange(vRange.offset * EXTRUDED_VERTEX_STRIDE_F32, vertexCount * EXTRUDED_VERTEX_STRIDE_F32);
    pool.indices.addUpdateRange(iRange.offset, indexCount);

    const slot: GeometrySlot = {
        vertexOffset: vRange.offset,
        vertexCount,
        indexOffset: iRange.offset,
        indexCount,
        pixelWidth: baked.pixelWidth,
        pixelHeight: baked.pixelHeight,
        bucketKey: pool.nextBucketKey++,
        refcount: 1,
    };
    pool.slots.set(spriteId, slot);
    return slot;
}

/** Drop a refcount on `spriteId`'s pool slot. The slot's ranges return to
 *  the free-lists when refcount hits zero. No-op when the slot is absent
 *  (e.g. after a clearGeometryPool on atlas swap). */
export function releaseGeometry(res: ExtrudedSpriteResources, spriteId: string): void {
    const pool = res.geometryPool;
    const slot = pool.slots.get(spriteId);
    if (!slot) return;
    slot.refcount--;
    if (slot.refcount > 0) return;
    freeRange(pool.vertexAllocator, { offset: slot.vertexOffset, count: slot.vertexCount });
    freeRange(pool.indexAllocator, { offset: slot.indexOffset, count: slot.indexCount });
    pool.slots.delete(spriteId);
}

/** Wipe the slot table + reset allocators in place. GpuBuffer identity is
 *  preserved (rooms hold setBuffer/setIndex bindings against these), so
 *  the next acquire writes fresh data into the same buffers.
 *
 *  Called from registry-dispatch on atlas swap — every cached silhouette
 *  is stale (bakes read live atlas pixels). Per-room visuals must drop
 *  their alive states (which hold stale GeometrySlot refs) for re-acquire
 *  to land in this freshly-cleared pool. */
export function clearGeometryPool(res: ExtrudedSpriteResources): void {
    const pool = res.geometryPool;
    pool.slots.clear();
    resetRangeAllocator(pool.vertexAllocator);
    resetRangeAllocator(pool.indexAllocator);
}

function getVertexCapacity(pool: GeometryPool): number {
    return (pool.vertices.array as Float32Array).length / EXTRUDED_VERTEX_STRIDE_F32;
}

function getIndexCapacity(pool: GeometryPool): number {
    return (pool.indices.array as Uint32Array).length;
}

function growVertex(pool: GeometryPool, newCapacity: number): void {
    const old = pool.vertices.array as Float32Array;
    const next = new Float32Array(newCapacity * EXTRUDED_VERTEX_STRIDE_F32);
    next.set(old);
    pool.vertices.array = next;
    pool.vertices.needsUpdate = true;
}

function growIndex(pool: GeometryPool, newCapacity: number): void {
    const old = pool.indices.array as Uint32Array;
    const next = new Uint32Array(newCapacity);
    next.set(old);
    pool.indices.array = next;
    pool.indices.needsUpdate = true;
}

// ── public type ─────────────────────────────────────────────────────

export type ExtrudedSpriteResources = {
    /** engine-global extruded-sprite material — HW instanced. Per-room
     *  buffers (slotMap, instanceData, env) bind by name through each
     *  room's geometry; the pool's vertex buffer binds as `vertex`, the
     *  index pool as the geometry index. */
    material: Material;
    /** atlas TextureNode owned by `material`. Retargeted by
     *  `rebindAtlas()` when SpriteResources swaps its atlas. */
    atlasTexNode: TextureNode;
    /** engine-global silhouette mesh pool — one bake per unique spriteId
     *  shared across rooms. */
    geometryPool: GeometryPool;
    /** ref to the engine-global SpriteResources — bakes read its atlas
     *  pixels + frame UV LUT. */
    spriteResources: SpriteResources;
};

// ── public api ──────────────────────────────────────────────────────

export function init(spriteResources: SpriteResources): ExtrudedSpriteResources {
    const { material, atlasTexNode } = createExtrudedSpriteMaterial(spriteResources.atlas);
    const geometryPool = createGeometryPool();
    return { material, atlasTexNode, geometryPool, spriteResources };
}

/** Retarget the material's atlas TextureNode at a freshly-allocated
 *  atlas. Called from registry-dispatch after SpriteResources swaps. */
export function rebindAtlas(res: ExtrudedSpriteResources, atlas: Texture): void {
    res.atlasTexNode.bindingNode.value = atlas._gpuTexture;
    res.atlasTexNode.samplerNode!.value = atlas._gpuSampler;
}

export function dispose(res: ExtrudedSpriteResources): void {
    res.material.dispose();
    disposeGeometryPool(res.geometryPool);
}

// ── internals ───────────────────────────────────────────────────────

function createExtrudedSpriteMaterial(atlas: Texture): { material: Material; atlasTexNode: TextureNode } {
    // HW vertex fetch from the interleaved pool — posU.xyz = pos,
    // posU.w = u; v = v. Stride 32B (struct rounds up; trailing 12B padding).
    const posU = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const vAttr = attribute('vertex', d.f32, { stride: 32, offset: 16 });
    const aPosition = posU.xyz.toVar('esPos');
    const aUv = vec2f(posU.w, vAttr).toVar('esUv');

    // slotMap[instanceIndex] → stable per-slot index in instanceData. HW
    // adds firstInstance to instanceIndex before the VS sees it, so each
    // draw indexes into its own [firstInstance ..] range packed contiguously
    // by extruded-sprite-visuals.
    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const realSlot = slotMap.element(instanceIndex).toVar('esSlot');

    // per-slot transform + material bundled into one binding.
    const instanceData = storage('instanceData', d.array(ExtrudedInstance), 'read');
    const instRec = instanceData.element(realSlot);
    const worldMatrix = instRec.field('worldMatrix').toVar('esWorldMatrix');
    const instMat = instRec.field('material').toVar('esInstMat');

    const uvRect = instMat.field('uvRect').toVar('esUvRect');
    const tint = instMat.field('tint').toVar('esTint');
    const lightF = instMat.field('light').toVar('esLight');
    const glowF = instMat.field('glow').toVar('esGlow');
    const unlitF = instMat.field('unlit').toVar('esUnlit');
    const litMinF = instMat.field('litMin').toVar('esLitMin');

    const worldPos = mul(worldMatrix, vec4f(aPosition, f32(1.0))).toVar('esWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos)).toVar('esClipPos');

    const sampledU = add(uvRect.x, mul(aUv.x, uvRect.z)).toVar('esSampledU');
    const sampledV = add(uvRect.y, mul(aUv.y, uvRect.w)).toVar('esSampledV');
    const sampledUv = vec2f(sampledU, sampledV).toVar('esSampledUv');

    const vUv = varying(sampledUv, 'esUv').setInterpolation('perspective', 'centroid');
    const vTint = varying(tint, 'esTintV').setInterpolation('flat');
    const vInstLight = varying(lightF, 'esInstLight').setInterpolation('flat');
    const vGlow = varying(glowF, 'esGlowV').setInterpolation('flat');
    const vUnlit = varying(unlitF, 'esUnlitV').setInterpolation('flat');
    const vLitMin = varying(litMinF, 'esLitMinV').setInterpolation('flat');

    const atlasTexNode = texture(atlas);
    const sampled = atlasTexNode.sample(vUv).toVar('esSampled');

    // lighting — no ndotl (bake doesn't emit per-vertex normals).
    const cfg = storage('env', EnvConfig, 'read').fields();
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('esSunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('esSunDir');
    const ambientMinimum = vec3f(f32(0.04), f32(0.04), f32(0.06)).toVar('esAmbientMin');

    const sunY = sunDirection.y.toVar('esSunY');
    const dayCurve = smoothstep(f32(-0.1), f32(0.15), sunY).toVar('esDayCurve');
    const skyBrightnessActive = mix(f32(0.05), f32(0.9), dayCurve).toVar('esSkyBrightActive');
    const enabledMask = cfg.enabled.toF32().toVar('esEnabledMask');
    const skyBrightness = mix(f32(1.0), skyBrightnessActive, enabledMask).toVar('esSkyBrightness');

    const skyScalar = mul(vInstLight.x, skyBrightness).toVar('esSkyScalar');
    const skyContrib = vec3f(skyScalar, skyScalar, skyScalar).toVar('esSkyContrib');
    const litMinFloor = vec3f(vLitMin, vLitMin, vLitMin).toVar('esLitMinFloor');
    const blockLight = vInstLight.yzw.toVar('esBlockLight');
    const voxelLight = max(max(blockLight, skyContrib), litMinFloor).toVar('esVoxelLight');
    const light = max(voxelLight, ambientMinimum).toVar('esLight');

    // tint the albedo first, then light it — lighting/shadows modulate the
    // tinted surface rather than a flat tint replacing the lit result.
    const tintedAlbedo = mix(sampled.rgb, vTint.rgb, vTint.w).toVar('esTintedAlbedo');
    const litShaded = mul(tintedAlbedo, light).toVar('esLitShaded');
    const litRgb = mix(litShaded, tintedAlbedo, vUnlit).toVar('esLitRgb');
    const glowedRgb = litRgb.add(vec3f(vGlow, vGlow, vGlow)).toVar('esGlowedRgb');
    const tinted = vec4f(glowedRgb, sampled.a).toVar('esTinted');

    const alphaCutout = Fn(
        (color, alpha) => {
            If(alpha.lessThan(f32(0.5)), () => {
                Discard();
            });
            return color;
        },
        {
            name: 'extrudedSpriteAlphaCutout',
            params: [
                { name: 'color', type: d.vec4f },
                { name: 'alpha', type: d.f32 },
            ],
        },
    );
    const fragment = alphaCutout(tinted, tinted.a).toVar('esFragment');

    const material = new Material({
        name: 'extruded-sprite-batched',
        vertex: clipPos,
        fragment,
        // extruded meshes are 3D — back-face cull is correct, the bake
        // skips internal seams, and alpha cutout (discard < 0.5) keeps
        // the mesh in the opaque pass — no sorting, correct depth writes.
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
        transparent: false,
    });

    return { material, atlasTexNode };
}
