import type { Camera, RenderPipeline, RenderTarget, Scene } from 'gpucat';
import type * as Performance from '../client/performance';
import type { RenderRoom, RenderRoomDeps } from '../client/rooms';
import type { ResourceLoader } from '../core/resource-loader';
import type { Blocks } from '../core/voxels/block-registry';
import type { ChunkMeshResult, MeshOutput } from '../core/voxels/chunk-mesher';
import type { Chunk, Voxels } from '../core/voxels/voxels';
import { type RenderDeviceCaps, type RendererBackendKind, readRendererOverride, webgpuAvailable } from './backend';
import type { VoxelArenaBudget } from './voxels/voxel-arena';

/** One cell of an atlas composite: the target sub-rect, and whether this render clears the whole target first (true only for the first tile). */
export type TileTarget = { rect: [number, number, number, number]; clear: boolean };

/** The headless render backend as one stateful handle, the icon-baking twin of `Renderer`. */
export type OfflineRenderer = {
    readonly kind: RendererBackendKind;
    readonly caps: RenderDeviceCaps;
    readonly performance: Performance.Profile;
    readonly budget: VoxelArenaBudget;

    /** Rebuilds the render-room deps against just-baked assets. Picks the voxel producer (WebGPU compute / WebGL CPU) and wires it back to this handle. */
    rebuildDeps(loader: ResourceLoader): Promise<{ deps: RenderRoomDeps; dispose: () => void }>;

    /** A reusable offline pipeline for one scene+camera; block-icons builds it once and reuses it across every tile. */
    createPipeline(scene: Scene, camera: Camera): RenderPipeline;

    /** Renders `room.render.scene` into `target` via `pipeline`, driving this backend's voxel producer, and restores the prior render target. */
    renderToTarget(
        deps: RenderRoomDeps,
        room: RenderRoom,
        camera: Camera,
        target: RenderTarget,
        pipeline: RenderPipeline,
        voxelViewChunkRadius: number,
    ): void;

    /** Draws `room.render.scene` into `sceneColor`'s `tile` cell (scissor-confined), driving the voxel producer first. The first tile clears the target; the rest load. `sceneColor` is HDR (rgba16float). */
    composeSceneToTarget(
        deps: RenderRoomDeps,
        room: RenderRoom,
        camera: Camera,
        sceneColor: RenderTarget,
        voxelViewChunkRadius: number,
        tile: TileTarget,
    ): void;

    /** Builds the one-shot post pipeline (fxaa, then tonemap/output) that reads the composited `sceneColor` texture. */
    createPostPipeline(sceneColor: RenderTarget): RenderPipeline;

    /** Runs the post pipeline once over the whole grid into `atlas` (rgba8unorm, ready to `readTarget`). Full-frame, clears first. */
    renderPostToTarget(atlas: RenderTarget, postPipeline: RenderPipeline): void;

    readTarget(target: RenderTarget): Promise<Uint8Array>;

    /** Releases the active render room's world from this backend's voxel arena and mesh worker cache, so the next room bakes clean. */
    unmountRoom(deps: RenderRoomDeps): void;

    /** Synchronously meshes a chunk into this backend's arena on the main thread. Returns null when the chunk is all-air or fully occluded. */
    remeshChunkInto(
        deps: RenderRoomDeps,
        voxels: Voxels,
        registry: Blocks,
        chunk: Chunk,
        meshOutput: MeshOutput,
    ): ChunkMeshResult | null;

    dispose(): void;
};

async function createOfflineFor(
    kind: RendererBackendKind,
    gpu?: { device: GPUDevice; adapter: GPUAdapter },
): Promise<OfflineRenderer> {
    const mod = kind === 'webgl' ? await import('./webgl') : await import('./webgpu');
    return mod.createOffline(gpu);
}

/**
 * Selects and dynamically imports the offline backend and mints its handle. Twin of
 * `loadRenderBackend()`. `gpu` is the injected Node Dawn device (WebGPU only); the
 * browser-worker path leaves it undefined and each backend acquires its own.
 *
 * `backend` is the host's chosen backend, threaded in because this runs in a worker
 * whose `self.location` can't carry the page query the live client reads, and keeps
 * the icon bake on the same backend as the client that will display those icons.
 */
export async function loadOfflineBackend(
    gpu?: { device: GPUDevice; adapter: GPUAdapter },
    backend?: RendererBackendKind,
): Promise<OfflineRenderer> {
    // An injected device is always WebGPU; there is no navigator.gpu to probe here.
    if (gpu) return createOfflineFor('webgpu', gpu);
    const requested = backend ?? readRendererOverride() ?? ((await webgpuAvailable()) ? 'webgpu' : 'webgl');
    if (requested === 'webgl') return createOfflineFor('webgl');
    try {
        return await createOfflineFor('webgpu');
    } catch (err) {
        console.error('[render] WebGPU offline init failed; falling back to WebGL2.', err);
        return createOfflineFor('webgl');
    }
}
