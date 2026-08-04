/**
 * per-room interpolation pipeline for smooth rendering. two paths,
 * routed per-frame by ownership:
 *
 *   owner-driven (fixed-step): position changes at tick cadence via
 *     local scripts / physics. `snapshot()` at the top of each fixed
 *     tick captures `position` → `prev`; `interpolate()` per-frame
 *     lerps `prev` → `position` with the fixed-step alpha. classic
 *     prev→cur interpolation, godot-style.
 *
 *   remote (non-owner): chase-latest. no buffer, no render-behind
 *     clock: the translator's target is always the NEWEST received pose
 *     (`t.position` / `t.quaternion`, copied in by the sync unpacks),
 *     and `current` eases toward it over roughly the observed send
 *     interval. cannot freeze while the server moves on — the target is
 *     always live — trading exact-path fidelity and jitter absorption
 *     for robustness on bad links, where a render-behind buffer would
 *     fall off the back of a finite ring and clamp-hold on a stale
 *     pose. teleport edge snaps the translator to the new pose.
 *
 *   predicted physics (owner with prediction): separate path,
 *     world-space correction-blend against an authoritative pose with
 *     stateful frame-carry. opt-in via RigidBody.prediction.
 *
 * each written node marks its descendants' visual chain dirty so they
 * lazily recompose against the freshly-written ancestor on next read.
 *
 * participation is explicit: callers opt nodes in via `setInterpolation`
 * (mirrors godot's `set_physics_interpolated`). this also seeds prev =
 * current immediately, mirroring godot's `reset_physics_interpolation`,
 * which avoids the "interpolating from (0,0,0)" failure that occurs
 * when prev is filled on the first snapshot tick but the node's first
 * render fires before that.
 *
 * client-only: interpolation is a rendering-smoothing concern.
 */

