// voxel mesh visuals — per-room HW-instanced rendering for VoxelMeshTrait
// instances. mirrors model-visuals.ts: one DrawIndirect per (model ×
// source-chunk) bucket, with instanceCount = number of currently-visible
// traits referencing that model.
//
// architecture:
//   - shared meshArena packs each VoxelModel's quads once (refcounted by
//     model). bakeModel is the single writer; mutations to a baked model
//     are dropped until `invalidateVoxelModel(visuals, model)` is called.
//   - per-trait `VoxelMeshState` on `VoxelMeshTrait._state` holds the
//     stable instanceData slot, the resolved modelEntry, this instance's
//     own frustum-cull entry (`cull`, seeded from the model's local AABB
//     and registered with the room culler), and the optional ModelTrait
//     ancestor used as the shared-light home.
//   - per frame: walk alive states, skip when `cull.visible` is false,
//     write instanceData (transform + params), bucket by (modelEntry,
//     sourceChunkIdx). then walk buckets, write slotMap entries (packed
//     realSlot | bucketId<<24), write chunkInfoTable, emit one
//     DrawIndirect per bucket. geometry.indirectDrawCount caps the loop.
//   - CPU cull only. Visibility writes `cull.visible` once per frame.
//
// the VS does:
//   slotEntry  = slotMap[instanceIndex]
//   realSlot   = slotEntry & SLOT_MASK
//   bucketId   = slotEntry >> SLOT_BITS
//   chunk      = chunkInfoTable[bucketId]   // subOrigin, quadStart
//   instance   = instanceData[realSlot]     // worldMatrix, params
//
// no GPU cull compute — Visibility does the frustum work via DBVT.

import type { Scene } from 'gpucat';
import {
    BufferLifecycle,
    createIndirectBuffer,
    d,
    DrawIndirect,
    GpuBuffer,
    layoutStrideOf,
    Mesh,
    Geometry,
    packTo,
} from 'gpucat';
import { type Box3, box3, type Vec3, vec3 } from 'mathcat';

