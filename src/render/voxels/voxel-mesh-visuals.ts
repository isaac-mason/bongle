// voxel mesh visuals, per-room HW-instanced rendering for VoxelMeshTrait
// instances. mirrors model-visuals.ts: one non-indexed instanced draw
// (`mesh.draws`) per (model × source-chunk) bucket, with instanceCount =
// number of currently-visible traits referencing that model.
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
//     realSlot | bucketId<<24), write chunkInfoTable, emit one MeshDraw
//     per bucket into `mesh.draws` (the renderer loops it). Both the storage
//     buffers are read-only, so gpucat lowers their reads to buffer-texture
//     fetches on WebGL2 automatically — one material source, both backends.
//   - CPU cull only. Visibility writes `cull.visible` once per frame.
//
// the VS does:
//   slotEntry  = slotMap[instanceIndex]
//   realSlot   = slotEntry & SLOT_MASK
//   bucketId   = slotEntry >> SLOT_BITS
//   chunk      = chunkInfoTable[bucketId]   // subOrigin, quadStart
//   instance   = instanceData[realSlot]     // worldMatrix, params
//
// no GPU cull compute, Visibility does the frustum work via DBVT.

import type { Scene } from 'gpucat';
import { packTo } from 'gpucat';
import { type Box3, box3, vec3 } from 'mathcat';
import { getVisualWorldMatrix } from '../../api/transforms';
import { ModelTrait } from '../../builtins/model';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import type { Node, SceneTree } from '../../core/scene/scene-tree';
import { getTrait, query } from '../../core/scene/scene-tree';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../core/voxels/chunk-mesher';
import { sampleVoxelLight } from '../../core/voxels/light';
import type { VoxelModel } from '../../core/voxels/voxel-model';
import type { Voxels } from '../../core/voxels/voxels';
import * as Visibility from '../core/visibility/visibility';
import { arenaAlloc, arenaFree, arenaWrite } from './voxel-arena';
import {
    allocateSlot,
    CHUNK_INFO_STRIDE,
    freeSlot,
    growVoxelMeshBatch,
    growVoxelMeshBuckets,
    InstanceParams,
    MODEL_INSTANCE_PARAMS_OFFSET,
    MODEL_INSTANCE_STRIDE,
    MODEL_INSTANCE_STRIDE_F32,
    type ModelEntry,
    resetVoxelMeshBatch,
    SLOT_BITS,
    type SourceChunkAlloc,
    type VoxelMeshBatch,
} from './voxel-mesh-resources';

type VoxelMeshQuery = ReturnType<typeof query<[typeof VoxelMeshTrait, typeof TransformTrait]>>;

// ── per-trait state ─────────────────────────────────────────────────

