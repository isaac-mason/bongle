// The bake-time draw function a computed `texture()` supplies, and its param types.
//
// Contract on `fn`:
//   - Sync. The bake pass runs `fn(ctx, inputs, params)` synchronously after awaiting
//     input texture loads, no async/await inside the fn.
//   - Pure w.r.t. its three args. Captured mutable state is INVISIBLE to `structuralHash`
//     (only `fn.toString()` participates), so depending on a captured `let` silently
//     misses invalidation. Pass it through `params` instead.
//   - Standard 2D context. The bake substrate is `skia-canvas` in Node; the engine never
//     imports skia types, so input images type-erase to the DOM `CanvasImageSource`
//     (skia `Image` / `Canvas` are structurally compatible).
//
// Why generics: typing `texture(id, { inputs: I, params: P, fn })` lets the user fn
// destructure `inputs.tex` and `params.seed` with proper types. `TextureDef` erases to
// the non-generic shape so registry storage stays uniform.

/** scalar param values, string / number / boolean only. JSON-serializes cleanly into the
 *  registry `structuralHash` and covers the seed + tweak knobs use case. Widen later
 *  (arrays, nested) only when a real consumer demands it. */
export type DrawParams = Record<string, string | number | boolean>;

/** the shape `DrawFn` keys its resolved input images by. The values are erased: only the
 *  KEYS matter here, since the bake resolves each to a `CanvasImageSource`. */
export type DrawInputs = Record<string, unknown>;

/** generic over the inputs/params maps so the user fn args are typed. At runtime the bake
 *  resolves each input to a `CanvasImageSource` (skia `Image` for file textures, skia
 *  `Canvas` for computed ones, both structurally compatible with the DOM type). */
export type DrawFn<I extends DrawInputs, P extends DrawParams> = (
    ctx: CanvasRenderingContext2D,
    inputs: { [K in keyof I]: CanvasImageSource },
    params: P,
) => void;
