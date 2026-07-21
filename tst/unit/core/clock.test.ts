import { describe, expect, it } from 'vitest';
import * as Clock from '../../../src/core/clock';

describe('Clock.init', () => {
    it('seeds server, starts time/wall at 0, and is unsynced', () => {
        const clock = Clock.init(100);
        expect(clock.time).toBe(0);
        expect(clock.serverSmoothed).toBe(100);
        expect(clock.wall).toBe(0);
        expect(clock.sync.synced).toBe(false);
    });
});

describe('Clock server-clock sync', () => {
    it('dead-reckons server before any sample (offline / pre-sync fallback)', () => {
        const clock = Clock.init(100);
        Clock.tick(clock, 1 / 60);
        expect(clock.serverSmoothed).toBeCloseTo(100 + 1 / 60, 6);
        // not yet synced, syncServer must leave the dead-reckoned value alone.
        Clock.syncServer(clock, 5, 1 / 60);
        expect(clock.serverSmoothed).toBeCloseTo(100 + 1 / 60, 6);
    });

    it('once synced, the fixed tick no longer advances server (single integrator)', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0, 0); // synced
        Clock.syncServer(clock, 100, 1 / 60); // server := 100 + offset(0) = 100
        const before = clock.serverSmoothed;
        Clock.tick(clock, 1 / 60); // must NOT bump server; syncServer owns it now
        expect(clock.serverSmoothed).toBe(before);
        expect(clock.time).toBeCloseTo(1 / 60, 9); // time still steps locally
    });

    it('first push snaps server onto the shared timeline, one-way latency behind', () => {
        const clock = Clock.init(0);
        // the server stamped `serverClock`; it reached us at local-monotonic recvTime,
        // one-way latency later. offset = serverClock − recvTime (render-behind).
        const serverClock = 510;
        const recvTime = 10.2;

        Clock.observeSample(clock, serverClock, recvTime);
        expect(clock.sync.synced).toBe(true);
        expect(clock.sync.appliedOffset).toBeCloseTo(serverClock - recvTime, 9);

        Clock.syncServer(clock, recvTime, 1 / 60);
        // server == the server-time we observed, minus the interp buffer, i.e. behind
        // true server-now by the one-way latency the push took PLUS the jitter buffer.
        // that lag is what lines up server-stamped events without pop-in.
        expect(clock.serverSmoothed).toBeCloseTo(serverClock - Clock.SERVER_CLOCK_INTERP_DELAY, 9);
    });

    it('keeps the least-delayed (max-offset) sample as the target', () => {
        const clock = Clock.init(0);
        // offset = serverClock − recvTime; a more-delayed push reads as a smaller offset.
        Clock.observeSample(clock, 100.4, 0.4); // offset 100.0
        expect(clock.sync.targetOffset).toBeCloseTo(100.0, 9);
        // a MORE delayed push (smaller offset) is ignored.
        Clock.observeSample(clock, 101.0, 1.5); // offset 99.5
        expect(clock.sync.targetOffset).toBeCloseTo(100.0, 9);
        // a LESS delayed push (larger offset) wins, it's the freshest/tightest.
        Clock.observeSample(clock, 102.4, 2.2); // offset 100.2
        expect(clock.sync.targetOffset).toBeCloseTo(100.2, 9);
    });

    it('expires stale samples so a sustained latency rise is tracked', () => {
        const clock = Clock.init(0);
        // a lucky low-latency push early on → high offset.
        Clock.observeSample(clock, 10.0, 0.01); // offset 9.99
        expect(clock.sync.targetOffset).toBeCloseTo(9.99, 9);
        // ...then latency rises for good (lower offsets). Once the lucky sample ages
        // past the TTL (12s), the target must follow the new, higher-latency floor.
        for (let t = 1; t <= 20; t++) {
            // offset = (t+10) − (t+0.2) = 9.8.
            Clock.observeSample(clock, t + 10.0, t + 0.2);
        }
        expect(clock.sync.targetOffset).toBeCloseTo(9.8, 9);
    });

    it('pulls smoothly toward a new target without jumping, and never backward', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0.0, 0.0); // offset 0 → synced, applied 0
        expect(clock.sync.appliedOffset).toBeCloseTo(0, 9);
        // a less-delayed push moves the target to +0.1 (a small, slewable gap).
        Clock.observeSample(clock, 1.1, 1.0); // offset 0.1
        expect(clock.sync.targetOffset).toBeCloseTo(0.1, 9);

        // one frame must not jump straight to the target.
        Clock.syncServer(clock, 5, 1 / 60);
        expect(clock.sync.appliedOffset).toBeGreaterThan(0);
        expect(clock.sync.appliedOffset).toBeLessThan(0.1);

        // drive frames: converges to the target, and server stays monotonic.
        let prev = clock.serverSmoothed;
        for (let i = 1; i <= 1200; i++) {
            Clock.syncServer(clock, 5 + i / 60, 1 / 60);
            expect(clock.serverSmoothed).toBeGreaterThanOrEqual(prev);
            prev = clock.serverSmoothed;
        }
        expect(clock.sync.appliedOffset).toBeCloseTo(0.1, 4);
    });

    it('snaps when the gap is too large to slew (e.g. a refocused tab)', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0.0, 0.0); // offset 0 → synced, applied 0
        // second sample spaced past the estimator decimation interval (per-tick
        // pushes are decimated to ~10Hz); offset 2.0 (> snap threshold).
        Clock.observeSample(clock, 2.2, 0.2);
        Clock.syncServer(clock, 10, 1 / 60);
        expect(clock.sync.appliedOffset).toBeCloseTo(2.0, 9);
        expect(clock.serverSmoothed).toBeCloseTo(12.0 - Clock.SERVER_CLOCK_INTERP_DELAY, 9);
    });

    it('end-to-end: client server clock tracks the server, one-way latency behind', () => {
        // server clock = local-monotonic + trueOffset; the old code dead-reckoned from
        // a single seed and drifted without bound. continuous push-sync must hold server
        // locked a steady one-way latency (L) behind true server-now for the whole
        // session, the lag that makes server-stamped events line up.
        const clock = Clock.init(0);
        const trueOffset = 1234.5;
        const L = 0.04; // one-way push latency
        const dt = 1 / 60;

        for (let frame = 1; frame <= 1200; frame++) {
            const now = frame * dt;
            // server pushes ~10Hz; each push was stamped one-way (L) before it arrives.
            if (frame % 6 === 0) {
                const serverClock = now - L + trueOffset;
                Clock.observeSample(clock, serverClock, now);
            }
            Clock.syncServer(clock, now, dt);
        }

        const finalNow = 1200 * dt;
        const trueServerNow = finalNow + trueOffset;
        // behind true server-now by the one-way latency AND the fixed interp buffer.
        expect(clock.serverSmoothed).toBeCloseTo(trueServerNow - L - Clock.SERVER_CLOCK_INTERP_DELAY, 6);
    });
});

