import { describe, expect, it } from 'vitest';
import { AXIS_NONE, AXIS_X, AXIS_Y, AXIS_Z, sweepAabbVsAabb, sweptBounds } from './aabb-sweep';

// helper: unit cube character (half-extents 0.5) at given center.
function sweepUnit(
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    box: [number, number, number, number, number, number],
) {
    return sweepAabbVsAabb(cx, cy, cz, 0.5, 0.5, 0.5, dx, dy, dz, box[0], box[1], box[2], box[3], box[4], box[5], {
        toi: 0,
        axis: 0,
        sign: 0,
        nX: 0,
        nY: 0,
        nZ: 0,
        overlapDepth: 0,
    });
}

describe('sweepAabbVsAabb', () => {
    it('no displacement, no overlap → no hit', () => {
        const r = sweepUnit(0, 0, 0, 0, 0, 0, [10, 10, 10, 11, 11, 11]);
        expect(r.axis).toBe(AXIS_NONE);
        expect(r.toi).toBe(Infinity);
    });

    it('moves into wall on +X, hits at the right toi', () => {
        // character at x=0 (extent 0.5), wall starting at x=2 (so face at 2)
        // toi = (1.5) / 5 = 0.3 — distance from char +X face (0.5) to wall face (2) is 1.5
        const r = sweepUnit(0, 0, 0, 5, 0, 0, [2, -10, -10, 3, 10, 10]);
        expect(r.axis).toBe(AXIS_X);
        expect(r.sign).toBe(-1);
        expect(r.toi).toBeCloseTo(1.5 / 5, 6);
    });

    it('moves into wall on -X', () => {
        const r = sweepUnit(0, 0, 0, -5, 0, 0, [-3, -10, -10, -2, 10, 10]);
        expect(r.axis).toBe(AXIS_X);
        expect(r.sign).toBe(1);
        expect(r.toi).toBeCloseTo(1.5 / 5, 6);
    });

    it('falls onto floor', () => {
        // character bottom at y=0.5, floor top at y=-2 (so distance 2.5), velocity -5
        const r = sweepUnit(0, 3, 0, 0, -5, 0, [-1, -3, -1, 1, -2, 1]);
        expect(r.axis).toBe(AXIS_Y);
        expect(r.sign).toBe(1);
        // 3 - 0.5 - (-2) = 4.5 separation? actually:
        // char center at y=3 with half-extent 0.5 → bottom y=2.5
        // floor top at y=-2 → distance = 2.5 - (-2) = 4.5; toi = 4.5 / 5 = 0.9
        expect(r.toi).toBeCloseTo(0.9, 6);
    });

    it('horizontal move misses a box that is above', () => {
        // walking forward in +X but the wall is high up — Y slab never overlaps.
        const r = sweepUnit(0, 0, 0, 5, 0, 0, [2, 100, -10, 3, 101, 10]);
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('grazing along Y plane (coplanar, perp motion) does not collide', () => {
        // character standing on top of a slab (slab top at y=0, character bottom at y=0).
        // moving sideways. should NOT register a hit because Y is at slab boundary, exclusive.
        const r = sweepUnit(0, 0.5, 0, 1, 0, 0, [2, -1, -10, 3, 0, 10]);
        // when char center y=0.5 with half extent 0.5 → bottom at 0; slab top is 0 → strict inequality fails
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('flush with floor moving up → no hit (jump regression)', () => {
        // character bottom flush with slab top: char center y=0.5 (extent 0.5
        // → bottom at 0), slab top at y=0. moving up at +Y must NOT report a
        // contact — without this, the slide kills the upward jump velocity.
        const r = sweepUnit(0, 0.5, 0, 0, 1, 0, [-10, -1, -10, 10, 0, 10]);
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('flush against +X face moving away (-X) → no hit', () => {
        // touching wall on +X side, then pulling back. must not register.
        // wall x=[1..2]. char center x=0.5 (extent 0.5 → +X face at 1, touching).
        const r = sweepUnit(0.5, 0, 0, -1, 0, 0, [1, -10, -10, 2, 10, 10]);
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('zero motion + overlapping → no hit', () => {
        // mirrors Minetest's per-axis `if (speed.X) {}` skip: with no motion,
        // no axis can be the colliding axis. depenetration only applies when
        // the character is actively moving into a face; a stationary overlap
        // is left for the next frame's velocity-driven solve to resolve.
        const r = sweepUnit(0, 0, 0, 0, 0, 0, [0.4, -10, -10, 1, 10, 10]);
        expect(r.axis).toBe(AXIS_NONE);
        expect(r.toi).toBe(Infinity);
    });

    it('overlapping with motion into wall → negative TOI depenetration', () => {
        // char at x=0 (extent 0.5 → +X face at 0.5) overlapping wall x=[0.4..1]
        // by 0.1 on the +X axis. moving further into the wall at +X. the new
        // model emits tEnter < 0 with axis=X, sign=-1 — caller applies
        // `pos += disp * tEnter` for backward depenetration onto the face.
        const r = sweepUnit(0, 0, 0, 0.1, 0, 0, [0.4, -10, -10, 1, 10, 10]);
        expect(r.axis).toBe(AXIS_X);
        expect(r.sign).toBe(-1);
        expect(r.toi).toBeLessThan(0);
        // disp 0.1, penetration 0.1 → tEnter = -0.1 / 0.1 = -1; check the math.
        expect(r.toi).toBeCloseTo(-1, 6);
    });

    it('overlapping past inner-margin midline → no hit', () => {
        // char center x=0.6 (extent 0.5 → +X face at 1.1) and the wall is
        // x=[0.4..1]. char center is past the wall's mid-line (0.7) — moving
        // +X would depenetrate to the wrong side. inner-margin gate rejects.
        const r = sweepUnit(0.85, 0, 0, 0.1, 0, 0, [0.4, -10, -10, 1, 10, 10]);
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('exit fraction past 1 is no hit', () => {
        // moving in +X with very small displacement, wall far away.
        const r = sweepUnit(0, 0, 0, 0.1, 0, 0, [10, -10, -10, 11, 10, 10]);
        expect(r.axis).toBe(AXIS_NONE);
    });

    it('hits Y first when both X and Y could collide (corner case)', () => {
        // moving diagonally toward a box; whichever axis enters last is the hit axis
        // box at [1..2, 1..2, -1..1]. character extent 0.5 at origin, displace (5, 5, 0).
        // X enters at (1 - 0.5)/5 = 0.1; Y enters at (1 - 0.5)/5 = 0.1 — tie. axis defaults to X (first).
        // shift slightly so Y enters later.
        const r = sweepUnit(0, 0, 0, 5, 4, 0, [1, 1, -1, 2, 2, 1]);
        // X enter: 0.5 / 5 = 0.1; Y enter: 0.5 / 4 = 0.125 → Y is later → axis=Y
        expect(r.axis).toBe(AXIS_Y);
        expect(r.toi).toBeCloseTo(0.125, 6);
    });

    it('zero displacement on one axis with separation on that axis → no hit', () => {
        // dy=0 and char y is below the box — never enters Y slab.
        const r = sweepUnit(0, -10, 0, 1, 0, 1, [1, 5, 1, 2, 6, 2]);
        expect(r.axis).toBe(AXIS_NONE);
    });
});

describe('sweptBounds', () => {
    it('expands forward direction', () => {
        const out = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        sweptBounds(0, 0, 0, 0.5, 0.5, 0.5, 2, 0, 0, out);
        expect(out.minX).toBe(-0.5);
        expect(out.maxX).toBe(2.5);
        expect(out.minY).toBe(-0.5);
        expect(out.maxY).toBe(0.5);
    });

    it('expands backward direction', () => {
        const out = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        sweptBounds(0, 0, 0, 0.5, 0.5, 0.5, -2, 0, 0, out);
        expect(out.minX).toBe(-2.5);
        expect(out.maxX).toBe(0.5);
    });

    it('combines all three axes', () => {
        const out = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        sweptBounds(0, 0, 0, 0.5, 0.5, 0.5, 1, -2, 3, out);
        expect(out.minX).toBe(-0.5);
        expect(out.maxX).toBe(1.5);
        expect(out.minY).toBe(-2.5);
        expect(out.maxY).toBe(0.5);
        expect(out.minZ).toBe(-0.5);
        expect(out.maxZ).toBe(3.5);
    });
});

describe('AXIS constants', () => {
    it('have stable values', () => {
        expect(AXIS_X).toBe(0);
        expect(AXIS_Y).toBe(1);
        expect(AXIS_Z).toBe(2);
        expect(AXIS_NONE).toBe(-1);
    });
});
