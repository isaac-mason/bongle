// sprite() declaration primitive, pure-data handle, module-scope api.
//
// shape mirrors `blockTexture()` (`core/voxels/blocks.ts`), not `model()`:
//   - no `_registerSpriteHandle` mutation path
//   - no codegen barrel (the bake's `GENERATED_BARRELS`
//     stays `['models', 'scenes', 'sounds']`, sprites are not added)
//   - declarations are pure source data; runtime wiring is a JSON
//     sidecar (`sprites-atlas.json`) emitted by the asset-pipeline pass
//     and fetched by `render/sprites/sprite-resources.ts` at room init
//
// `src` accepts an `ImageSource` (path/url, or a `DrawSource` bake-time
// fn descriptor) or an array of them (flipbook frames). URLs are
// normalized to `.href` strings at registration so downstream consumers
// (atlas hash, pipeline) only see one shape; nested `DrawSource`s pass
// through untouched. No per-frame `fps` or `interpolate` here, playback
// rate is the consumer's decision (`SpriteTrait`, `particle()` etc.).
//
// `DrawSource` / `ImageSource` / the `draw()` constructor live in
// `./draw.ts` and are re-exported below; both `sprite()` and
// `blockTexture()` consume them.

import { recordSprite } from '../capture/module-scope';
import { registry, upsert } from '../registry';
import type { ImageSource, NormalizedImageSource } from './draw';

/* ── source types re-exported for back-compat with existing import sites ── */

export type { DrawFn, DrawInputs, DrawParams, DrawSource, ImageSource, NormalizedImageSource } from './draw';
export { draw } from './draw';

/* ── public types ── */

export type SpriteOptions = {
    /** human-readable display name for editor UIs. falls back to the
     *  string id when omitted. purely cosmetic, IDs remain the lookup
     *  key everywhere else. */
    name?: string;

    /**
     * source image(s). single entry for static sprites, array for
     * flipbooks (one entry per frame, frames mixed freely between
     * paths/URLs and draw descriptors).
     *
     * URLs are normalized to `.href` at registration, same convention
     * as `blockTexture()`. The URL form lets 3rd-party packs ship sprite
     * pixels bundled alongside their modules (vite rewrites
     * `new URL(...)` in the client bundle; the asset pipeline resolves
     * `file://` URLs via `fileURLToPath` at bake time).
     */
    src: ImageSource | ImageSource[];

    /** gutter pixels in the atlas to avoid bleed at mip levels. default 1. */
    padding?: number;
    /** generate mips for this sprite. default true. set false for crisp
     *  pixel-art look (typical for particles). */
    mipmap?: boolean;
};

export type SpriteHandle = {
    /** sprite string id (e.g. 'sword'). */
    spriteId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `spriteId` when the author didn't supply one, so
     *  readers can show `handle.name` unconditionally. */
    name: string;
    /** DepGraph dependency. */
    dependency: { registry: 'sprites'; id: string };
    /** source declarations, post-URL-normalization. uv rects + sizes
     *  live in the atlas JSON sidecar, fetched at runtime. */
    src: NormalizedImageSource | NormalizedImageSource[];
    /** atlas padding (gutter pixels). */
    padding: number;
    /** mip generation flag. */
    mipmap: boolean;
};

/* ── registration ── */

/**
 * declare a sprite. called at module scope.
 *
 * single entry → static sprite; array → flipbook frames.
 *
 * returns a pure-data handle that the asset pipeline reads to pack the
 * sprite atlas and the runtime consults (by id) for uvRect + sizePx.
 *
 * @example
 * ```ts
 * const Sword = sprite('sword', { src: 'items/sword.png' });
 * const FlamingSword = sprite('flaming-sword', {
 *     src: ['items/flaming_0.png', 'items/flaming_1.png'],
 * });
 * ```
 */
export function sprite(id: string, options: SpriteOptions): SpriteHandle {
    const src: NormalizedImageSource | NormalizedImageSource[] = options.src;

    const handle: SpriteHandle = {
        spriteId: id,
        name: options.name ?? id,
        dependency: { registry: 'sprites', id },
        src,
        padding: options.padding ?? 1,
        mipmap: options.mipmap ?? true,
    };

    upsert(registry.sprites, id, handle);
    recordSprite(id);
    return handle;
}
