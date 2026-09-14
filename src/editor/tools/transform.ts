import type { PerspectiveCamera } from 'gpucat';
import { Object3D, type Scene } from 'gpucat';
import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import {
    getVisualWorldMatrix,
    getVisualWorldPosition,
    getVisualWorldQuaternion,
    markTransformDirty,
    TransformTrait,
} from '../../builtins/transform';
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
import { registry } from '../../core/registry';
import type { Resources } from '../../core/resources';
import { prefabHasVoxels } from '../../core/scene/prefab';
import { getAtPath, setAtPath } from '../../core/scene/prop/path';
import type { Schema } from '../../core/scene/prop/prop';
import type { Node, SceneTree } from '../../core/scene/scene-tree';
import { getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import { type ControlDef, cloneTraitValue, type TraitBase } from '../../core/scene/traits';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import { setTraitProps } from '../actions';
import { readNudgeDelta, snapCardinal, yawFromQuat } from '../camera';
import type { PivotPreset } from './placement';

export type { PivotPreset } from './placement';

import type { VoxelOp } from '../blueprint';
import { SetTraitCommand } from '../commands';
import type { ActiveFrame, EditRoomStoreApi, SnapTo } from '../edit-room-store';
import { NUDGE_KEYS, TRANSFORM_GIZMO_KEYS, TRANSFORM_OTHER_KEYS } from '../editor-controls';
import { useEditor } from '../editor-store';
import { unionSubtreeWorldAabb } from '../node-aabb';
import * as TransformControls from '../transform-controls';
import { commitVoxelOps } from '../voxel-edit';

export type TransformSnapshot = {
    nodeId: number;
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
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

export type TransformToolState = {
    store: EditRoomStoreApi;
    sceneTree: SceneTree;
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

    /** what the gizmo drives: the selection by default, a placement ghost while one is up. */
    target: NodeTarget;

    // reset on drag start; used when rotation is forced to cardinal snap.
    dragRotSteps: [number, number, number];
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
        sceneTree,
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
        dragRotSteps: [0, 0, 0],
        target: null as unknown as NodeTarget,
    };

    state.target = selectionTarget(state, sceneTree);

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

        state.target.onBegin?.(proxy);

        const nodeIds = state.target.nodeIds();
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
    });

    const unsubChange = gizmo.onObjectChange.add(() => {
        if (!state.dragging) return;

        const mode = gizmo.mode;

        if (state.frameDrag) {
            _applyFrameDrag(state, sceneTree, mode);
            return;
        }

        if (mode === 'translate') {
            const snapTo = effectiveSnapTo(state.store);
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
                t.position[0] = snapAxis(snap.position[0] + dx, step, snapTo, 0);
                t.position[1] = snapAxis(snap.position[1] + dy, step, snapTo, 1);
                t.position[2] = snapAxis(snap.position[2] + dz, step, snapTo, 2);
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
            const snapToCardinal = state.target.cardinalRotate();

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

                const onCardinalSteps = state.target.onCardinalSteps;
                if (onCardinalSteps) {
                    // the target applies whole steps itself (a voxel ghost re-bakes per step); the nodes stay at their snapshots.
                    for (const { axis, idx } of axes) onCardinalSteps(axis, state.dragRotSteps[idx]);
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

        // an ephemeral target (a placement ghost) gets its history entry on commit, not per drag
        if (state.target.ephemeral) return;

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

// corner: the grid. face-top-center: cell centre across, grid up. block-center: cell centre on every axis. no step: free.
export function snapAxis(value: number, step: number | null, snapTo: SnapTo, axis: 0 | 1 | 2): number {
    if (step === null) return value;
    const cellCentre = snapTo === 'block-center' || (snapTo === 'face-top-center' && axis !== 1);
    if (cellCentre) return Math.floor(value / step) * step + step / 2;
    return Math.round(value / step) * step;
}

const SNAP_DEFAULT_TRANSLATION = 1;

const SNAP_DEFAULT_ROTATION_DEG = 15;

const SNAP_DEFAULT_SCALE = 0.25;

export function feedPointer(state: TransformToolState, mk: MouseKeyboardInput): void {
    state.consumedClick = false;
    state.invertSnap = isModDown(mk);
    if (!state.gizmoAttached) return;
    // under pointer lock the cursor is the crosshair: the centre ray picks, and looking around drives the drag.
    const cursor = getCursor(mk);
    const locked = isMouseLocked(mk);
    _pointer.x = locked ? 0 : cursor.ndcX;
    _pointer.y = locked ? 0 : cursor.ndcY;
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
    if (!state.gizmoAttached || state.gizmo.dragging || !state.target.instantDrags) return;
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

/** sync the gizmo with the current selection (or placement root) and store settings; call every frame while activeTool === 'transform'. */
export function updateTransformTool(state: TransformToolState, sceneTree: SceneTree, resources: Resources): Vec3 | null {
    const storeState = state.store.getState();
    const { transformMode, transformSpace, translationSnap, rotationSnap, scaleSnap } = storeState;

    // place mode: no gizmo; the placement tool follows the cursor and reports its own pivot.
    if (transformMode === 'place') {
        _detachGizmo(state);
        return null;
    }

    // grab mode: no gizmo; the grab tool drives the body and reports its own pivot.
    if (transformMode === 'grab') {
        _detachGizmo(state);
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

    if (!state.target.pose(state.proxy, !state.dragging, resources)) {
        _detachGizmo(state);
        return null;
    }
    _ensureGizmoAttached(state);
    return [...state.proxy.position] as Vec3;
}

/** what the gizmo drives: a set of nodes moved by deltas, positioned at a pose while idle. */
export type NodeTarget = {
    nodeIds(): number[];
    /** places the proxy for an idle gizmo when `idle`; false means there is nothing to attach to. */
    pose(proxy: Object3D, idle: boolean, resources: Resources): boolean;
    /** voxel content: grid snaps forced, scale blocked. */
    hasVoxels(): boolean;
    /** rotation in 90 degree steps. */
    cardinalRotate(): boolean;
    onBegin?(proxy: Object3D): void;
    /** a target that applies whole steps itself gets the cumulative step count per axis while the nodes stay at their snapshots. */
    onCardinalSteps?(axis: 'x' | 'y' | 'z', totalSteps: number): void;
    /** no history entry per drag. */
    ephemeral: boolean;
    instantDrags: boolean;
    subFrames: boolean;
};

/** swaps what the gizmo drives; null returns it to the selection. */
export function setTarget(state: TransformToolState, target: NodeTarget | null): void {
    state.target = target ?? selectionTarget(state, state.sceneTree);
}

function selectionTarget(state: TransformToolState, sceneTree: SceneTree): NodeTarget {
    return {
        nodeIds: () => [...state.store.getState().selection.nodes],
        pose: (proxy, idle, resources) => {
            const selectedNodes: { node: Node; transform: TransformTrait }[] = [];
            for (const nodeId of state.store.getState().selection.nodes) {
                const node = getNodeById(sceneTree, nodeId);
                if (!node) continue;
                const t = getTrait(node, TransformTrait);
                if (!t) continue;
                selectedNodes.push({ node, transform: t });
            }
            if (selectedNodes.length === 0) return false;
            if (!idle) return true;
            const selectionPivot = state.store.getState().selectionPivot;
            if (selectionPivot !== 'center' && _selectionPivotCorner(selectedNodes, resources, selectionPivot, _centroid)) {
                vec3.copy(proxy.position, _centroid);
                quat.identity(proxy.quaternion);
            } else if (selectedNodes.length === 1) {
                const t = selectedNodes[0]!.transform;
                vec3.copy(proxy.position, getVisualWorldPosition(t));
                quat.copy(proxy.quaternion, getVisualWorldQuaternion(t));
            } else {
                vec3.set(_centroid, 0, 0, 0);
                for (const { transform: t } of selectedNodes) vec3.add(_centroid, _centroid, getVisualWorldPosition(t));
                vec3.scale(_centroid, _centroid, 1 / selectedNodes.length);
                vec3.copy(proxy.position, _centroid);
                quat.identity(proxy.quaternion);
            }
            // proxy scale stays identity; non-uniform scale would corrupt the worldQuaternion mat4.decompose extracts in the gizmo.
            vec3.set(proxy.scale, 1, 1, 1);
            return true;
        },
        hasVoxels: () => selectionHasVoxels(state, sceneTree),
        cardinalRotate: () => state.store.getState().transformHasVoxels,
        ephemeral: false,
        instantDrags: true,
        subFrames: true,
    };
}

/** attach the gizmo if it isn't; a target's owner calls this when it takes over the proxy. */
export function attachGizmo(state: TransformToolState): void {
    _ensureGizmoAttached(state);
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
    if (!activeFrame || !state.target.subFrames) return null;
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

const _frameParent: Mat4 = mat4.create();
const _frameParentQuaternion: Quat = [0, 0, 0, 1];
const _frameStep: Mat4 = mat4.create();

// node world times every `frame` annotation enclosing the edited field along the path. the object at the path contributes
// its own frame only when the field being edited is not that frame (a shape's centre sits inside the object's frame).
function _enclosingMatrix(frame: ResolvedFrame, out: Mat4): Mat4 {
    mat4.copy(out, getVisualWorldMatrix(frame.transform));
    let schema: Schema = frame.control.schema;
    let value: unknown = frame.control.get(frame.instance);
    const path = frame.activeFrame.path;
    for (let i = 0; i <= path.length; i++) {
        // resolve wrappers to the object they hold
        for (;;) {
            if (schema.type === 'optional' || schema.type === 'nullable' || schema.type === 'nullish') schema = schema.of;
            else if (schema.type === 'union' && value !== null && typeof value === 'object') {
                const discriminator = (value as Record<string, unknown>)[schema.key];
                const variant = schema.variants.find((v) => {
                    const lit = v.fields[schema.type === 'union' ? schema.key : ''];
                    return lit !== undefined && lit.type === 'literal' && lit.value === discriminator;
                });
                if (!variant) return out;
                schema = variant;
            } else break;
        }
        if (schema.type === 'object' && value !== null && typeof value === 'object') {
            const local = value as Record<string, unknown>;
            const editingThisFrame = i === path.length && schema.frame?.position === frame.activeFrame.position;
            if (schema.frame && !editingThisFrame) {
                const p: Vec3 = schema.frame.position
                    ? ((local[schema.frame.position] as Vec3 | undefined) ?? [0, 0, 0])
                    : [0, 0, 0];
                const q: Quat = schema.frame.quaternion
                    ? ((local[schema.frame.quaternion] as Quat | undefined) ?? [0, 0, 0, 1])
                    : [0, 0, 0, 1];
                mat4.fromRotationTranslation(_frameStep, q, p);
                mat4.multiply(out, out, _frameStep);
            }
        }
        if (i === path.length) break;
        const key = path[i]!;
        if (schema.type === 'object') {
            schema = schema.fields[key as string]!;
            value = (value as Record<string, unknown>)[key as string];
        } else if (schema.type === 'list') {
            schema = schema.of;
            value = (value as unknown[])[key as number];
        } else {
            return out;
        }
    }
    return out;
}

function _frameWorldPose(frame: ResolvedFrame, proxy: Object3D): void {
    const { position, quaternion } = frame.activeFrame;
    const localPosition = position ? (frame.local[position] as Vec3 | undefined) : undefined;
    const localQuaternion = quaternion ? (frame.local[quaternion] as Quat | undefined) : undefined;
    const parent = _enclosingMatrix(frame, _frameParent);
    vec3.transformMat4(proxy.position, localPosition ?? vec3.set(_frameLocalPosition, 0, 0, 0), parent);
    mat4.getRotation(_frameParentQuaternion, parent);
    quat.multiply(proxy.quaternion, _frameParentQuaternion, localQuaternion ?? quat.identity(_frameLocalQuaternion));
    vec3.set(proxy.scale, 1, 1, 1);
}

function _applyFrameDrag(state: TransformToolState, sceneTree: SceneTree, mode: 'translate' | 'rotate' | 'scale'): void {
    const drag = state.frameDrag!;
    const frame = _resolveFrame(drag, sceneTree);
    if (!frame) return;
    let next: Record<string, unknown> = frame.local;
    const parent = _enclosingMatrix(frame, _frameParent);
    if (mode === 'translate' && drag.position) {
        mat4.invert(_frameInvWorld, parent);
        vec3.transformMat4(_frameLocalPosition, state.proxy.position, _frameInvWorld);
        const step = state.translateStep;
        next = {
            ...next,
            [drag.position]: [
                snapAxis(_frameLocalPosition[0], step, 'corner', 0),
                snapAxis(_frameLocalPosition[1], step, 'corner', 1),
                snapAxis(_frameLocalPosition[2], step, 'corner', 2),
            ],
        };
    } else if (mode === 'rotate' && drag.quaternion) {
        mat4.getRotation(_frameParentQuaternion, parent);
        quat.invert(_frameInvWorldQuaternion, _frameParentQuaternion);
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

/** nudges selected nodes by (dx, dy, dz), wrapped in an undo action. */
export function nudgeNodes(
    state: TransformToolState,
    sceneTree: SceneTree,
    ctx: ScriptContext,
    dx: number,
    dy: number,
    dz: number,
): void {
    const nodeIds = state.target.nodeIds();
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
            if (state.target.ephemeral) continue;
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ position: vec3.clone(e.position) }),
            });
        }
    };

    if (state.target.ephemeral) {
        apply(finals);
        return;
    }
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
    const nodeIds = state.target.nodeIds();
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
            if (state.target.ephemeral) continue;
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ quaternion: quat.clone(e.quaternion) }),
            });
        }
    };

    if (state.target.ephemeral) {
        apply(finals);
        return;
    }
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
    const nodeIds = state.target.nodeIds();
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
            if (state.target.ephemeral) continue;
            send(ctx, SetTraitCommand, {
                id: e.nodeId,
                traitId: 'transform',
                props: JSON.stringify({ scale: vec3.clone(e.scale) }),
            });
        }
    };

    if (state.target.ephemeral) {
        apply(finals);
        return;
    }
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