export type VoxelMeshState = {
    /** stable instanceData slot, indexes into the merged transform+params buffer. */
    slot: number;
    trait: VoxelMeshTrait;
    /** pointer-stable VoxelModel currently bound. compared by `===`. */
    modelRef: VoxelModel | null;
    /** resolved model entry (refcounted geometry). */
    modelEntry: ModelEntry | null;
    /** this instance's own frustum-cull entry, registered with the shared
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
    /** this room's live VoxelMesh instances (+ their cull entries); per-frame
     *  loop reads the trait's `_state` directly. Each state's `slot` indexes the
     *  client-global batch. */
    aliveStates: VoxelMeshState[];
    /** bound to THIS room's sceneTree. */
    _query: VoxelMeshQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room voxel-mesh visuals: ready the client-global instance batch
 * (reset its allocator + scratch + draws + model registry; buffers + arena
 * untouched) and mount its Mesh into this room's scene. The batch — Mesh,
 * Geometry, mesh arena, per-slot buffers, model registry — is owned by
 * `VoxelMeshResources` and survives room swaps; only this room's use of it
 * (alive-states, cull entries, scene-tree query) lives here.
 */
export function init(batch: VoxelMeshBatch, scene: Scene, sceneTree: SceneTree): VoxelMeshVisuals {
    resetVoxelMeshBatch(batch);
    scene.add(batch.mesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [VoxelMeshTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

export function update(
    visuals: VoxelMeshVisuals,
    batch: VoxelMeshBatch,
    voxels: Voxels,
    visibility: Visibility.Visibility,
): void {
    const q = visuals._query;
    const frameId = ++visuals.frameId;

    let instArr = batch.instanceDataBuf.array as Float32Array;
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
            if (state !== null) destroyInstance(visuals, batch, vmTrait, visibility);
            continue;
        }

        // existing state with a different model, destroy + recreate so
        // refcounts on the old/new model settle and bucket key updates.
        if (state !== null) destroyInstance(visuals, batch, vmTrait, visibility);

        const entry = registerGeometry(batch, model);
        if (entry.chunkAllocs.length === 0) {
            // empty model (no non-empty chunks); skip without holding a slot.
            deregisterGeometry(batch, model);
            continue;
        }

        const slot = allocateSlot(batch.instanceAllocator);
        if (slot >= batch.instanceCapacity) {
            growVoxelMeshBatch(batch, batch.instanceAllocator.capacity);
            instArr = batch.instanceDataBuf.array as Float32Array;
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
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, batch, state.trait, visibility);
    }

    // ── phase 3: per-instance writes + bucket sort ──────────────────
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
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

        // ── transform upload, gated on TransformTrait._version ──
        const worldMatrix = getVisualWorldMatrix(transformTrait);
        const transformVersion = transformTrait._version;
        if (transformVersion !== state.transformVersionAtUpload) {
            for (let j = 0; j < 16; j++) instArr[slotBase + j] = worldMatrix[j]!;
            state.transformVersionAtUpload = transformVersion;
            instanceDataDirty = true;
        }

        // ── lighting + params, written every visible frame ──
        // per-corner light (`meshLight`, sampled in the VS) is the primary
        // source. instParams.light is a per-instance floor sampled at the
        // origin, useful while baked-mesh light is placeholder and for
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
    if (activeBucketCount > batch.maxBuckets) {
        growVoxelMeshBuckets(batch, activeBucketCount);
    }

    const slotMapArr = batch.slotMapBuf.array as Uint32Array;
    const chunkInfoArr = batch.chunkInfoData;
    const draws = batch.draws;

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
        const entry = modelEntryById(batch, entryId);
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
        batch.chunkInfoBuf.addUpdateRange(ciBase, CHUNK_INFO_STRIDE / 4);

        // one non-indexed instanced draw: vertexCount = quadCount * 6 (6 verts
        // per quad, vertex-pulled from meshQuads), instanceCount = len,
        // firstVertex = 0 (chunkInfoTable carries quadStart, the VS adds it).
        // Reuse the existing entry object if present.
        let draw = draws[bucketId];
        if (draw === undefined) {
            draw = { vertexCount: 0, instanceCount: 0, firstVertex: 0, firstInstance: 0 };
            draws[bucketId] = draw;
        }
        draw.vertexCount = chunk.quadCount * 6;
        draw.instanceCount = len;
        draw.firstVertex = 0;
        draw.firstInstance = firstInstance;

        firstInstance += len;
        bucketId++;
    }

    // trim the reused draw array to this frame's active bucket count.
    draws.length = bucketId;

    if (bucketId > 0) batch.slotMapBuf.needsUpdate = true;
    if (instanceDataDirty) batch.instanceDataBuf.needsUpdate = true;
}

// ── dispose ─────────────────────────────────────────────────────────

/**
 * Dispose per-room voxel-mesh visuals: tear down every instance this room holds
 * in the client-global batch (frees the allocator slot, unregisters cull, drops
 * the model refcount — which frees the model's arena ranges when it hits zero) and
 * detach the batch Mesh from this room's scene. The batch's GPU buffers + arena
 * are NOT freed — they survive for the next room's `init`.
 */
export function dispose(visuals: VoxelMeshVisuals, batch: VoxelMeshBatch, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
}

// ── invalidate ──────────────────────────────────────────────────────

/** drop a VoxelModel's baked geometry so the next reference re-bakes.
 *  required after mutating the model's voxels, bakes are immutable
 *  otherwise. live instances referencing this model are torn down and
 *  rebuilt on the next update tick. */
export function invalidateVoxelModel(
    visuals: VoxelMeshVisuals,
    batch: VoxelMeshBatch,
    model: VoxelModel,
    visibility: Visibility.Visibility,
): void {
    const entry = batch.modelEntries.get(model);
    if (!entry) return;

    // tear down any live instances pointing at this model so the next
    // update() pass re-runs the slow path with a fresh bake.
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.modelRef === model) destroyInstance(visuals, batch, state.trait, visibility);
    }

    // free the entry's arena ranges + drop the cached bake.
    for (const ca of entry.chunkAllocs) arenaFree(batch.meshArena, ca.quadStart);
    batch.modelEntries.delete(model);
}

