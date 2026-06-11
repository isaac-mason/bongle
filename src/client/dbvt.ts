// dbvt.ts — a dynamic bounding-volume tree (broadphase) over fat AABBs.
//
// Generic: it knows nothing about culling. Each LEAF carries an opaque
// numeric `data` payload (callers use it as an index into their own array);
// internal nodes have `data = -1`. Callers get `data` back from `remove` and
// from the `frustumCull` callback, and can rewrite it with `setData`.
//
// A port of crashcat's broadphase, stripped to the visibility use-case:
// fat-aabb expansion margin, freelist node pool, insert / remove / update
// with fat-aabb containment skip, ancestor refit. Dropped: collision filter
// / groups / mask, raycast and shape-cast helpers, previousAabb / velocity
// prediction. `intersectAABB` is replaced by `frustumCull`, which prunes
// internal subtrees via the 6-plane frustum test.

import { type Frustum, frustum } from 'gpucat';
import { type Box3, box3 } from 'mathcat';

export type DbvtNode = {
    index: number;
    parent: number;
    left: number;
    right: number;
    aabb: Box3;
    height: number;
    /** opaque payload for leaves (a caller-chosen index); -1 for internal
     *  nodes and freed slots. */
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

export function create(): Dbvt {
    return {
        nodes: [],
        freeNodeIndices: [],
        root: -1,
        expansionMargin: 0.05,
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

function isLeaf(node: DbvtNode): boolean {
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

function indexof(tree: Dbvt, nodeIndex: number): number {
    const node = tree.nodes[nodeIndex];
    const parent = tree.nodes[node.parent];
    return parent.right === nodeIndex ? 1 : 0;
}

function insertLeaf(tree: Dbvt, rootIndex: number, leafIndex: number): void {
    const leaf = tree.nodes[leafIndex];

    if (tree.root === -1) {
        tree.root = leafIndex;
        leaf.parent = -1;
        return;
    }

    let cur = rootIndex;
    let curNode = tree.nodes[cur];
    while (!isLeaf(curNode)) {
        const leftNode = tree.nodes[curNode.left];
        const rightNode = tree.nodes[curNode.right];
        const child = select(leaf.aabb, leftNode.aabb, rightNode.aabb);
        cur = child === 0 ? curNode.left : curNode.right;
        curNode = tree.nodes[cur];
    }

    const prev = curNode.parent;
    const newParentIndex = requestNode(tree);
    const newParent = tree.nodes[newParentIndex];

    newParent.parent = prev;
    box3.union(newParent.aabb, leaf.aabb, curNode.aabb);
    newParent.height = curNode.height + 1;

    if (prev !== -1) {
        const prevNode = tree.nodes[prev];
        if (indexof(tree, cur) === 0) {
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
            const parentNode = tree.nodes[parentIndex];
            if (!box3.containsBox3(parentNode.aabb, childNode.aabb)) {
                const leftNode = tree.nodes[parentNode.left];
                const rightNode = tree.nodes[parentNode.right];
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
        tree.root = newParentIndex;
    }
}

const _prevAabb = /* @__PURE__ */ box3.create();

function removeLeaf(tree: Dbvt, leafIndex: number): number {
    if (leafIndex === tree.root) {
        tree.root = -1;
        return -1;
    }

    const leaf = tree.nodes[leafIndex];
    const parentIndex = leaf.parent;
    const parent = tree.nodes[parentIndex];
    const prevIndex = parent.parent;
    const siblingIndex = parent.left === leafIndex ? parent.right : parent.left;
    const sibling = tree.nodes[siblingIndex];

    if (prevIndex !== -1) {
        const prev = tree.nodes[prevIndex];
        if (indexof(tree, parentIndex) === 0) {
            prev.left = siblingIndex;
        } else {
            prev.right = siblingIndex;
        }
        sibling.parent = prevIndex;
        releaseNode(tree, parentIndex);

        let nodeIndex = prevIndex;
        while (nodeIndex !== -1) {
            const node = tree.nodes[nodeIndex];
            box3.copy(_prevAabb, node.aabb);

            const leftNode = tree.nodes[node.left];
            const rightNode = tree.nodes[node.right];
            box3.union(node.aabb, leftNode.aabb, rightNode.aabb);

            if (!box3.exactEquals(node.aabb, _prevAabb)) {
                nodeIndex = node.parent;
            } else {
                break;
            }
        }

        return prevIndex;
    } else {
        tree.root = siblingIndex;
        sibling.parent = -1;
        releaseNode(tree, parentIndex);
        return tree.root;
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

    insertLeaf(tree, tree.root, leafIndex);
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

/**
 * refresh a leaf to a new tight aabb. fast path: if the new aabb still fits
 * inside the leaf's fat aabb, no tree mutation happens. otherwise the leaf is
 * removed and reinserted from the tree root. `data` is preserved.
 */
export function update(tree: Dbvt, leafIndex: number, aabb: Box3): void {
    const leaf = tree.nodes[leafIndex];
    if (box3.containsBox3(leaf.aabb, aabb)) return;

    box3.expandByMargin(_fatAabb, aabb, tree.expansionMargin);

    const rootIndex = removeLeaf(tree, leafIndex);
    box3.copy(leaf.aabb, _fatAabb);
    insertLeaf(tree, rootIndex === -1 ? tree.root : rootIndex, leafIndex);
}

/** visit every leaf whose fat aabb intersects the frustum, passing its
 *  `data` payload and (fat, world-space) aabb. */
export function frustumCull(tree: Dbvt, f: Frustum, onLeaf: (data: number, aabb: Box3) => void): void {
    if (tree.root === -1) return;

    stackReset(_stack);
    stackPush(_stack, tree.root);

    while (_stack.size > 0) {
        const nodeIndex = stackPop(_stack);
        const node = tree.nodes[nodeIndex];

        if (!frustum.intersectsBox3(f, node.aabb)) continue;

        if (isLeaf(node)) {
            onLeaf(node.data, node.aabb);
            continue;
        }

        if (node.left !== -1) stackPush(_stack, node.left);
        if (node.right !== -1) stackPush(_stack, node.right);
    }
}
