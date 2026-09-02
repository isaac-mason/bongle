// per-room frustum culler over the `dbvt` broadphase; owns one `CullState` per renderable.

import { type Camera, type Frustum, frustum } from 'gpucat';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../../api/transforms';
import type { TransformTrait } from '../../builtins/transform';
import * as dbvt from './dbvt';

/** per-renderable cull handle. Renderers read `visible` / `distSq` / `extentSq`; the rest is the culler's. */
export type CullState = {
    visible: boolean;
    distSq: number;
    extentSq: number;
    /** local-space AABB, copied from the box passed to `add`. */
    aabb: Box3;
    /** `aabb × transform.world`, tight (the tree's leaf carries it inflated by the broadphase margin). */
    worldAabb: Box3;
    /** -1 when unregistered. */
    leaf: number;
    /** prev-frame `visible`, for distance-cull hysteresis. */
    wasVisible: boolean;
};

function createCullState(): CullState {
    return {
        visible: true,
        distSq: 0,
        extentSq: 0,
        aabb: box3.create(),
        worldAabb: box3.create(),
        leaf: -1,
        wasVisible: false,
    };
}

export type Visibility = {
    tree: dbvt.Dbvt;
    frustum: Frustum;
    /** dense; a tree leaf's `data` is the entry's index here. */
    entries: CullState[];
    transforms: TransformTrait[];
    /** parallel to `entries`: `transform._version` as last folded into the leaf. */
    versions: number[];
};

export function init(): Visibility {
    return {
        tree: dbvt.create(),
        frustum: frustum.create(),
        entries: [],
        transforms: [],
        versions: [],
    };
}

/** how far past `viewRadius` a previously-visible leaf stays visible (block units). */
const VIEW_RADIUS_MARGIN = 16;

function isEmptyAabb(b: Box3): boolean {
    return b[0] > b[3] || b[1] > b[4] || b[2] > b[5];
}

/** register a renderable; an empty box returns an unregistered, visible-by-default handle. */
export function add(v: Visibility, aabb: Box3, transform: TransformTrait): CullState {
    const cull = createCullState();
    box3.copy(cull.aabb, aabb);
    if (isEmptyAabb(cull.aabb)) return cull;
    box3.transformMat4(cull.worldAabb, cull.aabb, getVisualWorldMatrix(transform));
    cull.leaf = dbvt.add(v.tree, cull.worldAabb, v.entries.length);
    v.entries.push(cull);
    v.transforms.push(transform);
    v.versions.push(transform._version);
    return cull;
}

/** unregister an entry and free its leaf. */
export function remove(v: Visibility, cull: CullState): void {
    if (cull.leaf === -1) return;
    const slot = dbvt.remove(v.tree, cull.leaf);
    cull.leaf = -1;

    const moved = v.entries.pop()!;
    const movedTransform = v.transforms.pop()!;
    const movedVersion = v.versions.pop()!;
    if (moved !== cull) {
        v.entries[slot] = moved;
        v.transforms[slot] = movedTransform;
        v.versions[slot] = movedVersion;
        dbvt.setData(v.tree, moved.leaf, slot);
    }
}

/** refit moved leaves, reset every `visible`, then frustum + distance cull. */
export function update(v: Visibility, camera: Camera, viewRadius: number): void {
    const entries = v.entries;
    const transforms = v.transforms;
    const versions = v.versions;
    const count = entries.length;

    for (let i = 0; i < count; i++) {
        const transform = transforms[i]!;
        const version = transform._version;
        if (version === versions[i]) continue;
        versions[i] = version;
        const cull = entries[i]!;
        box3.transformMat4(cull.worldAabb, cull.aabb, getVisualWorldMatrix(transform));
        dbvt.update(v.tree, cull.leaf, cull.worldAabb);
    }

    for (let i = 0; i < count; i++) {
        const cull = entries[i]!;
        cull.wasVisible = cull.visible;
        cull.visible = false;
    }

    // WebGL and WebGPU extract the near plane differently; omitting the convention culls half the view.
    frustum.setFromViewProjectionMatrix(v.frustum, camera.projectionMatrix, camera.matrixWorldInverse, camera.coordinateSystem);
    const camX = camera.position[0];
    const camY = camera.position[1];
    const camZ = camera.position[2];
    _activeEntries = entries;
    _activeCamX = camX;
    _activeCamY = camY;
    _activeCamZ = camZ;
    _activeInnerSq = viewRadius * viewRadius;
    const outer = viewRadius + VIEW_RADIUS_MARGIN;
    _activeOuterSq = outer * outer;
    dbvt.frustumCull(v.tree, v.frustum, camX, camY, camZ, _activeOuterSq, _onVisibleLeaf);
    _activeEntries = EMPTY;
}

const EMPTY: CullState[] = [];
let _activeEntries: CullState[] = EMPTY;
let _activeCamX = 0;
let _activeCamY = 0;
let _activeCamZ = 0;
let _activeInnerSq = Infinity;
let _activeOuterSq = Infinity;

function _onVisibleLeaf(slot: number): void {
    const cull = _activeEntries[slot]!;
    const aabb = cull.worldAabb;

    const dx = (aabb[0] + aabb[3]) * 0.5 - _activeCamX;
    const dy = (aabb[1] + aabb[4]) * 0.5 - _activeCamY;
    const dz = (aabb[2] + aabb[5]) * 0.5 - _activeCamZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const limit = cull.wasVisible ? _activeOuterSq : _activeInnerSq;
    if (distSq > limit) return;

    cull.visible = true;
    cull.distSq = distSq;
    const ex = aabb[3] - aabb[0];
    const ey = aabb[4] - aabb[1];
    const ez = aabb[5] - aabb[2];
    cull.extentSq = ex * ex + ey * ey + ez * ez;
}
