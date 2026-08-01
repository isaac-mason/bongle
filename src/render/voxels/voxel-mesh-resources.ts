// VoxelMeshResources, engine-global baked-mesh material.
//
// builds one Material per `EngineClient`; shared across all rooms. each
// room's per-instance buffers (meshQuads, instanceData, slotMap,
// chunkInfoTable) are routed by name via `geometry.setBuffer(...)`.
//
// the baked path mirrors the chunk path's unified all-quads format
// (14 u32/quad, header + per-corner light interleaved; see
// voxel-material.ts and chunk-mesher.ts PassMesh), but uses HW instancing:
//   - one DrawIndirect per (model × source-chunk) bucket; instanceCount =
//     number of currently-visible VoxelMeshTraits referencing that model.
//   - the per-frame `slotMap` packs (realSlot | bucketId<<24) so the VS
//     can resolve both the per-instance data and the per-bucket chunk info
//     from a single read.
//   - `chunkInfoTable[bucketId]` carries the source-chunk's `subOrigin` and
//     `quadStart`.
//   - `instanceData[realSlot]` carries the world matrix + InstanceParams
//     (merged into one binding, same shape as model-resources).
//
// CPU frustum cull: voxel-mesh-visuals reads each instance's own
// `cull.visible` (written by the room culler). per-corner
// light lives in the trailing 4 u32 of each quad's stride-14 slot in
// `meshQuads`, written by `meshChunk`'s `emitQuadLight*` helpers.

