import type { ScriptContext } from '../core/scene/scripts';
import type { SpriteHandle } from '../core/sprites/sprites';

export { sprite } from '../core/registry';
export type { ImageSource, SpriteHandle, SpriteOptions } from '../core/sprites/sprites';
export type { DrawFn, DrawInputs, DrawParams } from '../core/textures/draw-fn';

/** Default world units per source pixel. Matches `SpriteTrait`'s `worldScale` default. */
export const DEFAULT_PIXELS_PER_UNIT = 16;

/**
 * World-space `[width, height]` of a sprite, derived from its native pixel
 * dims (frame 0 for a flipbook) divided by `pixelsPerUnit`. Returns `null`
 * server-side, before the client has booted, or before the atlas has this sprite.
 */
export function spriteWorldSize(
    ctx: ScriptContext,
    sprite: SpriteHandle,
    opts?: { pixelsPerUnit?: number },
): [number, number] | null {
    const meta = ctx.client?.state?.resources?.spriteAtlas ?? null;
    const entry = meta?.sprites[sprite.def.spriteId];
    if (!entry) return null;
    const frame = entry.frames[0];
    if (!frame) return null;
    const pxPerUnit = opts?.pixelsPerUnit ?? DEFAULT_PIXELS_PER_UNIT;
    const inv = 1 / pxPerUnit;
    return [frame.w * inv, frame.h * inv];
}
