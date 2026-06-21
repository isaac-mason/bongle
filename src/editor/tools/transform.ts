// tools/transform.ts — gizmo-based transform tool for scene nodes + placement mode.
//
// two responsibilities:
//
//   1. normal transform: gizmo attaches to a proxy Object3D whose position/
//      rotation/scale mirrors the selected node(s). deltas are applied back to
//      the real TransformTraits each frame. undo snapshot on mouseDown, commit
//      on mouseUp.
//
//   2. placement mode: creates client-local ghost
//      nodes in the scene graph, points selectedNodeIds at the root ghost pivot,
//      and the existing gizmo machinery drives the ghost just like a real node.
//      on commit, ghost positions are materialized as voxel ops + real nodes.
//      on cancel, ghosts are destroyed and cut ops are reversed.

import { box, dof, MotionType, rigidBody, type BodyId } from 'crashcat';
import type { PerspectiveCamera } from 'gpucat';
import { Object3D, type Scene, TransformControls } from 'gpucat';
import { box3, type Box3, type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { TransformTrait } from '../../builtins/transform';
import { createVoxelModel, VoxelMeshTrait } from '../../builtins/voxel-mesh';
import type { Input, MouseKeyboardInput } from '../../client/input';
import { isKeyJustDown } from '../../client/input';
import type { Physics } from '../../core/physics/physics';
import { OBJECT_LAYER_NODE_MOVING } from '../../core/physics/physics';
import { registry } from '../../core/registry';
import type { Resources } from '../../core/resources';
import type { Node, Nodes, SerializedNode } from '../../core/scene/nodes';
import { addChild, addTrait, createNode, deserializeNode, destroyNode, getNodeById, getTrait } from '../../core/scene/nodes';
import { prefabHasVoxels } from '../../core/scene/prefab';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { getVisualWorldPosition, getVisualWorldQuaternion, markTransformDirty, setPosition } from '../../builtins/transform';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import { setTraitProps } from '../actions';
import type { Blueprint as BlueprintData, VoxelOp } from '../blueprint';
import * as Blueprint from '../blueprint';
import { readNudgeDelta, snapCardinal, yawFromQuat } from '../camera';
import { CreateNodeCommand, DestroyNodeCommand, SetTraitCommand, VoxelEditCommand } from '../commands';
import { NUDGE_KEYS, TRANSFORM_GIZMO_KEYS, TRANSFORM_OTHER_KEYS } from '../editor-controls';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { unionSubtreeWorldAabb } from '../node-aabb';
import * as Selection from '../../core/scene/selection';

// ── types ──────────────────────────────────────────────────────────

type TransformSnapshot = {
    nodeId: number;
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
};

// pivot preset — controls where the gizmo sits relative to the blueprint.
// 'min'    → [0, 0, 0]           (min corner of voxel AABB)
// 'center' → [sx/2, sy/2, sz/2]  (center of voxel AABB)
// 'max'    → [sx, sy, sz]         (max corner of voxel AABB)
// 'custom' → arbitrary user-specified offset
export type PivotPreset = 'min' | 'center' | 'max' | 'custom';

// all placement-mode state. lives as a single nullable object on
// TransformToolState so enter/exit is one assignment and read sites can
// destructure once at the top.
export type PlacementState = {
    // the blueprint being placed (original, pre-rotation)
    blueprint: BlueprintData;

    // current rotation of voxel content (0-3 turns CW around Y).
    // null when blueprint has no voxels (node-only can use gizmo rotate freely).
    rotation: 0 | 1 | 2 | 3 | null;

    // the voxel-rotated blueprint variant (rebuilt when rotation changes)
    rotatedBlueprint: BlueprintData;

    // root ghost node id — the single pivot the gizmo attaches to.
    rootId: number;

    // whether we've placed (clicked once) - switches from following cursor to gizmo-driven
    placed: boolean;

    // separate standalone node holding VoxelMeshTrait for the voxel ghost.
    // NOT a scene-graph child of root — its interpolatedPosition is set manually
    // each frame in _syncProxyFromPlacementRoot.
    voxelNodeId: number | null;

    // pivot preset active when placement was entered (recomputed after rotation)
    pivotPreset: PivotPreset;

    // pivot offset in blueprint local space at the time of enterPlacement.
    // cached here so commit/cancel are consistent even if store changes mid-flight.
    pivotOffset: Vec3;

    // for cut operations: ops to replay on cancel to restore original voxels
    cutReverseOps: VoxelOp[] | null;

    // rotation snap value before placement started (restored on exit)
    prevRotationSnap: number | null;

    // translation snap value before placement started (restored on exit)
    prevTranslationSnap: number | null;

    // tracks how many 90-deg voxel rotations have been applied per axis during the current gizmo drag.
    // used to diff against the proxy quaternion and fire rotatePlacement incrementally.
    dragRotSteps: [number, number, number];

    // accumulated rotation from rotatePlacement key/drag input (x/y/z 90-deg steps).
    // applied to voxels via Blueprint.rotateAxis for the preview; carried here so a
    // sourcePrefab commit can stamp the same rotation onto the wrapper node's
    // quaternion (the reconciler then rotates the prefab content to match).
    voxelQuat: Quat;

    // when entered via enterPrefabPlacement, the prefab id used to bake the
    // blueprint. lets the build tool detect when the active hotbar slot has
    // changed mid-placement and cancel cleanly. null for ctrl+v paste.
    sourcePrefabId: string | null;

    // when entered via enterBlueprintPlacement, the scene id of the saved
    // blueprint. used by the same slot-mismatch check as sourcePrefabId.
    sourceSceneId: string | null;
};

// transient grab-mode state. lives on TransformToolState as a single nullable
// object so enter/exit are one assignment. the body is created directly in
// the physics world (not via RigidBodyTrait) — gone the moment grab ends.
export type GrabState = {
    nodeId: number;
    bodyId: BodyId;
    // distance along camera forward to the held anchor point.
    grabDistance: number;
    // body→target offset expressed in camera space at grab-start, so the
    // grabbed object stays in the same screen-relative spot as we look around.
    anchorOffsetCS: Vec3;
    // body orientation in camera space at grab-start, so the relative rotation
    // (body's "facing direction") is preserved as we look around. pitch/roll
    // are physically locked by the body's allowedDegreesOfFreedom — the
    // controller still targets the full camera orientation; the rigid body
    // just refuses to rotate on locked axes.
    anchorQuatCS: Quat;
    // pivot offset in body-local space: the constant that, rotated by the
    // body's current quaternion, gives the world-space delta from body
    // center to the node's transform.position. preserves off-center pivots
    // through rotations when writing body pose → trait each frame.
    pivotOffsetLocal: Vec3;
    // start transform for the undo entry on release.
    snapshot: TransformSnapshot;
    // gmod-physgun-style free-rotate: while true, mouse dx/dy drives the
    // body's orientation directly via targetQuat instead of following the
    // camera. body's allowedDegreesOfFreedom is widened to all axes during
    // this state, restored to the resting yaw-lock on release.
    rotating: boolean;
    // user-driven target orientation while rotating. seeded from body.quat
    // on rotate-begin, accumulated via mouse delta each frame.
    targetQuat: Quat;
};

export type TransformToolState = {
    store: EditRoomStoreApi;
    gizmo: TransformControls;
    proxy: Object3D;
    scene: Scene;

    // whether proxy is currently attached to the gizmo
    gizmoAttached: boolean;

    // snapshot captured on drag start
    snapshots: TransformSnapshot[];

    // proxy transform at drag start (for computing deltas)
    proxyStartPosition: Vec3;
    proxyStartQuaternion: Quat;
    proxyStartScale: Vec3;

    // topic unsubscribe handles
    _unsubs: (() => void)[];

    // whether we're currently mid-drag
    dragging: boolean;

    // null when not in placement mode. set as one assignment in enterPlacement,
    // cleared as one assignment in _exitPlacementState.
    placement: PlacementState | null;

    // null when no node is currently grabbed.
    grab: GrabState | null;

    // cumulative 90-deg rotation steps (per axis) applied during the current
    // gizmo drag when rotation is forced to cardinal snap. derived from the
    // proxy delta quaternion each frame; reset on drag start.
    dragRotSteps: [number, number, number];

    // snapshots captured on first cursor-driven move in place-mode-with-selection
    // (the no-ghost branch of updatePlacementFromRaycast). null otherwise.
    // committed to history + persisted via commitPlaceSelection on exit.
    placeSnapshots: TransformSnapshot[] | null;
};

// ── create / dispose ───────────────────────────────────────────────

// note: `store` is patched in by the caller right after construction —
// the closures below access `state.store` only on user interaction (gizmo
// drag, grab handle), never synchronously during create. This lets the
// edit-room store reference transformToolState in its closures without a
// circular-dependency hazard.
//
// the gizmo holds its own `camera` ref (third-party TransformControls);
// callers must keep `state.gizmo.camera` pointed at the active control
// camera each frame so POV swaps don't strand the gizmo on a stale ref.
// per-call camera params on enterGrab/prePhysicsGrab/etc. avoid a second
// stale mirror on TransformToolState itself.
export function createTransformTool(
    camera: PerspectiveCamera,
    canvas: HTMLElement,
    scene: Scene,
    nodes: Nodes,
    ctx: ScriptContext,
): TransformToolState {
    const proxy = new Object3D();
    // proxy must be in the scene so gizmo can read parent world matrix
    scene.add(proxy);

    const gizmo = new TransformControls(camera, canvas);
    scene.add(gizmo.getHelper());

    const state: TransformToolState = {
        store: null as unknown as EditRoomStoreApi,
        gizmo,
        proxy,
        scene,
        gizmoAttached: false,
        snapshots: [],
        proxyStartPosition: vec3.create(),
        proxyStartQuaternion: quat.create(),
        proxyStartScale: vec3.fromValues(1, 1, 1),
        _unsubs: [],
        dragging: false,
        placement: null,
        grab: null,
        dragRotSteps: [0, 0, 0],
        placeSnapshots: null,
    };

    // on drag start: snapshot selected node transforms
    const unsubDown = gizmo.onMouseDown.add(() => {
        state.dragging = true;

        // on first click in placement mode, mark as placed and sync proxy position
        if (state.placement && !state.placement.placed) {
            state.placement.placed = true;
            const root = getNodeById(nodes, state.placement.rootId);
            if (root) {
                const t = getTrait(root, TransformTrait);
                if (t) {
                    vec3.copy(state.proxy.position, getVisualWorldPosition(t));
                    quat.copy(state.proxy.quaternion, getVisualWorldQuaternion(t));
                    vec3.set(state.proxy.scale, 1, 1, 1);
                }
            }
        }

        const nodeIds = _activeNodeIds(state);
        state.snapshots = [];
        for (const nodeId of nodeIds) {
            const node = getNodeById(nodes, nodeId);
            if (!node) continue;
            const t = getTrait(node, TransformTrait);
            if (!t) continue;
            state.snapshots.push({
                nodeId,
                position: vec3.clone(t.position),
                quaternion: quat.clone(t.quaternion),
                scale: vec3.clone(t.scale),
            });
        }
        vec3.copy(state.proxyStartPosition, proxy.position);
        quat.copy(state.proxyStartQuaternion, proxy.quaternion);
        vec3.copy(state.proxyStartScale, proxy.scale);
        state.dragRotSteps[0] = 0;
        state.dragRotSteps[1] = 0;
        state.dragRotSteps[2] = 0;
        if (state.placement) state.placement.dragRotSteps = [0, 0, 0];
    });

    // during drag: apply delta from proxy back to nodes
    const unsubChange = gizmo.onObjectChange.add(() => {
        if (!state.dragging) return;

        const mode = gizmo.mode;

        if (mode === 'translate') {
            // snapTo pins translated nodes to either the integer voxel grid (corner)
            // or block-top centers (face-center: X/Z to integer+0.5, Y to integer).
            // applies to both placement ghosts and committed selections.
            const useFaceCenter = _effectiveSnapTo(state) === 'face-center';

            const dx = proxy.position[0] - state.proxyStartPosition[0];
            const dy = proxy.position[1] - state.proxyStartPosition[1];
            const dz = proxy.position[2] - state.proxyStartPosition[2];

            for (const snap of state.snapshots) {
                const node = getNodeById(nodes, snap.nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;
                let nx = snap.position[0] + dx;
                let ny = snap.position[1] + dy;
                let nz = snap.position[2] + dz;
                if (useFaceCenter) {
                    nx = Math.floor(nx) + 0.5;
                    ny = Math.round(ny);
                    nz = Math.floor(nz) + 0.5;
                }
                t.position[0] = nx;
                t.position[1] = ny;
                t.position[2] = nz;
                markTransformDirty(t);
            }
        } else if (mode === 'rotate') {
            const invStart: Quat = quat.create();
            quat.invert(invStart, state.proxyStartQuaternion);
            const deltaQ: Quat = quat.create();
            quat.multiply(deltaQ, proxy.quaternion, invStart);

            // snap rotation to 90deg increments whenever voxel content is in
            // play — raw voxels can only sit on the integer grid in cardinal
            // orientations. covers both placement and selected voxel-bearing
            // prefab nodes (gizmo on already-placed instance).
            const snapToCardinal = state.placement
                ? state.placement.rotation !== null
                : state.store.getState().transformHasVoxels;

            if (snapToCardinal) {
                // extract per-axis angles from the delta quaternion. the gizmo
                // constrains to one axis at a time, so usually only one
                // component is significant — check all three to be robust.
                const axes: Array<{ axis: 'x' | 'y' | 'z'; idx: 0 | 1 | 2 }> = [
                    { axis: 'x', idx: 0 },
                    { axis: 'y', idx: 1 },
                    { axis: 'z', idx: 2 },
                ];
                for (const { idx } of axes) {
                    const angle = 2 * Math.atan2(deltaQ[idx], deltaQ[3]);
                    state.dragRotSteps[idx] = Math.round(angle / (Math.PI / 2));
                }

                if (state.placement && state.placement.rotation !== null) {
                    // placement: rebuild blueprint per-step via rotatePlacement.
                    // tracked separately on placement.dragRotSteps because each
                    // call mutates the blueprint and must fire incrementally.
                    const placement = state.placement;
                    for (const { axis, idx } of axes) {
                        const totalSteps = state.dragRotSteps[idx];
                        const delta = totalSteps - placement.dragRotSteps[idx];
                        if (delta !== 0) {
                            const dir = delta > 0 ? 1 : -1;
                            const count = Math.abs(delta);
                            for (let i = 0; i < count; i++) {
                                rotatePlacement(state, nodes, dir as 1 | -1, axis);
                            }
                            placement.dragRotSteps[idx] = totalSteps;
                        }
                    }
                    quat.copy(proxy.quaternion, state.proxyStartQuaternion);
                    for (const snap of state.snapshots) {
                        const node = getNodeById(nodes, snap.nodeId);
                        if (!node) continue;
                        const t = getTrait(node, TransformTrait);
                        if (!t) continue;
                        quat.copy(t.quaternion, snap.quaternion);
                        markTransformDirty(t);
                    }
                    return;
                }

                // selected voxel-bearing nodes: build absolute snapped delta
                // from cumulative steps and apply against snapshot baseline.
                const snappedDelta: Quat = quat.create();
                const tmpQ: Quat = quat.create();
                const AXES: Vec3[] = [
                    [1, 0, 0],
                    [0, 1, 0],
                    [0, 0, 1],
                ];
                for (const { idx } of axes) {
                    const steps = state.dragRotSteps[idx];
                    if (steps === 0) continue;
                    quat.setAxisAngle(tmpQ, AXES[idx]!, steps * (Math.PI / 2));
                    quat.multiply(snappedDelta, tmpQ, snappedDelta);
                }

                for (const snap of state.snapshots) {
                    const node = getNodeById(nodes, snap.nodeId);
                    if (!node) continue;
                    const t = getTrait(node, TransformTrait);
                    if (!t) continue;
                    const rel: Vec3 = vec3.create();
                    vec3.subtract(rel, snap.position, state.proxyStartPosition);
                    vec3.transformQuat(rel, rel, snappedDelta);
                    t.position[0] = state.proxyStartPosition[0] + rel[0];
                    t.position[1] = state.proxyStartPosition[1] + rel[1];
                    t.position[2] = state.proxyStartPosition[2] + rel[2];
                    quat.multiply(t.quaternion, snappedDelta, snap.quaternion);
                    markTransformDirty(t);
                }

                // reset proxy: gizmo handle stays at start while objects snap
                quat.copy(proxy.quaternion, state.proxyStartQuaternion);

                return;
            }

            for (const snap of state.snapshots) {
                const node = getNodeById(nodes, snap.nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;

                // rotate position around pivot
                const rel: Vec3 = vec3.create();
                vec3.subtract(rel, snap.position, state.proxyStartPosition);
                vec3.transformQuat(rel, rel, deltaQ);
                t.position[0] = state.proxyStartPosition[0] + rel[0];
                t.position[1] = state.proxyStartPosition[1] + rel[1];
                t.position[2] = state.proxyStartPosition[2] + rel[2];

                quat.multiply(t.quaternion, deltaQ, snap.quaternion);
                markTransformDirty(t);
            }
        } else if (mode === 'scale') {
            const sx = proxy.scale[0] / state.proxyStartScale[0];
            const sy = proxy.scale[1] / state.proxyStartScale[1];
            const sz = proxy.scale[2] / state.proxyStartScale[2];

            for (const snap of state.snapshots) {
                const node = getNodeById(nodes, snap.nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;

                const rel: Vec3 = vec3.create();
                vec3.subtract(rel, snap.position, state.proxyStartPosition);
                t.position[0] = state.proxyStartPosition[0] + rel[0] * sx;
                t.position[1] = state.proxyStartPosition[1] + rel[1] * sy;
                t.position[2] = state.proxyStartPosition[2] + rel[2] * sz;

                t.scale[0] = snap.scale[0] * sx;
                t.scale[1] = snap.scale[1] * sy;
                t.scale[2] = snap.scale[2] * sz;
                markTransformDirty(t);
            }
        }

    });

    // on drag end: commit undo action + send to server (normal mode only)
    const unsubUp = gizmo.onMouseUp.add(() => {
        state.dragging = false;
        if (state.snapshots.length === 0) return;

        // placement drags are ephemeral — no undo entry until commit
        if (state.placement) return;

        const finals: TransformSnapshot[] = [];
        for (const snap of state.snapshots) {
            const node = getNodeById(nodes, snap.nodeId);
            if (!node) continue;
            const t = getTrait(node, TransformTrait);
            if (!t) continue;
            finals.push({
                nodeId: snap.nodeId,
                position: vec3.clone(t.position),
                quaternion: quat.clone(t.quaternion),
                scale: vec3.clone(t.scale),
            });
        }

        const prevSnapshots = [...state.snapshots];

        state.store.getState().action({
            label: `transform ${gizmo.mode}`,
            do() {
                for (const f of finals) {
                    const n = getNodeById(nodes, f.nodeId);
                    if (!n) continue;
                    const props = {
                        position: vec3.clone(f.position),
                        quaternion: quat.clone(f.quaternion),
                        scale: vec3.clone(f.scale),
                    };
                    setTraitProps(nodes, n, 'transform', props);
                    send(ctx, SetTraitCommand, {
                        id: f.nodeId,
                        traitId: 'transform',
                        props: JSON.stringify(props),
                    });
                }
                state.store.getState().markDirty();
            },
            undo() {
                for (const s of prevSnapshots) {
                    const n = getNodeById(nodes, s.nodeId);
                    if (!n) continue;
                    const props = {
                        position: vec3.clone(s.position),
                        quaternion: quat.clone(s.quaternion),
                        scale: vec3.clone(s.scale),
                    };
                    setTraitProps(nodes, n, 'transform', props);
                    send(ctx, SetTraitCommand, {
                        id: s.nodeId,
                        traitId: 'transform',
                        props: JSON.stringify(props),
                    });
                }
                state.store.getState().markDirty();
            },
        });

        state.snapshots = [];
    });

    state._unsubs.push(unsubDown, unsubChange, unsubUp);

    return state;
}

export function disposeTransformTool(state: TransformToolState): void {
    for (const unsub of state._unsubs) unsub();
    state._unsubs.length = 0;

    if (state.gizmoAttached) {
        state.gizmo.detach();
        state.gizmoAttached = false;
    }
    state.gizmo.disconnect();
    state.scene.remove(state.gizmo.getHelper());
    state.gizmo.dispose();
    state.scene.remove(state.proxy);
}

// ── per-frame update ───────────────────────────────────────────────

const _centroid: Vec3 = [0, 0, 0];
const _placeScratch: Vec3 = [0, 0, 0];

/**
 * sync the gizmo with the current selection (or placement root) and store settings.
 * call every frame while activeTool === 'transform'.
 *
 * returns the current pivot world position so the caller can pass it to updatePivotDot.
 */
export function updateTransformTool(state: TransformToolState, nodes: Nodes): Vec3 | null {
    const storeState = state.store.getState();
    const { transformMode, transformSpace, translationSnap, rotationSnap, scaleSnap } = storeState;

    // place mode: no gizmo, ghost follows cursor (driven externally via updatePlacementFromRaycast)
    if (transformMode === 'place') {
        _detachGizmo(state);

        // in placement mode, still sync the voxel ghost position
        const placement = state.placement;
        if (placement) {
            const root = getNodeById(nodes, placement.rootId);
            if (root) {
                const t = getTrait(root, TransformTrait);
                if (t) {
                    // sync voxel ghost
                    if (placement.voxelNodeId !== null) {
                        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
                        if (voxelNode) {
                            const vt = getTrait(voxelNode, TransformTrait);
                            if (vt) {
                                const [sx, sy, sz] = placement.rotatedBlueprint.size;
                                const [px, py, pz] = placement.pivotOffset;
                                const tp = getVisualWorldPosition(t);
                                _placeScratch[0] = tp[0] - px + sx * 0.5;
                                _placeScratch[1] = tp[1] - py + sy * 0.5;
                                _placeScratch[2] = tp[2] - pz + sz * 0.5;
                                setPosition(vt, _placeScratch);
                            }
                        }
                    }
                    return [...getVisualWorldPosition(t)] as Vec3;
                }
            }
        }
        return null;
    }

    // grab mode: no gizmo. body+pose driven by updateGrab() called separately.
    if (transformMode === 'grab') {
        _detachGizmo(state);
        const grab = state.grab;
        if (grab) {
            const node = getNodeById(nodes, grab.nodeId);
            const t = node ? getTrait(node, TransformTrait) : null;
            if (t) return [...getVisualWorldPosition(t)] as Vec3;
        }
        return null;
    }

    // sync gizmo settings from store. when voxel content is involved (placement
    // blueprint or selected voxel-bearing prefab) force grid-aligned snaps and
    // block scale mode — voxels live on the integer grid in cardinal orientations
    // and can't be sub-unit scaled. effective snaps are applied at the gizmo
    // level without mutating the store, preserving the user's preferred values.
    let gizmoMode = transformMode as 'translate' | 'rotate' | 'scale';
    let effectiveTranslationSnap = translationSnap;
    let effectiveRotationSnap = rotationSnap;
    const effectiveScaleSnap = scaleSnap;
    if (computeTransformHasVoxels(state, nodes)) {
        effectiveTranslationSnap = 1;
        effectiveRotationSnap = 90;
        if (gizmoMode === 'scale') {
            gizmoMode = 'translate';
            state.store.setState({ transformMode: 'translate' });
        }
    }

    if (state.gizmo.mode !== gizmoMode) state.gizmo.setMode(gizmoMode);
    if (state.gizmo.space !== transformSpace) state.gizmo.setSpace(transformSpace);
    state.gizmo.setTranslationSnap(effectiveTranslationSnap);
    state.gizmo.setRotationSnap(effectiveRotationSnap != null ? effectiveRotationSnap * (Math.PI / 180) : null);
    state.gizmo.setScaleSnap(effectiveScaleSnap);

    // in placement mode, drive proxy from root ghost node only
    if (state.placement) {
        return _syncProxyFromPlacementRoot(state, nodes);
    }

    // normal mode: drive proxy from selected nodes
    const selectedNodes: { node: Node; transform: TransformTrait }[] = [];
    for (const nodeId of storeState.selection.nodes) {
        const node = getNodeById(nodes, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        selectedNodes.push({ node, transform: t });
    }

    if (selectedNodes.length === 0) {
        _detachGizmo(state);
        return null;
    }

    _ensureGizmoAttached(state);

    if (!state.dragging) {
        if (selectedNodes.length === 1) {
            const t = selectedNodes[0]!.transform;
            vec3.copy(state.proxy.position, getVisualWorldPosition(t));
            quat.copy(state.proxy.quaternion, getVisualWorldQuaternion(t));
        } else {
            _centroid[0] = 0;
            _centroid[1] = 0;
            _centroid[2] = 0;
            for (const { transform: t } of selectedNodes) {
                const p = getVisualWorldPosition(t);
                _centroid[0] += p[0];
                _centroid[1] += p[1];
                _centroid[2] += p[2];
            }
            const invN = 1 / selectedNodes.length;
            _centroid[0] *= invN;
            _centroid[1] *= invN;
            _centroid[2] *= invN;
            vec3.copy(state.proxy.position, _centroid);
            quat.identity(state.proxy.quaternion);
        }
        // keep proxy scale at identity — non-uniform scale on the proxy would
        // corrupt the worldQuaternion that mat4.decompose extracts in the gizmo,
        // making the gizmo visuals distort. node scale is tracked in snapshots
        // and applied as ratios in onObjectChange instead.
        vec3.set(state.proxy.scale, 1, 1, 1);
    }

    return [...state.proxy.position] as Vec3;
}

// returns the pivot world position, or null if root is missing.
function _syncProxyFromPlacementRoot(state: TransformToolState, nodes: Nodes): Vec3 | null {
    const placement = state.placement;
    if (!placement) return null;
    const root = getNodeById(nodes, placement.rootId);
    if (!root) return null;
    const t = getTrait(root, TransformTrait);
    if (!t) return null;

    _ensureGizmoAttached(state);

    // only sync proxy when placed (after first click). before that, keep proxy at current position
    // so gizmo doesn't jump unexpectedly when user starts interacting
    if (!state.dragging && placement.placed) {
        vec3.copy(state.proxy.position, getVisualWorldPosition(t));
        quat.copy(state.proxy.quaternion, getVisualWorldQuaternion(t));
        vec3.set(state.proxy.scale, 1, 1, 1);
    }

    // sync standalone voxel ghost node.
    // voxelmodel.origin defaults to [sx/2, sy/2, sz/2], so the mesh renders
    // centered on interpolatedPosition. to align the mesh min-corner with
    // the commit anchor (root.interpolatedPosition - pivotOffset), we set:
    //   voxelPosition = root.interpolatedPosition - pivotOffset + [sx/2, sy/2, sz/2]
    if (placement.voxelNodeId !== null) {
        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
        if (voxelNode) {
            const vt = getTrait(voxelNode, TransformTrait);
            if (vt) {
                const [sx, sy, sz] = placement.rotatedBlueprint.size;
                const [px, py, pz] = placement.pivotOffset;
                const tp = getVisualWorldPosition(t);
                _placeScratch[0] = tp[0] - px + sx * 0.5;
                _placeScratch[1] = tp[1] - py + sy * 0.5;
                _placeScratch[2] = tp[2] - pz + sz * 0.5;
                setPosition(vt, _placeScratch);
                vec3.copy(vt.interpolatedWorldPosition, vt.position);
            }
        }
    }

    return [...getVisualWorldPosition(t)] as Vec3;
}

function _ensureGizmoAttached(state: TransformToolState): void {
    if (!state.gizmoAttached) {
        state.gizmo.attach(state.proxy);
        state.gizmoAttached = true;
    }
}

function _detachGizmo(state: TransformToolState): void {
    if (state.gizmoAttached) {
        state.gizmo.detach();
        state.gizmoAttached = false;
    }
}

/** detach the gizmo immediately. call when switching away from the transform tool. */
export function detachGizmo(state: TransformToolState): void {
    _detachGizmo(state);
}

// returns the node ids the gizmo should operate on.
// during placement this is just the root ghost; otherwise it's the current selection.
function _activeNodeIds(state: TransformToolState): number[] {
    if (state.placement) {
        return [state.placement.rootId];
    }
    return [...state.store.getState().selection.nodes];
}

// ── pivot offset helpers ───────────────────────────────────────────

/**
 * compute the pivot offset vec3 for a given preset and blueprint size.
 * 'custom' returns the current store value unchanged.
 */
export function pivotOffsetForPreset(
    store: EditRoomStoreApi,
    preset: PivotPreset,
    size: Vec3,
    voxelAligned = false,
): Vec3 {
    switch (preset) {
        case 'min':
            return [0, 0, 0];
        case 'center': {
            const cx = size[0] * 0.5;
            const cy = size[1] * 0.5;
            const cz = size[2] * 0.5;
            // for voxel selections, floor so the pivot stays on the voxel grid.
            // e.g. size 3 → offset 1 (not 1.5), size 4 → offset 2.
            return voxelAligned ? [Math.floor(cx), Math.floor(cy), Math.floor(cz)] : [cx, cy, cz];
        }
        case 'max':
            return [size[0], size[1], size[2]];
        case 'custom':
            return [...store.getState().transformPivotOffset] as Vec3;
    }
}

/**
 * set the pivot preset during active placement.
 * updates both the store and the cached state so the root ghost repositions immediately.
 */
export function setPlacementPivot(state: TransformToolState, preset: PivotPreset, nodes: Nodes): void {
    const placement = state.placement;
    if (!placement) return;

    const hasVoxels = placement.rotation !== null;
    const newOffset = pivotOffsetForPreset(state.store, preset, placement.rotatedBlueprint.size, hasVoxels);

    // reposition root ghost: keep voxel min-corner where it is, shift pivot.
    // old root position = min-corner + old pivot offset
    // new root position = min-corner + new pivot offset
    const root = getNodeById(nodes, placement.rootId);
    if (root) {
        const t = getTrait(root, TransformTrait);
        if (t) {
            const [oldPx, oldPy, oldPz] = placement.pivotOffset;
            const [newPx, newPy, newPz] = newOffset;
            _placeScratch[0] = t.position[0] + (newPx - oldPx);
            _placeScratch[1] = t.position[1] + (newPy - oldPy);
            _placeScratch[2] = t.position[2] + (newPz - oldPz);
            setPosition(t, _placeScratch);
            vec3.copy(t.interpolatedWorldPosition, t.position);
        }
    }

    placement.pivotPreset = preset;
    placement.pivotOffset = newOffset;
    state.store.setState({ transformPivotOffset: [...newOffset] as Vec3 });
}

// ── placement mode ─────────────────────────────────────────────────
//
// entering placement creates two independent client-local ghost nodes:
//
//   root ghost (TransformTrait only)           ← gizmo pivot
//   voxel ghost (TransformTrait + VoxelMeshTrait) ← standalone, synced manually
//
// the root starts at blueprint.origin + pivotOffset. the voxel ghost's
// interpolatedPosition is recomputed each frame so the mesh min-corner
// stays aligned with the commit anchor (root - pivotOffset).
//
// this covers voxel-only, node-only, and mixed blueprints with one code path.

/**
 * enter placement mode. creates ghost nodes and hands them to the gizmo.
 * call on ctrl+v (isCut=false) or ctrl+x (isCut=true).
 */
export function enterPlacement(
    state: TransformToolState,
    blueprint: BlueprintData,
    isCut: boolean,
    cutReverseOps: VoxelOp[] | null,
    nodes: Nodes,
    ctx: ScriptContext,
): void {
    // bail if already in placement
    if (state.placement) return;

    // initial rotation is 0
    const rotation: 0 | 1 | 2 | 3 = 0;
    const rotatedBlueprint = Blueprint.rotate(blueprint, rotation);

    // default to 'center' pivot for voxel placements
    const preset: PivotPreset = 'center';
    const pivotOffset: Vec3 = blueprint.hasVoxels ? pivotOffsetForPreset(state.store, preset, rotatedBlueprint.size, true) : [0, 0, 0];

    // ── create root ghost pivot ──
    // sits at blueprint.origin + pivotOffset in world space.
    // has no geometry — pure pivot for the gizmo.
    const rootNode = createNode({ name: '__placement_root', persist: false });
    addChild(nodes.root, rootNode);
    const rootTransform = addTrait(rootNode, TransformTrait);
    rootTransform.position[0] = blueprint.origin[0] + pivotOffset[0];
    rootTransform.position[1] = blueprint.origin[1] + pivotOffset[1];
    rootTransform.position[2] = blueprint.origin[2] + pivotOffset[2];
    vec3.copy(rootTransform.interpolatedWorldPosition, rootTransform.position);

    // ── voxel ghost: standalone node (NOT a scene-graph child of root) ──
    // we avoid parenting because the engine does not propagate parent transforms
    // into child interpolatedPosition values. we set its interpolatedPosition
    // manually each frame in _syncProxyFromPlacementRoot instead.
    let voxelNodeId: number | null = null;
    if (blueprint.hasVoxels && rotatedBlueprint.voxels) {
        const voxelNode = createNode({ name: '__placement_voxels', persist: false });
        addChild(nodes.root, voxelNode);
        const voxelTransform = addTrait(voxelNode, TransformTrait);
        // initial interpolatedPosition: root - pivotOffset + [sx/2, sy/2, sz/2]
        const [sx, sy, sz] = rotatedBlueprint.size;
        const [px, py, pz] = pivotOffset;
        voxelTransform.position[0] = rootTransform.position[0] - px + sx * 0.5;
        voxelTransform.position[1] = rootTransform.position[1] - py + sy * 0.5;
        voxelTransform.position[2] = rootTransform.position[2] - pz + sz * 0.5;
        vec3.copy(voxelTransform.interpolatedWorldPosition, voxelTransform.position);

        const voxelMeshTrait = addTrait(voxelNode, VoxelMeshTrait);
        voxelMeshTrait.model = createVoxelModel(rotatedBlueprint.voxels);
        voxelMeshTrait.flash = [0.3, 0.7, 1.0, 0.25];
        voxelMeshTrait.glow = 0.12;

        voxelNodeId = voxelNode.id;
    }

    // ── node ghost children (voxel-only, node-only, and mixed all handled) ──
    // each blueprint entry is a SerializedNode with origin-relative transform.
    // deserialize the full subtree (children, traits, prefab linkage, scripts)
    // and attach under rootNode. the engine compounds the root's world-space
    // transform with the ghost's origin-relative transform at render time.
    if (blueprint.hasNodes) {
        for (const bpNode of blueprint.nodes) {
            const ghostNode = deserializeNode(bpNode);
            addChild(rootNode, ghostNode);
            _initGhostInterpolation(ghostNode);
        }
    }

    // ── store placement state ──
    const storeSnaps = state.store.getState();
    state.placement = {
        blueprint,
        rotation: blueprint.hasVoxels ? rotation : null,
        rotatedBlueprint,
        rootId: rootNode.id,
        placed: false,
        voxelNodeId,
        pivotPreset: preset,
        pivotOffset,
        cutReverseOps: isCut ? cutReverseOps : null,
        // snap restore values: only meaningful for voxel blueprints (we only
        // override snaps in that case below), but capture either way for symmetry.
        prevRotationSnap: storeSnaps.rotationSnap,
        prevTranslationSnap: storeSnaps.translationSnap,
        dragRotSteps: [0, 0, 0],
        voxelQuat: [0, 0, 0, 1],
        sourcePrefabId: null,
        sourceSceneId: null,
    };

    // sync proxy to root position so the gizmo appears at the right spot immediately
    vec3.copy(state.proxy.position, rootTransform.position);
    quat.copy(state.proxy.quaternion, rootTransform.quaternion);
    vec3.set(state.proxy.scale, 1, 1, 1);

    // force 1-voxel translation snap + 90deg rotation snap for voxel blueprints.
    // for node-only blueprints, only force place mode — preserve the user's
    // chosen snaps (sub-voxel placement of nodes is fine).
    if (blueprint.hasVoxels) {
        state.store.setState({ rotationSnap: 90, translationSnap: 1, transformMode: 'place' });
    } else {
        state.store.setState({ transformMode: 'place' });
    }

    // point selection at the root ghost so the gizmo addresses it
    state.store.setState((cur) => ({
        selection: { chunks: cur.selection.chunks, nodes: new Set([rootNode.id]) },
        activeTool: 'transform',
        placementActive: true,
        placementIsNodeOnly: !blueprint.hasVoxels,
        transformPivotOffset: [...pivotOffset] as Vec3,
    }));
}

/**
 * update placement ghost position from a voxel raycast hit.
 * computes smart positioning based on the face normal:
 * - top face: bottom of preview sits on top of hit block
 * - bottom face: top of preview sits under hit block
 * - side faces: preview edge flush against side, vertically centered
 *
 * no-op if not in placement mode or no blueprint.
 */
export function updatePlacementFromRaycast(
    state: TransformToolState,
    nodes: Nodes,
    hitVoxel: [number, number, number],
    hitNormal: [number, number, number],
    hitPoint: [number, number, number] | null,
): void {
    const placement = state.placement;
    const [nx, ny, nz] = hitNormal;
    const [hx, hy, hz] = hitVoxel;

    // no active placement: drive currently-selected nodes from cursor.
    // place mode is just a transform interaction — moves the selection to the
    // hovered face, with snapTo controlling the alignment (face-center vs corner).
    if (!placement) {
        const selectedNodeIds = state.store.getState().selection.nodes;
        if (selectedNodeIds.size === 0) return;

        // target position on the hovered face. face-center: pin to face midpoint
        // (+0.5 on the two axes perpendicular to the normal). corner: snap to the
        // face corner closest to the hit point (requires hitPoint; falls back to
        // the cell-adjacent corner if hitPoint is missing).
        const useFaceCenter = _effectiveSnapTo(state) === 'face-center';
        let tx: number;
        let ty: number;
        let tz: number;
        if (useFaceCenter) {
            tx = hx + nx + (nx === 0 ? 0.5 : 0);
            ty = hy + ny + (ny === 0 ? 0 : 0);
            tz = hz + nz + (nz === 0 ? 0.5 : 0);
        } else if (hitPoint) {
            // for axes perpendicular to the normal, snap to nearest integer corner
            // of the hovered face. for the normal axis, take the cell-adjacent value.
            tx = nx !== 0 ? hx + nx : Math.round(hitPoint[0]);
            ty = ny !== 0 ? hy + ny : Math.round(hitPoint[1]);
            tz = nz !== 0 ? hz + nz : Math.round(hitPoint[2]);
        } else {
            tx = hx + nx;
            ty = hy + ny;
            tz = hz + nz;
        }

        // compute centroid of selected nodes (interpolated for smoothness)
        let cxAvg = 0;
        let cyAvg = 0;
        let czAvg = 0;
        let count = 0;
        for (const id of selectedNodeIds) {
            const node = getNodeById(nodes, id);
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

        // first cursor-driven move in this place session: snapshot starting
        // positions so commitPlaceSelection can build a do/undo entry on exit.
        if (state.placeSnapshots === null) {
            const snaps: TransformSnapshot[] = [];
            for (const id of selectedNodeIds) {
                const node = getNodeById(nodes, id);
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
            const node = getNodeById(nodes, id);
            if (!node) continue;
            const tt = getTrait(node, TransformTrait);
            if (!tt) continue;
            tt.position[0] += dx;
            tt.position[1] += dy;
            tt.position[2] += dz;
            vec3.copy(tt.interpolatedWorldPosition, tt.position);
            markTransformDirty(tt);
        }
        return;
    }

    const root = getNodeById(nodes, placement.rootId);
    if (!root) return;
    const t = getTrait(root, TransformTrait);
    if (!t) return;

    const [sx, sy, sz] = placement.rotatedBlueprint.size;
    const [px, py, pz] = placement.pivotOffset;

    // node-only 1x1x1 placements: respect snapTo same as the no-placement branch.
    // face-center → ghost pinned to face midpoint; corner → snap to the integer
    // corner of the face closest to the cursor (requires hitPoint).
    if (!placement.blueprint.hasVoxels && sx === 1 && sy === 1 && sz === 1) {
        const useFaceCenter = _effectiveSnapTo(state) === 'face-center';
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
    // compute min-corner of where the blueprint should sit
    let minX: number;
    let minY: number;
    let minZ: number;

    if (ny === 1) {
        // top face: bottom of preview on top of hit block
        minX = hx - Math.floor(sx / 2);
        minY = hy + 1;
        minZ = hz - Math.floor(sz / 2);
    } else if (ny === -1) {
        // bottom face: top of preview under hit block
        minX = hx - Math.floor(sx / 2);
        minY = hy - sy;
        minZ = hz - Math.floor(sz / 2);
    } else if (nx === 1) {
        // +x face: left edge flush against right side of hit block
        minX = hx + 1;
        minY = hy - Math.floor(sy / 2);
        minZ = hz - Math.floor(sz / 2);
    } else if (nx === -1) {
        // -x face: right edge flush against left side
        minX = hx - sx;
        minY = hy - Math.floor(sy / 2);
        minZ = hz - Math.floor(sz / 2);
    } else if (nz === 1) {
        // +z face: front edge flush against back of hit block
        minX = hx - Math.floor(sx / 2);
        minY = hy - Math.floor(sy / 2);
        minZ = hz + 1;
    } else if (nz === -1) {
        // -z face
        minX = hx - Math.floor(sx / 2);
        minY = hy - Math.floor(sy / 2);
        minZ = hz - sz;
    } else {
        // fallback: adjacent to hit voxel
        minX = hx + nx;
        minY = hy + ny;
        minZ = hz + nz;
    }

    // root position = min-corner + pivot offset. setPosition marks the root
    // and its descendants dirty so the placement ghost children + prefab-visuals
    // voxel ghost grandchildren actually follow on the next frame.
    _placeScratch[0] = minX + px;
    _placeScratch[1] = minY + py;
    _placeScratch[2] = minZ + pz;
    setPosition(t, _placeScratch);
}

/**
 * rotate the voxel content of the placement preview 90 degrees CW around Y.
 * no-op if no active placement or blueprint has no voxels.
 * recomputes pivot offset if preset is 'center' or 'max' so it tracks the new size.
 */
export function nudgePlacement(state: TransformToolState, nodes: Nodes, dx: number, dy: number, dz: number): void {
    const placement = state.placement;
    if (!placement) return;
    const root = getNodeById(nodes, placement.rootId);
    if (!root) return;
    const t = getTrait(root, TransformTrait);
    if (!t) return;

    _placeScratch[0] = t.position[0] + dx;
    _placeScratch[1] = t.position[1] + dy;
    _placeScratch[2] = t.position[2] + dz;
    setPosition(t, _placeScratch);
    vec3.copy(t.interpolatedWorldPosition, t.position);

    // move the voxel ghost too if present
    if (placement.voxelNodeId !== null) {
        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
        if (voxelNode) {
            const vt = getTrait(voxelNode, TransformTrait);
            if (vt) {
                _placeScratch[0] = vt.position[0] + dx;
                _placeScratch[1] = vt.position[1] + dy;
                _placeScratch[2] = vt.position[2] + dz;
                setPosition(vt, _placeScratch);
                vec3.copy(vt.interpolatedWorldPosition, vt.position);
            }
        }
    }
}

/**
 * nudge selected nodes by (dx, dy, dz). used for arrow key nudge in transform mode.
 * wrapped in an undo action so ctrl+z reverts it.
 */
export function nudgeNodes(
    state: TransformToolState,
    nodes: Nodes,
    ctx: ScriptContext,
    dx: number,
    dy: number,
    dz: number,
): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    // snapshot current positions for undo
    const snapshots: { nodeId: number; position: Vec3 }[] = [];
    const finals: { nodeId: number; position: Vec3 }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(nodes, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, position: vec3.clone(t.position) });
        finals.push({ nodeId, position: [t.position[0] + dx, t.position[1] + dy, t.position[2] + dz] });
    }

    const apply = (entries: { nodeId: number; position: Vec3 }[]) => {
        for (const e of entries) {
            const n = getNodeById(nodes, e.nodeId);
            if (!n) continue;
            setTraitProps(nodes, n, 'transform', { position: vec3.clone(e.position) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ position: vec3.clone(e.position) }),
            });
        }
        state.store.getState().markDirty();
    };

    state.store.getState().action({
        label: 'nudge translate',
        do() {
            apply(finals);
        },
        undo() {
            apply(snapshots);
        },
    });
}

// scratch quats for rotation nudge
const _nudgeRotQ: Quat = quat.create();
const _nudgeResult: Quat = quat.create();

/**
 * rotate selected nodes around the given world axis by angle (radians).
 * uses the rotation snap from the store if set, otherwise falls back to the provided angle.
 * wrapped in an undo action so ctrl+z reverts it.
 */
export function rotateNodes(
    state: TransformToolState,
    nodes: Nodes,
    ctx: ScriptContext,
    axis: Vec3,
    angle: number,
): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    // caller already applied the appropriate snap (and sign) — use angle as-is.
    // do NOT override with storeState.rotationSnap: that strips sign and ignores
    // caller-side voxel-content forced 90deg.
    quat.setAxisAngle(_nudgeRotQ, axis, angle);

    // snapshot current quaternions for undo
    const snapshots: { nodeId: number; quaternion: Quat }[] = [];
    const finals: { nodeId: number; quaternion: Quat }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(nodes, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, quaternion: quat.clone(t.quaternion) });

        // new = nudgeRot * current (pre-multiply for world-space rotation)
        quat.multiply(_nudgeResult, _nudgeRotQ, t.quaternion);
        quat.normalize(_nudgeResult, _nudgeResult);
        finals.push({ nodeId, quaternion: [_nudgeResult[0], _nudgeResult[1], _nudgeResult[2], _nudgeResult[3]] });
    }

    const apply = (entries: { nodeId: number; quaternion: Quat }[]) => {
        for (const e of entries) {
            const n = getNodeById(nodes, e.nodeId);
            if (!n) continue;
            setTraitProps(nodes, n, 'transform', { quaternion: quat.clone(e.quaternion) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ quaternion: quat.clone(e.quaternion) }),
            });
        }
        state.store.getState().markDirty();
    };

    state.store.getState().action({
        label: 'nudge rotate',
        do() {
            apply(finals);
        },
        undo() {
            apply(snapshots);
        },
    });
}

