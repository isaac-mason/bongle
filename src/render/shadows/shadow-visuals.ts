import type { Camera, Scene } from 'gpucat';
import { ShadowCasterTrait } from '../../builtins/shadow-caster';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import { createVoxelRaycastResult, raycastVoxels } from '../../core/voxels/voxel-raycast';
import type { Voxels } from '../../core/voxels/voxels';
import { growShadowBatch, resetShadowBatch, SHADOW_INSTANCE_STRIDE, type ShadowBatch } from './shadow-resources';

type ShadowQuery = ReturnType<typeof query<[typeof ShadowCasterTrait, typeof TransformTrait]>>;

// World-unit Y bump so the shadow sits above the voxel top face without z-fighting.
const GROUND_EPSILON = 0.005;

// Dword offsets inside one ShadowInstance slot.
const F_GROUND_X = 0;
const F_GROUND_Y = 1;
const F_GROUND_Z = 2;
const F_RADIUS = 3;

export type ShadowVisualState = {
    /** -1 when the caster is currently invisible (no slot held). */
    slot: number;
    trait: ShadowCasterTrait;
    lastSeenFrame: number;
};

export type ShadowVisuals = {
    /** This room's live casters; each state's `slot` indexes the client-global batch. */
    aliveStates: ShadowVisualState[];
    _query: ShadowQuery;
    frameId: number;
    /** This room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

/** Resets the client-global batch's dense head + slot ownership (buffer untouched) and mounts its Mesh into this room's scene. */
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

const _ray = createVoxelRaycastResult();

export function update(visuals: ShadowVisuals, batch: ShadowBatch, voxels: Voxels, _camera: Camera): void {
    const frameId = ++visuals.frameId;

    let instArr = batch.instanceBuf.array as Float32Array;
    let dirty = false;

    const stride4 = SHADOW_INSTANCE_STRIDE / 4;

    for (const [trait, transform] of visuals._query) {
        // Slot is allocated lazily when the caster becomes visible.
        let state = trait._state;
        if (state === null) {
            state = { slot: -1, trait, lastSeenFrame: frameId };
            trait._state = state;
            visuals.aliveStates.push(state);
        }
        state.lastSeenFrame = frameId;

        const worldMat = getVisualWorldMatrix(transform);
        const ox = worldMat[12]!;
        const oy = worldMat[13]!;
        const oz = worldMat[14]!;
        const maxDist = trait.maxDistance;
        raycastVoxels(_ray, voxels, voxels.registry, ox, oy, oz, 0, -1, 0, maxDist, 0);

        // Only top-face hits count, sides/bottoms aren't shadow surfaces.
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

    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const s = aliveStates[i]!;
        if (s.lastSeenFrame !== frameId) {
            destroyInstance(visuals, batch, s.trait);
            dirty = true;
        }
    }

    batch.mesh.count = batch.head;
    // Uploads only the dense [0, head) prefix, not the whole capacity allocation.
    if (dirty) {
        batch.instanceBuf.addUpdateRange(0, batch.head * stride4);
        batch.instanceBuf.needsUpdate = true;
    }
}

/** Releases every slot this room holds in the client-global batch and detaches the batch Mesh from this room's scene. The GPU buffer survives for the next room's `init`. */
export function dispose(visuals: ShadowVisuals, batch: ShadowBatch): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait);
    visuals.scene.remove(batch.mesh);
}

/** Swap-and-pop: moves the last live slot into `state.slot`, shrinks head. */
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
