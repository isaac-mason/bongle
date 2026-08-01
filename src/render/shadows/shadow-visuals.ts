// ShadowVisuals, instanced renderer for ShadowCasterTrait.
// Material lives engine-global on `ShadowResources`. This per-room
// struct owns the geometry, per-instance vertex buffer (instanced attributes), and a
// swap-and-pop slot allocator that keeps the buffer's [0, head) prefix
// dense and visible.
//
// Architecture mirrors SpriteVisuals, shared 1×1 PlaneGeometry, one
// per-room vertex buffer carrying pose, one Mesh in the scene drawn
// with `mesh.count = head` instances.
//
// What it skips vs. SpriteVisuals: no atlas/material buffer, no
// flipbook, no voxel-light sampling, no anchor mode (always centered
// on the ground hit point), no orientation modes (always world-XZ
// flat).
//
// Visibility flow per frame, per ShadowCasterTrait (casters are few, so the
// down-ray is the only gate, no frustum check):
//   1. fetch the node's world-space position from TransformTrait
//   2. raycastVoxels straight down to trait.maxDistance; visible iff
//      top-face hit (ny > 0.5)
//   3. visible+no slot → alloc + write; visible+slot → write;
//      not visible+slot → free (swap-pop)

import type { Camera, Scene } from 'gpucat';
import { ShadowCasterTrait } from '../../builtins/shadow-caster';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import { createVoxelRaycastResult, raycastVoxels } from '../../core/voxels/voxel-raycast';
import type { Voxels } from '../../core/voxels/voxels';
import { growShadowBatch, resetShadowBatch, SHADOW_INSTANCE_STRIDE, type ShadowBatch } from './shadow-resources';

type ShadowQuery = ReturnType<typeof query<[typeof ShadowCasterTrait, typeof TransformTrait]>>;

// small Y bump so the shadow sits above the voxel top face without
// z-fighting. units = world units.
const GROUND_EPSILON = 0.005;

// CPU-side dword offsets inside one ShadowInstance slot.
const F_GROUND_X = 0;
const F_GROUND_Y = 1;
const F_GROUND_Z = 2;
const F_RADIUS = 3;

// ── types ───────────────────────────────────────────────────────────

export type ShadowVisualState = {
    /** -1 when the caster is currently invisible (no slot held). */
    slot: number;
    trait: ShadowCasterTrait;
    lastSeenFrame: number;
};

export type ShadowVisuals = {
    /** this room's live casters; per-frame loop reads ShadowCasterTrait._state
     *  directly. Each state's `slot` indexes the client-global batch. */
    aliveStates: ShadowVisualState[];
    /** bound to THIS room's sceneTree. */
    _query: ShadowQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room shadow visuals: ready the client-global instance batch (reset
 * its dense head + slot ownership; buffer untouched) and mount its Mesh into
 * this room's scene. The batch — plane Mesh, per-instance buffer — is owned by
 * `ShadowResources` and survives room swaps; only this room's use of it
 * (alive-states, scene-tree query) lives here.
 */
export function init(batch: ShadowBatch, scene: Scene, sceneTree: SceneTree): ShadowVisuals {
    resetShadowBatch(batch);
    scene.add(batch.mesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [ShadowCasterTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

const _ray = createVoxelRaycastResult();

export function update(visuals: ShadowVisuals, batch: ShadowBatch, voxels: Voxels, _camera: Camera): void {
    const frameId = ++visuals.frameId;

    let instArr = batch.instanceBuf.array as Float32Array;
    let dirty = false;

    const stride4 = SHADOW_INSTANCE_STRIDE / 4;

    for (const [trait, transform] of visuals._query) {
        // State is created on first sight regardless of visibility, it
        // tracks bounds + lastSeenFrame across frames. Slot is allocated
        // lazily when the caster becomes visible.
        let state = trait._state;
        if (state === null) {
            state = { slot: -1, trait, lastSeenFrame: frameId };
            trait._state = state;
            visuals.aliveStates.push(state);
        }
        state.lastSeenFrame = frameId;

        // raycast straight down from the caster's world position.
        const worldMat = getVisualWorldMatrix(transform);
        const ox = worldMat[12]!;
        const oy = worldMat[13]!;
        const oz = worldMat[14]!;
        const maxDist = trait.maxDistance;
        raycastVoxels(_ray, voxels, voxels.registry, ox, oy, oz, 0, -1, 0, maxDist, 0);

        // top-face hits only, sides/bottoms aren't shadow surfaces.
        const isTopHit = _ray.hit && _ray.ny > 0.5;

        if (!isTopHit) {
            if (state.slot !== -1) {
                freeSlot(batch, state);
                dirty = true;
            }
            continue;
        }

        if (state.slot === -1) {
            if (batch.head >= batch.capacity) {
                growShadowBatch(batch, batch.capacity * 2);
                instArr = batch.instanceBuf.array as Float32Array;
            }
            const slot = batch.head++;
            state.slot = slot;
            batch.slotOwner[slot] = state;
        }

        const off = state.slot * stride4;
        instArr[off + F_GROUND_X] = _ray.px;
        instArr[off + F_GROUND_Y] = _ray.py + GROUND_EPSILON;
        instArr[off + F_GROUND_Z] = _ray.pz;
        instArr[off + F_RADIUS] = trait.radius;
        dirty = true;
    }

    // cleanup stale states (caster trait removed or node detached).
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const s = aliveStates[i]!;
        if (s.lastSeenFrame !== frameId) {
            destroyInstance(visuals, batch, s.trait);
            dirty = true;
        }
    }

    batch.mesh.count = batch.head;
    if (dirty) batch.instanceBuf.needsUpdate = true;
}

/**
 * Dispose per-room shadow visuals: release every slot this room holds in the
 * client-global batch (swap-pop out, clear `trait._state`) and detach the batch
 * Mesh from this room's scene. The batch's GPU buffer is NOT freed — it survives
 * for the next room's `init`.
 */
export function dispose(visuals: ShadowVisuals, batch: ShadowBatch): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait);
    visuals.scene.remove(batch.mesh);
}

// ── internals ───────────────────────────────────────────────────────

/** swap-and-pop: move the last live slot into `state.slot`, shrink head. */
function freeSlot(batch: ShadowBatch, state: ShadowVisualState): void {
    const s = state.slot;
    const last = --batch.head;
    if (s !== last) {
        const arr = batch.instanceBuf.array as Float32Array;
        const stride4 = SHADOW_INSTANCE_STRIDE / 4;
        arr.copyWithin(s * stride4, last * stride4, (last + 1) * stride4);
        const moved = batch.slotOwner[last]!;
        moved.slot = s;
        batch.slotOwner[s] = moved;
    }
    batch.slotOwner[last] = null;
    state.slot = -1;
}

function destroyInstance(visuals: ShadowVisuals, batch: ShadowBatch, trait: ShadowCasterTrait): void {
    const state = trait._state;
    if (state === null) return;

    if (state.slot !== -1) freeSlot(batch, state);

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
