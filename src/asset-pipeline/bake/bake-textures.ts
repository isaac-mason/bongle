// Bakes computed textures to in-memory raster surfaces before the atlas builders run.
//
// Walks the TEXTURE STORE rather than scraping consumer registries for embedded
// descriptors, which is the whole point of textures having identity: the set of things to
// bake is a store, results are keyed by texture id, a texture referenced by several
// consumers bakes once, and a cycle names the texture that closed the loop instead of
// reporting an anonymous descriptor.
//
// File textures are not baked — the atlas builders load them from disk. Only computed ones
// run a draw fn, and their `inputs` are resolved through the store: a file input is loaded
// and decoded, a computed input is baked first (depth-first, memoised).
//
// No disk cache: the atlas builders' own content hashes decide whether anything is
// rewritten downstream.

import type { RegistryStore as KindStore } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import type { TextureDef } from '../../core/textures/textures';
import { BAKE_CONCURRENCY, mapConcurrent } from './concurrency';
import type { Raster, RasterCanvas, RasterContext2D, RasterImage } from './raster';

/** baked computed textures, keyed by texture id. */
export type BakedTextures = Map<string, RasterCanvas>;

export type BakeTexturesOptions = {
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** host-injected 2d raster (host-provided; see pipeline InitCtx). */
    raster: Raster;
};

/** user draw fn: 2d context + resolved inputs + scalar params. The public API types the
 *  ctx as a DOM 2d context; the raster's is structurally compatible for the subset draw
 *  fns use (drawImage, fillStyle, …), so `def.fn` is cast to this. */
type DrawFn = (
    ctx: RasterContext2D,
    inputs: Record<string, RasterImage | RasterCanvas>,
    params: Record<string, string | number | boolean>,
) => void;

type InFlight = Map<string, Promise<RasterCanvas>>;
type ImageCache = Map<string, Promise<RasterImage | RasterCanvas>>;

const PLACEHOLDER_SIZE = 16;

/**
 * Bake every computed texture in `textures`. Returns a map keyed by texture id that the
 * atlas builders index into.
 */
export async function bakeTextures(textures: KindStore<TextureDef>, opts: BakeTexturesOptions): Promise<BakedTextures> {
    const baked: BakedTextures = new Map();
    const imageCache: ImageCache = new Map();
    const inFlight: InFlight = new Map();

    const computed = [...textures.byId.values()].filter((def) => def.from === 'computed');
    if (computed.length === 0) return baked;

    console.log(`[bongle] baking ${computed.length} computed texture(s)...`);
    // Each root gets its own cycle guard — the guard tracks ANCESTRY within one chain, not
    // global in-flight-ness — while `inFlight` is shared so a texture several others draw
    // from still bakes once.
    await mapConcurrent(computed, BAKE_CONCURRENCY, (def) =>
        bakeOne(def.id, textures, baked, inFlight, imageCache, opts.loader, opts.raster, new Set()),
    );
    return baked;
}

/** bake one computed texture by id, depth-first through its inputs. Memoised by id. */
function bakeOne(
    id: string,
    textures: KindStore<TextureDef>,
    baked: BakedTextures,
    inFlight: InFlight,
    imageCache: ImageCache,
    loader: ResourceLoader,
    raster: Raster,
    ancestry: Set<string>,
): Promise<RasterCanvas> {
    // The cycle check comes BEFORE the memo: a self-referencing texture is in flight when
    // its own input asks for it, so consulting the memo first would hand the chain its own
    // pending promise and hang instead of reporting the cycle.
    if (ancestry.has(id)) {
        return Promise.reject(new Error(`[bongle] texture cycle detected — '${id}' is drawn from itself through its inputs`));
    }
    const existing = inFlight.get(id);
    if (existing) return existing;

    const def = textures.byId.get(id);
    if (def === undefined || def.from !== 'computed') {
        return Promise.reject(new Error(`[bongle] texture '${id}' is not a computed texture`));
    }

    const run = async (): Promise<RasterCanvas> => {
        ancestry.add(id);
        const entries = await Promise.all(
            Object.entries(def.inputs).map(async ([key, dep]) => {
                const resolved = await resolveInput(dep.id, textures, baked, inFlight, imageCache, loader, raster, ancestry);
                return [key, resolved] as const;
            }),
        );
        const inputs: Record<string, RasterImage | RasterCanvas> = {};
        for (const [k, v] of entries) inputs[k] = v;

        const { canvas, ctx } = raster.makeCanvas(def.size[0], def.size[1]);
        (def.fn as unknown as DrawFn)(ctx, inputs, def.params);
        ancestry.delete(id);
        baked.set(id, canvas);
        return canvas;
    };

    const promise = run();
    inFlight.set(id, promise);
    return promise;
}

/** resolve one input texture id: a file texture loads and decodes, a computed one bakes. */
function resolveInput(
    id: string,
    textures: KindStore<TextureDef>,
    baked: BakedTextures,
    inFlight: InFlight,
    imageCache: ImageCache,
    loader: ResourceLoader,
    raster: Raster,
    ancestry: Set<string>,
): Promise<RasterImage | RasterCanvas> {
    const def = textures.byId.get(id);
    if (def === undefined) {
        console.warn(`[bongle] texture input '${id}' is not declared (magenta placeholder)`);
        return Promise.resolve(makePlaceholderImage(raster));
    }
    if (def.from === 'computed') {
        return bakeOne(id, textures, baked, inFlight, imageCache, loader, raster, ancestry);
    }

    const cached = imageCache.get(def.src);
    if (cached) return cached;
    const load = (async (): Promise<RasterImage | RasterCanvas> => {
        let bytes: Uint8Array;
        try {
            bytes = await loader.loadBytes(def.src);
        } catch {
            console.warn(`[bongle] texture '${id}' source not found: ${def.src} (magenta placeholder)`);
            return makePlaceholderImage(raster);
        }
        return raster.decodeBitmap(bytes);
    })();
    imageCache.set(def.src, load);
    return load;
}

/** a magenta square, so a missing source is loud in-game rather than an invisible gap. */
function makePlaceholderImage(raster: Raster): RasterCanvas {
    const { canvas, ctx } = raster.makeCanvas(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
    return canvas;
}
