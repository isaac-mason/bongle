import { describe, expect, it } from 'vitest';
import {
    type NetSnapshots,
    pushPositionSnapshot,
    samplePositionSnapshot,
    type TransformTrait,
} from '../../../src/builtins/transform';
import * as Clock from '../../../src/core/clock';

// End-to-end reproduction of remote-transform interpolation under two network jitter
// shapes, driving the REAL clock sync (core/clock) and the REAL snapshot sampler
// (builtins/transform) — no mocks of the code under test.
//
// Two things are proven here:
//   1. The BUG: the jank is about the SHAPE of jitter, not its amount. Smooth bounded
//      jitter (the debug-pane net-sim's shape) is absorbed by the adaptive buffer; a
//      BURSTY link (head-of-line stalls, what real TCP/WAN does) outruns the buffer's
//      growth rate, render time crosses the newest keyframe, and the mover freezes then
//      snaps.
//   2. The FIX: choke-gated extrapolation. When Clock.isServerChoking reports a
//      transport stall, a dry position buffer coasts the last velocity instead of
//      freezing — so the same bursty link is smooth — WITHOUT changing anything on a
//      healthy link (the choke gate never fires there).

/** deterministic PRNG (mulberry32) so the "random" jitter is reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** one-way transit delay (seconds) for the packet sent on server tick `tick`. */
type DelayModel = (tick: number, rng: () => number) => number;

const TICK_HZ = 60;
const DT = 1 / TICK_HZ;
const TRANSFORM_EVERY = TICK_HZ / Clock.TRANSFORM_SEND_HZ; // 2 ticks → 30Hz keyframes
const SERVER_SEED = 1000; // arbitrary server-clock epoch
const MOVER_SPEED = 5; // m/s, constant velocity along +x
const DURATION_S = 24;
const WARMUP_S = 3; // ignore the join transient (sync settling + ring fill)

type Metrics = {
    /** frames where render time reached/passed the newest keyframe with >1 keyframe
     *  buffered — a dry frontier. Same whether we then freeze (hold) or coast. */
    dryFrames: number;
    /** dry frames where the transport was choking, so extrapolation coasted the buffer. */
    coastFrames: number;
    /** worst render-time overshoot past the newest keyframe (s). */
    maxBehindNewest: number;
    /** largest single-frame jump in sampled position (m). Smooth motion sits at
     *  MOVER_SPEED*DT; a big value is the visible SNAP out of a freeze. */
    maxSnapJump: number;
    /** largest single-frame BACKWARD move (m) — the mover profiles here are
     *  forward-monotone, so any backward step is the "jitter forward then snap back"
     *  artifact: extrapolation coasted past where the entity actually was, then the
     *  real keyframes pulled it back. 0 == never rewinds. */
    maxBackwardStep: number;
    /** expected smooth per-frame step, for reference. */
    expectedStep: number;
};

/** true world x of the remote entity at a given server time. Keyframes sample this. */
type MoverProfile = (serverTime: number) => number;

/** `extrapolate` toggles the fix: when true we pass the real Clock.isServerChoking()
 *  verdict to the sampler (production behavior); when false we always hold (the old
 *  behavior), so the two can be compared on an identical packet stream. */