describe('Clock raw server stamp (keyframe timestamps)', () => {
    it('stores lastServerStamp on EVERY push, even decimated ones', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 5.0, 0.0); // first: synced + folded
        expect(clock.serverLatest).toBe(5.0);
        // second arrives within the decimation interval: estimator skips it, but the
        // raw stamp (which keyframes read) must still refresh at the per-tick cadence.
        Clock.observeSample(clock, 5.1, 0.01);
        expect(clock.serverLatest).toBe(5.1);
        expect(clock.sync.samples.length).toBe(1); // feed was decimated
    });
});

describe('Clock adaptive transform interp margin', () => {
    // feed n samples ≥ the decimation interval apart (so all fold) with the given
    // per-sample offset, offsets chosen so the sorted spread is known.
    function feed(clock: Clock.Clock, offsets: number[]): void {
        for (let i = 0; i < offsets.length; i++) {
            const recvTime = i * 0.1; // 0.1s spacing ≥ SYNC_OBSERVE_MIN_INTERVAL
            Clock.observeSample(clock, recvTime + offsets[i]!, recvTime);
        }
    }

    // slew the margin to steady state (grow 0.5/s, so ~0.5s to cover 250ms).
    function settleMargin(clock: Clock.Clock): void {
        for (let i = 0; i < 300; i++) Clock.transformRenderTime(clock, 1 / 60);
    }

    it('settles to the fixed send-rate floor on a zero-jitter link', () => {
        const clock = Clock.init(0);
        // 0 spread → margin settles to the fixed floor, INTERP_BASE_BEHIND − fixed
        // buffer = (4 × 1/30) − 0.05 ≈ 0.0833, i.e. total render-behind ≈ INTERP_BASE_BEHIND.
        feed(
            clock,
            Array.from({ length: 16 }, () => 1.0),
        );
        expect(clock.sync.latencyJitter).toBeCloseTo(0, 6);
        settleMargin(clock);
        expect(clock.sync.interpMargin).toBeCloseTo(0.0833, 3);
    });

    it('widens beyond the floor to cover the jitter spread', () => {
        const clock = Clock.init(0);
        // 20ms spread. target = INTERP_BASE_BEHIND + spread − fixed buffer ≈ 0.0833 + 0.02.
        feed(
            clock,
            Array.from({ length: 16 }, (_, i) => 1.0 + (i % 2) * 0.02),
        );
        expect(clock.sync.latencyJitter).toBeCloseTo(0.02, 6);
        settleMargin(clock);
        expect(clock.sync.interpMargin).toBeCloseTo(0.1033, 3);
    });

    it('clamps the margin to the max render-behind on a very jittery link', () => {
        const clock = Clock.init(0);
        // half fast (offset 1.0), half slow (0.7): 300ms spread. floor + spread −
        // buffer ≈ 0.0833 + 0.30 far exceeds MAX_INTERP_MARGIN (0.2), so it clamps.
        feed(
            clock,
            Array.from({ length: 16 }, (_, i) => (i < 8 ? 1.0 : 0.7)),
        );
        expect(clock.sync.latencyJitter).toBeCloseTo(0.3, 6);
        settleMargin(clock);
        expect(clock.sync.interpMargin).toBeCloseTo(0.2, 3);
    });

    it('trims a lone outlier from the spread (percentile, not raw max)', () => {
        const clock = Clock.init(0);
        // 15 tight samples + 1 huge outlier; the outlier is dropped so it does not
        // pin the buffer wide.
        const offsets = Array.from({ length: 16 }, () => 1.0);
        offsets[3] = 0.1; // 900ms outlier
        feed(clock, offsets);
        expect(clock.sync.latencyJitter).toBeCloseTo(0, 6); // outlier trimmed away
    });

    it('render time is monotonic across a backward snap of clock.server', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0, 0); // synced, jitter 0
        clock.serverSmoothed = 100;
        // margin grows toward the floor at 0.6/s, so one 1/60s step adds 0.01: r1 = 100 − 0.01.
        const r1 = Clock.transformRenderTime(clock, 1 / 60);
        expect(r1).toBeCloseTo(99.99, 6);
        clock.serverSmoothed = 90; // refocused-tab style backward snap
        const r2 = Clock.transformRenderTime(clock, 1 / 60);
        expect(r2).toBeGreaterThanOrEqual(r1); // clamp holds, no rewind
    });
});
