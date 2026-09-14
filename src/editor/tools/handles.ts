import type { PerspectiveCamera } from 'gpucat';
import { unproject } from 'gpucat';
import { type Mat4, mat4, type Vec3, vec3 } from 'math';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import type { Cursor, MouseKeyboardInput } from '../../client/input';
import { getCursor, isModDown, isMouseDown, isMouseJustDown, isMouseLocked } from '../../client/input';
import { registry } from '../../core/registry';
import { type PropPath, setAtPath } from '../../core/scene/prop/path';
import type { ShapeSpecData } from '../../core/scene/prop/prop';
import { walkObjects } from '../../core/scene/prop/specs';
import type { Node, SceneTree } from '../../core/scene/scene-tree';
import { getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import { type ControlDef, cloneTraitValue, type TraitBase } from '../../core/scene/traits';
import * as Quads from '../../render/overlay/quads';
import * as Text from '../../render/overlay/text';
import { setTraitProps } from '../actions';
import { SetTraitCommand } from '../commands';
import type { EditRoomStoreApi } from '../edit-room-store';
import { silhouette } from '../visuals/shape-outlines';

const HANDLE_HALF_SIZE_PX = 9.5;

/** the pointer under pointer lock: the screen centre. */
const CROSSHAIR: Cursor = { x: 0, y: 0, ndcX: 0, ndcY: 0 };

const HANDLE_DOT_PX = 14;

const HANDLE_DOT_HOT_PX = 18;

const FRAME_DOT_PX = 10;

const HANDLE_LABEL_SCALE = 2;

const HANDLE_LABEL_GAP_PX = 6;

const AXIS_NAMES = ['x', 'y', 'z'] as const;

const READOUT_DX_PX = HANDLE_DOT_HOT_PX / 2 + HANDLE_LABEL_GAP_PX;

const MIN_LENGTH = 0.05;

const MAX_RAY_DIST = 1024;

const DOT_COLOR: [number, number, number, number] = [1, 1, 1, 1];

const HOT_COLOR: [number, number, number, number] = [1, 0.85, 0.1, 1];

const FRAME_COLOR: [number, number, number, number] = [0.3, 0.9, 1, 1];

type Handle = {
    kind: 'box-face' | 'radius' | 'segment-end' | 'frame';
    nodeId: number;
    traitId: string;
    controlId: string;
    /** to the annotated object inside the control value. */
    path: PropPath;
    field: string;
    axis: 0 | 1 | 2;
    sign: -1 | 1;
    /** node world times every enclosing frame. */
    matrix: Mat4;
    world: Vec3;
    framePosition: string | undefined;
    frameQuaternion: string | undefined;
};

export type HandlesState = {
    handles: Handle[];
    hovered: number;
    /** the armed handle's own copy: `handles` are pooled and rewritten every frame, so a reference into them goes stale. */
    armed: Handle | null;
    startValue: unknown;
    pool: Handle[];
};

function sameHandle(a: Handle, b: Handle): boolean {
    return (
        a.nodeId === b.nodeId &&
        a.traitId === b.traitId &&
        a.controlId === b.controlId &&
        a.kind === b.kind &&
        a.field === b.field &&
        a.axis === b.axis &&
        a.sign === b.sign &&
        a.path.length === b.path.length &&
        a.path.every((key, i) => key === b.path[i])
    );
}

function copyHandle(handle: Handle): Handle {
    return { ...handle, path: [...handle.path], matrix: mat4.clone(handle.matrix), world: vec3.clone(handle.world) };
}

export function init(): HandlesState {
    return { handles: [], hovered: -1, armed: null, startValue: null, pool: [] };
}

export function isEngaged(state: HandlesState): boolean {
    return state.armed !== null || state.hovered !== -1;
}

export function update(
    state: HandlesState,
    enabled: boolean,
    mk: MouseKeyboardInput,
    camera: PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
    sceneTree: SceneTree,
    ctx: ScriptContext,
    store: EditRoomStoreApi,
    quads: Quads.QuadBatch,
    text: Text.TextBatch,
): void {
    const storeState = store.getState();
    const activeId = enabled ? Selection.activeNode(storeState.selection) : null;
    const node = activeId !== null ? getNodeById(sceneTree, activeId) : undefined;
    const cursor = isMouseLocked(mk) ? CROSSHAIR : getCursor(mk);

    if (state.armed) {
        if (!isMouseDown(mk, 'left')) {
            commit(state, sceneTree, ctx, store);
        } else {
            drag(state, cursor, camera, sceneTree, store, isModDown(mk));
        }
    }

    collect(state, node, camera.position);
    if (state.armed) {
        // the live handle carries this frame's matrix and world point (a box face moves as its extent changes).
        const live = state.handles.find((handle) => sameHandle(handle, state.armed!));
        if (live) {
            mat4.copy(state.armed.matrix, live.matrix);
            vec3.copy(state.armed.world, live.world);
        }
    }
    if (!state.armed) {
        state.hovered = nearest(state, cursor, camera, viewportWidth, viewportHeight);
        if (state.hovered !== -1 && isMouseJustDown(mk, 'left')) arm(state, state.handles[state.hovered]!, sceneTree, store);
    }
    draw(state, camera, viewportWidth, viewportHeight, quads, text);
}

function handleLabel(handle: Handle): string {
    if (handle.kind === 'box-face') return `${handle.field} ${AXIS_NAMES[handle.axis]}${handle.sign > 0 ? '+' : '-'}`;
    if (handle.kind === 'frame') return 'frame';
    return handle.field;
}

function arm(state: HandlesState, handle: Handle, sceneTree: SceneTree, store: EditRoomStoreApi): void {
    if (handle.kind === 'frame') {
        // arming a frame hands it to the gizmo, which lives in the transform tool
        const { activeTool, transformMode } = store.getState();
        const keepMode = activeTool === 'transform' && (transformMode === 'translate' || transformMode === 'rotate');
        store.setState({
            activeFrame: {
                nodeId: handle.nodeId,
                traitId: handle.traitId,
                controlId: handle.controlId,
                path: handle.path,
                position: handle.framePosition,
                quaternion: handle.frameQuaternion,
            },
            activeTool: 'transform',
            transformMode: keepMode ? transformMode : 'translate',
        });
        return;
    }
    const target = resolve(handle, sceneTree);
    if (!target) return;
    state.armed = copyHandle(handle);
    state.startValue = cloneTraitValue(target.control.get(target.instance) as object);
}

function commit(state: HandlesState, sceneTree: SceneTree, ctx: ScriptContext, store: EditRoomStoreApi): void {
    const handle = state.armed!;
    state.armed = null;
    const target = resolve(handle, sceneTree);
    if (!target) return;
    const finalValue = cloneTraitValue(target.control.get(target.instance) as object);
    const startValue = state.startValue;
    const { nodeId, traitId, controlId } = handle;
    const write = (value: unknown) => {
        const node = getNodeById(sceneTree, nodeId);
        if (!node) return;
        const props = { [controlId]: value };
        setTraitProps(sceneTree, node, traitId, props);
        send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(props) });
    };
    store.getState().action({
        label: `resize ${traitId}.${controlId}`,
        do: () => write(finalValue),
        undo: () => write(startValue),
    });
}

