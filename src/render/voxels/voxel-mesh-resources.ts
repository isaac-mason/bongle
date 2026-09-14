import {
    add,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
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
import type { Vec3 } from 'math';
import { FLAGS_OFFSET, META_OFFSET, QUAD_META_DIAG_FLIP_BIT, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import type { VoxelModel } from '../../core/voxels/voxel-model';
import { createOutlineShellMaterial } from '../dsl/outline';
import { shadeTinted } from '../dsl/shade';
import type { TimeResources } from '../time';
import { arenaDispose, createSegmentArena, type SegmentArena } from './voxel-arena';
import {
    buildEnvSky,
    buildVoxelFragment,
    computeVertexAnimation,
    decodeQuadCentroid,
    decodeQuadCorner,
    decodeQuadFlags,
    makePassMaterial,
    POS_DECODE_ORIGIN,
    POS_DECODE_SCALE,
    pickCornerIdx,
    sampleVoxelAlbedo,
} from './voxel-material';

export const InstanceParams = struct('VoxelMeshInstanceParams', {
    /** rgb is the recolour target, a the intensity (lightness-preserving). */
    tint: d.vec4f,
    /** transient overlay, rgb is the colour, a the strength (lerp). */
    flash: d.vec4f,
    glow: d.f32,
    /** 0 = lit, 1 = bypass all lighting (f32 so the shader mixes). */
    unlit: d.f32,
    /** floor on voxel light (0..1) for readability. */
    litMin: d.f32,
    /** screen-door fade 0..1. 0 = solid, 1 = fully invisible. */
    dither: d.f32,
    outlineColor: d.vec4f,
    /** 0 = no outline. Units depend on outlineSpace. */
    outlineWidth: d.f32,
    /** 1 = screen pixels (constant width), 0 = world units (shrinks with distance). */
    outlineSpace: d.f32,
});

// Per-slot stable instance record: mat4x4f (64B) then InstanceParams (80B),
// 144B per slot, struct align 16. Same shape as mesh-resources.ModelInstance.
export const ModelInstance = struct('VoxelMeshModelInstance', {
    worldMatrix: d.mat4x4f,
    params: InstanceParams,
});

/** one entry per (model x source-chunk) bucket emitted this frame.
 *  the VS reads it via `chunkInfoTable[bucketId]`. */
export const ChunkInfo = struct('VoxelMeshChunkInfo', {
    /** model-local origin of this source-chunk's data; added to the per-
     *  corner u8x3 chunk-local position before applying the world matrix. */
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
 *  (~16M instances) and 8 bits of bucket (256 unique model x chunk per
 *  frame). bump SLOT_BITS to 20 if bucket counts ever push past 256. */
export const SLOT_BITS = 24;
export const SLOT_MASK = (1 << SLOT_BITS) - 1;
export const MAX_BUCKETS = 1 << (32 - SLOT_BITS);

/** f32 count per `ModelInstance` slot (144B / 4 = 36). */
export const MODEL_INSTANCE_STRIDE_F32 = MODEL_INSTANCE_STRIDE / 4;

// the shared meshArena, per-slot instance buffer, slotMap, chunkInfoTable, and model
// registry are client-global, not per-room: one room renders at a time, so a room swap
// reuses this GPU allocation (reset counts, re-add the Mesh) instead of reallocating it.
// Per-room VoxelMeshVisuals keep only this room's alive-states, cull entries, and query.
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
    /** the outline shell, sharing this batch's geometry, buffers and draw list. */
    outlineMesh: Mesh;
    geometry: Geometry;
    /** shared interleaved quad arena, packs every registered model's quads with
     *  per-corner light at u32[10..13] of each 14-u32 stride. Client-global. */
    meshArena: VoxelMeshMeshArena;
    /** stable per-slot {worldMatrix, params}, 144B/slot; read-only storage. */
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
    /** ref-counted geometry registry (model to baked arena allocations). */
    modelEntries: Map<VoxelModel, ModelEntry>;
    /** monotonic id for ModelEntry.id, used in bucket keys. */
    nextModelId: number;
};

/** Build the client-global instance batch: the shared mesh arena + per-slot
 *  instance/slotMap/chunkInfo storage bound into one Geometry, wrapped in a Mesh
 *  with the engine-global material. Not added to any scene until a room `init`s. */
function createVoxelMeshBatch(material: Material, outlineMaterial: Material): VoxelMeshBatch {
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

    // same instances drawn a second time with the shell material; renderOrder puts it after the mesh.
    const outlineMesh = new Mesh(geometry, outlineMaterial);
    outlineMesh.name = 'voxel-mesh-visuals-outline';
    outlineMesh.frustumCulled = false;
    outlineMesh.draws = draws;
    outlineMesh.renderOrder = 1;

    return {
        mesh,
        outlineMesh,
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

/** Readies the batch for a fresh room: empties the allocator, scratch, draws, and model
 *  registry. Buffers are not touched; room teardown drains every model's refcount, so a
 *  fresh room re-bakes into the same buffers. */
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

export type VoxelMeshResources = {
    /** engine-global baked-mesh material, binds per-room buffers by name. */
    material: Material;
    /** engine-global outline shell material, drawn by `batch.outlineMesh`. */
    outlineMaterial: Material;
    /** client-global instance batch, reused across room swaps; per-room VoxelMeshVisuals drive it. */
    batch: VoxelMeshBatch;
};

import type { EnvironmentResources } from '../environment/environment';
import { applyFog, fogDistance } from '../environment/fog';
import { bindLightVolume, sampleWorldLight } from './voxel-light-sample';
import type { VoxelTextures } from './voxel-textures';

export function init(textures: VoxelTextures, time: TimeResources, env: EnvironmentResources): VoxelMeshResources {
    const material = createBakedMeshMaterial(textures, time.elapsedTime, env);
    const outlineMaterial = createVoxelMeshOutlineMaterial(textures, time.elapsedTime);
    const batch = createVoxelMeshBatch(material, outlineMaterial);
    return { material, outlineMaterial, batch };
}

export function dispose(resources: VoxelMeshResources): void {
    disposeVoxelMeshBatch(resources.batch);
    resources.material.dispose();
    resources.outlineMaterial.dispose();
}

// vertex pull shared by the base pass and the outline shell: slotMap entry to quad corner to animated world position.
function pullVoxelMeshVertex(elapsedTime: Node<d.f32>) {
    const meshQuads = storage('meshQuads', d.array(d.u32), 'read');
    const instanceDataStorage = storage('instanceData', d.array(ModelInstance), 'read');
    const slotMap = storage('slotMap', d.array(d.u32), 'read');
    const chunkInfoTable = storage('chunkInfoTable', d.array(ChunkInfo), 'read');

    // (realSlot, bucketId) from the packed slotMap entry; each draw's firstInstance lands at its bucket's run.
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
    const flags = index(meshQuads, add(headerBase, u32(FLAGS_OFFSET))).toVar('qdFlags');

    const { texIndex, animType } = decodeQuadFlags(flags);

    // diagFlip (meta bit 16) controls the triangulation diagonal, so it picks the corner.
    const meta = index(meshQuads, add(headerBase, u32(META_OFFSET))).toVar('vmMeta');
    const diagFlip = meta.shiftRight(u32(QUAD_META_DIAG_FLIP_BIT)).bitwiseAnd(u32(1)).toVar('diagFlip');

    const cornerIdx = pickCornerIdx(diagFlip, vertInQuad);
    const { chunkLocalByte, uv, modelNormal } = decodeQuadCorner(meshQuads, realQuadId, cornerIdx);
    // inverse of the mesher's pos16 scale, matching the chunk shader so sub-chunk boundaries meet seamlessly.
    const chunkLocal = chunkLocalByte.mul(f32(POS_DECODE_SCALE)).sub(f32(POS_DECODE_ORIGIN)).toVar('chunkLocal');
    // corner offset from the quad's centroid, in voxels: zero along the normal, at least half a voxel in-plane.
    const cornerOffset = chunkLocal.sub(decodeQuadCentroid(meshQuads, realQuadId)).toVar('cornerOffset');

    const modelLocal = add(subOrigin, chunkLocal).toVar('modelLocal');
    const worldPosBase = mul(worldMatrix, vec4f(modelLocal, f32(1.0))).toVar('worldPosBase');

    // block centre from world position so sway phases agree with neighbouring chunk voxels under any transform.
    const blockCenter = vec3f(
        add(floor(worldPosBase.x), f32(0.5)),
        add(floor(worldPosBase.y), f32(0.5)),
        add(floor(worldPosBase.z), f32(0.5)),
    ).toVar('blockCenter');

    const animResult = computeVertexAnimation(worldPosBase.xyz, blockCenter, animType, elapsedTime);
    const xDisp = animResult.x;
    const zDisp = animResult.y;
    const depthBias = animResult.z;

    const worldPos = vec3f(add(worldPosBase.x, xDisp), worldPosBase.y, add(worldPosBase.z, zDisp)).toVar('worldPos');

    return { worldPos, depthBias, worldMatrix, instParams, modelNormal, cornerOffset, uv, texIndex };
}

function createBakedMeshMaterial(textures: VoxelTextures, elapsedTime: Node<d.f32>, env: EnvironmentResources): Material {
    const { worldPos, depthBias, worldMatrix, instParams, modelNormal, uv, texIndex } = pullVoxelMeshVertex(elapsedTime);

    const viewPos = mul(cameraViewMatrix, vec4f(worldPos, f32(1.0))).toVar('viewPos');
    const rawClipPos = mul(cameraProjectionMatrix, viewPos).toVar('rawClipPos');
    const clipPos = vec4f(rawClipPos.x, rawClipPos.y, add(rawClipPos.z, depthBias), rawClipPos.w).toVar('clipPos');

    // transform normal by upper-3x3 of world matrix
    const col0 = worldMatrix.element(u32(0)).xyz.toVar('col0');
    const col1 = worldMatrix.element(u32(1)).xyz.toVar('col1');
    const col2 = worldMatrix.element(u32(2)).xyz.toVar('col2');
    const normalMat = mat3(col0, col1, col2).toVar('normalMat');
    const worldNormal = normalize(mul(normalMat, modelNormal)).toVar('worldNormal');

    const { sunDirection, sunIntensity, skyBrightness, ambientMinimum } = buildEnvSky(env);

    // light volume sampled at the vertex's own world position, so a model straddling a shadow shades across it.
    const vertexLight = sampleWorldLight(bindLightVolume(env), worldPos).toVar('vertexLight');
    const vertexSkyContrib = vec3f(
        mul(vertexLight.x, skyBrightness),
        mul(vertexLight.x, skyBrightness),
        mul(vertexLight.x, skyBrightness),
    ).toVar('vertexSkyContrib');
    const vertexFloor = max(vertexLight.yzw, vertexSkyContrib).toVar('vertexFloor');

    const instLitMin = instParams.field('litMin').toVar('instLitMin');
    const litMinFloor = vec3f(instLitMin, instLitMin, instLitMin).toVar('litMinFloor');
    // a block model moves, so light baked at mesh time would go stale; the volume sample is the light, not a floor.
    const voxelLight = max(vertexFloor, litMinFloor).toVar('voxelLight');

    const vUv = varying(uv, 'vmUv');
    const vLight = varying(voxelLight, 'vmLight');
    const vNormal = varying(worldNormal, 'vmNormal');
    const vTint = varying(instParams.field('tint'), 'vmTint');
    const vFlash = varying(instParams.field('flash'), 'vmFlash');
    const vGlow = varying(instParams.field('glow'), 'vmGlow');
    const vUnlit = varying(instParams.field('unlit'), 'vmUnlit').setInterpolation('flat');
    const vDither = varying(instParams.field('dither'), 'vmDither').setInterpolation('flat');

    const { texColor, light } = buildVoxelFragment(
        textures,
        texIndex,
        vUv,
        vLight,
        vNormal,
        sunDirection,
        sunIntensity,
        ambientMinimum,
        elapsedTime,
    );

    const tintedRgb = shadeTinted(texColor.rgb, vTint, vFlash, light, vGlow, vUnlit);
    const foggedRgb = applyFog(env, tintedRgb, fogDistance(worldPos, 'vmFogDist'));
    const bakedColor = vec4(foggedRgb, texColor.a).toVar('bakedColor');

    // cutout + screen-door pass: the dither knob feeds the shared discard via makePassMaterial.
    return makePassMaterial({
        name: 'voxel-mesh-baked',
        pass: 'transparent',
        clipPos,
        fragColor: bakedColor,
        texColor,
        dither: vDither,
    });
}

// the outline shell: each quad pushed out along its normal and grown in-plane, so perpendicular faces meet square at every edge.
function createVoxelMeshOutlineMaterial(textures: VoxelTextures, elapsedTime: Node<d.f32>): Material {
    const { worldPos, worldMatrix, instParams, modelNormal, cornerOffset, uv, texIndex } = pullVoxelMeshVertex(elapsedTime);

    const col0 = worldMatrix.element(u32(0)).xyz;
    const col1 = worldMatrix.element(u32(1)).xyz;
    const col2 = worldMatrix.element(u32(2)).xyz;
    // normalised basis columns drop non-uniform scale.
    const rot = mat3(normalize(col0), normalize(col1), normalize(col2)).toVar('voRot');
    // normal plus the in-plane corner signs: one width along each axis, the solid offset by a cube.
    const minusOne = vec3f(f32(-1), f32(-1), f32(-1));
    const plusOne = vec3f(f32(1), f32(1), f32(1));
    const cornerSign = clamp(cornerOffset.mul(f32(1000)), minusOne, plusOne).toVar('voCornerSign');
    const worldGrow = mul(rot, add(modelNormal, cornerSign)).toVar('voWorldGrow');

    // honour the block's own cutout so a plant or a fence outlines its texture, not its quad.
    const vUv = varying(uv, 'voUv');
    const texAlpha = sampleVoxelAlbedo(textures, texIndex, vUv, elapsedTime).a.toVar('voTexAlpha');

    return createOutlineShellMaterial({
        name: 'voxel-mesh-outline',
        worldPos,
        worldGrow,
        width: instParams.field('outlineWidth'),
        space: instParams.field('outlineSpace'),
        color: instParams.field('outlineColor'),
        dither: instParams.field('dither'),
        alpha: texAlpha,
    });
}
