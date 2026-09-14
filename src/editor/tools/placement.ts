import { type Quat, quat, type Vec3, vec3 } from 'math';
import { MarkerTrait } from '../../builtins/marker';
import {
    getVisualWorldPosition,
    getVisualWorldQuaternion,
    markTransformDirty,
    setPosition,
    TransformTrait,
} from '../../builtins/transform';
import { createVoxelModel, VoxelMeshTrait } from '../../builtins/voxel-mesh';
import type { Input, MouseKeyboardInput } from '../../client/input';
import { isKeyJustDown } from '../../client/input';
import type { Node, SceneTree, SerializedNode } from '../../core/scene/scene-tree';
import { addChild, addTrait, createNode, deserializeNode, destroyNode, getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR } from '../../core/voxels/voxels';
import { setTraitProps } from '../actions';
import type { Blueprint as BlueprintData, VoxelOp } from '../blueprint';
import * as Blueprint from '../blueprint';
import { readNudgeDelta, snapCardinal, yawFromQuat } from '../camera';
import { CreateNodeCommand, DestroyNodeCommand, SetTraitCommand } from '../commands';
import type { EditRoomStoreApi } from '../edit-room-store';
import { NUDGE_KEYS, TRANSFORM_GIZMO_KEYS } from '../editor-controls';
import { commitVoxelOps } from '../voxel-edit';
import type { TransformSnapshot, TransformToolState } from './transform';
import * as TransformTool from './transform';

/** the placement tool: a ghost preview the cursor and gizmo drive until it commits into real nodes and voxels. */
export type PlacementTool = {
    store: EditRoomStoreApi;
    gizmo: TransformToolState;
    current: PlacementState | null;
    /** top-level ghost nodes; outlives `current` so `reconcilePlacementGhosts` can reap orphans left by an unclean teardown. */
    _ghostNodes: Set<Node>;
    /** snapshots from the first cursor-driven move in place-mode-with-selection; committed via commitPlaceSelection on exit. */
    placeSnapshots: TransformSnapshot[] | null;
};

// `store` is patched in by the caller right after construction, the same as the gizmo's.
export function init(gizmo: TransformToolState): PlacementTool {
    return { store: null as unknown as EditRoomStoreApi, gizmo, current: null, _ghostNodes: new Set(), placeSnapshots: null };
}

/** the ghost root's world position, for the pivot dot while place mode drives it; null when idle. */
export function pivotPosition(state: PlacementTool): Vec3 | null {
    const placement = state.current;
    if (!placement) return null;
    const t = getTrait(placement.rootNode, TransformTrait);
    if (!t) return null;
    _syncVoxelGhost(placement, t);
    return [...getVisualWorldPosition(t)] as Vec3;
}

// what the gizmo drives while a ghost is up: its root, no history on release, cardinal steps re-bake the voxel ghost.
function placementTarget(state: PlacementTool): TransformTool.NodeTarget {
    return {
        nodeIds: () => (state.current ? [state.current.rootNode.id] : []),
        pose: (proxy, idle) => {
            const placement = state.current;
            if (!placement) return false;
            const t = getTrait(placement.rootNode, TransformTrait);
            if (!t) return false;
            // only sync the proxy once placed; before that it stays put so the gizmo doesn't jump.
            if (idle && placement.placed) {
                vec3.copy(proxy.position, getVisualWorldPosition(t));
                quat.copy(proxy.quaternion, getVisualWorldQuaternion(t));
                vec3.set(proxy.scale, 1, 1, 1);
            }
            _syncVoxelGhost(placement, t);
            return true;
        },
        hasVoxels: () => state.current?.blueprint.hasVoxels ?? false,
        cardinalRotate: () => state.current !== null && state.current.rotation !== null,
        onBegin: (proxy) => {
            const placement = state.current;
            if (!placement) return;
            placement.dragRotSteps = [0, 0, 0];
            if (placement.placed) return;
            placement.placed = true;
            const t = getTrait(placement.rootNode, TransformTrait);
            if (t) {
                vec3.copy(proxy.position, getVisualWorldPosition(t));
                quat.copy(proxy.quaternion, getVisualWorldQuaternion(t));
                vec3.set(proxy.scale, 1, 1, 1);
            }
        },
        // each step re-bakes the blueprint, so the delta since the last call is walked one step at a time.
        onCardinalSteps: (axis, totalSteps) => {
            const placement = state.current;
            if (!placement) return;
            const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
            const delta = totalSteps - placement.dragRotSteps[idx];
            if (delta === 0) return;
            const dir: 1 | -1 = delta > 0 ? 1 : -1;
            for (let i = 0; i < Math.abs(delta); i++) rotatePlacement(state, dir, axis);
            placement.dragRotSteps[idx] = totalSteps;
        },
        ephemeral: true,
        instantDrags: false,
        subFrames: false,
    };
}

// 'min'/'center'/'max' are AABB corners; 'custom' is a user-specified offset.
export type PivotPreset = 'min' | 'center' | 'max' | 'custom';

