// ── per-game server tick rate ────────────────────────────────────────
//
// `config({ server: { tickRate } })` sets the SERVER's cadence only: owner-authority
// motion is stepped on its owner's client, which stays at 60 whatever the room does.
// locks in that the configured rate reaches the engine, that a second of wall time
// advances the room by that many ticks (and by a second of room clock, not a second
// scaled by whatever dt a host happened to pass), and that a nonsense rate is refused
// at declaration rather than silently clamped.

import { config } from 'bongle';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TICK_RATE } from '../../src/core/config';
import { createTestHarness, type TestHarness } from './harness';

const SERVER_HZ = 30;

describe('server tick rate', () => {
    let harness: TestHarness<unknown> | null = null;

    afterEach(() => {
        harness?.dispose();
        harness = null;
    });

    const boot = (tickRate?: number) =>
        createTestHarness(() => {
            config({ server: { maxPlayers: 4, ...(tickRate === undefined ? {} : { tickRate }) } });
            return {};
        });

    it('resolves the configured rate onto the server state', async () => {
        harness = await boot(SERVER_HZ);
        expect(harness.server.tickHz).toBe(SERVER_HZ);
        expect(harness.server.step).toBeCloseTo(1 / SERVER_HZ, 10);
    });

    it('defaults to 60 when a game does not pick one', async () => {
        harness = await boot();
        expect(harness.server.tickHz).toBe(DEFAULT_TICK_RATE);
        expect(harness.server.step).toBeCloseTo(1 / DEFAULT_TICK_RATE, 10);
    });

    it('advances a second of wall time as tickRate ticks and one second of room clock', async () => {
        harness = await boot(SERVER_HZ);
        const room = harness.room;
        const before = room.tick;

        // the clients in the same second run 60 times; tickSplit interleaves them as
        // they really run, which lockstep `tickN` cannot express.
        harness.tickSplit(1, SERVER_HZ);

        expect(room.tick - before).toBe(SERVER_HZ);
        // the room clock advances by the fixed step every tick, so a second of wall time
        // is a second of room time however the host paces its wake-ups.
        expect(room.clock.time).toBeCloseTo(1, 6);
    });

    it('a 60Hz room does twice the ticks in the same second', async () => {
        harness = await boot(DEFAULT_TICK_RATE);
        const room = harness.room;
        const before = room.tick;
        harness.tickSplit(1, DEFAULT_TICK_RATE);
        expect(room.tick - before).toBe(DEFAULT_TICK_RATE);
    });

    it('rejects a rate outside the supported range', async () => {
        await expect(boot(5)).rejects.toThrow(/tickRate/);
        await expect(boot(120)).rejects.toThrow(/tickRate/);
        await expect(boot(30.5)).rejects.toThrow(/tickRate/);
    });
});
