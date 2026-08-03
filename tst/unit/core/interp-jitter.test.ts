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
// The design under test prioritises ALWAYS-smooth remote motion over positional
// fidelity, via three rules (no extrapolation anywhere):
//   1. Render at a DEEP, jitter-adaptive delay behind server time. The margin grows fast
//      and shrinks glacially, so it behaves like a high-water mark that stays deep between
//      stalls — a bursty link that outran the old shallow buffer is now absorbed.
//   2. A dry buffer HOLDS the newest keyframe (never coasts a velocity guess). Holding is
//      forward-monotone: it can never rewind, so the "jitter forward then snap back"
//      artifact of extrapolation is gone by construction.
//   3. When a real stall does end and the newest pose jumps, the catch-up is folded into a
//      decaying visual offset (smooth) so it glides instead of snapping.

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
     *  buffered — a dry frontier where the buffer held the newest pose. */
    dryFrames: number;
    /** worst render-time overshoot past the newest keyframe (s). */
    maxBehindNewest: number;
    /** largest single-frame jump in rendered position (m). Smooth motion sits at
     *  MOVER_SPEED*DT; a big value is a visible SNAP out of a freeze. */
    maxSnapJump: number;
    /** largest single-frame BACKWARD move (m). Holding is forward-monotone for a
     *  forward-moving profile, so for those any backward step would be an artifact; for a
     *  profile with real backward motion it should stay near the true per-frame step. */
    maxBackwardStep: number;
    /** expected smooth per-frame step, for reference. */
    expectedStep: number;
};

/** true world x of the remote entity at a given server time. Keyframes sample this. */
type MoverProfile = (serverTime: number) => number;

/** run the real clock + sampler over a synthetic packet stream. `smooth` toggles the
 *  catch-up glide (production always passes true; false isolates the raw snap). */