// single nullable object on TransformToolState so enter/exit is one assignment.
export type PlacementState = {
    blueprint: BlueprintData;

    // 0-3 turns CW around Y; null for node-only blueprints.
    rotation: 0 | 1 | 2 | 3 | null;

    // rebuilt when rotation changes.
    rotatedBlueprint: BlueprintData;

    // gizmo pivot, held by direct reference; torn down in _destroyGhosts.
    rootNode: Node;

    // true once the user has clicked once, switches from cursor-follow to gizmo-driven.
    placed: boolean;

    // standalone voxel ghost node, or null for node-only blueprints; positioned each frame by the placement target's pose.
    voxelNode: Node | null;

    pivotPreset: PivotPreset;

    // blueprint local space, cached at enterPlacement so commit/cancel stay consistent if the store changes mid-flight.
    pivotOffset: Vec3;

    // ops to replay on cancel to restore voxels removed by a cut.
    cutReverseOps: VoxelOp[] | null;

    prevRotationSnap: number | null;
    prevTranslationSnap: number | null;

    // diffed against the proxy quaternion to fire rotatePlacement incrementally.
    dragRotSteps: [number, number, number];

    // accumulated rotation from rotatePlacement, so a sourcePrefab commit can stamp it onto the wrapper node's quaternion.
    voxelQuat: Quat;

    // lets the build tool detect a hotbar slot change mid-placement and cancel; null for ctrl+v paste.
    sourcePrefabId: string | null;

    // same slot-mismatch use as sourcePrefabId.
    sourceSceneId: string | null;
};

const _placeScratch: Vec3 = [0, 0, 0];

// (re)build the voxel ghost's mesh + tint from a blueprint's voxels; shared by enterPlacement and rotate/flipPlacement.
function _setVoxelGhostModel(voxelNode: Node, voxels: Voxels): void {
    const vmTrait = getTrait(voxelNode, VoxelMeshTrait);
    if (!vmTrait) return;
    vmTrait.model = createVoxelModel(voxels);
    vmTrait.flash = [0.3, 0.7, 1.0, 0.25];
    vmTrait.glow = 0.12;
}

// the voxel model's origin defaults to [size/2], so offset by -pivot + size/2 to sit the mesh min-corner on the commit anchor.
function _syncVoxelGhost(placement: PlacementState, rootTransform: TransformTrait): void {
    if (!placement.voxelNode) return;
    const vt = getTrait(placement.voxelNode, TransformTrait);
    if (!vt) return;
    const [sx, sy, sz] = placement.rotatedBlueprint.size;
    const [px, py, pz] = placement.pivotOffset;
    const tp = getVisualWorldPosition(rootTransform);
    _placeScratch[0] = tp[0] - px + sx * 0.5;
    _placeScratch[1] = tp[1] - py + sy * 0.5;
    _placeScratch[2] = tp[2] - pz + sz * 0.5;
    setPosition(vt, _placeScratch);
}

/** where a node lands when placed against a block face: the cell in front of the face, at its face centre or nearest corner. */
export function placePointOnFace(
    hitVoxel: [number, number, number],
    hitNormal: [number, number, number],
    hitPoint: [number, number, number] | null,
    snapTo: 'face-center' | 'corner',
): Vec3 {
    const [hx, hy, hz] = hitVoxel;
    const [nx, ny, nz] = hitNormal;
    if (snapTo === 'face-center') return [hx + nx + (nx === 0 ? 0.5 : 0), hy + ny, hz + nz + (nz === 0 ? 0.5 : 0)];
    if (hitPoint) {
        // axes across the face snap to the nearest integer corner; the normal axis takes the cell in front.
        return [
            nx !== 0 ? hx + nx : Math.round(hitPoint[0]),
            ny !== 0 ? hy + ny : Math.round(hitPoint[1]),
            nz !== 0 ? hz + nz : Math.round(hitPoint[2]),
        ];
    }
    return [hx + nx, hy + ny, hz + nz];
}

/** computes the pivot offset for a preset and blueprint size; 'custom' returns the current store value unchanged. */
export function pivotOffsetForPreset(store: EditRoomStoreApi, preset: PivotPreset, size: Vec3, voxelAligned = false): Vec3 {
    switch (preset) {
        case 'min':
            return [0, 0, 0];
        case 'center': {
            const cx = size[0] * 0.5;
            const cy = size[1] * 0.5;
            const cz = size[2] * 0.5;
            // for voxel selections, floor so the pivot stays on the voxel grid (size 3 gives offset 1, not 1.5).
            return voxelAligned ? [Math.floor(cx), Math.floor(cy), Math.floor(cz)] : [cx, cy, cz];
        }
        case 'max':
            return [size[0], size[1], size[2]];
        case 'custom':
            return [...store.getState().transformPivotOffset] as Vec3;
    }
}

