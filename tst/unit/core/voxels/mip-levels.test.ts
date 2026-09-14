// ── mip levels: the chain's three rules, and the rect copies ────────

import { describe, expect, it } from 'vitest';
import { ALPHA_REF, BPP, blitRect, buildMipLevels, coverageOf, sliceRect } from '../../../../src/core/voxels/mip-levels';

const RED: [number, number, number] = [200, 40, 30];

/** one 16x16 layer, filled by a predicate over (x, y). */
function tile(size: number, opaqueAt: (x: number, y: number) => boolean, rgb = RED): Uint8Array {
    const data = new Uint8Array(size * size * BPP);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const o = (y * size + x) * BPP;
            const on = opaqueAt(x, y);
            // transparent texels carry deliberately awful RGB (pure black) so any
            // filter that lets them leak into the average shows up as darkening.
            data[o] = on ? rgb[0] : 0;
            data[o + 1] = on ? rgb[1] : 0;
            data[o + 2] = on ? rgb[2] : 0;
            data[o + 3] = on ? 255 : 0;
        }
    }
    return data;
}

const texel = (data: Uint8Array, size: number, x: number, y: number) => {
    const o = (y * size + x) * BPP;
    return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!] as const;
};

describe('buildMipLevels', () => {
    it('produces one level per halving down to 1x1', () => {
        const levels = buildMipLevels(
            tile(16, () => true),
            1,
            16,
            16,
            4,
            () => true,
        );
        expect(levels.map((l) => l.width)).toEqual([8, 4, 2, 1]);
    });

    it('does not darken a partly covered texel: transparent black never leaks into colour', () => {
        // texel checkerboard: every 2x2 footprint is half red, half transparent black.
        // a naive box filter averages the black in and halves the red.
        const base = tile(16, (x, y) => (x + y) % 2 === 0);
        const [level1] = buildMipLevels(base, 1, 16, 16, 4, () => true);
        const [r, g, b] = texel(level1!.data, 8, 3, 5);
        expect([r, g, b]).toEqual(RED);
    });

    it('averages alpha as coverage on a non-cutout layer', () => {
        const base = tile(16, (x, y) => (x + y) % 2 === 0);
        const [level1] = buildMipLevels(base, 1, 16, 16, 4, () => false);
        const a = texel(level1!.data, 8, 0, 0)[3];
        expect(Math.abs(a - 128)).toBeLessThanOrEqual(1);
    });

    it('restores coverage on a cutout layer that a plain average would erode away', () => {
        // one opaque texel per 2x2: a plain average gives alpha 64 everywhere, so
        // every level-1 texel fails the cutoff and the tile vanishes at distance.
        const base = tile(16, (x, y) => x % 2 === 0 && y % 2 === 0);
        const baseCoverage = coverageOf(base, 0, 256, 1);
        expect(baseCoverage).toBeCloseTo(0.25, 5);

        const [naive] = buildMipLevels(base, 1, 16, 16, 4, () => false);
        expect(coverageOf(naive!.data, 0, 64, 1)).toBe(0);

        const [preserved] = buildMipLevels(base, 1, 16, 16, 4, () => true);
        expect(coverageOf(preserved!.data, 0, 64, 1)).toBeGreaterThanOrEqual(baseCoverage);
    });

    it('leaves a fully opaque cutout layer at 255, never parked on the threshold', () => {
        // the documented bug: a [0, 4] search converged on ALPHA_REF for an opaque
        // tile and halved every alpha to sit exactly on the discard line.
        const [l1, l2, l3, l4] = buildMipLevels(
            tile(16, () => true),
            1,
            16,
            16,
            4,
            () => true,
        );
        for (const level of [l1!, l2!, l3!, l4!]) {
            for (let i = 3; i < level.data.length; i += BPP) expect(level.data[i]).toBe(255);
        }
    });

    it('never scales alpha DOWN, only up, so coverage preservation cannot erode', () => {
        const base = tile(16, (x) => x < 12); // 75% coverage, clean vertical edge
        const [level1] = buildMipLevels(base, 1, 16, 16, 4, () => true);
        for (let i = 3; i < level1!.data.length; i += BPP) {
            const a = level1!.data[i]! / 255;
            expect(a === 0 || a >= ALPHA_REF || a === 0.5).toBe(true);
        }
        expect(coverageOf(level1!.data, 0, 64, 1)).toBeGreaterThanOrEqual(0.75);
    });

    it('handles layers independently', () => {
        const opaque = tile(16, () => true);
        const sparse = tile(16, (x, y) => x % 2 === 0 && y % 2 === 0);
        const base = new Uint8Array(opaque.length * 2);
        base.set(opaque, 0);
        base.set(sparse, opaque.length);
        const [level1] = buildMipLevels(base, 2, 16, 16, 4, () => true);
        expect(texel(level1!.data, 8, 0, 0)[3]).toBe(255);
        expect(coverageOf(level1!.data, 1, 64, 1)).toBeGreaterThanOrEqual(0.25);
    });
});

describe('buildMipLevels on a rectangular tile', () => {
    it('halves each axis independently and floors at one texel', () => {
        const base = new Uint8Array(32 * 16 * BPP).fill(255);
        const levels = buildMipLevels(base, 1, 32, 16, 4, () => false);
        expect(levels.map((l) => [l.width, l.height])).toEqual([
            [16, 8],
            [8, 4],
            [4, 2],
            [2, 1],
        ]);
        for (const level of levels) expect(level.data.length).toBe(level.width * level.height * BPP);
    });
});

describe('sliceRect / blitRect', () => {
    it('round-trips a rect through a tight buffer and back, byte for byte', () => {
        const atlasW = 12;
        const atlas = new Uint8Array(atlasW * 8 * BPP);
        for (let i = 0; i < atlas.length; i++) atlas[i] = (i * 31) & 0xff;

        const tight = sliceRect(atlas, atlasW, 4, 2, 6, 4);
        expect(tight.length).toBe(6 * 4 * BPP);
        expect(texel(tight, 6, 0, 0)).toEqual(texel(atlas, atlasW, 4, 2));
        expect(texel(tight, 6, 5, 3)).toEqual(texel(atlas, atlasW, 9, 5));

        const out = new Uint8Array(atlas.length);
        blitRect(out, atlasW, 4, 2, tight, 6, 4);
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < atlasW; x++) {
                const inside = x >= 4 && x < 10 && y >= 2 && y < 6;
                expect(texel(out, atlasW, x, y)).toEqual(inside ? texel(atlas, atlasW, x, y) : [0, 0, 0, 0]);
            }
        }
    });
});
