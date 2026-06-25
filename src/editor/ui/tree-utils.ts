import type { Node, Nodes } from '../../core/scene/nodes';

/* ── Flattened item for dnd-kit sortable ────────────────────────── */

export type FlattenedNode = {
    /** node.id as string (dnd-kit uses string identifiers) */
    id: string;
    /** original numeric node id */
    nodeId: number;
    /** reference to the actual scene graph node */
    node: Node;
    /** parent's id as string, null for root children */
    parentId: string | null;
    depth: number;
    /** index within the flat list (used by useSortable) */
    index: number;
    childCount: number;
    collapsed: boolean;
    /** false if this node OR any ancestor is non-persistent — used for gray/italic styling */
    effectivePersist: boolean;
};

/* ── Flatten scene graph for dnd-kit ────────────────────────────── */

/**
 * Flatten a scene graph's root children into a flat list suitable for
 * dnd-kit sortable. The root node itself is NOT included — it's always
 * the implicit parent. Only its descendants are flattened.
 *
 * Collapsed nodes' children are excluded from the flat list.
 */
export function flattenSceneGraph(sg: Nodes, collapsedIds: Set<number>): FlattenedNode[] {
    const result: FlattenedNode[] = [];

    // include root node itself
    const rootEffectivePersist = sg.root.persist;
    const rootCollapsed = collapsedIds.has(sg.root.id);
    result.push({
        id: String(sg.root.id),
        nodeId: sg.root.id,
        node: sg.root,
        parentId: null,
        depth: 0,
        index: 0,
        // childCount only used to render the collapsed-badge in tree-item.tsx —
        // skip the recursive count for expanded nodes. for the typical large
        // tree where most nodes are expanded this avoids O(N²) cost.
        childCount: rootCollapsed ? countDescendants(sg.root) : 0,
        collapsed: rootCollapsed,
        effectivePersist: rootEffectivePersist,
    });

    // then its children
    if (!rootCollapsed) {
        flattenChildren(sg.root, String(sg.root.id), 1, rootEffectivePersist, collapsedIds, result);
    }

    // Assign sequential indices for useSortable
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
            index: 0, // will be assigned after flattening
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
 * Flatten only nodes whose name matches `query` (case-insensitive substring),
 * along with all their ancestors so the tree path stays visible. The collapsed
 * state is ignored — every ancestor of a match is shown.
 *
 * Used when the hierarchy filter input is non-empty.
 */
export function flattenSceneGraphFiltered(sg: Nodes, query: string): FlattenedNode[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];

    // walk once to mark every node that should be visible: any node that
    // matches itself, plus every ancestor of such a node.
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
    walk(sg.root);
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
    emit(sg.root, null, 0, sg.root.persist);

    for (let i = 0; i < result.length; i++) result[i].index = i;
    return result;
}

/* ── Projection: determine depth + parent from drag offset ──────── */

export function getDragDepth(offset: number, indentationWidth: number): number {
    return Math.round(offset / indentationWidth);
}

/**
 * Given the current flat list, the target item position, and the
 * projected depth (initial depth + drag horizontal offset), compute
 * the actual clamped depth and new parentId.
 */
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

        // Walk backwards to find the ancestor at this depth
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

/* ── Get descendants of an item in the flat list ────────────────── */

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

/* ── Apply flat list result back to the scene graph ─────────────── */

/**
 * Given the final flattened list after a drag operation (with updated
 * parentId/depth), apply reparenting and reordering to the actual
 * scene graph nodes.
 *
 * This is the key function: it reads the flat list's order and parentId
 * assignments and mutates the real scene graph to match.
 */
