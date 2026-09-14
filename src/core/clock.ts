export type Clock = {
    /** seconds since this room's clock started locally, advanced at the fixed
     *  tick cadence. Private per-side timeline; use for tick-aligned logic
     *  (cooldowns, scheduled events). */
    time: number;
    /** the server room clock (seconds), shared across sides via the join
     *  seed. Equals `time` on the server; on a client it sits a touch behind
     *  by one-way latency. Use this (not `time`) for anything compared across the wire. */
    serverSmoothed: number;
    /** raw authoritative server time (seconds) the most recent `server_clock`
     *  push carried, unfiltered (not the skewed `server` render clock), so it
     *  timestamps remote-transform keyframes without smuggling arrival jitter
     *  in. 0 until the first push; stays 0 on the server / local rooms. */
    serverLatest: number;
    /** smooth render time (seconds): advances every render frame by the real,
     *  unclamped frame delta, so it tracks true elapsed across hitches. Local
     *  to each side, not comparable across the wire. Equals `time` on the server. */
    wall: number;
    /** client-side continuous-sync state for `server` (see ClockSync). Unused
     *  on the server and on local rooms, where `server` just dead-reckons via `tick`. */
    sync: ClockSync;
};

/**
 * Client-side machinery that keeps `server` locked to the server's
 * authoritative clock for the whole session, instead of dead-reckoning from a
 * single join seed (which drifts unbounded). ioquake3-style offset
 * integrator: `server = localMonotonic + offset`, converged from periodic
 * server-clock samples. `offset` holds `server` one-way latency behind true
 * server-now (render-behind), using the least-delayed sample in a recent
 * window plus a fixed `SERVER_CLOCK_INTERP_DELAY` jitter buffer on top.
 * Convergence is a rate-limited proportional pull toward the target offset,
 * snapping only past `SYNC_SNAP_THRESHOLD` where slewing would lag reality.
 */
export type ClockSync = {
    /** local-monotonic to server-clock offset we're converging on (least-delayed sample). */
    targetOffset: number;
    /** offset currently folded into `server`; pulled toward `targetOffset`. */
    appliedOffset: number;
    /** recent samples; the least-delayed (max-offset) live one wins. */
    samples: ClockSample[];
    /** false until the first sample lands, `server` rides the join seed until then. */
    synced: boolean;
    /** local-monotonic time of the last sample folded into the estimator. gates
     *  the feed to ~`SYNC_OBSERVE_MIN_INTERVAL`: `server_clock` is per server tick
     *  so `serverLatest` stays fresh for keyframes, but the least-delayed window
     *  (12s TTL, 16-sample cap) needs samples spread across time, not 16 crammed
     *  into ~0.27s. decimating the feed reproduces the pre-per-tick ~10Hz cadence. */
    lastObserved: number;
};

/** one push observation: `offset` is render-behind (`serverClock - recvTime`);
 *  `recvTime` (local-monotonic) both defines the offset and ages it out of the window. */
type ClockSample = { offset: number; recvTime: number };

/** hard cap on retained samples (a few seconds at the push cadence). */
const SYNC_SAMPLES_MAX = 16;
/** drop samples older than this (seconds) so a sustained latency rise is tracked
 *  instead of a stale least-delayed sample pinning the offset too-little-behind. */
const SYNC_SAMPLE_TTL = 12;
/** residual beyond this (seconds) snaps instead of slewing; slewing a
 *  multi-second gap (refocused tab) would lag reality. */
const SYNC_SNAP_THRESHOLD = 0.5;
/** min local-monotonic gap between estimator samples (seconds). `server_clock`
 *  arrives per-tick to keep `serverLatest` fresh for keyframe stamping, but the
 *  least-delayed offset filter is fed at ~10Hz so its TTL window holds samples
 *  spread over time rather than a fraction of a second. */
const SYNC_OBSERVE_MIN_INTERVAL = 0.1;
/** proportional pull strength (per second): a small error decays with ~1s time
 *  constant, invisibly slow at the sub-10ms drift seen in steady state. */
const SYNC_CORRECTION_STIFFNESS = 1.0;
/** cap on the offset's rate of change (fraction of real time), bounds how
 *  fast the clock can run hot/cold while closing a sub-snap gap. */
const SYNC_MAX_SLEW_RATE = 0.1;
/** fixed render-behind jitter buffer on top of the latency lag. Transport is
 *  reliable+ordered (no loss), so this covers connection jitter only: ~50ms
 *  absorbs a typical head-of-line stall, keeping server-stamped events from
 *  rendering early. */
export const SERVER_CLOCK_INTERP_DELAY = 0.05;

/** the client sim loop's rate. Fixed, and deliberately not the server's: owner-authority
 *  motion (the local character above all) is stepped only on its owner's client, so a
 *  game choosing a cheaper server cadence must not make its own character coarser. */
export const CLIENT_TICK_HZ = 60;

/** transform broadcast cadence (position + quaternion slices, `dirty.diff` capped).
 *  imported by `builtins/transform` for `rate.hz(...)` and by the remote chase-latest
 *  translator (render/transform/interpolation.ts) as the fallback ease interval, so the
 *  send rate and the chase timing derive from one constant. */
export const TRANSFORM_SEND_HZ = 30;

