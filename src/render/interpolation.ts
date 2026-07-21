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
 *   remote (non-owner): pose syncs land into a timestamped ring
 *     (`_netSnapshots`, filled by the transform sync unpacks). every
 *     frame `interpolate()` samples the ring at the render-behind
 *     server clock (`clock.server`), bracketing the two keyframes
 *     around render time. constant visual lag regardless of speed,
 *     jitter absorbed by the buffer, motion follows the true sent
 *     path. teleport edge (counter changed) collapses the ring to the
 *     current pose so a discontinuity doesn't smear visually.
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
import { RigidBodyTrait } from '../builtins/rigid-body';
import {
    getWorldMatrix,
    hasTransformedParent,
    markInterpolatedDescendantsDirty,
    resetNetSnapshots,
    samplePositionSnapshot,
    sampleRotationSnapshot,
    TRANSFORM_DIRTY_INTERPOLATED_MATRIX,
    TRANSFORM_DIRTY_INTERPOLATED_TRS,
    type TransformTrait,
    updateInterpolatedWorldTransform,
} from '../builtins/transform';
import type { PlayerId } from '../core/client';
import { getTrait, type SceneTree } from '../core/scene/scene-tree';

export { resetInterpolation, setInterpolation } from '../builtins/transform';

// ── constants ───────────────────────────────────────────────────────────

/** errors smaller than this are an exact match, no blend needed. */
const CORRECTION_SNAP_THRESHOLD = 0.01;
/** errors larger than this are a desync, hard-snap immediately. */
const CORRECTION_HARD_SNAP_THRESHOLD = 2.0;
/** frames over which to blend a small correction */
const CORRECTION_BLEND_FRAMES = 6;

// ── TEMP interpolation debug (remove once diagnosed) ─────────────────────
const DEBUG_INTERPOLATION = true;
/** throttle the per-room debug dump to at most one line-block per interval. */
const DEBUG_LOG_INTERVAL_MS = 1000;
const _debugLastLog = new Map<number, number>();

/** true at most once per DEBUG_LOG_INTERVAL_MS per playerId (room). */
function shouldDebugLog(playerId: number): boolean {
    const now = performance.now();
    const last = _debugLastLog.get(playerId) ?? 0;
    if (now - last < DEBUG_LOG_INTERVAL_MS) return false;
    _debugLastLog.set(playerId, now);
    return true;
}

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
 * `renderTime` is the room's render-behind server clock (`clock.server`), the
 * timeline remote snapshots are sampled on.
 *
 * per-frame routing pivot:
 *   - predicted physics → world-space correction-blend (stateful)
 *   - owner (node.owner === this room's playerId) → fixed-step
 *     prev→cur lerp at `alpha`
 *   - remote (non-owner) → sample the snapshot ring at `renderTime`;
 *     teleport edge collapses the ring to the current pose
 */
export function interpolate(sceneTree: SceneTree, playerId: PlayerId, alpha: number, renderTime: number): void {
    // ── TEMP interpolation debug ──
    const debug = DEBUG_INTERPOLATION && sceneTree._interpolating.size > 0 && shouldDebugLog(playerId);
    const debugLines: string[] = [];

    for (const transform of sceneTree._interpolating) {
        const node = transform._node!;

        transform._version++;
        transform._interpolated = 1;

        const rigidBody = getTrait(node, RigidBodyTrait);

        let branch = '';
        if (rigidBody?.prediction) {
            applyPredictionInterpolation(transform);
            branch = 'predict';
        } else if (node.owner === playerId) {
            sampleFixedStepPose(transform, alpha, _interpLocalPos, _interpLocalQuat);
            writeInterpolated(transform, _interpLocalPos, _interpLocalQuat);
            branch = 'owner-fixedstep';
        } else {
            sampleSnapshotPose(transform, renderTime);
            branch = 'remote-snapshot';
        }

        if (debug) {
            const moved = vec3.distance(transform.prevPosition, transform.position);
            let ringInfo = `posRing=${transform._netSnapshots?.posCount ?? '-'} rotRing=${transform._netSnapshots?.rotCount ?? '-'}`;
            const snaps = transform._netSnapshots;
            if (branch === 'remote-snapshot' && snaps && snaps.posCount > 0) {
                const cap = snaps.posTime.length;
                const newest = snaps.posTime[snaps.posHead]!;
                const oldest = snaps.posTime[(snaps.posHead - snaps.posCount + 1 + cap) % cap]!;
                // behind<0 = renderTime is inside the ring (good, will interpolate).
                // behind>=0 = renderTime is at/past the newest keyframe → clamps → steps.
                ringInfo +=
                    ` behindNewest=${(renderTime - newest).toFixed(4)}` +
                    ` ringSpan=${(newest - oldest).toFixed(4)}` +
                    ` rt=${renderTime.toFixed(4)}`;
            }
            debugLines.push(
                `  ${node.name ?? '<unnamed>'} ${branch} owner=${node.owner} prev→cur=${moved.toFixed(4)} ${ringInfo}`,
            );
        }

        if (node.children.length > 0) markInterpolatedDescendantsDirty(node);
    }

    if (debug) {
        // biome-ignore lint/suspicious/noConsole: temporary interpolation debug
        console.log(
            `[interp] pid=${playerId} alpha=${alpha.toFixed(3)} enrolled=${sceneTree._interpolating.size}\n${debugLines.join('\n')}`,
        );
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

/**
 * remote snapshot-interpolation path. pose syncs landed into a timestamped ring
 * (`_netSnapshots`, filled by the position/rotation sync unpacks). sample the ring
 * at `renderTime` (the render-behind server clock) to get a smooth local pose, then
 * publish it through the shared interpolated-world write — which handles both
 * top-level (local === world) and nested (compose with the parent's interpolated
 * matrix) exactly as the owner path does.
 *
 * a teleport edge (counter changed since last frame) collapses the ring to the
 * current pose so we hold on it instead of smearing across the discontinuity. an
 * empty ring (enrolled but no pose landed yet) holds at the current local pose.
 */
function sampleSnapshotPose(t: TransformTrait, renderTime: number): void {
    const snaps = t._netSnapshots;

    if (t.teleport !== t.lastTeleport) {
        t.lastTeleport = t.teleport;
        if (snaps) resetNetSnapshots(t, t.position, t.quaternion, renderTime);
        writeInterpolated(t, t.position, t.quaternion);
        return;
    }
    if (!snaps) {
        writeInterpolated(t, t.position, t.quaternion);
        return;
    }
    // sample each ring independently; a slice with no keyframes yet holds the
    // current local value (position and rotation are independent syncs, so an
    // entity that only rotates in place never fills the position ring, and vice
    // versa).
    if (snaps.posCount > 0) samplePositionSnapshot(snaps, renderTime, _interpLocalPos);
    else vec3.copy(_interpLocalPos, t.position);
    if (snaps.rotCount > 0) sampleRotationSnapshot(snaps, renderTime, _interpLocalQuat);
    else quat.copy(_interpLocalQuat, t.quaternion);
    writeInterpolated(t, _interpLocalPos, _interpLocalQuat);
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