function simulate(delay: DelayModel, seed: number, extrapolate: boolean, profile: MoverProfile, smooth: boolean): Metrics {
    const rng = mulberry32(seed);

    // Build the packet stream. The server is healthy (in tick budget): it emits one
    // per tick at a real 60Hz, so its fixed-step clock equals wall time. server_clock
    // rides every packet; a transform keyframe rides every 2nd. Arrival is monotonic
    // (reliable+ordered transport: a stall bunches the packets behind it, it never
    // reorders them).
    type Packet = { arrival: number; serverClock: number; pose: number | null };
    const packets: Packet[] = [];
    let prevArrival = 0;
    const totalTicks = DURATION_S * TICK_HZ;
    for (let tick = 0; tick < totalTicks; tick++) {
        const serverWall = tick * DT;
        const serverClock = SERVER_SEED + serverWall;
        const arrival = Math.max(prevArrival, serverWall + delay(tick, rng));
        prevArrival = arrival;
        const pose = tick % TRANSFORM_EVERY === 0 ? profile(serverWall) : null;
        packets.push({ arrival, serverClock, pose });
    }

    // The client: render at 60Hz. Each frame advances wall by the real delta, drains
    // every packet that has arrived, folds server_clock into the sync and pushes the
    // keyframe stamped with serverLatest (exactly as engine-client does), then samples
    // the mover at the render clock the engine derives.
    const clock = Clock.init(SERVER_SEED);
    const trait = { _netSnapshots: null } as unknown as TransformTrait;
    const out: [number, number, number] = [0, 0, 0];

    let nextPacket = 0;
    let prevSampledX = 0;
    const m: Metrics = {
        dryFrames: 0,
        coastFrames: 0,
        maxBehindNewest: -Infinity,
        maxSnapJump: 0,
        maxBackwardStep: 0,
        expectedStep: MOVER_SPEED * DT,
    };

    const frames = DURATION_S * TICK_HZ;
    for (let f = 1; f <= frames; f++) {
        const wall = f * DT;
        Clock.advanceWall(clock, DT);

        while (nextPacket < packets.length && packets[nextPacket]!.arrival <= wall) {
            const p = packets[nextPacket]!;
            // recvTime is the render clock (wall) at drain, the same base syncServer
            // reads — matches engine-client's `observeSample(clock, serverClock, wall)`.
            Clock.observeSample(clock, p.serverClock, wall);
            if (p.pose !== null) pushPositionSnapshot(trait, clock.serverLatest, [p.pose, 0, 0]);
            nextPacket++;
        }

        Clock.syncServer(clock, wall, DT);
        const renderTime = Clock.transformRenderTime(clock, DT);

        const snaps = trait._netSnapshots as NetSnapshots | null;
        if (!snaps || snaps.posCount === 0) continue;
        // production gates extrapolation on the transport choke verdict (see engine-client).
        const choking = extrapolate && Clock.isServerChoking(clock);
        samplePositionSnapshot(snaps, renderTime, out, choking, smooth);

        if (wall < WARMUP_S) {
            prevSampledX = out[0];
            continue;
        }

        const newestTime = snaps.posTime[snaps.posHead]!;
        const behind = renderTime - newestTime;
        if (behind > m.maxBehindNewest) m.maxBehindNewest = behind;
        const dry = snaps.posCount > 1 && renderTime >= newestTime;
        if (dry) m.dryFrames++;
        if (dry && choking) m.coastFrames++;

        const step = out[0] - prevSampledX;
        if (Math.abs(step) > m.maxSnapJump) m.maxSnapJump = Math.abs(step);
        if (-step > m.maxBackwardStep) m.maxBackwardStep = -step;
        prevSampledX = out[0];
    }

    return m;
}

// Smooth, bounded jitter — a stationary distribution the adaptive buffer settles on.
// This is the shape the debug-pane net-sim produces (rtt/2 + uniform(0, jitter)).
const smoothJitter: DelayModel = (_tick, rng) => 0.03 + rng() * 0.04; // 30–70ms one-way

// Bursty link: a tight baseline PLUS a big head-of-line stall every 4s (one packet
// delayed ~350ms; monotonic arrival bunches the packets behind it). Stalls are spaced
// far enough apart that the interp margin (shrinks at 10%/s) decays back between them,
// so each stall lands against a small buffer — a real intermittent-congestion link.
const STALL_PERIOD_TICKS = 4 * TICK_HZ;
const burstyJitter: DelayModel = (tick, rng) => {
    const base = 0.02 + rng() * 0.01; // 20–30ms one-way baseline
    return tick > 0 && tick % STALL_PERIOD_TICKS === 0 ? base + 0.35 : base;
};

const STALL_PERIOD_S = STALL_PERIOD_TICKS * DT; // 4s between stalls

// Constant-velocity mover: the simple case where extrapolation is exact.
const constantVelocity: MoverProfile = (t) => MOVER_SPEED * t;

// Walk-then-pause mover: walks at MOVER_SPEED but STANDS STILL for PAUSE_S at the top of
// each stall period — where the head-of-line stall also lands. So while the entity is
// actually stopped, the client (mid-stall, buffer dry) coasts its last WALKING velocity
// forward, overshooting the true position; when the bunched keyframes finally land they
// reveal it was standing still and the sampler snaps BACK. This is the "jitter forward
// then back" extrapolation introduced. Holding doesn't overshoot here — during the pause
// the frozen newest keyframe IS the correct pose.
const PAUSE_S = 0.4;
const walkPause: MoverProfile = (t) => {
    const periods = Math.floor(t / STALL_PERIOD_S);
    const movePerPeriod = STALL_PERIOD_S - PAUSE_S;
    const e = t - periods * STALL_PERIOD_S; // position within this period, 0..STALL_PERIOD_S
    let x = periods * movePerPeriod * MOVER_SPEED; // distance banked from completed periods
    if (e > PAUSE_S) x += (e - PAUSE_S) * MOVER_SPEED; // pause [0,PAUSE_S) then walk
    return x;
};

// Walk-then-reverse mover: the harshest case. It walks forward, then REVERSES (walks
// backward at the same speed) for PAUSE_S at the top of each stall period. Mid-stall the
// client coasts the last FORWARD velocity while the entity is actually going backward, so
// the overshoot (and the recovery correction) is doubled. Real backward motion here is
// exactly one step per frame, so a smoothed correction should keep the worst backward step
// near that — anything much larger is the un-smoothed snap leaking through.
const walkReverse: MoverProfile = (t) => {
    const periods = Math.floor(t / STALL_PERIOD_S);
    const banked = periods * (STALL_PERIOD_S - 2 * PAUSE_S) * MOVER_SPEED;
    const e = t - periods * STALL_PERIOD_S;
    if (e < PAUSE_S) return banked - MOVER_SPEED * e; // reverse for PAUSE_S
    return banked - MOVER_SPEED * PAUSE_S + MOVER_SPEED * (e - PAUSE_S); // then forward
};

