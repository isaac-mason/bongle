// dynamic bounding-volume tree over fat AABBs. Leaves carry an opaque numeric `data`.
// SAH sibling choice on insert, AVL rebalance to the root on every insert/remove.

import type { Frustum } from 'gpucat';
import { type Box3, box3 } from 'math/shapes';

export type DbvtNode = {
    index: number;
    parent: number;
    left: number;
    right: number;
    aabb: Box3;
    /** longest path down to a leaf; 0 for a leaf. drives the AVL rotation. */
    height: number;
    data: number;
};

export type Dbvt = {
    nodes: DbvtNode[];
    freeNodeIndices: number[];
    root: number;
    /** added to every leaf aabb on insert; lets `update` skip refit while the
     *  body still fits inside its fat aabb. */
    expansionMargin: number;
};

const DEFAULT_EXPANSION_MARGIN = 0.5;

type Stack = { entries: Int32Array; masks: Uint8Array; size: number };

function stackCreate(initialCapacity = 128): Stack {
    return { entries: new Int32Array(initialCapacity), masks: new Uint8Array(initialCapacity), size: 0 };
}

function stackPush(s: Stack, nodeIndex: number, mask: number): void {
    if (s.size >= s.entries.length) {
        const grownEntries = new Int32Array(s.entries.length * 2);
        grownEntries.set(s.entries);
        s.entries = grownEntries;
        const grownMasks = new Uint8Array(s.masks.length * 2);
        grownMasks.set(s.masks);
        s.masks = grownMasks;
    }
    s.entries[s.size] = nodeIndex;
    s.masks[s.size] = mask;
    s.size++;
}

const _stack = /* @__PURE__ */ stackCreate(128);

export function create(): Dbvt {
    return {
        nodes: [],
        freeNodeIndices: [],
        root: -1,
        expansionMargin: DEFAULT_EXPANSION_MARGIN,
    };
}

function requestNode(tree: Dbvt): number {
    let nodeIndex: number;
    if (tree.freeNodeIndices.length > 0) {
        nodeIndex = tree.freeNodeIndices.pop()!;
        const node = tree.nodes[nodeIndex];
        node.parent = -1;
        node.left = -1;
        node.right = -1;
        box3.empty(node.aabb);
        node.height = 0;
        node.data = -1;
    } else {
        nodeIndex = tree.nodes.length;
        tree.nodes.push({
            index: nodeIndex,
            parent: -1,
            left: -1,
            right: -1,
            aabb: box3.create(),
            height: 0,
            data: -1,
        });
    }
    return nodeIndex;
}

function releaseNode(tree: Dbvt, nodeIndex: number): void {
    const node = tree.nodes[nodeIndex];
    node.parent = -1;
    node.left = -1;
    node.right = -1;
    node.data = -1;
    tree.freeNodeIndices.push(nodeIndex);
}

function surfaceArea(b: Box3): number {
    const dx = b[3] - b[0];
    const dy = b[4] - b[1];
    const dz = b[5] - b[2];
    return 2 * (dx * dy + dy * dz + dz * dx);
}

function unionSurfaceArea(a: Box3, b: Box3): number {
    const minX = a[0] < b[0] ? a[0] : b[0];
    const minY = a[1] < b[1] ? a[1] : b[1];
    const minZ = a[2] < b[2] ? a[2] : b[2];
    const maxX = a[3] > b[3] ? a[3] : b[3];
    const maxY = a[4] > b[4] ? a[4] : b[4];
    const maxZ = a[5] > b[5] ? a[5] : b[5];
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    return 2 * (dx * dy + dy * dz + dz * dx);
}

