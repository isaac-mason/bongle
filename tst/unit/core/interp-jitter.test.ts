import { describe, expect, it } from 'vitest';
import { ensureRemoteInterpolation, type TransformTrait } from '../../../src/builtins/transform';
import * as Clock from '../../../src/core/clock';
import { advanceRemoteInterpolation, resetRemoteInterpolation } from '../../../src/render/transform/interpolation';

// End-to-end reproduction of remote-transform interpolation under two network jitter
// shapes, driving the REAL chase-latest translator (render/transform/interpolation ->
// advanceRemoteInterpolation) — no mocks of the code under test.
//
// The chase-latest model has ONE guarantee the old render-behind buffer could not keep
// on a bad link: the target is always the NEWEST received pose, so the rendered position
// can never freeze on a stale keyframe while the server has moved far ahead. It eases
// toward that live target over the observed send interval; if packets stall it keeps
// easing to the last target and settles there (never a hard freeze, never extrapolates
// past it).
//
// These tests assert exactly that: bounded tracking lag, forward-monotone motion for a
// forward mover, and — the regression that motivated the rewrite — the render NEVER
// stalls far behind a live, still-advancing target.

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
const TRANSFORM_EVERY = TICK_HZ / Clock.TRANSFORM_SEND_HZ; // 2 ticks -> 30Hz keyframes
const SERVER_SEED = 1000; // arbitrary server-clock epoch
const MOVER_SPEED = 5; // m/s, constant velocity along +x
const DURATION_S = 24;
const WARMUP_S = 3; // ignore the join transient (sync settling + first ease)

type Metrics = {
    /** worst tracking lag: how far the rendered x fell behind the newest RECEIVED
     *  target (m). Bounded means the chase keeps up; a large value would be the freeze. */
    maxTargetLag: number;
    /** largest single-frame BACKWARD move (m). A forward mover eased with cap 1.0 never
     *  rewinds, so any backward step is an artifact. */
    maxBackwardStep: number;
    /** frames where the rendered x did not advance at all while the received target had
     *  moved well ahead — the "frozen while server moved on" regression. */
    frozenWhileBehindFrames: number;
    /** expected smooth per-frame step, for reference. */
    expectedStep: number;
};

/** true world x of the remote entity at a given server time. Keyframes sample this. */
type MoverProfile = (serverTime: number) => number;

/** run the real clock + chase translator over a synthetic packet stream. */
function simulate(delay: DelayModel, seed: number, profile: MoverProfile): Metrics {
    const rng = mulberry32(seed);

    // Build the packet stream. The server is healthy (in tick budget): it emits one per
    // tick at a real 60Hz, so its fixed-step clock equals wall time. server_clock rides
    // every packet; a transform keyframe rides every 2nd. Arrival is monotonic (reliable+
    // ordered transport: a stall bunches the packets behind it, it never reorders them).
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
    // every packet that has arrived, folds server_clock into the sync and — exactly as
    // the transform sync unpack does — copies the pose into the live target and bumps the
    // channel sequence, then eases the translator toward that live target.
    const clock = Clock.init(SERVER_SEED);
    const trait = { _remoteInterpolation: null } as unknown as TransformTrait;
    const remote = ensureRemoteInterpolation(trait);
    const target: [number, number, number] = [0, 0, 0];
    const identity: [number, number, number, number] = [0, 0, 0, 1];
    resetRemoteInterpolation(remote, target, identity);

    let nextPacket = 0;
    let prevRenderedX = 0;
    let newestTarget = 0; // newest pose actually received (the live chase target's x)
    const m: Metrics = {
        maxTargetLag: 0,
        maxBackwardStep: 0,
        frozenWhileBehindFrames: 0,
        expectedStep: MOVER_SPEED * DT,
    };

    const frames = DURATION_S * TICK_HZ;
    for (let f = 1; f <= frames; f++) {
        const wall = f * DT;
        Clock.advanceWall(clock, DT);

        while (nextPacket < packets.length && packets[nextPacket]!.arrival <= wall) {
            const p = packets[nextPacket]!;
            Clock.observeSample(clock, p.serverClock, wall);
            if (p.pose !== null) {
                // mirror the sync unpack: live target := newest pose, bump the sequence
                // (stamped with serverLatest, the jitter-free authoritative send time).
                target[0] = p.pose;
                newestTarget = p.pose;
                remote.positionPendingStamp = clock.serverLatest;
                remote.positionSequence++;
            }
            nextPacket++;
        }

        Clock.syncServer(clock, wall, DT);
        advanceRemoteInterpolation(remote, target, identity, DT);
        const renderedX = remote.positionCurrent[0];

        if (wall < WARMUP_S) {
            prevRenderedX = renderedX;
            continue;
        }

        const lag = newestTarget - renderedX;
        if (lag > m.maxTargetLag) m.maxTargetLag = lag;

        const step = renderedX - prevRenderedX;
        if (-step > m.maxBackwardStep) m.maxBackwardStep = -step;

        // the freeze regression: rendered pose stuck (no advance) while the received
        // target sits well ahead (more than a few frames of true motion).
        if (step <= 1e-6 && lag > m.expectedStep * 4) m.frozenWhileBehindFrames++;

        prevRenderedX = renderedX;
    }

    return m;
}

// Smooth, bounded jitter — the shape the debug-pane net-sim produces (rtt/2 + uniform).
const smoothJitter: DelayModel = (_tick, rng) => 0.03 + rng() * 0.04; // 30-70ms one-way

// Bursty link: a tight baseline PLUS a big head-of-line stall every 4s (one packet
// delayed ~350ms; monotonic arrival bunches the packets behind it). This is the shape
// that dried the old render-behind buffer and froze it on a stale keyframe.
const STALL_PERIOD_TICKS = 4 * TICK_HZ;
const burstyJitter: DelayModel = (tick, rng) => {
    const base = 0.02 + rng() * 0.01; // 20-30ms one-way baseline
    return tick > 0 && tick % STALL_PERIOD_TICKS === 0 ? base + 0.35 : base;
};

// Constant-velocity mover: forward-monotone, the simplest tracking case.
const constantVelocity: MoverProfile = (t) => MOVER_SPEED * t;

describe('remote-transform chase-latest vs jitter shape', () => {
    it('tracks a constant mover under smooth jitter with bounded lag, no rewind', () => {
        const m = simulate(smoothJitter, 0x1234, constantVelocity);
        // the ease lag is ~one send interval of travel; comfortably under a fixed bound.
        expect(m.maxTargetLag).toBeLessThan(MOVER_SPEED * 0.15); // < 15ms*... ~0.75m
        // forward mover, cap 1.0: rendering never rewinds.
        expect(m.maxBackwardStep).toBeLessThanOrEqual(1e-6);
        // and it never freezes behind a live target.
        expect(m.frozenWhileBehindFrames).toBe(0);
    });

    it('never freezes behind a live target across a bursty stall (the regression)', () => {
        const m = simulate(burstyJitter, 0x1234, constantVelocity);
        // the whole point of chase-latest: even when a stall bunches packets, the target
        // is always the newest received pose, so the render keeps easing toward it and
        // never stalls far behind while the server has moved on.
        expect(m.frozenWhileBehindFrames).toBe(0);
        // the stall bunches a burst of poses; the chase absorbs it, so worst-case lag
        // stays bounded (a fraction of a second of travel) rather than unbounded freeze.
        expect(m.maxTargetLag).toBeLessThan(MOVER_SPEED * 0.5); // < ~2.5m even at the burst
        // forward mover: still no rewind through the burst.
        expect(m.maxBackwardStep).toBeLessThanOrEqual(1e-6);
    });
});
