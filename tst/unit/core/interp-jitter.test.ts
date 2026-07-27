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
    /** expected smooth per-frame step, for reference. */
    expectedStep: number;
};

/** `extrapolate` toggles the fix: when true we pass the real Clock.isServerChoking()
 *  verdict to the sampler (production behavior); when false we always hold (the old
 *  behavior), so the two can be compared on an identical packet stream. */
function simulate(delay: DelayModel, seed: number, extrapolate: boolean): Metrics {
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
        const pose = tick % TRANSFORM_EVERY === 0 ? MOVER_SPEED * serverWall : null;
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
        samplePositionSnapshot(snaps, renderTime, out, choking);

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

        const jump = Math.abs(out[0] - prevSampledX);
        if (jump > m.maxSnapJump) m.maxSnapJump = jump;
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

describe('remote-transform interpolation vs jitter shape', () => {
    it('absorbs smooth bounded jitter — render time stays bracketed, motion is smooth', () => {
        const m = simulate(smoothJitter, 0x1234, false);
        // render time never reaches the newest keyframe: always interpolating between two.
        expect(m.dryFrames).toBe(0);
        expect(m.maxBehindNewest).toBeLessThan(0);
        // largest per-frame move stays at the constant-velocity step (no snap).
        expect(m.maxSnapJump).toBeLessThan(m.expectedStep * 1.5);
    });

    it('BUG: breaks on a bursty link without the fix — freezes on the frontier then snaps', () => {
        const m = simulate(burstyJitter, 0x1234, false);
        // the buffer runs dry during stalls: many frozen frames on the frontier...
        expect(m.dryFrames).toBeGreaterThan(20);
        expect(m.coastFrames).toBe(0); // extrapolation disabled → never coasts
        expect(m.maxBehindNewest).toBeGreaterThan(0);
        // ...and the recovery snap is far larger than a smooth step.
        expect(m.maxSnapJump).toBeGreaterThan(m.expectedStep * 5);
    });

    it('FIX: choke-gated extrapolation coasts the bursty link smoothly', () => {
        const m = simulate(burstyJitter, 0x1234, true);
        // still goes dry during stalls, but now it COASTS instead of freezing...
        expect(m.dryFrames).toBeGreaterThan(20);
        expect(m.coastFrames).toBeGreaterThan(20);
        // ...so the snap collapses to near a normal step (residual is the ramp-to-zero
        // tail on stalls beyond the 250ms cap, not a freeze).
        expect(m.maxSnapJump).toBeLessThan(m.expectedStep * 2);
    });

    it('DISCIPLINE: the fix is a no-op on a healthy link (choke never fires, zero added lag)', () => {
        const off = simulate(smoothJitter, 0x1234, false);
        const on = simulate(smoothJitter, 0x1234, true);
        // no spurious extrapolation, and render-behind / motion are byte-identical.
        expect(on.coastFrames).toBe(0);
        expect(on.maxBehindNewest).toBe(off.maxBehindNewest);
        expect(on.maxSnapJump).toBe(off.maxSnapJump);
    });
});
