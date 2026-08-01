// The headless (canvas-less) render backend seam — the icon-baking twin of the
// live `Renderer` (backend.ts) + `loadRenderBackend` (load.ts). The pipeline
// worker's icon bakers program against `OfflineRenderer` and never name the
// concrete `render/webgpu` / `render/webgl` modules, the voxel producer, or the
// readback fn (`readPixels` vs `readRenderTargetPixels`). `selectBackend()` picks
// the backend, so a forwarded `?renderer=` reaches offline icon baking for free.

import type { Camera, RenderPipeline, RenderTarget, Scene } from 'gpucat';
import type * as Performance from '../client/performance';
import type { RenderRoom, RenderRoomDeps } from '../client/rooms';
import type { ResourceLoader } from '../core/resource-loader';
import { type RenderDeviceCaps, type RendererBackendKind, selectBackend } from './backend';
import type { VoxelArenaBudget } from './voxels/voxel-arena';

/**
 * The headless render backend as one stateful handle — the icon-baking twin of
 * `Renderer`. `createOffline()` mints the device + renderer + pipeline and returns
 * this; every method closes over that state, carries no backend types, so the
 * bakers hold a single handle and never see backend internals (device, voxel
 * producer, readback path).
 */
export type OfflineRenderer = {
    readonly kind: RendererBackendKind;
    /** device caps + the perf tier / voxel budget the client derives from them. */
    readonly caps: RenderDeviceCaps;
    readonly performance: Performance.Profile;
    readonly budget: VoxelArenaBudget;

    /** rebuild the render-room deps against just-baked assets (per bake). The
     *  backend picks its voxel producer (WebGPU compute / WebGL CPU) here and
     *  wires the returned `RenderRoomDeps.offline` back to this handle. */
    rebuildDeps(loader: ResourceLoader): Promise<{ deps: RenderRoomDeps; dispose: () => void }>;

    /** a reusable offline pipeline for one scene+camera (block-icons builds it
     *  once, reuses across every tile). `RenderPipeline` is a neutral gpucat type. */
    createPipeline(scene: Scene, camera: Camera): RenderPipeline;

    /** render `room.scene` into `target` via `pipeline`, driving this backend's
     *  voxel producer — WebGPU compute dispatch (arena-based) OR WebGL CPU
     *  `cullEmit` (writes `mesh.draws` onto `room.voxelVisuals`). Restores the prior
     *  render target. Takes the whole `RenderRoom` because the WebGL producer needs
     *  the room's voxel visuals, which the arena-based WebGPU path does not. */
    renderToTarget(
        deps: RenderRoomDeps,
        room: RenderRoom,
        camera: Camera,
        target: RenderTarget,
        pipeline: RenderPipeline,
        voxelViewChunkRadius: number,
    ): void;

    /** read `target` back to tightly-packed RGBA8 — `readPixels` (WebGPU) /
     *  `readRenderTargetPixels` (WebGL). */
    readTarget(target: RenderTarget): Promise<Uint8Array>;

    dispose(): void;
};

/**
 * Select + dynamically import the offline backend and mint its handle. Twin of
 * `loadRenderBackend()` — same `selectBackend()` + code-split `import()`. `gpu` is
 * the injected Node Dawn device (WebGPU only); the browser-worker path leaves it
 * undefined and each backend acquires its own (WebGPU: `navigator.gpu`; WebGL:
 * OffscreenCanvas WebGL2).
 */
export async function loadOfflineBackend(gpu?: { device: GPUDevice; adapter: GPUAdapter }): Promise<OfflineRenderer> {
    // An injected device is always WebGPU (Node Dawn bake — no navigator.gpu, so
    // selectBackend() would wrongly pick WebGL). Only the browser-worker path (no
    // injected device) honours selectBackend() → the forwarded `?renderer=`.
    const kind = gpu ? 'webgpu' : selectBackend();
    const mod = kind === 'webgl' ? await import('./webgl') : await import('./webgpu');
    return mod.createOffline(gpu);
}
