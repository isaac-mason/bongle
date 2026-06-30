// editor/camera.ts, camera math helpers and focus-node utility.

import { box3, mat4, type Quat, quat, type Vec3 } from 'mathcat';
import { getVisualWorldMatrix, getVisualWorldPosition, setWorldPosition, setWorldQuaternion } from '../api/transforms';
import { CameraRefTrait } from '../builtins/camera';
import { MeshTrait } from '../builtins/mesh';
import { TransformTrait } from '../builtins/transform';
import type { Input } from '../client/input';
import { isKeyJustDown } from '../client/input';
import type { ClientRoom } from '../client/rooms';
import type { Resources } from '../core/resources';
import { getNodeById, getTrait } from '../core/scene/nodes';
import type { EditRoomStoreApi } from './edit-room-store';
import { NUDGE_KEYS } from './editor-controls';

// ── camera math ───────────────────────────────────────────────────────

export function yawFromQuat(qx: number, qy: number, qz: number, qw: number): number {
    return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz));
}

/** extract pitch (X-rotation) from a YXZ-order camera quaternion. radians;
 *  positive = looking up. clamped to ±π/2. matches the yaw/pitch composition
 *  used by fly-controller and character. */
export function pitchFromQuat(qx: number, qy: number, qz: number, qw: number): number {
    const s = 2 * (qw * qx - qy * qz);
    return Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
}

/** snap a yaw angle to the nearest cardinal axis. returns [forwardX, forwardZ]. */
export function snapCardinal(yaw: number): [number, number] {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    if (Math.abs(fx) >= Math.abs(fz)) {
        return fx >= 0 ? [1, 0] : [-1, 0];
    }
    return fz >= 0 ? [0, 1] : [0, -1];
}

/**
 * camera-relative nudge delta from arrow keys + [ / ].
 * returns [dx, dy, dz] or null if no nudge key was pressed this frame.
 */
export function readNudgeDelta(input: Input, cameraQuat: Quat): [number, number, number] | null {
    const mk = input.mouseKeyboard;
    const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
    const [fwdX, fwdZ] = snapCardinal(yaw);
    const rgtX = fwdZ,
        rgtZ = -fwdX;

    let dx = 0,
        dy = 0,
        dz = 0;
    if (isKeyJustDown(mk, NUDGE_KEYS.forward)) {
        dx -= fwdX;
        dz -= fwdZ;
    }
    if (isKeyJustDown(mk, NUDGE_KEYS.backward)) {
        dx += fwdX;
        dz += fwdZ;
    }
    if (isKeyJustDown(mk, NUDGE_KEYS.right)) {
        dx += rgtX;
        dz += rgtZ;
    }
    if (isKeyJustDown(mk, NUDGE_KEYS.left)) {
        dx -= rgtX;
        dz -= rgtZ;
    }
    if (isKeyJustDown(mk, NUDGE_KEYS.up)) dy += 1;
    if (isKeyJustDown(mk, NUDGE_KEYS.down)) dy -= 1;

    return dx !== 0 || dy !== 0 || dz !== 0 ? [dx, dy, dz] : null;
}

// ── focus node ────────────────────────────────────────────────────────

// scratch for mesh aabb transform
const _meshLocalAabb = box3.create();
const _meshWorldAabb = box3.create();
const _focusEye: Vec3 = [0, 0, 0];
const _focusTarget: Vec3 = [0, 0, 0];
const _focusUp: Vec3 = [0, 1, 0];
const _focusMat = mat4.create();
const _focusQuat: Quat = [0, 0, 0, 1];

/**
 * teleport the camera to face the given scene node from a short distance,
 * then switch to fly controls.
 *
 * if the node has a MeshTrait, target the world-space center of the mesh's
 * bind-pose AABB (transformed by the node's world matrix). otherwise, target
 * the node's interpolated position.
 *
 * resolves the active camera-node TransformTrait via the POV node's
 * CameraRefTrait and writes pose directly there (renderer composes the
 * render camera from this transform each frame).
 *
 * TODO(W3.x): walk descendant MeshTraits and union their AABBs for a tight
 * focus on multi-mesh model trees (matches the old ModelTrait behaviour).
 */
export function focusNode(api: EditRoomStoreApi, room: ClientRoom, resources: Resources, nodeId: number): void {
    const node = getNodeById(room.nodes, nodeId);
    if (!node) return;

    const transform = getTrait(node, TransformTrait);
    if (!transform) return;

    const povNode = room.pov.node;
    if (!povNode) return;
    const cameraTrait = getTrait(povNode, CameraRefTrait)?.camera;
    const cameraNode = cameraTrait?._node;
    const cameraTransform = cameraNode ? getTrait(cameraNode, TransformTrait) : null;
    if (!cameraTransform) return;

    let tx: number;
    let ty: number;
    let tz: number;

    const mesh = getTrait(node, MeshTrait);
    const meshId = mesh?.meshId;
    const handle = meshId ? resources.models.get(meshId.modelId)?.handle : null;
    const meshEntry = handle && meshId ? handle.meshes[meshId.meshName] : undefined;
    if (meshEntry) {
        box3.copy(_meshLocalAabb, meshEntry.aabb);
        box3.transformMat4(_meshWorldAabb, _meshLocalAabb, getVisualWorldMatrix(transform));
        tx = (_meshWorldAabb[0] + _meshWorldAabb[3]) * 0.5;
        ty = (_meshWorldAabb[1] + _meshWorldAabb[4]) * 0.5;
        tz = (_meshWorldAabb[2] + _meshWorldAabb[5]) * 0.5;
    } else {
        const p = getVisualWorldPosition(transform);
        tx = p[0];
        ty = p[1];
        tz = p[2];
    }

    // place camera dist units back along +z, slightly above the target
    const dist = 7;
    _focusEye[0] = tx;
    _focusEye[1] = ty + dist * 0.25;
    _focusEye[2] = tz + dist;
    _focusTarget[0] = tx;
    _focusTarget[1] = ty;
    _focusTarget[2] = tz;

    mat4.targetTo(_focusMat, _focusEye, _focusTarget, _focusUp);
    quat.fromMat4(_focusQuat, _focusMat);

    setWorldPosition(cameraTransform, _focusEye);
    setWorldQuaternion(cameraTransform, _focusQuat);

    api.getState().setControlMode('fly');
}