export function applyFlattenedOrder(sg: Nodes, flatItems: FlattenedNode[], removedItems: FlattenedNode[]): void {
    // Merge removed items (descendants of dragged node) back in.
    // They keep their original parentId relative to the dragged node,
    // so they just need to be re-inserted after the dragged node.
    const allItems = [...flatItems];

    if (removedItems.length > 0) {
        // Find the dragged item (the one whose children were removed)
        // The removed items' original parent structure is preserved
        // relative to each other — just splice them back in after
        // the dragged node.
        const draggedId = removedItems[0].parentId;
        const draggedIndex = allItems.findIndex((item) => item.id === draggedId);
        if (draggedIndex !== -1) {
            allItems.splice(draggedIndex + 1, 0, ...removedItems);
        }
    }

    // Build a map of parentId -> ordered children
    const childrenMap = new Map<string | null, FlattenedNode[]>();
    for (const item of allItems) {
        const pid = item.parentId;
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid)!.push(item);
    }

    // Apply to scene graph: for each parent, reorder its children array
    // parentId null means children of root
    applyChildren(sg.root, null, childrenMap, sg);
}

function applyChildren(
    parent: Node,
    parentFlatId: string | null,
    childrenMap: Map<string | null, FlattenedNode[]>,
    sg: Nodes,
): void {
    const orderedChildren = childrenMap.get(parentFlatId);
    if (!orderedChildren) return;

    // Detach all current children (without destroying them)
    const existingChildren = new Map<number, Node>();
    for (const child of parent.children) {
        existingChildren.set(child.id, child);
    }

    // Clear parent's children array
    parent.children = [];

    // Re-attach in the new order, reparenting as needed
    for (const flatItem of orderedChildren) {
        const node = sg._idToNode.get(flatItem.nodeId);
        if (!node) continue;

        // If node's current parent is different, reparent
        if (node.parent !== parent) {
            // Remove from old parent's children array
            if (node.parent) {
                const oldChildren = node.parent.children;
                const idx = oldChildren.indexOf(node);
                if (idx !== -1) oldChildren.splice(idx, 1);
            }
            node.parent = parent;
        }

        parent.children.push(node);

        // Recurse into this node's children
        applyChildren(node, flatItem.id, childrenMap, sg);
    }
}

/* ── Compute reparent/reorder instructions from flat list ───────── */

/** instruction emitted when a node needs to move to a new parent/index */
export type ReparentInstruction = { nodeId: number; parentId: number; index: number };

/**
 * given the final flattened list after a drag operation, compute the
 * reparent instructions needed to make the scene graph match. this does NOT
 * mutate the scene graph — pass each instruction to reparentAction/reorderAction.
 *
 * parentId in FlattenedNode is String(node.id). null means child of root.
 */
export function computeReorderOps(sg: Nodes, flatItems: FlattenedNode[], removedItems: FlattenedNode[]): ReparentInstruction[] {
    // merge removed items (dragged node's descendants) back in
    const allItems = [...flatItems];

    if (removedItems.length > 0) {
        const draggedId = removedItems[0].parentId;
        const draggedIndex = allItems.findIndex((item) => item.id === draggedId);
        if (draggedIndex !== -1) {
            allItems.splice(draggedIndex + 1, 0, ...removedItems);
        }
    }

    // build desired parent → ordered children map
    // parentId null → root's children
    const childrenMap = new Map<string | null, FlattenedNode[]>();
    for (const item of allItems) {
        const pid = item.parentId;
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid)!.push(item);
    }

    // walk the desired tree and emit reparent instructions for nodes that moved
    const ops: ReparentInstruction[] = [];
    collectReorderOps(sg.root, null, childrenMap, sg, ops);
    return ops;
}

function collectReorderOps(
    parent: Node,
    parentFlatId: string | null,
    childrenMap: Map<string | null, FlattenedNode[]>,
    sg: Nodes,
    ops: ReparentInstruction[],
): void {
    const orderedChildren = childrenMap.get(parentFlatId);
    if (!orderedChildren) return;

    for (let i = 0; i < orderedChildren.length; i++) {
        const flatItem = orderedChildren[i];
        const node = sg._idToNode.get(flatItem.nodeId);
        if (!node) continue;

        const currentParent = node.parent;
        const currentIndex = currentParent ? currentParent.children.indexOf(node) : -1;

        // emit instruction if parent changed or index changed
        if (currentParent !== parent || currentIndex !== i) {
            ops.push({ nodeId: node.id, parentId: parent.id, index: i });
        }

        // recurse
        collectReorderOps(node, flatItem.id, childrenMap, sg, ops);
    }
}
