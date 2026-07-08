export type Clock = {
    /** seconds since this room's clock started locally, advanced at the FIXED tick
     *  cadence (it steps, it does not advance between ticks within a frame). a
     *  private per-side timeline, starts at 0 on every side. use it for
     *  tick-aligned logic (cooldowns, scheduled events). */
    time: number;
    /** the SERVER room clock (seconds), shared across sides: a joining client
     *  seeds it from the server's value (sent in the join handshake) so both
     *  sides read the same timeline. on the server it equals `time`; on a client
     *  it sits a touch behind by the one-way join latency, the offset wanted when
     *  placing server-stamped events (e.g. a projectile's spawn time). also fixed
     *  cadence. use this (not `time`) for anything compared across the wire. */
    serverSmoothed: number;
    /** RAW authoritative server time (seconds) the most recent `server_clock` push
     *  carried, stored unfiltered (NOT the skewed `server` render clock). refreshed
     *  every tick (server_clock is per-tick), so it timestamps remote-transform
     *  snapshot keyframes at the cadence a moving entity emits them. reading the
     *  skewed `server` here instead would smuggle arrival jitter back into keyframe
     *  timestamps, the exact thing this stamp exists to remove. 0 until the first
     *  push; on the server / local rooms it stays 0 (no pushes arrive). */
    serverLatest: number;
    /** smooth render time (seconds): advances every RENDER FRAME by the REAL frame
     *  delta, UNCLAMPED, unlike the integrator delta, so it never loses time to the
     *  stall clamp and tracks true elapsed across hitches/backgrounding. per-frame
     *  visuals (spins, bobs, derived motion) read it for smoothness at any refresh
     *  rate, and it's the client's local base for `server`-clock sync (see ClockSync).
     *  on the SERVER it just equals `time`. local to each side, not comparable across
     *  the wire. */
    wall: number;
    /** client-side continuous-sync state for `server` (see ClockSync). unused on
     *  the server and on local rooms, there `server` just dead-reckons via `tick`. */
    sync: ClockSync;
};

/**
 * Client-side machinery that keeps `server` locked to the server's authoritative
 * clock for the whole session, instead of dead-reckoning from a single join seed
 * (which drifts without bound, every render-delta clamp, GC pause, or backgrounded
 * tab loses time that's never recovered).
 *
 * Models ioquake3's clock (code/client/cl_cgame.c `CL_AdjustTimeDelta`): the client
 * never accumulates its own server time, it derives it as a single integrator,
 * `server = localMonotonic + offset`, where `offset` is the only state tracking the
 * server (ioq3's `cl.serverTimeDelta`). The server pushes a room's `server` clock
 * (batched into the per-tick packet it already sends, see engine-server); each
 * arrival is one sample. Two properties:
 *
 *  - RENDER-BEHIND. `offset = serverClock − recvTime` holds `server` one-way latency
 *    BEHIND true server-now (the server stamped `serverClock`, we receive it one way
 *    later; ioq3 / Source's interpolation both render behind, and our `clock.server`
 *    contract says "a touch behind by one-way latency"). That lag is what makes a
 *    server-stamped event line up: a projectile's `ProjectileCast` reaches us one way
 *    later, exactly as `server` crosses its spawnTime, so it spawns at the muzzle,
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
    /** false until the first sample lands, `server` rides the join seed until then. */
    synced: boolean;
    /** local-monotonic time of the last sample folded into the estimator. gates
     *  the feed to ~`SYNC_OBSERVE_MIN_INTERVAL`: `server_clock` is per-tick (~60Hz)
     *  so `lastServerStamp` stays fresh for keyframes, but the least-delayed window
     *  (12s TTL, 16-sample cap) needs samples spread across time, not 16 crammed
     *  into ~0.27s. decimating the feed reproduces the pre-per-tick ~10Hz cadence. */
    lastObserved: number;

    // ── adaptive remote-transform interp buffer (Source cl_interp_ratio style) ──
    /** measured one-way latency SPREAD (seconds): the gap between the least-delayed
     *  sample and the `JITTER_COVERAGE` percentile of the most-delayed, over the
     *  FULL-RATE jitter window (`jitterOffsets`, fed every push). `clock.server` is
     *  anchored to the least-delayed (min latency), so remote snapshots landing slower
     *  than that arrive behind render time and snap; holding render time back by this
     *  spread (plus `INTERP_BRACKET_RESERVE`) keeps `JITTER_COVERAGE` of them
     *  bracketable. a percentile (not the raw max) so a lone outlier doesn't pin the
     *  buffer wide for the whole window. */
    latencyJitter: number;
    /** full-rate ring of recent raw offsets (`serverClock − recvTime`), one per push,
     *  the `latencyJitter` spread is measured over. distinct from the decimated
     *  `samples` window (which tracks the slow latency FLOOR for `targetOffset`);
     *  jitter is a fast-moving quantity and needs every packet. `-1` head when empty. */
    jitterOffsets: Float64Array;
    jitterHead: number;
    jitterCount: number;
    /** transform-only render-behind currently applied on top of `clock.server`
     *  (seconds), slewed toward
     *  `max(0, INTERP_BRACKET_RESERVE + latencyJitter − SERVER_CLOCK_INTERP_DELAY)`.
     *  0 whenever `reserve + jitter` fits inside the fixed 50ms buffer (i.e. good
     *  connections), so those are byte-identical to a fixed buffer. projectiles are
     *  unaffected — this rides only the transform render clock. */
    interpMargin: number;
    /** monotonic transform render clock (`clock.server − interpMargin`, clamped
     *  non-decreasing). the clamp guards the one case the slew can't: a backward
     *  snap of `clock.server` (refocused tab) would otherwise rewind remote motion. */
    serverRenderTime: number;
};