/** sets the pivot preset during active placement, updating both the store and the cached state so the root ghost repositions immediately. */
export function setPlacementPivot(state: PlacementTool, preset: PivotPreset): void {
    const placement = state.current;
    if (!placement) return;

    const hasVoxels = placement.rotation !== null;
    const newOffset = pivotOffsetForPreset(state.store, preset, placement.rotatedBlueprint.size, hasVoxels);

    // reposition root ghost: keep the voxel min-corner where it is and shift the pivot.
    const t = getTrait(placement.rootNode, TransformTrait);
    if (t) {
        const [oldPx, oldPy, oldPz] = placement.pivotOffset;
        const [newPx, newPy, newPz] = newOffset;
        _placeScratch[0] = t.position[0] + (newPx - oldPx);
        _placeScratch[1] = t.position[1] + (newPy - oldPy);
        _placeScratch[2] = t.position[2] + (newPz - oldPz);
        setPosition(t, _placeScratch);
    }

    placement.pivotPreset = preset;
    placement.pivotOffset = newOffset;
    state.store.setState({ transformPivotOffset: [...newOffset] as Vec3 });
}

/** enters placement mode, creating a root ghost (gizmo pivot) and, for voxel content, a standalone synced voxel ghost. */
export function enterPlacement(
    state: PlacementTool,
    blueprint: BlueprintData,
    isCut: boolean,
    cutReverseOps: VoxelOp[] | null,
    sceneTree: SceneTree,
    _ctx: ScriptContext,
): void {
    if (state.current) return;

    const rotation: 0 | 1 | 2 | 3 = 0;
    const rotatedBlueprint = Blueprint.rotate(blueprint, rotation);

    const preset: PivotPreset = 'center';
    const pivotOffset: Vec3 = blueprint.hasVoxels
        ? pivotOffsetForPreset(state.store, preset, rotatedBlueprint.size, true)
        : [0, 0, 0];

    // root ghost: no geometry, pure gizmo pivot at blueprint.origin + pivotOffset.
    const rootNode = createNode({ name: '__placement_root', persist: false });
    addChild(sceneTree.root, rootNode);
    state._ghostNodes.add(rootNode);
    const rootTransform = addTrait(rootNode, TransformTrait);
    rootTransform.position[0] = blueprint.origin[0] + pivotOffset[0];
    rootTransform.position[1] = blueprint.origin[1] + pivotOffset[1];
    rootTransform.position[2] = blueprint.origin[2] + pivotOffset[2];

    // voxel ghost is a standalone node, not a scene tree child of root: its position is set each frame by the placement target's pose.
    let voxelNode: Node | null = null;
    if (blueprint.hasVoxels && rotatedBlueprint.voxels) {
        voxelNode = createNode({ name: '__placement_voxels', persist: false });
        addChild(sceneTree.root, voxelNode);
        state._ghostNodes.add(voxelNode);
        const voxelTransform = addTrait(voxelNode, TransformTrait);
        // root - pivotOffset + [sx/2, sy/2, sz/2]
        const [sx, sy, sz] = rotatedBlueprint.size;
        const [px, py, pz] = pivotOffset;
        voxelTransform.position[0] = rootTransform.position[0] - px + sx * 0.5;
        voxelTransform.position[1] = rootTransform.position[1] - py + sy * 0.5;
        voxelTransform.position[2] = rootTransform.position[2] - pz + sz * 0.5;

        addTrait(voxelNode, VoxelMeshTrait);
        _setVoxelGhostModel(voxelNode, rotatedBlueprint.voxels);
    }

    // deserialize each blueprint node's subtree and attach under rootNode; the engine compounds transforms at render time.
    if (blueprint.hasNodes) {
        for (const bpNode of blueprint.nodes) {
            const ghostNode = deserializeNode(bpNode);
            addChild(rootNode, ghostNode);
            _quietGhostMarkers(ghostNode);
        }
    }

    const storeSnaps = state.store.getState();
    state.current = {
        blueprint,
        rotation: blueprint.hasVoxels ? rotation : null,
        rotatedBlueprint,
        rootNode,
        placed: false,
        voxelNode,
        pivotPreset: preset,
        pivotOffset,
        cutReverseOps: isCut ? cutReverseOps : null,
        prevRotationSnap: storeSnaps.rotationSnap,
        prevTranslationSnap: storeSnaps.translationSnap,
        dragRotSteps: [0, 0, 0],
        voxelQuat: [0, 0, 0, 1],
        sourcePrefabId: null,
        sourceSceneId: null,
    };
    TransformTool.setTarget(state.gizmo, placementTarget(state));

    vec3.copy(state.gizmo.proxy.position, rootTransform.position);
    quat.copy(state.gizmo.proxy.quaternion, rootTransform.quaternion);
    vec3.set(state.gizmo.proxy.scale, 1, 1, 1);

    // voxel blueprints are forced onto the 1-voxel/90deg grid; node-only blueprints keep the user's chosen snaps.
    if (blueprint.hasVoxels) {
        state.store.setState({ rotationSnap: 90, translationSnap: 1, transformMode: 'place' });
    } else {
        state.store.setState({ transformMode: 'place' });
    }

    state.store.setState({
        activeTool: 'transform',
        placementActive: true,
        placementIsNodeOnly: !blueprint.hasVoxels,
        transformPivotOffset: [...pivotOffset] as Vec3,
    });
}

