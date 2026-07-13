// bakes `DrawSource` descriptors to in-memory OffscreenCanvases before the
// atlas builders run. Walks both registries (block textures + sprites),
// depth-first resolves each draw's inputs (image refs via the loader +
// createImageBitmap, nested DrawSources by recursion), invokes the user fn
// against a fresh canvas, and memoizes results by the descriptor's referential
// identity. No disk cache — the registry payload hash already invalidates
// downstream atlases when any fn body or input ref changes.
//
// Cycle detection: nested DrawSources can ref each other through user closure
// capture. A per-bake `Set` tracks in-flight descriptors; re-entry throws with
// the cycle root so the user sees the bad ref instead of a hung pipeline.
//
// Output type `BakedDraws = Map<DrawSource, OffscreenCanvas>` is opaque to
// callers; both atlas builders draw the canvas directly.

import type { ResourceLoader } from '../../core/resource-loader';
import { normalizeImageSource } from '../../core/sprites/draw';
import type { BlockTextureDef, DrawSource, KindStore, NormalizedImageSource, SpriteHandle } from '../../internal';
import { makeCanvas } from './raster';

export type BakedDraws = Map<DrawSource, OffscreenCanvas>;

export type BakeDrawTexturesOptions = {
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
};

/** user draw fn: DOM 2d context + image-source inputs + scalar params.
 *  OffscreenCanvas's context is structurally compatible for the subset draw
 *  fns use (drawImage, fillStyle, …). */
type DrawFn = (
    ctx: OffscreenCanvasRenderingContext2D,
    inputs: Record<string, CanvasImageSource>,
    params: Record<string, string | number | boolean>,
) => void;

/**
 * Walk both registries and bake every `DrawSource` frame (top-level or nested
 * via input chains) to an OffscreenCanvas. Returns a referential-identity map
 * the atlas builders index into when they encounter a `DrawSource` frame.
 *
 * Image inputs are loaded through the injected loader + createImageBitmap and
 * cached for the duration of one pipeline pass. Missing inputs log a warning
 * and substitute a magenta placeholder.
 */
export async function bakeDrawTextures(
    blockTexturesRegistry: KindStore<BlockTextureDef>,
    spritesRegistry: KindStore<SpriteHandle>,
    opts: BakeDrawTexturesOptions,
): Promise<BakedDraws> {
    const baked: BakedDraws = new Map();
    const imageCache: ImageCache = new Map();

    const drawFrames: DrawSource[] = [];
    for (const handle of blockTexturesRegistry.byId.values()) {
        for (const frame of handle.payload.frames) if (isDrawSource(frame)) drawFrames.push(frame);
    }
    for (const handle of spritesRegistry.byId.values()) {
        const srcs = Array.isArray(handle.payload.src) ? handle.payload.src : [handle.payload.src];
        for (const frame of srcs) if (isDrawSource(frame)) drawFrames.push(frame);
    }

    if (drawFrames.length === 0) return baked;

    console.log(`[bongle] baking ${drawFrames.length} DrawSource frame(s)...`);
    for (const ds of drawFrames) await bakeOne(ds, baked, imageCache, opts.loader, new Set());
    return baked;
}

// ── internals ───────────────────────────────────────────────────────

type ImageCache = Map<string, ImageBitmap>;

function isDrawSource(s: NormalizedImageSource): s is DrawSource {
    return typeof s !== 'string';
}

/**
 * Bake one DrawSource: depth-first resolve inputs, run the user fn against a
 * fresh canvas, store in `baked`. Memoized by descriptor identity, so a draw
 * shared between multiple frames bakes once.
 */
async function bakeOne(
    ds: DrawSource,
    baked: BakedDraws,
    imageCache: ImageCache,
    loader: ResourceLoader,
    cycleGuard: Set<DrawSource>,
): Promise<OffscreenCanvas> {
    const existing = baked.get(ds);
    if (existing) return existing;

    if (cycleGuard.has(ds)) {
        throw new Error('[bongle] draw() cycle detected — a draw descriptor references itself through its inputs');
    }
    cycleGuard.add(ds);

    const inputEntries = await Promise.all(
        Object.entries(ds.inputs).map(async ([key, src]) => {
            // `ds.inputs` values are `ImageSource` (may carry a URL); collapse to
            // the normalized form `resolveInput` consumes.
            const resolved = await resolveInput(normalizeImageSource(src), baked, imageCache, loader, cycleGuard);
            return [key, resolved] as const;
        }),
    );
    const inputs: Record<string, CanvasImageSource> = {};
    for (const [k, v] of inputEntries) inputs[k] = v;

    const { canvas, ctx } = makeCanvas(ds.size[0], ds.size[1]);
    (ds.fn as unknown as DrawFn)(ctx, inputs, ds.params);

    baked.set(ds, canvas);
    cycleGuard.delete(ds);
    return canvas;
}

async function resolveInput(
    src: NormalizedImageSource,
    baked: BakedDraws,
    imageCache: ImageCache,
    loader: ResourceLoader,
    cycleGuard: Set<DrawSource>,
): Promise<CanvasImageSource> {
    if (isDrawSource(src)) return bakeOne(src, baked, imageCache, loader, cycleGuard);

    const cached = imageCache.get(src);
    if (cached) return cached;
    let bytes: Uint8Array;
    try {
        bytes = await loader.loadBytes(src);
    } catch {
        console.warn(`[bongle] draw() input not found: ${src} (magenta placeholder)`);
        return makePlaceholderImage();
    }
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    imageCache.set(src, bitmap);
    return bitmap;
}

/** 16×16 magenta canvas, substituted for a missing draw input so the user fn
 *  can still run (visibly-broken output) rather than crashing the pipeline. */
function makePlaceholderImage(): OffscreenCanvas {
    const { canvas, ctx } = makeCanvas(16, 16);
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, 16, 16);
    return canvas;
}
