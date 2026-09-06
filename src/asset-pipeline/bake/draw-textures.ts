// bakes `DrawSource` descriptors to in-memory raster surfaces before the atlas
// builders run. Walks both registries (block textures + sprites), depth-first
// resolves each draw's inputs (image refs via the loader + the raster's
// decodeBitmap, nested DrawSources by recursion), invokes the user fn against a
// fresh canvas, and memoizes results by the descriptor's referential identity.
// No disk cache — the registry payload hash already invalidates downstream
// atlases when any fn body or input ref changes.
//
// Cycle detection: nested DrawSources can ref each other through user closure
// capture. A per-bake `Set` tracks in-flight descriptors; re-entry throws with
// the cycle root so the user sees the bad ref instead of a hung pipeline.
//
// Output type `BakedDraws = Map<DrawSource, RasterCanvas>` is opaque to callers;
// both atlas builders draw the canvas directly.

import type { RegistryStore as KindStore } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import type { DrawSource, NormalizedImageSource, SpriteDef } from '../../core/sprites/sprites';
import type { BlockTextureDef } from '../../core/voxels/blocks';
import { BAKE_CONCURRENCY, mapConcurrent } from './concurrency';
import type { Raster, RasterCanvas, RasterContext2D, RasterImage } from './raster';

export type BakedDraws = Map<DrawSource, RasterCanvas>;

export type BakeDrawTexturesOptions = {
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** host-injected 2d raster (host-provided; see pipeline InitCtx). */
    raster: Raster;
};

/** user draw fn: 2d context + image-source inputs + scalar params. The public
 *  draw() API types the ctx as a DOM 2d context; the raster's ctx is structurally
 *  compatible for the subset draw fns use (drawImage, fillStyle, …), so `ds.fn`
 *  is cast to this. */
type DrawFn = (
    ctx: RasterContext2D,
    inputs: Record<string, RasterImage | RasterCanvas>,
    params: Record<string, string | number | boolean>,
) => void;

/**
 * Walk both registries and bake every `DrawSource` frame (top-level or nested
 * via input chains) to a raster surface. Returns a referential-identity map the
 * atlas builders index into when they encounter a `DrawSource` frame.
 *
 * Image inputs are loaded through the injected loader + raster.decodeBitmap and
 * cached for the duration of one pipeline pass. Missing inputs log a warning and
 * substitute a magenta placeholder.
 */
export async function bakeDrawTextures(
    blockTexturesRegistry: KindStore<BlockTextureDef>,
    spritesRegistry: KindStore<SpriteDef>,
    opts: BakeDrawTexturesOptions,
): Promise<BakedDraws> {
    const baked: BakedDraws = new Map();
    const imageCache: ImageCache = new Map();

    const drawFrames: DrawSource[] = [];
    for (const handle of blockTexturesRegistry.byId.values()) {
        for (const frame of handle.frames) if (isDrawSource(frame)) drawFrames.push(frame);
    }
    for (const handle of spritesRegistry.byId.values()) {
        const srcs = Array.isArray(handle.src) ? handle.src : [handle.src];
        for (const frame of srcs) if (isDrawSource(frame)) drawFrames.push(frame);
    }

    if (drawFrames.length === 0) return baked;

    console.log(`[bongle] baking ${drawFrames.length} DrawSource frame(s)...`);
    // Each top-level frame gets its own cycle guard (the guard tracks ANCESTRY within one chain,
    // not global in-flight-ness), while `inFlight` is shared so a draw referenced by several frames
    // still bakes once.
    const inFlight: InFlight = new Map();
    await mapConcurrent(drawFrames, BAKE_CONCURRENCY, (ds) =>
        bakeOne(ds, baked, inFlight, imageCache, opts.loader, opts.raster, new Set()),
    );
    return baked;
}

// ── internals ───────────────────────────────────────────────────────

// PROMISES, not values. Both caches are consulted by concurrent chains, so memoizing the settled
// result lets two chains that miss simultaneously do the same work twice — a double decode for an
// image, and for a draw a second run of the user's fn against a second canvas, after which one of
// the two canvases is the one in `baked` and the other is silently discarded.
type ImageCache = Map<string, Promise<RasterImage | RasterCanvas>>;
type InFlight = Map<DrawSource, Promise<RasterCanvas>>;

function isDrawSource(s: NormalizedImageSource): s is DrawSource {
    return typeof s !== 'string';
}

/**
 * Bake one DrawSource: depth-first resolve inputs, run the user fn against a
 * fresh canvas, store in `baked`. Memoized by descriptor identity, so a draw
 * shared between multiple frames bakes once.
 */
function bakeOne(
    ds: DrawSource,
    baked: BakedDraws,
    inFlight: InFlight,
    imageCache: ImageCache,
    loader: ResourceLoader,
    raster: Raster,
    cycleGuard: Set<DrawSource>,
): Promise<RasterCanvas> {
    // The cycle check comes BEFORE the memo: a self-referencing draw is in flight when its own
    // input asks for it, so consulting the memo first would hand the chain its own pending promise
    // and hang instead of reporting the cycle.
    if (cycleGuard.has(ds)) {
        return Promise.reject(
            new Error('[bongle] draw() cycle detected — a draw descriptor references itself through its inputs'),
        );
    }
    const existing = inFlight.get(ds);
    if (existing) return existing;

    const run = async (): Promise<RasterCanvas> => {
        cycleGuard.add(ds);
        const inputEntries = await Promise.all(
            Object.entries(ds.inputs).map(async ([key, src]) => {
                const resolved = await resolveInput(src, baked, inFlight, imageCache, loader, raster, cycleGuard);
                return [key, resolved] as const;
            }),
        );
        const inputs: Record<string, RasterImage | RasterCanvas> = {};
        for (const [k, v] of inputEntries) inputs[k] = v;

        const { canvas, ctx } = raster.makeCanvas(ds.size[0], ds.size[1]);
        (ds.fn as unknown as DrawFn)(ctx, inputs, ds.params);

        baked.set(ds, canvas);
        cycleGuard.delete(ds);
        return canvas;
    };

    const p = run();
    inFlight.set(ds, p);
    return p;
}

function resolveInput(
    src: NormalizedImageSource,
    baked: BakedDraws,
    inFlight: InFlight,
    imageCache: ImageCache,
    loader: ResourceLoader,
    raster: Raster,
    cycleGuard: Set<DrawSource>,
): Promise<RasterImage | RasterCanvas> {
    if (isDrawSource(src)) return bakeOne(src, baked, inFlight, imageCache, loader, raster, cycleGuard);

    const cached = imageCache.get(src);
    if (cached) return cached;
    const load = (async (): Promise<RasterImage | RasterCanvas> => {
        let bytes: Uint8Array;
        try {
            bytes = await loader.loadBytes(src);
        } catch {
            console.warn(`[bongle] draw() input not found: ${src} (magenta placeholder)`);
            return makePlaceholderImage(raster);
        }
        return raster.decodeBitmap(bytes);
    })();
    imageCache.set(src, load);
    return load;
}

/** 16×16 magenta canvas, substituted for a missing draw input so the user fn
 *  can still run (visibly-broken output) rather than crashing the pipeline. */
function makePlaceholderImage(raster: Raster): RasterCanvas {
    const { canvas, ctx } = raster.makeCanvas(16, 16);
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, 16, 16);
    return canvas;
}