/** the live value under the armed handle, for the drag readout; null when idle. */
export function readout(state: HandlesState, sceneTree: SceneTree): { text: string; at: Vec3; dxPx: number } | null {
    const handle = state.armed;
    if (!handle) return null;
    const target = resolve(handle, sceneTree);
    if (!target) return null;
    const value = target.local[handle.field];
    if (handle.kind === 'box-face') {
        const half = value as Vec3;
        return {
            text: `${handle.field}[${handle.axis}] ${half[handle.axis]!.toFixed(2)}`,
            at: handle.world,
            dxPx: READOUT_DX_PX,
        };
    }
    if (handle.kind === 'radius')
        return { text: `${handle.field} ${(value as number).toFixed(2)}`, at: handle.world, dxPx: READOUT_DX_PX };
    const point = value as Vec3;
    return {
        text: `${handle.field} ${point[0].toFixed(2)} ${point[1].toFixed(2)} ${point[2].toFixed(2)}`,
        at: handle.world,
        dxPx: READOUT_DX_PX,
    };
}

type Target = { node: Node; control: ControlDef; instance: TraitBase; local: Record<string, unknown> };

function resolve(handle: Handle, sceneTree: SceneTree): Target | null {
    const node = getNodeById(sceneTree, handle.nodeId);
    if (!node) return null;
    const trait = registry.traits.handles.get(handle.traitId);
    if (!trait) return null;
    const control = trait.def.controls.find((c) => c.controlId === handle.controlId);
    const instance = node.traits[trait.slot];
    if (!control || !instance) return null;
    let local: unknown = control.get(instance);
    for (const key of handle.path) {
        if (local === null || typeof local !== 'object') return null;
        local = (local as Record<string | number, unknown>)[key];
    }
    if (local === null || typeof local !== 'object') return null;
    return { node, control, instance, local: local as Record<string, unknown> };
}