import { ModelTrait } from '../../builtins/model';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import { getVisualWorldMatrix } from '../../api/transforms';
import { buildMeshInput, createMeshOutput, meshChunk, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { sampleVoxelLight } from '../../core/voxels/light';
import type { Node, Nodes } from '../../core/scene/nodes';
import { getTrait, query } from '../../core/scene/nodes';
import * as Visibility from '../visibility';
import type * as Environment from '../environment';
import type { VoxelModel } from '../../core/voxels/voxel-model';
import type { Voxels } from '../../core/voxels/voxels';
import {
    CHUNK_INFO_STRIDE,
    ChunkInfo,
    InstanceParams,
    MAX_BUCKETS,
    MODEL_INSTANCE_PARAMS_OFFSET,
    MODEL_INSTANCE_STRIDE,
    ModelInstance,
    SLOT_BITS,
    type VoxelMeshResources,
} from './voxel-mesh-resources';
import { arenaAlloc, arenaDispose, arenaFree, arenaWrite, createSegmentArena, type SegmentArena } from './voxel-resources';

type VoxelMeshQuery = ReturnType<typeof query<[typeof VoxelMeshTrait, typeof TransformTrait]>>;
type GpuBufferType = GpuBuffer<any>;

const INITIAL_INSTANCE_CAPACITY = 64;
const INITIAL_MAX_BUCKETS = 256;
const INITIAL_MESH_QUAD_CAPACITY = 16384;

const MODEL_INSTANCE_STRIDE_F32 = MODEL_INSTANCE_STRIDE / 4;
const DRAW_INDIRECT_STRIDE = layoutStrideOf(DrawIndirect);
const DRAW_INDIRECT_STRIDE_U32 = DRAW_INDIRECT_STRIDE / 4; // 4

// ── slot allocator (single-slot, free-list) ─────────────────────────

type Allocator = { capacity: number; head: number; freeList: number[] };

function createAllocator(capacity: number): Allocator {
    return { capacity, head: 0, freeList: [] };
}

function allocateOne(a: Allocator): number {
    if (a.freeList.length > 0) return a.freeList.pop()!;
    if (a.head >= a.capacity) a.capacity *= 2;
    return a.head++;
}

function freeOne(a: Allocator, slot: number): void {
    a.freeList.push(slot);
}

// ── geometry registry ───────────────────────────────────────────────

type SourceChunkAlloc = {
    /** range in shared meshArena (baseSlot, count = quadCount). */
    quadStart: number;
    quadCount: number;
    /** model-local origin of this source chunk (chunk.wx/y/z - model.origin). */
    subOrigin: Vec3;
};

type ModelEntry = {
    /** stable id for bucket-keying; sequential across models. */
    id: number;
    /** packed source-chunk allocations in the shared meshArena. shared
     *  across all instances referencing this model. */
    chunkAllocs: SourceChunkAlloc[];
    refCount: number;
};

// ── per-trait state ─────────────────────────────────────────────────

export type VoxelMeshState = {
    /** stable instanceData slot — indexes into the merged transform+params buffer. */
    slot: number;
    trait: VoxelMeshTrait;
    /** pointer-stable VoxelModel currently bound. compared by `===`. */
    modelRef: VoxelModel | null;
    /** resolved model entry (refcounted geometry). */
    modelEntry: ModelEntry | null;
    /** this instance's own frustum-cull entry — registered with the shared
     *  Visibility culler at alloc, seeded from the VoxelModel's local AABB.
     *  The culler writes `cull.visible`. */
    cull: Visibility.CullState;
    /** optional ModelTrait ancestor used as a shared-light home. mirrors
     *  model-visuals: present ⇒ read model.light, absent ⇒ sample voxel
     *  light at the instance origin. fed into the shader as a floor on the
     *  per-corner `meshLight` buffer. */
    model: ModelTrait | null;
    /** frame counter for stale-state sweep. */
    lastSeenFrame: number;
    /** TransformTrait._version observed at the most recent transform upload. */
    transformVersionAtUpload: number;
};

// ── visuals ────────────────────────────────────────────────────────

export type VoxelMeshVisuals = {
    mesh: Mesh;
    geometry: Geometry;

    /** shared interleaved quad arena — packs every registered model's
     *  quads with per-corner light at u32[10..13] of each 14-u32 stride. */
    meshArena: SegmentArena<{
        meshQuads: { schema: d.u32; perSlot: number };
    }>;

    /** stable per-slot {worldMatrix, params}; merged into one buffer like
     *  model-resources.ModelInstance. */
    instanceDataBuf: GpuBufferType;

    /** per-frame: packed entries (realSlot | bucketId<<SLOT_BITS). CPU
     *  writes one contiguous run per bucket. */
    slotMapBuf: GpuBufferType;

    /** per-frame: per-bucket {subOrigin, quadStart}. CPU writes
     *  bucketCount entries. */
    chunkInfoBuf: GpuBufferType;
    chunkInfoData: Float32Array;

    /** per-frame DrawIndirect[]; bucketCount entries active per frame
     *  (geometry.indirectDrawCount caps the renderer loop). */
    drawIndirectBuf: GpuBufferType;
    drawIndirectData: Uint32Array;

    /** scratch buckets reused across frames. key = `entry.id * 65536 +
     *  chunkIdx`. arrays are emptied (length=0) each frame; freed arrays
     *  get pooled via `_freeBuckets`. */
    _bucketScratch: Map<number, number[]>;
    _freeBuckets: number[][];

    instanceCapacity: number;
    maxBuckets: number;

    instanceAllocator: Allocator;
    aliveStates: VoxelMeshState[];

    /** ref-counted geometry registry. */
    modelEntries: Map<VoxelModel, ModelEntry>;
    /** monotonic id for ModelEntry.id — used in bucket keys. */
    nextModelId: number;

    _query: VoxelMeshQuery;
    frameId: number;
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

export function init(
    scene: Scene,
    nodes: Nodes,
    voxelMeshResources: VoxelMeshResources,
    env: Environment.EnvironmentResources,
): VoxelMeshVisuals {
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

    const drawIndirectData = new Uint32Array(maxBuckets * DRAW_INDIRECT_STRIDE_U32);
    const drawIndirectBuf = createIndirectBuffer(d.array(DrawIndirect), drawIndirectData);

    const geometry = new Geometry();
    geometry.setBuffer('meshQuads', meshArena.buffers.meshQuads);
    geometry.setBuffer('instanceData', instanceDataBuf);
    geometry.setBuffer('slotMap', slotMapBuf);
    geometry.setBuffer('chunkInfoTable', chunkInfoBuf);
    geometry.setBuffer('env', env.envConfigBuffer);
    geometry.indirect = drawIndirectBuf;
    geometry.indirectDrawCount = 0;

    const mesh = new Mesh(geometry, voxelMeshResources.material);
    mesh.name = 'voxel-mesh-visuals';
    mesh.frustumCulled = false;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        meshArena,
        instanceDataBuf,
        slotMapBuf,
        chunkInfoBuf,
        chunkInfoData,
        drawIndirectBuf,
        drawIndirectData,
        _bucketScratch: new Map(),
        _freeBuckets: [],
        instanceCapacity,
        maxBuckets,
        instanceAllocator: createAllocator(instanceCapacity),
        aliveStates: [],
        modelEntries: new Map(),
        nextModelId: 0,
        _query: query(nodes, [VoxelMeshTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

export function update(visuals: VoxelMeshVisuals, voxels: Voxels, visibility: Visibility.Visibility): void {
    const q = visuals._query;
    const frameId = ++visuals.frameId;

    let instArr = visuals.instanceDataBuf.array as Float32Array;
    let instanceDataDirty = false;

    // ── phase 1: allocate / refresh states ──────────────────────────
    for (const [vmTrait, transformTrait] of q) {
        let state = vmTrait._state;
        const model = vmTrait.model;

        // fast path: same model ref, state already exists.
        if (state !== null && state.modelRef === model && model !== null) {
            state.lastSeenFrame = frameId;
            continue;
        }

        // ── slow path ─────────────────────────────────────────────
        if (model === null) {
            if (state !== null) destroyInstance(visuals, vmTrait, visibility);
            continue;
        }

        // existing state with a different model — destroy + recreate so
        // refcounts on the old/new model settle and bucket key updates.
        if (state !== null) destroyInstance(visuals, vmTrait, visibility);

        const entry = registerGeometry(visuals, model);
        if (entry.chunkAllocs.length === 0) {
            // empty model (no non-empty chunks); skip without holding a slot.
            deregisterGeometry(visuals, model);
            continue;
        }

        const slot = allocateOne(visuals.instanceAllocator);
        if (slot >= visuals.instanceCapacity) {
            growInstanceBuffers(visuals, visuals.instanceAllocator.capacity);
            instArr = visuals.instanceDataBuf.array as Float32Array;
        }

        const node = vmTrait._node;
        const modelAncestor = findModelAncestor(node);

        // register with a cull box from the VoxelModel's local AABB
        // (boundsMin/Max − origin, the space the mesh is baked in).
        const cull = Visibility.add(visibility, voxelLocalAabb(box3.create(), model), transformTrait);

        state = {
            slot,
            trait: vmTrait,
            modelRef: model,
            modelEntry: entry,
            cull,
            model: modelAncestor,
            lastSeenFrame: frameId,
            transformVersionAtUpload: -1,
        };
        vmTrait._state = state;
        visuals.aliveStates.push(state);
    }

    // ── phase 2: cleanup stale states ───────────────────────────────
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, state.trait, visibility);
    }

    // ── phase 3: per-instance writes + bucket sort ──────────────────
    const buckets = visuals._bucketScratch;
    const freeBuckets = visuals._freeBuckets;
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < aliveStates.length; i++) {
        const state = aliveStates[i]!;
        const entry = state.modelEntry;
        if (entry === null) continue;

        const visible = state.cull.visible && state.trait.visible;
        if (!visible) continue;

        const trait = state.trait;
        const transformTrait = getTrait(trait._node, TransformTrait);
        if (!transformTrait) continue;

        const slot = state.slot;
        const slotBase = slot * MODEL_INSTANCE_STRIDE_F32;

        // ── transform upload — gated on TransformTrait._version ──
        const worldMatrix = getVisualWorldMatrix(transformTrait);
        const transformVersion = transformTrait._version;
        if (transformVersion !== state.transformVersionAtUpload) {
            for (let j = 0; j < 16; j++) instArr[slotBase + j] = worldMatrix[j]!;
            state.transformVersionAtUpload = transformVersion;
            instanceDataDirty = true;
        }

        // ── lighting + params — written every visible frame ──
        // per-corner light (`meshLight`, sampled in the VS) is the primary
        // source. instParams.light is a per-instance floor sampled at the
        // origin — useful while baked-mesh light is placeholder and for
        // instances drifting between cells. shared-light home: ModelTrait
        // ancestor's light if present, else sample the room's voxel light.
        const light = trait.light;
        if (state.model !== null) {
            const src = state.model.light;
            light[0] = src[0]!;
            light[1] = src[1]!;
            light[2] = src[2]!;
            light[3] = src[3]!;
        } else {
            sampleVoxelLight(voxels, worldMatrix[12]!, worldMatrix[13]!, worldMatrix[14]!, light);
        }

        packTo(InstanceParams, instArr, slot * MODEL_INSTANCE_STRIDE + MODEL_INSTANCE_PARAMS_OFFSET, {
            tint: trait.tint,
            flash: trait.flash,
            light,
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
        });
        instanceDataDirty = true;

        // ── bucket by (model entry, source-chunk idx) ─────────────
        const chunkAllocs = entry.chunkAllocs;
        const entryId = entry.id;
        for (let c = 0; c < chunkAllocs.length; c++) {
            const key = entryId * 65536 + c;
            let bucket = buckets.get(key);
            if (bucket === undefined) {
                bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
                buckets.set(key, bucket);
            }
            bucket.push(slot);
        }
    }

    // ── phase 4: pack slotMap + chunkInfoTable + drawIndirect ───────
    let activeBucketCount = 0;
    for (const arr of buckets.values()) {
        if (arr.length > 0) activeBucketCount++;
    }
    if (activeBucketCount > visuals.maxBuckets) {
        growBucketBuffers(visuals, activeBucketCount);
    }

    const slotMapArr = visuals.slotMapBuf.array as Uint32Array;
    const chunkInfoArr = visuals.chunkInfoData;
    const indirectArr = visuals.drawIndirectData;

    let firstInstance = 0;
    let bucketId = 0;
    for (const [key, slots] of buckets) {
        const len = slots.length;
        if (len === 0) {
            // recycle empty bucket; drop from map so it doesn't linger.
            buckets.delete(key);
            freeBuckets.push(slots);
            continue;
        }

        // resolve the chunk alloc this bucket key refers to.
        const entryId = Math.floor(key / 65536);
        const chunkIdx = key - entryId * 65536;
        const entry = modelEntryById(visuals, entryId);
        const chunk = entry?.chunkAllocs[chunkIdx];
        if (!chunk) continue; // model was deregistered mid-frame.

        // write slotMap entries (packed realSlot | bucketId<<SLOT_BITS).
        const packedHi = bucketId << SLOT_BITS;
        for (let i = 0; i < len; i++) slotMapArr[firstInstance + i] = slots[i]! | packedHi;

        // write chunkInfoTable[bucketId] = { subOrigin, quadStart }.
        // ChunkInfo layout: vec3f subOrigin (12B) + u32 quadStart (4B) = 16B.
        const ciBase = bucketId * (CHUNK_INFO_STRIDE / 4);
        chunkInfoArr[ciBase + 0] = chunk.subOrigin[0]!;
        chunkInfoArr[ciBase + 1] = chunk.subOrigin[1]!;
        chunkInfoArr[ciBase + 2] = chunk.subOrigin[2]!;
        const chunkInfoU32 = new Uint32Array(chunkInfoArr.buffer, chunkInfoArr.byteOffset, chunkInfoArr.length);
        chunkInfoU32[ciBase + 3] = chunk.quadStart;
        visuals.chunkInfoBuf.addUpdateRange(ciBase, CHUNK_INFO_STRIDE / 4);

        // emit DrawIndirect: vertexCount = quadCount * 6, instanceCount = len.
        const off = bucketId * DRAW_INDIRECT_STRIDE_U32;
        indirectArr[off + 0] = chunk.quadCount * 6;
        indirectArr[off + 1] = len;
        indirectArr[off + 2] = 0; // firstVertex — chunkInfoTable carries quadStart, VS adds it
        indirectArr[off + 3] = firstInstance;

        firstInstance += len;
        bucketId++;
    }

    visuals.geometry.indirectDrawCount = bucketId;

    if (bucketId > 0) {
        visuals.slotMapBuf.needsUpdate = true;
        visuals.drawIndirectBuf.needsUpdate = true;
    }
    if (instanceDataDirty) visuals.instanceDataBuf.needsUpdate = true;
}

// ── dispose ─────────────────────────────────────────────────────────

export function dispose(visuals: VoxelMeshVisuals, scene: Scene, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, arr[i]!.trait, visibility);
    scene.remove(visuals.mesh);
    visuals.geometry.dispose();
    arenaDispose(visuals.meshArena);
    visuals.instanceDataBuf.dispose();
    visuals.slotMapBuf.dispose();
    visuals.chunkInfoBuf.dispose();
    visuals.drawIndirectBuf.dispose();
}

// ── invalidate ──────────────────────────────────────────────────────

/** drop a VoxelModel's baked geometry so the next reference re-bakes.
 *  required after mutating the model's voxels — bakes are immutable
 *  otherwise. live instances referencing this model are torn down and
 *  rebuilt on the next update tick. */
export function invalidateVoxelModel(visuals: VoxelMeshVisuals, model: VoxelModel, visibility: Visibility.Visibility): void {
    const entry = visuals.modelEntries.get(model);
    if (!entry) return;

    // tear down any live instances pointing at this model so the next
    // update() pass re-runs the slow path with a fresh bake.
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.modelRef === model) destroyInstance(visuals, state.trait, visibility);
    }

    // free the entry's arena ranges + drop the cached bake.
    for (const ca of entry.chunkAllocs) arenaFree(visuals.meshArena, ca.quadStart);
    visuals.modelEntries.delete(model);
}