/**
 * uniform scale selected nodes by a multiplicative factor.
 * uses the scale snap from the store as the step size.
 * wrapped in an undo action so ctrl+z reverts it.
 */
export function scaleNodes(
    state: TransformToolState,
    nodes: Nodes,
    ctx: ScriptContext,
    factor: number,
): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    // snapshot current scales for undo
    const snapshots: { nodeId: number; scale: Vec3 }[] = [];
    const finals: { nodeId: number; scale: Vec3 }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(nodes, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, scale: vec3.clone(t.scale) });
        finals.push({ nodeId, scale: [t.scale[0] * factor, t.scale[1] * factor, t.scale[2] * factor] });
    }

    const apply = (entries: { nodeId: number; scale: Vec3 }[]) => {
        for (const e of entries) {
            const n = getNodeById(nodes, e.nodeId);
            if (!n) continue;
            setTraitProps(nodes, n, 'transform', { scale: vec3.clone(e.scale) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ scale: vec3.clone(e.scale) }),
            });
        }
        state.store.getState().markDirty();
    };

    state.store.getState().action({
        label: 'nudge scale',
        do() {
            apply(finals);
        },
        undo() {
            apply(snapshots);
        },
    });
}

/**
 * nudge selected voxels from the store's current selection.
 */
export function nudgeVoxelsFromSelection(
    state: TransformToolState,
    _nodes: Nodes,
    ctx: ScriptContext,
    dx: number,
    dy: number,
    dz: number,
): void {
    const selection = state.store.getState().selection;
    if (Selection.isEmpty(selection)) return;

    const voxels = ctx.voxels;
    const forwardOps: VoxelOp[] = [];
    const reverseOps: VoxelOp[] = [];

    Selection.forEach(selection, (wx, wy, wz) => {
        const key = getBlock(voxels, wx, wy, wz);
        if (key === BLOCK_AIR) return;

        const destX = wx + dx;
        const destY = wy + dy;
        const destZ = wz + dz;

        forwardOps.push({ wx: destX, wy: destY, wz: destZ, key });
        reverseOps.push({ wx: wx, wy: wy, wz: wz, key: BLOCK_AIR });
    });

    if (forwardOps.length === 0) return;

    state.store.getState().action({
        label: 'nudge voxels',
        do() {
            send(ctx, VoxelEditCommand, { ops: forwardOps });
        },
        undo() {
            send(ctx, VoxelEditCommand, { ops: reverseOps });
        },
    });
}