import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { RigidBodyTrait } from '../../builtins/rigid-body';
import {
    ensureRemoteInterpolation,
    getWorldMatrix,
    hasTransformedParent,
    markInterpolatedDescendantsDirty,
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

// ── constants ───────────────────────────────────────────────────────────

/** errors smaller than this are an exact match, no blend needed. */
const CORRECTION_SNAP_THRESHOLD = 0.01;
/** errors larger than this are a desync, hard-snap immediately. */
const CORRECTION_HARD_SNAP_THRESHOLD = 2.0;
/** frames over which to blend a small correction */
const CORRECTION_BLEND_FRAMES = 6;

// ── scratch (reused to avoid allocation) ────────────────────────────────

const _interpLocalMat: Mat4 = mat4.create();
const _interpLocalPos: Vec3 = vec3.create();
const _interpLocalQuat: Quat = quat.create();
const _authWorldMat: Mat4 = mat4.create();
const _authWorldPos: Vec3 = vec3.create();
const _authWorldQuat: Quat = quat.create();
const _authWorldScale: Vec3 = vec3.create();

/* ── snapshot ── */

/**
 * snapshot current local transform values into TransformTrait's prev
 * fields. call at the top of each fixed tick so the owner-driven
 * (prev→cur) path has a stable "from" state. remote-driven transforms
 * don't read prev, so they're left out of the drain even when present
 * in `_transformDirty`, their `markWorldDirty` lights up the dirty
 * bits but doesn't enroll them in the snapshot set.
 */
export function snapshot(sceneTree: SceneTree): void {
    const dirty = sceneTree._transformDirty;
    for (const t of dirty) {
        if (!t.interpolate) continue;
        t.prevPosition[0] = t.position[0];
        t.prevPosition[1] = t.position[1];
        t.prevPosition[2] = t.position[2];
        t.prevQuaternion[0] = t.quaternion[0];
        t.prevQuaternion[1] = t.quaternion[1];
        t.prevQuaternion[2] = t.quaternion[2];
        t.prevQuaternion[3] = t.quaternion[3];
    }
    dirty.clear();
}

/* ── interpolate ── */

/**
 * produce per-frame world-space interpolated values for smooth rendering.
 *
 * iterates `_interpolating` (populated by `setInterpolation`). writes into
 * `interpolatedWorld*` fields, the rendering chain that descendants
 * compose against. each written node also marks its descendants'
 * VISUAL_MATRIX dirty so they lazily recompose against the freshly-written
 * ancestor on next read.
 *
 * `delta` is the real render-frame delta (seconds), the timestep the remote
 * chase-latest translator eases over.
 *
 * per-frame routing pivot:
 *   - predicted physics → world-space correction-blend (stateful)
 *   - owner (node.owner === this room's playerId) → fixed-step
 *     prev→cur lerp at `alpha`
 *   - remote (non-owner) → chase the latest received pose (no buffer);
 *     teleport edge snaps the translator to the current pose
 */
export function interpolate(sceneTree: SceneTree, playerId: PlayerId, alpha: number, delta: number): void {
    for (const transform of sceneTree._interpolating) {
        const node = transform._node!;

        transform._version++;
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

        if (node.children.length > 0) markInterpolatedDescendantsDirty(node);
    }
}

/**
 * owner-driven fixed-step path. snapshot() filled prev at the top of
 * the tick; lerp prev → current with the fixed-step alpha. teleport
 * edge snaps to current.
 */
function sampleFixedStepPose(t: TransformTrait, alpha: number, outPos: Vec3, outQuat: Quat): void {
    if (t.teleport !== t.lastTeleport) {
        t.lastTeleport = t.teleport;
        vec3.copy(outPos, t.position);
        quat.copy(outQuat, t.quaternion);
    } else {
        vec3.lerp(outPos, t.prevPosition, t.position, alpha);
        quat.slerp(outQuat, t.prevQuaternion, t.quaternion, alpha);
    }
}

/** send-interval fallback (seconds) before any cadence has been observed. */
const DEFAULT_INTERVAL = 1 / TRANSFORM_SEND_HZ;
/** clamp observed intervals into a sane band so a network stall (a huge gap) or a
 *  burst (a tiny gap) can't wreck the chase rate — the eased value always arrives
 *  within ~2 send intervals. */
const MIN_EASE_DURATION = DEFAULT_INTERVAL * 0.5;
const MAX_EASE_DURATION = DEFAULT_INTERVAL * 2;
/** "move a bit less than should" damping — smooths a retarget. paired with the 1.0 ratio
 *  ceiling (no extrapolation, matching the engine's never-guess-velocity contract), the
 *  eased value still fully reaches the target at ~1.25 intervals. */
const CHASE_DAMPING = 0.8;

/** EWMA the observed send interval into the ease duration, clamped so outliers (a stall
 *  or a burst) can't stall or overshoot the chase rate. */
function blendEaseDuration(previous: number, interval: number): number {
    const clamped =
        interval < MIN_EASE_DURATION ? MIN_EASE_DURATION : interval > MAX_EASE_DURATION ? MAX_EASE_DURATION : interval;
    return previous <= 0 ? clamped : previous * 0.9 + clamped * 0.1;
}

/** fraction of old→target to have covered by now: elapsed / easeDuration, damped, capped
 *  at 1 so the eased value settles exactly on the target if updates stop. */
function chaseRatio(elapsed: number, easeDuration: number): number {
    const ratio = easeDuration > 0.001 ? elapsed / easeDuration : 1;
    const damped = ratio * CHASE_DAMPING;
    return damped < 1 ? damped : 1;
}

/** snap the translator to a known pose (first frame / teleport edge): old == current
 *  == target, elapsed cleared, cadence retained. `seen` catches up to `sequence` so the
 *  pending sync that rode along with the snap doesn't re-trigger a retarget. */
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

/**
 * ease both channels of a remote translator toward their live targets by `dt`, writing
 * the eased poses into `remote.positionCurrent` / `remote.quaternionCurrent`. on a fresh
 * unpack (a bumped per-channel sequence) it restarts the ease from the current pose
 * toward the new target, learning the cadence from the stamp gap; then it advances the
 * elapsed timer and lerps/slerps `old → target` at the damped, capped ratio.
 *
 * position and quaternion chase independently (a mover with a fixed facing never re-emits
 * quaternion, and vice versa). exported for tests; the render loop uses `sampleRemotePose`,
 * which also handles the teleport/first-frame seed and the world-space publish.
 */
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

/**
 * remote chase-latest path. the sync unpacks copy the newest pose straight into
 * `t.position` / `t.quaternion` and bump a per-channel sequence; here we ease the
 * translator's `current` toward that live target over the observed send interval and
 * publish it through the shared interpolated-world write.
 *
 * a teleport edge (counter changed) snaps the translator to the current pose instead of
 * easing across the discontinuity; the first frame seeds `current` the same way.
 */
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

/**
 * predicted physics path: blend in world space toward an authoritative
 * pose. top-level uses position/quaternion directly (local === world);
 * nested composes through the parent's world matrix and decomposes the
 * result to get the auth world TRS, then rebuilds interpolatedWorldMatrix
 * post-blend (without re-multiplying parent, the blend output is already
 * world-space TRS).
 *
 * separate from the prev→cur sample-and-write path because the blend is
 * stateful (carries _correctionFrames across frames) and operates in
 * world space rather than local.
 */
function applyPredictionInterpolation(transform: TransformTrait): void {
    if (!hasTransformedParent(transform)) {
        applyPredictionBlend(transform, transform.position, transform.quaternion);
        vec3.copy(transform.interpolatedWorldScale, transform.scale);
    } else {
        const parent = transform._parent as TransformTrait;
        let parentMat: Mat4;
        if (parent._interpolated) {
            updateInterpolatedWorldTransform(parent);
            parentMat = parent.interpolatedWorldMatrix;
        } else {
            parentMat = getWorldMatrix(parent);
        }
        mat4.fromRotationTranslationScale(_interpLocalMat, transform.quaternion, transform.position, transform.scale);
        mat4.multiply(_authWorldMat, parentMat, _interpLocalMat);
        mat4.decompose(_authWorldQuat, _authWorldPos, _authWorldScale, _authWorldMat);
        applyPredictionBlend(transform, _authWorldPos, _authWorldQuat);
        vec3.copy(transform.interpolatedWorldScale, _authWorldScale);
    }
    mat4.fromRotationTranslationScale(
        transform.interpolatedWorldMatrix,
        transform.interpolatedWorldQuaternion,
        transform.interpolatedWorldPosition,
        transform.interpolatedWorldScale,
    );
    transform._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
}

/**
 * blend interpolatedWorldPosition/Quaternion toward an authoritative
 * world-space pose. detects a correction by measuring error between the
 * visual position and the auth position. small errors blend smoothly;
 * large errors snap immediately.
 */
function applyPredictionBlend(transform: TransformTrait, authPos: Vec3, authQuat: Quat): void {
    if (transform._correctionFrames > 0) {
        const blendFactor = 1.0 / transform._correctionFrames;
        vec3.lerp(
            transform.interpolatedWorldPosition,
            transform.interpolatedWorldPosition,
            transform._correctionTarget,
            blendFactor,
        );
        quat.slerp(
            transform.interpolatedWorldQuaternion,
            transform.interpolatedWorldQuaternion,
            transform._correctionTargetQuat,
            blendFactor,
        );
        transform._correctionFrames--;
    } else {
        const error = vec3.distance(transform.interpolatedWorldPosition, authPos);

        if (error < CORRECTION_SNAP_THRESHOLD) {
            vec3.copy(transform.interpolatedWorldPosition, authPos);
            quat.copy(transform.interpolatedWorldQuaternion, authQuat);
        } else if (error >= CORRECTION_HARD_SNAP_THRESHOLD) {
            vec3.copy(transform.interpolatedWorldPosition, authPos);
            quat.copy(transform.interpolatedWorldQuaternion, authQuat);
        } else {
            vec3.copy(transform._correctionTarget, authPos);
            quat.copy(transform._correctionTargetQuat, authQuat);
            transform._correctionFrames = CORRECTION_BLEND_FRAMES;

            const blendFactor = 1.0 / transform._correctionFrames;
            vec3.lerp(
                transform.interpolatedWorldPosition,
                transform.interpolatedWorldPosition,
                transform._correctionTarget,
                blendFactor,
            );
            quat.slerp(
                transform.interpolatedWorldQuaternion,
                transform.interpolatedWorldQuaternion,
                transform._correctionTargetQuat,
                blendFactor,
            );
            transform._correctionFrames--;
        }
    }
}

/**
 * write a sampled local-space pose into the transform's interpolated
 * world chain. branches on nested vs top-level: top-level local ===
 * world, nested composes with the parent's visual matrix.
 */
function writeInterpolated(transform: TransformTrait, localPos: Vec3, localQuat: Quat): void {
    if (!hasTransformedParent(transform)) {
        vec3.copy(transform.interpolatedWorldPosition, localPos);
        quat.copy(transform.interpolatedWorldQuaternion, localQuat);
        vec3.copy(transform.interpolatedWorldScale, transform.scale);
        mat4.fromRotationTranslationScale(
            transform.interpolatedWorldMatrix,
            transform.interpolatedWorldQuaternion,
            transform.interpolatedWorldPosition,
            transform.interpolatedWorldScale,
        );
        transform._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
    } else {
        const parent = transform._parent as TransformTrait;
        let parentMat: Mat4;
        if (parent._interpolated) {
            updateInterpolatedWorldTransform(parent);
            parentMat = parent.interpolatedWorldMatrix;
        } else {
            parentMat = getWorldMatrix(parent);
        }
        mat4.fromRotationTranslationScale(_interpLocalMat, localQuat, localPos, transform.scale);
        mat4.multiply(transform.interpolatedWorldMatrix, parentMat, _interpLocalMat);
        transform._dirty = (transform._dirty | TRANSFORM_DIRTY_INTERPOLATED_TRS) & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX;
    }
}
