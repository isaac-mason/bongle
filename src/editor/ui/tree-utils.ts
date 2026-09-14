import type { Node, SceneTree } from '../../core/scene/scene-tree';

export type FlattenedNode = {
    /** node.id as string, dnd-kit uses string identifiers */
    id: string;
    nodeId: number;
    node: Node;
    /** parent's id as string, null for root children */
    parentId: string | null;
    depth: number;
    /** index within the flat list, used by useSortable */
    index: number;
    childCount: number;
    collapsed: boolean;
    /** false if this node or any ancestor is non-persistent, drives gray/italic styling */
    effectivePersist: boolean;
};

/** Flattens a scene tree, including the root, into a flat list for dnd-kit sortable. Collapsed nodes' children are excluded. */
export function flattenSceneTree(sceneTree: SceneTree, collapsedIds: Set<number>): FlattenedNode[] {
    const result: FlattenedNode[] = [];

    const rootEffectivePersist = sceneTree.root.persist;
    const rootCollapsed = collapsedIds.has(sceneTree.root.id);
    result.push({
        id: String(sceneTree.root.id),
        nodeId: sceneTree.root.id,
        node: sceneTree.root,
        parentId: null,
        depth: 0,
        index: 0,
        // only counted for collapsed nodes (renders the collapsed-badge); skipping expanded nodes avoids O(N^2) cost on large trees
        childCount: rootCollapsed ? countDescendants(sceneTree.root) : 0,
        collapsed: rootCollapsed,
        effectivePersist: rootEffectivePersist,
    });

    if (!rootCollapsed) {
        flattenChildren(sceneTree.root, String(sceneTree.root.id), 1, rootEffectivePersist, collapsedIds, result);
    }

    for (let i = 0; i < result.length; i++) {
        result[i].index = i;
    }
    return result;
}

function flattenChildren(
    parent: Node,
    parentId: string | null,
    depth: number,
    parentEffectivePersist: boolean,
    collapsedIds: Set<number>,
    out: FlattenedNode[],
): void {
    for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        const id = String(child.id);
        const collapsed = collapsedIds.has(child.id);
        const effectivePersist = parentEffectivePersist && child.persist;

        out.push({
            id,
            nodeId: child.id,
            node: child,
            parentId,
            depth,
            index: 0, // assigned after flattening
            childCount: collapsed ? countDescendants(child) : 0,
            collapsed,
            effectivePersist,
        });

        if (!collapsed) {
            flattenChildren(child, id, depth + 1, effectivePersist, collapsedIds, out);
        }
    }
}

function countDescendants(node: Node): number {
    let count = 0;
    for (const child of node.children) {
        count += 1 + countDescendants(child);
    }
    return count;
}

/**
 * Flattens only nodes whose name matches `query` (case-insensitive substring), plus their
 * ancestors so the tree path stays visible. Collapsed state is ignored.
 */
export function flattenSceneTreeFiltered(sceneTree: SceneTree, query: string): FlattenedNode[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];

    // marks every node that matches itself, plus every ancestor of such a node
    const visible = new Set<number>();
    function walk(node: Node): boolean {
        let anyVisible = false;
        for (const child of node.children) {
            if (walk(child)) anyVisible = true;
        }
        const name = node.name ?? '';
        if (anyVisible || name.toLowerCase().includes(q)) {
            visible.add(node.id);
            return true;
        }
        return false;
    }
    walk(sceneTree.root);
    if (visible.size === 0) return [];

    const result: FlattenedNode[] = [];
    function emit(node: Node, parentId: string | null, depth: number, parentEffectivePersist: boolean): void {
        if (!visible.has(node.id)) return;
        const effectivePersist = parentEffectivePersist && node.persist;
        result.push({
            id: String(node.id),
            nodeId: node.id,
            node,
            parentId,
            depth,
            index: 0,
            childCount: 0,
            collapsed: false,
            effectivePersist,
        });
        for (const child of node.children) {
            emit(child, String(node.id), depth + 1, effectivePersist);
        }
    }
    emit(sceneTree.root, null, 0, sceneTree.root.persist);

    for (let i = 0; i < result.length; i++) result[i].index = i;
    return result;
}

export function getDragDepth(offset: number, indentationWidth: number): number {
    return Math.round(offset / indentationWidth);
}

/** Computes the clamped depth and new parentId for a drag, from the target item and the projected depth (initial depth + drag horizontal offset). */
export function getProjection(
    items: FlattenedNode[],
    targetId: string | number,
    projectedDepth: number,
): { depth: number; parentId: string | null } {
    const targetIndex = items.findIndex(({ id }) => id === String(targetId));
    if (targetIndex === -1) return { depth: 0, parentId: null };

    const previousItem = items[targetIndex - 1];
    const targetItem = items[targetIndex];
    const nextItem = items[targetIndex + 1];

    const maxDepth = getMaxDepth(targetItem, previousItem);
    const minDepth = getMinDepth(nextItem);

    let depth = projectedDepth;
    if (depth >= maxDepth) depth = maxDepth;
    else if (depth < minDepth) depth = minDepth;

    return { depth, parentId: getParentId() };

    function getParentId(): string | null {
        if (depth === 0 || !previousItem) return null;
        if (depth === previousItem.depth) return previousItem.parentId;
        if (depth > previousItem.depth) return previousItem.id;

        // walk backwards to find the ancestor at this depth
        const ancestor = items
            .slice(0, targetIndex)
            .reverse()
            .find((item) => item.depth === depth)?.parentId;

        return ancestor ?? null;
    }
}