import {
    type ArrayTexture,
    add,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    d,
    f32,
    floor,
    Geometry,
    GpuBuffer,
    index,
    instanceIndex,
    layoutStrideOf,
    type Material,
    Mesh,
    mat3,
    max,
    mul,
    type Node,
    type NonIndexedMeshDraw,
    normalize,
    storage,
    struct,
    u32,
    varying,
    vec3f,
    vec4,
    vec4f,
    vertexIndex,
} from 'gpucat';
import type { Vec3 } from 'mathcat';
import { QUAD_LIGHT_OFFSET, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import type { VoxelModel } from '../../core/voxels/voxel-model';
import { shadeTinted } from '../dsl/shade';
import type { TimeResources } from '../time';
import { arenaDispose, createSegmentArena, type SegmentArena } from './voxel-arena';
import {
    buildEnvSky,
    buildVoxelFragment,
    computeVertexAnimation,
    decodeQuadCorner,
    decodeQuadFlags,
    makePassMaterial,
    pickCornerIdx,
    unpackVoxelLight,
} from './voxel-material';

// ── gpu structs ─────────────────────────────────────────────────────

export const InstanceParams = struct('VoxelMeshInstanceParams', {
    /** rgb is the recolour target, a the intensity (lightness-preserving). */
    tint: d.vec4f,
    /** transient overlay, rgb is the colour, a the strength (lerp). */
    flash: d.vec4f,
    /** per-instance light floor [sky, r, g, b] sampled at the instance
     *  origin. combined as a floor on the per-corner `meshLight` so a
     *  moving instance never goes darker than its origin cell. */
    light: d.vec4f,
    glow: d.f32,
    /** 0 = lit, 1 = bypass all lighting (f32 so the shader mixes). */
    unlit: d.f32,
    /** floor on voxel light (0..1) for readability. */
    litMin: d.f32,
    /** screen-door fade 0..1. 0 = solid, 1 = fully invisible. */
    dither: d.f32,
});

// Per-slot stable instance record. Merges world matrix + InstanceParams
// into one binding, same shape as model-resources.ModelInstance. Layout:
// mat4x4f (64B, align 16) then InstanceParams (64B, align 16, no pad)
// → 128B per slot, struct align 16.
export const ModelInstance = struct('VoxelMeshModelInstance', {
    worldMatrix: d.mat4x4f,
    params: InstanceParams,
});

/** one entry per (model × source-chunk) bucket emitted this frame.
 *  the VS reads it via `chunkInfoTable[bucketId]`. */
export const ChunkInfo = struct('VoxelMeshChunkInfo', {
    /** model-local origin of this source-chunk's data; added to the per-
     *  corner u8×3 chunk-local position before applying the world matrix. */
    subOrigin: d.vec3f,
    /** first quad in meshQuadArena for this bucket. */
    quadStart: d.u32,
});

export const INSTANCE_PARAMS_STRIDE = layoutStrideOf(InstanceParams);
export const MODEL_INSTANCE_STRIDE = layoutStrideOf(ModelInstance);
/** byte offset of the `params` member inside `ModelInstance` (after the mat4x4f). */
export const MODEL_INSTANCE_PARAMS_OFFSET = 64;
export const CHUNK_INFO_STRIDE = layoutStrideOf(ChunkInfo);

/** slotMap packs (realSlot | bucketId << SLOT_BITS). 24 bits of slot
 *  (≈16M instances) and 8 bits of bucket (256 unique model×chunk per
 *  frame). bump SLOT_BITS to 20 if bucket counts ever push past 256. */
export const SLOT_BITS = 24;
export const SLOT_MASK = (1 << SLOT_BITS) - 1;
export const MAX_BUCKETS = 1 << (32 - SLOT_BITS);

/** f32 count per `ModelInstance` slot (128B / 4 = 32). */
export const MODEL_INSTANCE_STRIDE_F32 = MODEL_INSTANCE_STRIDE / 4;

// ── instance batch (client-global, persistent GPU allocation) ───────
// The shared meshArena (refcounted baked-model quads) + per-slot instance buffer
// + slotMap + chunkInfoTable + their Mesh/Geometry + the model registry live
// here, NOT on per-room visuals. One room renders at a time, so a room swap
// REUSES this GPU allocation (reset counts + re-add the Mesh) instead of freeing
// + reallocating it. Per-room `VoxelMeshVisuals` keep only this-room's use —
// alive-states, cull entries, scene-tree query. Because the arena is now
// client-global, a baked model's GPU quads are keyed by VoxelModel and refcounted
// across the active room's instances (drained on room teardown, re-baked on the
// next room's first tick into the same buffers).

const INITIAL_INSTANCE_CAPACITY = 64;
const INITIAL_MAX_BUCKETS = 256;
const INITIAL_MESH_QUAD_CAPACITY = 16384;

type GpuBufferType = GpuBuffer<any>;

/** single-slot free-list allocator over the instance buffer; reset per room. */
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

export type SourceChunkAlloc = {
    /** range in shared meshArena (baseSlot, count = quadCount). */
    quadStart: number;
    quadCount: number;
    /** model-local origin of this source chunk (chunk.wx/y/z - model.origin). */
    subOrigin: Vec3;
};

export type ModelEntry = {
    /** stable id for bucket-keying; sequential across models. */
    id: number;
    /** packed source-chunk allocations in the shared meshArena. shared
     *  across all instances referencing this model. */
    chunkAllocs: SourceChunkAlloc[];
    refCount: number;
};

export type VoxelMeshMeshArena = SegmentArena<{
    meshQuads: { schema: d.u32; perSlot: number };
}>;

export type VoxelMeshBatch = {
    /** one Mesh(geometry, material); added to the active room's scene on `init`,
     *  removed on `dispose`. Never disposed on a room swap. */
    mesh: Mesh;
    geometry: Geometry;
    /** shared interleaved quad arena, packs every registered model's quads with
     *  per-corner light at u32[10..13] of each 14-u32 stride. Client-global. */
    meshArena: VoxelMeshMeshArena;
    /** stable per-slot {worldMatrix, params}, 128B/slot; read-only storage. */
    instanceDataBuf: GpuBufferType;
    /** per-frame packed entries (realSlot | bucketId<<SLOT_BITS). */
    slotMapBuf: GpuBufferType;
    /** per-frame per-bucket {subOrigin, quadStart}. */
    chunkInfoBuf: GpuBufferType;
    chunkInfoData: Float32Array;
    /** per-frame batched draw list, shared by identity with `mesh.draws`. */
    draws: NonIndexedMeshDraw[];
    /** scratch buckets reused across frames. key = `entry.id * 65536 + chunkIdx`. */
    _bucketScratch: Map<number, number[]>;
    _freeBuckets: number[][];
    instanceCapacity: number;
    maxBuckets: number;
    instanceAllocator: Allocator;
    /** ref-counted geometry registry (model → baked arena allocations). */
    modelEntries: Map<VoxelModel, ModelEntry>;
    /** monotonic id for ModelEntry.id, used in bucket keys. */
    nextModelId: number;
};

/** Build the client-global instance batch: the shared mesh arena + per-slot
 *  instance/slotMap/chunkInfo storage bound into one Geometry, wrapped in a Mesh
 *  with the engine-global material. Not added to any scene until a room `init`s. */
function createVoxelMeshBatch(material: Material): VoxelMeshBatch {
    const instanceCapacity = INITIAL_INSTANCE_CAPACITY;
    const maxBuckets = INITIAL_MAX_BUCKETS;

    const meshArena = createSegmentArena({
        slotCount: INITIAL_MESH_QUAD_CAPACITY,
        streams: {
            meshQuads: { schema: d.u32, perSlot: QUAD_STRIDE_U32S },
        },
    });

    const instanceDataBuf = new GpuBuffer(d.array(ModelInstance), {
        data: new Float32Array(instanceCapacity * MODEL_INSTANCE_STRIDE_F32),
        usage: 'storage',
    });
    const slotMapBuf = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(instanceCapacity),
        usage: 'storage',
    });
    const chunkInfoData = new Float32Array((maxBuckets * CHUNK_INFO_STRIDE) / 4);
    const chunkInfoBuf = new GpuBuffer(d.array(ChunkInfo), {
        data: chunkInfoData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });

    const draws: NonIndexedMeshDraw[] = [];

    const geometry = new Geometry();
    geometry.setBuffer('meshQuads', meshArena.buffers.meshQuads);
    geometry.setBuffer('instanceData', instanceDataBuf);
    geometry.setBuffer('slotMap', slotMapBuf);
    geometry.setBuffer('chunkInfoTable', chunkInfoBuf);

    const mesh = new Mesh(geometry, material);
    mesh.name = 'voxel-mesh-visuals';
    mesh.frustumCulled = false;
    mesh.draws = draws;

    return {
        mesh,
        geometry,
        meshArena,
        instanceDataBuf,
        slotMapBuf,
        chunkInfoBuf,
        chunkInfoData,
        draws,
        _bucketScratch: new Map(),
        _freeBuckets: [],
        instanceCapacity,
        maxBuckets,
        instanceAllocator: createAllocator(instanceCapacity),
        modelEntries: new Map(),
        nextModelId: 0,
    };
}

