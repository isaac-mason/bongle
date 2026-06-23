/**
 * kit/runtime/pipeline-node.ts — `boot(ctx)` for the Node asset pipeline.
 *
 * Loaded through the `pipeline` Vite environment's module runner (via the
 * `virtual:bongle/pipeline-worker` entry, which imports user code first), so the
 * engine + user code share ONE module graph + registry + `env`. Drives
 * `EngineAssetPipeline` — the render-only engine entry — NOT `EngineClient`, so
 * there is no DOM, audio, input, driver, or `env.headless`.
 *
 * Native I/O (disk byte loading, sharp image decode, artifact writes) arrives
 * via `ctx`: the `resourceLoader` is the pipeline's `ResourceLoader`
 * (`{ loadBytes, decodeImage }`), and the writers persist rendered pixels. This
 * module imports no Node libs itself.
 */

import { env } from 'bongle';
import { EngineAssetPipeline } from 'bongle/engine-asset-pipeline';
import type { ResourceLoader } from 'bongle/engine-client';
import { __kit, type ScenePayload } from 'bongle/internal';

export type PipelineBootContext = {
    /** Imports user code (`virtual:bongle/user-src`) so the registries populate.
     *  Awaited after the env flags are set, before the engine boots. */
    userEntry: () => Promise<unknown>;
    gpu: { device: GPUDevice; adapter: GPUAdapter };
    /** disk byte loader + sharp `decodeImage` — the pipeline's ResourceLoader. */
    resourceLoader: ResourceLoader;
    /** Write the block-icon atlas (icons-write, in the worker host). */
    writeBlockIcons: (result: EngineAssetPipeline.BlockIconAtlasResult, hash: string) => Promise<void>;
    /** Write one per-id scene/prefab icon (icons-write, in the worker host). */
    writePerIdIcon: (group: 'scenes' | 'prefabs', id: string, pxSize: number, pixels: Uint8Array) => Promise<void>;
};

/** The verb surface served to the orchestrator (matches `kit/pipeline/worker-api`). */
export type PipelineWorker = {
    readonly bootId: string;
    bootEngine(): Promise<void>;
    applyScene(id: string, payload: ScenePayload): Promise<void>;
    clearScene(id: string): Promise<void>;
    applyRegistryChanges(): Promise<void>;
    renderBlockIcons(hash: string): Promise<void>;
    renderPrefabIcon(id: string): Promise<void>;
    renderSceneIcon(id: string): Promise<void>;
    dispose(): void;
};

export async function boot(ctx: PipelineBootContext): Promise<PipelineWorker> {
    env.client = true;
    env.server = false;
    env.editor = true;

    // import user code (registers blocks/models/scenes with their asset-pipeline
    // URLs) — must run after the env flags above, before the engine boots.
    await ctx.userEntry();

    let state: EngineAssetPipeline.State | null = null;
    let bootId = '0';

    return {
        get bootId() {
            return bootId;
        },

        async bootEngine() {
            if (state) EngineAssetPipeline.dispose(state);
            state = await EngineAssetPipeline.boot({ gpu: ctx.gpu, resourceLoader: ctx.resourceLoader });
            bootId = `node-${performance.now()}`;
        },

        async applyScene(id: string, payload: ScenePayload) {
            __kit.registerScene(id, payload);
            if (state) EngineAssetPipeline.applyScene(state, id, payload);
        },

        async clearScene(id: string) {
            if (state) EngineAssetPipeline.clearScene(state, id);
        },

        async applyRegistryChanges() {
            if (state) await EngineAssetPipeline.applyRegistryChanges(state);
        },

        async renderBlockIcons(hash: string) {
            if (!state) throw new Error('[pipeline-node] renderBlockIcons before bootEngine');
            await ctx.writeBlockIcons(await EngineAssetPipeline.renderBlockIcons(state), hash);
        },

        async renderPrefabIcon(id: string) {
            if (!state) throw new Error('[pipeline-node] renderPrefabIcon before bootEngine');
            const r = await EngineAssetPipeline.renderPrefabIcon(state, id);
            await ctx.writePerIdIcon('prefabs', id, r.pxSize, r.pixels);
        },

        async renderSceneIcon(id: string) {
            if (!state) throw new Error('[pipeline-node] renderSceneIcon before bootEngine');
            const r = await EngineAssetPipeline.renderSceneIcon(state, id);
            await ctx.writePerIdIcon('scenes', id, r.pxSize, r.pixels);
        },

        dispose() {
            if (state) EngineAssetPipeline.dispose(state);
            state = null;
        },
    };
}
