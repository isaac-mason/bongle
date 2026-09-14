import { type BodyId, type BoxShape, box, type Filter, filter as filterMod, MotionType, rigidBody, type World } from 'crashcat';
import type { Vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { CameraTrait } from '../builtins/camera';
import { CharacterTrait } from '../builtins/character';
import { TransformTrait } from '../builtins/transform';
import type { Physics } from '../core/physics/physics';
import { OBJECT_LAYER_EDITOR_NODES, settings } from '../core/physics/physics';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { getNodeById, getTrait } from '../core/scene/scene-tree';
import type { Visibility } from '../render/visibility/visibility';
import type { EditRoomStoreApi } from './edit-room-store';
import { EditorTrait } from './editor-trait';

type BodyEntry = {
    bodyId: BodyId;
    shape: BoxShape;
};

export type NodeBodies = {
    world: World;
    nodeToBody: Map<number, BodyEntry>;
    bodyToNode: Map<BodyId, number>;
    queryFilter: Filter;
    targetable: Set<number>;
    _unsubscribe: () => void;
    targetableDirty: boolean;
    syncedGeneration: number;
};

export function init(store: EditRoomStoreApi, physics: Physics): NodeBodies {
    const qf = filterMod.createEmpty();
    filterMod.enableObjectLayer(qf, settings.layers, OBJECT_LAYER_EDITOR_NODES);
    qf.collisionMask = ~0;
    qf.collisionGroups = ~0;

    const state: NodeBodies = {
        world: physics.rigid.world,
        nodeToBody: new Map(),
        bodyToNode: new Map(),
        queryFilter: qf,
        targetable: new Set(),
        _unsubscribe: () => {},
        targetableDirty: true,
        syncedGeneration: -1,
    };

    state._unsubscribe = store.subscribe((s, prev) => {
        if (s.selection !== prev.selection) state.targetableDirty = true;
    });

    return state;
}

export function dispose(state: NodeBodies): void {
    state._unsubscribe();
    const { nodeToBody, bodyToNode, world } = state;
    for (const entry of nodeToBody.values()) {
        const body = rigidBody.get(world, entry.bodyId);
        if (body) rigidBody.remove(world, body);
    }
    nodeToBody.clear();
    bodyToNode.clear();
    state.targetable.clear();
}

/** a click inside a character rig or a prefab's generated internals selects the root that owns them. */
export function isOwnershipBoundary(node: Node): boolean {
    return node.prefab !== null || getTrait(node, CharacterTrait) !== undefined;
}

function isFrontierEligible(node: Node, root: Node): boolean {
    if (node === root) return false;
    if (!getTrait(node, TransformTrait)) return false;
    if (getTrait(node, CameraTrait)) return false;
    if (getTrait(node, EditorTrait)) return false;
    return true;
}

function addEligibleChildren(parent: Node, root: Node, out: Set<number>): boolean {
    let added = false;
    for (const child of parent.children) {
        if (!isFrontierEligible(child, root)) continue;
        out.add(child.id);
        added = true;
    }
    return added;
}

function recomputeFrontier(state: NodeBodies, sceneTree: SceneTree, store: EditRoomStoreApi): void {
    const { targetable } = state;
    targetable.clear();

    const root = sceneTree.root;
    const selectedIds = store.getState().selection.nodes;

    addEligibleChildren(root, root, targetable);

    // drill-down: a selected node's children replace it; a selected leaf stays
    for (const sid of selectedIds) {
        const sel = getNodeById(sceneTree, sid);
        if (!sel || sel === root || isOwnershipBoundary(sel)) continue;
        const childrenAdded = addEligibleChildren(sel, root, targetable);
        if (childrenAdded) {
            targetable.delete(sel.id);
        }
    }
}

const _scratchPos: Vec3 = [0, 0, 0];
const _unions = new Map<number, Box3>();
const _boxPool: Box3[] = [];
const _toRemove: number[] = [];

function syncBodyToWorldAabb(world: World, entry: BodyEntry, aabb: Box3): void {
    const body = rigidBody.get(world, entry.bodyId);
    if (!body) return;

    const hx = Math.max((aabb[3] - aabb[0]) * 0.5, 0.01);
    const hy = Math.max((aabb[4] - aabb[1]) * 0.5, 0.01);
    const hz = Math.max((aabb[5] - aabb[2]) * 0.5, 0.01);
    _scratchPos[0] = (aabb[0] + aabb[3]) * 0.5;
    _scratchPos[1] = (aabb[1] + aabb[4]) * 0.5;
    _scratchPos[2] = (aabb[2] + aabb[5]) * 0.5;

    entry.shape.halfExtents[0] = hx;
    entry.shape.halfExtents[1] = hy;
    entry.shape.halfExtents[2] = hz;
    box.update(entry.shape);
    rigidBody.updateShape(world, body);
    rigidBody.setPosition(world, body, _scratchPos, false);
}

function removeBody(state: NodeBodies, nodeId: number): void {
    const entry = state.nodeToBody.get(nodeId);
    if (!entry) return;
    const body = rigidBody.get(state.world, entry.bodyId);
    if (body) rigidBody.remove(state.world, body);
    state.bodyToNode.delete(entry.bodyId);
    state.nodeToBody.delete(nodeId);
}

function unionPartsByFrontierNode(state: NodeBodies, visibility: Visibility): void {
    const { targetable } = state;
    const entries = visibility.entries;
    const transforms = visibility.transforms;
    _unions.clear();
    let poolIndex = 0;

    for (let i = 0; i < entries.length; i++) {
        let node: Node | null = transforms[i]!._node;
        while (node !== null && !targetable.has(node.id)) node = node.parent;
        if (node === null) continue;

        let union = _unions.get(node.id);
        if (union === undefined) {
            if (poolIndex === _boxPool.length) _boxPool.push(box3.create());
            union = _boxPool[poolIndex]!;
            poolIndex++;
            box3.empty(union);
            _unions.set(node.id, union);
        }
        box3.union(union, union, entries[i]!.worldAabb);
    }
}

export function update(state: NodeBodies, visibility: Visibility, sceneTree: SceneTree, store: EditRoomStoreApi): void {
    if (state.targetableDirty) {
        recomputeFrontier(state, sceneTree, store);
        state.targetableDirty = false;
    } else if (state.syncedGeneration === visibility.generation) {
        return;
    }
    state.syncedGeneration = visibility.generation;

    const { nodeToBody, bodyToNode, targetable, world } = state;

    unionPartsByFrontierNode(state, visibility);

    _toRemove.length = 0;
    for (const nodeId of nodeToBody.keys()) {
        if (!targetable.has(nodeId) || !_unions.has(nodeId)) _toRemove.push(nodeId);
    }
    for (const nodeId of _toRemove) removeBody(state, nodeId);

    for (const [nodeId, union] of _unions) {
        const existing = nodeToBody.get(nodeId);
        if (existing) {
            syncBodyToWorldAabb(world, existing, union);
            continue;
        }
        const hx = Math.max((union[3] - union[0]) * 0.5, 0.01);
        const hy = Math.max((union[4] - union[1]) * 0.5, 0.01);
        const hz = Math.max((union[5] - union[2]) * 0.5, 0.01);
        const cx = (union[0] + union[3]) * 0.5;
        const cy = (union[1] + union[4]) * 0.5;
        const cz = (union[2] + union[5]) * 0.5;
        const shape = box.create({ halfExtents: [hx, hy, hz] });
        const body = rigidBody.create(world, {
            shape,
            objectLayer: OBJECT_LAYER_EDITOR_NODES,
            motionType: MotionType.STATIC,
            position: [cx, cy, cz],
            sensor: true,
        });
        nodeToBody.set(nodeId, { bodyId: body.id, shape });
        bodyToNode.set(body.id, nodeId);
    }
}

export function nodeIdForBody(state: NodeBodies, bodyId: BodyId): number | undefined {
    return state.bodyToNode.get(bodyId);
}
