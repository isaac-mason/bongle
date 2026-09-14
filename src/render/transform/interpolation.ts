// per-room interpolation pipeline: owner nodes lerp prev->current, remote nodes chase-latest, predicted nodes correction-blend. client-only.

import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import { RigidBodyTrait } from '../../builtins/rigid-body';
import {
    ensureInterpolatedPose,
    ensureRemoteInterpolation,
    getWorldMatrix,
    sweepInterpolatedDescendants,
    parentTransform,
    type RemoteInterpolation,
    TRANSFORM_DIRTY_INTERPOLATED_MATRIX,
    TRANSFORM_DIRTY_INTERPOLATED_TRS,
    type TransformTrait,
    updateInterpolatedWorldTransform,
} from '../../builtins/transform';
import type { PlayerId } from '../../core/client';
import { TRANSFORM_SEND_HZ } from '../../core/clock';
import { getTrait, type SceneTree } from '../../core/scene/scene-tree';

export { resetInterpolation, setInterpolation } from '../../builtins/transform';

/** errors smaller than this are an exact match, no blend needed. */
const CORRECTION_SNAP_THRESHOLD = 0.01;
/** errors larger than this are a desync, hard-snap immediately. */
const CORRECTION_HARD_SNAP_THRESHOLD = 2.0;
/** frames over which to blend a small correction */
const CORRECTION_BLEND_FRAMES = 6;

const _interpLocalMat: Mat4 = mat4.create();
const _interpLocalPos: Vec3 = vec3.create();
const _interpLocalQuat: Quat = quat.create();
const _authWorldMat: Mat4 = mat4.create();
const _authWorldPos: Vec3 = vec3.create();
const _authWorldQuat: Quat = quat.create();
const _authWorldScale: Vec3 = vec3.create();

/** call at the top of each fixed tick so the owner-driven prev->cur path has a stable "from" state. */
export function snapshot(sceneTree: SceneTree): void {
    for (const t of sceneTree.interpolating) {
        if (!t._movedSinceSnapshot) continue;
        t._movedSinceSnapshot = 0;
        const prevPosition = t.prevPosition!;
        const prevQuaternion = t.prevQuaternion!;
        prevPosition[0] = t.position[0];
        prevPosition[1] = t.position[1];
        prevPosition[2] = t.position[2];
        prevQuaternion[0] = t.quaternion[0];
        prevQuaternion[1] = t.quaternion[1];
        prevQuaternion[2] = t.quaternion[2];
        prevQuaternion[3] = t.quaternion[3];
    }
}

/** writes per-frame world-space interpolated values into `interpolatedWorld*` for roots; `concatenate()` walks subtrees after. */
export function interpolate(sceneTree: SceneTree, playerId: PlayerId, alpha: number, delta: number): void {
    for (const transform of sceneTree.interpolating) {
        const node = transform._node!;

        transform._version++;
        ensureInterpolatedPose(transform);
        transform._interpolated = 1;

        const rigidBody = getTrait(node, RigidBodyTrait);

        if (rigidBody?.prediction) {
            applyPredictionInterpolation(transform);
        } else if (node.owner === playerId) {
            sampleFixedStepPose(transform, alpha, _interpLocalPos, _interpLocalQuat);
            writeInterpolated(transform, _interpLocalPos, _interpLocalQuat);
        } else {
            sampleRemotePose(transform, delta);
        }
    }
}

/** composes every descendant's visual matrix against the root pose `interpolate()` wrote; run after the last writer of the frame. */
export function concatenate(sceneTree: SceneTree): void {
    for (const transform of sceneTree.interpolating) {
        if (transform._children.length > 0) sweepInterpolatedDescendants(transform);
    }
}

/** owner-driven fixed-step path: lerp prev -> current with the fixed-step alpha; a teleport edge snaps to current. */
function sampleFixedStepPose(t: TransformTrait, alpha: number, outPos: Vec3, outQuat: Quat): void {
    if (t.teleport !== t.lastTeleport) {
        t.lastTeleport = t.teleport;
        vec3.copy(outPos, t.position);
        quat.copy(outQuat, t.quaternion);
    } else {
        vec3.lerp(outPos, t.prevPosition!, t.position, alpha);
        quat.slerp(outQuat, t.prevQuaternion!, t.quaternion, alpha);
    }
}

/** send-interval fallback (seconds) before any cadence has been observed. */
const DEFAULT_INTERVAL = 1 / TRANSFORM_SEND_HZ;
// clamps observed intervals into a sane band so a network stall or burst can't wreck the chase rate.
const MIN_EASE_DURATION = DEFAULT_INTERVAL * 0.5;
const MAX_EASE_DURATION = DEFAULT_INTERVAL * 2;
/** damping factor that smooths a retarget; no extrapolation past a ratio of 1.0. */
const CHASE_DAMPING = 0.8;

