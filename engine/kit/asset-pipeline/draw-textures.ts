// bakes `DrawSource` descriptors to in-memory skia-canvas `Canvas`es
// before the atlas builders run. Walks both registries (block textures +
// sprites), depth-first resolves each draw's inputs (path strings via
// `loadImage`, nested DrawSources by recursion), invokes the user fn
// against a fresh canvas, and memoizes results by the descriptor's
// referential identity. No disk cache — the registry payload hash already
// invalidates downstream atlases when any fn body or input path changes,
// and skia-canvas is fast enough to bake from scratch on every dirty pass
// (see `spikes/skia-canvas-bench/bench.mjs` for the back-of-envelope).
//
// Cycle detection: nested DrawSources can ref each other through user
// closure capture. A per-bake `Set` tracks the in-flight descriptors;
// re-entry throws with the cycle root so the user sees the bad ref
// instead of a hung pipeline.
//
// Output type — `BakedDraws = Map<DrawSource, Canvas>` — is opaque to
// callers; both atlas builders treat the `Canvas` as a raw pixel source
// via `canvas.getContext('2d').getImageData(...)`.

import * as fs from 'node:fs';
import { Canvas, type CanvasRenderingContext2D, type Image, loadImage } from 'skia-canvas';
import type {
    BlockTextureDef,
    DrawSource,
    KindStore,
    NormalizedImageSource,
    SpriteHandle,
} from 'bongle/internal';
import { resolveSrcToAbsPath } from './util';

export type BakedDraws = Map<DrawSource, Canvas>;

export type BakeDrawTexturesOptions = {
    /** absolute path to the project root. */
    projectDir: string;
};

/**
 * Walk both registries and bake every `DrawSource` frame (top-level or
 * nested via input chains) to a `Canvas`. Returns a referential-identity
 * map the atlas builders index into when they encounter a `DrawSource`
 * frame.
 *
 * Path inputs are loaded through skia-canvas `loadImage` and cached for
 * the duration of one pipeline pass. Missing image files log a warning
 * and substitute a magenta placeholder image, matching the atlas
 * builders' fallback for missing source PNGs.
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
        for (const frame of handle.payload.frames) {
            if (isDrawSource(frame)) drawFrames.push(frame);
        }
    }
    for (const handle of spritesRegistry.byId.values()) {
        const srcs = Array.isArray(handle.payload.src) ? handle.payload.src : [handle.payload.src];
        for (const frame of srcs) {
            if (isDrawSource(frame)) drawFrames.push(frame);
        }
    }

    if (drawFrames.length === 0) return baked;

    console.log(`[bongle] baking ${drawFrames.length} DrawSource frame(s)...`);

    for (const ds of drawFrames) {
        await bakeOne(ds, baked, imageCache, opts.projectDir, new Set());
    }

    return baked;
}

// ── internals ───────────────────────────────────────────────────────

type ImageCache = Map<string, Image>;

function isDrawSource(s: NormalizedImageSource): s is DrawSource {
    return typeof s !== 'string';
}

/**
 * Bake one DrawSource: depth-first resolve inputs, run the user fn
 * against a fresh canvas, store in `baked`. Memoized by descriptor
 * identity — sharing a draw descriptor between multiple frames bakes
 * once.
 */
async function bakeOne(
    ds: DrawSource,
    baked: BakedDraws,
    imageCache: ImageCache,
    projectDir: string,
    cycleGuard: Set<DrawSource>,
): Promise<Canvas> {
    const existing = baked.get(ds);
    if (existing) return existing;

    if (cycleGuard.has(ds)) {
        throw new Error('[bongle] draw() cycle detected — a draw descriptor references itself through its inputs');
    }
    cycleGuard.add(ds);

    const inputEntries = await Promise.all(
        Object.entries(ds.inputs).map(async ([key, src]) => {
            const resolved = await resolveInput(src, baked, imageCache, projectDir, cycleGuard);
            return [key, resolved] as const;
        }),
    );
    const inputs: Record<string, Image | Canvas> = {};
    for (const [k, v] of inputEntries) inputs[k] = v;

    const canvas = new Canvas(ds.size[0], ds.size[1]);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    // user fn is typed against the DOM CanvasRenderingContext2D + DOM
    // CanvasImageSource — skia-canvas types are structurally compatible
    // for the subset draw fns actually use (drawImage, fillStyle, etc).
    (ds.fn as unknown as (
        c: CanvasRenderingContext2D,
        i: Record<string, Image | Canvas>,
        p: Record<string, string | number | boolean>,
    ) => void)(ctx, inputs, ds.params);

    baked.set(ds, canvas);
    cycleGuard.delete(ds);
    return canvas;
}

async function resolveInput(
    src: NormalizedImageSource,
    baked: BakedDraws,
    imageCache: ImageCache,
    projectDir: string,
    cycleGuard: Set<DrawSource>,
): Promise<Image | Canvas> {
    if (isDrawSource(src)) {
        return bakeOne(src, baked, imageCache, projectDir, cycleGuard);
    }
    const absPath = resolveSrcToAbsPath(src, projectDir);
    const cached = imageCache.get(absPath);
    if (cached) return cached;
    if (!fs.existsSync(absPath)) {
        console.warn(`[bongle] draw() input not found: ${absPath} (magenta placeholder)`);
        return makePlaceholderImage();
    }
    const img = await loadImage(absPath);
    imageCache.set(absPath, img);
    return img;
}

/** 16×16 magenta canvas — substituted for a missing draw input so the
 *  user fn can still run (likely producing a visibly-broken output)
 *  rather than crashing the pipeline. Returned as a `Canvas` since the
 *  resolveInput return type already widens to `Image | Canvas` and
 *  skia-canvas's drawImage accepts both. */
function makePlaceholderImage(): Canvas {
    const c = new Canvas(16, 16);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, 16, 16);
    return c;
}
