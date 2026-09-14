// mesh visuals, per-room HW-instanced rendering for MeshTrait instances.
//
// Renders MeshTrait, one instance per (MeshTrait, TransformTrait), grouped for
// lighting and inherited visibility by an optional `Up(ModelTrait)` ancestor.
// `MeshResources` and `MeshAtlas` alongside are the client-global GPU pools it
// draws from. "model" survives here only where it means the loaded asset a mesh
// comes from (`modelId`, `core/models`) or the `ModelTrait` grouping node.
//
// architecture:
//   - shared geometry / atlas / meshInfo / material owned by client-global
//     MeshResources. The pool's interleaved vertex buffer binds as a real
//     vertex buffer named `vertex`; the index pool binds as the geometry
//     index. HW vertex fetch + HW indexing.
//   - per-room: stable per-slot `instanceData` ({worldMatrix, params},
//     each sub-range written gated by its own trait version; params now
//     also carries `uvOffset`/`uvScale` re-uploaded on entry-ref change),
//     plus per-frame `slotMap` (u32[]) + `mesh.draws` (MeshDraw[]) rebuilt
//     from the visible subset of `aliveStates`. Both storage buffers are
//     read-only, so gpucat lowers their reads to buffer-texture fetches on
//     WebGL2 automatically — one material source, both backends.
//   - CPU per frame walks aliveStates → buckets each visible state by
//     `meshSlot` → for each bucket writes the bucket's stable slots
//     contiguously into slotMap starting at the running `firstInstance`
//     cursor, then appends one MeshDraw covering that range to `mesh.draws`.
//     The renderer loops `mesh.draws` (one instanced draw per entry) — the
//     portable replacement for WebGPU-only indirect draws.
//   - VS reads attributes via HW, resolves `slotMap[instanceIndex]` →
//     `realSlot` (`instanceIndex` base-inclusive on both backends), reads
//     `instanceData[realSlot]`.
//   - per-instance state never moves slot. visibility = "got included in
//     some bucket this frame"; no per-instance visible u32 to write.

