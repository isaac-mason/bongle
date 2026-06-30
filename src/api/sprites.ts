/**
 * Script-facing sprite API.
 *
 * Module-scope `sprite()` declaration primitive + source-type re-exports
 * + a small set of ctx-taking free fns for advanced consumers (custom
 * materials, body-size-from-sprite). Mirrors `api/audio.ts`'s shape,
 * server-safe shims that gate on `ctx.client?.state?.spriteResources`
 * and return `null` when the resource isn't up (server side, or before
 * the client has finished `load()`).
 *
 * Per `feedback_no_speculative_precompute`: `sampleSprite()` +
 * `spriteWhiteUv()` are the shader-node fragment surface and depend on
 * the GPU frame-LUT buffer + reserved white-pixel UV, neither has a
 * concrete consumer until step 7's `ExtrudedSpriteTrait` material wants
 * to read pixels through the LUT. Those land in step 7 alongside their
 * first caller.
 */

import type { Texture } from 'gpucat';
import type { ScriptContext } from '../core/scene/scripts';
import type { SpriteHandle } from '../core/sprites/sprites';

export type {
    DrawFn,
    DrawInputs,
    DrawParams,
    DrawSource,
    ImageSource,
    NormalizedImageSource,
    SpriteHandle,
    SpriteOptions,
} from '../core/sprites/sprites';
export { draw, sprite } from '../core/sprites/sprites';

/**
 * Default world units per source pixel. Matches `SpriteTrait`'s
 * `worldScale` default and Minecraft's 1px = 1/16 block convention.
 * Pulled out as a named constant so the open question (plan §"Open
 * questions" #1: global pixels-per-unit) has a single sticky value to
 * revisit when it's settled.
 */
export const DEFAULT_PIXELS_PER_UNIT = 16;

/**
 * Resolve the engine-global sprite atlas `Texture`, escape hatch for
 * advanced scripts that want to write a custom material sampling the
 * atlas directly. Returns `null` server-side or before the client has
 * finished `load()`. Prefer `sampleSprite()` (step 7) over raw atlas
 * access where possible, atlas-layout shifts on every registry change,
 * but `sampleSprite()`'s LUT indirection absorbs them.
 */
export function spriteAtlasTexture(ctx: ScriptContext): Texture | null {
    const res = ctx.client?.state?.spriteResources;
    if (!res) return null;
    return res.atlas;
}

/**
 * World-space `[width, height]` of a sprite, derived from its native
 * pixel dims (frame 0 if the sprite is a flipbook) divided by
 * `pixelsPerUnit` (defaults to `DEFAULT_PIXELS_PER_UNIT`). Returns
 * `null` server-side, before the client has booted, or before the
 * asset pipeline has emitted this sprite into the atlas.
 *
 * Convenience for keeping an `AabbBody` size in sync with the visual,
 * body owns its own size concern per "own table for sub-concepts",
 * this helper just removes the manual arithmetic at the call site.
 */
export function spriteWorldSize(
    ctx: ScriptContext,
    sprite: SpriteHandle,
    opts?: { pixelsPerUnit?: number },
): [number, number] | null {
    const res = ctx.client?.state?.spriteResources;
    if (!res?.metadata) return null;
    const entry = res.metadata.sprites[sprite.spriteId];
    if (!entry) return null;
    const frame = entry.frames[0];
    if (!frame) return null;
    const pxPerUnit = opts?.pixelsPerUnit ?? DEFAULT_PIXELS_PER_UNIT;
    const inv = 1 / pxPerUnit;
    return [frame.w * inv, frame.h * inv];
}
