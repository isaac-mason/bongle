import { describe, expect, it } from 'vitest';
import type { TraitSyncState } from '../traits';
import { captureValue, diffSyncSlice } from './sync-diff';
import { syncMetric } from './sync-rate';

// minimal stubs — diffSyncSlice only touches codec.{pack,packInto} + syncDef.{rate,pack}
// + the per-instance sync state, so we avoid pulling real packcat codecs (and their
// runtime env needs) into the test. packInto mirrors pack: write the slice's bytes into
// the scratch, return the length.
const node = {} as never;
const codec = {
    pack: (inst: { bytes: Uint8Array }) => inst.bytes,
    packInto: (inst: { bytes: Uint8Array }, _node: never, u8: Uint8Array, offset: number) => {
        u8.set(inst.bytes, offset);
        return inst.bytes.length;
    },
} as never;
const def = (rate: unknown, pack: (inst: never) => unknown) => ({ rate, pack, authority: 'server' }) as never;
const syncState = (): TraitSyncState => ({
    dirty: new Uint32Array(1),
    bytes: [],
    values: [],
    versions: new Float64Array(1),
    traitVersion: 0,
});

describe('syncMetric', () => {
    it('distance is euclidean', () => {
        expect(syncMetric.distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5);
    });
    it('scalar is abs diff', () => {
        expect(syncMetric.scalar(2, 5)).toBe(3);
    });
    it('angle: 0 for identical quaternions, π for orthogonal', () => {
        expect(syncMetric.angle([0, 0, 0, 1], [0, 0, 0, 1])).toBeCloseTo(0);
        expect(syncMetric.angle([0, 0, 0, 1], [0, 0, 1, 0])).toBeCloseTo(Math.PI);
    });
});

describe('captureValue', () => {
    it('clones an array on first capture (no aliasing to the live value)', () => {
        const live = [1, 2, 3];
        const stored = captureValue(undefined, live) as number[];
        expect(stored).toEqual([1, 2, 3]);
        expect(stored).not.toBe(live);
    });
    it('copies in place when shape matches (zero-alloc steady state)', () => {
        const prev = [1, 2, 3];
        const stored = captureValue(prev, [4, 5, 6]);
        expect(stored).toBe(prev); // reused buffer
        expect(prev).toEqual([4, 5, 6]);
    });
    it('stores scalars directly', () => {
        expect(captureValue(undefined, 7)).toBe(7);
    });
});

describe('diffSyncSlice — byte-diff', () => {
    const realtime = () => def('realtime', (inst: { value: number }) => inst.value);

    it('server seeds a first-seen slice silently; client emits it', () => {
        const inst = { bytes: new Uint8Array([1]), value: 1 };
        const s = syncState();
        expect(diffSyncSlice(realtime(), codec, inst as never, node, 0, s, false)).toBe(false);
        expect(s.bytes[0]).toBeDefined(); // seeded for next compare

        const c = syncState();
        expect(diffSyncSlice(realtime(), codec, inst as never, node, 0, c, true)).toBe(true);
    });

    it('emits on byte change, stays silent when unchanged', () => {
        const inst = { bytes: new Uint8Array([1]), value: 1 };
        const s = syncState();
        diffSyncSlice(realtime(), codec, inst as never, node, 0, s, false); // seed
        expect(diffSyncSlice(realtime(), codec, inst as never, node, 0, s, false)).toBe(false);
        inst.bytes = new Uint8Array([2]);
        expect(diffSyncSlice(realtime(), codec, inst as never, node, 0, s, false)).toBe(true);
    });
});

describe('diffSyncSlice — threshold', () => {
    const posDef = () => def({ threshold: 1, metric: syncMetric.distance }, (inst: { pos: number[] }) => inst.pos);

    it('emits only on significant change; sub-threshold accumulates against the last emit', () => {
        const inst = { pos: [0, 0, 0], bytes: new Uint8Array([0]) };
        const s = syncState();

        // first-seen on the server → seed silently
        expect(diffSyncSlice(posDef(), codec, inst as never, node, 0, s, false)).toBe(false);

        // move 0.5 (< threshold) → silent, snapshot NOT advanced
        inst.pos = [0.5, 0, 0];
        expect(diffSyncSlice(posDef(), codec, inst as never, node, 0, s, false)).toBe(false);

        // move to 1.0 → vs last EMITTED [0,0,0] = 1.0 ≥ 1 → emit (accumulated, not vs 0.5)
        inst.pos = [1.0, 0, 0];
        expect(diffSyncSlice(posDef(), codec, inst as never, node, 0, s, false)).toBe(true);

        // jitter after emit → silent
        inst.pos = [1.05, 0, 0];
        expect(diffSyncSlice(posDef(), codec, inst as never, node, 0, s, false)).toBe(false);
    });

    it('client emits the first-seen threshold value', () => {
        const inst = { pos: [3, 0, 0], bytes: new Uint8Array([0]) };
        const s = syncState();
        expect(diffSyncSlice(posDef(), codec, inst as never, node, 0, s, true)).toBe(true);
    });
});
