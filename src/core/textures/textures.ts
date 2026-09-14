/**
 * core/textures/textures.ts, the texture kind: one picture, from disk or computed.
 *
 * A texture is the pixel SOURCE. It is named for what it is rather than what it is for,
 * because every texture ends up sampled — the consumers are named for their usage instead
 * (`tile()` for the 16x16 voxel atlas, `sprite()` for the sprite atlas). "A tile is made
 * of textures" and "a sprite is made of textures" both read the right way round.
 *
 * A texture is exactly ONE picture. Animation and flipbooks are the consumer's `frames`
 * array, which buys per-frame invalidation (editing frame 2 of an eight-frame animation
 * re-bakes frame 2) and lets frame 0 of an animated tile also back a sprite.
 *
 * Computed textures take other TEXTURES as inputs, by handle. That is what makes
 * composition pointer-native: the def stores `DepKey`s, so `deps` hands DepGraph the real
 * edges and a source edit propagates to everything derived from it. The predecessor
 * (`draw()`) had no identity at all, so it could own no edges, dedup nothing, and name
 * nothing in an error. It is gone; `texture()` replaced it.
 */

import type { DepKey } from '../capture/dep-graph';
import type { DrawFn, DrawInputs, DrawParams } from './draw-fn';

/** a texture from a file: a project-relative path or an `asset()` href. */
export type TextureFileOptions = {
    src: string;
};

/** a texture computed at bake time from other textures. */
export type TextureComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams> = {
    /** output canvas dims in pixels. */
    size: [number, number];
    /** other textures this one is drawn from, keyed by the name `fn` destructures. */
    inputs?: I;
    /** scalar tweak knobs. Hashed, so a change here invalidates; a value the `fn` closes
     *  over instead of taking through here is INVISIBLE to change detection. */
    params?: P;
    /** drawn at bake time. Sync, and pure with respect to its three arguments. */
    fn: DrawFn<DrawInputs, P>;
};

export type TextureOptions<
    I extends Record<string, TextureHandle> = Record<string, TextureHandle>,
    P extends DrawParams = DrawParams,
> = TextureFileOptions | TextureComputedOptions<I, P>;

/**
 * The declared data for one texture. Pure: hashed wholesale, swapped wholesale on
 * re-declaration. `inputs` holds `DepKey`s rather than live handles so the def stays plain
 * data — the bake resolves them through the store, which is safe because by bake time
 * every declaration has run.
 */
export type TextureDef =
    | { id: string; from: 'file'; src: string }
    | {
          id: string;
          from: 'computed';
          size: [number, number];
          inputs: Record<string, DepKey>;
          params: DrawParams;
          fn: DrawFn<DrawInputs, DrawParams>;
      };

/** Stable wrapper around a `TextureDef`; the data is read through `.def`, which is
 *  re-pointed on every re-declaration (see `declare`). */
export type TextureHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    readonly dependency: DepKey;
    /** the declared data. re-pointed on every re-declaration. */
    def: TextureDef;
};

/** true when the options describe a computed texture rather than a file one. */
export function isComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams>(
    options: TextureOptions<I, P>,
): options is TextureComputedOptions<I, P> {
    return 'fn' in options;
}

/** the texture ids a computed texture draws from, for `deps`. A file texture has none. */
export function textureInputDeps(def: TextureDef): DepKey[] {
    if (def.from === 'file') return [];
    return Object.values(def.inputs);
}
