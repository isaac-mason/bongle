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
    /** client-side continuous-sync state for `server` (see ClockSync). unused on
     *  the server and on local rooms — there `server` just dead-reckons via `tick`. */
    sync: ClockSync;
};

/**
 * Client-side machinery that keeps `server` locked to the server's authoritative
 * clock for the whole session, instead of dead-reckoning from a single join seed
 * (which drifts without bound — every render-delta clamp, GC pause, or backgrounded
 * tab loses time that's never recovered).
 *
 * Models ioquake3's clock (code/client/cl_cgame.c `CL_AdjustTimeDelta`): the client
 * never accumulates its own server time — it derives it as a single integrator,
 * `server = localMonotonic + offset`, where `offset` is the only state tracking the
 * server (ioq3's `cl.serverTimeDelta`). The server pushes a room's `server` clock
 * (batched into the per-tick packet it already sends — see engine-server); each
 * arrival is one sample. Two properties:
 *
 *  - RENDER-BEHIND. `offset = serverClock − recvTime` holds `server` one-way latency
 *    BEHIND true server-now (the server stamped `serverClock`, we receive it one way
 *    later; ioq3 / Source's interpolation both render behind, and our `clock.server`
 *    contract says "a touch behind by one-way latency"). That lag is what makes a
 *    server-stamped event line up: a projectile's `ProjectileCast` reaches us one way
 *    later, exactly as `server` crosses its spawnTime — so it spawns at the muzzle,
 *    not already downrange, and its impact lands as the bolt reaches the target.
 *  - LEAST-DELAYED FILTERING over a recent window. A push delayed by queueing reads
 *    as a smaller offset; the least-delayed (max-offset) sample is the tightest, most
 *    accurate "behind by one-way latency". One-way latency has a hard floor, so there
 *    are no spurious too-fresh samples to guard against; stale ones expire so a rising
 *    latency floor is tracked.
 *  - INTERPOLATION DELAY (Source's `cl_interp`). On top of the latency lag we hold
 *    `server` a fixed `SERVER_CLOCK_INTERP_DELAY` further behind. The latency sync
 *    alone runs behind by the *minimum* observed latency, so a cast packet slower
 *    than that (jitter, a TCP head-of-line stall) would render its bolt downrange
 *    (pop-in). The buffer keeps `elapsed ≤ 0` at arrival for typical jitter, so the
 *    bolt spawns at the muzzle and the consumer's `max(0,…)` clamp holds it there.
 *    Applied at the read (a render concern), so sync/snap stay in latency terms.
 *
 * Convergence is a rate-limited proportional pull toward the target offset (smooth,
 * no overshoot), monotonic on the slew path, snapping only past `SYNC_SNAP_THRESHOLD`
 * (ioq3's 500ms RESET_TIME) where slewing would lag reality (first fix, refocus).
 */
export type ClockSync = {
    /** local-monotonic→server-clock offset we're converging on (least-delayed sample). */
    targetOffset: number;
    /** offset currently folded into `server`; pulled toward `targetOffset`. */
    appliedOffset: number;
    /** recent samples; the least-delayed (max-offset) live one wins. */
    samples: ClockSample[];
    /** false until the first sample lands — `server` rides the join seed until then. */
    synced: boolean;
};

/** one push observation: `offset` is render-behind (`serverClock − recvTime`);
 *  `recvTime` (local-monotonic) both defines the offset and ages it out of the window. */
type ClockSample = { offset: number; recvTime: number };

/** hard cap on retained samples (a few seconds at the push cadence). */
const SYNC_SAMPLES_MAX = 16;
/** drop samples older than this (seconds) so a sustained latency rise is tracked
 *  instead of a stale least-delayed sample pinning the offset too-little-behind. */
const SYNC_SAMPLE_TTL = 12;
/** residual beyond this (seconds) snaps instead of slewing — matches ioq3's
 *  RESET_TIME (500ms); slewing a multi-second gap (refocused tab) would lag reality. */
const SYNC_SNAP_THRESHOLD = 0.5;
/** proportional pull strength (per second): a small error decays with ~1s time
 *  constant — invisibly slow at the sub-10ms drift we see in steady state. */
const SYNC_CORRECTION_STIFFNESS = 1.0;
/** cap on the offset's rate of change (fraction of real time). Bounds how fast the
 *  clock can run hot/cold while closing a larger (sub-snap) gap, so derived motion
 *  stays smooth — 10% is the most a bolt's speed ever bends, briefly and rarely. */
const SYNC_MAX_SLEW_RATE = 0.1;
/** fixed render-behind jitter buffer on top of the latency lag — Source's `cl_interp`
 *  (which defaults to 100ms but bakes in a packet-loss cushion). Our transport is
 *  reliable+ordered (no loss), so this covers connection jitter only: ~50ms absorbs a
 *  typical head-of-line stall, keeping server-stamped events from rendering early. */
