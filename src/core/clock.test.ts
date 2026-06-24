import { describe, expect, it } from 'vitest';
import * as Clock from './clock';

describe('Clock.init', () => {
    it('seeds server, starts time/wall at 0, and is unsynced', () => {
        const clock = Clock.init(100);
        expect(clock.time).toBe(0);
        expect(clock.server).toBe(100);
        expect(clock.wall).toBe(0);
        expect(clock.sync.synced).toBe(false);
    });
});

describe('Clock server-clock sync', () => {
    it('dead-reckons server before any sample (offline / pre-sync fallback)', () => {
        const clock = Clock.init(100);
        Clock.tick(clock, 1 / 60);
        expect(clock.server).toBeCloseTo(100 + 1 / 60, 6);
        // not yet synced — syncServer must leave the dead-reckoned value alone.
        Clock.syncServer(clock, 5, 1 / 60);
        expect(clock.server).toBeCloseTo(100 + 1 / 60, 6);
    });

    it('once synced, the fixed tick no longer advances server (single integrator)', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0, 0); // synced
        Clock.syncServer(clock, 100, 1 / 60); // server := 100 + offset(0) = 100
        const before = clock.server;
        Clock.tick(clock, 1 / 60); // must NOT bump server; syncServer owns it now
        expect(clock.server).toBe(before);
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
        // server == the server-time we observed, minus the interp buffer — i.e. behind
        // true server-now by the one-way latency the push took PLUS the jitter buffer.
        // that lag is what lines up server-stamped events without pop-in.
        expect(clock.server).toBeCloseTo(serverClock - Clock.SERVER_CLOCK_INTERP_DELAY, 9);
    });

    it('keeps the least-delayed (max-offset) sample as the target', () => {
        const clock = Clock.init(0);
        // offset = serverClock − recvTime; a more-delayed push reads as a smaller offset.
        Clock.observeSample(clock, 100.4, 0.4); // offset 100.0
        expect(clock.sync.targetOffset).toBeCloseTo(100.0, 9);
        // a MORE delayed push (smaller offset) is ignored.
        Clock.observeSample(clock, 101.0, 1.5); // offset 99.5
        expect(clock.sync.targetOffset).toBeCloseTo(100.0, 9);
        // a LESS delayed push (larger offset) wins — it's the freshest/tightest.
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
        let prev = clock.server;
        for (let i = 1; i <= 1200; i++) {
            Clock.syncServer(clock, 5 + i / 60, 1 / 60);
            expect(clock.server).toBeGreaterThanOrEqual(prev);
            prev = clock.server;
        }
        expect(clock.sync.appliedOffset).toBeCloseTo(0.1, 4);
    });

    it('snaps when the gap is too large to slew (e.g. a refocused tab)', () => {
        const clock = Clock.init(0);
        Clock.observeSample(clock, 0.0, 0.0); // offset 0 → synced, applied 0
        Clock.observeSample(clock, 2.0, 0.0); // offset 2.0 (> snap threshold)
        Clock.syncServer(clock, 10, 1 / 60);
        expect(clock.sync.appliedOffset).toBeCloseTo(2.0, 9);
        expect(clock.server).toBeCloseTo(12.0 - Clock.SERVER_CLOCK_INTERP_DELAY, 9);
    });

    it('end-to-end: client server clock tracks the server, one-way latency behind', () => {
        // server clock = local-monotonic + trueOffset; the old code dead-reckoned from
        // a single seed and drifted without bound. continuous push-sync must hold server
        // locked a steady one-way latency (L) behind true server-now for the whole
        // session — the lag that makes server-stamped events line up.
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
        expect(clock.server).toBeCloseTo(trueServerNow - L - Clock.SERVER_CLOCK_INTERP_DELAY, 6);
    });
});
