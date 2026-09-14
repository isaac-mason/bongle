import { packTo, type Scene } from 'gpucat';
import { box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../../api/transforms';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import type { MeshId } from '../../core/models/handle';
import * as Resources from '../../core/resources';
import type { SceneTree } from '../../core/scene/scene-tree';
import { getTrait, query } from '../../core/scene/scene-tree';
import * as Visibility from '../visibility/visibility';
import {
    allocateSlot,
    ensureSmoothNormals,
    freeSlot,
    growMeshBatch,
    INSTANCE_PARAMS_STRIDE,
    INSTANCE_PARAMS_STRIDE_F32,
    InstanceParams,
    type MeshBatch,
    type MeshResources,
    MODEL_INSTANCE_PARAMS_OFFSET_F32,
    MODEL_INSTANCE_STRIDE_F32,
    meshInfoIndexOf,
    resetMeshBatch,
} from './mesh-resources';

type MeshQuery = ReturnType<typeof query<[typeof MeshTrait, typeof TransformTrait]>>;

// InstanceParams is written through `packTo` against the schema in mesh-resources.ts,
// not by hand-numbered float indices, so adding or reordering a field is safe.
//
// dirtiness is decided by comparing the packed result against what the buffer already
// holds, rather than a version counter the trait's setters would have to remember to
// bump, so a script can assign trait fields directly with no setter to forget.

/** one packed `InstanceParams`, reused every write. Module scratch: the per-frame
 *  loop is single-threaded and the contents never outlive one iteration. */
const _paramsScratch = new Float32Array(INSTANCE_PARAMS_STRIDE_F32);

/** renderer-owned per-instance state stored on `MeshTrait._state`. created on first
 *  alloc, cleared to null on destroy; the per-frame loop reads it directly, no Map
 *  lookup, no sparse array. */
export type MeshVisualState = {
    /** stable GPU instance slot, indexes into instanceData. */
    slot: number;
    /** back-ref so cleanup can clear `trait._state` on destroy. */
    trait: MeshTrait;
    /** pointer-stable MeshId currently bound; compared by `===`, mismatch forces
     *  re-resolution of `meshSlot`. */
    meshIdRef: MeshId | null;
    /** resolved index into modelResources.meshInfo.entries[] for `meshIdRef`. */
    meshSlot: number;
    /** frame counter of the most recent update() pass that touched this state; a
     *  stale value gets destroyed at end of update(). */
    lastSeenFrame: number;
    /** TransformTrait._version observed at the last transform upload. not advanced
     *  while hidden, so becoming visible forces a fresh write. */
    transformVersionAtUpload: number;
    /** this mesh's own frustum-cull entry, registered at alloc and unregistered on
     *  destroy; the shared Visibility culler writes `cull.visible`. */
    cull: Visibility.CullState;
    /** sibling `TransformTrait`, resolved at alloc and cached to skip the `_traits`
     *  Map hit; always present since the query gates on [MeshTrait, TransformTrait]. */
    transform: TransformTrait;
};

export type MeshVisuals = {
    /** this room's live meshes and their cull registrations; each state's `slot`
     *  indexes the client-global `batch.instanceDataBuf`, freed on `dispose`. */
    aliveStates: MeshVisualState[];
    /** bound to this room's sceneTree. */
    _query: MeshQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` and its outline shell
     *  are added on init. */
    scene: Scene;
};

/** creates per-room model visuals: resets the client-global instance batch's
 *  allocator/scratch/draws and mounts its Mesh into this room's scene. the batch
 *  itself is owned by `MeshResources` and survives room swaps. */
export function init(batch: MeshBatch, scene: Scene, sceneTree: SceneTree): MeshVisuals {
    resetMeshBatch(batch);
    scene.add(batch.mesh);
    scene.add(batch.outlineMesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [MeshTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

/** per-frame update, in four phases. */
export function update(
    visuals: MeshVisuals,
    batch: MeshBatch,
    modelResources: MeshResources,
    resources: Resources.Resources,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    refreshStates(visuals, batch, modelResources, resources, visibility, frameId);
    destroyStaleStates(visuals, batch, visibility, frameId);
    writeInstances(visuals, batch, modelResources);
    packDraws(batch, modelResources);
}

/** phase 1: give every matched mesh a live MeshVisualState, allocating or rebinding as
 *  needed, and stamp it so phase 2 can tell which states no longer have a match. */
function refreshStates(
    visuals: MeshVisuals,
    batch: MeshBatch,
    modelResources: MeshResources,
    resources: Resources.Resources,
    visibility: Visibility.Visibility,
    frameId: number,
): void {
    const q = visuals._query;
    for (const [meshTrait] of q.matches) {
        let state = meshTrait._state as MeshVisualState | null;
        const meshId = meshTrait.meshId;

        // fast path: same MeshId ref, state already exists.
        if (state !== null && state.meshIdRef === meshId && meshId !== null) {
            state.lastSeenFrame = frameId;
            continue;
        }

        // slow path
        if (meshId === null) {
            if (state !== null) destroyInstance(visuals, batch, meshTrait, visibility);
            continue;
        }

        if (!Resources.hasModel(resources, meshId.modelId)) {
            Resources.ensureModel(resources, meshId.modelId);
            if (state !== null) destroyInstance(visuals, batch, meshTrait, visibility);
            continue;
        }

        const meshKey = `${meshId.modelId}/${meshId.meshName}`;
        const meshSlot = meshInfoIndexOf(modelResources.meshInfo, meshKey);
        if (meshSlot === null) {
            if (state !== null) destroyInstance(visuals, batch, meshTrait, visibility);
            continue;
        }

        // existing state with a different MeshId, destroy + recreate so
        // the new meshSlot resolves fresh.
        if (state !== null) destroyInstance(visuals, batch, meshTrait, visibility);

        const slot = allocateSlot(batch.instanceAllocator);
        if (slot >= batch.instanceCapacity) {
            growMeshBatch(batch, batch.instanceAllocator.capacity);
        }

        const transform = getTrait(meshTrait._node, TransformTrait)!;

        // seeded from the handle's bind-pose AABB; world AABB = that box times the mesh
        // node's world matrix, exact even mid-animation since there's no skinning.
        const handle = resources.models.get(meshId.modelId)?.def;
        const meshEntry = handle?.meshes[meshId.meshName];
        const cull = Visibility.add(visibility, meshEntry?.aabb ?? box3.create(), transform);

        state = {
            slot,
            trait: meshTrait,
            meshIdRef: meshId,
            meshSlot,
            lastSeenFrame: frameId,
            transformVersionAtUpload: -1,
            cull,
            transform,
        };
        meshTrait._state = state;
        visuals.aliveStates.push(state);
    }
}

/** phase 2: drop states whose mesh left the query this frame. */
function destroyStaleStates(visuals: MeshVisuals, batch: MeshBatch, visibility: Visibility.Visibility, frameId: number): void {
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, batch, state.trait, visibility);
    }
}

/** phase 3: per-instance writes into the merged instance buffer, plus bucketing by mesh for
 *  the draw pack below. Queues the touched span for upload before returning. */
function writeInstances(visuals: MeshVisuals, batch: MeshBatch, modelResources: MeshResources): void {
    const aliveStates = visuals.aliveStates;
    // re-read here rather than in `update`: growing the batch in refreshStates
    // reallocates the buffer, so a reference taken earlier can be stale.
    const instArr = batch.instanceDataBuf.array as Float32Array;
    const meshInfoEntries = modelResources.meshInfo.entries;
    // touched-slot span, widened by each write below and uploaded as one range at the
    // end; slots come from a free-list allocator so they can scatter, and a span then
    // covers untouched slots that re-send unchanged bytes.
    let dirtyMinSlot = Number.MAX_SAFE_INTEGER;
    let dirtyMaxSlot = -1;
    let dirtySlotCount = 0;

    // reset buckets, empty arrays in-place and pool any orphaned ones.
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < aliveStates.length; i++) {
        const state = aliveStates[i]!;

        if (!state.cull.visible || !state.trait.visible) continue;

        const meshTrait = state.trait;
        const transformTrait = state.transform;

        // mesh metadata may be momentarily missing if the model was
        // released mid-frame; skip rather than crash.
        const entry = meshInfoEntries[state.meshSlot];
        if (!entry) continue;
        if (entry.indexCount === 0) continue;

        const slot = state.slot;

        const visualWorldMatrix = getVisualWorldMatrix(transformTrait);

        // transforms and params write into the same merged instanceData buffer at their
        // slot's sub-ranges, each with its own version compare so we skip whichever didn't change.
        const slotBase = slot * MODEL_INSTANCE_STRIDE_F32;
        let slotDirty = false;

        // transform upload, gated on TransformTrait._version.
        const transformVersion = transformTrait._version;
        if (transformVersion !== state.transformVersionAtUpload) {
            instArr[slotBase + 0] = visualWorldMatrix[0]!;
            instArr[slotBase + 1] = visualWorldMatrix[1]!;
            instArr[slotBase + 2] = visualWorldMatrix[2]!;
            instArr[slotBase + 3] = visualWorldMatrix[3]!;
            instArr[slotBase + 4] = visualWorldMatrix[4]!;
            instArr[slotBase + 5] = visualWorldMatrix[5]!;
            instArr[slotBase + 6] = visualWorldMatrix[6]!;
            instArr[slotBase + 7] = visualWorldMatrix[7]!;
            instArr[slotBase + 8] = visualWorldMatrix[8]!;
            instArr[slotBase + 9] = visualWorldMatrix[9]!;
            instArr[slotBase + 10] = visualWorldMatrix[10]!;
            instArr[slotBase + 11] = visualWorldMatrix[11]!;
            instArr[slotBase + 12] = visualWorldMatrix[12]!;
            instArr[slotBase + 13] = visualWorldMatrix[13]!;
            instArr[slotBase + 14] = visualWorldMatrix[14]!;
            instArr[slotBase + 15] = visualWorldMatrix[15]!;
            state.transformVersionAtUpload = transformVersion;
            slotDirty = true;
        }

        // params (tint/flash/glow/outline + atlas uv): packed into a scratch, then
        // compared field-for-field against what the instance buffer already holds. the
        // buffer is the cache, so a MeshInfo entry swap shows up as a plain difference.
        const outline = meshTrait.outline;
        // the smoothed-normal bake only runs once, for a mesh something actually
        // outlines; `ensureSmoothNormals` is idempotent, a flag check afterward.
        if (outline.enabled) ensureSmoothNormals(modelResources.geometry, entry.geometry);
        packTo(InstanceParams, _paramsScratch, 0, {
            tint: meshTrait.tint,
            flash: meshTrait.flash,
            glow: meshTrait.glow,
            unlit: meshTrait.unlit ? 1 : 0,
            litMin: meshTrait.litMin,
            dither: meshTrait.dither,
            uvOffset: entry.uvOffset,
            uvScale: entry.uvScale,
            outlineColor: outline.color,
            // width 0 is the off switch on the GPU, dropping the triangle outright;
            // `enabled` stays separate so a configured width survives toggling.
            outlineWidth: outline.enabled ? outline.width : 0,
            outlineSpace: outline.space === 'world' ? 0 : 1,
        });
        const po = slotBase + MODEL_INSTANCE_PARAMS_OFFSET_F32;
        // compare and write in one pass, element by element, rather than `set()`
        // re-sending the whole block on any change.
        let paramsDirty = false;
        for (let k = 0; k < INSTANCE_PARAMS_STRIDE_F32; k++) {
            const v = _paramsScratch[k]!;
            if (instArr[po + k] !== v) {
                instArr[po + k] = v;
                paramsDirty = true;
            }
        }
        if (paramsDirty) slotDirty = true;

        if (slotDirty) {
            dirtySlotCount++;
            if (slot < dirtyMinSlot) dirtyMinSlot = slot;
            if (slot > dirtyMaxSlot) dirtyMaxSlot = slot;
            // ONE RANGE PER DIRTY SLOT, not a single min..max span. Dirty slots scatter - the
            // light resample is phased by slot, so only every Nth re-samples on a given frame -
            // and one span across them re-sends every untouched slot in the gap at 160 B each.
            // gpucat merges adjacent ranges before uploading, so contiguous runs still cost one
            // write, and a fully-dirty batch collapses back to the single span this replaces.
            batch.instanceDataBuf.addUpdateRange(slot * MODEL_INSTANCE_STRIDE_F32, MODEL_INSTANCE_STRIDE_F32);
        }

        let bucket = buckets.get(state.meshSlot);
        if (bucket === undefined) {
            bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
            buckets.set(state.meshSlot, bucket);
        }
        bucket.push(slot);
    }

    if (dirtyMaxSlot >= 0) {
        batch.instanceDataBuf.needsUpdate = true;
    }

    // span efficiency, read by the render backend into the frame profiler. `dirtySlots` is
    // what actually changed; `dirtySpan` is what the min..max range uploads, and they
    // diverge when dirty slots scatter (the light resample is phased by slot).
    batch.aliveInstances = aliveStates.length;
    batch.dirtyInstances = dirtySlotCount;
    // what a single min..max span WOULD have uploaded, kept as the comparison against
    // `dirtyInstances`: the gap between them is what per-slot ranges now avoid sending.
    batch.dirtySpan = dirtyMaxSlot >= 0 ? dirtyMaxSlot - dirtyMinSlot + 1 : 0;
}

/** phase 4: walk the buckets phase 3 filled, writing slots contiguously into slotMap and
 *  emitting one MeshDraw per non-empty bucket. */
function packDraws(batch: MeshBatch, modelResources: MeshResources): void {
    const meshInfoEntries = modelResources.meshInfo.entries;
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    const slotMapArr = batch.slotMapBuf.array as Uint32Array;
    const draws = batch.draws;

    let firstInstance = 0;
    let writtenDraws = 0;
    for (const [meshSlot, slots] of buckets) {
        const len = slots.length;
        if (len === 0) {
            // orphan bucket, no slots this frame: recycle the array into the free list.
            buckets.delete(meshSlot);
            freeBuckets.push(slots);
            continue;
        }
        const entry = meshInfoEntries[meshSlot];
        if (!entry) continue; // released mid-frame, skip.

        for (let i = 0; i < len; i++) slotMapArr[firstInstance + i] = slots[i]!;

        // baseVertex stays 0 since pool indices are pre-rebased to absolute vertex
        // positions at upload time. reuse the existing entry object if present.
        let draw = draws[writtenDraws];
        if (draw === undefined) {
            draw = { indexCount: 0, instanceCount: 0, firstIndex: 0, firstInstance: 0 };
            draws[writtenDraws] = draw;
        }
        draw.indexCount = entry.indexCount;
        draw.instanceCount = len;
        draw.firstIndex = entry.firstIndex;
        draw.firstInstance = firstInstance;

        firstInstance += len;
        writtenDraws++;
    }

    draws.length = writtenDraws;

    // only [0, firstInstance) was written, so upload that prefix rather than the whole
    // instanceCapacity-sized allocation.
    if (writtenDraws > 0) {
        batch.slotMapBuf.addUpdateRange(0, firstInstance);
        batch.slotMapBuf.needsUpdate = true;
    }
}

/** disposes per-room model visuals: releases every slot this room holds in the
 *  client-global batch and detaches the batch Mesh from this room's scene. the
 *  batch's GPU buffers are not freed, they survive for the next room's `init`. */
export function dispose(visuals: MeshVisuals, batch: MeshBatch, visibility: Visibility.Visibility): void {
    // walk backward, destroyInstance does swap-pop from aliveStates.
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
    visuals.scene.remove(batch.outlineMesh);
}

function destroyInstance(visuals: MeshVisuals, batch: MeshBatch, trait: MeshTrait, visibility: Visibility.Visibility): void {
    const state = trait._state as MeshVisualState | null;
    if (state === null) return;
    Visibility.remove(visibility, state.cull);
    const slot = state.slot;

    // zero per-slot params so a reused slot doesn't briefly inherit stale tint/uv, and
    // so the comparison in `writeInstances` sees a difference and writes. transforms
    // aren't zeroed, the next allocation's version mismatch forces a full re-upload.
    const instArr = batch.instanceDataBuf.array as Float32Array;
    const po = slot * MODEL_INSTANCE_STRIDE_F32 + MODEL_INSTANCE_PARAMS_OFFSET_F32;
    for (let k = 0; k < INSTANCE_PARAMS_STRIDE_F32; k++) instArr[po + k] = 0;
    batch.instanceDataBuf.addUpdateRange(po, INSTANCE_PARAMS_STRIDE / 4);
    batch.instanceDataBuf.needsUpdate = true;

    freeSlot(batch.instanceAllocator, slot);

    const arr = visuals.aliveStates;
    const last = arr.length - 1;
    if (last >= 0) {
        for (let i = last; i >= 0; i--) {
            if (arr[i] === state) {
                if (i !== last) arr[i] = arr[last]!;
                arr.pop();
                break;
            }
        }
    }

    trait._state = null;
}
