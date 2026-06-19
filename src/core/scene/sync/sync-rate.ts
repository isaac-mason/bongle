// ── adaptive sync rate ───────────────────────────────────────────────
//
// all server→client send rate logic lives here. discovery.ts calls in
// to gate which syncs get sent each tick. no abstractions — just the
// logic needed.
//
// diff detection still runs every tick for all nodes (cheap byte compare).
// rate gating only applies to the send path (serialization + network I/O).

import type { SyncRateConfig, ThresholdRate } from '../traits';

/**
 * resolve a SyncRateConfig to an Hz cap, or null = no send-path throttle.
 * - number → explicit Hz cap
 * - everything else → null:
 *   - 'realtime' — emit whenever the diff bumps the version
 *   - 'dirty'    — emission is flagged by SyncHandle.dirty() in the diff loop
 *   - ThresholdRate — the throttle IS the diff: the version only bumps on a
 *     significant value change (see `diffSyncSlice`)
 */
export function resolveRate(rateConfig: SyncRateConfig | undefined): number | null {
    if (typeof rateConfig === 'number') return rateConfig;
    return null;
}

/**
 * change metrics for `ThresholdRate`. each receives the previously-emitted value
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
 * `ThresholdRate` constructors for the common shapes — bake the metric so it can't
 * be mismatched with the value, and read as English at the call site:
 * `rate: syncRate.distance(0.05)`. for an exotic metric, write the raw
 * `{ threshold, metric }` form instead.
 */
export const syncRate = {
    /** emit when a vector/scalar-list value moves ≥ `threshold` (euclidean). */
    distance: (threshold: number): ThresholdRate => ({ threshold, metric: syncMetric.distance }),
    /** emit when a quaternion [x,y,z,w] rotates ≥ `threshold` radians. */
    angle: (threshold: number): ThresholdRate => ({ threshold, metric: syncMetric.angle }),
    /** emit when a scalar changes by ≥ `threshold`. */
    scalar: (threshold: number): ThresholdRate => ({ threshold, metric: syncMetric.scalar }),
};

/**
 * returns true if an update should be sent this tick given the rate and timing.
 */
export function shouldSendThisTick(rate: number, lastSentTick: number, currentTick: number, tickRate: number): boolean {
    if (rate <= 0) return false;
    const ticksPerSend = tickRate / rate;
    return currentTick - lastSentTick >= ticksPerSend;
}
