/**
 * per-room game clock. monotonic seconds, advanced by the engine's tick
 * loop — paused implicitly when no tick fires (tab hidden, paused engine,
 * etc.). read by scripts via `getTime(ctx)`; reaches into the room handle
 * exposed on ClientContext / ServerContext.
 *
 * a tiny module rather than a free scalar on each room: gives the concept
 * a name, keeps the advance call self-explanatory at the engine tick
 * site, and leaves room to grow (tick count, paused flag, started-at
 * wall clock) without scattering disjoint scalars across room shapes.
 */

export type Clock = {
    /** seconds since this room's clock started locally, advanced at the FIXED tick
     *  cadence (it steps, it does not advance between ticks within a frame). a
     *  private per-side timeline — starts at 0 on every side. use it for
     *  tick-aligned logic (cooldowns, scheduled events). */
    time: number;
    /** the SERVER room clock (seconds), shared across sides: a joining client
     *  seeds it from the server's value (sent in the join handshake) so both
     *  sides read the same timeline. on the server it equals `time`; on a client
     *  it sits a touch behind by the one-way join latency — the offset wanted when
     *  placing server-stamped events (e.g. a projectile's spawn time). also fixed
     *  cadence. use this (not `time`) for anything compared across the wire. */
    server: number;
    /** smooth render time (seconds): advances every RENDER FRAME by the real frame
     *  delta on the client, so per-frame visuals (spins, bobs, derived motion) are
     *  smooth at any refresh rate rather than stepping at the 60Hz tick. on the
     *  SERVER it just equals `time` (no render frames). local to each side — for
     *  client-only visuals; not comparable across the wire. */
    wall: number;
};

/** `seed` is the server clock to align `server` to (from the join handshake);
 *  0 for the server itself and for local rooms. `time`/`wall` start at 0. */
export function init(seed = 0): Clock {
    return { time: 0, server: seed, wall: 0 };
}

/** advance the fixed-cadence clocks by the elapsed tick delta (seconds). */
export function tick(clock: Clock, delta: number): void {
    clock.time += delta;
    clock.server += delta;
}

/** advance the smooth render clock by a real frame delta — every frame on the
 *  client; on the server, call it with the tick delta so `wall` tracks `time`. */
export function advanceWall(clock: Clock, delta: number): void {
    clock.wall += delta;
}