/** EWMA the observed send interval into the ease duration, clamped so outliers can't stall or overshoot the chase rate. */
function blendEaseDuration(previous: number, interval: number): number {
    const clamped =
        interval < MIN_EASE_DURATION ? MIN_EASE_DURATION : interval > MAX_EASE_DURATION ? MAX_EASE_DURATION : interval;
    return previous <= 0 ? clamped : previous * 0.9 + clamped * 0.1;
}

/** fraction of old to target covered by now, damped and capped at 1 so the eased value settles exactly if updates stop. */
function chaseRatio(elapsed: number, easeDuration: number): number {
    const ratio = easeDuration > 0.001 ? elapsed / easeDuration : 1;
    const damped = ratio * CHASE_DAMPING;
    return damped < 1 ? damped : 1;
}

/** snap the translator to a known pose (first frame / teleport edge), retaining cadence and suppressing a re-triggered retarget. */
export function resetRemoteInterpolation(remote: RemoteInterpolation, position: Vec3, quaternion: Quat): void {
    vec3.copy(remote.positionOld, position);
    vec3.copy(remote.positionCurrent, position);
    quat.copy(remote.quaternionOld, quaternion);
    quat.copy(remote.quaternionCurrent, quaternion);
    remote.positionElapsed = 0;
    remote.quaternionElapsed = 0;
    remote.positionSeen = remote.positionSequence;
    remote.quaternionSeen = remote.quaternionSequence;
    remote.positionStamp = remote.positionPendingStamp;
    remote.quaternionStamp = remote.quaternionPendingStamp;
    remote.initialized = 1;
}

/** eases both channels of a remote translator toward their live targets by `dt`, independently; exported for tests. */
export function advanceRemoteInterpolation(
    remote: RemoteInterpolation,
    positionTarget: Vec3,
    quaternionTarget: Quat,
    dt: number,
): void {
    if (remote.positionSequence !== remote.positionSeen) {
        const interval = remote.positionStamp > 0 ? remote.positionPendingStamp - remote.positionStamp : DEFAULT_INTERVAL;
        remote.positionStamp = remote.positionPendingStamp;
        remote.positionSeen = remote.positionSequence;
        remote.positionEaseDuration = blendEaseDuration(remote.positionEaseDuration, interval);
        vec3.copy(remote.positionOld, remote.positionCurrent);
        remote.positionElapsed = 0;
    }
    remote.positionElapsed += dt;
    vec3.lerp(
        remote.positionCurrent,
        remote.positionOld,
        positionTarget,
        chaseRatio(remote.positionElapsed, remote.positionEaseDuration),
    );

    if (remote.quaternionSequence !== remote.quaternionSeen) {
        const interval = remote.quaternionStamp > 0 ? remote.quaternionPendingStamp - remote.quaternionStamp : DEFAULT_INTERVAL;
        remote.quaternionStamp = remote.quaternionPendingStamp;
        remote.quaternionSeen = remote.quaternionSequence;
        remote.quaternionEaseDuration = blendEaseDuration(remote.quaternionEaseDuration, interval);
        quat.copy(remote.quaternionOld, remote.quaternionCurrent);
        remote.quaternionElapsed = 0;
    }
    remote.quaternionElapsed += dt;
    quat.slerp(
        remote.quaternionCurrent,
        remote.quaternionOld,
        quaternionTarget,
        chaseRatio(remote.quaternionElapsed, remote.quaternionEaseDuration),
    );
}

/** remote chase-latest path; a teleport edge snaps the translator to the current pose instead of easing across it. */
function sampleRemotePose(t: TransformTrait, dt: number): void {
    const remote = ensureRemoteInterpolation(t);

    if (t.teleport !== t.lastTeleport) {
        t.lastTeleport = t.teleport;
        resetRemoteInterpolation(remote, t.position, t.quaternion);
        writeInterpolated(t, remote.positionCurrent, remote.quaternionCurrent);
        return;
    }
    if (remote.initialized === 0) resetRemoteInterpolation(remote, t.position, t.quaternion);

    advanceRemoteInterpolation(remote, t.position, t.quaternion, dt);
    writeInterpolated(t, remote.positionCurrent, remote.quaternionCurrent);
}