/** one push observation: `offset` is render-behind (`serverClock − recvTime`);
 *  `recvTime` (local-monotonic) both defines the offset and ages it out of the window. */
type ClockSample = { offset: number; recvTime: number };

/** hard cap on retained samples (a few seconds at the push cadence). */
const SYNC_SAMPLES_MAX = 16;
/** drop samples older than this (seconds) so a sustained latency rise is tracked
 *  instead of a stale least-delayed sample pinning the offset too-little-behind. */
const SYNC_SAMPLE_TTL = 12;
/** residual beyond this (seconds) snaps instead of slewing, matches ioq3's
 *  RESET_TIME (500ms); slewing a multi-second gap (refocused tab) would lag reality. */
const SYNC_SNAP_THRESHOLD = 0.5;
/** min local-monotonic gap between estimator samples (seconds). `server_clock`
 *  arrives per-tick (~60Hz) to keep `lastServerStamp` fresh for keyframe stamping,
 *  but the least-delayed offset filter is fed at ~10Hz so its 12s TTL window holds
 *  samples spread over time rather than a fraction of a second. matches the prior
 *  every-6-ticks push cadence. */
const SYNC_OBSERVE_MIN_INTERVAL = 0.1;
/** proportional pull strength (per second): a small error decays with ~1s time
 *  constant, invisibly slow at the sub-10ms drift we see in steady state. */
const SYNC_CORRECTION_STIFFNESS = 1.0;
/** cap on the offset's rate of change (fraction of real time). Bounds how fast the
 *  clock can run hot/cold while closing a larger (sub-snap) gap, so derived motion
 *  stays smooth, 10% is the most a bolt's speed ever bends, briefly and rarely. */
const SYNC_MAX_SLEW_RATE = 0.1;
/** fixed render-behind jitter buffer on top of the latency lag, Source's `cl_interp`
 *  (which defaults to 100ms but bakes in a packet-loss cushion). Our transport is
 *  reliable+ordered (no loss), so this covers connection jitter only: ~50ms absorbs a
 *  typical head-of-line stall, keeping server-stamped events from rendering early. */
export const SERVER_CLOCK_INTERP_DELAY = 0.05;
/** fraction of packets the adaptive transform buffer keeps bracketable. the jitter
 *  spread is measured to this percentile of latency (not the raw max), so the worst
 *  ~5% snap rather than dragging the whole buffer (and the visible lag) out to a lone
 *  outlier. this is Source's `cl_interp_ratio` tolerance expressed as a percentile. */
const JITTER_COVERAGE = 0.95;
/** bracketing headroom the transform render clock ALWAYS holds beyond the measured
 *  jitter spread (seconds), so `renderTime` sits between two received keyframes even
 *  for a worst-case (95th-percentile) packet. this is the piece the old target was
 *  missing: it rendered exactly `jitterSpread` behind the newest keyframe (zero
 *  reserve), so any near-worst packet landed at/past the frontier and the sampler
 *  freeze-held then snapped. Source (`c_baseentity.cpp` GetInterpolationAmount)
 *  renders `cl_interp + 1 server tick`; our transform broadcast is capped at 20Hz
 *  (`rate.hz(20)`), so one keyframe interval is ~50ms and we reserve that. widens the
 *  visible lag on other players by this much and nothing else — the price of never
 *  freezing on jitter. */
const INTERP_BRACKET_RESERVE = 0.05;
/** hard ceiling on the adaptive transform render-behind (seconds), so a pathologically
 *  jittery link can't drive the buffer arbitrarily deep. total render-behind is then
 *  `SERVER_CLOCK_INTERP_DELAY + this` = 0.25s max. two reasons: (1) the snapshot ring
 *  is finite (`NET_SNAPSHOT_CAP` keyframes) and render time must stay inside it with a
 *  few keyframes of headroom; (2) past ~250ms of lag, rendering peers that far in the
 *  past is already a lot — a link jittery enough to need more is better served by
 *  snapping the worst ~5% of packets (graceful degradation) than by drifting the whole
 *  world further into the past. buffer depth tracks JITTER, not ping, so this covers a
 *  steady 300-400ms link (low jitter → small margin) and up to ~160ms of jitter (95th
 *  pct) before the tail snaps. Source sizes its history to the live interp amount the
 *  same way, rather than holding a fixed worst-case depth. */