/** detects whether the active placement or current selection contains voxel data, which forces snapTo to 'corner'. */
export function computeTransformHasVoxels(state: TransformToolState, sceneTree: SceneTree): boolean {
    return state.target.hasVoxels() || selectionHasVoxels(state, sceneTree);
}

function selectionHasVoxels(state: TransformToolState, sceneTree: SceneTree): boolean {
    const store = state.store.getState();
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

/** the store's snapTo, forced to 'corner' when voxel content is involved. */
export function effectiveSnapTo(store: EditRoomStoreApi): SnapTo {
    const s = store.getState();
    return s.transformHasVoxels ? 'corner' : s.snapTo;
}

// handles both placement mode and normal gizmo mode; called from the inspect/transform onFrame block.
export function handleTransformKeys(
    mk: MouseKeyboardInput,
    input: Input,
    cameraQuat: Quat,
    state: TransformToolState,
    sceneTree: SceneTree,
    ctx: ScriptContext,
    grabbing: boolean,
): void {
    // mid-drag the keys belong to the drag: axis locks, Escape cancels, nothing else fires.
    if (state.gizmo.dragging) {
        handleAxisLockKeys(state, mk);
        if (isKeyJustDown(mk, 'Escape')) cancelDrag(state);
        return;
    }

    // switch gizmo mode; the mode's own key again starts an instant drag from the cursor.
    // suppressed while grabbing so R-hold can drive grab-rotate.
    if (!grabbing) {
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
