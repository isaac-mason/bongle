import { type BodyId, box, dof, MotionType, rigidBody } from 'crashcat';
import type { PerspectiveCamera } from 'gpucat';
import { type Quat, quat, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldPosition, getVisualWorldQuaternion, markTransformDirty, TransformTrait } from '../../builtins/transform';
import type { MouseKeyboardInput } from '../../client/input';
import type { Physics } from '../../core/physics/physics';
import { OBJECT_LAYER_NODE_MOVING } from '../../core/physics/physics';
import type { Resources } from '../../core/resources';
import type { Node, SceneTree } from '../../core/scene/scene-tree';
import { getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { setTraitProps } from '../actions';
import { SetTraitCommand } from '../commands';
import type { EditRoomStoreApi } from '../edit-room-store';
import { unionSubtreeWorldAabb } from '../node-aabb';
import type { TransformSnapshot } from './transform';

export type GrabState = {
    nodeId: number;
    bodyId: BodyId;
    grabDistance: number;
    anchorOffsetCS: Vec3;
    anchorQuatCS: Quat;
    pivotOffsetLocal: Vec3;
    snapshot: TransformSnapshot;
    rotating: boolean;
    targetQuat: Quat;
};

/** the grab tool: a kinematic body chased to the cursor; `current` is the grab in progress. */
export type GrabTool = {
    store: EditRoomStoreApi;
    current: GrabState | null;
};

export function init(store: EditRoomStoreApi): GrabTool {
    return { store, current: null };
}

/** the grabbed node's world position, for the pivot dot; null when idle. */
export function pivotPosition(state: GrabTool, sceneTree: SceneTree): Vec3 | null {
    const grab = state.current;
    if (!grab) return null;
    const node = getNodeById(sceneTree, grab.nodeId);
    const t = node ? getTrait(node, TransformTrait) : null;
    return t ? ([...getVisualWorldPosition(t)] as Vec3) : null;
}

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
    state: GrabTool,
    nodeId: number,
    sceneTree: SceneTree,
    physics: Physics,
    resources: Resources,
    camera: PerspectiveCamera,
): void {
    if (state.current) return;
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

    state.current = {
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
export function updateGrab(state: GrabTool, mk: MouseKeyboardInput): void {
    const grab = state.current;
    if (!grab) return;

    // wheel adjusts grab distance, multiplicative so it feels uniform near/far
    if (mk._wheelDeltaY !== 0) {
        const factor = 1 - mk._wheelDeltaY * GRAB_DIST_SCROLL;
        grab.grabDistance = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, grab.grabDistance * factor));
    }
}

/** fixed-step PD controller for the held body; computes the camera-relative target pose and writes linear/angular velocities. */
export function prePhysicsGrab(state: GrabTool, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.current;
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
export function postPhysicsGrab(state: GrabTool, sceneTree: SceneTree, physics: Physics): void {
    const grab = state.current;
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
export function beginRotate(state: GrabTool, physics: Physics): void {
    const grab = state.current;
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
export function applyRotateDelta(state: GrabTool, dx: number, dy: number, camera: PerspectiveCamera): void {
    const grab = state.current;
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
export function endRotate(state: GrabTool, physics: Physics, camera: PerspectiveCamera): void {
    const grab = state.current;
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
export function exitGrab(state: GrabTool, sceneTree: SceneTree, physics: Physics, ctx: ScriptContext): void {
    const grab = state.current;
    if (!grab) return;

    const body = rigidBody.get(physics.rigid.world, grab.bodyId);
    if (body) rigidBody.remove(physics.rigid.world, body);

    const node = getNodeById(sceneTree, grab.nodeId);
    if (!node) {
        state.current = null;
        return;
    }
    const transform = getTrait(node, TransformTrait);
    if (!transform) {
        state.current = null;
        return;
    }

    const final: TransformSnapshot = {
        nodeId: grab.nodeId,
        position: vec3.clone(transform.position),
        quaternion: quat.clone(transform.quaternion),
        scale: vec3.clone(transform.scale),
    };
    const start = grab.snapshot;
    state.current = null;

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

export function isInGrab(state: GrabTool): boolean {
    return state.current !== null;
}