// ── instance lifecycle ──────────────────────────────────────────────

function destroyInstance(visuals: VoxelMeshVisuals, trait: VoxelMeshTrait, visibility: Visibility.Visibility): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    const slot = state.slot;
    // zero per-slot params so a reused slot doesn't briefly inherit
    // stale tint/light before the first write lands.
    packTo(InstanceParams, visuals.instanceDataBuf.array!, slot * MODEL_INSTANCE_STRIDE + MODEL_INSTANCE_PARAMS_OFFSET, {
        tint: [0, 0, 0, 0],
        flash: [0, 0, 0, 0],
        light: [0, 0, 0, 0],
        glow: 0,
        unlit: 0,
        litMin: 0,
        dither: 0,
    });
    visuals.instanceDataBuf.needsUpdate = true;

    freeOne(visuals.instanceAllocator, slot);

    if (state.modelRef !== null) deregisterGeometry(visuals, state.modelRef);

    const arr = visuals.aliveStates;
    const last = arr.length - 1;
    for (let i = last; i >= 0; i--) {
        if (arr[i] === state) {
            if (i !== last) arr[i] = arr[last]!;
            arr.pop();
            break;
        }
    }

    trait._state = null;
}

// ── geometry registration (refcounted) ──────────────────────────────

function registerGeometry(visuals: VoxelMeshVisuals, model: VoxelModel): ModelEntry {
    let entry = visuals.modelEntries.get(model);
    if (entry) {
        entry.refCount++;
        return entry;
    }
    entry = {
        id: visuals.nextModelId++,
        chunkAllocs: bakeModel(visuals, model),
        refCount: 1,
    };
    visuals.modelEntries.set(model, entry);
    return entry;
}