function simulate(delay: DelayModel, seed: number, profile: MoverProfile, smooth: boolean): Metrics {
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
        samplePositionSnapshot(snaps, renderTime, out, smooth);

        if (wall < WARMUP_S) {
            prevSampledX = out[0];
            continue;
        }

        const newestTime = snaps.posTime[snaps.posHead]!;
        const behind = renderTime - newestTime;
        if (behind > m.maxBehindNewest) m.maxBehindNewest = behind;
        if (snaps.posCount > 1 && renderTime >= newestTime) m.dryFrames++;

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
// delayed ~350ms; monotonic arrival bunches the packets behind it). This is the shape
// that broke the old shallow buffer — the deep, sticky margin is what absorbs it now.
const STALL_PERIOD_TICKS = 4 * TICK_HZ;
const burstyJitter: DelayModel = (tick, rng) => {
    const base = 0.02 + rng() * 0.01; // 20–30ms one-way baseline
    return tick > 0 && tick % STALL_PERIOD_TICKS === 0 ? base + 0.35 : base;
};

const STALL_PERIOD_S = STALL_PERIOD_TICKS * DT; // 4s between stalls

// Constant-velocity mover: forward-monotone, the simplest catch-up case.
const constantVelocity: MoverProfile = (t) => MOVER_SPEED * t;

// Walk-then-pause mover: walks at MOVER_SPEED but STANDS STILL for PAUSE_S at the top of
// each stall period — where the head-of-line stall also lands. Under the old design the
// client coasted its last walking velocity through the stall and overshot, then snapped
// BACK when the keyframes revealed it was standing still. Holding never overshoots: the
// frozen newest keyframe IS the correct pose during the pause, so there is nothing to
// rewind.
const PAUSE_S = 0.4;
const walkPause: MoverProfile = (t) => {
    const periods = Math.floor(t / STALL_PERIOD_S);
    const movePerPeriod = STALL_PERIOD_S - PAUSE_S;
    const e = t - periods * STALL_PERIOD_S; // position within this period, 0..STALL_PERIOD_S
    let x = periods * movePerPeriod * MOVER_SPEED; // distance banked from completed periods
    if (e > PAUSE_S) x += (e - PAUSE_S) * MOVER_SPEED; // pause [0,PAUSE_S) then walk
    return x;
};

// Walk-then-reverse mover: walks forward, then REVERSES for PAUSE_S at the top of each
// stall period. This one has REAL backward motion, so a backward step is expected — but
// it must stay near the true per-frame step, never a larger snap (holding can't overshoot
// the reversal the way coasting did).
const walkReverse: MoverProfile = (t) => {
    const periods = Math.floor(t / STALL_PERIOD_S);
    const banked = periods * (STALL_PERIOD_S - 2 * PAUSE_S) * MOVER_SPEED;
    const e = t - periods * STALL_PERIOD_S;
    if (e < PAUSE_S) return banked - MOVER_SPEED * e; // reverse for PAUSE_S
    return banked - MOVER_SPEED * PAUSE_S + MOVER_SPEED * (e - PAUSE_S); // then forward
};

describe('remote-transform interpolation vs jitter shape', () => {
    it('absorbs smooth bounded jitter — render time stays bracketed, motion is smooth', () => {
        const m = simulate(smoothJitter, 0x1234, constantVelocity, true);
        // render time never reaches the newest keyframe: always interpolating between two.
        expect(m.dryFrames).toBe(0);
        expect(m.maxBehindNewest).toBeLessThan(0);
        // largest per-frame move stays at the constant-velocity step (no snap).
        expect(m.maxSnapJump).toBeLessThan(m.expectedStep * 1.5);
    });

    it('deep sticky buffer absorbs a bursty link — stays bracketed after it has grown', () => {
        const m = simulate(burstyJitter, 0x1234, constantVelocity, true);
        // The first stall (before the margin grew) may dry briefly, but the sticky margin
        // then holds deep, so the repeated stalls are absorbed: dry frames stay a small
        // fraction of the run rather than one burst per stall.
        expect(m.dryFrames).toBeLessThan(30);
        // forward-monotone profile: rendering NEVER rewinds (no extrapolation to overshoot).
        expect(m.maxBackwardStep).toBeLessThan(m.expectedStep);
    });

    it('catch-up after a dry stall is glided, not snapped', () => {
        const raw = simulate(burstyJitter, 0x1234, constantVelocity, false);
        const glided = simulate(burstyJitter, 0x1234, constantVelocity, true);
        // whatever dry-outs occur, the raw path snaps hard on recovery...
        expect(raw.maxSnapJump).toBeGreaterThan(raw.expectedStep * 4);
        // ...and the glide collapses that snap to a small fraction of it.
        expect(glided.maxSnapJump).toBeLessThan(raw.maxSnapJump / 3);
    });
});

// Holding never rewinds — the "jitter forward then snap back" artifact that extrapolation
// produced is gone by construction. Proven with movers whose real motion diverges from a
// linear projection of pre-stall velocity exactly while the transport stalls.
describe('remote-transform interpolation never rewinds (no extrapolation)', () => {
    it('mid-stall stop: holds the frozen pose, never overshoots backward', () => {
        const m = simulate(burstyJitter, 0x1234, walkPause, true);
        // during the pause the frozen newest keyframe is the correct pose, so the render is
        // forward-monotone: no overshoot, nothing to snap back from.
        expect(m.maxBackwardStep).toBeLessThan(m.expectedStep);
    });

    it('mid-stall reversal: backward motion stays near the true step, no snap-back', () => {
        const m = simulate(burstyJitter, 0x1234, walkReverse, true);
        // real backward motion here IS ~one step per frame. holding never overshoots it;
        // the catch-up glide eases a recovery over several frames, adding a little backward
        // motion on top of the real reversal, so the worst step sits at ~2x the true step —
        // a smooth ease, not the multi-metre snap-back extrapolation produced (~24x here).
        expect(m.maxBackwardStep).toBeLessThan(m.expectedStep * 2);
    });
});