const _near: Vec3 = [0, 0, 0];

const _far: Vec3 = [0, 0, 0];

const _dir: Vec3 = [0, 0, 0];

const _origin: Vec3 = [0, 0, 0];

const _axis: Vec3 = [0, 0, 0];

const _hit: Vec3 = [0, 0, 0];

const _eye: Vec3 = [0, 0, 0];

const _inverse: Mat4 = mat4.create();

function cursorRay(cursor: Cursor, camera: PerspectiveCamera): void {
    unproject(_near, [cursor.ndcX, cursor.ndcY, 0], camera);
    unproject(_far, [cursor.ndcX, cursor.ndcY, 1], camera);
    vec3.subtract(_dir, _far, _near);
    vec3.normalize(_dir, _dir);
}

// the closest point on the ray to the line `origin + t * axis`, returned as t along the axis.
function rayLineParam(origin: Vec3, axis: Vec3): number {
    const w0 = vec3.subtract(_hit, _near, origin);
    const b = vec3.dot(_dir, axis);
    const d = vec3.dot(_dir, w0);
    const e = vec3.dot(axis, w0);
    const denominator = 1 - b * b;
    if (Math.abs(denominator) < 1e-6) return e;
    return (e - b * d) / denominator;
}

// the hit of the ray with the plane through `origin` facing the camera; false when the ray is parallel.
function rayCameraPlane(origin: Vec3, camera: PerspectiveCamera, out: Vec3): boolean {
    vec3.subtract(_eye, camera.position, origin);
    vec3.normalize(_eye, _eye);
    const denominator = vec3.dot(_dir, _eye);
    if (Math.abs(denominator) < 1e-6) return false;
    const t = vec3.dot(vec3.subtract(out, origin, _near), _eye) / denominator;
    if (t < 0 || t > MAX_RAY_DIST) return false;
    vec3.scaleAndAdd(out, _near, _dir, t);
    return true;
}

const SNAP_DEFAULT = 1;

// the modifier flips snapping: off becomes the default step, on becomes free.
function snapLength(value: number, store: EditRoomStoreApi, invert: boolean): number {
    const setting = store.getState().translationSnap;
    const snap = invert ? (setting ? null : SNAP_DEFAULT) : setting;
    const snapped = snap ? Math.round(value / snap) * snap : value;
    return Math.max(snapped, MIN_LENGTH);
}

function drag(
    state: HandlesState,
    cursor: Cursor,
    camera: PerspectiveCamera,
    sceneTree: SceneTree,
    store: EditRoomStoreApi,
    invertSnap: boolean,
): void {
    const handle = state.armed!;
    const target = resolve(handle, sceneTree);
    if (!target) return;
    cursorRay(cursor, camera);
    const m = handle.matrix;
    vec3.set(_origin, m[12]!, m[13]!, m[14]!);
    let next: Record<string, unknown> | null = null;

    if (handle.kind === 'box-face') {
        const column = handle.axis * 4;
        vec3.normalize(_axis, vec3.set(_axis, m[column]!, m[column + 1]!, m[column + 2]!));
        const t = rayLineParam(_origin, _axis) * handle.sign;
        const half = [...(target.local[handle.field] as Vec3)] as Vec3;
        half[handle.axis] = snapLength(t, store, invertSnap);
        next = { ...target.local, [handle.field]: half };
    } else if (handle.kind === 'radius') {
        if (rayCameraPlane(_origin, camera, _hit)) {
            next = { ...target.local, [handle.field]: snapLength(vec3.distance(_hit, _origin), store, invertSnap) };
        }
    } else if (handle.kind === 'segment-end') {
        if (rayCameraPlane(handle.world, camera, _hit)) {
            mat4.invert(_inverse, m);
            vec3.transformMat4(_hit, _hit, _inverse);
            next = { ...target.local, [handle.field]: [_hit[0], _hit[1], _hit[2]] };
        }
    }
    if (!next) return;
    const value = setAtPath(target.control.get(target.instance), handle.path, next);
    setTraitProps(sceneTree, target.node, handle.traitId, { [handle.controlId]: value });
}

