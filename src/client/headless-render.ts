import type { ResourceLoader } from '../core/resource-loader';
import type { RendererBackendKind } from '../render/backend';
import { loadOfflineBackend, type OfflineRenderer } from '../render/offline';
import type * as VoxelArena from '../render/voxels/voxel-arena';
import type * as Performance from './performance';
import type { RenderRoomDeps } from './rooms';

/** Persistent offline render context, created once per worker since the device
 *  handshake and pipeline compiles are expensive and atlas-independent. */
export type HeadlessRenderContext = {
    offline: OfflineRenderer;
    performance: Performance.Profile;
    budget: VoxelArena.VoxelArenaBudget;
};

/** `gpu` is the injected Node Dawn device; the browser worker leaves it undefined
 *  and the backend acquires its own. `backend` is the forwarded `?renderer=`
 *  override; absent, the offline seam probes the adapter itself. */
export async function createHeadlessRenderContext(
    gpu?: { device: GPUDevice; adapter: GPUAdapter },
    backend?: RendererBackendKind,
): Promise<HeadlessRenderContext> {
    const offline = await loadOfflineBackend(gpu, backend);
    return { offline, performance: offline.performance, budget: offline.budget };
}

/** Rebuild `RenderRoomDeps` against the just-baked assets read through `loader`.
 *  Called per bake so the voxel atlas reflects the latest baked textures. */
export function buildRenderDeps(
    ctx: HeadlessRenderContext,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    return ctx.offline.rebuildDeps(loader);
}
