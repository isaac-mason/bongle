// WebGPU backend: client-global render resources.
//
// The eight engine-global GPU resource sets (atlases, materials, cull computes)
// bundled into one owner. Construction is the sync-init + async-load two-phase
// that used to live scattered in `engine-client.load()`; the HMR-driven resource
// swaps that used to live in `registry-dispatch` are here too (resource level;
// the per-room visual rebuild they trigger is orchestrated in `./index`).

import type * as Performance from '../../client/performance';
import type { Resources } from '../../core/resources';
import type { Blocks } from '../../core/voxels/block-registry';
import * as CloudResources from '../common/environment/clouds/cloud-resources';
import * as ModelResources from '../common/models/model-resources';
import * as ParticleResources from '../common/particles/particle-resources';
import * as ShadowResources from '../common/shadows/shadow-resources';
import * as ExtrudedSpriteResources from '../common/sprites/extruded-sprite-resources';
import * as SpriteResources from '../common/sprites/sprite-resources';
import type { VoxelArenaBudget } from '../common/voxels/voxel-arena';
import * as VoxelMeshResources from '../common/voxels/voxel-mesh-resources';
import type { WebGpuState } from './index';
import * as VoxelResources from './voxels/gpu-frame';

/** the eight client-global GPU resource sets, owned by the backend. */
export type BackendResources = {
    sprite: SpriteResources.SpriteResources;
    extrudedSprite: ExtrudedSpriteResources.ExtrudedSpriteResources;
    particle: ParticleResources.ParticleResources;
    cloud: CloudResources.CloudResources;
    model: ModelResources.ModelResources;
    shadow: ShadowResources.ShadowResources;
    voxel: VoxelResources.VoxelResources;
    voxelMesh: VoxelMeshResources.VoxelMeshResources;
};

/**
 * sync construction of every resource set. pure (no awaits, no fetches): builds
 * materials + cull computes against the magenta placeholder atlas so the
 * downstream extruded/particle inits can name-bind it immediately. The async
 * atlas fetches happen in `loadResources`. Sets `renderer.resources`.
 */
export function initResources(renderer: WebGpuState, opts: { blockRegistry: Blocks; voxelBudget: VoxelArenaBudget }): void {
    const sprite = SpriteResources.init(renderer.environmentResources);
    const extrudedSprite = ExtrudedSpriteResources.init(sprite, renderer.environmentResources);
    const particle = ParticleResources.init(sprite.atlas, renderer.environmentResources);
    const cloud = CloudResources.init(renderer.environmentResources);
    const model = ModelResources.init(renderer.environmentResources);
    const shadow = ShadowResources.init();
    const voxel = VoxelResources.init(
        opts.blockRegistry,
        renderer.environmentResources,
        opts.voxelBudget,
        renderer.timeResources,
    );
    const voxelMesh = VoxelMeshResources.init(
        voxel.atlas,
        voxel.texAnimBuffer,
        renderer.timeResources,
        renderer.environmentResources,
    );
    renderer.resources = { sprite, extrudedSprite, particle, cloud, model, shadow, voxel, voxelMesh };
}

/**
 * async load pass: pre-warms compile pipelines + fetches the real sprite/voxel
 * atlases (the placeholder keeps materials valid meanwhile). Both extruded and
 * particle materials captured a TextureNode against the placeholder atlas during
 * init; `SpriteResources.load` swaps the placeholder out, so re-bind them after.
 * Audio is NOT here — it's not a render resource; engine-client races it.
 */
export async function loadResources(
    renderer: WebGpuState,
    opts: { blockRegistry: Blocks; settings: Performance.Settings; resources: Resources },
): Promise<void> {
    const r = renderer.resources;
    await Promise.all([
        SpriteResources.load(r.sprite, opts.resources.loader),
        VoxelResources.load(
            r.voxel,
            opts.blockRegistry,
            opts.settings.voxelWorkerCount,
            opts.settings.voxelWorkerQueueDepth,
            opts.resources,
            renderer.renderer,
        ),
    ]);
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
}

/**
 * HMR: re-fetch block atlas + rebuild voxel resources (and voxel-mesh resources,
 * which bind the atlas + texAnim). Resource level only — returns whether the
 * resources actually swapped, so `./index` can rebuild each room's voxel visuals.
 */
export async function swapVoxelResources(
    renderer: WebGpuState,
    opts: { blockRegistry: Blocks; voxelBudget: VoxelArenaBudget; settings: Performance.Settings; resources: Resources },
): Promise<boolean> {
    const r = renderer.resources;
    const { resources: nextVoxel, changed } = await VoxelResources.refresh(
        r.voxel,
        opts.blockRegistry,
        renderer.environmentResources,
        opts.voxelBudget,
        renderer.timeResources,
        opts.settings.voxelWorkerCount,
        opts.settings.voxelWorkerQueueDepth,
        opts.resources,
        renderer.renderer,
    );
    r.voxel = nextVoxel;

    // voxelMeshResources binds the engine-global atlas + texAnim, so it must
    // rebuild alongside voxelResources whenever those swap.
    if (changed) {
        VoxelMeshResources.dispose(r.voxelMesh);
        r.voxelMesh = VoxelMeshResources.init(
            r.voxel.atlas,
            r.voxel.texAnimBuffer,
            renderer.timeResources,
            renderer.environmentResources,
        );
    }
    return changed;
}

/**
 * HMR: re-fetch the sprite atlas, rebind the extruded + particle materials that
 * hold their own TextureNodes against it, and wipe the extruded silhouette pool
 * (every bake is stale). Returns whether the atlas changed, so `./index` can
 * rebuild each room's extruded-sprite visuals.
 */
export async function swapSpriteResources(renderer: WebGpuState, opts: { resources: Resources }): Promise<boolean> {
    const r = renderer.resources;
    const changed = await SpriteResources.refresh(r.sprite, opts.resources.loader);
    if (!changed) return false;
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
    ExtrudedSpriteResources.clearGeometryPool(r.extrudedSprite);
    return true;
}

/** dispose the client-global resources. mirrors the prior engine-client dispose
 *  order; modelResources has no dispose (matches prior behaviour). */
export function disposeResources(renderer: WebGpuState): void {
    const r = renderer.resources;
    if (!r) return;
    ShadowResources.dispose(r.shadow);
    CloudResources.dispose(r.cloud);
    VoxelMeshResources.dispose(r.voxelMesh);
    VoxelResources.dispose(r.voxel);
    ParticleResources.dispose(r.particle);
    ExtrudedSpriteResources.dispose(r.extrudedSprite);
    SpriteResources.dispose(r.sprite);
}