export function rotatePlacement(
    state: TransformToolState,
    nodes: Nodes,
    direction: 1 | -1 = 1,
    axis: 'x' | 'y' | 'z' = 'y',
): void {
    const placement = state.placement;
    if (!placement) return;
    if (placement.rotation === null) return; // node-only: use gizmo rotate mode

    // apply incremental rotation to the current rotated blueprint
    const newRotatedBlueprint = Blueprint.rotateAxis(placement.rotatedBlueprint, axis, direction);

    // update VoxelMeshTrait on the standalone voxel ghost node
    if (placement.voxelNodeId !== null && newRotatedBlueprint.voxels) {
        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
        if (voxelNode) {
            const vmTrait = getTrait(voxelNode, VoxelMeshTrait);
            if (vmTrait) {
                vmTrait.model = createVoxelModel(newRotatedBlueprint.voxels);
                vmTrait.flash = [0.3, 0.7, 1.0, 0.25];
                vmTrait.glow = 0.12;
            }
        }
    }

    // track Y turns for legacy compat (only meaningful for Y-axis rotations)
    if (axis === 'y') {
        placement.rotation = ((placement.rotation + direction + 4) & 3) as 0 | 1 | 2 | 3;
    }
    placement.rotatedBlueprint = newRotatedBlueprint;

    // accumulate the same step into voxelQuat (pre-multiply matches the node-rotation
    // composition Blueprint.rotateAxis uses, so wrapper.quaternion at commit reproduces
    // the rotation the user saw in the preview).
    const halfAngle = (direction * Math.PI) / 4;
    const s = Math.sin(halfAngle);
    const c = Math.cos(halfAngle);
    const stepQuat: Quat = axis === 'y' ? [0, s, 0, c] : axis === 'x' ? [s, 0, 0, c] : [0, 0, s, c];
    quat.multiply(placement.voxelQuat, stepQuat, placement.voxelQuat);

    // recompute pivot offset for non-custom presets so it tracks the new size
    if (placement.pivotPreset !== 'custom') {
        const newOffset = pivotOffsetForPreset(state.store, placement.pivotPreset, newRotatedBlueprint.size, true);
        const root = getNodeById(nodes, placement.rootId);
        if (root) {
            const t = getTrait(root, TransformTrait);
            if (t) {
                const [oldPx, oldPy, oldPz] = placement.pivotOffset;
                const [newPx, newPy, newPz] = newOffset;
                _placeScratch[0] = t.position[0] + (newPx - oldPx);
                _placeScratch[1] = t.position[1] + (newPy - oldPy);
                _placeScratch[2] = t.position[2] + (newPz - oldPz);
                setPosition(t, _placeScratch);
                vec3.copy(t.interpolatedWorldPosition, t.position);
            }
        }
        placement.pivotOffset = newOffset;
        state.store.setState({ transformPivotOffset: [...newOffset] as Vec3 });
    }
}

