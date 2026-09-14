import type { Scene } from 'gpucat';
import { packTo } from 'gpucat';
import { vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../../api/transforms';
import { ModelTrait } from '../../builtins/model';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import { Optional, type Src, Up } from '../../core/scene/conditions';
import type { SceneTree } from '../../core/scene/scene-tree';
import { getTrait, query } from '../../core/scene/scene-tree';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../core/voxels/chunk-mesher';
import type { VoxelModel } from '../../core/voxels/voxel-model';
import * as Visibility from '../visibility/visibility';
import { arenaAlloc, arenaFree, arenaWrite } from './voxel-arena';
import {
    allocateSlot,
    CHUNK_INFO_STRIDE,
    freeSlot,
    growVoxelMeshBatch,
    growVoxelMeshBuckets,
    INSTANCE_PARAMS_STRIDE,
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

type VoxelMeshQuery = ReturnType<
    typeof query<[typeof VoxelMeshTrait, typeof TransformTrait, ReturnType<typeof Optional<typeof ModelTrait, Src.Up>>]>
>;

export type VoxelMeshState = {
    /** stable instanceData slot, indexes into the merged transform+params buffer. */
    slot: number;
    trait: VoxelMeshTrait;
    /** pointer-stable VoxelModel currently bound. compared by `===`. */
    modelRef: VoxelModel | null;
    /** resolved model entry (refcounted geometry). */
    modelEntry: ModelEntry | null;
    /** frustum-cull entry registered with the shared Visibility culler at alloc, seeded
     *  from the VoxelModel's local AABB. The culler writes cull.visible. */
    cull: Visibility.CullState;
    /** optional ModelTrait ancestor, for inherited visibility. */
    model: ModelTrait | null;
    /** frame counter for stale-state sweep. */
    lastSeenFrame: number;
    /** TransformTrait._version observed at the most recent transform upload. */
    transformVersionAtUpload: number;
};

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

/** Creates per-room voxel-mesh visuals: readies the client-global instance batch and mounts
 *  its Mesh into this room's scene. The batch is owned by VoxelMeshResources and survives
 *  room swaps; only this room's alive-states, cull entries, and scene-tree query live here. */
export function init(batch: VoxelMeshBatch, scene: Scene, sceneTree: SceneTree): VoxelMeshVisuals {
    resetVoxelMeshBatch(batch);
    scene.add(batch.mesh);
    scene.add(batch.outlineMesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [VoxelMeshTrait, TransformTrait, Optional(Up(ModelTrait))]),
        frameId: 0,
        scene,
    };
}

export function update(visuals: VoxelMeshVisuals, batch: VoxelMeshBatch, visibility: Visibility.Visibility): void {
    const q = visuals._query;
    const frameId = ++visuals.frameId;

    let instArr = batch.instanceDataBuf.array as Float32Array;
    // touched-slot span, widened per write and uploaded as ONE range in the draw pack below.
    // slots come from a free-list allocator so they can scatter; a span then re-sends a few
    // untouched slots in the middle, still far short of the whole capacity allocation.
    let dirtyMinSlot = Number.MAX_SAFE_INTEGER;
    let dirtyMaxSlot = -1;

    for (const [vmTrait, transformTrait, modelAncestor] of q) {
        let state = vmTrait._state;
        const model = vmTrait.model;

        // fast path: same model ref, state already exists.
        if (state !== null && state.modelRef === model && model !== null) {
            state.lastSeenFrame = frameId;
            // the query keeps the resolved lighting group live; phase 3 walks
            // aliveStates rather than matches, so copy it across.
            state.model = modelAncestor;
            continue;
        }

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

        // register with a cull box from the VoxelModel's local AABB
        // (boundsMin/Max minus origin, the space the mesh is baked in).
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

    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, batch, state.trait, visibility);
    }

    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < aliveStates.length; i++) {
        const state = aliveStates[i]!;
        const entry = state.modelEntry;
        if (entry === null) continue;

        // `state.model` is Optional: a mesh under no ModelTrait has no inherited visibility.
        const visible = state.cull.visible && state.trait.visible && (state.model === null || state.model.visible);
        if (!visible) continue;

        const trait = state.trait;
        const transformTrait = getTrait(trait._node, TransformTrait);
        if (!transformTrait) continue;

        const slot = state.slot;
        const slotBase = slot * MODEL_INSTANCE_STRIDE_F32;

        const worldMatrix = getVisualWorldMatrix(transformTrait);
        const transformVersion = transformTrait._version;
        if (transformVersion !== state.transformVersionAtUpload) {
            for (let j = 0; j < 16; j++) instArr[slotBase + j] = worldMatrix[j]!;
            state.transformVersionAtUpload = transformVersion;
            if (slot < dirtyMinSlot) dirtyMinSlot = slot;
            if (slot > dirtyMaxSlot) dirtyMaxSlot = slot;
        }

        const outline = trait.outline;
        packTo(InstanceParams, instArr, slot * MODEL_INSTANCE_STRIDE + MODEL_INSTANCE_PARAMS_OFFSET, {
            tint: trait.tint,
            flash: trait.flash,
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
            outlineColor: outline.color,
            // width 0 is the off switch on the GPU; `enabled` keeps a configured width across toggles.
            outlineWidth: outline.enabled ? outline.width : 0,
            outlineSpace: outline.space === 'world' ? 0 : 1,
        });
        if (slot < dirtyMinSlot) dirtyMinSlot = slot;
        if (slot > dirtyMaxSlot) dirtyMaxSlot = slot;

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

    // only [0, firstInstance) of slotMap was written and only that prefix is indexed by the
    // draws, so upload the prefix rather than the whole capacity-sized allocation.
    if (bucketId > 0) {
        batch.slotMapBuf.addUpdateRange(0, firstInstance);
        batch.slotMapBuf.needsUpdate = true;
    }
    if (dirtyMaxSlot >= 0) {
        const base = dirtyMinSlot * MODEL_INSTANCE_STRIDE_F32;
        batch.instanceDataBuf.addUpdateRange(base, (dirtyMaxSlot - dirtyMinSlot + 1) * MODEL_INSTANCE_STRIDE_F32);
        batch.instanceDataBuf.needsUpdate = true;
    }
}

