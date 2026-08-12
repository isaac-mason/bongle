/**
 * Shared asset-pipeline pass. Two call sites:
 *
 *   - dev: the bongle:pipeline realm (cli/realms/pipeline + editor pipeline-worker),
 *     fired on every settled HMR cascade. Pulls the typed registries off
 *     the server env via `env.runner.import('bongle/internal')`.
 *
 *   - prod: build.ts's `runAssetPipelineInProcess`, fired once before
 *     the Vite bundle. Pulls them off the same process via plain
 *     `await import('bongle/internal')` (the node bin runs the bake in-process, so
 *     dynamic TS imports of the user module are native).
 *
 * Both call sites materialize a partial ProjectModule view (only the
 * fields atlas + models read) from the typed registries and dispatch to
 * `buildBlockTextureAtlas` / `buildModels`. The config the bundle
 * manifest needs is exposed via `state.config`, the `build.ts` caller
 * reads it directly off pipeline state after the pass.
 */

import { type Config, DEFAULT_CONFIG, isStandalone } from '../../core/config';
import type { ModelHandle } from '../../core/models/handle';
import { type Registry, resolveConfig } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import type { SceneHandle } from '../../core/scene/scene-handle';
import type { Blocks } from '../../core/voxels/block-registry';
import type { BlockDef, BlockHandle, BlockTextureDef } from '../../core/voxels/blocks';
import type { ModuleVersion } from '../../internal';
import type { Filesystem } from '../filesystem';
import { buildAudio } from './audio';
import { buildBlockTextureAtlas } from './block-texture-atlas';
import type { DecodeAudio } from './decode-audio';
import { type BakedDraws, bakeDrawTextures } from './draw-textures';
import { buildModels, type ModelsCacheEntry } from './models';
import type { Raster } from './raster';
import { buildScenes } from './scenes';
import { buildSpriteAtlas } from './sprite-atlas';

/** Shape of the `bongle/internal` exports the pipeline pass consumes.
 *  Captured as a struct so each call site can adapt its own import
 *  result (env.runner.import vs await import) into the same parameter. */
export type PipelineInternal = {
    registry: Registry;
    buildBlockRegistry: (
        defs: Map<string, BlockDef>,
        handles: Map<string, BlockHandle>,
        blockTextures: Map<string, BlockTextureDef>,
    ) => Blocks;
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
     *  sidecar hash collapses every DrawSource to a constant `'draw'`
     *  marker, so a cache hit can mask draw-fn changes between build
     *  invocations. */
    cache: boolean;
};

/**
 * Per-flush state for the dev pipeline handler. Tracks the last-seen
 * `revision` of each consumed registry so a flush whose registries are
 * unchanged short-circuits before any disk write. Without this the
 * pipeline writes generated barrels on every flush, the writes wake
 * Vite's watcher, the watcher's HMR re-fires the flush handler via the
 * bongle-capture postlude, and we infini-loop.
 *
 * `-1` as the cold-start sentinel matches the registries' initial
 * `revision: 0`, so the first pass treats everything as "changed" and
 * emits a full set.
 */
export type PipelineState = {
    blocks: number;
    blockTextures: number;
    models: number;
    scenes: number;
    /** last-seen config-store revision (named apart from `config` below, which
     *  holds the value; the other kinds only track a revision so reuse the
     *  store name directly). */
    configRev: number;
    sounds: number;
    sprites: number;
    /** Latest observed config, refreshed every pass. `build.ts` reads this
     *  after the pass to seed the bundle manifest; the pass also compares
     *  against it to detect a standalone flip. */
    config: Config | null;
    /** Per-id incremental cache for the models builder, replaces the
     *  former `.bongle/cache/models-build.json` disk sidecar. Lives for
     *  the lifetime of the process; cold starts re-pack every model. */
    modelsCache: Map<string, ModelsCacheEntry>;
};

export function createPipelineState(): PipelineState {
    return {
        blocks: -1,
        blockTextures: -1,
        models: -1,
        scenes: -1,
        configRev: -1,
        sounds: -1,
        sprites: -1,
        config: null,
        modelsCache: new Map(),
    };
}

/**
 * Run one asset-pipeline pass. Each builder runs only if its source
 * registries' revisions have advanced since the last pass. Registries
 * are expected to already be settled (Project.load /
 * EngineServer.applyRegistryChanges in dev; user-module evaluation in
 * prod) before this is called.
 *
 * Pass a fresh `state` for prod (one-shot, everything runs); reuse the
 * same `state` across dev flushes so subsequent no-op flushes skip all
 * writes.
 */
export type RunPassOptions = {
    /** Force every builder dirty regardless of registry revision. Used when
     *  an external asset source file changed on disk, registries didn't
     *  move, but the bytes the builders read did. Each builder's content-hash
     *  gate still no-ops if nothing actually changed; this just bypasses
     *  the revision short-circuit at the top of the pass. */
    forceAll?: boolean;
};