describe('remote-transform interpolation vs jitter shape', () => {
    it('absorbs smooth bounded jitter — render time stays bracketed, motion is smooth', () => {
        const m = simulate(smoothJitter, 0x1234, false, constantVelocity, true);
        // render time never reaches the newest keyframe: always interpolating between two.
        expect(m.dryFrames).toBe(0);
        expect(m.maxBehindNewest).toBeLessThan(0);
        // largest per-frame move stays at the constant-velocity step (no snap).
        expect(m.maxSnapJump).toBeLessThan(m.expectedStep * 1.5);
    });

    it('BUG: breaks on a bursty link without the fix — freezes on the frontier then snaps', () => {
        const m = simulate(burstyJitter, 0x1234, false, constantVelocity, true);
        // the buffer runs dry during stalls: many frozen frames on the frontier...
        expect(m.dryFrames).toBeGreaterThan(20);
        expect(m.coastFrames).toBe(0); // extrapolation disabled → never coasts
        expect(m.maxBehindNewest).toBeGreaterThan(0);
        // ...and the recovery snap is far larger than a smooth step.
        expect(m.maxSnapJump).toBeGreaterThan(m.expectedStep * 5);
    });

    it('FIX: choke-gated extrapolation coasts the bursty link smoothly', () => {
        const m = simulate(burstyJitter, 0x1234, true, constantVelocity, true);
        // still goes dry during stalls, but now it COASTS instead of freezing...
        expect(m.dryFrames).toBeGreaterThan(20);
        expect(m.coastFrames).toBeGreaterThan(20);
        // ...so the snap collapses to near a normal step (residual is the ramp-to-zero
        // tail on stalls beyond the 250ms cap, not a freeze).
        expect(m.maxSnapJump).toBeLessThan(m.expectedStep * 2);
    });

    it('DISCIPLINE: the fix is a no-op on a healthy link (choke never fires, zero added lag)', () => {
        const off = simulate(smoothJitter, 0x1234, false, constantVelocity, true);
        const on = simulate(smoothJitter, 0x1234, true, constantVelocity, true);
        // no spurious extrapolation, and render-behind / motion are byte-identical.
        expect(on.coastFrames).toBe(0);
        expect(on.maxBehindNewest).toBe(off.maxBehindNewest);
        expect(on.maxSnapJump).toBe(off.maxSnapJump);
    });
});

// The flip-side of the extrapolation fix: when the entity's real motion during a stall
// differs from the linear projection of its pre-stall velocity (it stops / slows / turns),
// coasting overshoots and the recovery pulls it back — visible as "jitter forward then
// snap back". Reproduced with a mover that stops exactly while the transport stalls.
describe('remote-transform interpolation overshoot on mid-stall velocity change', () => {
    it('BUG: extrapolation overshoots a mid-stall stop then snaps backward (no smoothing)', () => {
        const m = simulate(burstyJitter, 0x1234, true, walkPause, false);
        expect(m.coastFrames).toBeGreaterThan(0); // it did extrapolate the stop
        expect(m.maxBackwardStep).toBeGreaterThan(m.expectedStep * 3); // and rewound hard
    });

    it('FIX: correction smoothing glides the overshoot back — no visible rewind', () => {
        const raw = simulate(burstyJitter, 0x1234, true, walkPause, false);
        const m = simulate(burstyJitter, 0x1234, true, walkPause, true);
        expect(m.coastFrames).toBeGreaterThan(0); // still coasts the stall (freeze fix kept)
        // the 1m backward snap becomes a gentle glide — well under a jerk, and ~7x smaller.
        expect(m.maxBackwardStep).toBeLessThan(m.expectedStep * 2.5);
        expect(m.maxBackwardStep).toBeLessThan(raw.maxBackwardStep / 5);
    });

    it('SECOND GUARD: reverses direction mid-stall (harshest overshoot) — still smoothed', () => {
        const raw = simulate(burstyJitter, 0x1234, true, walkReverse, false);
        const m = simulate(burstyJitter, 0x1234, true, walkReverse, true);
        // real motion here IS backward, so the offset is bigger, but the smoothed step is
        // still a small fraction of the raw ~2m snap.
        expect(m.maxBackwardStep).toBeLessThan(raw.maxBackwardStep / 4);
    });

    it('holding never rewinds — the backward jitter is introduced by extrapolation', () => {
        const m = simulate(burstyJitter, 0x1234, false, walkPause, false);
        // during the pause the frozen newest keyframe is the correct pose, so hold is
        // forward-monotone: no overshoot, nothing to snap back from.
        expect(m.maxBackwardStep).toBeLessThan(m.expectedStep);
    });
});
