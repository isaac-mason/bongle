// per-room visibility — a generic frustum culler over a dynamic bounding
// volume tree. It knows nothing about meshes, sprites, or any trait: callers
// `register(cull, transform)` an entry, `unregister(cull)` it, and each frame
// `update(camera, viewRadius)` refits every entry and writes the cull result
// back into its `cull` object.
//
// An entry is a `CullState` (see core/scene/cull.ts) plus the `TransformTrait`
// whose world matrix places it. The owning renderer keeps the `CullState` on
// its own render-state object (`MeshVisualState.cull`, `SpriteVisualState.cull`,
// …), fills `cull.aabb` (local) from geometry it already knows, and registers
// it. The culler owns the DBVT leaf and writes `cull.visible / distSq /
// extentSq` each frame — so consumers (the renderers themselves, the animator
// gate/LOD, model lighting) just read `cull` with no reference to the culler.
//
// The culler holds the `TransformTrait` ref directly, so it recomputes the
// world AABB itself at cull time (`cull.aabb × transform.world`) — fresh, no
// frame lag. Refit triggers on a `cull.version` (geometry changed) or
// `transform._version` (moved) bump. Lifecycle is explicit: a leaf exists
// from `register` to `unregister`, so there's no per-frame trait sweep.
//
// The DBVT is a port of crashcat's broadphase, stripped to visibility-only:
// fat-aabb expansion margin, freelist node pool, insert / remove / update
// with fat-aabb containment skip, ancestor refit, opath rotation. Dropped:
// collision filter / groups / mask, raycast and shape-cast helpers,
// `world` parameter, previousAabb / velocity prediction. `intersectAABB`
// is replaced by `frustumCull` which prunes internal subtrees via the
// 6-plane frustum test.

import { type Camera, type Frustum, frustum } from 'gpucat';
import { type Box3, box3 } from 'mathcat';
import type { TransformTrait } from '../builtins/transform';
import { getVisualWorldMatrix } from '../api/transforms';
import type { CullState } from '../core/scene/cull';

// ── DBVT internals ───────────────────────────────────────────────────────

type DBVTNode = {
    index: number;
    parent: number;
    left: number;
    right: number;
    aabb: Box3;
    height: number;
};

type DBVT = {
    nodes: DBVTNode[];
    freeNodeIndices: number[];
    root: number;
    /** added to every leaf aabb on insert; lets `dbvtUpdate` skip refit
     *  while the body still fits inside its fat aabb. */
    expansionMargin: number;
    /** rolling bit cursor for `optimizeIncremental` opath rotation. */
    optimizationPath: number;
};

type Stack = { entries: Int32Array; size: number };

function stackCreate(initialCapacity = 128): Stack {
    return { entries: new Int32Array(initialCapacity), size: 0 };
}

function stackPush(s: Stack, nodeIndex: number): void {
    if (s.size >= s.entries.length) {
        const grown = new Int32Array(s.entries.length * 2);
        grown.set(s.entries);
        s.entries = grown;
    }
    s.entries[s.size++] = nodeIndex;
}

function stackPop(s: Stack): number {
    return s.entries[--s.size];
}

function stackReset(s: Stack): void {
    s.size = 0;
}

const _stack = /* @__PURE__ */ stackCreate(128);

function dbvtCreate(): DBVT {
    return {
        nodes: [],
        freeNodeIndices: [],
        root: -1,
        expansionMargin: 0.05,
        optimizationPath: 0,
    };
}

function requestNode(bvh: DBVT): number {
    let nodeIndex: number;
    if (bvh.freeNodeIndices.length > 0) {
        nodeIndex = bvh.freeNodeIndices.pop()!;
        const node = bvh.nodes[nodeIndex];
        node.parent = -1;
        node.left = -1;
        node.right = -1;
        box3.empty(node.aabb);
        node.height = 0;
    } else {
        nodeIndex = bvh.nodes.length;
        bvh.nodes.push({
            index: nodeIndex,
            parent: -1,
            left: -1,
            right: -1,
            aabb: box3.create(),
            height: 0,
        });
    }
    return nodeIndex;
}

function releaseNode(bvh: DBVT, nodeIndex: number): void {
    const node = bvh.nodes[nodeIndex];
    node.parent = -1;
    node.left = -1;
    node.right = -1;
    bvh.freeNodeIndices.push(nodeIndex);
}

function isLeaf(node: DBVTNode): boolean {
    return node.left === -1 && node.right === -1;
}

function proximity(a: Box3, b: Box3): number {
    const dx = a[0] + a[3] - (b[0] + b[3]);
    const dy = a[1] + a[4] - (b[1] + b[4]);
    const dz = a[2] + a[5] - (b[2] + b[5]);
    return Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
}

