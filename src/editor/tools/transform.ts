import { type BodyId, box, dof, MotionType, rigidBody } from 'crashcat';
import type { PerspectiveCamera } from 'gpucat';
import { Object3D, type Scene } from 'gpucat';
import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { MarkerTrait } from '../../builtins/marker';
import {
    getVisualWorldMatrix,
    getVisualWorldPosition,
    getVisualWorldQuaternion,
    markTransformDirty,
    setPosition,
    TransformTrait,
} from '../../builtins/transform';
import { createVoxelModel, VoxelMeshTrait } from '../../builtins/voxel-mesh';
import type { Input, MouseKeyboardInput } from '../../client/input';
import {
    getCursor,
    isKeyDown,
    isKeyJustDown,
    isModDown,
    isMouseDown,
    isMouseJustDown,
    isMouseJustUp,
    isMouseLocked,
} from '../../client/input';
import type { Physics } from '../../core/physics/physics';
import { OBJECT_LAYER_NODE_MOVING } from '../../core/physics/physics';
import { registry } from '../../core/registry';
import type { Resources } from '../../core/resources';
import { prefabHasVoxels } from '../../core/scene/prefab';
import { getAtPath, setAtPath } from '../../core/scene/prop/path';
import type { Node, SceneTree, SerializedNode } from '../../core/scene/scene-tree';
import { addChild, addTrait, createNode, deserializeNode, destroyNode, getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import { type ControlDef, cloneTraitValue, type TraitBase } from '../../core/scene/traits';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import { setTraitProps } from '../actions';
import type { Blueprint as BlueprintData, VoxelOp } from '../blueprint';
import * as Blueprint from '../blueprint';
import { readNudgeDelta, snapCardinal, yawFromQuat } from '../camera';
import { CreateNodeCommand, DestroyNodeCommand, SetTraitCommand } from '../commands';
import type { ActiveFrame, EditRoomStoreApi } from '../edit-room-store';
import { NUDGE_KEYS, TRANSFORM_GIZMO_KEYS, TRANSFORM_OTHER_KEYS } from '../editor-controls';
import { useEditor } from '../editor-store';
import { unionSubtreeWorldAabb } from '../node-aabb';
import * as TransformControls from '../transform-controls';
import { commitVoxelOps } from '../voxel-edit';

type TransformSnapshot = {
    nodeId: number;
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
};

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

    // standalone voxel ghost node, or null for node-only blueprints; positioned manually each frame in _syncProxyFromPlacementRoot.
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

// single nullable object on TransformToolState; the body is created directly in the physics world and destroyed the moment grab ends.
type FrameDrag = ActiveFrame & { startValue: unknown };

type ResolvedFrame = {
    activeFrame: ActiveFrame;
    node: Node;
    transform: TransformTrait;
    control: ControlDef;
    instance: TraitBase;
    /** the object at `activeFrame.path` inside the control's value. */
    local: Record<string, unknown>;
};

export type GrabState = {
    nodeId: number;
    bodyId: BodyId;
    // distance along camera forward to the held anchor point.
    grabDistance: number;
    // body-to-target offset in camera space at grab-start, keeps the grabbed object screen-relative as the camera looks around.
    anchorOffsetCS: Vec3;
    // body orientation in camera space at grab-start; pitch/roll locked by allowedDegreesOfFreedom.
    anchorQuatCS: Quat;
    // body-local space; world-space delta from body center to transform.position is body.quat * this.
    pivotOffsetLocal: Vec3;
    // start transform for the undo entry on release.
    snapshot: TransformSnapshot;
    // physgun-style free-rotate: while true, mouse dx/dy drives targetQuat directly instead of following the camera.
    rotating: boolean;
    // seeded from body.quat on rotate-begin.
    targetQuat: Quat;
};

export type TransformToolState = {
    store: EditRoomStoreApi;
    gizmo: TransformControls.TransformControls;
    proxy: Object3D;
    scene: Scene;

    gizmoAttached: boolean;
    snapshots: TransformSnapshot[];

    // for computing deltas.
    proxyStartPosition: Vec3;
    proxyStartQuaternion: Quat;
    proxyStartScale: Vec3;

    _unsubs: (() => void)[];
    dragging: boolean;
    /** set for the duration of a drag that writes a sub-frame instead of node transforms. */
    frameDrag: FrameDrag | null;
    /** a keyboard-started drag: the pointer moves it without a button held, a click commits, Escape cancels. */
    instantDrag: boolean;
    /** the click that committed an instant drag this frame; the inspect tool must not also select with it. */
    consumedClick: boolean;
    /** the snap modifier is held: snapping flips for the drag. */
    invertSnap: boolean;
    /** the translate grid for this frame's drag, null = free; nodes snap to it, the gizmo follows the node. */
    translateStep: number | null;

    // null outside placement mode; set in enterPlacement, cleared in _exitPlacementState.
    placement: PlacementState | null;

    // top-level ghost preview nodes; outlives `placement` so reconcilePlacementGhosts can reap orphans left by an unclean teardown.
    _ghostNodes: Set<Node>;

    grab: GrabState | null;

    // reset on drag start; used when rotation is forced to cardinal snap.
    dragRotSteps: [number, number, number];

    // snapshots from the first cursor-driven move in place-mode-with-selection; committed via commitPlaceSelection on exit, null otherwise.
    placeSnapshots: TransformSnapshot[] | null;
};

// `store` is patched in by the caller right after construction; closures access `state.store` only on user interaction, never synchronously during create.
// callers must keep `state.gizmo.camera` pointed at the active POV camera each frame.
export function createTransformTool(
    camera: PerspectiveCamera,
    scene: Scene,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): TransformToolState {
    const proxy = new Object3D();
    // proxy must be in the scene so gizmo can read parent world matrix
    scene.add(proxy);

    const gizmo = TransformControls.init(camera);
    scene.add(gizmo.root);

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
        frameDrag: null,
        instantDrag: false,
        consumedClick: false,
        invertSnap: false,
        translateStep: null,
        placement: null,
        _ghostNodes: new Set(),
        grab: null,
        dragRotSteps: [0, 0, 0],
        placeSnapshots: null,
    };

    const unsubDown = gizmo.onMouseDown.add(() => {
        state.dragging = true;

        const frame = _resolveActiveFrame(state, sceneTree);
        if (frame) {
            state.frameDrag = { ...frame.activeFrame, startValue: cloneTraitValue(frame.control.get(frame.instance) as object) };
            state.snapshots = [];
            vec3.copy(state.proxyStartPosition, proxy.position);
            quat.copy(state.proxyStartQuaternion, proxy.quaternion);
            return;
        }
        state.frameDrag = null;

        if (state.placement && !state.placement.placed) {
            state.placement.placed = true;
            const t = getTrait(state.placement.rootNode, TransformTrait);
            if (t) {
                vec3.copy(state.proxy.position, getVisualWorldPosition(t));
                quat.copy(state.proxy.quaternion, getVisualWorldQuaternion(t));
                vec3.set(state.proxy.scale, 1, 1, 1);
            }
        }

        const nodeIds = _activeNodeIds(state);
        state.snapshots = [];
        for (const nodeId of nodeIds) {
            const node = getNodeById(sceneTree, nodeId);
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

    const unsubChange = gizmo.onObjectChange.add(() => {
        if (!state.dragging) return;

        const mode = gizmo.mode;

        if (state.frameDrag) {
            _applyFrameDrag(state, sceneTree, mode);
            return;
        }

        if (mode === 'translate') {
            const faceCenter = _effectiveSnapTo(state) === 'face-center';
            const step = state.translateStep;

            const dx = proxy.position[0] - state.proxyStartPosition[0];
            const dy = proxy.position[1] - state.proxyStartPosition[1];
            const dz = proxy.position[2] - state.proxyStartPosition[2];

            let first: TransformSnapshot | null = null;
            for (const snap of state.snapshots) {
                const node = getNodeById(sceneTree, snap.nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;
                t.position[0] = snapAxis(snap.position[0] + dx, step, faceCenter);
                t.position[1] = snapAxis(snap.position[1] + dy, step, false);
                t.position[2] = snapAxis(snap.position[2] + dz, step, faceCenter);
                markTransformDirty(t);
                if (first === null) {
                    first = snap;
                    // the gizmo sits on the node: the proxy takes the snapped delta, the next pointer move re-derives from start.
                    proxy.position[0] = state.proxyStartPosition[0] + (t.position[0] - snap.position[0]);
                    proxy.position[1] = state.proxyStartPosition[1] + (t.position[1] - snap.position[1]);
                    proxy.position[2] = state.proxyStartPosition[2] + (t.position[2] - snap.position[2]);
                }
            }
        } else if (mode === 'rotate') {
            const invStart: Quat = quat.create();
            quat.invert(invStart, state.proxyStartQuaternion);
            const deltaQ: Quat = quat.create();
            quat.multiply(deltaQ, proxy.quaternion, invStart);

            // voxels only sit on the integer grid in cardinal orientations, so snap rotation to 90deg increments.
            const snapToCardinal = state.placement
                ? state.placement.rotation !== null
                : state.store.getState().transformHasVoxels;

            if (snapToCardinal) {
                // the gizmo constrains to one axis at a time, so check all three components.
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
                    // rebuild the blueprint per-step via rotatePlacement, since each call mutates the blueprint and must fire incrementally.
                    const placement = state.placement;
                    for (const { axis, idx } of axes) {
                        const totalSteps = state.dragRotSteps[idx];
                        const delta = totalSteps - placement.dragRotSteps[idx];
                        if (delta !== 0) {
                            const dir = delta > 0 ? 1 : -1;
                            const count = Math.abs(delta);
                            for (let i = 0; i < count; i++) {
                                rotatePlacement(state, dir as 1 | -1, axis);
                            }
                            placement.dragRotSteps[idx] = totalSteps;
                        }
                    }
                    quat.copy(proxy.quaternion, state.proxyStartQuaternion);
                    for (const snap of state.snapshots) {
                        const node = getNodeById(sceneTree, snap.nodeId);
                        if (!node) continue;
                        const t = getTrait(node, TransformTrait);
                        if (!t) continue;
                        quat.copy(t.quaternion, snap.quaternion);
                        markTransformDirty(t);
                    }
                    return;
                }

                // build absolute snapped delta from cumulative steps and apply against snapshot baseline.
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
                    const node = getNodeById(sceneTree, snap.nodeId);
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
                const node = getNodeById(sceneTree, snap.nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;

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
                const node = getNodeById(sceneTree, snap.nodeId);
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

    const unsubUp = gizmo.onMouseUp.add(() => {
        state.dragging = false;
        if (state.frameDrag) {
            _commitFrameDrag(state, sceneTree, ctx);
            return;
        }
        if (state.snapshots.length === 0) return;

        // placement drags are ephemeral, no undo entry until commit
        if (state.placement) return;

        const finals: TransformSnapshot[] = [];
        for (const snap of state.snapshots) {
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
        }

        const prevSnapshots = [...state.snapshots];

        state.store.getState().action({
            label: `transform ${gizmo.mode}`,
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
                    send(ctx, SetTraitCommand, {
                        id: f.nodeId,
                        traitId: 'transform',
                        props: JSON.stringify(props),
                    });
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
                    send(ctx, SetTraitCommand, {
                        id: s.nodeId,
                        traitId: 'transform',
                        props: JSON.stringify(props),
                    });
                }
            },
        });

        state.snapshots = [];
    });

    state._unsubs.push(unsubDown, unsubChange, unsubUp);

    return state;
}

const _pointer = { x: 0, y: 0, button: 0 };
const DRAG_MOVE_BUTTON = -1;

// corner: the grid; face-center: the middle of the cell on the horizontal axes; no step: free.
function snapAxis(value: number, step: number | null, faceCenter: boolean): number {
    if (step === null) return value;
    if (faceCenter) return Math.floor(value / step) * step + step / 2;
    return Math.round(value / step) * step;
}
const SNAP_DEFAULT_TRANSLATION = 1;
const SNAP_DEFAULT_ROTATION_DEG = 15;
const SNAP_DEFAULT_SCALE = 0.25;

export function feedPointer(state: TransformToolState, mk: MouseKeyboardInput): void {
    state.consumedClick = false;
    state.invertSnap = isModDown(mk);
    if (!state.gizmoAttached || isMouseLocked(mk)) return;
    const cursor = getCursor(mk);
    _pointer.x = cursor.ndcX;
    _pointer.y = cursor.ndcY;
    const gizmo = state.gizmo;
    if (state.instantDrag) {
        if (isMouseJustDown(mk, 'left')) {
            _pointer.button = 0;
            TransformControls.pointerUp(gizmo, _pointer);
            state.instantDrag = false;
            state.consumedClick = true;
        } else if (isMouseJustDown(mk, 'right')) {
            cancelDrag(state);
        } else {
            _pointer.button = DRAG_MOVE_BUTTON;
            TransformControls.pointerMove(gizmo, _pointer);
        }
        return;
    }
    if (isMouseJustDown(mk, 'left')) {
        _pointer.button = 0;
        TransformControls.pointerHover(gizmo, _pointer);
        TransformControls.pointerDown(gizmo, _pointer);
    } else if (isMouseJustUp(mk, 'left')) {
        _pointer.button = 0;
        TransformControls.pointerUp(gizmo, _pointer);
    } else if (gizmo.dragging && isMouseDown(mk, 'left')) {
        _pointer.button = DRAG_MOVE_BUTTON;
        TransformControls.pointerMove(gizmo, _pointer);
    } else {
        _pointer.button = 0;
        TransformControls.pointerHover(gizmo, _pointer);
    }
}

export function layoutGizmo(state: TransformToolState): void {
    if (state.gizmoAttached) TransformControls.update(state.gizmo);
}

const INSTANT_DRAG_AXIS = { translate: 'XYZ', rotate: 'E', scale: 'XYZ' } as const;

/** start a drag of `mode` from the cursor without a handle press. */
export function beginInstantDrag(state: TransformToolState, mode: 'translate' | 'rotate' | 'scale'): void {
    if (!state.gizmoAttached || state.gizmo.dragging || state.placement || state.grab) return;
    state.store.setState({ transformMode: mode });
    state.gizmo.mode = mode;
    TransformControls.update(state.gizmo);
    TransformControls.beginDrag(state.gizmo, _pointer, INSTANT_DRAG_AXIS[mode]);
    state.instantDrag = state.gizmo.dragging;
}

/** abandon the current drag; nodes return to their start poses with no history entry. */
export function cancelDrag(state: TransformToolState): void {
    if (!state.gizmo.dragging) return;
    TransformControls.cancelDrag(state.gizmo);
    state.dragging = false;
    state.snapshots = [];
    state.frameDrag = null;
    state.instantDrag = false;
}

const AXIS_LOCK_KEYS: Array<{ key: string; axis: 'X' | 'Y' | 'Z'; plane: 'YZ' | 'XZ' | 'XY' }> = [
    { key: 'KeyX', axis: 'X', plane: 'YZ' },
    { key: 'KeyY', axis: 'Y', plane: 'XZ' },
    { key: 'KeyZ', axis: 'Z', plane: 'XY' },
];

// X / Y / Z lock the drag to an axis, Shift + key to the plane across it (translate and scale only); the same key again frees it.
function handleAxisLockKeys(state: TransformToolState, mk: MouseKeyboardInput): void {
    const gizmo = state.gizmo;
    for (const { key, axis, plane } of AXIS_LOCK_KEYS) {
        if (!isKeyJustDown(mk, key)) continue;
        const wantPlane = gizmo.mode !== 'rotate' && (isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight'));
        const next = wantPlane ? plane : axis;
        const free = gizmo.mode === 'rotate' ? 'E' : 'XYZ';
        TransformControls.setDragAxis(gizmo, _pointer, gizmo.axis === next ? free : next);
    }
}

export function disposeTransformTool(state: TransformToolState): void {
    for (const unsub of state._unsubs) unsub();
    state._unsubs.length = 0;

    if (state.gizmoAttached) {
        TransformControls.detach(state.gizmo);
        state.gizmoAttached = false;
    }
    state.scene.remove(state.gizmo.root);
    TransformControls.dispose(state.gizmo);
    state.scene.remove(state.proxy);
}

const _centroid: Vec3 = [0, 0, 0];
const _placeScratch: Vec3 = [0, 0, 0];

/** sync the gizmo with the current selection (or placement root) and store settings; call every frame while activeTool === 'transform'. */
export function updateTransformTool(state: TransformToolState, sceneTree: SceneTree, resources: Resources): Vec3 | null {
    const storeState = state.store.getState();
    const { transformMode, transformSpace, translationSnap, rotationSnap, scaleSnap, selectionPivot } = storeState;

    // place mode: no gizmo, ghost follows cursor (driven externally via updatePlacementFromRaycast)
    if (transformMode === 'place') {
        _detachGizmo(state);

        const placement = state.placement;
        if (placement) {
            const t = getTrait(placement.rootNode, TransformTrait);
            if (t) {
                _syncVoxelGhost(placement, t);
                return [...getVisualWorldPosition(t)] as Vec3;
            }
        }
        return null;
    }

    // grab mode: no gizmo. body+pose driven by updateGrab() called separately.
    if (transformMode === 'grab') {
        _detachGizmo(state);
        const grab = state.grab;
        if (grab) {
            const node = getNodeById(sceneTree, grab.nodeId);
            const t = node ? getTrait(node, TransformTrait) : null;
            if (t) return [...getVisualWorldPosition(t)] as Vec3;
        }
        return null;
    }

    const frame = state.dragging && state.frameDrag ? null : _resolveActiveFrame(state, sceneTree);

    // voxel content lives on the integer grid and can't be sub-unit scaled, so force grid-aligned snaps and block scale mode.
    let gizmoMode = transformMode as 'translate' | 'rotate' | 'scale';
    let effectiveTranslationSnap = translationSnap;
    let effectiveRotationSnap = rotationSnap;
    let effectiveScaleSnap = scaleSnap;
    let snapForced = false;
    if (frame || state.frameDrag) {
        if (gizmoMode === 'scale') {
            gizmoMode = 'translate';
            state.store.setState({ transformMode: 'translate' });
        }
    } else if (computeTransformHasVoxels(state, sceneTree)) {
        effectiveTranslationSnap = 1;
        effectiveRotationSnap = 90;
        snapForced = true;
        if (gizmoMode === 'scale') {
            gizmoMode = 'translate';
            state.store.setState({ transformMode: 'translate' });
        }
    }
    // the modifier flips snapping for the drag: off becomes the default step, on becomes free.
    if (state.invertSnap && !snapForced) {
        effectiveTranslationSnap = effectiveTranslationSnap ? null : SNAP_DEFAULT_TRANSLATION;
        effectiveRotationSnap = effectiveRotationSnap ? null : SNAP_DEFAULT_ROTATION_DEG;
        effectiveScaleSnap = effectiveScaleSnap ? null : SNAP_DEFAULT_SCALE;
    }

    state.gizmo.mode = gizmoMode;
    state.gizmo.space = transformSpace;
    state.gizmo.translationSnap = null;
    state.translateStep = effectiveTranslationSnap;
    state.gizmo.rotationSnap = effectiveRotationSnap != null ? effectiveRotationSnap * (Math.PI / 180) : null;
    state.gizmo.scaleSnap = effectiveScaleSnap;

    if (state.frameDrag) {
        _ensureGizmoAttached(state);
        return [...state.proxy.position] as Vec3;
    }
    if (frame) {
        _ensureGizmoAttached(state);
        if (!state.dragging) _frameWorldPose(frame, state.proxy);
        return [...state.proxy.position] as Vec3;
    }

    // in placement mode, drive proxy from root ghost node only
    if (state.placement) {
        return _syncProxyFromPlacementRoot(state);
    }

    // normal mode: drive proxy from selected nodes
    const selectedNodes: { node: Node; transform: TransformTrait }[] = [];
    for (const nodeId of storeState.selection.nodes) {
        const node = getNodeById(sceneTree, nodeId);
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
        if (selectionPivot !== 'center' && _selectionPivotCorner(selectedNodes, resources, selectionPivot, _centroid)) {
            vec3.copy(state.proxy.position, _centroid);
            quat.identity(state.proxy.quaternion);
        } else if (selectedNodes.length === 1) {
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
        // keep proxy scale at identity; non-uniform scale would corrupt the worldQuaternion mat4.decompose extracts in the gizmo.
        vec3.set(state.proxy.scale, 1, 1, 1);
    }

    return [...state.proxy.position] as Vec3;
}

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

// returns the pivot world position, or null if root is missing.
function _syncProxyFromPlacementRoot(state: TransformToolState): Vec3 | null {
    const placement = state.placement;
    if (!placement) return null;
    const t = getTrait(placement.rootNode, TransformTrait);
    if (!t) return null;

    _ensureGizmoAttached(state);

    // only sync proxy when placed; before that, keep it at its current position so the gizmo doesn't jump.
    if (!state.dragging && placement.placed) {
        vec3.copy(state.proxy.position, getVisualWorldPosition(t));
        quat.copy(state.proxy.quaternion, getVisualWorldQuaternion(t));
        vec3.set(state.proxy.scale, 1, 1, 1);
    }

    _syncVoxelGhost(placement, t);

    return [...getVisualWorldPosition(t)] as Vec3;
}

function _ensureGizmoAttached(state: TransformToolState): void {
    if (!state.gizmoAttached) {
        TransformControls.attach(state.gizmo, state.proxy);
        state.gizmoAttached = true;
    }
}

function _detachGizmo(state: TransformToolState): void {
    if (state.gizmoAttached) {
        TransformControls.detach(state.gizmo);
        state.gizmoAttached = false;
    }
}

/** detach the gizmo immediately. call when switching away from the transform tool. */
export function detachGizmo(state: TransformToolState): void {
    _detachGizmo(state);
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

// during placement this is just the root ghost; otherwise it's the current selection.
function _activeNodeIds(state: TransformToolState): number[] {
    if (state.placement) {
        return [state.placement.rootNode.id];
    }
    return [...state.store.getState().selection.nodes];
}

const _pivotAabb: Box3 = box3.create();

// min / max corner of the selection's world AABB; false when nothing in the selection has bounds.
function _selectionPivotCorner(selectedNodes: { node: Node }[], resources: Resources, preset: PivotPreset, out: Vec3): boolean {
    box3.empty(_pivotAabb);
    let found = false;
    for (const { node } of selectedNodes) found = unionSubtreeWorldAabb(node, resources, _pivotAabb) || found;
    if (!found) return false;
    if (preset === 'min') vec3.set(out, _pivotAabb[0], _pivotAabb[1], _pivotAabb[2]);
    else vec3.set(out, _pivotAabb[3], _pivotAabb[4], _pivotAabb[5]);
    return true;
}

const _frameLocalPosition: Vec3 = [0, 0, 0];
const _frameLocalQuaternion: Quat = [0, 0, 0, 1];
const _frameInvWorld: Mat4 = mat4.create();
const _frameInvWorldQuaternion: Quat = [0, 0, 0, 1];

// the store's `activeFrame` is a request; it resolves only while its node is the active selection and the path still lands on an object.
function _resolveActiveFrame(state: TransformToolState, sceneTree: SceneTree): ResolvedFrame | null {
    const storeState = state.store.getState();
    const activeFrame = storeState.activeFrame;
    if (!activeFrame || state.placement) return null;
    const resolved = _resolveFrame(activeFrame, sceneTree);
    if (!resolved || Selection.activeNode(storeState.selection) !== activeFrame.nodeId) {
        state.store.setState({ activeFrame: null });
        return null;
    }
    return resolved;
}

function _resolveFrame(activeFrame: ActiveFrame, sceneTree: SceneTree): ResolvedFrame | null {
    const node = getNodeById(sceneTree, activeFrame.nodeId);
    if (!node) return null;
    const transform = getTrait(node, TransformTrait);
    if (!transform) return null;
    const handle = registry.traits.handles.get(activeFrame.traitId);
    if (!handle) return null;
    const control = handle.def.controls.find((c) => c.controlId === activeFrame.controlId);
    const instance = node.traits[handle.slot];
    if (!control || !instance) return null;
    const local = getAtPath(control.get(instance), activeFrame.path);
    if (local === null || typeof local !== 'object' || Array.isArray(local)) return null;
    return { activeFrame, node, transform, control, instance, local: local as Record<string, unknown> };
}

function _frameWorldPose(frame: ResolvedFrame, proxy: Object3D): void {
    const { position, quaternion } = frame.activeFrame;
    const localPosition = position ? (frame.local[position] as Vec3 | undefined) : undefined;
    const localQuaternion = quaternion ? (frame.local[quaternion] as Quat | undefined) : undefined;
    vec3.transformMat4(
        proxy.position,
        localPosition ?? vec3.set(_frameLocalPosition, 0, 0, 0),
        getVisualWorldMatrix(frame.transform),
    );
    quat.multiply(
        proxy.quaternion,
        getVisualWorldQuaternion(frame.transform),
        localQuaternion ?? quat.identity(_frameLocalQuaternion),
    );
    vec3.set(proxy.scale, 1, 1, 1);
}

function _applyFrameDrag(state: TransformToolState, sceneTree: SceneTree, mode: 'translate' | 'rotate' | 'scale'): void {
    const drag = state.frameDrag!;
    const frame = _resolveFrame(drag, sceneTree);
    if (!frame) return;
    let next: Record<string, unknown> = frame.local;
    if (mode === 'translate' && drag.position) {
        mat4.invert(_frameInvWorld, getVisualWorldMatrix(frame.transform));
        vec3.transformMat4(_frameLocalPosition, state.proxy.position, _frameInvWorld);
        const step = state.translateStep;
        next = {
            ...next,
            [drag.position]: [
                snapAxis(_frameLocalPosition[0], step, false),
                snapAxis(_frameLocalPosition[1], step, false),
                snapAxis(_frameLocalPosition[2], step, false),
            ],
        };
    } else if (mode === 'rotate' && drag.quaternion) {
        quat.invert(_frameInvWorldQuaternion, getVisualWorldQuaternion(frame.transform));
        quat.multiply(_frameLocalQuaternion, _frameInvWorldQuaternion, state.proxy.quaternion);
        next = { ...next, [drag.quaternion]: [..._frameLocalQuaternion] };
    } else {
        return;
    }
    const value = setAtPath(frame.control.get(frame.instance), drag.path, next);
    setTraitProps(sceneTree, frame.node, drag.traitId, { [drag.controlId]: value });
}

function _commitFrameDrag(state: TransformToolState, sceneTree: SceneTree, ctx: ScriptContext): void {
    const drag = state.frameDrag!;
    state.frameDrag = null;
    const frame = _resolveFrame(drag, sceneTree);
    if (!frame) return;
    const finalValue = cloneTraitValue(frame.control.get(frame.instance) as object);
    const startValue = drag.startValue;
    const { nodeId, traitId, controlId } = drag;
    const write = (value: unknown) => {
        const node = getNodeById(sceneTree, nodeId);
        if (!node) return;
        const props = { [controlId]: value };
        setTraitProps(sceneTree, node, traitId, props);
        send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(props) });
    };
    state.store.getState().action({
        label: `transform ${traitId}.${controlId} frame`,
        do: () => write(finalValue),
        undo: () => write(startValue),
    });
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
export function setPlacementPivot(state: TransformToolState, preset: PivotPreset): void {
    const placement = state.placement;
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
    state: TransformToolState,
    blueprint: BlueprintData,
    isCut: boolean,
    cutReverseOps: VoxelOp[] | null,
    sceneTree: SceneTree,
    _ctx: ScriptContext,
): void {
    if (state.placement) return;

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

    // voxel ghost is a standalone node, not a scene tree child of root: its position is set manually each frame in _syncProxyFromPlacementRoot.
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
    state.placement = {
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

    vec3.copy(state.proxy.position, rootTransform.position);
    quat.copy(state.proxy.quaternion, rootTransform.quaternion);
    vec3.set(state.proxy.scale, 1, 1, 1);

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
    state: TransformToolState,
    sceneTree: SceneTree,
    hitVoxel: [number, number, number],
    hitNormal: [number, number, number],
    hitPoint: [number, number, number] | null,
): void {
    const placement = state.placement;
    const [nx, ny, nz] = hitNormal;
    const [hx, hy, hz] = hitVoxel;

    // no active placement: drive currently-selected nodes from cursor, with snapTo controlling the alignment.
    if (!placement) {
        const selectedNodeIds = state.store.getState().selection.nodes;
        if (selectedNodeIds.size === 0) return;

        const [tx, ty, tz] = placePointOnFace(hitVoxel, hitNormal, hitPoint, _effectiveSnapTo(state));

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
export function nudgePlacement(state: TransformToolState, dx: number, dy: number, dz: number): void {
    const placement = state.placement;
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

/** nudges selected nodes by (dx, dy, dz), wrapped in an undo action. */
export function nudgeNodes(
    state: TransformToolState,
    sceneTree: SceneTree,
    ctx: ScriptContext,
    dx: number,
    dy: number,
    dz: number,
): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    const snapshots: { nodeId: number; position: Vec3 }[] = [];
    const finals: { nodeId: number; position: Vec3 }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(sceneTree, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, position: vec3.clone(t.position) });
        finals.push({ nodeId, position: [t.position[0] + dx, t.position[1] + dy, t.position[2] + dz] });
    }

    const apply = (entries: { nodeId: number; position: Vec3 }[]) => {
        for (const e of entries) {
            const n = getNodeById(sceneTree, e.nodeId);
            if (!n) continue;
            setTraitProps(sceneTree, n, 'transform', { position: vec3.clone(e.position) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ position: vec3.clone(e.position) }),
            });
        }
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

/** rotates selected nodes around the given world axis by angle (radians), wrapped in an undo action. */
export function rotateNodes(
    state: TransformToolState,
    sceneTree: SceneTree,
    ctx: ScriptContext,
    axis: Vec3,
    angle: number,
): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    // use angle as-is, do not override with storeState.rotationSnap: that strips sign and ignores voxel-content forced 90deg.
    quat.setAxisAngle(_nudgeRotQ, axis, angle);

    const snapshots: { nodeId: number; quaternion: Quat }[] = [];
    const finals: { nodeId: number; quaternion: Quat }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(sceneTree, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, quaternion: quat.clone(t.quaternion) });

        // pre-multiply for world-space rotation
        quat.multiply(_nudgeResult, _nudgeRotQ, t.quaternion);
        quat.normalize(_nudgeResult, _nudgeResult);
        finals.push({ nodeId, quaternion: [_nudgeResult[0], _nudgeResult[1], _nudgeResult[2], _nudgeResult[3]] });
    }

    const apply = (entries: { nodeId: number; quaternion: Quat }[]) => {
        for (const e of entries) {
            const n = getNodeById(sceneTree, e.nodeId);
            if (!n) continue;
            setTraitProps(sceneTree, n, 'transform', { quaternion: quat.clone(e.quaternion) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ quaternion: quat.clone(e.quaternion) }),
            });
        }
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

/** uniformly scales selected nodes by a multiplicative factor, wrapped in an undo action. */
export function scaleNodes(state: TransformToolState, sceneTree: SceneTree, ctx: ScriptContext, factor: number): void {
    const storeState = state.store.getState();
    const nodeIds = Array.from(storeState.selection.nodes);
    if (nodeIds.length === 0) return;

    const snapshots: { nodeId: number; scale: Vec3 }[] = [];
    const finals: { nodeId: number; scale: Vec3 }[] = [];
    for (const nodeId of nodeIds) {
        const node = getNodeById(sceneTree, nodeId);
        if (!node) continue;
        const t = getTrait(node, TransformTrait);
        if (!t) continue;
        snapshots.push({ nodeId, scale: vec3.clone(t.scale) });
        finals.push({ nodeId, scale: [t.scale[0] * factor, t.scale[1] * factor, t.scale[2] * factor] });
    }

    const apply = (entries: { nodeId: number; scale: Vec3 }[]) => {
        for (const e of entries) {
            const n = getNodeById(sceneTree, e.nodeId);
            if (!n) continue;
            setTraitProps(sceneTree, n, 'transform', { scale: vec3.clone(e.scale) });
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ scale: vec3.clone(e.scale) }),
            });
        }
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

/** nudges selected voxels from the store's current selection. */
export function nudgeVoxelsFromSelection(
    state: TransformToolState,
    _sceneTree: SceneTree,
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
            commitVoxelOps(ctx, forwardOps);
        },
        undo() {
            commitVoxelOps(ctx, reverseOps);
        },
    });
}

/** rotates the voxel content of the placement preview 90 degrees around the given axis; recomputes pivot offset for 'center'/'max' presets. */
export function rotatePlacement(state: TransformToolState, direction: 1 | -1 = 1, axis: 'x' | 'y' | 'z' = 'y'): void {
    const placement = state.placement;
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

export function flipPlacement(state: TransformToolState, axis: 'x' | 'y' | 'z'): void {
    const placement = state.placement;
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
export function commitPlacement(state: TransformToolState, sceneTree: SceneTree, worldVoxels: Voxels, ctx: ScriptContext): void {
    const placement = state.placement;
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
        if (state.placement) state.placement.sourcePrefabId = sourcePrefabId;
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
export function cancelPlacement(state: TransformToolState, ctx: ScriptContext): void {
    if (!state.placement) return;

    const cutReverseOps = state.placement.cutReverseOps;
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
export function revertPlaceSelection(state: TransformToolState, sceneTree: SceneTree): void {
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
export function commitPlaceSelection(state: TransformToolState, sceneTree: SceneTree, ctx: ScriptContext): void {
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
    state: TransformToolState,
    prefabId: string,
    anchor: Vec3,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    if (state.placement !== null) return;

    const runtime = ctx._runtime;
    if (!runtime) return;

    const blueprint = Blueprint.createPrefabBlueprint(prefabId, anchor, runtime, ctx.blocks);
    if (!blueprint) return;

    enterPlacement(state, blueprint, false, null, sceneTree, ctx);
    // enterPlacement always installs state.placement on success; the assertion bypasses TS narrowing from the bail-check above.
    const placement = state.placement as PlacementState | null;
    if (placement) placement.sourcePrefabId = prefabId;
}

/** enters placement mode for a saved blueprint scene; unlike prefabs, it pastes raw nodes + voxels with no source linkage. */
export function enterBlueprintPlacement(
    state: TransformToolState,
    sceneId: string,
    anchor: Vec3,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    if (state.placement !== null) return;
    const blueprint = Blueprint.createSceneBlueprint(sceneId, anchor, ctx.blocks);
    if (!blueprint) return;
    enterPlacement(state, blueprint, false, null, sceneTree, ctx);
    const placement = state.placement as PlacementState | null;
    if (placement) placement.sourceSceneId = sceneId;
}

/** true when placement mode is currently active */
export function isInPlacement(state: TransformToolState): boolean {
    return state.placement !== null;
}

/** detects whether the active placement or current selection contains voxel data, which forces snapTo to 'corner'. */
export function computeTransformHasVoxels(state: TransformToolState, sceneTree: SceneTree): boolean {
    const store = state.store.getState();
    if (state.placement?.blueprint.hasVoxels) return true;
    const room = useEditor.getState().room;
    if (!room) return false;
    for (const id of store.selection.nodes) {
        const node = getNodeById(sceneTree, id);
        if (!node) continue;
        const def = node.prefab ? registry.prefabs.byId.get(node.prefab.prefabId) : null;
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

// a freshly deserialized ghost subtree is a preview: its markers stay quiet until the placement commits into real nodes.
function _quietGhostMarkers(node: Node): void {
    const marker = getTrait(node, MarkerTrait);
    if (marker) marker.enabled = false;
    for (const child of node.children) _quietGhostMarkers(child);
}

function _destroyGhosts(state: TransformToolState): void {
    _detachGizmo(state);

    // destroy by object identity via each node's own scene pointer; destroyNode recurses into children.
    for (const node of state._ghostNodes) {
        if (node.scene) destroyNode(node.scene, node);
    }
    state._ghostNodes.clear();
}

/** per-frame backstop that reaps ghost nodes when a path drops `state.placement` without a clean teardown. */
export function reconcilePlacementGhosts(state: TransformToolState): void {
    if (state.placement === null && state._ghostNodes.size > 0) {
        _destroyGhosts(state);
    }
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

// physgun-style grab: holding left mouse creates a transient dynamic body driven by a PD controller toward a camera-relative anchor.

const GRAB_DIST_MIN = 1;
const GRAB_DIST_MAX = 100;
const GRAB_DIST_SCROLL = 0.005; // wheel-pixels to distance units (delta * grabDist * factor)
const GRAB_LIN_STIFF = 12; // velocity = posError * stiffness
const GRAB_ANG_STIFF = 12;
const GRAB_LIN_VMAX = 60; // m/s clamp
const GRAB_ANG_VMAX = 30; // rad/s clamp
const GRAB_FALLBACK_HALF = 0.5;
const GRAB_ROT_SENS = 0.005; // rad per pixel of mouse delta during R-rotate
// resting DOF: yaw-only rotation. matches enterGrab default, held things stay upright.
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

/** computes world-space half-extents and center for a node's subtree mesh AABB, falling back to a 0.5-unit cube if nothing contributes geometry. */
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

/** begins grabbing `nodeId`: creates a transient dynamic body sized to its subtree AABB and captures camera-relative anchors. */
export function enterGrab(
    state: TransformToolState,
    nodeId: number,
    sceneTree: SceneTree,
    physics: Physics,
    resources: Resources,
    camera: PerspectiveCamera,
): void {
    if (state.grab) return;
    const node = getNodeById(sceneTree, nodeId);
    if (!node) return;
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;

    // body pose uses AABB center rather than transform.position, so off-pivot models don't flail on grab-start.
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
        // pitch/roll locked, only yaw follows the camera by default; widened to all axes on R-hold.
        allowedDegreesOfFreedom: GRAB_DOF_REST,
    });

    const dx = center[0] - camera.position[0];
    const dy = center[1] - camera.position[1];
    const dz = center[2] - camera.position[2];
    const grabDistance = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, Math.sqrt(dx * dx + dy * dy + dz * dz)));

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

    // pivotOffsetLocal = inv(body.quat) * (transform.position - bodyStartCenter); world offset = body.quat * pivotOffsetLocal.
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

/** per-frame grab input; handles scroll wheel for grab distance, no-op when no grab is active. */
export function updateGrab(state: TransformToolState, mk: MouseKeyboardInput): void {
    const grab = state.grab;
    if (!grab) return;

    // wheel adjusts grab distance, multiplicative so it feels uniform near/far
    if (mk._wheelDeltaY !== 0) {
        const factor = 1 - mk._wheelDeltaY * GRAB_DIST_SCROLL;
        grab.grabDistance = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, grab.grabDistance * factor));
    }
}

/** fixed-step PD controller for the held body; computes the camera-relative target pose and writes linear/angular velocities. */
export function prePhysicsGrab(state: TransformToolState, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) return;

    // target pos = cam.pos + cam.fwd*grabDistance + anchorOffsetCS; target quat = targetQuat while rotating, else cam.quat * anchorQuatCS.
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
    const sinHalf = Math.sqrt(
        _grabDeltaQ[0] * _grabDeltaQ[0] + _grabDeltaQ[1] * _grabDeltaQ[1] + _grabDeltaQ[2] * _grabDeltaQ[2],
    );
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

/** fixed-step body-to-transform writeback; body is anchored to the AABB center, so pivotOffsetLocal is rotated back into world space. */
export function postPhysicsGrab(state: TransformToolState, sceneTree: SceneTree, physics: Physics): void {
    const grab = state.grab;
    if (!grab) return;
    const node = getNodeById(sceneTree, grab.nodeId);
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

/** begins free-rotate: mouse delta drives the body's orientation via targetQuat, and allowedDegreesOfFreedom widens to all axes. */
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

/** applies mouse delta to the in-progress rotate (dx = yaw around world up, dy = pitch around camera right), accumulated into grab.targetQuat. */
export function applyRotateDelta(state: TransformToolState, dx: number, dy: number, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab?.rotating) return;
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

/** ends free-rotate: locks pitch/roll back to the resting yaw-only DOF and re-anchors anchorQuatCS to the body's current orientation. */
export function endRotate(state: TransformToolState, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.grab;
    if (!grab) return;
    if (!grab.rotating) return;
    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (!body) {
        grab.rotating = false;
        return;
    }

    // anchorQuatCS = inv(cam.quat) * body.quat
    quat.invert(_grabInvCam, camera.quaternion);
    quat.multiply(grab.anchorQuatCS, _grabInvCam, body.quaternion);

    body.motionProperties.allowedDegreesOfFreedom = GRAB_DOF_REST;
    grab.rotating = false;
}

/** releases the active grab: destroys the body and commits a single undo entry for the start-to-end transform. */
export function exitGrab(state: TransformToolState, sceneTree: SceneTree, physics: Physics, ctx: ScriptContext): void {
    const grab = state.grab;
    if (!grab) return;

    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (body) rigidBody.remove(physics.rigid.world, body);

    const node = getNodeById(sceneTree, grab.nodeId);
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
            const n = getNodeById(sceneTree, grab.nodeId);
            if (!n) return;
            const props = {
                position: vec3.clone(final.position),
                quaternion: quat.clone(final.quaternion),
                scale: vec3.clone(final.scale),
            };
            setTraitProps(sceneTree, n, 'transform', props);
            send(ctx, SetTraitCommand, { id: grab.nodeId, traitId: 'transform', props: JSON.stringify(props) });
        },
        undo() {
            const n = getNodeById(sceneTree, grab.nodeId);
            if (!n) return;
            const props = {
                position: vec3.clone(start.position),
                quaternion: quat.clone(start.quaternion),
                scale: vec3.clone(start.scale),
            };
            setTraitProps(sceneTree, n, 'transform', props);
            send(ctx, SetTraitCommand, { id: grab.nodeId, traitId: 'transform', props: JSON.stringify(props) });
        },
    });
}

export function isInGrab(state: TransformToolState): boolean {
    return state.grab !== null;
}

// handles both placement mode and normal gizmo mode; called from the inspect/transform onFrame block.
export function handleTransformKeys(
    mk: MouseKeyboardInput,
    input: Input,
    cameraQuat: Quat,
    state: TransformToolState,
    sceneTree: SceneTree,
    ctx: ScriptContext,
): void {
    const inPlacement = isInPlacement(state);

    if (inPlacement) {
        const placement = state.placement!;
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
                        rotateNodes(state, sceneTree, ctx, [0, 1, 0], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                        rotateNodes(state, sceneTree, ctx, [0, 1, 0], -snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                        rotateNodes(state, sceneTree, ctx, [rgtX, 0, rgtZ], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                        rotateNodes(state, sceneTree, ctx, [rgtX, 0, rgtZ], -snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                        rotateNodes(state, sceneTree, ctx, [fwdX, 0, fwdZ], snap);
                    } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                        rotateNodes(state, sceneTree, ctx, [fwdX, 0, fwdZ], -snap);
                    }
                }
            } else if (plMode === 'scale') {
                const snap = state.store.getState().scaleSnap ?? 0.25;
                if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    scaleNodes(state, sceneTree, ctx, 1 + snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    scaleNodes(state, sceneTree, ctx, 1 / (1 + snap));
                }
            }
        }
    } else {
        // mid-drag the keys belong to the drag: axis locks, Escape cancels, nothing else fires.
        if (state.gizmo.dragging) {
            handleAxisLockKeys(state, mk);
            if (isKeyJustDown(mk, 'Escape')) cancelDrag(state);
            return;
        }

        // switch gizmo mode; the mode's own key again starts an instant drag from the cursor.
        // suppressed while grabbing so R-hold can drive grab-rotate.
        if (!isInGrab(state)) {
            const mode = state.store.getState().transformMode;
            if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.rotate)) {
                if (mode === 'rotate') beginInstantDrag(state, 'rotate');
                else state.store.setState({ transformMode: 'rotate' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.translate)) {
                if (mode === 'translate') beginInstantDrag(state, 'translate');
                else state.store.setState({ transformMode: 'translate' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.scale)) {
                if (mode === 'scale') beginInstantDrag(state, 'scale');
                else state.store.setState({ transformMode: 'scale' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.place)) {
                state.store.setState({ transformMode: 'place' });
            } else if (isKeyJustDown(mk, TRANSFORM_GIZMO_KEYS.grab)) {
                state.store.setState({ transformMode: 'grab' });
            }
        }

        // Escape returns the gizmo to the node, then clears selection, then returns to inspect
        if (isKeyJustDown(mk, 'Escape')) {
            if (state.store.getState().activeFrame !== null) {
                state.store.setState({ activeFrame: null });
            } else if (state.store.getState().selection.nodes.size > 0) {
                state.store.getState().clearNodeSelection();
            } else {
                state.store.setState({ activeTool: 'inspect' });
            }
        }

        // X toggles world/local space
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
                    // nudge in place mode pins the ghost and switches to translate
                    if (mode === 'place' && state.placement) {
                        state.placement.placed = true;
                        state.store.setState({ transformMode: 'translate' });
                    }
                    const [ndx, ndy, ndz] = nudge;
                    nudgeNodes(state, sceneTree, ctx, ndx, ndy, ndz);
                    nudgeVoxelsFromSelection(state, sceneTree, ctx, ndx, ndy, ndz);
                }
            } else if (mode === 'rotate') {
                // left/right rotates around Y, up/down around camera-right (pitch), [/] around camera-forward (roll).
                const baseSnapDeg = state.store.getState().rotationSnap ?? 45;
                const snapDeg = computeTransformHasVoxels(state, sceneTree) ? 90 : baseSnapDeg;
                const snap = snapDeg * (Math.PI / 180);
                const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
                const [fwdX, fwdZ] = snapCardinal(yaw);
                // camera-right = perpendicular to forward in XZ plane
                const rgtX = fwdZ,
                    rgtZ = -fwdX;

                if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
                    rotateNodes(state, sceneTree, ctx, [0, 1, 0], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
                    rotateNodes(state, sceneTree, ctx, [0, 1, 0], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
                    rotateNodes(state, sceneTree, ctx, [rgtX, 0, rgtZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
                    rotateNodes(state, sceneTree, ctx, [rgtX, 0, rgtZ], -snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    rotateNodes(state, sceneTree, ctx, [fwdX, 0, fwdZ], snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    rotateNodes(state, sceneTree, ctx, [fwdX, 0, fwdZ], -snap);
                }
            } else if (mode === 'scale') {
                // ] = scale up, [ = scale down
                const snap = state.store.getState().scaleSnap ?? 0.25;
                if (isKeyJustDown(mk, NUDGE_KEYS.up)) {
                    scaleNodes(state, sceneTree, ctx, 1 + snap);
                } else if (isKeyJustDown(mk, NUDGE_KEYS.down)) {
                    scaleNodes(state, sceneTree, ctx, 1 / (1 + snap));
                }
            }
        }
    }
}