import { packTo, type Scene } from 'gpucat';
import { box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../../api/transforms';
import { MeshTrait } from '../../builtins/mesh';
import { ModelTrait } from '../../builtins/model';
import { TransformTrait } from '../../builtins/transform';
import type { MeshId } from '../../core/models/handle';
import * as Resources from '../../core/resources';
import { Optional, type Src, Up } from '../../core/scene/conditions';
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

type MeshQuery = ReturnType<
    typeof query<[typeof MeshTrait, typeof TransformTrait, ReturnType<typeof Optional<typeof ModelTrait, Src.Up>>]>
>;

// InstanceParams is written through `packTo` against the schema in
// mesh-resources.ts, NOT by hand-numbered float indices. It used to be the
// latter, and removing one field silently shifted every field after it into the
// next instance's memory - every model in the game rendered garbled, and no
// compiler caught it. Adding or reordering a field is now free.
//
// Dirtiness is decided by COMPARING the packed result against what the buffer
// already holds, rather than by a version counter the trait's setters had to
// remember to bump. That is the same shape `meshIdRef` already uses, and it
// means a script can assign trait fields directly with no setter to forget.

/** one packed `InstanceParams`, reused every write. Module scratch: the per-frame
 *  loop is single-threaded and the contents never outlive one iteration. */
const _paramsScratch = new Float32Array(INSTANCE_PARAMS_STRIDE_F32);

// ── types ───────────────────────────────────────────────────────────

/**
 * renderer-owned per-instance state stored on `MeshTrait._state`. created
 * on first alloc, cleared (back to null on the trait) on destroy. the
 * per-frame loop reads `meshTrait._state` directly, no Map lookup, no
 * sparse array.
 */
export type MeshVisualState = {
    /** stable GPU instance slot, indexes into instanceData. */
    slot: number;
    /** back-ref so cleanup can clear `trait._state` on destroy. */
    trait: MeshTrait;
    /** pointer-stable MeshId currently bound. compared by `===`; mismatch
     *  forces re-resolution of `meshSlot`. */
    meshIdRef: MeshId | null;
    /** resolved index into modelResources.meshInfo.entries[] for `meshIdRef`.
     *  read per frame to fetch firstIndex / indexCount + group by mesh. */
    meshSlot: number;
    /** frame counter of the most recent update() pass that touched this
     *  state. cleanup at end of update() destroys any state whose
     *  lastSeenFrame is stale. */
    lastSeenFrame: number;
    /** TransformTrait._version observed at the most recent transform
     *  upload. NOT advanced while the instance is hidden, so the moment
     *  it becomes visible the version mismatch forces a fresh write. */
    transformVersionAtUpload: number;
    /** this mesh's own frustum-cull entry. `cull.aabb` is the mesh handle's
     *  bind-pose box (filled at alloc / mesh swap); the shared Visibility
     *  culler owns the leaf and writes `cull.visible`, which the per-frame
     *  loop reads to gate inclusion in the per-mesh buckets. Registered at
     *  alloc, unregistered on destroy. */
    cull: Visibility.CullState;
    /** the mesh's lighting group: the nearest `ModelTrait` at or above this
     *  node, resolved by the query's `Up` term and kept live by the scene
     *  tree. `null` means this mesh is its own lighting unit and samples
     *  voxel light at its own AABB centre. Refreshed every frame from the
     *  query tuple, so a regrouped mesh can never hold a stale pointer. */
    model: ModelTrait | null;
    /** sibling `TransformTrait` on this mesh's node, resolved at alloc and
     *  cached so the per-frame loop skips the `_traits.get` Map hit. The
     *  ECS query gates on `[MeshTrait, TransformTrait]` already, so this
     *  is always present at alloc time; if a script removes the transform
     *  later the query stops matching and the state goes stale → destroyed. */
    transform: TransformTrait;
};

export type MeshVisuals = {
    /** this room's live meshes (+ their cull registrations). Each state's `slot`
     *  indexes the client-global `batch.instanceDataBuf`; freed on `dispose`. */
    aliveStates: MeshVisualState[];
    /** bound to THIS room's sceneTree. */
    _query: MeshQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` and its outline
     *  shell are added on init. */
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room model visuals: ready the client-global instance batch for a
 * fresh set of instances (reset its allocator + scratch + draws, buffers
 * untouched) and mount its Mesh into this room's scene. The batch itself — Mesh,
 * Geometry, per-slot buffers — is owned by `MeshResources` and survives room
 * swaps; only this room's use of it (alive-states, cull entries, scene-tree
 * query) lives here.
 */
export function init(batch: MeshBatch, scene: Scene, sceneTree: SceneTree): MeshVisuals {
    resetMeshBatch(batch);
    scene.add(batch.mesh);
    scene.add(batch.outlineMesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

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
    for (const [meshTrait, , model] of q.matches) {
        let state = meshTrait._state as MeshVisualState | null;
        const meshId = meshTrait.meshId;

        // fast path: same MeshId ref, state already exists.
        if (state !== null && state.meshIdRef === meshId && meshId !== null) {
            state.lastSeenFrame = frameId;
            // the query keeps the resolved group live; copy it across so phase 3
            // (which walks aliveStates, not matches) reads the current one.
            state.model = model;
            continue;
        }

        // ── slow path ─────────────────────────────────────────────
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

        // register this mesh with the shared culler, seeded from the handle's
        // bind-pose AABB. world AABB = that box × the mesh node's world matrix,
        // exact even mid-animation (TRS only, no skinning), so per-mesh
        // culling is correct.
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
            model,
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
    // touched-slot span, widened by each write below and uploaded as ONE range at the end.
    // slots come from a free-list allocator so they can scatter, and a span then covers
    // untouched slots in the middle — those re-send unchanged bytes, which is exactly what
    // the old blanket `needsUpdate` did for the WHOLE buffer, so the span is never worse.
    let dirtyMinSlot = Number.MAX_SAFE_INTEGER;
    let dirtyMaxSlot = -1;
    let dirtySlotCount = 0;

    // reset buckets, empty arrays in-place and pool any orphaned ones.
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < aliveStates.length; i++) {
        const state = aliveStates[i]!;
        const model = state.model;

        // `model` is Optional: a mesh under no ModelTrait has no inherited visibility.
        if (!state.cull.visible || !state.trait.visible) continue;
        if (model !== null && !model.visible) continue;

        const meshTrait = state.trait;
        const transformTrait = state.transform;

        // mesh metadata may be momentarily missing if the model was
        // released mid-frame; skip rather than crash.
        const entry = meshInfoEntries[state.meshSlot];
        if (!entry) continue;
        if (entry.indexCount === 0) continue;

        const slot = state.slot;

        const visualWorldMatrix = getVisualWorldMatrix(transformTrait);

        // both transforms and params write into the same merged
        // instanceData buffer at their slot's sub-ranges. each has its
        // own version compare so we still skip whichever didn't change.
        const slotBase = slot * MODEL_INSTANCE_STRIDE_F32;
        let slotDirty = false;

        // ── transform upload, gated on TransformTrait._version ──
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

        // ── params (tint/flash/glow/outline + atlas uv) ──
        // Packed into a scratch, then compared field-for-field against what the
        // instance buffer already holds. The buffer IS the cache, so there is no
        // per-instance snapshot to keep in step, and a MeshInfo entry swap
        // (image-decode patch landed → new uvOffset/uvScale) shows up as a plain
        // difference rather than needing its own ref check.
        const outline = meshTrait.outline;
        // LAZY: the smoothed-normal bake only runs for a mesh something actually
        // outlines, and only once. `ensureSmoothNormals` is idempotent, so this is
        // a flag check on every subsequent frame.
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
            // width 0 IS the off switch on the GPU: the vertex stage drops the
            // triangle outright. `enabled` stays a separate field so a configured
            // width survives being toggled.
            outlineWidth: outline.enabled ? outline.width : 0,
            outlineSpace: outline.space === 'world' ? 0 : 1,
        });
        const po = slotBase + MODEL_INSTANCE_PARAMS_OFFSET_F32;
        // compare and write in ONE pass, element by element: `set()` would re-send
        // the whole block on any change and costs a call for ~24 floats.
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
        }

        // ── bucket by meshSlot ────────────────────────────────────
        let bucket = buckets.get(state.meshSlot);
        if (bucket === undefined) {
            bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
            buckets.set(state.meshSlot, bucket);
        }
        bucket.push(slot);
    }

    if (dirtyMaxSlot >= 0) {
        const base = dirtyMinSlot * MODEL_INSTANCE_STRIDE_F32;
        batch.instanceDataBuf.addUpdateRange(base, (dirtyMaxSlot - dirtyMinSlot + 1) * MODEL_INSTANCE_STRIDE_F32);
        batch.instanceDataBuf.needsUpdate = true;
    }

    // Span efficiency, read by the render backend into the frame profiler. `dirtySlots` is what
    // actually changed; `dirtySpan` is what the single min..max range uploads. They diverge
    // when dirty slots scatter — the light resample is phased BY SLOT, so every 8th slot
    // re-samples on a given frame — and a wide span then re-sends untouched slots.
    batch.aliveInstances = aliveStates.length;
    batch.dirtyInstances = dirtySlotCount;
    batch.dirtySpan = dirtyMaxSlot >= 0 ? dirtyMaxSlot - dirtyMinSlot + 1 : 0;
}

/** phase 4: walk the buckets phase 3 filled, writing slots contiguously into slotMap and
 *  emitting one MeshDraw per non-empty bucket. */
function packDraws(batch: MeshBatch, modelResources: MeshResources): void {
    const meshInfoEntries = modelResources.meshInfo.entries;
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    // walk buckets; for each non-empty, write slots contiguously into slotMap
    // and emit one MeshDraw covering that range. orphan buckets (no slots this
    // frame) get popped into the free list to keep the working set tight.
    const slotMapArr = batch.slotMapBuf.array as Uint32Array;
    const draws = batch.draws;

    let firstInstance = 0;
    let writtenDraws = 0;
    for (const [meshSlot, slots] of buckets) {
        const len = slots.length;
        if (len === 0) {
            // recycle the array; drop from the map so it doesn't linger.
            buckets.delete(meshSlot);
            freeBuckets.push(slots);
            continue;
        }
        const entry = meshInfoEntries[meshSlot];
        if (!entry) continue; // released mid-frame, skip.

        // write slots into slotMap at [firstInstance .. +len).
        for (let i = 0; i < len; i++) slotMapArr[firstInstance + i] = slots[i]!;

        // one instanced draw over this bucket's shared geometry; baseVertex
        // stays 0 since pool indices are pre-rebased to absolute vertex
        // positions at upload time. Reuse the existing entry object if present.
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

    // trim the reused draw array to this frame's active count.
    draws.length = writtenDraws;

    // only [0, firstInstance) was written and only that prefix is indexed by the draws, so
    // upload the prefix rather than the whole instanceCapacity-sized allocation.
    if (writtenDraws > 0) {
        batch.slotMapBuf.addUpdateRange(0, firstInstance);
        batch.slotMapBuf.needsUpdate = true;
    }
}

// ── dispose ─────────────────────────────────────────────────────────

/**
 * Dispose per-room model visuals: release every slot this room holds in the
 * client-global batch (frees the allocator entries, unregisters cull, clears
 * `trait._state`) and detach the batch Mesh from this room's scene. The batch's
 * GPU buffers are NOT freed — they survive for the next room's `init`.
 */
export function dispose(visuals: MeshVisuals, batch: MeshBatch, visibility: Visibility.Visibility): void {
    // walk backward, destroyInstance does swap-pop from aliveStates.
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
    visuals.scene.remove(batch.outlineMesh);
}

// ── internal ────────────────────────────────────────────────────────

function destroyInstance(visuals: MeshVisuals, batch: MeshBatch, trait: MeshTrait, visibility: Visibility.Visibility): void {
    const state = trait._state as MeshVisualState | null;
    if (state === null) return;
    Visibility.remove(visibility, state.cull);
    const slot = state.slot;

    // zero per-slot params so a reused slot doesn't briefly inherit stale
    // tint/uv before the first write lands - and so the comparison in
    // `writeInstances` sees a difference and writes. Transforms aren't zeroed:
    // the next allocation's version mismatch forces a full re-upload before the
    // slot is referenced again.
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