/** Disposes per-room voxel-mesh visuals: tears down every instance this room holds and
 *  detaches the batch Mesh from this room's scene. The batch's GPU buffers and arena are
 *  not freed; they survive for the next room's init. */
export function dispose(visuals: VoxelMeshVisuals, batch: VoxelMeshBatch, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
    visuals.scene.remove(batch.outlineMesh);
}

/** Drops a VoxelModel's baked geometry so the next reference re-bakes, since bakes are
 *  immutable otherwise. Live instances referencing this model are torn down and rebuilt
 *  on the next update tick. */
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
    // stale tint before the first write lands.
    packTo(InstanceParams, batch.instanceDataBuf.array!, slot * MODEL_INSTANCE_STRIDE + MODEL_INSTANCE_PARAMS_OFFSET, {
        tint: [0, 0, 0, 0],
        flash: [0, 0, 0, 0],
        glow: 0,
        unlit: 0,
        litMin: 0,
        dither: 0,
        outlineColor: [0, 0, 0, 0],
        outlineWidth: 0,
        outlineSpace: 0,
    });
    batch.instanceDataBuf.addUpdateRange(
        slot * MODEL_INSTANCE_STRIDE_F32 + MODEL_INSTANCE_PARAMS_OFFSET / 4,
        INSTANCE_PARAMS_STRIDE / 4,
    );
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
    // linear scan; modelEntries is typically tiny (one per unique model in use this room).
    for (const entry of batch.modelEntries.values()) {
        if (entry.id === id) return entry;
    }
    return null;
}

/** Meshes every non-empty source chunk of model.voxels and packs the opaque, transparent,
 *  and translucent quads into the shared meshArena. Translucent quads are baked into the
 *  same stream with no per-quad depth sort, acceptable for object-scale models. */
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

/** Writes the VoxelModel's local AABB (boundsMin/Max minus origin, the space the mesh is
 *  baked in) into out and returns it. */
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