const _view: Mat4 = mat4.create();

const _viewProjection: Mat4 = mat4.create();

const _projected: Vec3 = [0, 0, 0];

const _viewSpace: Vec3 = [0, 0, 0];

function nearest(state: HandlesState, cursor: Cursor, camera: PerspectiveCamera, width: number, height: number): number {
    // the view matrix comes from matrixWorld the way the gizmo's raycaster does, not from a cached inverse that may lag.
    mat4.invert(_view, camera.matrixWorld);
    mat4.multiply(_viewProjection, camera.projectionMatrix, _view);
    let best = -1;
    let bestDistance = HANDLE_HALF_SIZE_PX;
    for (let i = 0; i < state.handles.length; i++) {
        // in front of the camera is a view-space test; NDC depth ranges differ between the WebGPU and WebGL backends.
        vec3.transformMat4(_viewSpace, state.handles[i]!.world, _view);
        if (_viewSpace[2] >= 0) continue;
        vec3.transformMat4(_projected, state.handles[i]!.world, _viewProjection);
        const dx = ((_projected[0] - cursor.ndcX) * width) / 2;
        const dy = ((_projected[1] - cursor.ndcY) * height) / 2;
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

const LABEL_MIN_PX = 28;
const _placedLabels: { x: number; y: number }[] = [];

function draw(
    state: HandlesState,
    camera: PerspectiveCamera,
    width: number,
    height: number,
    quads: Quads.QuadBatch,
    text: Text.TextBatch,
): void {
    mat4.invert(_view, camera.matrixWorld);
    mat4.multiply(_viewProjection, camera.projectionMatrix, _view);
    _placedLabels.length = 0;
    for (let i = 0; i < state.handles.length; i++) {
        const handle = state.handles[i]!;
        const hot = (state.armed !== null && sameHandle(handle, state.armed)) || i === state.hovered;
        const [r, g, b, a] = hot ? HOT_COLOR : handle.kind === 'frame' ? FRAME_COLOR : DOT_COLOR;
        const size = hot ? HANDLE_DOT_HOT_PX : handle.kind === 'frame' ? FRAME_DOT_PX : HANDLE_DOT_PX;
        const [x, y, z] = handle.world;
        Quads.dot(quads, x, y, z, size, r, g, b, a);
        if (state.armed !== null && sameHandle(handle, state.armed)) continue;
        // on a small shape the dots bunch up; a label yields to one already placed within reach, the hot dot always wins.
        vec3.transformMat4(_projected, handle.world, _viewProjection);
        const px = ((_projected[0] + 1) * width) / 2;
        const py = ((1 - _projected[1]) * height) / 2;
        const crowded = !hot && _placedLabels.some((p) => Math.hypot(p.x - px, p.y - py) < LABEL_MIN_PX);
        if (crowded) continue;
        _placedLabels.push({ x: px, y: py });
        Text.labelLeft(text, x, y, z, handleLabel(handle), HANDLE_LABEL_SCALE, size / 2 + HANDLE_LABEL_GAP_PX, 0, r, g, b, a);
    }
}

// collection: one handle per box face, sphere radius, segment end and frame origin on the active node.

let _collecting: HandlesState | null = null;

let _nodeId = 0;

let _traitId = '';

let _controlId = '';

let _collectEye: Vec3 = [0, 0, 0];

function collect(state: HandlesState, node: Node | undefined, eye: Vec3): void {
    _collectEye = eye;
    for (const handle of state.handles) state.pool.push(handle);
    state.handles.length = 0;
    if (!node) return;
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    const world = getVisualWorldMatrix(transform);
    _collecting = state;
    _nodeId = node.id;
    for (let slot = 0; slot < node.traits.length; slot++) {
        const instance = node.traits[slot];
        const trait = registry.slotToTrait[slot];
        if (!instance || !trait) continue;
        _traitId = trait.def.id;
        for (const reg of trait.def.controls) {
            _controlId = reg.controlId;
            walkObjects(reg.schema, reg.get(instance), world, (site) => {
                const { schema, local, path } = site;
                if (schema.frame) {
                    const origin = take('frame', path, '', 0, 1, site.matrix, 0, 0, 0);
                    origin.framePosition = schema.frame.position;
                    origin.frameQuaternion = schema.frame.quaternion;
                }
                if (schema.shape) {
                    if (schema.shape.kind !== 'segment' && schema.shape.center) {
                        const origin = take('frame', path, '', 0, 1, site.shapeMatrix, 0, 0, 0);
                        origin.framePosition = schema.shape.center;
                    }
                    shapeHandles(schema.shape, local, site.shapeMatrix, path);
                }
                return false;
            });
        }
    }
    _collecting = null;
}

function take(
    kind: Handle['kind'],
    path: PropPath,
    field: string,
    axis: 0 | 1 | 2,
    sign: -1 | 1,
    matrix: Mat4,
    lx: number,
    ly: number,
    lz: number,
): Handle {
    const state = _collecting!;
    const handle = state.pool.pop() ?? {
        kind,
        nodeId: 0,
        traitId: '',
        controlId: '',
        path: [],
        field: '',
        axis: 0,
        sign: 1,
        matrix: mat4.create(),
        world: [0, 0, 0],
        framePosition: undefined,
        frameQuaternion: undefined,
    };
    handle.kind = kind;
    handle.nodeId = _nodeId;
    handle.traitId = _traitId;
    handle.controlId = _controlId;
    handle.path = path;
    handle.field = field;
    handle.axis = axis;
    handle.sign = sign;
    mat4.copy(handle.matrix, matrix);
    vec3.transformMat4(handle.world, vec3.set(handle.world, lx, ly, lz), matrix);
    handle.framePosition = undefined;
    handle.frameQuaternion = undefined;
    state.handles.push(handle);
    return handle;
}

function shapeHandles(spec: ShapeSpecData, local: Record<string, unknown>, matrix: Mat4, path: PropPath): void {
    if (spec.kind === 'box3') {
        const half = local[spec.halfExtents] as Vec3 | undefined;
        if (!half) return;
        take('box-face', path, spec.halfExtents, 0, 1, matrix, half[0], 0, 0);
        take('box-face', path, spec.halfExtents, 0, -1, matrix, -half[0], 0, 0);
        take('box-face', path, spec.halfExtents, 1, 1, matrix, 0, half[1], 0);
        take('box-face', path, spec.halfExtents, 1, -1, matrix, 0, -half[1], 0);
        take('box-face', path, spec.halfExtents, 2, 1, matrix, 0, 0, half[2]);
        take('box-face', path, spec.halfExtents, 2, -1, matrix, 0, 0, -half[2]);
    } else if (spec.kind === 'sphere') {
        const radius = local[spec.radius] as number | undefined;
        if (radius === undefined) return;
        // the drag measures from the centre (the matrix origin); the dot sits on the silhouette ring, where the edge is on screen.
        const handle = take('radius', path, spec.radius, 0, 1, matrix, 0, 0, 0);
        vec3.set(_centerWorld, matrix[12]!, matrix[13]!, matrix[14]!);
        const ringRadius = silhouette(_centerWorld, radius, _collectEye, _ringCenter, _ringU, _ringV);
        if (ringRadius > 0) vec3.scaleAndAdd(handle.world, _ringCenter, _ringU, ringRadius);
        else vec3.scaleAndAdd(handle.world, _centerWorld, [1, 0, 0], radius);
    } else if (spec.kind === 'segment') {
        const from = local[spec.from] as Vec3 | undefined;
        const to = local[spec.to] as Vec3 | undefined;
        if (from) take('segment-end', path, spec.from, 0, 1, matrix, from[0], from[1], from[2]);
        if (to) take('segment-end', path, spec.to, 0, 1, matrix, to[0], to[1], to[2]);
    }
}

const _centerWorld: Vec3 = [0, 0, 0];

const _ringCenter: Vec3 = [0, 0, 0];

const _ringU: Vec3 = [0, 0, 0];

const _ringV: Vec3 = [0, 0, 0];