/** updates placement ghost position from a voxel raycast hit, computing positioning based on the hit face normal. */
export function updatePlacementFromRaycast(
    state: PlacementTool,
    sceneTree: SceneTree,
    hitVoxel: [number, number, number],
    hitNormal: [number, number, number],
    hitPoint: [number, number, number] | null,
): void {
    const placement = state.current;
    const [nx, ny, nz] = hitNormal;
    const [hx, hy, hz] = hitVoxel;

    // no active placement: drive currently-selected nodes from cursor, with snapTo controlling the alignment.
    if (!placement) {
        const selectedNodeIds = state.store.getState().selection.nodes;
        if (selectedNodeIds.size === 0) return;

        const [tx, ty, tz] = placePointOnFace(hitVoxel, hitNormal, hitPoint, TransformTool.effectiveSnapTo(state.store));

        let cxAvg = 0;
        let cyAvg = 0;
        let czAvg = 0;
        let count = 0;
        for (const id of selectedNodeIds) {
            const node = getNodeById(sceneTree, id);
            if (!node) continue;
            const tt = getTrait(node, TransformTrait);
            if (!tt) continue;
            cxAvg += tt.position[0];
            cyAvg += tt.position[1];
            czAvg += tt.position[2];
            count++;
        }
        if (count === 0) return;
        cxAvg /= count;
        cyAvg /= count;
        czAvg /= count;

        const dx = tx - cxAvg;
        const dy = ty - cyAvg;
        const dz = tz - czAvg;

        // first cursor-driven move in this place session: snapshot starting positions for commitPlaceSelection.
        if (state.placeSnapshots === null) {
            const snaps: TransformSnapshot[] = [];
            for (const id of selectedNodeIds) {
                const node = getNodeById(sceneTree, id);
                if (!node) continue;
                const tt = getTrait(node, TransformTrait);
                if (!tt) continue;
                snaps.push({
                    nodeId: id,
                    position: vec3.clone(tt.position),
                    quaternion: quat.clone(tt.quaternion),
                    scale: vec3.clone(tt.scale),
                });
            }
            state.placeSnapshots = snaps;
        }

        for (const id of selectedNodeIds) {
            const node = getNodeById(sceneTree, id);
            if (!node) continue;
            const tt = getTrait(node, TransformTrait);
            if (!tt) continue;
            tt.position[0] += dx;
            tt.position[1] += dy;
            tt.position[2] += dz;
            markTransformDirty(tt);
        }
        return;
    }

    const root = placement.rootNode;
    const t = getTrait(root, TransformTrait);
    if (!t) return;

    const [sx, sy, sz] = placement.rotatedBlueprint.size;
    const [px, py, pz] = placement.pivotOffset;

    // node-only prefabs have no voxel footprint (size is [0,0,0]); place a single point on the hovered face.
    if (!placement.blueprint.hasVoxels) {
        const useFaceCenter = TransformTool.effectiveSnapTo(state.store) === 'face-center';
        let qx: number;
        let qy: number;
        let qz: number;
        if (useFaceCenter) {
            qx = hx + nx + (nx === 0 ? 0.5 : 0);
            qy = hy + ny + (ny === 0 ? 0 : 0);
            qz = hz + nz + (nz === 0 ? 0.5 : 0);
        } else if (hitPoint) {
            qx = nx !== 0 ? hx + nx : Math.round(hitPoint[0]);
            qy = ny !== 0 ? hy + ny : Math.round(hitPoint[1]);
            qz = nz !== 0 ? hz + nz : Math.round(hitPoint[2]);
        } else {
            qx = hx + nx;
            qy = hy + ny;
            qz = hz + nz;
        }
        _placeScratch[0] = qx + px;
        _placeScratch[1] = qy + py;
        _placeScratch[2] = qz + pz;
        setPosition(t, _placeScratch);
        return;
    }

    // multi-cell or voxel-bearing blueprint: center on hovered face, integer-aligned.
    let minX: number;
    let minY: number;
    let minZ: number;

    if (ny === 1) {
        minX = hx - Math.floor(sx / 2);
        minY = hy + 1;
        minZ = hz - Math.floor(sz / 2);
    } else if (ny === -1) {
        minX = hx - Math.floor(sx / 2);
        minY = hy - sy;
        minZ = hz - Math.floor(sz / 2);
    } else if (nx === 1) {
        minX = hx + 1;
        minY = hy - Math.floor(sy / 2);
        minZ = hz - Math.floor(sz / 2);
    } else if (nx === -1) {
        minX = hx - sx;
        minY = hy - Math.floor(sy / 2);
        minZ = hz - Math.floor(sz / 2);
    } else if (nz === 1) {
        minX = hx - Math.floor(sx / 2);
        minY = hy - Math.floor(sy / 2);
        minZ = hz + 1;
    } else if (nz === -1) {
        minX = hx - Math.floor(sx / 2);
        minY = hy - Math.floor(sy / 2);
        minZ = hz - sz;
    } else {
        minX = hx + nx;
        minY = hy + ny;
        minZ = hz + nz;
    }

    // root position = min-corner + pivot offset; setPosition marks descendants dirty so ghost children follow next frame.
    _placeScratch[0] = minX + px;
    _placeScratch[1] = minY + py;
    _placeScratch[2] = minZ + pz;
    setPosition(t, _placeScratch);
}