export function flipPlacement(
    state: TransformToolState,
    nodes: Nodes,
    axis: 'x' | 'y' | 'z',
): void {
    const placement = state.placement;
    if (!placement) return;
    if (placement.rotation === null) return; // node-only: gizmo handles it

    const newRotatedBlueprint = Blueprint.flipAxis(placement.rotatedBlueprint, axis);

    if (placement.voxelNodeId !== null && newRotatedBlueprint.voxels) {
        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
        if (voxelNode) {
            const vmTrait = getTrait(voxelNode, VoxelMeshTrait);
            if (vmTrait) {
                vmTrait.model = createVoxelModel(newRotatedBlueprint.voxels);
                vmTrait.flash = [0.3, 0.7, 1.0, 0.25];
                vmTrait.glow = 0.12;
            }
        }
    }

    placement.rotatedBlueprint = newRotatedBlueprint;

    // mirror voxelQuat across the same plane so a sourcePrefab commit
    // stamps a quaternion that matches the visible preview.
    const [qx, qy, qz, qw] = placement.voxelQuat;
    if (axis === 'x') placement.voxelQuat = [qx, -qy, -qz, qw];
    else if (axis === 'y') placement.voxelQuat = [-qx, qy, -qz, qw];
    else placement.voxelQuat = [-qx, -qy, qz, qw];

    // flip preserves size, so pivot preset offsets are unchanged.
}

