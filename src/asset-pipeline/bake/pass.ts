import type { Filesystem } from '../../../os/interface';
import { type Config, DEFAULT_CONFIG, isStandalone } from '../../core/config';
import type { ModelDef } from '../../core/models/handle';
import { type Registry, resolveConfig } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import type { SceneHandle } from '../../core/scene/scene-handle';
import type { Blocks } from '../../core/voxels/block-registry';
import type { BlockDef, BlockHandle, TileDef } from '../../core/voxels/blocks';
import type { ModuleVersion } from '../../internal';
import { buildAudio } from './audio';
import { type BakedTextures, bakeTextures } from './bake-textures';
import type { DecodeAudio } from './decode-audio';
import { buildModels, type ModelsCacheEntry } from './models';
import type { Raster } from './raster';
import { buildScenes } from './scenes';
import { buildSpriteAtlas } from './sprite-atlas';
import { buildTileAtlas } from './tile-atlas';

/** captured as a struct so each call site can adapt its own import result into the same parameter. */
export type PipelineInternal = {
    registry: Registry;
    createBlockRegistry: () => Blocks;
    /** fills its first argument in place; the bake wants a throwaway view, so it
     *  pairs this with its own `createBlockRegistry()` rather than the engine's. */
    buildBlockRegistry: (
        out: Blocks,
        defs: Map<string, BlockDef>,
        handles: Map<string, BlockHandle>,
        tiles: Map<string, TileDef>,
    ) => void;
};

export type PipelineOpts = {
    /** the editor project filesystem (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** host-injected audio decode (host-provided; see pipeline InitCtx). */
    decodeAudio: DecodeAudio;
    /** host-injected 2d raster (host-provided; see pipeline InitCtx). */
    raster: Raster;
    /** bake invocation mode, controls scene barrel discovery (see buildScenes). */
    mode: 'edit' | 'play';
    /** forwarded to the two atlas builders as their `cache` option. true
     *  in dev HMR (the upstream revision gate has already decided this
     *  call is worth making); false in prod build paths because the
     *  sidecar hash collapses every computed texture to a constant marker,
     *  so a cache hit can mask `fn` changes between build invocations. */
    cache: boolean;
};

/**
 * tracks the last-seen `revision` of each consumed registry so a flush whose registries are
 * unchanged short-circuits before any disk write; without this, generated-barrel writes would
 * wake Vite's watcher, whose HMR re-fires the flush handler, infini-looping. `-1` as the
 * cold-start sentinel matches the registries' initial `revision: 0`, so the first pass treats
 * everything as changed.
 */
export type PipelineState = {
    blocks: number;
    tiles: number;
    models: number;
    scenes: number;
    /** named apart from `config` below (which holds the value) since the other kinds only track a revision. */
    configRev: number;
    sounds: number;
    sprites: number;
    /** both atlases consume textures, so a texture edit must dirty them even though neither
     *  consumer's own revision moved: a consumer holds frame references, so its hash covers
     *  which textures it uses, not their pixels. */
    textures: number;
    /** refreshed every pass; `build.ts` reads this after the pass to seed the bundle manifest,
     *  and the pass compares against it to detect a standalone flip. */
    config: Config | null;
    /** per-id incremental cache for the models builder; lives for the process lifetime, cold starts re-pack every model. */
    modelsCache: Map<string, ModelsCacheEntry>;
};

export function createPipelineState(): PipelineState {
    return {
        blocks: -1,
        tiles: -1,
        models: -1,
        scenes: -1,
        configRev: -1,
        sounds: -1,
        sprites: -1,
        textures: -1,
        config: null,
        modelsCache: new Map(),
    };
}

// pass a fresh `state` for prod (one-shot, everything runs); reuse the same `state` across dev
// flushes so subsequent no-op flushes skip all writes.
export type RunPassOptions = {
    /** forces every builder dirty regardless of registry revision, for when an external asset
     *  source file changed on disk but registries didn't move. each builder's content-hash gate
     *  still no-ops if nothing actually changed; this just bypasses the revision short-circuit. */
    forceAll?: boolean;
};

/** per-builder wall-clock (ms), keyed by display label. builders run concurrently, so these
 *  overlap and won't sum to the pass total, read them as the long pole. an absent key means the
 *  builder was skipped. */
export type PipelinePassTimings = Record<string, number>;

