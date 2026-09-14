import { describe, expect, it } from 'vitest';
import { glyph, glyphMetrics, glyphSprites, glyphs } from '../../../src/kit/sprites';

describe('kit glyphs', () => {
    it('maps text to the glyph sprites, with ? for anything outside printable ASCII', () => {
        expect(glyphSprites).toHaveLength(95);
        expect(glyph('A').def.spriteId).toBe('kit:glyph:65');
        expect(glyph(' ').def.spriteId).toBe('kit:glyph:32');
        expect(glyph('~').def.spriteId).toBe('kit:glyph:126');
        expect(glyph('\n').def.spriteId).toBe('kit:glyph:63');
        expect(glyph('é').def.spriteId).toBe('kit:glyph:63');
        expect(glyphs('hi!').map((s) => s.def.spriteId)).toEqual(['kit:glyph:104', 'kit:glyph:105', 'kit:glyph:33']);
        expect(glyphs('')).toEqual([]);
        expect(glyphMetrics).toEqual({ width: 5, height: 7, advance: 6 });
    });
});