/**
 * commit placement: materialize ghost content as real voxel ops + nodes.
 * creates an undo action that covers everything.
 */
export function commitPlacement(
    state: TransformToolState,
    nodes: Nodes,
    worldVoxels: Voxels,
    ctx: ScriptContext,
): void {
    const placement = state.placement;
    if (!placement) return;

    const blueprint = placement.blueprint;
    const rotatedBlueprint = placement.rotatedBlueprint;

    // read final position and rotation from root ghost
    const rootNode = getNodeById(nodes, placement.rootId);
    const rootTransform = rootNode ? getTrait(rootNode, TransformTrait) : null;

    // voxel anchor = root position - pivot offset = blueprint min corner in world space
    const [px, py, pz] = placement.pivotOffset;
    const anchor: Vec3 = rootTransform
        ? [rootTransform.position[0] - px, rootTransform.position[1] - py, rootTransform.position[2] - pz]
        : [...blueprint.origin];
    const rotation: Quat = rootTransform
        ? [rootTransform.quaternion[0], rootTransform.quaternion[1], rootTransform.quaternion[2], rootTransform.quaternion[3]]
        : [0, 0, 0, 1];

    // prefab-source path: emit one wrapper node carrying the prefab config so
    // the runtime re-instantiates the contents on the real node — keeps the
    // linkage alive instead of concretizing the snapshot. voxel ops + per-entry
    // node creates are skipped; the reconciler stamps voxels and rebuilds child
    // nodes from the prefab def. wrapper.quaternion combines gizmo rotation
    // (rootTransform.quaternion) with keyboard/drag R-key rotation (voxelQuat
    // — accumulated in rotatePlacement). matches the convention used by
    // buildNodePaste (pre-multiply: world rotation outside, local inside).
    const sourcePrefab = blueprint.sourcePrefab;
    const wrapperQuat: Quat = sourcePrefab ? quat.multiply(quat.create(), rotation, placement.voxelQuat) : rotation;

    // capture cut ops + source prefab id before clearing state (the latter is
    // restored after the continuous re-enter below so build-tool slot-mismatch
    // detection keeps working across the loop).
    const cutReverseOps = placement.cutReverseOps;
    const isCut = cutReverseOps !== null;
    const sourcePrefabId = placement.sourcePrefabId;

    // build voxel ops + per-entry node data only on the non-prefab (concretize) path.
    const voxelForward: VoxelOp[] = [];
    const voxelReverse: VoxelOp[] = [];
    const nodePasteEntries: SerializedNode[] = [];
    if (!sourcePrefab) {
        const ops = Blueprint.buildPasteOps(rotatedBlueprint, anchor, worldVoxels);
        voxelForward.push(...ops.forward);
        voxelReverse.push(...ops.reverse);
        // use rotatedBlueprint so child nodes inherit the rotation applied via
        // rotatePlacement. for node-only placements, rotatedBlueprint === blueprint
        // and gizmo rotation lives on `rotation`.
        const paste = Blueprint.buildNodePaste(rotatedBlueprint, anchor, rotation);
        nodePasteEntries.push(...paste.entries);
    }

    // destroy ghost nodes now (before pushing undo so redo can recreate)
    _destroyGhosts(state, nodes);
    _exitPlacementState(state);

    // allocate node ids upfront so do/undo/redo all reference the same nodes.
    // if ids were allocated inside do(), redo would create duplicates with
    // fresh ids and undo would have nothing to destroy.
    const createdIds: number[] = [];
    const wrapperEntryCount = sourcePrefab ? 1 : nodePasteEntries.length;
    for (let i = 0; i < wrapperEntryCount; i++) {
        createdIds.push(nodes._nextNodeId++);
    }

    state.store.getState().action({
        label: isCut ? 'cut-paste' : sourcePrefab ? 'place-prefab' : 'paste',
        do() {
            if (sourcePrefab) {
                // single wrapper carrying the prefab config — runtime materializes
                // voxels + child nodes on the real node.
                send(ctx, CreateNodeCommand, {
                    id: createdIds[0]!,
                    parentId: nodes.root.id,
                    index: nodes.root.children.length,
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
                state.store.getState().markDirty();
                return;
            }
            // apply voxels
            if (voxelForward.length > 0) {
                send(ctx, VoxelEditCommand, { ops: voxelForward });
            }
            // create nodes — buildNodePaste already re-anchored each entry's
            // top-level transform to world space. children carry parent-relative
            // positions and ride along through the children blob.
            for (let i = 0; i < nodePasteEntries.length; i++) {
                const entry = nodePasteEntries[i]!;
                send(ctx, CreateNodeCommand, {
                    id: createdIds[i]!,
                    parentId: nodes.root.id,
                    index: nodes.root.children.length,
                    name: entry.name,
                    persist: true,
                    traits: JSON.stringify(entry.traits),
                    children: JSON.stringify(entry.children),
                    prefab: entry.prefab ? JSON.stringify(entry.prefab) : undefined,
                });
            }
            state.store.getState().markDirty();
        },
        undo() {
            // reverse voxels back
            if (voxelReverse.length > 0) {
                send(ctx, VoxelEditCommand, { ops: voxelReverse });
            }
            // restore cut source voxels
            if (isCut && cutReverseOps && cutReverseOps.length > 0) {
                send(ctx, VoxelEditCommand, { ops: cutReverseOps });
            }
            // destroy nodes created in do(). server cascades child destruction.
            for (const id of createdIds) {
                const n = getNodeById(nodes, id);
                if (n) destroyNode(nodes, n);
                send(ctx, DestroyNodeCommand, { id });
            }
            state.store.getState().markDirty();
        },
    });

    // continuous placement: re-arm with the same blueprint so the next click
    // drops another instance. used by build-tool prefab placement and by
    // shift+paste / shift+cut-paste from the clipboard handlers.
    if (state.store.getState().placementContinuous) {
        const reBlueprint: BlueprintData = { ...blueprint, origin: [anchor[0], anchor[1], anchor[2]] };
        enterPlacement(state, reBlueprint, false, null, nodes, ctx);
        if (state.placement) state.placement.sourcePrefabId = sourcePrefabId;
        return;
    }

    state.store.setState((cur) => ({
        activeTool: 'inspect',
        selection: { chunks: cur.selection.chunks, nodes: new Set() },
    }));
}

/**
 * cancel placement: destroy ghosts and restore cut content if applicable.
 */
export function cancelPlacement(state: TransformToolState, nodes: Nodes, ctx: ScriptContext): void {
    if (!state.placement) return;

    const cutReverseOps = state.placement.cutReverseOps;
    _destroyGhosts(state, nodes);
    _exitPlacementState(state);

    if (cutReverseOps && cutReverseOps.length > 0) {
        send(ctx, VoxelEditCommand, { ops: cutReverseOps });
    }

    state.store.setState((cur) => ({
        activeTool: 'inspect',
        selection: { chunks: cur.selection.chunks, nodes: new Set() },
        placementContinuous: false,
    }));
}

/**
 * revert place-mode-with-selection cursor-follow back to the snapshot positions.
 * called on cancel paths (mode-key, escape, tool change) so the cursor follow
 * acts as a non-destructive preview — no history entry is created.
 */
export function revertPlaceSelection(state: TransformToolState, nodes: Nodes): void {
    const snaps = state.placeSnapshots;
    state.placeSnapshots = null;
    if (!snaps) return;
    for (const s of snaps) {
        const node = getNodeById(nodes, s.nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        vec3.copy(t.position, s.position);
        vec3.copy(t.interpolatedWorldPosition, s.position);
        markTransformDirty(t);
    }
}

/**
 * commit cursor-follow position changes from place-mode-with-selection
 * (the no-ghost branch of updatePlacementFromRaycast). builds a do/undo entry
 * from the captured snapshots → current positions, persists via setTraitProps,
 * and replicates via SetTraitCommand. clears state.placeSnapshots.
 *
 * called only on explicit confirm (click) — see revertPlaceSelection for the
 * cancel path. no-op when nothing actually moved (avoids noise in undo stack).
 */
export function commitPlaceSelection(
    state: TransformToolState,
    nodes: Nodes,
    ctx: ScriptContext,
): void {
    const prevSnapshots = state.placeSnapshots;
    state.placeSnapshots = null;
    if (!prevSnapshots || prevSnapshots.length === 0) return;

    const finals: TransformSnapshot[] = [];
    let changed = false;
    for (const snap of prevSnapshots) {
        const node = getNodeById(nodes, snap.nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        finals.push({
            nodeId: snap.nodeId,
            position: vec3.clone(t.position),
            quaternion: quat.clone(t.quaternion),
            scale: vec3.clone(t.scale),
        });
        if (
            t.position[0] !== snap.position[0] ||
            t.position[1] !== snap.position[1] ||
            t.position[2] !== snap.position[2]
        ) {
            changed = true;
        }
    }
    if (!changed || finals.length === 0) return;

    state.store.getState().action({
        label: 'place',
        do() {
            for (const f of finals) {
                const n = getNodeById(nodes, f.nodeId);
                if (!n) continue;
                const props = {
                    position: vec3.clone(f.position),
                    quaternion: quat.clone(f.quaternion),
                    scale: vec3.clone(f.scale),
                };
                setTraitProps(nodes, n, 'transform', props);
                send(ctx, SetTraitCommand, { id: f.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            }
            state.store.getState().markDirty();
        },
        undo() {
            for (const s of prevSnapshots) {
                const n = getNodeById(nodes, s.nodeId);
                if (!n) continue;
                const props = {
                    position: vec3.clone(s.position),
                    quaternion: quat.clone(s.quaternion),
                    scale: vec3.clone(s.scale),
                };
                setTraitProps(nodes, n, 'transform', props);
                send(ctx, SetTraitCommand, { id: s.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            }
            state.store.getState().markDirty();
        },
    });
}

/**
 * enter placement mode for a prefab. instantiates the prefab into a synthetic
 * scratch node, snapshots its voxels and child nodes into a Blueprint, and
 * feeds that Blueprint through the standard placement path. the prefab's
 * voxels become first-class blueprint voxels — rotation, pivot, snap, and
 * commit all reuse the copy/paste codepath verbatim.
 *
 * the placed result is "frozen": the prefab linkage is dropped at commit time.
 * later edits to the prefab def do not propagate to placed instances.
 *
 * caller is responsible for setting `placementContinuous` on the store
 * if it wants the build-tool re-arm loop.
 */
export function enterPrefabPlacement(
    state: TransformToolState,
    prefabId: string,
    anchor: Vec3,
    nodes: Nodes,
    ctx: ScriptContext,
): void {
    if (state.placement !== null) return;

    const runtime = ctx._runtime;
    if (!runtime) return;

    const blueprint = Blueprint.createPrefabBlueprint(prefabId, anchor, runtime, ctx.blocks);
    if (!blueprint) return;

    enterPlacement(state, blueprint, false, null, nodes, ctx);
    // enterPlacement always installs state.placement on success, but the
    // assertion bypasses TS narrowing from the bail-check above.
    const placement = state.placement as PlacementState | null;
    if (placement) placement.sourcePrefabId = prefabId;
}

/**
 * enter placement mode for a saved blueprint scene. reads the scene's
 * payload from the registry and feeds it through the standard placement
 * path. unlike prefabs, blueprint placements don't preserve any source
 * linkage — they paste raw nodes + voxels.
 */
export function enterBlueprintPlacement(
    state: TransformToolState,
    sceneId: string,
    anchor: Vec3,
    nodes: Nodes,
    ctx: ScriptContext,
): void {
    if (state.placement !== null) return;
    const blueprint = Blueprint.createSceneBlueprint(sceneId, anchor, ctx.blocks);
    if (!blueprint) return;
    enterPlacement(state, blueprint, false, null, nodes, ctx);
    const placement = state.placement as PlacementState | null;
    if (placement) placement.sourceSceneId = sceneId;
}

/** true when placement mode is currently active */
export function isInPlacement(state: TransformToolState): boolean {
    return state.placement !== null;
}

/**
 * detect whether the active placement or current selection contains voxel data.
 * voxel content (raw voxels or a voxel-bearing prefab) cannot be sensibly placed
 * off the integer grid, so snapTo must be forced to 'corner' when this is true.
 * called per-frame from inspect.ts; result is mirrored to store.transformHasVoxels.
 */
export function computeTransformHasVoxels(state: TransformToolState, nodes: Nodes): boolean {
    const store = state.store.getState();
    if (state.placement && state.placement.blueprint.hasVoxels) return true;
    const room = useEditor.getState().room;
    if (!room) return false;
    for (const id of store.selection.nodes) {
        const node = getNodeById(nodes, id);
        if (!node) continue;
        const def = node.prefab ? registry.prefabs.byId.get(node.prefab.prefabId)?.payload : null;
        if (def && prefabHasVoxels(def)) return true;
    }
    return false;
}

/** read snapTo from store, but force 'corner' when voxel content is involved. */
function _effectiveSnapTo(state: TransformToolState): 'face-center' | 'corner' {
    const s = state.store.getState();
    return s.transformHasVoxels ? 'corner' : s.snapTo;
}

/** true when placement contains voxel data (rotation must go through rotatePlacement, not quaternion) */
export function isVoxelPlacement(state: TransformToolState): boolean {
    return state.placement !== null && state.placement.rotation !== null;
}

// ── placement helpers ──────────────────────────────────────────────

// init interpolated transform values across a freshly deserialized ghost
// subtree so the first frame renders without snapping from default zero.
function _initGhostInterpolation(node: Node): void {
    const t = getTrait(node, TransformTrait);
    if (t) {
        vec3.copy(t.interpolatedWorldPosition, t.position);
        quat.copy(t.interpolatedWorldQuaternion, t.quaternion);
    }
    for (const child of node.children) _initGhostInterpolation(child);
}

function _destroyGhosts(state: TransformToolState, nodes: Nodes): void {
    _detachGizmo(state);

    const placement = state.placement;
    if (!placement) return;

    if (placement.voxelNodeId !== null) {
        const voxelNode = getNodeById(nodes, placement.voxelNodeId);
        if (voxelNode) destroyNode(nodes, voxelNode);
    }

    const rootNode = getNodeById(nodes, placement.rootId);
    // destroyNode recurses into children (node ghosts), so this covers everything
    if (rootNode) destroyNode(nodes, rootNode);
}

function _exitPlacementState(state: TransformToolState): void {
    const placement = state.placement;
    if (!placement) return;

    // restore snaps that were overridden in enterPlacement (only for voxel blueprints)
    if (placement.blueprint.hasVoxels) {
        state.store.setState({
            rotationSnap: placement.prevRotationSnap ?? null,
            translationSnap: placement.prevTranslationSnap ?? null,
        });
    }
    state.placement = null;
    state.store.setState({ transformPivotOffset: [0, 0, 0], placementActive: false, placementIsNodeOnly: false });
}

// ── grab mode (gmod physgun) ───────────────────────────────────────
//
// hold left mouse on a target node to "grab" it: a transient dynamic body
// is created in the physics world and a PD controller drives it toward a
// camera-relative anchor point. scroll wheel adjusts grabDistance. release
// (mouseup) destroys the body and commits a single transform-undo entry.
//
// the body is created directly via crashcat (not via RigidBodyTrait) so it
// only exists for the duration of the grab — no edit-mode/play-mode sync,
// no replication. the node's TransformTrait is written each frame from the
// body's pose; the existing OBJECT_LAYER_EDITOR_NODES sensor for the node
// stays put (different broadphase layer, doesn't fight us).

const GRAB_DIST_MIN = 1;
const GRAB_DIST_MAX = 100;
const GRAB_DIST_SCROLL = 0.005; // wheel-pixels → distance units (delta * grabDist * factor)
const GRAB_LIN_STIFF = 12; // velocity = posError * stiffness
const GRAB_ANG_STIFF = 12;
const GRAB_LIN_VMAX = 60; // m/s clamp
const GRAB_ANG_VMAX = 30; // rad/s clamp
const GRAB_FALLBACK_HALF = 0.5;
const GRAB_ROT_SENS = 0.005; // rad per pixel of mouse delta during R-rotate
// resting DOF: yaw-only rotation. matches enterGrab default — held things stay upright.
const GRAB_DOF_REST = /* @__PURE__ */ dof(true, true, true, false, true, false);
// rotate DOF: all axes free. used while R is held so user can pitch/roll the body.
const GRAB_DOF_ROTATE = /* @__PURE__ */ dof(true, true, true, true, true, true);

const _grabAabb: Box3 = box3.create();
const _grabCamFwd: Vec3 = [0, 0, 0];
const _grabTargetPos: Vec3 = [0, 0, 0];
const _grabTargetQuat: Quat = [0, 0, 0, 1];
const _grabPosErr: Vec3 = [0, 0, 0];
const _grabLinVel: Vec3 = [0, 0, 0];
const _grabAngVel: Vec3 = [0, 0, 0];
const _grabDeltaQ: Quat = [0, 0, 0, 1];
const _grabInvCam: Quat = [0, 0, 0, 1];
const _grabRel: Vec3 = [0, 0, 0];

/**
 * compute world-space half-extents and center for a node's subtree mesh AABB.
 * falls back to a 0.5-unit cube at interpolatedPosition when nothing in the
 * subtree contributes geometry (matches node-bodies.ts fallback).
 */
function _grabBodyAabb(node: Node, resources: Resources, outCenter: Vec3, outHalf: Vec3): void {
    const transform = getTrait(node, TransformTrait);
    box3.set(_grabAabb, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    if (unionSubtreeWorldAabb(node, resources, _grabAabb)) {
        outHalf[0] = Math.max((_grabAabb[3] - _grabAabb[0]) * 0.5, 0.01);
        outHalf[1] = Math.max((_grabAabb[4] - _grabAabb[1]) * 0.5, 0.01);
        outHalf[2] = Math.max((_grabAabb[5] - _grabAabb[2]) * 0.5, 0.01);
        outCenter[0] = (_grabAabb[0] + _grabAabb[3]) * 0.5;
        outCenter[1] = (_grabAabb[1] + _grabAabb[4]) * 0.5;
        outCenter[2] = (_grabAabb[2] + _grabAabb[5]) * 0.5;
        return;
    }
    if (transform) {
        const p = getVisualWorldPosition(transform);
        outCenter[0] = p[0];
        outCenter[1] = p[1];
        outCenter[2] = p[2];
    } else {
        outCenter[0] = 0;
        outCenter[1] = 0;
        outCenter[2] = 0;
    }
    outHalf[0] = GRAB_FALLBACK_HALF;
    outHalf[1] = GRAB_FALLBACK_HALF;
    outHalf[2] = GRAB_FALLBACK_HALF;
}

/**
 * begin grabbing `nodeId`. creates a transient dynamic body sized to the node's
 * subtree AABB at its current world pose, captures camera-relative anchors so
 * the held object stays in the same screen-relative spot as the camera turns.
 *
 * no-op if a grab is already active or the node is missing TransformTrait.
 */
export function enterGrab(state: TransformToolState, nodeId: number, nodes: Nodes, physics: Physics, resources: Resources, camera: PerspectiveCamera): void {
    if (state.grab) return;
    const node = getNodeById(nodes, nodeId);
    if (!node) return;
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;

    // body pose: AABB-center position + node's interpolated quaternion. using
    // AABB center (rather than transform.position) keeps off-pivot models
    // from flailing on grab-start — the held point is the visual center.
    const center: Vec3 = [0, 0, 0];
    const half: Vec3 = [0, 0, 0];
    _grabBodyAabb(node, resources, center, half);

    const shape = box.create({ halfExtents: [half[0], half[1], half[2]] });
    const startQuat = getVisualWorldQuaternion(transform);
    const body = rigidBody.create(physics.rigid.world, {
        shape,
        objectLayer: OBJECT_LAYER_NODE_MOVING,
        motionType: MotionType.DYNAMIC,
        position: [center[0], center[1], center[2]],
        quaternion: [startQuat[0], startQuat[1], startQuat[2], startQuat[3]],
        gravityFactor: 0,
        friction: 0.5,
        restitution: 0,
        // lock pitch and roll — only yaw (world Y) follows the camera by default.
        // matches gmod physgun feel: held things stay upright when you swing the view.
        // widened to all axes on R-hold (see beginRotate).
        allowedDegreesOfFreedom: GRAB_DOF_REST,
    });

    // distance from camera to held point
    const dx = center[0] - camera.position[0];
    const dy = center[1] - camera.position[1];
    const dz = center[2] - camera.position[2];
    const grabDistance = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, Math.sqrt(dx * dx + dy * dy + dz * dz)));

    // anchor offset in camera space: relate body center to (cam.pos + cam.fwd * grabDistance)
    // anchorOffsetCS = inv(cam.quat) * (bodyPos - (cam.pos + cam.fwd * grabDistance))
    vec3.set(_grabCamFwd, 0, 0, -1);
    vec3.transformQuat(_grabCamFwd, _grabCamFwd, camera.quaternion);
    const anchorWS: Vec3 = [
        center[0] - (camera.position[0] + _grabCamFwd[0] * grabDistance),
        center[1] - (camera.position[1] + _grabCamFwd[1] * grabDistance),
        center[2] - (camera.position[2] + _grabCamFwd[2] * grabDistance),
    ];
    quat.invert(_grabInvCam, camera.quaternion);
    const anchorOffsetCS: Vec3 = [0, 0, 0];
    vec3.transformQuat(anchorOffsetCS, anchorWS, _grabInvCam);

    // anchor orientation in camera space: inv(cam.quat) * body.quat
    const anchorQuatCS: Quat = [0, 0, 0, 1];
    quat.multiply(anchorQuatCS, _grabInvCam, startQuat);

    // pivotOffsetLocal = inv(body.quat) * (transform.position - bodyStartCenter).
    // body sits at AABB center; transform.position can be anywhere. by storing
    // the offset in body-local space we get correct pivot tracking through
    // rotations: world offset = body.quat * pivotOffsetLocal.
    const pivotWS: Vec3 = [
        transform.position[0] - center[0],
        transform.position[1] - center[1],
        transform.position[2] - center[2],
    ];
    const pivotOffsetLocal: Vec3 = [0, 0, 0];
    const invStartQuat: Quat = [0, 0, 0, 1];
    quat.invert(invStartQuat, startQuat);
    vec3.transformQuat(pivotOffsetLocal, pivotWS, invStartQuat);

    state.grab = {
        nodeId,
        bodyId: body.id,
        grabDistance,
        anchorOffsetCS,
        anchorQuatCS,
        pivotOffsetLocal,
        snapshot: {
            nodeId,
            position: vec3.clone(transform.position),
            quaternion: quat.clone(transform.quaternion),
            scale: vec3.clone(transform.scale),
        },
        rotating: false,
        targetQuat: [0, 0, 0, 1],
    };
}

/**
 * per-frame grab input — handles scroll wheel for grab distance. body PD
 * runs in prePhysicsGrab (fixed step); transform write runs in
 * postPhysicsGrab (also fixed step) so render-frame interpolation smooths
 * the body's pose between ticks.
 *
 * no-op when no grab is active.
 */
export function updateGrab(state: TransformToolState, mk: MouseKeyboardInput): void {
    const grab = state.grab;
    if (!grab) return;

    // wheel → adjust grab distance (multiplicative so it feels uniform near/far)
    if (mk._wheelDeltaY !== 0) {
        const factor = 1 - mk._wheelDeltaY * GRAB_DIST_SCROLL;
        grab.grabDistance = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, grab.grabDistance * factor));
    }
}

/**
 * fixed-step PD controller for the held body. computes the camera-relative
 * target pose and writes linear/angular velocities. runs in onPrePhysicsStep
 * so the body integrates against fresh velocity inputs each tick.
 *
 * no-op when no grab is active.
 */
export function prePhysicsGrab(state: TransformToolState, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) return;

    // target world pose:
    //   pos = cam.pos + cam.fwd * grabDistance + anchorOffsetCS rotated into world
    //   quat = (rotating) targetQuat — user-driven via mouse
    //          (resting)  cam.quat * anchorQuatCS — follows the camera
    vec3.set(_grabCamFwd, 0, 0, -1);
    vec3.transformQuat(_grabCamFwd, _grabCamFwd, camera.quaternion);
    vec3.transformQuat(_grabRel, grab.anchorOffsetCS, camera.quaternion);
    _grabTargetPos[0] = camera.position[0] + _grabCamFwd[0] * grab.grabDistance + _grabRel[0];
    _grabTargetPos[1] = camera.position[1] + _grabCamFwd[1] * grab.grabDistance + _grabRel[1];
    _grabTargetPos[2] = camera.position[2] + _grabCamFwd[2] * grab.grabDistance + _grabRel[2];
    if (grab.rotating) {
        _grabTargetQuat[0] = grab.targetQuat[0];
        _grabTargetQuat[1] = grab.targetQuat[1];
        _grabTargetQuat[2] = grab.targetQuat[2];
        _grabTargetQuat[3] = grab.targetQuat[3];
    } else {
        quat.multiply(_grabTargetQuat, camera.quaternion, grab.anchorQuatCS);
    }

    // PD-ish: linear velocity proportional to position error, capped.
    _grabPosErr[0] = _grabTargetPos[0] - body.position[0];
    _grabPosErr[1] = _grabTargetPos[1] - body.position[1];
    _grabPosErr[2] = _grabTargetPos[2] - body.position[2];
    _grabLinVel[0] = _grabPosErr[0] * GRAB_LIN_STIFF;
    _grabLinVel[1] = _grabPosErr[1] * GRAB_LIN_STIFF;
    _grabLinVel[2] = _grabPosErr[2] * GRAB_LIN_STIFF;
    const linMag = vec3.length(_grabLinVel);
    if (linMag > GRAB_LIN_VMAX) vec3.scale(_grabLinVel, _grabLinVel, GRAB_LIN_VMAX / linMag);
    rigidBody.setLinearVelocity(physics.rigid.world, body, _grabLinVel);

    // angular: deltaQ = targetQuat * inv(body.quat); ensure shortest arc; axis*angle/dt-ish
    const invBody: Quat = [body.quaternion[0], body.quaternion[1], body.quaternion[2], body.quaternion[3]];
    quat.invert(invBody, invBody);
    quat.multiply(_grabDeltaQ, _grabTargetQuat, invBody);
    if (_grabDeltaQ[3] < 0) {
        _grabDeltaQ[0] = -_grabDeltaQ[0];
        _grabDeltaQ[1] = -_grabDeltaQ[1];
        _grabDeltaQ[2] = -_grabDeltaQ[2];
        _grabDeltaQ[3] = -_grabDeltaQ[3];
    }
    const sinHalf = Math.sqrt(_grabDeltaQ[0] * _grabDeltaQ[0] + _grabDeltaQ[1] * _grabDeltaQ[1] + _grabDeltaQ[2] * _grabDeltaQ[2]);
    const angle = 2 * Math.atan2(sinHalf, _grabDeltaQ[3]);
    if (sinHalf > 1e-6) {
        const inv = 1 / sinHalf;
        _grabAngVel[0] = _grabDeltaQ[0] * inv * angle * GRAB_ANG_STIFF;
        _grabAngVel[1] = _grabDeltaQ[1] * inv * angle * GRAB_ANG_STIFF;
        _grabAngVel[2] = _grabDeltaQ[2] * inv * angle * GRAB_ANG_STIFF;
    } else {
        _grabAngVel[0] = 0;
        _grabAngVel[1] = 0;
        _grabAngVel[2] = 0;
    }
    const angMag = vec3.length(_grabAngVel);
    if (angMag > GRAB_ANG_VMAX) vec3.scale(_grabAngVel, _grabAngVel, GRAB_ANG_VMAX / angMag);
    rigidBody.setAngularVelocity(physics.rigid.world, body, _grabAngVel);
}

/**
 * fixed-step body→transform writeback. runs in onPostPhysicsStep so the new
 * pose is captured by the regular Interpolation.snapshot+interpolate pipeline,
 * giving smooth motion at the render rate even though physics ticks at a
 * fixed cadence. body is anchored to the AABB center, so rotate
 * pivotOffsetLocal into world space and add it back to preserve off-center
 * transform positions through rotations.
 *
 * no-op when no grab is active.
 */
export function postPhysicsGrab(state: TransformToolState, nodes: Nodes, physics: Physics): void {
    const grab = state.grab;
    if (!grab) return;
    const node = getNodeById(nodes, grab.nodeId);
    if (!node) return;
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) return;

    vec3.transformQuat(_grabRel, grab.pivotOffsetLocal, body.quaternion);
    transform.position[0] = body.position[0] + _grabRel[0];
    transform.position[1] = body.position[1] + _grabRel[1];
    transform.position[2] = body.position[2] + _grabRel[2];
    transform.quaternion[0] = body.quaternion[0];
    transform.quaternion[1] = body.quaternion[1];
    transform.quaternion[2] = body.quaternion[2];
    transform.quaternion[3] = body.quaternion[3];
    markTransformDirty(transform);
}

/**
 * begin gmod-physgun-style free-rotate. while held, mouse delta drives the
 * body's orientation directly via targetQuat; body's allowedDegreesOfFreedom
 * is widened to all axes so it physically responds. linear PD continues
 * tracking the camera anchor — the body still moves with you, just freely
 * rotating to whatever the user dials in.
 *
 * caller is expected to be inside an active grab.
 */
export function beginRotate(state: TransformToolState, physics: Physics): void {
    const grab = state.grab;
    if (!grab) return;
    if (grab.rotating) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) return;

    body.motionProperties.allowedDegreesOfFreedom = GRAB_DOF_ROTATE;
    grab.targetQuat[0] = body.quaternion[0];
    grab.targetQuat[1] = body.quaternion[1];
    grab.targetQuat[2] = body.quaternion[2];
    grab.targetQuat[3] = body.quaternion[3];
    grab.rotating = true;
}

const _grabRotYaw: Quat = [0, 0, 0, 1];
const _grabRotPitch: Quat = [0, 0, 0, 1];
const _grabRotRight: Vec3 = [1, 0, 0];

/**
 * apply mouse delta to the in-progress rotate. dx → yaw around world up;
 * dy → pitch around camera right. accumulated into grab.targetQuat.
 *
 * no-op if grab isn't active or isn't currently rotating.
 */
export function applyRotateDelta(state: TransformToolState, dx: number, dy: number, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab || !grab.rotating) return;
    if (dx === 0 && dy === 0) return;

    // yaw around world-Y
    const yawAngle = -dx * GRAB_ROT_SENS;
    quat.setAxisAngle(_grabRotYaw, [0, 1, 0], yawAngle);

    // pitch around camera-right (cam.quat applied to [1,0,0])
    vec3.set(_grabRotRight, 1, 0, 0);
    vec3.transformQuat(_grabRotRight, _grabRotRight, camera.quaternion);
    const pitchAngle = -dy * GRAB_ROT_SENS;
    quat.setAxisAngle(_grabRotPitch, _grabRotRight, pitchAngle);

    // pre-multiply: targetQuat = yaw * pitch * targetQuat
    quat.multiply(grab.targetQuat, _grabRotPitch, grab.targetQuat);
    quat.multiply(grab.targetQuat, _grabRotYaw, grab.targetQuat);
    quat.normalize(grab.targetQuat, grab.targetQuat);
}

/**
 * end free-rotate: lock pitch/roll back to the resting yaw-only DOF and
 * re-anchor anchorQuatCS to the body's current orientation so the held
 * object holds its new pose as we look around afterward.
 */
export function endRotate(state: TransformToolState, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab) return;
    if (!grab.rotating) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) {
        grab.rotating = false;
        return;
    }

    // recompute camera-space anchor from the new body orientation:
    // anchorQuatCS = inv(cam.quat) * body.quat
    quat.invert(_grabInvCam, camera.quaternion);
    quat.multiply(grab.anchorQuatCS, _grabInvCam, body.quaternion);

    body.motionProperties.allowedDegreesOfFreedom = GRAB_DOF_REST;
    grab.rotating = false;
}