export async function runAssetPipelinePass(
    internal: PipelineInternal,
    opts: PipelineOpts,
    state: PipelineState,
    runOpts: RunPassOptions = {},
): Promise<PipelinePassTimings> {
    const { mode, cache, fs, loader, decodeAudio, raster } = opts;
    const { forceAll = false } = runOpts;
    const timings: PipelinePassTimings = {};
    const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
        const start = performance.now();
        return p.then((v) => {
            timings[label] = performance.now() - start;
            return v;
        });
    };

    const { registry } = internal;
    const blocksRev = registry.blocks.revision;
    const tilesRev = registry.tiles.revision;
    const modelsRev = registry.models.revision;
    const scenesRev = registry.scenes.revision;
    const configRev = registry.config.revision;
    const soundsRev = registry.sounds.revision;
    const spritesRev = registry.sprites.revision;
    const texturesRev = registry.textures.revision;

    // the scene set and the model bake's server-bin emission both branch on `standalone`, so a
    // pure config() edit that flips it must re-bake them even though no scene/model rev changed.
    const cfg = resolveConfig(registry);
    const standalone = isStandalone(cfg);
    const prevStandalone = isStandalone(state.config ?? DEFAULT_CONFIG);
    const standaloneChanged = standalone !== prevStandalone;

    const atlasDirty = forceAll || blocksRev !== state.blocks || tilesRev !== state.tiles || texturesRev !== state.textures;
    const modelsDirty = forceAll || modelsRev !== state.models || standaloneChanged;
    const scenesDirty = forceAll || scenesRev !== state.scenes || standaloneChanged;
    const configDirty = configRev !== state.configRev;
    const soundsDirty = forceAll || soundsRev !== state.sounds;
    const spritesDirty = forceAll || spritesRev !== state.sprites || texturesRev !== state.textures;

    if (!atlasDirty && !modelsDirty && !scenesDirty && !configDirty && !soundsDirty && !spritesDirty) return timings;

    // buildBlockRegistry's deriveBlockDust registers a computed `<id>:particle{0..N-1}` texture
    // per cube-block variant; those must be in `registry.textures` before `bakeTextures` walks
    // it, or the sprite atlas falls back to magenta placeholders.
    let moduleView: ModuleVersion | null = null;
    if (atlasDirty || modelsDirty || scenesDirty) {
        const defs = new Map<string, BlockDef>();
        const handles = new Map<string, BlockHandle>();
        for (const [id, def] of registry.blocks.byId) {
            defs.set(id, def);
            const handle = registry.blocks.handles.get(id);
            if (handle) handles.set(id, handle);
        }
        const tiles = new Map<string, TileDef>();
        for (const [id, h] of registry.tiles.byId) tiles.set(id, h);
        const models = new Map<string, ModelDef>();
        for (const [id, h] of registry.models.byId) models.set(id, h);

        const blocks = internal.createBlockRegistry();
        internal.buildBlockRegistry(blocks, defs, handles, tiles);
        const scenes = new Map<string, SceneHandle>();
        for (const [id, h] of registry.scenes.handles) scenes.set(id, h);
        moduleView = { blocks, tiles, models, scenes };
    }

    // not awaited here: only the two atlases consume it. audio, models and scenes read none of
    // it, and awaiting up front would put them behind a bake they don't need (audio worst of
    // all, the longest phase and dependent on nothing but registry.sounds).
    const bakedTextures: Promise<BakedTextures> =
        atlasDirty || spritesDirty
            ? timed('draw', bakeTextures(registry.textures, { loader, raster }))
            : Promise.resolve(new Map());

    const tasks: Promise<void>[] = [];

    if (moduleView) {
        if (atlasDirty) {
            const view = moduleView;
            tasks.push(
                bakedTextures
                    .then((baked) =>
                        timed('tile-atlas', buildTileAtlas(view, { bakedTextures: baked, cache, loader, fs, raster })),
                    )
                    .then(() => undefined),
            );
        }
        if (modelsDirty) {
            // standalone -> don't emit the server-side model bin.
            tasks.push(
                timed('models', buildModels(moduleView, { cache: state.modelsCache, loader, fs, emitServer: !standalone })).then(
                    () => undefined,
                ),
            );
        }
        // standalone -> bake every authored scene into the client (no server serves them).
        if (scenesDirty) tasks.push(timed('scenes', buildScenes(moduleView, { mode, standalone, fs })).then(() => undefined));
    }

    if (soundsDirty) {
        tasks.push(timed('audio', buildAudio(registry.sounds, { fs, loader, decodeAudio })).then(() => undefined));
    }

    if (spritesDirty) {
        // `bakedTextures` is the in-memory output of the texture bake above; missing map entries fall back to magenta inside the builder.
        tasks.push(
            bakedTextures
                .then((baked) =>
                    timed(
                        'sprite-atlas',
                        buildSpriteAtlas(registry.sprites, {
                            bakedTextures: baked,
                            textures: registry.textures,
                            cache,
                            loader,
                            fs,
                            raster,
                        }),
                    ),
                )
                .then(() => undefined),
        );
    }

    await Promise.all(tasks);

    // set unconditionally (cheap) so `prevStandalone` is always the last-baked value.
    state.config = cfg;

    state.blocks = blocksRev;
    state.tiles = tilesRev;
    state.models = modelsRev;
    state.scenes = scenesRev;
    state.configRev = configRev;
    state.sounds = soundsRev;
    state.sprites = spritesRev;
    state.textures = texturesRev;

    return timings;
}
