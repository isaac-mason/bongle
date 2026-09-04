// model visuals, per-room HW-instanced rendering for MeshTrait instances.
//
// architecture:
//   - shared geometry / atlas / meshInfo / material owned by client-global
//     ModelResources. The pool's interleaved vertex buffer binds as a real
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

import type { Scene } from 'gpucat';
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
import { sampleVoxelLight } from '../../core/voxels/light';
import type { Voxels } from '../../core/voxels/voxels';
import * as Visibility from '../visibility/visibility';
import {
    allocateSlot,
    freeSlot,
    growModelBatch,
    type MeshInfoEntry,
    MODEL_INSTANCE_PARAMS_OFFSET_F32,
    MODEL_INSTANCE_STRIDE_F32,
    type ModelBatch,
    type ModelResources,
    meshInfoIndexOf,
    resetModelBatch,
} from './model-resources';

type MeshQuery = ReturnType<
    typeof query<[typeof MeshTrait, typeof TransformTrait, ReturnType<typeof Optional<typeof ModelTrait, Src.Up>>]>
>;

// InstanceParams f32 layout (20 f32 / 80B, mirrors `InstanceParams` in
// model-resources.ts, must stay in sync, no compiler will catch drift):
//   [ 0..3 ]  tint     vec4f  (rgb = target, a = intensity)
//   [ 4..7 ]  flash    vec4f  (rgb = colour, a = strength)
//   [ 8..11]  light    vec4f
//   [  12  ]  glow     f32
//   [  13  ]  unlit    f32   (0=lit, 1=bypass)
//   [  14  ]  litMin   f32
//   [  15  ]  dither   f32
//   [ 16..17] uvOffset vec2f
//   [ 18..19] uvScale  vec2f
// If you reorder fields in `InstanceParams`, update the writes below AND
// `destroyInstance` AND `MODEL_INSTANCE_PARAMS_OFFSET_F32` in lockstep.

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
    /** MeshTrait._version observed at the most recent params upload.
     *  -1 forces the initial upload (trait._version starts at 0). */
    paramsVersionAtUpload: number;
    /** TransformTrait._version observed at the most recent transform
     *  upload. NOT advanced while the instance is hidden, so the moment
     *  it becomes visible the version mismatch forces a fresh write. */
    transformVersionAtUpload: number;
    /** MeshInfoEntry reference observed at the most recent params upload.
     *  Image-decode patches replace the entry object, mismatch retriggers
     *  the params upload so the new uvOffset/uvScale reach the slot. */
    entryRefAtUpload: MeshInfoEntry | null;
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
    /** frame of the most recent voxel-light resample, and the inputs that
     *  justified it. Only meaningful for an ungrouped mesh (one in a lighting
     *  group reads the group's value and never samples). */
    lightSampledFrame: number;
    lightTransformVersion: number;
    lightEpoch: number;
    /** RGBA of the last light written into the slot's params block. Compared
     *  against the freshly resolved light each frame; only a delta marks
     *  params dirty. Initialised to NaN so the first compare always
     *  mismatches and the initial upload fires. */
    lastLightR: number;
    lastLightG: number;
    lastLightB: number;
    lastLightA: number;
};

export type ModelVisuals = {
    /** this room's live meshes (+ their cull registrations). Each state's `slot`
     *  indexes the client-global `batch.instanceDataBuf`; freed on `dispose`. */
    aliveStates: MeshVisualState[];
    /** bound to THIS room's sceneTree. */
    _query: MeshQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room model visuals: ready the client-global instance batch for a
 * fresh set of instances (reset its allocator + scratch + draws, buffers
 * untouched) and mount its Mesh into this room's scene. The batch itself — Mesh,
 * Geometry, per-slot buffers — is owned by `ModelResources` and survives room
 * swaps; only this room's use of it (alive-states, cull entries, scene-tree
 * query) lives here.
 */
