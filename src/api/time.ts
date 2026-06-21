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
 * LOCAL to each side — starts at 0 on the server and on every client, so it
 * is NOT comparable across the wire. for a shared timeline use
 * `getServerTime` / `ctx.clock.server`.
 */
export function getTime(ctx: ScriptContext): number {
    return ctx.clock.time;
}

/**
 * the SERVER room clock in seconds, shared across sides: a joining client seeds
 * it from the server's value (sent in the join handshake), so server and clients
 * read the same timeline. on the server it equals `getTime`; on a client it sits
 * a touch behind by the one-way join latency (and may drift slowly by tick
 * jitter) — exactly the offset wanted when rendering server-stamped events.
 *
 * use this to derive a shared timeline from a networked timestamp (e.g. a
 * projectile's flight from its spawn time). good enough for that; not frame-exact.
 */
export function getServerTime(ctx: ScriptContext): number {
    return ctx.clock.server;
}

/**
 * smooth render time in seconds. unlike `getTime` (which steps at the 60Hz fixed
 * tick), this advances every render frame by the real frame delta on the client —
 * so per-frame visuals (spins, bobs, derived motion in `onFrame`) are smooth at any
 * refresh rate. on the server it just equals `getTime`.
 *
 * local to each side — for client-only visuals; not comparable across the wire.
 */
export function getWallTime(ctx: ScriptContext): number {
    return ctx.clock.wall;
}