/** nudges the placement ghost (root and, if present, the standalone voxel ghost) by a world-space delta. */
export function nudgePlacement(state: PlacementTool, dx: number, dy: number, dz: number): void {
    const placement = state.current;
    if (!placement) return;
    const t = getTrait(placement.rootNode, TransformTrait);
    if (!t) return;

    _placeScratch[0] = t.position[0] + dx;
    _placeScratch[1] = t.position[1] + dy;
    _placeScratch[2] = t.position[2] + dz;
    setPosition(t, _placeScratch);

    if (placement.voxelNode) {
        const vt = getTrait(placement.voxelNode, TransformTrait);
        if (vt) {
            _placeScratch[0] = vt.position[0] + dx;
            _placeScratch[1] = vt.position[1] + dy;
            _placeScratch[2] = vt.position[2] + dz;
            setPosition(vt, _placeScratch);
        }
    }
}

/** rotates the voxel content of the placement preview 90 degrees around the given axis; recomputes pivot offset for 'center'/'max' presets. */
export function rotatePlacement(state: PlacementTool, direction: 1 | -1 = 1, axis: 'x' | 'y' | 'z' = 'y'): void {
    const placement = state.current;
    if (!placement) return;
    if (placement.rotation === null) return; // node-only: use gizmo rotate mode

    const newRotatedBlueprint = Blueprint.rotateAxis(placement.rotatedBlueprint, axis, direction);

    if (placement.voxelNode && newRotatedBlueprint.voxels) {
        _setVoxelGhostModel(placement.voxelNode, newRotatedBlueprint.voxels);
    }

    // rotation only tracks Y-axis turns, used elsewhere for cardinal snap checks
    if (axis === 'y') {
        placement.rotation = ((placement.rotation + direction + 4) & 3) as 0 | 1 | 2 | 3;
    }
    placement.rotatedBlueprint = newRotatedBlueprint;

    // pre-multiply matches Blueprint.rotateAxis's composition, so wrapper.quaternion at commit reproduces the preview's rotation.
    const halfAngle = (direction * Math.PI) / 4;
    const s = Math.sin(halfAngle);
    const c = Math.cos(halfAngle);
    const stepQuat: Quat = axis === 'y' ? [0, s, 0, c] : axis === 'x' ? [s, 0, 0, c] : [0, 0, s, c];
    quat.multiply(placement.voxelQuat, stepQuat, placement.voxelQuat);

    if (placement.pivotPreset !== 'custom') {
        const newOffset = pivotOffsetForPreset(state.store, placement.pivotPreset, newRotatedBlueprint.size, true);
        const t = getTrait(placement.rootNode, TransformTrait);
        if (t) {
            const [oldPx, oldPy, oldPz] = placement.pivotOffset;
            const [newPx, newPy, newPz] = newOffset;
            _placeScratch[0] = t.position[0] + (newPx - oldPx);
            _placeScratch[1] = t.position[1] + (newPy - oldPy);
            _placeScratch[2] = t.position[2] + (newPz - oldPz);
            setPosition(t, _placeScratch);
        }
        placement.pivotOffset = newOffset;
        state.store.setState({ transformPivotOffset: [...newOffset] as Vec3 });
    }
}

export function flipPlacement(state: PlacementTool, axis: 'x' | 'y' | 'z'): void {
    const placement = state.current;
    if (!placement) return;
    if (placement.rotation === null) return; // node-only: gizmo handles it

    const newRotatedBlueprint = Blueprint.flipAxis(placement.rotatedBlueprint, axis);

    if (placement.voxelNode && newRotatedBlueprint.voxels) {
        _setVoxelGhostModel(placement.voxelNode, newRotatedBlueprint.voxels);
    }

    placement.rotatedBlueprint = newRotatedBlueprint;

    // mirror voxelQuat across the same plane so a sourcePrefab commit stamps a quaternion matching the visible preview.
    const [qx, qy, qz, qw] = placement.voxelQuat;
    if (axis === 'x') placement.voxelQuat = [qx, -qy, -qz, qw];
    else if (axis === 'y') placement.voxelQuat = [-qx, qy, -qz, qw];
    else placement.voxelQuat = [-qx, -qy, qz, qw];

    // flip preserves size, so pivot preset offsets are unchanged.
}