export function init(batch: ModelBatch, scene: Scene, sceneTree: SceneTree): ModelVisuals {
    resetModelBatch(batch);
    scene.add(batch.mesh);
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
    visuals: ModelVisuals,
    batch: ModelBatch,
    modelResources: ModelResources,
    resources: Resources.Resources,
    visibility: Visibility.Visibility,
    voxels: Voxels,
): void {
    const frameId = ++visuals.frameId;
    refreshStates(visuals, batch, modelResources, resources, visibility, frameId);
    destroyStaleStates(visuals, batch, visibility, frameId);
    const instanceDataDirty = writeInstances(visuals, batch, modelResources, voxels, frameId);
    packDraws(batch, modelResources, instanceDataDirty);
}

/** phase 1: give every matched mesh a live MeshVisualState, allocating or rebinding as
 *  needed, and stamp it so phase 2 can tell which states no longer have a match. */
function refreshStates(
    visuals: ModelVisuals,
    batch: ModelBatch,
    modelResources: ModelResources,
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
            growModelBatch(batch, batch.instanceAllocator.capacity);
        }

        const transform = getTrait(meshTrait._node, TransformTrait)!;

        // register this mesh with the shared culler, seeded from the handle's
        // bind-pose AABB. world AABB = that box × the mesh node's world matrix,
        // exact even mid-animation (TRS only, no skinning), so per-mesh
        // culling is correct.
        const handle = resources.models.get(meshId.modelId)?.handle;
        const meshEntry = handle?.meshes[meshId.meshName];
        const cull = Visibility.add(visibility, meshEntry?.aabb ?? box3.create(), transform);

        state = {
            slot,
            trait: meshTrait,
            meshIdRef: meshId,
            meshSlot,
            lastSeenFrame: frameId,
            paramsVersionAtUpload: -1,
            transformVersionAtUpload: -1,
            entryRefAtUpload: null,
            cull,
            model,
            transform,
            lightSampledFrame: -1,
            lightTransformVersion: -1,
            lightEpoch: -1,
            lastLightR: NaN,
            lastLightG: NaN,
            lastLightB: NaN,
            lastLightA: NaN,
        };
        meshTrait._state = state;
        visuals.aliveStates.push(state);
    }
}

/** phase 2: drop states whose mesh left the query this frame. */
function destroyStaleStates(visuals: ModelVisuals, batch: ModelBatch, visibility: Visibility.Visibility, frameId: number): void {
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, batch, state.trait, visibility);
    }
}

/** phase 3: per-instance writes into the merged instance buffer, plus bucketing by mesh for
 *  the draw pack below. Returns whether anything was written. */
