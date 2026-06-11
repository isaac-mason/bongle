// per-room visibility — the frustum culler. A thin policy layer over the
// generic `dbvt` broadphase tree: it owns the per-renderable `CullState`s,
// refits their world AABBs from their transforms each frame, frustum +
// distance culls, and writes the result back into each `CullState`.
//
// `CullState` is the one object per cullable. The renderer `add`s a local box
// + transform, gets the handle back, keeps it on its own render-state
// (`MeshVisualState.cull`, `SpriteVisualState.cull`, …), reads `visible` /
// `distSq` / `extentSq`, and `remove`s it on destroy. Everything else on the
// struct is the culler's. No traits, no model-level state — a model isn't a
// cullable, its meshes are.
//
// The culler holds the `TransformTrait` ref (on the `CullState`), so it
// recomputes the world AABB itself at cull time — fresh, no frame lag. It
// keeps registered entries in one dense `CullState[]`; the tree leaf's `data`
// payload is the entry's index into that array (fixed up on swap-pop), so the
// frustum callback maps straight back with no sparse leaf-indexed arrays.

import { type Camera, type Frustum, frustum } from 'gpucat';
import { type Box3, box3 } from 'mathcat';
import type { TransformTrait } from '../builtins/transform';
import { getVisualWorldMatrix } from '../api/transforms';
import * as Dbvt from './dbvt';

/**
 * Per-renderable cull handle, returned by `add` and held on the
 * renderer's render-state. The renderer reads only `visible` / `distSq` /
 * `extentSq`; everything else is the culler's. Defaults (before/without a
 * leaf) are "visible", so a freshly-spawned thing renders until the culler
 * has measured it, and server / offline ticks (which run no cull) treat it
 * visible.
 */
export type CullState = {
    /** frustum + distance cull result, written each frame; read by consumers
     *  (renderers, animator gate/LOD, model lighting) to skip off-screen work. */
    visible: boolean;
    /** squared camera distance to the leaf's world-AABB center, written every
     *  frame the leaf is visible. animation LOD input. */
    distSq: number;
    /** squared world-space diagonal extent of the leaf, written alongside
     *  `distSq`. coverage = `extentSq / distSq` (∝ projected pixel size). */
    extentSq: number;

    // ── owned by Visibility (renderers don't touch these) ──
    /** local-space AABB, copied from the box passed to `add`. world AABB =
     *  `aabb × transform.world`, recomputed each frame the transform moves. */
    aabb: Box3;
    /** DBVT leaf index; -1 when unregistered (empty box). */
    leaf: number;
    /** the transform placing this entry; null when unregistered. */
    transform: TransformTrait | null;
    /** `transform._version` last folded into the leaf's world AABB. */
    transformVersion: number;
    /** prev-frame `visible` — feeds distance-cull hysteresis so a leaf near
     *  the radius boundary doesn't flicker. */
    wasVisible: boolean;
};

function createCullState(): CullState {
    return {
        visible: true,
        distSq: 0,
        extentSq: 0,
        aabb: box3.create(),
        leaf: -1,
        transform: null,
        transformVersion: 0,
        wasVisible: false,
    };
}

export type Visibility = {
    tree: Dbvt.Dbvt;
    /** scratch frustum, rebuilt each `update`. */
    frustum: Frustum;
    /** registered entries, dense. the tree leaf's `data` is the entry's index
     *  here, kept in sync on swap-pop. */
    entries: CullState[];
};

export function init(): Visibility {
    return {
        tree: Dbvt.create(),
        frustum: frustum.create(),
        entries: [],
    };
}

/** how far past `viewRadius` a leaf that was visible last frame stays visible
 *  (block units). Mirrors the server's `VIEW_RADIUS_MARGIN` — small enough to
 *  be invisible to the player, big enough to absorb per-frame motion across
 *  the radius boundary. */
const VIEW_RADIUS_MARGIN = 16;

const _scratchWorldAabb: Box3 = box3.create();

function isEmptyAabb(b: Box3): boolean {
    return b[0] > b[3] || b[1] > b[4] || b[2] > b[5];
}

/**
 * Add a renderable's local `aabb` + `transform` and return its cull handle.
 * The leaf is seeded from `aabb × transform.world`. An empty box (the renderer
 * has no geometry yet) returns an unregistered, visible-by-default handle —
 * nothing to cull. Pair with `remove` when the render-state is freed.
 */
export function add(v: Visibility, aabb: Box3, transform: TransformTrait): CullState {
    const cull = createCullState();
    box3.copy(cull.aabb, aabb);
    if (isEmptyAabb(cull.aabb)) return cull;
    box3.transformMat4(_scratchWorldAabb, cull.aabb, getVisualWorldMatrix(transform));
    cull.leaf = Dbvt.add(v.tree, _scratchWorldAabb, v.entries.length);
    cull.transform = transform;
    cull.transformVersion = transform._version;
    v.entries.push(cull);
    return cull;
}