/** Per-builder wall-clock (ms) for one pass, keyed by display label
 *  ('draw', 'block-atlas', 'sprite-atlas', 'models', 'scenes', 'audio').
 *  Builders run concurrently, so these overlap and won't sum to the pass
 *  total, read them as the long pole. An absent key means the builder was
 *  skipped (nothing dirty). */
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
    const blockTexturesRev = registry.blockTextures.revision;
    const modelsRev = registry.models.revision;
    const scenesRev = registry.scenes.revision;
    const configRev = registry.config.revision;
    const soundsRev = registry.sounds.revision;
    const spritesRev = registry.sprites.revision;

    // The scene SET (all authored scenes vs `scene()`-declared only) and the
    // model bake (whether the server bin is emitted) both branch on `standalone`,
    // so a pure config() edit that flips it must re-bake them even though no
    // scene/model registry rev changed. Compare against the last-baked config.
    const cfg = resolveConfig(registry);
    const standalone = isStandalone(cfg);
    const prevStandalone = isStandalone(state.config ?? DEFAULT_CONFIG);
    const standaloneChanged = standalone !== prevStandalone;

    // Atlas reads blocks (for `BlockRegistryData.textures` derivation) and
    // blockTextures (the source PNGs). Either bumping is grounds for rebuild.
    const atlasDirty = forceAll || blocksRev !== state.blocks || blockTexturesRev !== state.blockTextures;
    const modelsDirty = forceAll || modelsRev !== state.models || standaloneChanged;
    const scenesDirty = forceAll || scenesRev !== state.scenes || standaloneChanged;
    const configDirty = configRev !== state.configRev;
    const soundsDirty = forceAll || soundsRev !== state.sounds;
    const spritesDirty = forceAll || spritesRev !== state.sprites;

    if (!atlasDirty && !modelsDirty && !scenesDirty && !configDirty && !soundsDirty && !spritesDirty) return timings;

    // Build the block registry first when blocks/models/scenes are dirty.
    // `buildBlockRegistry` evaluates each block's default model and, for
    // cube blocks, calls `deriveBlockDust`, which registers per-block
    // `<id>:particle{0..N-1}` sprites whose `src` is a `draw(...)`
    // DrawSource. Those sprites must be in `registry.sprites` BEFORE
    // `bakeDrawTextures` walks it, otherwise their DrawSources never get
    // baked and the sprite atlas falls back to magenta placeholders.
    let moduleView: ModuleVersion | null = null;
    if (atlasDirty || modelsDirty || scenesDirty) {
        const defs = new Map<string, BlockDef>();
        const handles = new Map<string, BlockHandle>();
        for (const [id, h] of registry.blocks.byId) {
            handles.set(id, h);
            defs.set(id, h._def);
        }
        const blockTextures = new Map<string, BlockTextureDef>();
        for (const [id, h] of registry.blockTextures.byId) blockTextures.set(id, h);
        const models = new Map<string, ModelHandle>();
        for (const [id, h] of registry.models.byId) models.set(id, h);

        const blocks = internal.buildBlockRegistry(defs, handles, blockTextures);
        const scenes = new Map<string, SceneHandle>();
        for (const [id, h] of registry.scenes.byId) scenes.set(id, h);
        moduleView = { blocks, blockTextures, models, scenes };
    }

    // Bake DrawSources after block-registry derivation so dust sprites
    // are present. Atlas builders read the resulting `BakedDraws` map to
    // replace magenta placeholders with rendered pixels. The bake walks
    // both registries unconditionally; per-builder gates downstream still
    // apply.
    const bakedDraws: BakedDraws =
        atlasDirty || spritesDirty
            ? await timed('draw', bakeDrawTextures(registry.blockTextures, registry.sprites, { loader, raster }))
            : new Map();

    const tasks: Promise<void>[] = [];

    if (moduleView) {
        if (atlasDirty)
            tasks.push(
                timed('block-atlas', buildBlockTextureAtlas(moduleView, { bakedDraws, cache, loader, fs, raster })).then(
                    () => undefined,
                ),
            );
        // `standalone` is computed once up top (also drives modelsDirty/scenesDirty).
        if (modelsDirty) {
            // standalone → don't emit the server-side model bin (resources/server/models).
            tasks.push(
                timed(
                    'models',
                    buildModels(moduleView, { cache: state.modelsCache, loader, fs, emitServer: !standalone }),
                ).then(() => undefined),
            );
        }
        // standalone → bake EVERY authored scene into the client (no server serves them).
        if (scenesDirty)
            tasks.push(timed('scenes', buildScenes(moduleView, { mode, standalone, fs })).then(() => undefined));
    }

    if (soundsDirty) {
        // buildAudio reads the sounds store directly (independent surface
        // from the partial view above, sounds aren't part of any
        // cross-domain composition like blocks/textures/models).
        tasks.push(timed('audio', buildAudio(registry.sounds, { fs, loader, decodeAudio })).then(() => undefined));
    }

    if (spritesDirty) {
        // buildSpriteAtlas reads the sprites store directly, independent of
        // the block/model view above. `bakedDraws` is the in-memory output
        // of the draw-textures pass above; nullable map entries fall back
        // to magenta inside the builder.
        tasks.push(
            timed('sprite-atlas', buildSpriteAtlas(registry.sprites, { bakedDraws, cache, loader, fs, raster })).then(
                () => undefined,
            ),
        );
    }

    await Promise.all(tasks);

    // Stash the current launch config on pipeline state: the build caller reads it,
    // and the next pass compares against it to detect a standalone flip. Set
    // unconditionally (cheap) so `prevStandalone` is always the last-baked value.
    state.config = cfg;

    state.blocks = blocksRev;
    state.blockTextures = blockTexturesRev;
    state.models = modelsRev;
    state.scenes = scenesRev;
    state.configRev = configRev;
    state.sounds = soundsRev;
    state.sprites = spritesRev;

    return timings;
}
