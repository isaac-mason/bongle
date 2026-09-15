import { describe, expect, it } from 'vitest';
import { LABEL_SCALE } from '../../../src/editor/visuals/node-card';
import * as Text from '../../../src/render/overlay/text';

/** the kit font is 5 by 7 with a one-pixel gap; only the ratio and those metrics matter to scaling. */
function batchAt(pixelRatio: number): Text.TextBatch {
    return {
        quads: { pixelRatio },
        glyphUv: new Float32Array(95 * 4),
        glyphWidth: 5,
        glyphHeight: 7,
        atlasHash: null,
    } as unknown as Text.TextBatch;
}

describe('overlay text scaling', () => {
    it('a whole-number scale is the same CSS size on every integer display ratio', () => {
        for (const pixelRatio of [1, 2, 3]) {
            expect(Text.height(batchAt(pixelRatio), 2)).toBe(14);
            expect(Text.measure(batchAt(pixelRatio), 'abc', 2)).toBe(34);
        }
    });

    it('the card label uses a whole-number scale, so it does not step between monitors', () => {
        expect(Number.isInteger(LABEL_SCALE)).toBe(true);
        expect(Text.height(batchAt(1), LABEL_SCALE)).toBe(Text.height(batchAt(2), LABEL_SCALE));
    });

    it('rounds a fractional scale onto whole device pixels, so glyph columns stay even', () => {
        // 1.5 lands on 3 device pixels per font pixel at 2x, but has to round up to 2 at 1x
        expect(Text.height(batchAt(2), 1.5)).toBe(10.5);
        expect(Text.height(batchAt(1), 1.5)).toBe(14);
    });

    it('never falls below one device pixel per font pixel', () => {
        expect(Text.height(batchAt(1), 0.1)).toBe(7);
    });
});