/** Ready the batch for a fresh room: empty the allocator + scratch + draws +
 *  model registry. Buffers are NOT touched. The arena is empty here — room
 *  teardown drains every model's refcount (freeing its ranges), so a fresh room
 *  re-bakes into the same buffers. */
export function resetVoxelMeshBatch(batch: VoxelMeshBatch): void {
    batch.instanceAllocator.head = 0;
    batch.instanceAllocator.freeList.length = 0;
    batch._bucketScratch.clear();
    batch._freeBuckets.length = 0;
    batch.draws.length = 0;
    batch.modelEntries.clear();
    batch.nextModelId = 0;
}

// gpucat tracks buffer swaps by GpuBuffer identity; routing a fresh wrapper via
// `geometry.setBuffer(name, newBuf)` rebuilds the material's bind groups.
export function growVoxelMeshBatch(batch: VoxelMeshBatch, newCapacity: number): void {
    const geometry = batch.geometry;

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
        const newBuf = new GpuBuffer(d.array(d.u32), {
            data: new Uint32Array(newCapacity),
            usage: 'storage',
        });
        geometry.setBuffer('slotMap', newBuf);
        batch.slotMapBuf.dispose();
        batch.slotMapBuf = newBuf;
    }

    batch.instanceCapacity = newCapacity;
}

export function growVoxelMeshBuckets(batch: VoxelMeshBatch, needed: number): void {
    let cap = batch.maxBuckets;
    while (cap < needed) cap *= 2;
    if (cap > MAX_BUCKETS) {
        throw new Error(`voxel-mesh: bucket count ${needed} exceeds SLOT_BITS-derived cap ${MAX_BUCKETS}`);
    }

    {
        const newArr = new Float32Array((cap * CHUNK_INFO_STRIDE) / 4);
        const newBuf = new GpuBuffer(d.array(ChunkInfo), {
            data: newArr,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });
        batch.geometry.setBuffer('chunkInfoTable', newBuf);
        batch.chunkInfoBuf.dispose();
        batch.chunkInfoBuf = newBuf;
        batch.chunkInfoData = newArr;
    }

    // `mesh.draws` grows itself (plain array); only chunkInfoTable needs a
    // fresh sized GPU buffer here.
    batch.maxBuckets = cap;
}

function disposeVoxelMeshBatch(batch: VoxelMeshBatch): void {
    // Called once at client shutdown, never on room swap.
    batch.geometry.dispose();
    arenaDispose(batch.meshArena);
    batch.instanceDataBuf.dispose();
    batch.slotMapBuf.dispose();
    batch.chunkInfoBuf.dispose();
}

// ── resources ───────────────────────────────────────────────────────

