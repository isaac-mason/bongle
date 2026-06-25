// node-bodies.ts — maintains crashcat sensor rigid bodies for scene nodes
// so broadphase queries (castRay, intersectAABB) can find them efficiently.
//
// Only nodes in the *targetable frontier* hold bodies. The frontier is a
// Blender-style drill-down model derived from the current selection:
//
//   - no selection: every direct child of root that has a transform.
//   - with selection: each selected node's direct children replace the
//     selected node in the frontier (you've drilled past it). leaf-selected
//     nodes (no children) stay in the frontier so they remain clickable.
//   - root.children are always present so the user can pick another
//     top-level object without first deselecting.
//
// Nodes whose subtree contributes no mesh AABB get NO body — they're only
// selectable from the hierarchy panel. Each tracked body owns a stable
// `BoxShape` whose `halfExtents` is mutated in place each frame to avoid
// per-frame allocations.
//
// the module does NOT use userData on the rigid body — instead it maintains
// a bidirectional map: bodyId ↔ nodeId.

import { type BodyId, type BoxShape, box, type Filter, filter as filterMod, MotionType, rigidBody } from 'crashcat';
import { type Box3, box3, type Mat4, mat4, type Vec3 } from 'mathcat';
import { getVisualWorldMatrix } from '../api/transforms';
import { PlayerTrait } from '../builtins/player';
import { TransformTrait } from '../builtins/transform';
import type { Physics } from '../core/physics/physics';
import { OBJECT_LAYER_EDITOR_NODES, settings } from '../core/physics/physics';
import type { Resources } from '../core/resources';
import type { Node, Nodes } from '../core/scene/nodes';
import { getNodeById, getTrait, isAncestorOf, query } from '../core/scene/nodes';
import type { EditRoomStoreApi } from './edit-room-store';
import { unionSubtreeWorldAabb } from './node-aabb';

// ── types ───────────────────────────────────────────────────────────

type BodyEntry = {
    bodyId: BodyId;
    shape: BoxShape;
    /** subtree mesh-AABB union expressed in this node's local frame.
     * snapshotted at first sync (using the current pose) and re-derived
     * only when the frontier rebuilds. animation moving bones inside the
     * rig does NOT re-tighten this — same trade Godot makes. */
    localAabb: Box3 | null;
    /** transform._version at last body sync. an int-compare against the
     * current frame's _version short-circuits the per-frame update when
     * the rig hasn't moved (markDirty / interpolate bump _version). */
    lastVersion: number;
};

export type NodeBodies = {
    // bidirectional maps
    nodeToBody: Map<number, BodyEntry>;
    bodyToNode: Map<BodyId, number>;
    // pre-built filter that only hits the editor nodes layer
    queryFilter: Filter;
    // cached player node id — refreshed when the frontier rebuilds
    playerNodeId: number;
    // current targetable frontier (node ids eligible for a body)
    targetable: Set<number>;
    // last selection signature we built `targetable` from
    _lastSelectionVersion: number;
    // unsubscribe from the editor store on dispose
    _unsubscribe: () => void;
    // set when frontier inputs change (selection, scene structure)
    targetableDirty: boolean;
};

// ── init / dispose ──────────────────────────────────────────────────

export function init(store: EditRoomStoreApi): NodeBodies {
    const qf = filterMod.createEmpty();
    filterMod.enableObjectLayer(qf, settings.layers, OBJECT_LAYER_EDITOR_NODES);
    qf.collisionMask = ~0;
    qf.collisionGroups = ~0;

    const state: NodeBodies = {
        nodeToBody: new Map(),
        bodyToNode: new Map(),
        queryFilter: qf,
        playerNodeId: -1,
        targetable: new Set(),
        _lastSelectionVersion: -1,
        _unsubscribe: () => {},
        targetableDirty: true,
    };

    // any change to selection or scene structure (sceneRevision bump) flips the
    // dirty bit; the next update() rebuilds the frontier.
    state._unsubscribe = store.subscribe((s, prev) => {
        if (s.selection !== prev.selection || s.sceneRevision !== prev.sceneRevision) {
            state.targetableDirty = true;
        }
    });

    return state;
}

export function dispose(state: NodeBodies, physics: Physics): void {
    state._unsubscribe();
    const { nodeToBody, bodyToNode } = state;
    for (const entry of nodeToBody.values()) {
        const body = rigidBody.get(physics.rigid.world, entry.bodyId);
        if (body) rigidBody.remove(physics.rigid.world, body);
    }
    nodeToBody.clear();
    bodyToNode.clear();
    state.targetable.clear();
}

// ── frontier computation ────────────────────────────────────────────

/** does this node carry a transform and is not a player or scene root? */
function isFrontierEligible(node: Node, playerNodeId: number, root: Node): boolean {
    if (node === root) return false;
    if (node.id === playerNodeId) return false;
    if (!getTrait(node, TransformTrait)) return false;
    return true;
}

/** add direct frontier-eligible children of `parent` to `out`. returns whether any were added. */
function addEligibleChildren(parent: Node, playerNode: Node | null, root: Node, out: Set<number>): boolean {
    let added = false;
    const playerId = playerNode ? playerNode.id : -1;
    for (const child of parent.children) {
        if (!isFrontierEligible(child, playerId, root)) continue;
        // skip descendants of the player
        if (playerNode && isAncestorOf(playerNode, child)) continue;
        out.add(child.id);
        added = true;
    }
    return added;
}