function select(o: Box3, a: Box3, b: Box3): number {
    return proximity(o, a) < proximity(o, b) ? 0 : 1;
}

function indexof(dbvt: DBVT, nodeIndex: number): number {
    const node = dbvt.nodes[nodeIndex];
    const parent = dbvt.nodes[node.parent];
    return parent.right === nodeIndex ? 1 : 0;
}

function insertLeaf(dbvt: DBVT, rootIndex: number, leafIndex: number): void {
    const leaf = dbvt.nodes[leafIndex];

    if (dbvt.root === -1) {
        dbvt.root = leafIndex;
        leaf.parent = -1;
        return;
    }

    let cur = rootIndex;
    let curNode = dbvt.nodes[cur];
    while (!isLeaf(curNode)) {
        const leftNode = dbvt.nodes[curNode.left];
        const rightNode = dbvt.nodes[curNode.right];
        const child = select(leaf.aabb, leftNode.aabb, rightNode.aabb);
        cur = child === 0 ? curNode.left : curNode.right;
        curNode = dbvt.nodes[cur];
    }

    const prev = curNode.parent;
    const newParentIndex = requestNode(dbvt);
    const newParent = dbvt.nodes[newParentIndex];

    newParent.parent = prev;
    box3.union(newParent.aabb, leaf.aabb, curNode.aabb);
    newParent.height = curNode.height + 1;

    if (prev !== -1) {
        const prevNode = dbvt.nodes[prev];
        if (indexof(dbvt, cur) === 0) {
            prevNode.left = newParentIndex;
        } else {
            prevNode.right = newParentIndex;
        }
        newParent.left = cur;
        curNode.parent = newParentIndex;
        newParent.right = leafIndex;
        leaf.parent = newParentIndex;

        let childNode = newParent;
        let parentIndex = prev;
        while (parentIndex !== -1) {
            const parentNode = dbvt.nodes[parentIndex];
            if (!box3.containsBox3(parentNode.aabb, childNode.aabb)) {
                const leftNode = dbvt.nodes[parentNode.left];
                const rightNode = dbvt.nodes[parentNode.right];
                box3.union(parentNode.aabb, leftNode.aabb, rightNode.aabb);
            } else {
                break;
            }
            childNode = parentNode;
            parentIndex = parentNode.parent;
        }
    } else {
        newParent.left = cur;
        curNode.parent = newParentIndex;
        newParent.right = leafIndex;
        leaf.parent = newParentIndex;
        dbvt.root = newParentIndex;
    }
}

const _prevAabb = /* @__PURE__ */ box3.create();

function removeLeaf(dbvt: DBVT, leafIndex: number): number {
    if (leafIndex === dbvt.root) {
        dbvt.root = -1;
        return -1;
    }

    const leaf = dbvt.nodes[leafIndex];
    const parentIndex = leaf.parent;
    const parent = dbvt.nodes[parentIndex];
    const prevIndex = parent.parent;
    const siblingIndex = parent.left === leafIndex ? parent.right : parent.left;
    const sibling = dbvt.nodes[siblingIndex];

    if (prevIndex !== -1) {
        const prev = dbvt.nodes[prevIndex];
        if (indexof(dbvt, parentIndex) === 0) {
            prev.left = siblingIndex;
        } else {
            prev.right = siblingIndex;
        }
        sibling.parent = prevIndex;
        releaseNode(dbvt, parentIndex);

        let nodeIndex = prevIndex;
        while (nodeIndex !== -1) {
            const node = dbvt.nodes[nodeIndex];
            box3.copy(_prevAabb, node.aabb);

            const leftNode = dbvt.nodes[node.left];
            const rightNode = dbvt.nodes[node.right];
            box3.union(node.aabb, leftNode.aabb, rightNode.aabb);

            if (!box3.exactEquals(node.aabb, _prevAabb)) {
                nodeIndex = node.parent;
            } else {
                break;
            }
        }

        return prevIndex;
    } else {
        dbvt.root = siblingIndex;
        sibling.parent = -1;
        releaseNode(dbvt, parentIndex);
        return dbvt.root;
    }
}

const _bounds = /* @__PURE__ */ box3.create();

function dbvtAdd(dbvt: DBVT, aabb: Box3): number {
    box3.expandByMargin(_bounds, aabb, dbvt.expansionMargin);

    const leafIndex = requestNode(dbvt);
    const leaf = dbvt.nodes[leafIndex];
    box3.copy(leaf.aabb, _bounds);
    leaf.height = 0;

    insertLeaf(dbvt, dbvt.root, leafIndex);
    return leafIndex;
}