/** commits placement: materializes ghost content as real voxel ops + nodes, wrapped in one undo action. */
export function commitPlacement(state: PlacementTool, sceneTree: SceneTree, worldVoxels: Voxels, ctx: ScriptContext): void {
    const placement = state.current;
    if (!placement) return;

    const blueprint = placement.blueprint;
    const rotatedBlueprint = placement.rotatedBlueprint;

    const rootTransform = getTrait(placement.rootNode, TransformTrait);

    // voxel anchor = root position - pivot offset = blueprint min corner in world space
    const [px, py, pz] = placement.pivotOffset;
    const anchor: Vec3 = rootTransform
        ? [rootTransform.position[0] - px, rootTransform.position[1] - py, rootTransform.position[2] - pz]
        : [...blueprint.origin];
    const rotation: Quat = rootTransform
        ? [rootTransform.quaternion[0], rootTransform.quaternion[1], rootTransform.quaternion[2], rootTransform.quaternion[3]]
        : [0, 0, 0, 1];

    // prefab-source path emits one wrapper node carrying the prefab config so the runtime re-instantiates contents on the real node.
    const sourcePrefab = blueprint.sourcePrefab;
    const wrapperQuat: Quat = sourcePrefab ? quat.multiply(quat.create(), rotation, placement.voxelQuat) : rotation;

    // capture before clearing state; sourcePrefabId is restored after the continuous re-enter below.
    const cutReverseOps = placement.cutReverseOps;
    const isCut = cutReverseOps !== null;
    const sourcePrefabId = placement.sourcePrefabId;

    // voxel ops + per-entry node data only apply on the non-prefab (concretize) path
    const voxelForward: VoxelOp[] = [];
    const voxelReverse: VoxelOp[] = [];
    const nodePasteEntries: SerializedNode[] = [];
    if (!sourcePrefab) {
        const ops = Blueprint.buildPasteOps(rotatedBlueprint, anchor, worldVoxels);
        voxelForward.push(...ops.forward);
        voxelReverse.push(...ops.reverse);
        // rotatedBlueprint carries rotatePlacement's rotation into child nodes.
        const paste = Blueprint.buildNodePaste(rotatedBlueprint, anchor, rotation);
        nodePasteEntries.push(...paste.entries);
    }

    // destroy ghosts before pushing undo so redo can recreate them
    _destroyGhosts(state);
    _exitPlacementState(state);

    // allocate node ids upfront so do/undo/redo all reference the same nodes.
    const createdIds: number[] = [];
    const wrapperEntryCount = sourcePrefab ? 1 : nodePasteEntries.length;
    for (let i = 0; i < wrapperEntryCount; i++) {
        createdIds.push(sceneTree.nextServerId++);
    }

    state.store.getState().action({
        label: isCut ? 'cut-paste' : sourcePrefab ? 'place-prefab' : 'paste',
        do() {
            if (sourcePrefab) {
                send(ctx, CreateNodeCommand, {
                    id: createdIds[0]!,
                    parentId: sceneTree.root.id,
                    index: sceneTree.root.children.length,
                    name: sourcePrefab.prefabId,
                    persist: true,
                    traits: JSON.stringify([
                        {
                            id: 'transform',
                            controls: {
                                position: [anchor[0], anchor[1], anchor[2]],
                                quaternion: [wrapperQuat[0], wrapperQuat[1], wrapperQuat[2], wrapperQuat[3]],
                                scale: [1, 1, 1],
                            },
                        },
                    ]),
                    children: JSON.stringify([]),
                    prefab: JSON.stringify(sourcePrefab),
                });
                return;
            }
            if (voxelForward.length > 0) {
                commitVoxelOps(ctx, voxelForward);
            }
            // buildNodePaste already re-anchored each entry's top-level transform to world space.
            for (let i = 0; i < nodePasteEntries.length; i++) {
                const entry = nodePasteEntries[i]!;
                send(ctx, CreateNodeCommand, {
                    id: createdIds[i]!,
                    parentId: sceneTree.root.id,
                    index: sceneTree.root.children.length,
                    name: entry.name,
                    persist: true,
                    traits: JSON.stringify(entry.traits),
                    children: JSON.stringify(entry.children),
                    prefab: entry.prefab ? JSON.stringify(entry.prefab) : undefined,
                });
            }
        },
        undo() {
            if (voxelReverse.length > 0) {
                commitVoxelOps(ctx, voxelReverse);
            }
            if (isCut && cutReverseOps && cutReverseOps.length > 0) {
                commitVoxelOps(ctx, cutReverseOps);
            }
            // server cascades child destruction
            for (const id of createdIds) {
                const n = getNodeById(sceneTree, id);
                if (n) destroyNode(sceneTree, n);
                send(ctx, DestroyNodeCommand, { id });
            }
        },
    });

    // re-arm with the same blueprint so the next click drops another instance
    if (state.store.getState().placementContinuous) {
        const reBlueprint: BlueprintData = { ...blueprint, origin: [anchor[0], anchor[1], anchor[2]] };
        enterPlacement(state, reBlueprint, false, null, sceneTree, ctx);
        if (state.current) state.current.sourcePrefabId = sourcePrefabId;
        return;
    }

    // what landed is the selection: the created nodes, or the pasted cells.
    const landed = Selection.withNodes(Selection.create(), createdIds);
    if (!sourcePrefab) {
        for (const op of voxelForward) if (op.key !== BLOCK_AIR) Selection.set(landed, op.wx, op.wy, op.wz);
    }
    state.store.setState({ activeTool: 'inspect', selection: landed });
}