// ── instance lifecycle ──────────────────────────────────────────────

function destroyInstance(
    visuals: VoxelMeshVisuals,
    batch: VoxelMeshBatch,
    trait: VoxelMeshTrait,
    visibility: Visibility.Visibility,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    const slot = state.slot;
    // zero per-slot params so a reused slot doesn't briefly inherit
    // stale tint/light before the first write lands.
    packTo(InstanceParams, batch.instanceDataBuf.array!, slot * MODEL_INSTANCE_STRIDE + MODEL_INSTANCE_PARAMS_OFFSET, {
        tint: [0, 0, 0, 0],
        flash: [0, 0, 0, 0],
        light: [0, 0, 0, 0],
        glow: 0,
        unlit: 0,
        litMin: 0,
        dither: 0,
    });
    batch.instanceDataBuf.needsUpdate = true;

    freeSlot(batch.instanceAllocator, slot);

    if (state.modelRef !== null) deregisterGeometry(batch, state.modelRef);

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

function registerGeometry(batch: VoxelMeshBatch, model: VoxelModel): ModelEntry {
    let entry = batch.modelEntries.get(model);
    if (entry) {
        entry.refCount++;
        return entry;
    }
    entry = {
        id: batch.nextModelId++,
        chunkAllocs: bakeModel(batch, model),
        refCount: 1,
    };
    batch.modelEntries.set(model, entry);
    return entry;
}

function deregisterGeometry(batch: VoxelMeshBatch, model: VoxelModel): void {
    const entry = batch.modelEntries.get(model);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const ca of entry.chunkAllocs) arenaFree(batch.meshArena, ca.quadStart);
    batch.modelEntries.delete(model);
}

function modelEntryById(batch: VoxelMeshBatch, id: number): ModelEntry | null {
    // linear scan, modelEntries is typically tiny (one per unique
    // VoxelModel in use this room). beats holding a parallel id→entry map.
    for (const entry of batch.modelEntries.values()) {
        if (entry.id === id) return entry;
    }
    return null;
}

// ── bake ────────────────────────────────────────────────────────────

/** mesh every non-empty source chunk of `model.voxels` and pack the
 *  opaque + transparent + translucent quads into the shared meshArena.
 *  translucent quads are baked into the same opaque stream, no per-quad
 *  depth sort across instances. acceptable for object-scale models; the
 *  chunk path still handles in-world translucents with proper ordering. */
function bakeModel(batch: VoxelMeshBatch, model: VoxelModel): SourceChunkAlloc[] {
    const voxels = model.voxels;
    const registry = voxels.registry;
    const ox = model.origin[0];
    const oy = model.origin[1];
    const oz = model.origin[2];

    const out: SourceChunkAlloc[] = [];
    const meshOutput = createMeshOutput();

    for (const chunk of voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        const result = meshChunk(meshOutput, buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
        if (!result) continue;

        const ranges = [result.opaque, result.transparent, result.translucent].filter(
            (p): p is NonNullable<typeof p> => p !== null && p.quadCount > 0,
        );
        const total = ranges.reduce((n, p) => n + p.quadCount, 0);
        if (total === 0) continue;

        const baseSlot = arenaAlloc(batch.meshArena, total);
        let cursor = baseSlot;
        for (const p of ranges) {
            arenaWrite(batch.meshArena, 'meshQuads', cursor, p.quadCount, p.quads);
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
