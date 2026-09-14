import { describe, expect, it } from 'vitest';
import { GLYPH_COUNT, GLYPH_FALLBACK_INDEX, glyphIndex, glyphSpriteId } from '../../../src/render/text/glyph-font';
import { measure } from '../../../src/render/text/text-visuals';

const CELL = 5;

describe('glyph font', () => {
    it('maps codes to the kit sprite ids, falling back to ?', () => {
        expect(glyphSpriteId(glyphIndex('A'.charCodeAt(0)))).toBe('kit:glyph:65');
        expect(glyphSpriteId(glyphIndex(' '.charCodeAt(0)))).toBe('kit:glyph:32');
        expect(glyphSpriteId(0)).toBe('kit:glyph:32');
        expect(glyphSpriteId(GLYPH_COUNT - 1)).toBe('kit:glyph:126');
        expect(glyphIndex('\n'.charCodeAt(0))).toBe(GLYPH_FALLBACK_INDEX);
        expect(glyphIndex(0xe9)).toBe(GLYPH_FALLBACK_INDEX);
    });
});

describe('text layout', () => {
    it('measures a run as the cells plus the single-pixel gaps between them', () => {
        expect(measure('', CELL)).toEqual({ width: 0, lines: 1 });
        expect(measure('A', CELL)).toEqual({ width: 5, lines: 1 });
        expect(measure('AB', CELL)).toEqual({ width: 11, lines: 1 });
        expect(measure('ABC', CELL)).toEqual({ width: 17, lines: 1 });
    });

    it('takes the longest line and counts the lines a newline opens', () => {
        expect(measure('AB\nA', CELL)).toEqual({ width: 11, lines: 2 });
        expect(measure('A\nABC', CELL)).toEqual({ width: 17, lines: 2 });
        expect(measure('A\n\nA', CELL)).toEqual({ width: 5, lines: 3 });
        // a trailing newline opens a line that is empty, not one that does not exist
        expect(measure('A\n', CELL)).toEqual({ width: 5, lines: 2 });
    });

    it("reuses its scratch array, so a shorter string cannot read a longer one's tail", () => {
        expect(measure('A\nB\nC', CELL).lines).toBe(3);
        expect(measure('A', CELL)).toEqual({ width: 5, lines: 1 });
    });
});
