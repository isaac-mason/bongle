/**
 * src/asset-pipeline/engine.ts — EngineAssetPipeline.
 *
 * A render-only engine entry, sibling to EngineClient / the server. It builds
 * the GPU render resources an icon render needs and nothing else — no DOM,
 * input, audio, networking, sprites/particles/clouds-presentation, or driver.
 * Native I/O (disk bytes, sharp image decode) arrives via the injected
 * `ResourceLoader` on `Resources`, so this module imports no Node libs and is
 * never in the client bundle's path.
 *
 * `boot()` builds the FULL state and returns it — no `null!` placeholders.
 * `env` (client flags) is set by the boot entry BEFORE user code imports, not
 * here.
 */

import * as CloudResources from '../client/cloud-resources';
import * as ModelResources from '../client/models/model-resources';
import * as Performance from '../client/performance';
import * as Renderer from '../client/renderer';
import * as VoxelMeshResources from '../client/voxels/voxel-mesh-resources';
import * as VoxelResources from '../client/voxels/voxel-resources';
import { type VoxelArenaBudget, voxelArenaBudgetForTier } from '../client/voxels/voxel-resources';
import * as Content from '../core/content';
import * as Registry from '../core/registry';
import { registry } from '../core/registry';
import type { ResourceLoader } from '../core/resource-loader';
import * as Resources from '../core/resources';
import { type BlockIconAtlasResult, runBlockIcons } from './tasks/block-icons';
import { type PrefabIconResult, runPrefabIcon } from './tasks/prefab-icons';
import { runSceneIcon, type SceneIconResult } from './tasks/scene-icon';

export type { BlockIconAtlasResult } from './tasks/block-icons';
export type { PrefabIconResult } from './tasks/prefab-icons';
export type { SceneIconResult } from './tasks/scene-icon';

export type State = {
    renderer: Renderer.Renderer;
    resources: Resources.Resources;
    content: Content.Content;
    performance: Performance.Profile;
    voxelBudget: VoxelArenaBudget;
    voxelResources: VoxelResources.VoxelResources;
    voxelMeshResources: VoxelMeshResources.VoxelMeshResources;
    modelResources: ModelResources.ModelResources;
    cloudResources: CloudResources.CloudResources;
};

export type BootOptions = {
    gpu: { device: GPUDevice; adapter: GPUAdapter };
    /** disk byte loader + sharp `decodeImage` (the pipeline's ResourceLoader). */
    resourceLoader: ResourceLoader;
};

/** Build the full render state (the WorkerApi's bootEngine). */
export async function boot(opts: BootOptions): Promise<State> {
    const renderer = Renderer.initHeadless(opts.gpu);
    const resources = Resources.init(opts.resourceLoader, 'client');
    const content = Content.init();

    await Renderer.load(renderer);

    const performance = Performance.detect(renderer.renderer._adapter);
    const voxelBudget = voxelArenaBudgetForTier(performance);
    const settings = Performance.settingsForTier(performance);

    const cloudResources = CloudResources.init(renderer.environmentResources);
    const modelResources = ModelResources.init();
    const voxelResources = VoxelResources.init(registry.blockRegistry, renderer.environmentResources, voxelBudget);
    const voxelMeshResources = VoxelMeshResources.init(voxelResources.atlas, voxelResources.texAnimBuffer);

    await VoxelResources.load(
        voxelResources,
        registry.blockRegistry,
        settings.voxelWorkerCount,
        settings.voxelWorkerQueueDepth,
        resources,
        renderer.renderer,
    );

    return {
        renderer,
        resources,
        content,
        performance,
        voxelBudget,
        voxelResources,
        voxelMeshResources,
        modelResources,
        cloudResources,
    };
}

export function applyScene(state: State, id: string, payload: Content.ScenePayload): void {
    const handle = registry.scenes.byId.get(id)?.payload;
    if (!handle) return;
    handle._payload = payload;
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'client');
    Registry.touch(registry.scenes, id);
}

export function clearScene(state: State, id: string): void {
    const handle = registry.scenes.byId.get(id)?.payload;
    if (handle) handle._payload = null;
    Content.clearScene(state.content, id, 'client');
    Registry.touch(registry.scenes, id);
}

/** Re-fetch the atlas + rebuild voxel resources after a registry/atlas change.
 *  Rooms are ephemeral (built per render), so they pick up the swapped
 *  engine-global resources on the next render — no per-room rebind needed. */
export async function applyRegistryChanges(state: State): Promise<void> {
    const settings = Performance.settingsForTier(state.performance);
    const { resources: nextRes, changed } = await VoxelResources.refresh(
        state.voxelResources,
        registry.blockRegistry,
        state.renderer.environmentResources,
        state.voxelBudget,
        settings.voxelWorkerCount,
        settings.voxelWorkerQueueDepth,
        state.resources,
        state.renderer.renderer,
    );
    state.voxelResources = nextRes;
    if (changed) {
        VoxelMeshResources.dispose(state.voxelMeshResources);
        state.voxelMeshResources = VoxelMeshResources.init(state.voxelResources.atlas, state.voxelResources.texAnimBuffer);
    }
    ModelResources.update(state.modelResources, state.resources);
}

export function renderBlockIcons(state: State): Promise<BlockIconAtlasResult> {
    return runBlockIcons(state);
}

export function renderPrefabIcon(state: State, id: string): Promise<PrefabIconResult> {
    return runPrefabIcon(state, id);
}

export function renderSceneIcon(state: State, id: string): Promise<SceneIconResult> {
    return runSceneIcon(state, id);
}

export function dispose(state: State): void {
    VoxelResources.dispose(state.voxelResources);
    VoxelMeshResources.dispose(state.voxelMeshResources);
    ModelResources.dispose(state.modelResources);
}