/** cancels placement: destroys ghosts and restores cut content if applicable. */
export function cancelPlacement(state: PlacementTool, ctx: ScriptContext): void {
    if (!state.current) return;

    const cutReverseOps = state.current.cutReverseOps;
    _destroyGhosts(state);
    _exitPlacementState(state);

    // a cancelled cut puts the cells back, and they stay selected the way they were before the cut.
    const restored = Selection.create();
    if (cutReverseOps && cutReverseOps.length > 0) {
        commitVoxelOps(ctx, cutReverseOps);
        for (const op of cutReverseOps) if (op.key !== BLOCK_AIR) Selection.set(restored, op.wx, op.wy, op.wz);
    }

    state.store.setState({ activeTool: 'inspect', selection: restored, placementContinuous: false });
}

/** reverts place-mode-with-selection cursor-follow back to the snapshot positions; no history entry is created. */
export function revertPlaceSelection(state: PlacementTool, sceneTree: SceneTree): void {
    const snaps = state.placeSnapshots;
    state.placeSnapshots = null;
    if (!snaps) return;
    for (const s of snaps) {
        const node = getNodeById(sceneTree, s.nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        vec3.copy(t.position, s.position);
        markTransformDirty(t);
    }
}

/** commits cursor-follow position changes from place-mode-with-selection as a do/undo entry; no-op when nothing moved. */
export function commitPlaceSelection(state: PlacementTool, sceneTree: SceneTree, ctx: ScriptContext): void {
    const prevSnapshots = state.placeSnapshots;
    state.placeSnapshots = null;
    if (!prevSnapshots || prevSnapshots.length === 0) return;

    const finals: TransformSnapshot[] = [];
    let changed = false;
    for (const snap of prevSnapshots) {
        const node = getNodeById(sceneTree, snap.nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        finals.push({
            nodeId: snap.nodeId,
            position: vec3.clone(t.position),
            quaternion: quat.clone(t.quaternion),
            scale: vec3.clone(t.scale),
        });
        if (t.position[0] !== snap.position[0] || t.position[1] !== snap.position[1] || t.position[2] !== snap.position[2]) {
            changed = true;
        }
    }
    if (!changed || finals.length === 0) return;

    state.store.getState().action({
        label: 'place',
        do() {
            for (const f of finals) {
                const n = getNodeById(sceneTree, f.nodeId);
                if (!n) continue;
                const props = {
                    position: vec3.clone(f.position),
                    quaternion: quat.clone(f.quaternion),
                    scale: vec3.clone(f.scale),
                };
                setTraitProps(sceneTree, n, 'transform', props);
                send(ctx, SetTraitCommand, { id: f.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            }
        },
        undo() {
            for (const s of prevSnapshots) {
                const n = getNodeById(sceneTree, s.nodeId);
                if (!n) continue;
                const props = {
                    position: vec3.clone(s.position),
                    quaternion: quat.clone(s.quaternion),
                    scale: vec3.clone(s.scale),
                };
                setTraitProps(sceneTree, n, 'transform', props);
                send(ctx, SetTraitCommand, { id: s.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            }
        },
    });
}

/** enters placement mode for a prefab, snapshotting its instantiated voxels and child nodes into a Blueprint fed through the standard placement path. */
export function enterPrefabPlacement(
    state: PlacementTool,
    prefabId: string,
    anchor: Vec3,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    if (state.current !== null) return;

    const runtime = ctx._runtime;
    if (!runtime) return;

    const blueprint = Blueprint.createPrefabBlueprint(prefabId, anchor, runtime, ctx.blocks);
    if (!blueprint) return;

    enterPlacement(state, blueprint, false, null, sceneTree, ctx);
    // enterPlacement always installs state.current on success; the assertion bypasses TS narrowing from the bail-check above.
    const placement = state.current as PlacementState | null;
    if (placement) placement.sourcePrefabId = prefabId;
}

/** enters placement mode for a saved blueprint scene; unlike prefabs, it pastes raw nodes + voxels with no source linkage. */
export function enterBlueprintPlacement(
    state: PlacementTool,
    sceneId: string,
    anchor: Vec3,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    if (state.current !== null) return;
    const blueprint = Blueprint.createSceneBlueprint(sceneId, anchor, ctx.blocks);
    if (!blueprint) return;
    enterPlacement(state, blueprint, false, null, sceneTree, ctx);
    const placement = state.current as PlacementState | null;
    if (placement) placement.sourceSceneId = sceneId;
}

/** true when placement mode is currently active */
export function isInPlacement(state: PlacementTool): boolean {
    return state.current !== null;
}

/** true when placement contains voxel data (rotation must go through rotatePlacement, not quaternion) */
export function isVoxelPlacement(state: PlacementTool): boolean {
    return state.current !== null && state.current.rotation !== null;
}

// a freshly deserialized ghost subtree is a preview: its markers stay quiet until the placement commits into real nodes.
function _quietGhostMarkers(node: Node): void {
    const marker = getTrait(node, MarkerTrait);
    if (marker) marker.enabled = false;
    for (const child of node.children) _quietGhostMarkers(child);
}

function _destroyGhosts(state: PlacementTool): void {
    TransformTool.detachGizmo(state.gizmo);

    // destroy by object identity via each node's own scene pointer; destroyNode recurses into children.
    for (const node of state._ghostNodes) {
        if (node.scene) destroyNode(node.scene, node);
    }
    state._ghostNodes.clear();
}

/** per-frame backstop that reaps ghost nodes when a path drops `state.current` without a clean teardown. */
export function reconcilePlacementGhosts(state: PlacementTool): void {
    if (state.current === null && state._ghostNodes.size > 0) {
        _destroyGhosts(state);
    }
}

function _exitPlacementState(state: PlacementTool): void {
    const placement = state.current;
    if (!placement) return;

    // restore snaps that were overridden in enterPlacement (only for voxel blueprints)
    if (placement.blueprint.hasVoxels) {
        state.store.setState({
            rotationSnap: placement.prevRotationSnap ?? null,
            translationSnap: placement.prevTranslationSnap ?? null,
        });
    }
    state.current = null;
    TransformTool.setTarget(state.gizmo, null);
    state.store.setState({ transformPivotOffset: [0, 0, 0], placementActive: false, placementIsNodeOnly: false });
}

// physgun-style grab: holding left mouse creates a transient dynamic body driven by a PD controller toward a camera-relative anchor.

/** the placement keys: mode switches pin the ghost, Enter commits, Escape cancels, arrows and [ ] nudge or step-rotate, P cycles the pivot. */
export function handleKeys(
    state: PlacementTool,
    mk: MouseKeyboardInput,
    input: Input,
    cameraQuat: Quat,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    const placement = state.current!;
    // Q/T/Y switch to gizmo mode (pins ghost, marks placed)
    if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.translate)) {
        placement.placed = true;
        state.store.setState({ transformMode: 'translate' });
    } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.rotate)) {
        placement.placed = true;
        state.store.setState({ transformMode: 'rotate' });
    } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.scale)) {
        placement.placed = true;
        state.store.setState({ transformMode: 'scale' });
    } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.place)) {
        state.store.setState({ transformMode: 'place' });
    }

    // Enter commits placement
    if (isKeyJustDown(mk, 'Enter')) {
        commitPlacement(state, sceneTree, ctx.voxels, ctx);
    }

    // Escape cancels placement (restores cut voxels if applicable)
    if (isKeyJustDown(mk, 'Escape')) {
        cancelPlacement(state, ctx);
    }

    // arrow keys + [ / ] do a mode-aware nudge during placement
    {
        const { transformMode: plMode } = state.store.getState();

        if (plMode === 'place' || plMode === 'translate') {
            // position nudge (placement ghost or pinned translate)
            const nudge = readNudgeDelta(input, cameraQuat);
            if (nudge) {
                if (plMode === 'place') {
                    // pin ghost and switch to translate on nudge
                    placement.placed = true;
                    state.store.setState({ transformMode: 'translate' });
                }
                nudgePlacement(state, nudge[0], nudge[1], nudge[2]);
            }
        } else if (plMode === 'rotate') {
            if (isVoxelPlacement(state)) {
                // rotate voxel data in 90-deg steps, camera-relative: left/right is always Y, forward/backward and [/] are camera axes.
                const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
                const [fwdX, fwdZ] = snapCardinal(yaw);
                // camera-forward aligns with X when fwdX != 0, else Z
                const fwdAxis: 'x' | 'z' = fwdX !== 0 ? 'x' : 'z';
                const rgtAxis: 'x' | 'z' = fwdX !== 0 ? 'z' : 'x';
                // flip rotation direction when facing negative so tilt/roll feel consistent regardless of view angle.
                const fwdSign = (fwdX !== 0 ? fwdX : fwdZ) as 1 | -1;
                const rgtSign = (fwdX !== 0 ? -fwdX : fwdZ) as 1 | -1;

                if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
                    rotatePlacement(state, 1, 'y');
                } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                    rotatePlacement(state, -1, 'y');
                } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                    rotatePlacement(state, (1 * rgtSign) as 1 | -1, rgtAxis);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                    rotatePlacement(state, (-1 * rgtSign) as 1 | -1, rgtAxis);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    rotatePlacement(state, (1 * fwdSign) as 1 | -1, fwdAxis);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    rotatePlacement(state, (-1 * fwdSign) as 1 | -1, fwdAxis);
                }
            } else {
                // node-only placement: quaternion rotation via nudge
                const snapDeg = state.store.getState().rotationSnap ?? 45;
                const snap = snapDeg * (Math.PI / 180);
                const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
                const [fwdX, fwdZ] = snapCardinal(yaw);
                const rgtX = fwdZ,
                    rgtZ = -fwdX;

                if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [0, 1, 0], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [0, 1, 0], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [rgtX, 0, rgtZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [rgtX, 0, rgtZ], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [fwdX, 0, fwdZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    TransformTool.rotateNodes(state.gizmo, sceneTree, ctx, [fwdX, 0, fwdZ], -snap);
                }
            }
        } else if (plMode === 'scale') {
            const snap = state.store.getState().scaleSnap ?? 0.25;
            if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                TransformTool.scaleNodes(state.gizmo, sceneTree, ctx, 1 + snap);
            } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                TransformTool.scaleNodes(state.gizmo, sceneTree, ctx, 1 / (1 + snap));
            }
        }
    }
}