function dbvtRemove(dbvt: DBVT, leafIndex: number): void {
    if (leafIndex < 0 || leafIndex >= dbvt.nodes.length) return;
    removeLeaf(dbvt, leafIndex);
    releaseNode(dbvt, leafIndex);
}

/**
 * refresh a leaf to a new tight aabb. fast path: if the new aabb still
 * fits inside the leaf's fat aabb, no tree mutation happens. otherwise
 * the leaf is removed and reinserted from the tree root (lookahead -1
 * semantics; we don't expose lookahead tuning here).
 */
function dbvtUpdate(dbvt: DBVT, leafIndex: number, aabb: Box3): void {
    const leaf = dbvt.nodes[leafIndex];
    if (box3.containsBox3(leaf.aabb, aabb)) return;

    box3.expandByMargin(_bounds, aabb, dbvt.expansionMargin);

    const rootIndex = removeLeaf(dbvt, leafIndex);
    box3.copy(leaf.aabb, _bounds);
    insertLeaf(dbvt, rootIndex === -1 ? dbvt.root : rootIndex, leafIndex);
}

function dbvtFrustumCull(dbvt: DBVT, f: Frustum, onLeaf: (leafIndex: number) => void): void {
    if (dbvt.root === -1) return;

    stackReset(_stack);
    stackPush(_stack, dbvt.root);

    while (_stack.size > 0) {
        const nodeIndex = stackPop(_stack);
        const node = dbvt.nodes[nodeIndex];

        if (!frustum.intersectsBox3(f, node.aabb)) continue;

        if (isLeaf(node)) {
            onLeaf(nodeIndex);
            continue;
        }

        if (node.left !== -1) stackPush(_stack, node.left);
        if (node.right !== -1) stackPush(_stack, node.right);
    }
}

// ── public Visibility surface ────────────────────────────────────────────

export type Visibility = {
    dbvt: DBVT;
    /** scratch frustum, rebuilt each `update`. */
    frustum: Frustum;
    /**
     * Registered cull entries indexed by DBVT leaf index (sparse — slot is
     * null between `unregister` and the leaf index being reused).
     */
    cullables: (CullState | null)[];
    /** the `TransformTrait` placing each entry, parallel to `please cullables`.
     *  the culler reads `transform.world` each frame to refit the leaf. */
    transforms: (TransformTrait | null)[];
    /** per-leaf versions last folded into the leaf's world AABB. */
    aabbVersions: number[];
    transformVersions: number[];
    /** prev-frame `visible` bit per leaf — feeds hysteresis on the
     *  distance cull so leaves crossing the radius boundary don't flicker. */
    wasVisible: Uint8Array;
};

export function init(): Visibility {
    return {
        dbvt: dbvtCreate(),
        frustum: frustum.create(),
        cullables: [],
        transforms: [],
        aabbVersions: [],
        transformVersions: [],
        wasVisible: new Uint8Array(0),
    };
}

/** how far past `viewRadius` a leaf that was visible last frame stays
 *  visible (block units). Mirrors the server's `VIEW_RADIUS_MARGIN` —
 *  small enough to be invisible to the player, big enough to absorb
 *  per-frame motion across the radius boundary. */
const VIEW_RADIUS_MARGIN = 16;

const _scratchWorldAabb: Box3 = box3.create();

function isEmptyAabb(b: Box3): boolean {
    return b[0] > b[3] || b[1] > b[4] || b[2] > b[5];
}

function ensureLeafArrays(v: Visibility, leaf: number): void {
    while (v.cullables.length <= leaf) {
        v.cullables.push(null);
        v.transforms.push(null);
        v.aabbVersions.push(0);
        v.transformVersions.push(0);
    }
}

/**
 * Register a cull entry. The owning renderer must have filled `cull.aabb`
 * (local) before calling — the leaf is seeded from `cull.aabb ×
 * transform.world`. No-op (leaves it unregistered + visible) if the box is
 * still empty. Pair with `unregister` when the render-state is freed.
 */
export function register(v: Visibility, cull: CullState, transform: TransformTrait): void {
    if (cull.leaf !== -1) return;
    if (isEmptyAabb(cull.aabb)) return;
    box3.transformMat4(_scratchWorldAabb, cull.aabb, getVisualWorldMatrix(transform));
    const leaf = dbvtAdd(v.dbvt, _scratchWorldAabb);
    cull.leaf = leaf;
    ensureLeafArrays(v, leaf);
    v.cullables[leaf] = cull;
    v.transforms[leaf] = transform;
    v.aabbVersions[leaf] = cull.version;
    v.transformVersions[leaf] = transform._version;
}

/** Remove a previously-registered entry and free its leaf. Resets
 *  `cull.leaf` to -1 so the entry can be re-registered later. */