/** predicted physics path: blend in world space toward an authoritative pose, stateful across frames via `_correctionFrames`. */
function applyPredictionInterpolation(transform: TransformTrait): void {
    const parentOfTransform = parentTransform(transform);
    if (parentOfTransform === null) {
        applyPredictionBlend(transform, transform.position, transform.quaternion);
        vec3.copy(transform.interpolatedWorldScale!, transform.scale);
    } else {
        const parent = parentOfTransform;
        let parentMat: Mat4;
        if (parent._interpolated) {
            updateInterpolatedWorldTransform(parent);
            parentMat = parent.interpolatedWorldMatrix!;
        } else {
            parentMat = getWorldMatrix(parent);
        }
        mat4.fromRotationTranslationScale(_interpLocalMat, transform.quaternion, transform.position, transform.scale);
        mat4.multiply(_authWorldMat, parentMat, _interpLocalMat);
        mat4.decompose(_authWorldQuat, _authWorldPos, _authWorldScale, _authWorldMat);
        applyPredictionBlend(transform, _authWorldPos, _authWorldQuat);
        vec3.copy(transform.interpolatedWorldScale!, _authWorldScale);
    }
    mat4.fromRotationTranslationScale(
        transform.interpolatedWorldMatrix!,
        transform.interpolatedWorldQuaternion!,
        transform.interpolatedWorldPosition!,
        transform.interpolatedWorldScale!,
    );
    transform._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
}

/** small errors blend smoothly toward the authoritative pose; large errors snap immediately. */
function applyPredictionBlend(transform: TransformTrait, authPos: Vec3, authQuat: Quat): void {
    if (transform._correctionFrames > 0) {
        const blendFactor = 1.0 / transform._correctionFrames;
        vec3.lerp(
            transform.interpolatedWorldPosition!,
            transform.interpolatedWorldPosition!,
            transform._correctionTarget!,
            blendFactor,
        );
        quat.slerp(
            transform.interpolatedWorldQuaternion!,
            transform.interpolatedWorldQuaternion!,
            transform._correctionTargetQuat!,
            blendFactor,
        );
        transform._correctionFrames--;
    } else {
        const error = vec3.distance(transform.interpolatedWorldPosition!, authPos);

        if (error < CORRECTION_SNAP_THRESHOLD) {
            vec3.copy(transform.interpolatedWorldPosition!, authPos);
            quat.copy(transform.interpolatedWorldQuaternion!, authQuat);
        } else if (error >= CORRECTION_HARD_SNAP_THRESHOLD) {
            vec3.copy(transform.interpolatedWorldPosition!, authPos);
            quat.copy(transform.interpolatedWorldQuaternion!, authQuat);
        } else {
            const correctionTarget = (transform._correctionTarget ??= vec3.create());
            const correctionTargetQuat = (transform._correctionTargetQuat ??= quat.create());
            vec3.copy(correctionTarget, authPos);
            quat.copy(correctionTargetQuat, authQuat);
            transform._correctionFrames = CORRECTION_BLEND_FRAMES;

            const blendFactor = 1.0 / transform._correctionFrames;
            vec3.lerp(transform.interpolatedWorldPosition!, transform.interpolatedWorldPosition!, correctionTarget, blendFactor);
            quat.slerp(
                transform.interpolatedWorldQuaternion!,
                transform.interpolatedWorldQuaternion!,
                correctionTargetQuat,
                blendFactor,
            );
            transform._correctionFrames--;
        }
    }
}

/** top-level local === world; nested composes with the parent's visual matrix. */
function writeInterpolated(transform: TransformTrait, localPos: Vec3, localQuat: Quat): void {
    const parentOfTransform = parentTransform(transform);
    if (parentOfTransform === null) {
        vec3.copy(transform.interpolatedWorldPosition!, localPos);
        quat.copy(transform.interpolatedWorldQuaternion!, localQuat);
        vec3.copy(transform.interpolatedWorldScale!, transform.scale);
        mat4.fromRotationTranslationScale(
            transform.interpolatedWorldMatrix!,
            transform.interpolatedWorldQuaternion!,
            transform.interpolatedWorldPosition!,
            transform.interpolatedWorldScale!,
        );
        transform._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
    } else {
        const parent = parentOfTransform;
        let parentMat: Mat4;
        if (parent._interpolated) {
            updateInterpolatedWorldTransform(parent);
            parentMat = parent.interpolatedWorldMatrix!;
        } else {
            parentMat = getWorldMatrix(parent);
        }
        mat4.fromRotationTranslationScale(_interpLocalMat, localQuat, localPos, transform.scale);
        mat4.multiply(transform.interpolatedWorldMatrix!, parentMat, _interpLocalMat);
        transform._dirty = (transform._dirty | TRANSFORM_DIRTY_INTERPOLATED_TRS) & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX;
    }
}
