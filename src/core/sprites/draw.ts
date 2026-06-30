// draw(), bake-time texture-source descriptor constructor.
//
// The only escape hatch above "load a file" in the sprite + blockTexture
// `src` surface. Callers compose ImageSources recursively (path strings
// or other `draw()` descriptors) and supply a user fn that draws into a
// standard `CanvasRenderingContext2D` at bake time.
//
// Plain-data descriptor: `draw()` returns `{ _kind, fn, size, inputs,
// params }` and never executes `fn`. The asset-pipeline pass (step 10:
// `lib/kit/src/asset-pipeline/draw-textures.ts`) walks both registries,
// depth-first-bakes nested draws, and hands the resulting canvases to
// the atlas builders. Invalidation rides the existing payload-hash
// machinery, `structuralHash` walks fn bodies via
// `Function.prototype.toString()`, so any edit anywhere in the tree
// bumps the outer registry's revision automatically.
//
// Contract on `fn`:
//   - Sync. The bake pass runs `fn(ctx, inputs, params)` synchronously
//     after awaiting input image loads, no async/await inside the fn.
//   - Pure w.r.t. its three args. Captured mutable state is ignored by
//     `structuralHash` (only `fn.toString()` participates), so depending
//     on a captured `let` silently misses invalidation.
//   - Standard 2D context. The bake substrate is `skia-canvas` in Node;
//     the engine never imports skia types, input images type-erase to
//     the DOM `CanvasImageSource` (skia `Image` / `Canvas` are
//     structurally compatible).
//
// Why generics: typing `draw<I, P>(fn, { inputs: I, params: P })` lets
// the user fn destructure `inputs.tex` and `params.seed` with proper
// types. The stored `DrawSource` erases to the non-generic shape so
// registry storage stays uniform.

/** scalar param values, string / number / boolean only. JSON-serializes
 *  cleanly into the registry `structuralHash` and covers the seed +
 *  tweak knobs use case. Widen later (arrays, nested) only when a real
 *  consumer demands it. */
export type DrawParams = Record<string, string | number | boolean>;

/** input map, each entry is itself an ImageSource (path string or a
 *  nested DrawSource). Recursive composition, no handle indirection. */
export type DrawInputs = Record<string, ImageSource>;

/** generic over the inputs/params maps so the user fn args are typed.
 *  At runtime the bake pass resolves each input to a `CanvasImageSource`
 *  (skia `Image` for paths, skia `Canvas` for nested draws, both
 *  structurally compatible with the DOM type). */
export type DrawFn<I extends DrawInputs, P extends DrawParams> = (
    ctx: CanvasRenderingContext2D,
    inputs: { [K in keyof I]: CanvasImageSource },
    params: P,
) => void;

/** bake-time descriptor. carries the `_kind: 'draw'` brand so the
 *  `ImageSource` union discriminates against plain path strings. */
export type DrawSource = {
    _kind: 'draw';
    /** user fn, generics erased at the descriptor boundary so storage
     *  stays uniform. fn args inside the closure remain typed via the
     *  `draw()` constructor's generics. */
    fn: DrawFn<DrawInputs, DrawParams>;
    /** output canvas dims in pixels. */
    size: [number, number];
    /** input map, keys are local names the fn destructures. */
    inputs: DrawInputs;
    /** scalar tweak knobs. */
    params: DrawParams;
};

/** one image: path string, URL (normalized to `.href` at registration),
 *  or a bake-time `DrawSource`. Used as the source type for both
 *  `sprite()` (frames) and `blockTexture()` (frames). Arrays of
 *  `ImageSource` only appear at the top-level `src` field (flipbook). */
export type ImageSource = string | URL | DrawSource;

/** post-normalization form, URLs collapsed to `.href` strings.
 *  Downstream consumers (atlas builder, hashing) only see this shape. */
export type NormalizedImageSource = string | DrawSource;

/**
 * Construct a bake-time draw descriptor. Pure data, `fn` is not
 * executed until the asset-pipeline `draw-textures` pass walks the
 * registry.
 *
 * @example
 * ```ts
 * const GrassDust = sprite('grass-dust', {
 *     src: draw(
 *         (ctx, { tex }, { seed }) => {
 *             const r = mulberry32(seed);
 *             const sx = Math.floor(r() * 12);
 *             const sy = Math.floor(r() * 12);
 *             ctx.drawImage(tex, sx, sy, 4, 4, 0, 0, 4, 4);
 *         },
 *         { size: [4, 4], inputs: { tex: 'blocks/grass_top.png' }, params: { seed: 1337 } },
 *     ),
 * });
 * ```
 */
export function draw<I extends DrawInputs = DrawInputs, P extends DrawParams = DrawParams>(
    fn: DrawFn<I, P>,
    opts: { size: [number, number]; inputs?: I; params?: P },
): DrawSource {
    return {
        _kind: 'draw',
        fn: fn as DrawFn<DrawInputs, DrawParams>,
        size: opts.size,
        inputs: (opts.inputs ?? {}) as DrawInputs,
        params: (opts.params ?? {}) as DrawParams,
    };
}

/** collapse URLs to `.href` strings; pass paths + DrawSources through. */
export function normalizeImageSource(s: ImageSource): NormalizedImageSource {
    return s instanceof URL ? s.href : s;
}
