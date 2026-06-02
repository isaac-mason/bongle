// ── adaptive sync rate ───────────────────────────────────────────────
//
// all server→client send rate logic lives here. discovery.ts calls in
// to gate which syncs get sent each tick. no abstractions — just the
// logic needed.
//
// diff detection still runs every tick for all nodes (cheap byte compare).
// rate gating only applies to the send path (serialization + network I/O).

import { vec3 } from 'mathcat';
import { RigidBodyTrait } from '../../../builtins/rigid-body';
import { getTrait, type Node } from '../nodes';
import type { SyncRateConfig } from '../traits';

/**
 * resolve a SyncRateConfig to an Hz cap (or null = no throttle) for a node.
 * - undefined or 'realtime' → null (no throttle)
 * - 'dirty'    → null (no throttle on send path; cold-path byte-diff is
 *                skipped separately in the diff loop, so emission only
 *                happens when SyncHandle.dirty() is called)
 * - 'movement' → adaptive rate based on rigid body velocity
 * - number → explicit Hz cap
 */
export function resolveRate(rateConfig: SyncRateConfig | undefined, node: Node): number | null {
    if (rateConfig === undefined || rateConfig === 'realtime' || rateConfig === 'dirty') return null;
    if (typeof rateConfig === 'number') return rateConfig;
    if (rateConfig === 'movement') return getMovementRate(node);
    return null;
}

/**
 * adaptive velocity-based rate for 'movement' syncs.
 * returns Hz based on rigid body speed, or null if no rigid body.
 */
function getMovementRate(node: Node): number | null {
    const rb = getTrait(node, RigidBodyTrait);
    if (!rb) return null;
    if (rb.body?.sleeping) return 0;

    const speed = vec3.length(rb.linearVelocity);
    const angSpeed = vec3.length(rb.angularVelocity);

    if (speed < 0.05 && angSpeed < 0.05) return 2;
    if (speed < 0.5) return 5;
    if (speed < 2.0) return 10;
    if (speed < 10.0) return 20;
    return 30;
}

/**
 * returns true if an update should be sent this tick given the rate and timing.
 */
export function shouldSendThisTick(rate: number, lastSentTick: number, currentTick: number, tickRate: number): boolean {
    if (rate <= 0) return false;
    const ticksPerSend = tickRate / rate;
    return currentTick - lastSentTick >= ticksPerSend;
}
