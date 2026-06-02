import type { ScriptContext } from '../core/scene/scripts';

/**
 * monotonic per-room game time in seconds. advanced by the engine's tick
 * loop on whichever side is calling; pauses when no tick fires. use for
 * tick-aligned timing (cooldowns, scheduled events) — pairs naturally
 * with `onTick`.
 *
 * not wall-clock — does not advance between fixed ticks within a frame
 * and does not advance at all when the tab is backgrounded long enough
 * to clamp the inbound delta. for wall-clock semantics use
 * `performance.now()`.
 *
 * client and server each keep their own clock — they start near zero
 * but drift apart by network/tick jitter. do not use as a shared
 * reference between sides.
 */
export function getTime(ctx: ScriptContext): number {
    return ctx.clock.time;
}
