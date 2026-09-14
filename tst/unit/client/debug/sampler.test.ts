import { describe, expect, it } from 'vitest';

import { autorange, sampler, smoother } from '../../../../src/client/debug/monitors/sampler';

describe('sampler', () => {
    it('starts empty', () => {
        const s = sampler(3);
        expect(s.count).toBe(0);
        expect(s.last()).toBe(0);
        expect(s.min()).toBe(0);
        expect(s.max()).toBe(0);
        expect(s.avg()).toBe(0);
    });

    it('records samples in order', () => {
        const s = sampler(4);
        s.push(1);
        s.push(2);
        s.push(3);
        expect(s.count).toBe(3);
        expect(s.at(0)).toBe(1);
        expect(s.at(2)).toBe(3);
        expect(s.last()).toBe(3);
        expect(s.min()).toBe(1);
        expect(s.max()).toBe(3);
        expect(s.avg()).toBe(2);
    });

    it('wraps once full, keeping the last `size` in view', () => {
        const s = sampler(3);
        for (const v of [1, 2, 3, 4]) s.push(v);
        expect(s.count).toBe(3);
        expect(s.at(0)).toBe(2); // 1 fell off the front
        expect(s.at(2)).toBe(4);
        expect(s.last()).toBe(4);
        expect(s.min()).toBe(2);
        expect(s.max()).toBe(4);
    });

    it('clears', () => {
        const s = sampler(3);
        s.push(9);
        s.clear();
        expect(s.count).toBe(0);
        expect(s.last()).toBe(0);
    });
});

describe('autorange', () => {
    it('honors fixed min and max', () => {
        const s = sampler(3);
        s.push(5);
        expect(autorange([s], 0, 100)).toEqual([0, 100]);
    });

    it('autoscales to the samples in view', () => {
        const a = sampler(4);
        const b = sampler(4);
        for (const v of [1, 8]) a.push(v);
        for (const v of [3, 4]) b.push(v);
        expect(autorange([a, b])).toEqual([1, 8]);
    });

    it('returns a non-zero span for empty or flat data', () => {
        expect(autorange([sampler(2)])).toEqual([0, 1]);
        const flat = sampler(2);
        flat.push(5);
        flat.push(5);
        const [lo, hi] = autorange([flat]);
        expect(hi).toBeGreaterThan(lo);
    });
});

describe('smoother', () => {
    it('passes values through when smoothing is 0', () => {
        const f = smoother(0);
        expect(f(3)).toBe(3);
        expect(f(9)).toBe(9);
    });

    it('seeds with the first value, then blends', () => {
        const f = smoother(0.5);
        expect(f(10)).toBe(10); // first value seeds the average
        expect(f(20)).toBe(15); // 10*0.5 + 20*0.5
    });

    it('clamps the weight below 1 so it never freezes', () => {
        const f = smoother(5);
        f(0);
        expect(f(100)).toBeGreaterThan(0); // still moves toward the new value
    });
});