function recomputeFrontier(state: NodeBodies, nodes: Nodes, store: EditRoomStoreApi): void {
    const { targetable } = state;
    targetable.clear();

    // refresh cached player id
    let playerNode: Node | null = null;
    for (const [player] of query(nodes, [PlayerTrait])) {
        playerNode = player._node!;
        break;
    }
    state.playerNodeId = playerNode ? playerNode.id : -1;

    const root = nodes.root;
    const selectedIds = store.getState().selection.nodes;

    // root.children are always part of the frontier (so a different top-level
    // object can be picked without deselecting first).
    addEligibleChildren(root, playerNode, root, targetable);

    // for each selected node: add its direct eligible children. if any were
    // added, drop the selected node from the frontier (drill-down). otherwise
    // keep the leaf-selected node so it remains clickable.
    for (const sid of selectedIds) {
        const sel = getNodeById(nodes, sid);
        if (!sel || sel === root) continue;
        const childrenAdded = addEligibleChildren(sel, playerNode, root, targetable);
        if (childrenAdded) {
            targetable.delete(sel.id);
        }
    }
}

// ── per-frame sync ──────────────────────────────────────────────────

const _worldAabb: Box3 = box3.create();
const _invMat: Mat4 = mat4.create();
const _scratchPos: Vec3 = [0, 0, 0];

function syncBodyToWorldAabb(physics: Physics, entry: BodyEntry, aabb: Box3): void {
    const body = rigidBody.get(physics.rigid.world, entry.bodyId);
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
    rigidBody.updateShape(physics.rigid.world, body);
    rigidBody.setPosition(physics.rigid.world, body, _scratchPos, false);
}

export function update(state: NodeBodies, physics: Physics, nodes: Nodes, store: EditRoomStoreApi, resources: Resources): void {
    const { nodeToBody, bodyToNode, targetable } = state;
    const world = physics.rigid.world;

    if (state.targetableDirty) {
        recomputeFrontier(state, nodes, store);
        state.targetableDirty = false;

        // remove bodies for nodes that left the frontier
        const toRemove: number[] = [];
        for (const nodeId of nodeToBody.keys()) {
            if (!targetable.has(nodeId)) toRemove.push(nodeId);
        }
        for (const nodeId of toRemove) {
            const entry = nodeToBody.get(nodeId)!;
            const body = rigidBody.get(world, entry.bodyId);
            if (body) rigidBody.remove(world, body);
            bodyToNode.delete(entry.bodyId);
            nodeToBody.delete(nodeId);
        }

        // structure may have changed (children added/removed, mesh swapped, etc.) —
        // force surviving entries to re-derive their cached local AABB next sync.
        for (const entry of nodeToBody.values()) entry.localAabb = null;
    }

    for (const nodeId of targetable) {
        const node = getNodeById(nodes, nodeId);
        if (!node) continue;
        const transform = getTrait(node, TransformTrait);
        if (!transform) continue;

        const existing = nodeToBody.get(nodeId);

        // ── steady state: cached local AABB + version short-circuit ──
        if (existing && existing.localAabb) {
            if (existing.lastVersion === transform._version) {
                // rig root hasn't moved since last sync — body already in place.
                continue;
            }
            const iwm = getVisualWorldMatrix(transform);
            box3.transformMat4(_worldAabb, existing.localAabb, iwm);
            existing.lastVersion = transform._version;
            syncBodyToWorldAabb(physics, existing, _worldAabb);
            continue;
        }

        // ── first sync (or post-dirty rebuild): walk subtree once ──
        box3.set(_worldAabb, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
        if (!unionSubtreeWorldAabb(node, resources, _worldAabb)) {
            // no geometry yet — drop a stale body if present (mesh may have been removed)
            if (existing) {
                const body = rigidBody.get(world, existing.bodyId);
                if (body) rigidBody.remove(world, body);
                bodyToNode.delete(existing.bodyId);
                nodeToBody.delete(nodeId);
            }
            continue;
        }

        // derive node-local AABB once: localAabb = inverse(rootWorld) * worldAabb
        const rootIwm = getVisualWorldMatrix(transform);
        if (!mat4.invert(_invMat, rootIwm)) {
            // singular matrix (zero scale, etc.) — skip; will retry next frame.
            continue;
        }
        const localAabb = box3.create();
        box3.transformMat4(localAabb, _worldAabb, _invMat);

        if (existing) {
            existing.localAabb = localAabb;
            existing.lastVersion = transform._version;
            syncBodyToWorldAabb(physics, existing, _worldAabb);
        } else {
            const hx = Math.max((_worldAabb[3] - _worldAabb[0]) * 0.5, 0.01);
            const hy = Math.max((_worldAabb[4] - _worldAabb[1]) * 0.5, 0.01);
            const hz = Math.max((_worldAabb[5] - _worldAabb[2]) * 0.5, 0.01);
            const cx = (_worldAabb[0] + _worldAabb[3]) * 0.5;
            const cy = (_worldAabb[1] + _worldAabb[4]) * 0.5;
            const cz = (_worldAabb[2] + _worldAabb[5]) * 0.5;
            const shape = box.create({ halfExtents: [hx, hy, hz] });
            const body = rigidBody.create(world, {
                shape,
                objectLayer: OBJECT_LAYER_EDITOR_NODES,
                motionType: MotionType.STATIC,
                position: [cx, cy, cz],
                sensor: true,
            });
            nodeToBody.set(nodeId, { bodyId: body.id, shape, localAabb, lastVersion: transform._version });
            bodyToNode.set(body.id, nodeId);
        }
    }
}

// ── lookup helpers ──────────────────────────────────────────────────

export function nodeIdForBody(state: NodeBodies, bodyId: BodyId): number | undefined {
    return state.bodyToNode.get(bodyId);
}
