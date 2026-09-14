// sprite() declaration primitive, pure-data handle, module-scope api.
//
// shape mirrors `tile()` (`core/voxels/blocks.ts`), not `model()`:
//   - no `_registerSpriteHandle` mutation path
//   - no codegen barrel (the bake's `GENERATED_BARRELS`
//     stays `['models', 'scenes', 'sounds']`, sprites are not added)
//   - declarations are pure source data; runtime wiring is a JSON
//     sidecar (`sprites-atlas.json`) emitted by the asset-pipeline pass
//     and fetched by `render/sprites/sprite-resources.ts` at room init
//
// A sprite holds `frames: DepKey[]` pointing at TEXTURES. `src` is sugar that
// declares one texture per frame; `frames` takes texture handles directly.
// URLs are normalized to `.href` strings at registration so downstream
// consumers (atlas hash, pipeline) only see one shape. No per-frame `fps` or
// `interpolate` here, playback rate is the consumer's decision (`SpriteTrait`,
// `particle()` etc.).

import type { AssetMeta } from '../asset-meta';
import type { DepKey } from '../capture/dep-graph';
import type { TextureHandle } from '../textures/textures';

/** one image source: a project-relative path or an `asset()` href. Composition is no
 *  longer expressible here — a composed image is a computed `texture()`, which has an id,
 *  a hash and real dep edges. */
export type ImageSource = string;

/* ── public types ── */

export type SpriteOptions = AssetMeta & {
    /**
     * source image(s). single entry for static sprites, array for
     * flipbooks (one entry per frame). Sugar: each entry declares a texture.
     *
     * URLs are normalized to `.href` at registration, same convention
     * as `tile()`. The URL form lets 3rd-party packs ship sprite
     * pixels bundled alongside their modules (vite rewrites
     * `new URL(...)` in the client bundle; the asset pipeline resolves
     * `file://` URLs via `fileURLToPath` at bake time).
     */
    src?: ImageSource | ImageSource[];

    /** the textures this sprite's frames come from. The direct form; `src` is sugar
     *  that declares textures for you. */
    frames?: TextureHandle[];

    /** gutter pixels in the atlas to avoid bleed at mip levels. default 1. */
    padding?: number;
    /** generate mips for this sprite. default true. set false for crisp
     *  pixel-art look (typical for particles). */
    mipmap?: boolean;
};

/** The declared data for one sprite. Pure: hashed wholesale for change detection,
 *  swapped wholesale on re-declaration (see `declare`). */
export type SpriteDef = {
    /** sprite string id (e.g. 'sword'). */
    spriteId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `spriteId` when the author didn't supply one, so
     *  readers can show `def.name` unconditionally. */
    name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    tags: readonly string[];
    /** the textures this sprite's frames come from, in order. References, not
     *  sources: the pixels belong to the texture kind. uv rects + sizes live in
     *  the atlas JSON sidecar, fetched at runtime. */
    frames: DepKey[];
    /** atlas padding (gutter pixels). */
    padding: number;
    /** mip generation flag. */
    mipmap: boolean;
};

/** Stable wrapper around a `SpriteDef`; identity plus the live def. */
export type SpriteHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'sprites'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: SpriteDef;
};

/* ── registration ── */