/** scratch for the per-observe percentile sort (<= SYNC_SAMPLES_MAX live samples). */
const _sortedOffsets = new Float64Array(SYNC_SAMPLES_MAX);

function newSync(): ClockSync {
    return {
        targetOffset: 0,
        appliedOffset: 0,
        samples: [],
        synced: false,
        lastObserved: 0,
    };
}

/** `seed` is the server clock to align `server` to (from the join handshake);
 *  0 for the server itself and for local rooms. `time`/`wall` start at 0. */
export function init(seed = 0): Clock {
    return { time: 0, serverSmoothed: seed, wall: 0, sync: newSync(), serverLatest: 0 };
}

/** advance the fixed-cadence clocks by the elapsed tick delta (seconds).
 *  `time` is always local-stepped. `server` dead-reckons alongside it until
 *  continuous sync takes ownership (on the server / local rooms that never
 *  happens, so the two stay locked); once synced, `syncServer` drives
 *  `server` instead, so there's a single integrator, not two that fight. */
export function tick(clock: Clock, delta: number): void {
    clock.time += delta;
    if (!clock.sync.synced) clock.serverSmoothed += delta;
}

/** advance the smooth render clock by a real frame delta, every frame on the
 *  client; on the server, call it with the tick delta so `wall` tracks `time`. */
export function advanceWall(clock: Clock, delta: number): void {
    clock.wall += delta;
}

// client-side server-clock sync. Drive from the client engine loop: fold each
// server-clock push into the room's estimate via `observeSample`, and call
// `syncServer` every frame so `server` tracks it. All no-ops on the server /
// local rooms (no pushes ever arrive).

/** fold one server-clock push into the estimate. `serverClock` is the room's
 *  `server` value the server stamped; `recvTime` is the client's
 *  local-monotonic clock when the push arrived. We retire stale samples, then
 *  take the least-delayed survivor (max offset) as the target. */
export function observeSample(clock: Clock, serverClock: number, recvTime: number): void {
    const sync = clock.sync;

    // store the raw authoritative stamp every push, so the remote chase-latest
    // translator learns each entity's send cadence. Unfiltered, distinct from
    // the skewed `server` render clock the estimator drives below.
    clock.serverLatest = serverClock;

    const offset = serverClock - recvTime;

    // decimate the offset-floor estimator feed to ~`SYNC_OBSERVE_MIN_INTERVAL`.
    // The first sample always passes; `serverLatest` above is unaffected.
    if (sync.synced && recvTime - sync.lastObserved < SYNC_OBSERVE_MIN_INTERVAL) return;
    sync.lastObserved = recvTime;

    sync.samples.push({ offset, recvTime });
    // age out the window (oldest first), then bound its size as a backstop.
    const cutoff = recvTime - SYNC_SAMPLE_TTL;
    while (sync.samples.length > 0 && sync.samples[0].recvTime < cutoff) sync.samples.shift();
    while (sync.samples.length > SYNC_SAMPLES_MAX) sync.samples.shift();

    // sort the live offsets ascending (offset falls as latency rises, so
    // ascending is most-delayed to least-delayed); the top entry becomes targetOffset.
    const n = sync.samples.length;
    for (let i = 0; i < n; i++) _sortedOffsets[i] = sync.samples[i]!.offset;
    _sortedOffsets.subarray(0, n).sort();
    sync.targetOffset = _sortedOffsets[n - 1]!;

    // first fix: adopt the offset outright, the next `syncServer` snaps `server`
    // off the dead-reckoned join seed onto the shared timeline.
    if (!sync.synced) {
        sync.synced = true;
        sync.appliedOffset = sync.targetOffset;
    }
}

/** advance `server` toward the synced estimate. Until the first sample lands
 *  this is a no-op and `server` rides the join seed; after that `server = now
 *  + appliedOffset`, pulled toward the target by a rate-limited proportional
 *  controller capped at `SYNC_MAX_SLEW_RATE`. A gap past
 *  `SYNC_SNAP_THRESHOLD` (first fix, refocused tab) snaps instead, which may jump. */
export function syncServer(clock: Clock, now: number, dt: number): void {
    const sync = clock.sync;
    if (!sync.synced) return;

    const residual = sync.targetOffset - sync.appliedOffset;
    if (Math.abs(residual) > SYNC_SNAP_THRESHOLD) {
        sync.appliedOffset = sync.targetOffset; // snap, too far to slew without lagging reality.
        clock.serverSmoothed = now + sync.appliedOffset - SERVER_CLOCK_INTERP_DELAY;
        return;
    }

    const maxStep = SYNC_MAX_SLEW_RATE * dt;
    const step = residual * SYNC_CORRECTION_STIFFNESS * dt;
    sync.appliedOffset += step > maxStep ? maxStep : step < -maxStep ? -maxStep : step;

    // monotonic floor on the slew path (ioq3's oldServerTime guard), defensive
    // against any non-monotonic `now`; the snap above is the only sanctioned jump.
    // the interp delay is a constant, so it doesn't affect monotonicity.
    const next = now + sync.appliedOffset - SERVER_CLOCK_INTERP_DELAY;
    if (next > clock.serverSmoothed) clock.serverSmoothed = next;
}
