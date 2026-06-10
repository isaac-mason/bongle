// ShadowVisuals — instanced renderer for ShadowCasterTrait.
// Material lives engine-global on `ShadowResources`. This per-room
// struct owns the geometry, per-instance storage buffer, and a
// swap-and-pop slot allocator that keeps the buffer's [0, head) prefix
// dense and visible.
//
// Architecture mirrors SpriteVisuals — shared 1×1 PlaneGeometry, one
// per-room storage buffer carrying pose, one Mesh in the scene drawn
// with `mesh.count = head` instances.
//
// What it skips vs. SpriteVisuals: no atlas/material buffer, no
// flipbook, no voxel-light sampling, no anchor mode (always centered
// on the ground hit point), no orientation modes (always world-XZ
// flat).
//
// Visibility flow per frame, per ShadowCasterTrait (casters are few, so the
// down-ray is the only gate — no frustum check):
//   1. fetch the node's world-space position from TransformTrait
//   2. raycastVoxels straight down to trait.maxDistance; visible iff
//      top-face hit (ny > 0.5)
//   3. visible+no slot → alloc + write; visible+slot → write;
//      not visible+slot → free (swap-pop)

import {
    type Camera,
    createPlaneGeometry,
    d,
    type Geometry,
    GpuBuffer,
    Mesh,
    type Scene,
} from 'gpucat';
import { ShadowCasterTrait } from '../../builtins/shadow-caster';
import { TransformTrait } from '../../builtins/transform';
import { type Nodes, query } from '../../core/scene/nodes';
import { getVisualWorldMatrix } from '../../builtins/transform';
import { createVoxelRaycastResult, raycastVoxels } from '../../core/voxels/voxel-raycast';
import type { Voxels } from '../../core/voxels/voxels';
import {
    SHADOW_INSTANCE_STRIDE,
    ShadowInstance,
    type ShadowResources,
} from './shadow-resources';

type GpuBufferType = GpuBuffer<any>;

type ShadowQuery = ReturnType<typeof query<[typeof ShadowCasterTrait, typeof TransformTrait]>>;

const INITIAL_INSTANCE_CAPACITY = 64;

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
    mesh: Mesh;
    geometry: Geometry;

    instanceBuf: GpuBufferType;

    /** dense alive prefix [0, head) of `instanceBuf`. */
    head: number;
    capacity: number;
    /** parallel to instanceBuf: which state owns slot i (null for free). */
    slotOwner: (ShadowVisualState | null)[];

    aliveStates: ShadowVisualState[];

    _query: ShadowQuery;

    frameId: number;

    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

export function init(scene: Scene, nodes: Nodes, resources: ShadowResources): ShadowVisuals {
    const capacity = INITIAL_INSTANCE_CAPACITY;

    // Shared 1×1 plane geometry — positions in [-0.5..0.5] × [-0.5..0.5].
    // The vertex shader interprets aPosition.xy as offsets in the world
    // XZ plane (Y comes straight from groundPos).
    const geometry = createPlaneGeometry(1, 1);

    const instanceBuf = new GpuBuffer(d.array(ShadowInstance), {
        data: new Float32Array((capacity * SHADOW_INSTANCE_STRIDE) / 4),
        usage: 'storage',
    });

    // route per-room storage buffer to the engine-global material by name.
    geometry.setBuffer('instance', instanceBuf);

    const mesh = new Mesh(geometry, resources.material);
    mesh.name = 'shadow-visuals';
    mesh.frustumCulled = false;
    // Mesh.count defaults to 1 — override so the first frame before
    // update() runs draws nothing instead of one garbage instance.
    mesh.count = 0;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        instanceBuf,
        head: 0,
        capacity,
        slotOwner: new Array(capacity).fill(null),
        aliveStates: [],
        _query: query(nodes, [ShadowCasterTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

const _ray = createVoxelRaycastResult();

export function update(visuals: ShadowVisuals, voxels: Voxels, _camera: Camera): void {
    const frameId = ++visuals.frameId;

    let instArr = visuals.instanceBuf.array as Float32Array;
    let dirty = false;

    const stride4 = SHADOW_INSTANCE_STRIDE / 4;

    for (const [trait, transform] of visuals._query) {
        // State is created on first sight regardless of visibility — it
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

        // top-face hits only — sides/bottoms aren't shadow surfaces.
        const isTopHit = _ray.hit && _ray.ny > 0.5;

        if (!isTopHit) {
            if (state.slot !== -1) {
                freeSlot(visuals, state);
                dirty = true;
            }
            continue;
        }

        if (state.slot === -1) {
            if (visuals.head >= visuals.capacity) {
                growInstanceBuffers(visuals, visuals.capacity * 2);
                instArr = visuals.instanceBuf.array as Float32Array;
            }
            const slot = visuals.head++;
            state.slot = slot;
            visuals.slotOwner[slot] = state;
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
            destroyInstance(visuals, s.trait);
            dirty = true;
        }
    }

    visuals.mesh.count = visuals.head;
    if (dirty) visuals.instanceBuf.needsUpdate = true;
}

export function dispose(visuals: ShadowVisuals): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, arr[i]!.trait);
    visuals.scene.remove(visuals.mesh);
    visuals.geometry.dispose();
    visuals.instanceBuf.dispose();
}

// ── internals ───────────────────────────────────────────────────────

/** swap-and-pop: move the last live slot into `state.slot`, shrink head. */
function freeSlot(visuals: ShadowVisuals, state: ShadowVisualState): void {
    const s = state.slot;
    const last = --visuals.head;
    if (s !== last) {
        const arr = visuals.instanceBuf.array as Float32Array;
        const stride4 = SHADOW_INSTANCE_STRIDE / 4;
        arr.copyWithin(s * stride4, last * stride4, (last + 1) * stride4);
        const moved = visuals.slotOwner[last]!;
        moved.slot = s;
        visuals.slotOwner[s] = moved;
    }
    visuals.slotOwner[last] = null;
    state.slot = -1;
}

function destroyInstance(visuals: ShadowVisuals, trait: ShadowCasterTrait): void {
    const state = trait._state;
    if (state === null) return;

    if (state.slot !== -1) freeSlot(visuals, state);

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

// ── buffer growth ───────────────────────────────────────────────────

function growInstanceBuffers(visuals: ShadowVisuals, newCapacity: number): void {
    const oldArr = visuals.instanceBuf.array as Float32Array;
    const floats = (newCapacity * SHADOW_INSTANCE_STRIDE) / 4;
    const newArr = new Float32Array(floats);
    newArr.set(oldArr.subarray(0, Math.min(oldArr.length, floats)));
    const newBuf = new GpuBuffer(d.array(ShadowInstance), { data: newArr, usage: 'storage' });
    visuals.geometry.setBuffer('instance', newBuf);
    visuals.instanceBuf.dispose();
    visuals.instanceBuf = newBuf;

    visuals.slotOwner.length = newCapacity;
    for (let i = visuals.capacity; i < newCapacity; i++) visuals.slotOwner[i] = null;
    visuals.capacity = newCapacity;
}