/** AVL rotation around `iA`; returns whichever index now sits where `iA` did. */
function balance(tree: Dbvt, iA: number): number {
    const A = tree.nodes[iA];
    if (A.left === -1 || A.height < 2) return iA;

    const iB = A.left;
    const iC = A.right;
    const B = tree.nodes[iB];
    const C = tree.nodes[iC];
    const skew = C.height - B.height;

    if (skew > 1) {
        const iF = C.left;
        const iG = C.right;
        const F = tree.nodes[iF];
        const G = tree.nodes[iG];

        C.left = iA;
        C.parent = A.parent;
        A.parent = iC;

        if (C.parent !== -1) {
            const P = tree.nodes[C.parent];
            if (P.left === iA) P.left = iC;
            else P.right = iC;
        } else {
            tree.root = iC;
        }

        if (F.height > G.height) {
            C.right = iF;
            A.right = iG;
            G.parent = iA;
            box3.union(A.aabb, B.aabb, G.aabb);
            box3.union(C.aabb, A.aabb, F.aabb);
            A.height = 1 + (B.height > G.height ? B.height : G.height);
            C.height = 1 + (A.height > F.height ? A.height : F.height);
        } else {
            C.right = iG;
            A.right = iF;
            F.parent = iA;
            box3.union(A.aabb, B.aabb, F.aabb);
            box3.union(C.aabb, A.aabb, G.aabb);
            A.height = 1 + (B.height > F.height ? B.height : F.height);
            C.height = 1 + (A.height > G.height ? A.height : G.height);
        }
        return iC;
    }

    if (skew < -1) {
        const iD = B.left;
        const iE = B.right;
        const D = tree.nodes[iD];
        const E = tree.nodes[iE];

        B.right = iA;
        B.parent = A.parent;
        A.parent = iB;

        if (B.parent !== -1) {
            const P = tree.nodes[B.parent];
            if (P.left === iA) P.left = iB;
            else P.right = iB;
        } else {
            tree.root = iB;
        }

        if (D.height > E.height) {
            B.left = iD;
            A.left = iE;
            E.parent = iA;
            box3.union(A.aabb, C.aabb, E.aabb);
            box3.union(B.aabb, A.aabb, D.aabb);
            A.height = 1 + (C.height > E.height ? C.height : E.height);
            B.height = 1 + (A.height > D.height ? A.height : D.height);
        } else {
            B.left = iE;
            A.left = iD;
            D.parent = iA;
            box3.union(A.aabb, C.aabb, D.aabb);
            box3.union(B.aabb, A.aabb, E.aabb);
            A.height = 1 + (C.height > D.height ? C.height : D.height);
            B.height = 1 + (A.height > E.height ? A.height : E.height);
        }
        return iB;
    }

    return iA;
}

function refitAndBalance(tree: Dbvt, startIndex: number): void {
    let index = startIndex;
    while (index !== -1) {
        index = balance(tree, index);
        const node = tree.nodes[index];
        const left = tree.nodes[node.left];
        const right = tree.nodes[node.right];
        node.height = 1 + (left.height > right.height ? left.height : right.height);
        box3.union(node.aabb, left.aabb, right.aabb);
        index = node.parent;
    }
}

function insertLeaf(tree: Dbvt, leafIndex: number): void {
    const leaf = tree.nodes[leafIndex];

    if (tree.root === -1) {
        tree.root = leafIndex;
        leaf.parent = -1;
        return;
    }

    const leafAabb = leaf.aabb;
    let siblingIndex = tree.root;
    let sibling = tree.nodes[siblingIndex];
    while (sibling.left !== -1) {
        const area = surfaceArea(sibling.aabb);
        const combined = unionSurfaceArea(sibling.aabb, leafAabb);

        const stopCost = 2 * combined;
        const inheritance = 2 * (combined - area);

        const leftIndex = sibling.left;
        const rightIndex = sibling.right;
        const left = tree.nodes[leftIndex];
        const right = tree.nodes[rightIndex];

        const leftUnion = unionSurfaceArea(leafAabb, left.aabb);
        const leftCost = (left.left === -1 ? leftUnion : leftUnion - surfaceArea(left.aabb)) + inheritance;
        const rightUnion = unionSurfaceArea(leafAabb, right.aabb);
        const rightCost = (right.left === -1 ? rightUnion : rightUnion - surfaceArea(right.aabb)) + inheritance;

        if (stopCost < leftCost && stopCost < rightCost) break;

        if (leftCost < rightCost) {
            siblingIndex = leftIndex;
            sibling = left;
        } else {
            siblingIndex = rightIndex;
            sibling = right;
        }
    }

    const oldParentIndex = sibling.parent;
    const newParentIndex = requestNode(tree);
    const newParent = tree.nodes[newParentIndex];

    newParent.parent = oldParentIndex;
    newParent.left = siblingIndex;
    newParent.right = leafIndex;
    newParent.height = sibling.height + 1;
    box3.union(newParent.aabb, leafAabb, sibling.aabb);
    sibling.parent = newParentIndex;
    leaf.parent = newParentIndex;

    if (oldParentIndex !== -1) {
        const oldParent = tree.nodes[oldParentIndex];
        if (oldParent.left === siblingIndex) oldParent.left = newParentIndex;
        else oldParent.right = newParentIndex;
    } else {
        tree.root = newParentIndex;
    }

    refitAndBalance(tree, newParentIndex);
}

function removeLeaf(tree: Dbvt, leafIndex: number): void {
    if (leafIndex === tree.root) {
        tree.root = -1;
        return;
    }

    const leaf = tree.nodes[leafIndex];
    const parentIndex = leaf.parent;
    const parent = tree.nodes[parentIndex];
    const grandparentIndex = parent.parent;
    const siblingIndex = parent.left === leafIndex ? parent.right : parent.left;
    const sibling = tree.nodes[siblingIndex];

    if (grandparentIndex !== -1) {
        const grandparent = tree.nodes[grandparentIndex];
        if (grandparent.left === parentIndex) grandparent.left = siblingIndex;
        else grandparent.right = siblingIndex;
        sibling.parent = grandparentIndex;
        releaseNode(tree, parentIndex);
        refitAndBalance(tree, grandparentIndex);
    } else {
        tree.root = siblingIndex;
        sibling.parent = -1;
        releaseNode(tree, parentIndex);
    }
}