function writeInstances(
    visuals: ModelVisuals,
    batch: ModelBatch,
    modelResources: ModelResources,
    voxels: Voxels,
    frameId: number,
): boolean {
    const aliveStates = visuals.aliveStates;
    // re-read here rather than in `update`: growing the batch in refreshStates
    // reallocates the buffer, so a reference taken earlier can be stale.
    const instArr = batch.instanceDataBuf.array as Float32Array;
    const meshInfoEntries = modelResources.meshInfo.entries;
    let instanceDataDirty = false;

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

        // Resolve lighting. Unlit meshes skip the work entirely; toggling
        // `unlit` via `setMeshUnlit` bumps `meshTrait._version` so the
        // params upload below still picks up the flag flip.
        //
        // The lit branch writes `meshTrait.light` (script-visible), then compares
        // against the state's last-uploaded light. Writing unchanged values
        // doesn't flip `lightDirty`, so the params upload is skipped; without
        // this gate every visible mesh would re-upload every frame.
        //
        // A mesh in a lighting group (a `ModelTrait` at or above it) shares that
        // group's one sample, so a rig's limbs stay consistent and a bone whose
        // world position clips into a solid voxel can't pop dark. A mesh with no
        // group is its own lighting unit and samples at its own AABB centre,
        // which is inside its geometry by construction — no anchor to configure.
        const visualWorldMatrix = getVisualWorldMatrix(transformTrait);
        let lightDirty = false;
        if (!meshTrait.unlit) {
            const light = meshTrait.light;
            const cull = state.cull;
            if (model !== null) {
                const src = model.light;
                light[0] = src[0]!;
                light[1] = src[1]!;
                light[2] = src[2]!;
                light[3] = src[3]!;
            } else if (cull.leaf !== -1 && shouldResampleLight(state, transformTrait, voxels, frameId)) {
                // the centre of a box's world AABB is the world transform of its
                // local centre (the box is symmetric about it), so this is a
                // point transform, not a box transform.
                const b = cull.aabb;
                const lx = (b[0]! + b[3]!) * 0.5;
                const ly = (b[1]! + b[4]!) * 0.5;
                const lz = (b[2]! + b[5]!) * 0.5;
                const m = visualWorldMatrix;
                sampleVoxelLight(
                    voxels,
                    m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!,
                    m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!,
                    m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!,
                    light,
                );
            }
            const lr = light[0]!;
            const lg = light[1]!;
            const lb = light[2]!;
            const la = light[3]!;
            if (lr !== state.lastLightR || lg !== state.lastLightG || lb !== state.lastLightB || la !== state.lastLightA) {
                state.lastLightR = lr;
                state.lastLightG = lg;
                state.lastLightB = lb;
                state.lastLightA = la;
                lightDirty = true;
            }
        }

        // both transforms and params write into the same merged
        // instanceData buffer at their slot's sub-ranges. each has its
        // own version compare so we still skip whichever didn't change.
        const slotBase = slot * MODEL_INSTANCE_STRIDE_F32;

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
            instanceDataDirty = true;
        }

        // ── params (tint/light/glow + uv), re-uploads on trait._version
        //    bump (script-visible field changed), MeshInfo entry swap
        //    (image-decode patch landed → new uvOffset/uvScale), OR a
        //    light delta detected above. ──
        const meshVersion = meshTrait._version;
        if (meshVersion !== state.paramsVersionAtUpload || entry !== state.entryRefAtUpload || lightDirty) {
            const po = slotBase + MODEL_INSTANCE_PARAMS_OFFSET_F32;
            const tint = meshTrait.tint;
            const flash = meshTrait.flash;
            const light = meshTrait.light;
            const uvOffset = entry.uvOffset;
            const uvScale = entry.uvScale;
            instArr[po] = tint[0]!;
            instArr[po + 1] = tint[1]!;
            instArr[po + 2] = tint[2]!;
            instArr[po + 3] = tint[3]!;
            instArr[po + 4] = flash[0]!;
            instArr[po + 5] = flash[1]!;
            instArr[po + 6] = flash[2]!;
            instArr[po + 7] = flash[3]!;
            instArr[po + 8] = light[0]!;
            instArr[po + 9] = light[1]!;
            instArr[po + 10] = light[2]!;
            instArr[po + 11] = light[3]!;
            instArr[po + 12] = meshTrait.glow;
            instArr[po + 13] = meshTrait.unlit ? 1 : 0;
            instArr[po + 14] = meshTrait.litMin;
            instArr[po + 15] = meshTrait.dither;
            instArr[po + 16] = uvOffset[0]!;
            instArr[po + 17] = uvOffset[1]!;
            instArr[po + 18] = uvScale[0]!;
            instArr[po + 19] = uvScale[1]!;
            state.paramsVersionAtUpload = meshVersion;
            state.entryRefAtUpload = entry;
            instanceDataDirty = true;
        }

        // ── bucket by meshSlot ────────────────────────────────────
        let bucket = buckets.get(state.meshSlot);
        if (bucket === undefined) {
            bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
            buckets.set(state.meshSlot, bucket);
        }
        bucket.push(slot);
    }

    return instanceDataDirty;
}