export type VoxelMeshResources = {
    /** engine-global baked-mesh material, binds per-room buffers by name. */
    material: Material;
    /** client-global instance batch (Mesh/Geometry + mesh arena + per-slot
     *  buffers + model registry). Reused across room swaps; per-room
     *  `VoxelMeshVisuals` drive it. */
    batch: VoxelMeshBatch;
};

import type { EnvironmentResources } from '../environment/environment';

export function init(
    atlas: ArrayTexture,
    texAnimBuffer: GpuBuffer<any>,
    time: TimeResources,
    env: EnvironmentResources,
): VoxelMeshResources {
    const material = createBakedMeshMaterial(atlas, texAnimBuffer, time.elapsedTime, env);
    const batch = createVoxelMeshBatch(material);
    return { material, batch };
}

export function dispose(resources: VoxelMeshResources): void {
    disposeVoxelMeshBatch(resources.batch);
    resources.material.dispose();
}

// ── material ────────────────────────────────────────────────────────

function createBakedMeshMaterial(
    atlas: ArrayTexture,
    texAnimBuffer: GpuBuffer<any>,
    elapsedTime: Node<d.f32>,
    env: EnvironmentResources,
): Material {
    // per-name storage bindings
    const meshQuads = storage('meshQuads', d.array(d.u32), 'read');
    const instanceDataStorage = storage('instanceData', d.array(ModelInstance), 'read');
    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const chunkInfoTable = storage('chunkInfoTable', d.array(ChunkInfo), 'read');

    // resolve (realSlot, bucketId) from the packed slotMap entry. instanceIndex
    // spans the whole slotMap; each indirect draw's firstInstance + offset
    // lands at the corresponding bucket's run.
    const slotEntry = index(slotMap, instanceIndex).toVar('slotEntry');
    const realSlot = slotEntry.bitwiseAnd(u32(SLOT_MASK)).toVar('realSlot');
    const bucketId = slotEntry.shiftRight(u32(SLOT_BITS)).toVar('bucketId');

    const chunkInfo = index(chunkInfoTable, bucketId).toVar('chunkInfo');
    const subOrigin = chunkInfo.field('subOrigin').toVar('meshSubOrigin');
    const quadStart = chunkInfo.field('quadStart').toVar('meshQuadStart');

    const instData = index(instanceDataStorage, realSlot).toVar('instData');
    const worldMatrix = instData.field('worldMatrix').toVar('worldMatrix');
    const instParams = instData.field('params').toVar('instParams');

    // quad-pull addressing
    const drawnQuadId = vertexIndex.div(u32(6)).toVar('drawnQuadId');
    const vertInQuad = vertexIndex.mod(u32(6)).toVar('vertInQuad');
    const realQuadId = add(quadStart, drawnQuadId).toVar('realQuadId');

    const headerBase = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('quadHeaderBase');
    const flags = index(meshQuads, add(headerBase, u32(8))).toVar('qdFlags');

    const { texIndex, animType } = decodeQuadFlags(flags);

    // diagFlip is written by meshChunk's per-quad emitQuadLight* helpers
    // (Sodium hierarchical compare) into corner-0's light word at bit 29.
    // Pull it before picking the corner since it controls the triangulation
    // diagonal.
    const lightBase = add(headerBase, u32(QUAD_LIGHT_OFFSET)).toVar('lightBase');
    const corner0Light = index(meshQuads, lightBase).toVar('corner0Light');
    const diagFlip = corner0Light.shiftRight(u32(29)).bitwiseAnd(u32(1)).toVar('diagFlip');

    const cornerIdx = pickCornerIdx(diagFlip, vertInQuad);
    const { chunkLocalByte, uv, modelNormal } = decodeQuadCorner(meshQuads, realQuadId, cornerIdx);
    // inverse of mesher pos16's 255/16 scale (byte 0 → 0, byte 255 → 16).
    // matches chunk shader so sub-chunk boundaries within a baked mesh
    // meet seamlessly, the old 1/16 scale left a ~0.0625-voxel gap at
    // every byte=255 corner.
    const chunkLocal = chunkLocalByte.mul(f32(16.0 / 255.0)).toVar('chunkLocal');

    // chunk-local → model-local → world (before animation)
    const modelLocal = add(subOrigin, chunkLocal).toVar('modelLocal');
    const worldPosBase = mul(worldMatrix, vec4f(modelLocal, f32(1.0))).toVar('worldPosBase');

    // baked meshes have arbitrary instance transforms; derive the block
    // center from world position so sway phases agree with neighbouring
    // chunk voxels regardless of model rotation/scale.
    const blockCenter = vec3f(
        add(floor(worldPosBase.x), f32(0.5)),
        add(floor(worldPosBase.y), f32(0.5)),
        add(floor(worldPosBase.z), f32(0.5)),
    ).toVar('blockCenter');

    const animResult = computeVertexAnimation(worldPosBase.xyz, blockCenter, animType, elapsedTime);
    const xDisp = animResult.x;
    const zDisp = animResult.y;
    const depthBias = animResult.z;

    const worldPos = vec4f(add(worldPosBase.x, xDisp), worldPosBase.y, add(worldPosBase.z, zDisp), worldPosBase.w).toVar(
        'worldPos',
    );
    const viewPos = mul(cameraViewMatrix, worldPos).toVar('viewPos');
    const rawClipPos = mul(cameraProjectionMatrix, viewPos).toVar('rawClipPos');
    const clipPos = vec4f(rawClipPos.x, rawClipPos.y, add(rawClipPos.z, depthBias), rawClipPos.w).toVar('clipPos');

    // transform normal by upper-3x3 of world matrix
    const col0 = worldMatrix.element(u32(0)).xyz.toVar('col0');
    const col1 = worldMatrix.element(u32(1)).xyz.toVar('col1');
    const col2 = worldMatrix.element(u32(2)).xyz.toVar('col2');
    const normalMat = mat3(col0, col1, col2).toVar('normalMat');
    const worldNormal = normalize(mul(normalMat, modelNormal)).toVar('worldNormal');

    // env-derived sky/sun
    const { sunDirection, sunIntensity, skyBrightness, ambientMinimum } = buildEnvSky(env);

    // per-corner light pulled from the trailing 4 u32 of the quad's
    // stride-14 slot in `meshQuads`. mirrors chunk path: same packed-byte
    // layout, same unpack curve. meshChunk's emitQuadLight* helpers write
    // these directly (Sodium-blended per-corner brightness with diagFlip
    // in corner-0's bit 29).
    const cornerLightOffset = add(lightBase, cornerIdx).toVar('cornerLightOffset');
    const cornerLight = index(meshQuads, cornerLightOffset).toVar('cornerLight');
    const rawLight = unpackVoxelLight(cornerLight, skyBrightness).toVar('rawLight');

    // per-instance light floor: [sky, r, g, b] sampled at the origin (or
    // inherited from a ModelTrait ancestor). expand sky→skyBrightness and
    // combine with block RGB the same way `unpackVoxelLight` does so the
    // two paths live on the same scale. max(perCorner, perInstance).
    const instLight = instParams.field('light').toVar('instLight');
    const instSkyContrib = vec3f(
        mul(instLight.x, skyBrightness),
        mul(instLight.x, skyBrightness),
        mul(instLight.x, skyBrightness),
    ).toVar('instSkyContrib');
    const instFloor = max(instLight.yzw, instSkyContrib).toVar('instFloor');

    const instLitMin = instParams.field('litMin').toVar('instLitMin');
    const litMinFloor = vec3f(instLitMin, instLitMin, instLitMin).toVar('litMinFloor');
    const voxelLight = max(max(rawLight, instFloor), litMinFloor).toVar('voxelLight');

    // varyings
    const vTexIndex = varying(texIndex, 'vmTexIndex').setInterpolation('flat');
    const vUv = varying(uv, 'vmUv');
    const vLight = varying(voxelLight, 'vmLight');
    const vNormal = varying(worldNormal, 'vmNormal');
    const vTint = varying(instParams.field('tint'), 'vmTint');
    const vFlash = varying(instParams.field('flash'), 'vmFlash');
    const vGlow = varying(instParams.field('glow'), 'vmGlow');
    const vUnlit = varying(instParams.field('unlit'), 'vmUnlit').setInterpolation('flat');
    const vDither = varying(instParams.field('dither'), 'vmDither').setInterpolation('flat');

    const { texColor, light } = buildVoxelFragment(
        atlas,
        texAnimBuffer,
        vTexIndex,
        vUv,
        vLight,
        vNormal,
        sunDirection,
        sunIntensity,
        ambientMinimum,
        elapsedTime,
    );

    const tintedRgb = shadeTinted(texColor.rgb, vTint, vFlash, light, vGlow, vUnlit);
    const bakedColor = vec4(tintedRgb, texColor.a).toVar('bakedColor');

    // cutout + screen-door pass: the dither knob feeds the shared discard
    // via makePassMaterial.
    return makePassMaterial({
        name: 'voxel-mesh-baked',
        pass: 'transparent',
        clipPos,
        fragColor: bakedColor,
        texColor,
        dither: vDither,
    });
}