/**
 * release the active grab: destroy the body and commit a single undo entry
 * for the start→end transform. no-op if no grab active. if `commit` is false
 * (e.g. exiting tool/mode mid-hold), still destroys the body but no undo.
 */
export function exitGrab(state: TransformToolState, nodes: Nodes, physics: Physics, ctx: ScriptContext): void {
    const grab = state.grab;
    if (!grab) return;

    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (body) rigidBody.remove(physics.rigid.world, body);

    const node = getNodeById(nodes, grab.nodeId);
    if (!node) {
        state.grab = null;
        return;
    }
    const transform = getTrait(node, TransformTrait);
    if (!transform) {
        state.grab = null;
        return;
    }

    const final: TransformSnapshot = {
        nodeId: grab.nodeId,
        position: vec3.clone(transform.position),
        quaternion: quat.clone(transform.quaternion),
        scale: vec3.clone(transform.scale),
    };
    const start = grab.snapshot;
    state.grab = null;

    // skip undo if nothing actually changed (very short tap)
    if (
        vec3.equals(start.position, final.position) &&
        quat.equals(start.quaternion, final.quaternion) &&
        vec3.equals(start.scale, final.scale)
    ) {
        return;
    }

    state.store.getState().action({
        label: 'grab',
        do() {
            const n = getNodeById(nodes, grab.nodeId);
            if (!n) return;
            const props = {
                position: vec3.clone(final.position),
                quaternion: quat.clone(final.quaternion),
                scale: vec3.clone(final.scale),
            };
            setTraitProps(nodes, n, 'transform', props);
            send(ctx, SetTraitCommand, { id: grab.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            state.store.getState().markDirty();
        },
        undo() {
            const n = getNodeById(nodes, grab.nodeId);
            if (!n) return;
            const props = {
                position: vec3.clone(start.position),
                quaternion: quat.clone(start.quaternion),
                scale: vec3.clone(start.scale),
            };
            setTraitProps(nodes, n, 'transform', props);
            send(ctx, SetTraitCommand, { id: grab.nodeId, traitId: 'transform', props: JSON.stringify(props) });
            state.store.getState().markDirty();
        },
    });
}

export function isInGrab(state: TransformToolState): boolean {
    return state.grab !== null;
}

// ── keyboard shortcuts for the transform tool ──────────────────────
//
// handles both placement mode (inPlacement=true) and normal gizmo mode.
// called from the inspect/transform onFrame block whenever activeTool === 'transform'
// and isInputFocused() is false.

export function handleTransformKeys(
    mk: MouseKeyboardInput,
    input: Input,
    cameraQuat: Quat,
    state: TransformToolState,
    nodes: Nodes,
    ctx: ScriptContext,
): void {
    const inPlacement = isInPlacement(state);

    if (inPlacement) {
        const placement = state.placement!;
        // Q/T/Y → switch to gizmo mode (pins ghost, marks placed)
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

        // Enter → commit placement
        if (isKeyJustDown(mk, 'Enter')) {
            commitPlacement(state, nodes, ctx.voxels, ctx);
        }

        // Escape → cancel placement (restores cut voxels if applicable)
        if (isKeyJustDown(mk, 'Escape')) {
            cancelPlacement(state, nodes, ctx);
        }

        // arrow keys + [ / ] → mode-aware nudge during placement
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
                    nudgePlacement(state, nodes, nudge[0], nudge[1], nudge[2]);
                }
            } else if (plMode === 'rotate') {
                if (isVoxelPlacement(state)) {
                    // voxel placement: rotate voxel data in 90-deg steps.
                    // axes are camera-relative so rotation feels consistent
                    // regardless of viewing angle.
                    // left/right → always Y axis
                    // forward/backward → camera-right world axis (X or Z)
                    // [/] → camera-forward world axis (X or Z)
                    const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
                    const [fwdX, fwdZ] = snapCardinal(yaw);
                    // camera-forward aligns with X when fwdX != 0, else Z
                    const fwdAxis: 'x' | 'z' = fwdX !== 0 ? 'x' : 'z';
                    const rgtAxis: 'x' | 'z' = fwdX !== 0 ? 'z' : 'x';
                    // sign of the cardinal component along each axis —
                    // flip rotation direction when facing negative so
                    // "forward tilt" and "roll" feel consistent
                    const fwdSign = (fwdX !== 0 ? fwdX : fwdZ) as 1 | -1;
                    const rgtSign = (fwdX !== 0 ? -fwdX : fwdZ) as 1 | -1;

                    if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
                        rotatePlacement(state, nodes, 1, 'y');
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                        rotatePlacement(state, nodes, -1, 'y');
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                        rotatePlacement(state, nodes, (1 * rgtSign) as 1 | -1, rgtAxis);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                        rotatePlacement(state, nodes, (-1 * rgtSign) as 1 | -1, rgtAxis);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                        rotatePlacement(state, nodes, (1 * fwdSign) as 1 | -1, fwdAxis);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                        rotatePlacement(state, nodes, (-1 * fwdSign) as 1 | -1, fwdAxis);
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
                        rotateNodes(state, nodes, ctx, [0, 1, 0], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                        rotateNodes(state, nodes, ctx, [0, 1, 0], -snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                        rotateNodes(state, nodes, ctx, [rgtX, 0, rgtZ], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                        rotateNodes(state, nodes, ctx, [rgtX, 0, rgtZ], -snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                        rotateNodes(state, nodes, ctx, [fwdX, 0, fwdZ], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                        rotateNodes(state, nodes, ctx, [fwdX, 0, fwdZ], -snap);
                    }
                }
            } else if (plMode === 'scale') {
                const snap = state.store.getState().scaleSnap ?? 0.25;
                if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    scaleNodes(state, nodes, ctx, 1 + snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    scaleNodes(state, nodes, ctx, 1 / (1 + snap));
                }
            }
        }
    } else {
        // R/T/Y/U/I in normal transform → switch gizmo mode (top-row left-to-right).
        // suppressed while actively grabbing so R-hold can drive grab-rotate.
        if (!isInGrab(state)) {
            if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.rotate)) {
                state.store.setState({ transformMode: 'rotate' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.translate)) {
                state.store.setState({ transformMode: 'translate' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.scale)) {
                state.store.setState({ transformMode: 'scale' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.place)) {
                state.store.setState({ transformMode: 'place' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.grab)) {
                state.store.setState({ transformMode: 'grab' });
            }
        }

        // P → toggle pivot preset (no-op when not in placement; setPlacementPivot itself bails)
        if (isKeyJustDown(mk, TRANSFORM_OTHER_KEYS.togglePivot)) {
            const current = state.placement?.pivotPreset ?? 'center';
            const presets: PivotPreset[] = ['min', 'center', 'max'];
            const idx = presets.indexOf(current);
            const next = presets[(idx + 1) % 3];
            setPlacementPivot(state, next, nodes);
        }

        // Escape → clear selection first, then return to inspect
        if (isKeyJustDown(mk, 'Escape')) {
            if (state.store.getState().selection.nodes.size > 0) {
                state.store.getState().clearSelection();
            } else {
                state.store.setState({ activeTool: 'inspect' });
            }
        }

        // X → toggle world/local space
        if (isKeyJustDown(mk, TRANSFORM_OTHER_KEYS.toggleSpace)) {
            const current = state.store.getState().transformSpace;
            state.store.setState({ transformSpace: current === 'world' ? 'local' : 'world' });
        }

        // nudge: behavior depends on gizmo mode
        {
            const { transformMode: mode } = state.store.getState();

            if (mode === 'translate' || mode === 'place') {
                // camera-relative position nudge
                const nudge = readNudgeDelta(input, cameraQuat);
                if (nudge) {
                    // nudge in place mode → pin ghost and switch to translate
                    if (mode === 'place' && state.placement) {
                        state.placement.placed = true;
                        state.store.setState({ transformMode: 'translate' });
                    }
                    const [ndx, ndy, ndz] = nudge;
                    nudgeNodes(state, nodes, ctx, ndx, ndy, ndz);
                    nudgeVoxelsFromSelection(state, nodes, ctx, ndx, ndy, ndz);
                }
            } else if (mode === 'rotate') {
                // left/right = rotate around Y
                // up/down = rotate around camera-right axis (pitch)
                // [ / ] = rotate around camera-forward axis (roll)
                // voxel content forces 90deg regardless of user's rotationSnap —
                // any other value produces non-cardinal quats which don't round-trip
                // through rotateVoxelsByQuat.
                const baseSnapDeg = state.store.getState().rotationSnap ?? 45;
                const snapDeg = computeTransformHasVoxels(state, nodes) ? 90 : baseSnapDeg;
                const snap = snapDeg * (Math.PI / 180);
                const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
                const [fwdX, fwdZ] = snapCardinal(yaw);
                // camera-right = perpendicular to forward in XZ plane
                const rgtX = fwdZ,
                    rgtZ = -fwdX;

                if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
                    rotateNodes(state, nodes, ctx, [0, 1, 0], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                    rotateNodes(state, nodes, ctx, [0, 1, 0], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                    rotateNodes(state, nodes, ctx, [rgtX, 0, rgtZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                    rotateNodes(state, nodes, ctx, [rgtX, 0, rgtZ], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    rotateNodes(state, nodes, ctx, [fwdX, 0, fwdZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    rotateNodes(state, nodes, ctx, [fwdX, 0, fwdZ], -snap);
                }
            } else if (mode === 'scale') {
                // ] = scale up, [ = scale down
                const snap = state.store.getState().scaleSnap ?? 0.25;
                if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    scaleNodes(state, nodes, ctx, 1 + snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    scaleNodes(state, nodes, ctx, 1 / (1 + snap));
                }
            }
        }
    }
}