function deregisterGeometry(visuals: VoxelMeshVisuals, model: VoxelModel): void {
    const entry = visuals.modelEntries.get(model);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const ca of entry.chunkAllocs) arenaFree(visuals.meshArena, ca.quadStart);
    visuals.modelEntries.delete(model);
}

function modelEntryById(visuals: VoxelMeshVisuals, id: number): ModelEntry | null {
    // linear scan — modelEntries is typically tiny (one per unique
    // VoxelModel in use this room). beats holding a parallel id→entry map.
    for (const entry of visuals.modelEntries.values()) {
        if (entry.id === id) return entry;
    }
    return null;
}

// ── bake ────────────────────────────────────────────────────────────

/** mesh every non-empty source chunk of `model.voxels` and pack the
 *  opaque + transparent + translucent quads into the shared meshArena.
 *  translucent quads are baked into the same opaque stream — no per-quad
 *  depth sort across instances. acceptable for object-scale models; the
 *  chunk path still handles in-world translucents with proper ordering. */
function bakeModel(visuals: VoxelMeshVisuals, model: VoxelModel): SourceChunkAlloc[] {
    const voxels = model.voxels;
    const registry = voxels.registry;
    const ox = model.origin[0];
    const oy = model.origin[1];
    const oz = model.origin[2];

    const out: SourceChunkAlloc[] = [];
    const meshOutput = createMeshOutput();

    for (const chunk of voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        const result = meshChunk(meshOutput, buildMeshInput(voxels, chunk), registry);
        if (!result) continue;

        const ranges = [result.opaque, result.transparent, result.translucent].filter(
            (p): p is NonNullable<typeof p> => p !== null && p.quadCount > 0,
        );
        const total = ranges.reduce((n, p) => n + p.quadCount, 0);
        if (total === 0) continue;

        const baseSlot = arenaAlloc(visuals.meshArena, total);
        let cursor = baseSlot;
        for (const p of ranges) {
            arenaWrite(visuals.meshArena, 'meshQuads', cursor, p.quadCount, p.quads);
            cursor += p.quadCount;
        }

        out.push({
            quadStart: baseSlot,
            quadCount: total,
            subOrigin: vec3.fromValues(chunk.wx - ox, chunk.wy - oy, chunk.wz - oz),
        });
    }

    return out;
}