export function unregister(v: Visibility, cull: CullState): void {
    const leaf = cull.leaf;
    if (leaf === -1) return;
    dbvtRemove(v.dbvt, leaf);
    v.cullables[leaf] = null;
    v.transforms[leaf] = null;
    cull.leaf = -1;
}

/**
 * Per-frame pass:
 *   1. refit each registered leaf whose `cull.version` (geometry changed)
 *      or `transform._version` (moved) bumped since last folded in. World
 *      AABB = `cull.aabb × transform.world`, recomputed here so it's fresh.
 *   2. snapshot prev `visible` per leaf, then reset every entry's
 *      `cull.visible = false`.
 *   3. frustum-cull the DBVT; for each in-frustum leaf, additionally
 *      reject if its world-AABB center is past `viewRadius` (with
 *      `VIEW_RADIUS_MARGIN` hysteresis vs the prev-frame bit). Flip
 *      `cull.visible = true` on survivors and stash `distSq`/`extentSq`.
 *
 * `viewRadius` is block-space. Conventionally the renderer's voxel chunk
 * view radius (× CHUNK_SIZE) drives this so visuals fade at the same
 * boundary the chunk mesher uses. Tests may pass `Infinity` to isolate
 * frustum-only behavior.
 */
export function update(v: Visibility, camera: Camera, viewRadius: number): void {
    // ── refit moved / resized leaves ────────────────────────────────
    for (let i = 0; i < v.cullables.length; i++) {
        const cull = v.cullables[i];
        if (cull === null) continue;
        const transform = v.transforms[i]!;
        const aabbDirty = cull.version !== v.aabbVersions[i];
        const transformDirty = transform._version !== v.transformVersions[i];
        if (aabbDirty || transformDirty) {
            box3.transformMat4(_scratchWorldAabb, cull.aabb, getVisualWorldMatrix(transform));
            dbvtUpdate(v.dbvt, i, _scratchWorldAabb);
            v.aabbVersions[i] = cull.version;
            v.transformVersions[i] = transform._version;
        }
    }

    // ── snapshot prev `visible` (for distance hysteresis), then reset ──
    if (v.wasVisible.length < v.cullables.length) {
        const grown = new Uint8Array(v.cullables.length);
        grown.set(v.wasVisible);
        v.wasVisible = grown;
    }
    for (let i = 0; i < v.cullables.length; i++) {
        const cs = v.cullables[i];
        if (cs === null) {
            v.wasVisible[i] = 0;
            continue;
        }
        v.wasVisible[i] = cs.visible ? 1 : 0;
        cs.visible = false;
    }

    // ── frustum + distance cull ────────────────────────────────────
    frustum.setFromViewProjectionMatrix(v.frustum, camera.projectionMatrix, camera.matrixWorldInverse);
    _activeVisibility = v;
    _activeCamX = camera.position[0];
    _activeCamY = camera.position[1];
    _activeCamZ = camera.position[2];
    _activeInnerSq = viewRadius * viewRadius;
    const outer = viewRadius + VIEW_RADIUS_MARGIN;
    _activeOuterSq = outer * outer;
    dbvtFrustumCull(v.dbvt, v.frustum, _onVisibleLeaf);
    _activeVisibility = null;
}

let _activeVisibility: Visibility | null = null;
let _activeCamX = 0;
let _activeCamY = 0;
let _activeCamZ = 0;
let _activeInnerSq = Infinity;
let _activeOuterSq = Infinity;

function _onVisibleLeaf(leafIndex: number): void {
    const v = _activeVisibility!;
    const cs = v.cullables[leafIndex];
    if (cs === null) return;

    // distance cull with hysteresis: leaves that were visible last
    // frame keep visibility out to `outer` (= viewRadius + margin);
    // fresh leaves must be inside `inner` (= viewRadius). prevents
    // flicker for things sitting near the boundary that a script or
    // animation nudges across.
    const aabb = v.dbvt.nodes[leafIndex].aabb;
    const dx = (aabb[0] + aabb[3]) * 0.5 - _activeCamX;
    const dy = (aabb[1] + aabb[4]) * 0.5 - _activeCamY;
    const dz = (aabb[2] + aabb[5]) * 0.5 - _activeCamZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const limit = v.wasVisible[leafIndex] ? _activeOuterSq : _activeInnerSq;
    if (distSq > limit) return;

    cs.visible = true;
    // stash coverage inputs for animation LOD (and any future consumer
    // ranking by projected size). world-space extent² ÷ distSq is monotonic
    // with projected pixel size for a given fov — no sqrt, no projection.
    cs.distSq = distSq;
    const ex = aabb[3] - aabb[0];
    const ey = aabb[4] - aabb[1];
    const ez = aabb[5] - aabb[2];
    cs.extentSq = ex * ex + ey * ey + ez * ez;
}