export const SERVER_CLOCK_INTERP_DELAY = 0.05;

function newSync(): ClockSync {
    return { targetOffset: 0, appliedOffset: 0, samples: [], synced: false };
}

/** `seed` is the server clock to align `server` to (from the join handshake);
 *  0 for the server itself and for local rooms. `time`/`wall` start at 0. */
export function init(seed = 0): Clock {
    return { time: 0, server: seed, wall: 0, sync: newSync() };
}

/** advance the fixed-cadence clocks by the elapsed tick delta (seconds). `time` is
 *  always local-stepped. `server` dead-reckons alongside it UNTIL continuous sync
 *  takes ownership: on the authoritative server and on local/offline rooms that
 *  never happens (no replies arrive), so the two stay locked; on a networked client
 *  `syncServer` drives `server` once the first sample lands, and we stop stepping it
 *  here so there's a single integrator (localMonotonic + offset), not two that fight. */
export function tick(clock: Clock, delta: number): void {
    clock.time += delta;
    if (!clock.sync.synced) clock.server += delta;
}

/** advance the smooth render clock by a real frame delta — every frame on the
 *  client; on the server, call it with the tick delta so `wall` tracks `time`. */
export function advanceWall(clock: Clock, delta: number): void {
    clock.wall += delta;
}

/* ── client-side server-clock sync ──────────────────────────────────────────
 *  Drive from the client engine loop: fold each server-clock push into the room's
 *  estimate via `observeSample`, and call `syncServer` every frame so `server`
 *  tracks it. All no-ops on the server / local rooms (no pushes ever arrive, so
 *  `syncServer` stays in its pre-sync early-out and `server` keeps dead-reckoning
 *  via `tick`).
 */

/** fold one server-clock push into the estimate. `serverClock` is the room's `server`
 *  value the server stamped; `recvTime` is the client's local-monotonic clock when the
 *  push arrived. The offset is render-behind — `serverClock − recvTime` tracks the
 *  server-time we observed (one-way latency old), not a forward-extrapolated true-now
 *  (see ClockSync). We retire stale samples, then take the least-delayed survivor (max
 *  offset) as the target — the tightest "behind by one-way latency". */
export function observeSample(clock: Clock, serverClock: number, recvTime: number): void {
    const sync = clock.sync;
    const offset = serverClock - recvTime;

    sync.samples.push({ offset, recvTime });
    // age out the window (oldest first), then bound its size as a backstop.
    const cutoff = recvTime - SYNC_SAMPLE_TTL;
    while (sync.samples.length > 0 && sync.samples[0].recvTime < cutoff) sync.samples.shift();
    while (sync.samples.length > SYNC_SAMPLES_MAX) sync.samples.shift();

    let best = sync.samples[0];
    for (let i = 1; i < sync.samples.length; i++) {
        if (sync.samples[i].offset > best.offset) best = sync.samples[i];
    }
    sync.targetOffset = best.offset;

    // first fix: adopt the offset outright — the next `syncServer` snaps `server`
    // off the dead-reckoned join seed onto the shared timeline.
    if (!sync.synced) {
        sync.synced = true;
        sync.appliedOffset = best.offset;
    }
}

/** advance `server` toward the synced estimate. Until the first sample lands this is
 *  a no-op and `server` rides the join seed (advanced by `tick`); after that
 *  `server = now + appliedOffset`, where `appliedOffset` is pulled toward the target
 *  by a rate-limited proportional controller: the step is proportional to the error
 *  (smooth, no overshoot — first-order) but capped at `SYNC_MAX_SLEW_RATE` so even a
 *  larger sub-snap gap closes without bending derived motion much. The slew path is
 *  monotonic (a capped offset change can't outrun the monotonic `now`); a gap past
 *  `SYNC_SNAP_THRESHOLD` (first fix, refocused tab) snaps, which may jump. */
export function syncServer(clock: Clock, now: number, dt: number): void {
    const sync = clock.sync;
    if (!sync.synced) return;

    const residual = sync.targetOffset - sync.appliedOffset;
    if (Math.abs(residual) > SYNC_SNAP_THRESHOLD) {
        sync.appliedOffset = sync.targetOffset; // snap — too far to slew without lagging reality.
        clock.server = now + sync.appliedOffset - SERVER_CLOCK_INTERP_DELAY;
        return;
    }

    const maxStep = SYNC_MAX_SLEW_RATE * dt;
    const step = residual * SYNC_CORRECTION_STIFFNESS * dt;
    sync.appliedOffset += step > maxStep ? maxStep : step < -maxStep ? -maxStep : step;

    // monotonic floor on the slew path (ioq3's oldServerTime guard) — defensive
    // against any non-monotonic `now`; the snap above is the only sanctioned jump.
    // the interp delay is a constant, so it doesn't affect monotonicity.
    const next = now + sync.appliedOffset - SERVER_CLOCK_INTERP_DELAY;
    if (next > clock.server) clock.server = next;
}
