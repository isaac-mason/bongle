// Headless render-deps assembler for a canvas-less, window-less context — the
// pipeline worker's in-worker icon renderer. Builds the same engine render
// resources `engine-client.load()` does, minus everything presentation-coupled
// (no input, viewport, React UI, net, or DOM canvas). The GPU device + renderer
// are created once (`createHeadlessRenderContext`); the per-bake resources are
// rebuilt (`buildRenderDeps`) so the voxel atlas always reflects the latest bake.
//
// Both `createRenderRoom` consumers — the live client and this — go through the
// same `RenderRoomDeps` seam, so block/prefab icon rendering is identical code.

import { registry } from '../core/registry';
import type { ResourceLoader } from '../core/resource-loader';
import * as Resources from '../core/resources';
import * as Rpc from '../core/rpc';
import * as CloudResources from '../render/cloud-resources';
import * as ModelResources from '../render/models/model-resources';
import * as Performance from '../render/performance';
import * as Renderer from '../render/renderer';
import * as VoxelMeshResources from '../render/voxels/voxel-mesh-resources';
import * as VoxelResources from '../render/voxels/voxel-resources';
import type { RenderRoomDeps } from './rooms';

/** Persistent GPU + renderer context. Created once per worker: the device
 *  handshake and pipeline compiles are expensive and atlas-independent. */
export type HeadlessRenderContext = {
    renderer: Renderer.Renderer;
    adapter: GPUAdapter;
    performance: Performance.Profile;
    budget: VoxelResources.VoxelArenaBudget;
};

/** Stand up a headless renderer. The GPU device is either injected (node: Dawn
 *  via the `webgpu` pkg, which has no `navigator.gpu`) or requested from
 *  `navigator.gpu` (browser worker — WebGPU is not DOM-bound). */
export async function createHeadlessRenderContext(gpu?: {
    device: GPUDevice;
    adapter: GPUAdapter;
}): Promise<HeadlessRenderContext> {
    let adapter: GPUAdapter;
    let device: GPUDevice;
    if (gpu) {
        ({ device, adapter } = gpu);
    } else {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            throw new Error('[headless-render] WebGPU unavailable here (no navigator.gpu)');
        }
        const requested = await navigator.gpu.requestAdapter();
        if (!requested) throw new Error('[headless-render] no GPU adapter');
        adapter = requested;
        device = await adapter.requestDevice();
    }
    const renderer = Renderer.initHeadless({ device, adapter });
    await Renderer.load(renderer);
    const performance = Performance.detect(adapter);
    const budget = VoxelResources.voxelArenaBudgetForTier(performance);
    return { renderer, adapter, performance, budget };
}

/**
 * Build a `RenderRoomDeps` (+ its teardown) against the realm's live registry and
 * the just-baked assets read through `loader`. Rebuilt per bake so the voxel
 * atlas reflects the latest baked textures; the persistent `ctx` renderer/device
 * is reused. Arena index 0 is free here (no live world room to coexist with).
 */
export async function buildRenderDeps(
    ctx: HeadlessRenderContext,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    const resources = Resources.init(loader, 'client');
    // no net in a headless render room; scriptRuntime only stores this, and a
    // `local:` room's send no-ops anyway. static handles satisfy the driver shape.
    const rpc = Rpc.init({ send() {}, broadcast() {} });

    const cloudResources = CloudResources.init(ctx.renderer.environmentResources);
    const modelResources = ModelResources.init();
    const voxelResources = VoxelResources.init(registry.blockRegistry, ctx.renderer.environmentResources, ctx.budget);
    const voxelMeshResources = VoxelMeshResources.init(voxelResources.atlas, voxelResources.texAnimBuffer);

    // workerCount=0 → synchronous remesh, no nested mesher worker pool (icons mesh
    // inline via meshChunk); still fetches + decodes the baked atlas (worker-safe
    // createImageBitmap path). consumers gate on `voxelResources.atlasReady`.
    await VoxelResources.load(voxelResources, registry.blockRegistry, 0, 0, resources, ctx.renderer.renderer);

    const deps: RenderRoomDeps = {
        resources,
        rpc,
        renderer: ctx.renderer,
        voxelResources,
        voxelMeshResources,
        modelResources,
        cloudResources,
        allocRoomIndex: () => 0,
    };
    const dispose = (): void => {
        VoxelResources.dispose(voxelResources);
        VoxelMeshResources.dispose(voxelMeshResources);
        ModelResources.dispose(modelResources);
        CloudResources.dispose(cloudResources);
    };
    return { deps, dispose };
}
