/** the kit bakes one sprite per printable ASCII character; both the world text batch and the editor overlay cut runs from these. */

export const GLYPH_FIRST_CODE = 0x20;

export const GLYPH_COUNT = 95;

/** unprintable characters draw as `?`. */
export const GLYPH_FALLBACK_INDEX = 0x3f - GLYPH_FIRST_CODE;

/** the glyph table index for a character code. */
export function glyphIndex(code: number): number {
    const index = code - GLYPH_FIRST_CODE;
    return index >= 0 && index < GLYPH_COUNT ? index : GLYPH_FALLBACK_INDEX;
}

export function glyphSpriteId(index: number): string {
    return `kit:glyph:${GLYPH_FIRST_CODE + index}`;
}
