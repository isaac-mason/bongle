// ── sync dirtiness + rate ─────────────────────────────────────────────
//
// two orthogonal per-sync policies, and the send-side helpers that read them:
//   - `dirty`: WHAT counts as a change worth sending (byte-diff, threshold, or
//     explicit-only). consumed by the diff pass (sync-diff.ts).
//   - `rate`: HOW OFTEN a dirty value may send, at most. consumed by the send
//     path (discovery.ts fanout). nothing un-dirty ever sends, regardless of rate.
//
// diff detection still runs every tick for all nodes (cheap byte compare); rate
// gating only applies to the send path (serialization + network I/O).

import type { DirtyThreshold } from '../traits';

/**
 * change metrics for `DirtyThreshold`. each receives the previously-emitted value
 * and the current one (the field's own value, not bytes), returning a magnitude
 * the diff compares against the rate's `threshold`. body-agnostic: a node moved by
 * a rigid body, an AABB body, a script, or an animation all measure the same way.
 */
export const syncMetric = {
    /** euclidean distance between two equal-length numeric vectors (position, scale). */
    distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            const d = a[i]! - b[i]!;
            sum += d * d;
        }
        return Math.sqrt(sum);
    },
    /** angle in radians between two quaternions [x, y, z, w]. */
    angle(a: ArrayLike<number>, b: ArrayLike<number>): number {
        const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
        return 2 * Math.acos(Math.min(1, Math.abs(dot)));
    },
    /** absolute difference between two scalars. */
    scalar(a: number, b: number): number {
        return Math.abs(a - b);
    },
};

/**
 * `dirty` policy constructors — what counts as a change worth sending. the metric
 * variants bake their metric so it can't be mismatched with the value, and read as
 * English at the call site: `dirty: dirty.distance(0.05)`.
 */
export const dirty = {
    /** dirty when a vector/scalar-list value moves ≥ `threshold` (euclidean). */
    distance: (threshold: number): DirtyThreshold => ({ threshold, metric: syncMetric.distance }),
    /** dirty when a quaternion [x,y,z,w] rotates ≥ `threshold` radians. */
    angle: (threshold: number): DirtyThreshold => ({ threshold, metric: syncMetric.angle }),
    /** dirty when a scalar changes by ≥ `threshold`. */
    scalar: (threshold: number): DirtyThreshold => ({ threshold, metric: syncMetric.scalar }),
    /** dirty on any byte change (the default). */
    onChange: (): 'onChange' => 'onChange',
    /** never auto-dirty; only `SyncHandle.dirty()` marks it. */
    explicit: (): 'explicit' => 'explicit',
};

/**
 * `rate` policy constructors — the maximum send cadence for a dirty value.
 */
export const rate = {
    /** send at most `hz` times/sec (a per-field time-gate, Quake's snapshotMsec). */
    hz: (hz: number): { hz: number } => ({ hz }),
    /** send every tick the value is dirty (the default, no throttle). */
    realtime: (): 'realtime' => 'realtime',
};

/**
 * returns true if a dirty value may send this tick given its `hz` cap and timing.
 */
export function shouldSendThisTick(hz: number, lastSentTick: number, currentTick: number, tickRate: number): boolean {
    if (hz <= 0) return false;
    const ticksPerSend = tickRate / hz;
    return currentTick - lastSentTick >= ticksPerSend;
}