/** phase 4: walk the buckets phase 3 filled, writing slots contiguously into slotMap and
 *  emitting one MeshDraw per non-empty bucket. */
function packDraws(batch: ModelBatch, modelResources: ModelResources, instanceDataDirty: boolean): void {
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

    if (writtenDraws > 0) batch.slotMapBuf.needsUpdate = true;
    if (instanceDataDirty) batch.instanceDataBuf.needsUpdate = true;
}


/** how often an unmoved, ungrouped mesh re-samples voxel light, in frames.
 *  phased by instance slot so the cost spreads instead of spiking. */
const LIGHT_RESAMPLE_FRAMES = 8;

/**
 * Should this ungrouped mesh sample voxel light this frame? A mesh that hasn't
 * moved is almost always looking at unchanged light, so a static prop pays one
 * sample rather than one per frame.
 *
 * Movement and a full relight (`lighting.epoch`) resample immediately. Ordinary
 * local light changes — a torch placed nearby — bump neither, so the phased
 * periodic refresh is what catches those, within `LIGHT_RESAMPLE_FRAMES`.
 */
function shouldResampleLight(state: MeshVisualState, transform: TransformTrait, voxels: Voxels, frameId: number): boolean {
    const version = transform._version;
    const epoch = voxels.lighting.epoch;
    if (state.lightTransformVersion !== version || state.lightEpoch !== epoch) {
        state.lightTransformVersion = version;
        state.lightEpoch = epoch;
        state.lightSampledFrame = frameId;
        return true;
    }
    if ((frameId + state.slot) % LIGHT_RESAMPLE_FRAMES === 0) {
        state.lightSampledFrame = frameId;
        return true;
    }
    return false;
}

// ── dispose ─────────────────────────────────────────────────────────

/**
 * Dispose per-room model visuals: release every slot this room holds in the
 * client-global batch (frees the allocator entries, unregisters cull, clears
 * `trait._state`) and detach the batch Mesh from this room's scene. The batch's
 * GPU buffers are NOT freed — they survive for the next room's `init`.
 */
export function dispose(visuals: ModelVisuals, batch: ModelBatch, visibility: Visibility.Visibility): void {
    // walk backward, destroyInstance does swap-pop from aliveStates.
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
}

// ── internal ────────────────────────────────────────────────────────

function destroyInstance(visuals: ModelVisuals, batch: ModelBatch, trait: MeshTrait, visibility: Visibility.Visibility): void {
    const state = trait._state as MeshVisualState | null;
    if (state === null) return;
    Visibility.remove(visibility, state.cull);
    const slot = state.slot;

    // zero per-slot params so a reused slot doesn't briefly inherit
    // stale tint/light/uv before the first write lands. transforms aren't
    // zeroed, the next allocation's version mismatch forces a full
    // re-upload before the slot is referenced again. 20 f32 = 80B params
    // block (mirrors `InstanceParams` layout above).
    const instArr = batch.instanceDataBuf.array as Float32Array;
    const po = slot * MODEL_INSTANCE_STRIDE_F32 + MODEL_INSTANCE_PARAMS_OFFSET_F32;
    instArr[po] = 0;
    instArr[po + 1] = 0;
    instArr[po + 2] = 0;
    instArr[po + 3] = 0;
    instArr[po + 4] = 0;
    instArr[po + 5] = 0;
    instArr[po + 6] = 0;
    instArr[po + 7] = 0;
    instArr[po + 8] = 0;
    instArr[po + 9] = 0;
    instArr[po + 10] = 0;
    instArr[po + 11] = 0;
    instArr[po + 12] = 0;
    instArr[po + 13] = 0;
    instArr[po + 14] = 0;
    instArr[po + 15] = 0;
    instArr[po + 16] = 0;
    instArr[po + 17] = 0;
    instArr[po + 18] = 0;
    instArr[po + 19] = 0;
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