/** Remove a previously-added entry and free its leaf. Resets `cull.leaf` to
 *  -1 so the handle reads as unregistered. */
export function remove(v: Visibility, cull: CullState): void {
    if (cull.leaf === -1) return;
    const slot = Dbvt.remove(v.tree, cull.leaf);
    cull.leaf = -1;
    cull.transform = null;

    // swap-pop the dense entries array: move the tail into the freed slot and
    // point its tree leaf at the new index.
    const moved = v.entries.pop()!;
    if (moved !== cull) {
        v.entries[slot] = moved;
        Dbvt.setData(v.tree, moved.leaf, slot);
    }
}

/**
 * Per-frame pass:
 *   1. refit each entry whose `transform._version` bumped (moved) since last
 *      folded in. World AABB = `cull.aabb × transform.world`, recomputed here.
 *   2. snapshot prev `visible`, then reset every entry's `visible = false`.
 *   3. frustum-cull the tree; for each in-frustum leaf, additionally reject if
 *      its world-AABB center is past `viewRadius` (with `VIEW_RADIUS_MARGIN`
 *      hysteresis vs the prev-frame bit). Flip `visible = true` on survivors
 *      and stash `distSq` / `extentSq`.
 *
 * `viewRadius` is block-space. Conventionally the renderer's voxel chunk view
 * radius (× CHUNK_SIZE) drives this so visuals fade at the same boundary the
 * chunk mesher uses. Tests may pass `Infinity` to isolate frustum-only behavior.
 */
export function update(v: Visibility, camera: Camera, viewRadius: number): void {
    const entries = v.entries;

    // ── refit moved leaves ──────────────────────────────────────────
    for (let i = 0; i < entries.length; i++) {
        const cull = entries[i]!;
        const transform = cull.transform!;
        if (transform._version === cull.transformVersion) continue;
        box3.transformMat4(_scratchWorldAabb, cull.aabb, getVisualWorldMatrix(transform));
        Dbvt.update(v.tree, cull.leaf, _scratchWorldAabb);
        cull.transformVersion = transform._version;
    }

    // ── snapshot prev `visible` (for distance hysteresis), then reset ──
    for (let i = 0; i < entries.length; i++) {
        const cull = entries[i]!;
        cull.wasVisible = cull.visible;
        cull.visible = false;
    }

    // ── frustum + distance cull ─────────────────────────────────────
    frustum.setFromViewProjectionMatrix(v.frustum, camera.projectionMatrix, camera.matrixWorldInverse);
    _activeEntries = entries;
    _activeCamX = camera.position[0];
    _activeCamY = camera.position[1];
    _activeCamZ = camera.position[2];
    _activeInnerSq = viewRadius * viewRadius;
    const outer = viewRadius + VIEW_RADIUS_MARGIN;
    _activeOuterSq = outer * outer;
    Dbvt.frustumCull(v.tree, v.frustum, _onVisibleLeaf);
    _activeEntries = EMPTY;
}

const EMPTY: CullState[] = [];
let _activeEntries: CullState[] = EMPTY;
let _activeCamX = 0;
let _activeCamY = 0;
let _activeCamZ = 0;
let _activeInnerSq = Infinity;
let _activeOuterSq = Infinity;

function _onVisibleLeaf(slot: number, aabb: Box3): void {
    const cull = _activeEntries[slot]!;

    // distance cull with hysteresis: leaves that were visible last frame keep
    // visibility out to `outer` (= viewRadius + margin); fresh leaves must be
    // inside `inner` (= viewRadius). prevents flicker for things a script or
    // animation nudges across the boundary.
    const dx = (aabb[0] + aabb[3]) * 0.5 - _activeCamX;
    const dy = (aabb[1] + aabb[4]) * 0.5 - _activeCamY;
    const dz = (aabb[2] + aabb[5]) * 0.5 - _activeCamZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const limit = cull.wasVisible ? _activeOuterSq : _activeInnerSq;
    if (distSq > limit) return;

    cull.visible = true;
    // coverage inputs for animation LOD (and any future projected-size
    // ranking). world-space extent² ÷ distSq is monotonic with projected
    // pixel size for a given fov — no sqrt, no projection.
    cull.distSq = distSq;
    const ex = aabb[3] - aabb[0];
    const ey = aabb[4] - aabb[1];
    const ez = aabb[5] - aabb[2];
    cull.extentSq = ex * ex + ey * ey + ez * ez;
}