const MAX_INTERP_MARGIN = 0.2;
/** slew caps for `interpMargin` (fraction of real time). grow fast so a rising jitter
 *  floor is covered before it snaps; shrink slow (hysteresis) so a lull doesn't yank
 *  the lag back and immediately re-dry. both stay < 1 so `clock.server − interpMargin`
 *  keeps advancing (render clock never freezes on the slew path). */
const INTERP_MARGIN_GROW_RATE = 0.6;
const INTERP_MARGIN_SHRINK_RATE = 0.1;

/** full-rate offset ring depth for the jitter estimator (~0.8s at the 60Hz push
 *  cadence). the jitter spread is measured over THIS window, fed on every push, not
 *  the decimated 12s offset window (which sees 1-in-6 packets and so blurs the
 *  high-frequency arrival jitter the transform buffer actually has to absorb). */
const JITTER_WINDOW_CAP = 48;

/** scratch for the per-observe percentile sort (≤ SYNC_SAMPLES_MAX live samples). */
const _sortedOffsets = new Float64Array(SYNC_SAMPLES_MAX);
/** scratch for the full-rate jitter percentile sort (≤ JITTER_WINDOW_CAP samples). */
const _jitterSorted = new Float64Array(JITTER_WINDOW_CAP);

function newSync(): ClockSync {
    return {
        targetOffset: 0,
        appliedOffset: 0,
        samples: [],
        synced: false,
        lastObserved: 0,
        latencyJitter: 0,
        jitterOffsets: new Float64Array(JITTER_WINDOW_CAP),
        jitterHead: -1,
        jitterCount: 0,
        interpMargin: 0,
        serverRenderTime: 0,
    };
}

/** fold one offset into the full-rate jitter ring and recompute `latencyJitter`, the
 *  spread the transform buffer must absorb. runs on EVERY push (before the offset
 *  estimator's decimation gate), so it sees arrival jitter at packet cadence. */
function observeJitter(sync: ClockSync, offset: number): void {
    const i = (sync.jitterHead + 1) % JITTER_WINDOW_CAP;
    sync.jitterHead = i;
    sync.jitterOffsets[i] = offset;
    if (sync.jitterCount < JITTER_WINDOW_CAP) sync.jitterCount++;

    // sort ascending (offset falls as latency rises → most-delayed first, least last).
    const n = sync.jitterCount;
    for (let k = 0; k < n; k++) _jitterSorted[k] = sync.jitterOffsets[k]!;
    _jitterSorted.subarray(0, n).sort();
    // spread from the least-delayed sample down to the `JITTER_COVERAGE` percentile of
    // the most-delayed, trimming the worst ~(1 − coverage) so a lone stall doesn't pin
    // the buffer wide for the whole window.
    const coverageIndex = Math.min(n - 1, Math.round((1 - JITTER_COVERAGE) * n));
    sync.latencyJitter = _jitterSorted[n - 1]! - _jitterSorted[coverageIndex]!;
}

/** `seed` is the server clock to align `server` to (from the join handshake);
 *  0 for the server itself and for local rooms. `time`/`wall` start at 0. */
export function init(seed = 0): Clock {
    return { time: 0, serverSmoothed: seed, wall: 0, sync: newSync(), serverLatest: 0 };
}

/** advance the fixed-cadence clocks by the elapsed tick delta (seconds). `time` is
 *  always local-stepped. `server` dead-reckons alongside it UNTIL continuous sync
 *  takes ownership: on the authoritative server and on local/offline rooms that
 *  never happens (no replies arrive), so the two stay locked; on a networked client
 *  `syncServer` drives `server` once the first sample lands, and we stop stepping it
 *  here so there's a single integrator (localMonotonic + offset), not two that fight. */
export function tick(clock: Clock, delta: number): void {
    clock.time += delta;
    if (!clock.sync.synced) clock.serverSmoothed += delta;
}

/** advance the smooth render clock by a real frame delta, every frame on the
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
 *  push arrived. The offset is render-behind, `serverClock − recvTime` tracks the
 *  server-time we observed (one-way latency old), not a forward-extrapolated true-now
 *  (see ClockSync). We retire stale samples, then take the least-delayed survivor (max
 *  offset) as the target, the tightest "behind by one-way latency". */