const _fatAabb = /* @__PURE__ */ box3.create();

/** insert a leaf carrying `data`; returns its stable leaf index. */
export function add(tree: Dbvt, aabb: Box3, data: number): number {
    box3.expandByMargin(_fatAabb, aabb, tree.expansionMargin);

    const leafIndex = requestNode(tree);
    const leaf = tree.nodes[leafIndex];
    box3.copy(leaf.aabb, _fatAabb);
    leaf.height = 0;
    leaf.data = data;

    insertLeaf(tree, leafIndex);
    return leafIndex;
}

/** remove a leaf; returns the `data` it carried (-1 if the index is stale). */
export function remove(tree: Dbvt, leafIndex: number): number {
    if (leafIndex < 0 || leafIndex >= tree.nodes.length) return -1;
    const data = tree.nodes[leafIndex].data;
    removeLeaf(tree, leafIndex);
    releaseNode(tree, leafIndex);
    return data;
}

/** overwrite a leaf's `data` payload (its index is unchanged). */
export function setData(tree: Dbvt, leafIndex: number, data: number): void {
    tree.nodes[leafIndex].data = data;
}

/** refresh a leaf's aabb; no-op while it still fits the fat aabb, else reinsert from the root. */
export function update(tree: Dbvt, leafIndex: number, aabb: Box3): void {
    const leaf = tree.nodes[leafIndex];
    if (box3.containsBox3(leaf.aabb, aabb)) return;

    box3.expandByMargin(_fatAabb, aabb, tree.expansionMargin);

    removeLeaf(tree, leafIndex);
    box3.copy(leaf.aabb, _fatAabb);
    leaf.parent = -1;
    leaf.left = -1;
    leaf.right = -1;
    leaf.height = 0;
    insertLeaf(tree, leafIndex);
}

/** longest root-to-leaf path; 0 for an empty or single-leaf tree. */
export function height(tree: Dbvt): number {
    return tree.root === -1 ? 0 : tree.nodes[tree.root].height;
}

const _planes = /* @__PURE__ */ new Float64Array(24);

const ALL_PLANES = 0b111111;

/** visit every leaf inside the frustum and within `radiusSq` of the camera. `Infinity` disables the sphere. */
export function frustumCull(
    tree: Dbvt,
    f: Frustum,
    cx: number,
    cy: number,
    cz: number,
    radiusSq: number,
    onLeaf: (data: number) => void,
): void {
    if (tree.root === -1) return;

    for (let i = 0; i < 6; i++) {
        const plane = f[i];
        const o = i * 4;
        _planes[o] = plane.normal[0];
        _planes[o + 1] = plane.normal[1];
        _planes[o + 2] = plane.normal[2];
        _planes[o + 3] = plane.constant;
    }

    const clipToSphere = radiusSq !== Number.POSITIVE_INFINITY;
    const nodes = tree.nodes;
    const stack = _stack;
    stack.size = 0;
    stackPush(stack, tree.root, ALL_PLANES);

    while (stack.size > 0) {
        stack.size--;
        const nodeIndex = stack.entries[stack.size]!;
        let mask = stack.masks[stack.size]!;
        const node = nodes[nodeIndex]!;
        const aabb = node.aabb;
        const minX = aabb[0];
        const minY = aabb[1];
        const minZ = aabb[2];
        const maxX = aabb[3];
        const maxY = aabb[4];
        const maxZ = aabb[5];

        let outside = false;
        for (let i = 0; i < 6; i++) {
            const bit = 1 << i;
            if ((mask & bit) === 0) continue;
            const o = i * 4;
            const nx = _planes[o]!;
            const ny = _planes[o + 1]!;
            const nz = _planes[o + 2]!;
            const constant = _planes[o + 3]!;

            const px = nx >= 0 ? maxX : minX;
            const py = ny >= 0 ? maxY : minY;
            const pz = nz >= 0 ? maxZ : minZ;
            if (nx * px + ny * py + nz * pz + constant < 0) {
                outside = true;
                break;
            }

            const qx = nx >= 0 ? minX : maxX;
            const qy = ny >= 0 ? minY : maxY;
            const qz = nz >= 0 ? minZ : maxZ;
            if (nx * qx + ny * qy + nz * qz + constant >= 0) mask &= ~bit;
        }
        if (outside) continue;

        if (clipToSphere) {
            const dx = cx < minX ? minX - cx : cx > maxX ? cx - maxX : 0;
            const dy = cy < minY ? minY - cy : cy > maxY ? cy - maxY : 0;
            const dz = cz < minZ ? minZ - cz : cz > maxZ ? cz - maxZ : 0;
            if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
        }

        if (node.left === -1) {
            onLeaf(node.data);
            continue;
        }

        stackPush(stack, node.left, mask);
        stackPush(stack, node.right, mask);
    }
}
