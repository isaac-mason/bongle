import type { SpriteResources } from '../sprites/sprite-resources';
import { GLYPH_COUNT, glyphIndex, glyphSpriteId } from '../text/glyph-font';
import * as Quads from './quads';

export type TextBatch = {
    quads: Quads.QuadBatch;
    /** per glyph index: atlas u0 v0 u1 v1, from the `kit:glyph:<code>` sprites. */
    glyphUv: Float32Array;
    glyphWidth: number;
    glyphHeight: number;
    atlasHash: string | null;
};

export function init(quads: Quads.QuadBatch): TextBatch {
    return { quads, glyphUv: new Float32Array(GLYPH_COUNT * 4), glyphWidth: 5, glyphHeight: 7, atlasHash: null };
}

/** reads the glyph rects out of the sprite atlas when it (re)loads. */
export function bind(batch: TextBatch, sprite: SpriteResources): void {
    if (batch.atlasHash === sprite.atlasHash) return;
    batch.atlasHash = sprite.atlasHash;
    const atlasSize = sprite.metadata?.atlasSize ?? 0;
    for (let i = 0; i < GLYPH_COUNT; i++) {
        const frame = sprite.frames.get(glyphSpriteId(i))?.frames[0];
        const u = i * 4;
        if (!frame) {
            batch.glyphUv[u] = batch.glyphUv[u + 1] = batch.glyphUv[u + 2] = batch.glyphUv[u + 3] = 0;
            continue;
        }
        batch.glyphUv[u] = frame.u;
        batch.glyphUv[u + 1] = frame.v;
        batch.glyphUv[u + 2] = frame.u + frame.w;
        batch.glyphUv[u + 3] = frame.v + frame.h;
        batch.glyphWidth = Math.round(frame.w * atlasSize);
        batch.glyphHeight = Math.round(frame.h * atlasSize);
    }
}

function advance(batch: TextBatch): number {
    return batch.glyphWidth + 1;
}

export function measure(batch: TextBatch, text: string, scale: number): number {
    return text.length === 0 ? 0 : (text.length * advance(batch) - 1) * scale;
}

/** left edge `dxPx` pixels right of a world point, vertically centred `dyPx` above it. */
export function labelLeft(
    batch: TextBatch,
    x: number,
    y: number,
    z: number,
    text: string,
    scale: number,
    dxPx: number,
    dyPx: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const hw = (batch.glyphWidth * scale) / 2;
    run(batch, x, y, z, text, scale, dxPx + hw, dyPx, r, g, b, a);
}

/** centred on a world point, `dyPx` pixels above it. */
export function label(
    batch: TextBatch,
    x: number,
    y: number,
    z: number,
    text: string,
    scale: number,
    dyPx: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const hw = (batch.glyphWidth * scale) / 2;
    run(batch, x, y, z, text, scale, -measure(batch, text, scale) / 2 + hw, dyPx, r, g, b, a);
}

// glyphs from the first glyph's centre at `dx`, advancing right.
function run(
    batch: TextBatch,
    x: number,
    y: number,
    z: number,
    text: string,
    scale: number,
    startDx: number,
    dyPx: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const { quads, glyphUv } = batch;
    const hw = (batch.glyphWidth * scale) / 2;
    const hh = (batch.glyphHeight * scale) / 2;
    let dx = startDx;
    for (let i = 0; i < text.length; i++) {
        const u = glyphIndex(text.charCodeAt(i)) * 4;
        Quads.quad(quads, x, y, z, dx, dyPx, hw, hh, glyphUv[u]!, glyphUv[u + 1]!, glyphUv[u + 2]!, glyphUv[u + 3]!, r, g, b, a);
        dx += advance(batch) * scale;
    }
}