export function observeSample(clock: Clock, serverClock: number, recvTime: number): void {
    const sync = clock.sync;

    // store the raw authoritative stamp EVERY push (per-tick), so remote-transform
    // keyframes timestamp against a value that refreshes at the cadence a moving
    // entity emits poses. this is the unfiltered server time, distinct from the
    // skewed `server` render clock the estimator drives below.
    clock.serverLatest = serverClock;

    // feed the FULL-RATE jitter estimator on every push, BEFORE the decimation gate
    // below — arrival jitter is a fast-moving quantity, so it's measured at the cadence
    // packets actually land, not the 1-in-6 the offset-floor window sees.
    const offset = serverClock - recvTime;
    observeJitter(sync, offset);

    // decimate the OFFSET-FLOOR estimator feed to ~`SYNC_OBSERVE_MIN_INTERVAL`. the
    // first sample always passes (it flips `synced` and adopts the offset); afterward
    // we skip pushes closer than the interval so the least-delayed window spans real
    // time. `serverLatest`/`latencyJitter` above are unaffected, both always updated.
    if (sync.synced && recvTime - sync.lastObserved < SYNC_OBSERVE_MIN_INTERVAL) return;
    sync.lastObserved = recvTime;

    sync.samples.push({ offset, recvTime });
    // age out the window (oldest first), then bound its size as a backstop.
    const cutoff = recvTime - SYNC_SAMPLE_TTL;
    while (sync.samples.length > 0 && sync.samples[0].recvTime < cutoff) sync.samples.shift();
    while (sync.samples.length > SYNC_SAMPLES_MAX) sync.samples.shift();

    // sort the live offsets ascending (offset falls as latency rises, so ascending is
    // most-delayed → least-delayed). the top entry is the least-delayed sample, the
    // tightest "behind by one-way latency" → targetOffset.
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

/** advance `server` toward the synced estimate. Until the first sample lands this is
 *  a no-op and `server` rides the join seed (advanced by `tick`); after that
 *  `server = now + appliedOffset`, where `appliedOffset` is pulled toward the target
 *  by a rate-limited proportional controller: the step is proportional to the error
 *  (smooth, no overshoot, first-order) but capped at `SYNC_MAX_SLEW_RATE` so even a
 *  larger sub-snap gap closes without bending derived motion much. The slew path is
 *  monotonic (a capped offset change can't outrun the monotonic `now`); a gap past
 *  `SYNC_SNAP_THRESHOLD` (first fix, refocused tab) snaps, which may jump. */
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

/**
 * the render clock remote transform snapshots are sampled on: `clock.server` held
 * back by an adaptive, jitter-sized margin. `clock.server` tracks the LEAST-delayed
 * packets (min latency), so on a jittery link the slower packets land behind it and
 * their keyframes snap; `interpMargin` widens the render-behind to cover
 * `JITTER_COVERAGE` of the observed latency spread PLUS a fixed bracketing reserve,
 * so render time stays between two keyframes (never on the frontier) even for a
 * worst-case packet.
 *
 * call once per frame per room (after `syncServer`, so `clock.server` is fresh). it
 * slews `interpMargin` toward
 * `max(0, INTERP_BRACKET_RESERVE + latencyJitter − SERVER_CLOCK_INTERP_DELAY)` — 0
 * while `reserve + jitter` fits the fixed 50ms buffer, so good connections match a
 * fixed buffer exactly — and returns the monotonic render time. projectiles read
 * `clock.server` directly and are unaffected.
 */
export function transformRenderTime(clock: Clock, dt: number): number {
    const sync = clock.sync;

    // hold render time back by the full measured jitter spread PLUS a fixed bracketing
    // reserve, so even a worst-case packet lands with a keyframe still ahead of render
    // time (never freeze-holding on the frontier). the fixed 50ms buffer already baked
    // into `clock.server` covers the first slice, so only the excess needs an adaptive
    // margin — target 0 (no margin) whenever `reserve + spread` fits inside it, which
    // is every good connection, keeping those byte-identical to a fixed buffer.
    const wanted = INTERP_BRACKET_RESERVE + sync.latencyJitter - SERVER_CLOCK_INTERP_DELAY;
    const target = wanted < 0 ? 0 : wanted > MAX_INTERP_MARGIN ? MAX_INTERP_MARGIN : wanted;
    const rate = target > sync.interpMargin ? INTERP_MARGIN_GROW_RATE : INTERP_MARGIN_SHRINK_RATE;
    const maxStep = rate * dt;
    const residual = target - sync.interpMargin;
    sync.interpMargin += residual > maxStep ? maxStep : residual < -maxStep ? -maxStep : residual;

    // monotonic clamp: the slew keeps this advancing, but a backward snap of
    // `clock.server` (refocused tab) must not rewind remote motion.
    const next = clock.serverSmoothed - sync.interpMargin;
    if (next > sync.serverRenderTime) sync.serverRenderTime = next;
    return sync.serverRenderTime;
}
