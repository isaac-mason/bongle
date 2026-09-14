// The shared atlas packer: aligned cells for the block atlas, padded cells for
// the sprite atlas, and a clean null on overflow so the caller can say so.

import { describe, expect, it } from 'vitest';
import { packAtlas } from '../../../../src/core/atlas/pack';

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('packAtlas', () => {
    it('keeps every block cell 16-aligned in origin and size, with no overlaps', () => {
        const items = [
            { w: 16, h: 16, padding: 0 },
            { w: 32, h: 32, padding: 0 },
            { w: 48, h: 16, padding: 0 },
            { w: 16, h: 64, padding: 0 },
            { w: 32, h: 16, padding: 0 },
        ];
        const packed = packAtlas(items, 16, 64, 4096);
        expect(packed).not.toBeNull();
        const { rects } = packed!;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i]!;
            expect(r.x % 16).toBe(0);
            expect(r.y % 16).toBe(0);
            expect([r.w, r.h]).toEqual([items[i]!.w, items[i]!.h]);
            for (let j = i + 1; j < rects.length; j++) expect(overlaps(r, rects[j]!)).toBe(false);
        }
    });

    it('returns rects in input order regardless of packing order', () => {
        const items = [
            { w: 16, h: 16, padding: 0 },
            { w: 64, h: 64, padding: 0 },
        ];
        const { rects } = packAtlas(items, 16, 128, 128)!;
        expect(rects[0]).toMatchObject({ w: 16, h: 16 });
        expect(rects[1]).toMatchObject({ w: 64, h: 64 });
    });

    it('reserves padding around a sprite and reports the interior', () => {
        const { rects } = packAtlas([{ w: 8, h: 8, padding: 2 }], 1, 16, 16)!;
        expect(rects[0]).toEqual({ x: 2, y: 2, w: 8, h: 8 });
    });

    it('grows the atlas until everything fits', () => {
        // five 16px tiles: 4 fit a 32px atlas, 5 need 64.
        const items = Array.from({ length: 5 }, () => ({ w: 16, h: 16, padding: 0 }));
        expect(packAtlas(items, 16, 16, 64)!.atlasSize).toBe(64);
    });

    it('returns null past the size cap', () => {
        const items = Array.from({ length: 17 }, () => ({ w: 16, h: 16, padding: 0 }));
        expect(packAtlas(items, 16, 16, 64)).toBeNull();
    });
});