// ── cull box helper ─────────────────────────────────────────────────

/** write the VoxelModel's local AABB (boundsMin/Max − origin, the space the
 *  mesh is baked in) into `out` and return it. */
function voxelLocalAabb(out: Box3, model: VoxelModel): Box3 {
    const ox = model.origin[0];
    const oy = model.origin[1];
    const oz = model.origin[2];
    return box3.set(
        out,
        model.boundsMin[0] - ox,
        model.boundsMin[1] - oy,
        model.boundsMin[2] - oz,
        model.boundsMax[0] - ox,
        model.boundsMax[1] - oy,
        model.boundsMax[2] - oz,
    );
}

function findModelAncestor(node: Node): ModelTrait | null {
    let cur: Node | null = node;
    while (cur) {
        const m = getTrait(cur, ModelTrait);
        if (m) return m;
        cur = cur.parent;
    }
    return null;
}

// ── buffer growth ───────────────────────────────────────────────────

function growInstanceBuffers(visuals: VoxelMeshVisuals, newCapacity: number): void {
    const geometry = visuals.geometry;

    {
        const oldArr = visuals.instanceDataBuf.array as Float32Array;
        const newArr = new Float32Array(newCapacity * MODEL_INSTANCE_STRIDE_F32);
        newArr.set(oldArr.subarray(0, Math.min(oldArr.length, newArr.length)));
        const newBuf = new GpuBuffer(d.array(ModelInstance), { data: newArr, usage: 'storage' });
        geometry.setBuffer('instanceData', newBuf);
        visuals.instanceDataBuf.dispose();
        visuals.instanceDataBuf = newBuf;
    }

    // slotMap — rebuilt every frame, no need to preserve.
    {
        const newBuf = new GpuBuffer(d.array(d.u32), {
            data: new Uint32Array(newCapacity),
            usage: 'storage',
        });
        geometry.setBuffer('slotMap', newBuf);
        visuals.slotMapBuf.dispose();
        visuals.slotMapBuf = newBuf;
    }

    visuals.instanceCapacity = newCapacity;
}

function growBucketBuffers(visuals: VoxelMeshVisuals, needed: number): void {
    let cap = visuals.maxBuckets;
    while (cap < needed) cap *= 2;
    if (cap > MAX_BUCKETS) {
        throw new Error(`voxel-mesh-visuals: bucket count ${needed} exceeds SLOT_BITS-derived cap ${MAX_BUCKETS}`);
    }

    {
        const newArr = new Float32Array((cap * CHUNK_INFO_STRIDE) / 4);
        const newBuf = new GpuBuffer(d.array(ChunkInfo), {
            data: newArr,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });
        visuals.geometry.setBuffer('chunkInfoTable', newBuf);
        visuals.chunkInfoBuf.dispose();
        visuals.chunkInfoBuf = newBuf;
        visuals.chunkInfoData = newArr;
    }

    {
        const newArr = new Uint32Array(cap * DRAW_INDIRECT_STRIDE_U32);
        const newBuf = createIndirectBuffer(d.array(DrawIndirect), newArr);
        visuals.geometry.setIndirect(newBuf);
        visuals.drawIndirectBuf.dispose();
        visuals.drawIndirectBuf = newBuf;
        visuals.drawIndirectData = newArr;
    }

    visuals.maxBuckets = cap;
}
