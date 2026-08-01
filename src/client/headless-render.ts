// Headless render context for the pipeline worker's icon bakers. Thin wrapper
// over the offline render backend seam (`render/offline`): `createHeadlessRenderContext`
// stands one up (backend chosen by `selectBackend()` — honours a forwarded
// `?renderer=`), and `buildRenderDeps` rebuilds the per-bake render resources
// through it. All backend specifics (device, voxel producer, readback) live behind
// the `OfflineRenderer` handle, so block/prefab icon rendering is backend-neutral.

import type { ResourceLoader } from '../core/resource-loader';
import { loadOfflineBackend, type OfflineRenderer } from '../render/offline';
import type * as VoxelArena from '../render/voxels/voxel-arena';
import type * as Performance from './performance';
import type { RenderRoomDeps } from './rooms';

/** Persistent offline render context. Created once per worker: the device
 *  handshake and pipeline compiles are expensive and atlas-independent. */
export type HeadlessRenderContext = {
    offline: OfflineRenderer;
    performance: Performance.Profile;
    budget: VoxelArena.VoxelArenaBudget;
};

/** Stand up a headless renderer via the offline seam. `gpu` is the injected Node
 *  Dawn device (WebGPU); the browser worker leaves it undefined and the backend
 *  acquires its own. The concrete backend is `selectBackend()`'s choice. */
export async function createHeadlessRenderContext(gpu?: {
    device: GPUDevice;
    adapter: GPUAdapter;
}): Promise<HeadlessRenderContext> {
    const offline = await loadOfflineBackend(gpu);
    return { offline, performance: offline.performance, budget: offline.budget };
}

/**
 * Rebuild the `RenderRoomDeps` (+ teardown) against the just-baked assets read
 * through `loader`. Delegates to the offline backend, which picks its voxel
 * producer (WebGPU compute / WebGL CPU) and wires `deps.offline` back to itself.
 * Rebuilt per bake so the voxel atlas reflects the latest baked textures.
 */
export function buildRenderDeps(
    ctx: HeadlessRenderContext,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    return ctx.offline.rebuildDeps(loader);
}
