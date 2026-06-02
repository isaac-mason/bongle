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
    /** seconds since this room's clock started (i.e. since `init()`). */
    time: number;
};

export function init(): Clock {
    return { time: 0 };
}

/** advance the clock by the elapsed tick delta (seconds). */
export function tick(clock: Clock, delta: number): void {
    clock.time += delta;
}