function getMaxDepth(targetItem: FlattenedNode, previousItem: FlattenedNode | undefined): number {
    if (!previousItem) return 0;
    return Math.min(targetItem.depth + 1, previousItem.depth + 1);
}

function getMinDepth(nextItem: FlattenedNode | undefined): number {
    return nextItem ? nextItem.depth : 0;
}

export function getDescendantIds(items: FlattenedNode[], parentId: string | number): Set<string> {
    const parentIdStr = String(parentId);
    const directChildren = items.filter((item) => item.parentId === parentIdStr);

    return directChildren.reduce((descendants, child) => {
        descendants.add(child.id);
        for (const id of getDescendantIds(items, child.id)) {
            descendants.add(id);
        }
        return descendants;
    }, new Set<string>());
}

/** Applies the final flattened list after a drag operation (with updated parentId/depth) to the actual scene tree, reparenting and reordering nodes to match. */
export function applyFlattenedOrder(sceneTree: SceneTree, flatItems: FlattenedNode[], removedItems: FlattenedNode[]): void {
    // removed items (descendants of the dragged node) keep their parentId relative to it,
    // so re-insert them right after the dragged node
    const allItems = [...flatItems];

    if (removedItems.length > 0) {
        const draggedId = removedItems[0].parentId;
        const draggedIndex = allItems.findIndex((item) => item.id === draggedId);
        if (draggedIndex !== -1) {
            allItems.splice(draggedIndex + 1, 0, ...removedItems);
        }
    }

    const childrenMap = new Map<string | null, FlattenedNode[]>();
    for (const item of allItems) {
        const pid = item.parentId;
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid)!.push(item);
    }

    // parentId null means children of root
    applyChildren(sceneTree.root, null, childrenMap, sceneTree);
}

function applyChildren(
    parent: Node,
    parentFlatId: string | null,
    childrenMap: Map<string | null, FlattenedNode[]>,
    sceneTree: SceneTree,
): void {
    const orderedChildren = childrenMap.get(parentFlatId);
    if (!orderedChildren) return;

    const existingChildren = new Map<number, Node>();
    for (const child of parent.children) {
        existingChildren.set(child.id, child);
    }

    parent.children = [];

    for (const flatItem of orderedChildren) {
        const node = sceneTree.idToNode.get(flatItem.nodeId);
        if (!node) continue;

        if (node.parent !== parent) {
            if (node.parent) {
                const oldChildren = node.parent.children;
                const idx = oldChildren.indexOf(node);
                if (idx !== -1) oldChildren.splice(idx, 1);
            }
            node.parent = parent;
        }

        parent.children.push(node);

        applyChildren(node, flatItem.id, childrenMap, sceneTree);
    }
}

/** instruction emitted when a node needs to move to a new parent/index */
export type ReparentInstruction = { nodeId: number; parentId: number; index: number };

/**
 * Computes the reparent instructions needed to make the scene tree match the final flattened
 * list after a drag. Does not mutate the scene tree; pass each instruction to reparentAction/reorderAction.
 */
export function computeReorderOps(
    sceneTree: SceneTree,
    flatItems: FlattenedNode[],
    removedItems: FlattenedNode[],
): ReparentInstruction[] {
    const allItems = [...flatItems];

    if (removedItems.length > 0) {
        const draggedId = removedItems[0].parentId;
        const draggedIndex = allItems.findIndex((item) => item.id === draggedId);
        if (draggedIndex !== -1) {
            allItems.splice(draggedIndex + 1, 0, ...removedItems);
        }
    }

    // parentId null maps to root's children
    const childrenMap = new Map<string | null, FlattenedNode[]>();
    for (const item of allItems) {
        const pid = item.parentId;
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid)!.push(item);
    }

    const ops: ReparentInstruction[] = [];
    collectReorderOps(sceneTree.root, null, childrenMap, sceneTree, ops);
    return ops;
}

function collectReorderOps(
    parent: Node,
    parentFlatId: string | null,
    childrenMap: Map<string | null, FlattenedNode[]>,
    sceneTree: SceneTree,
    ops: ReparentInstruction[],
): void {
    const orderedChildren = childrenMap.get(parentFlatId);
    if (!orderedChildren) return;

    for (let i = 0; i < orderedChildren.length; i++) {
        const flatItem = orderedChildren[i];
        const node = sceneTree.idToNode.get(flatItem.nodeId);
        if (!node) continue;

        const currentParent = node.parent;
        const currentIndex = currentParent ? currentParent.children.indexOf(node) : -1;

        if (currentParent !== parent || currentIndex !== i) {
            ops.push({ nodeId: node.id, parentId: parent.id, index: i });
        }

        collectReorderOps(node, flatItem.id, childrenMap, sceneTree, ops);
    }
}
