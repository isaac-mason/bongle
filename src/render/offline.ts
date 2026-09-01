// The headless (canvas-less) render backend seam — the icon-baking twin of the
// live `Renderer` (backend.ts) + `loadRenderBackend` (load.ts). The pipeline
// worker's icon bakers program against `OfflineRenderer` and never name the
// concrete `render/webgpu` / `render/webgl` modules, the voxel producer, or the
// readback fn (`readPixels` vs `readRenderTargetPixels`). `loadOfflineBackend` takes
// the backend the same way the live client does — from the host that probed the
// device — so icon baking always lands on the backend the client is running.

import type { Camera, RenderPipeline, RenderTarget, Scene } from 'gpucat';
import type * as Performance from '../client/performance';
import type { RenderRoom, RenderRoomDeps } from '../client/rooms';
import type { ResourceLoader } from '../core/resource-loader';
import type { Blocks } from '../core/voxels/block-registry';
import type { ChunkMeshResult, MeshOutput } from '../core/voxels/chunk-mesher';
import type { Chunk, Voxels } from '../core/voxels/voxels';
import { type RenderDeviceCaps, type RendererBackendKind, readRendererOverride, webgpuAvailable } from './backend';
import type { VoxelArenaBudget } from './voxels/voxel-arena';

/**
 * The headless render backend as one stateful handle — the icon-baking twin of
 * `Renderer`. `createOffline()` mints the device + renderer + pipeline and returns
 * this; every method closes over that state, carries no backend types, so the
 * bakers hold a single handle and never see backend internals (device, voxel
 * producer, readback path).
 */
/** one cell of an atlas composite: the target sub-rect + whether this render clears
 *  the whole target first (true only for the first tile). */
export type TileTarget = { rect: [number, number, number, number]; clear: boolean };

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

    /** render `room.render.scene` into `target` via `pipeline`, driving this backend's
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

    // ── block-icon atlas: composite geometry with per-tile scissor into ONE HDR
    // scene-color target, then post-process it once. This renders the scene GEOMETRY
    // directly (renderer.render(scene,camera)) into the tile — NOT through a PassNode
    // (which owns its own target) — so the target's viewport/scissor actually confine
    // it. The fullscreen fxaa+tonemap runs once over the finished grid (createPostPipeline
    // + renderPostToTarget), and the whole atlas reads back in one call. Collapses the
    // per-icon GPU→CPU readback (N → 1) without the fragment artifacts a per-tile
    // fullscreen post pass produced.

    /** draw `room.render.scene` into `sceneColor`'s `tile` cell (scissor-confined),
     *  driving the voxel producer first. The first tile clears the whole target, the
     *  rest load. `sceneColor` is HDR (rgba16float) — post-process it before readback. */
    composeSceneToTarget(
        deps: RenderRoomDeps,
        room: RenderRoom,
        camera: Camera,
        sceneColor: RenderTarget,
        voxelViewChunkRadius: number,
        tile: TileTarget,
    ): void;

    /** build the one-shot post pipeline (fxaa → tonemap/output) that reads the composited
     *  `sceneColor` texture; reused for the single `renderPostToTarget` at the end. */
    createPostPipeline(sceneColor: RenderTarget): RenderPipeline;

    /** run the post pipeline once over the whole grid into `atlas` (rgba8unorm, ready to
     *  `readTarget`). Full-frame (no scissor), clears first. */
    renderPostToTarget(atlas: RenderTarget, postPipeline: RenderPipeline): void;

    /** read `target` back to tightly-packed RGBA8 — `readPixels` (WebGPU) /
     *  `readRenderTargetPixels` (WebGL). */
    readTarget(target: RenderTarget): Promise<Uint8Array>;

    /** release the active render room's world from this backend's voxel arena +
     *  mesh worker cache, so the next room bakes clean. Backend-specific: the CPU
     *  and WebGPU producers own separate arenas, so each narrows `deps.voxelResources`
     *  to its own producer (mirrors `renderToTarget`). */
    unmountRoom(deps: RenderRoomDeps): void;

    /** synchronously mesh a chunk into this backend's arena (the offline bakers fill
     *  the arena on the main thread, no worker pool). Returns the mesh, or null when
     *  the chunk was all-air / fully occluded (the caller may skip an empty tile).
     *  Backend-specific for the same reason as `unmountRoom` — the producer owns its
     *  arena — so the narrowing lives here, not in the shared bakers. */
    remeshChunkInto(
        deps: RenderRoomDeps,
        voxels: Voxels,
        registry: Blocks,
        chunk: Chunk,
        meshOutput: MeshOutput,
    ): ChunkMeshResult | null;

    dispose(): void;
};

/** create the offline handle for one backend. */
async function createOfflineFor(
    kind: RendererBackendKind,
    gpu?: { device: GPUDevice; adapter: GPUAdapter },
): Promise<OfflineRenderer> {
    const mod = kind === 'webgl' ? await import('./webgl') : await import('./webgpu');
    return mod.createOffline(gpu);
}

/**
 * Select + dynamically import the offline backend and mint its handle. Twin of
 * `loadRenderBackend()` — same precedence, same fallback, same code-split `import()`.
 * `gpu` is the injected Node Dawn device (WebGPU only); the browser-worker path
 * leaves it undefined and each backend acquires its own (WebGPU: `navigator.gpu`;
 * WebGL: OffscreenCanvas WebGL2).
 *
 * `backend` is the host's chosen backend, threaded in because this runs in a worker
 * whose `self.location` can't carry the page query the live client reads. Sharing
 * one host decision is what keeps the icon bake on the SAME backend as the client
 * that will display those icons. Left to guess for itself, a bake could take a
 * WebGPU path the client didn't, which reads as "everything renders except block
 * icons".
 */
export async function loadOfflineBackend(
    gpu?: { device: GPUDevice; adapter: GPUAdapter },
    backend?: RendererBackendKind,
): Promise<OfflineRenderer> {
    // An injected device is always WebGPU (Node Dawn bake — no navigator.gpu, so the
    // probe below would wrongly pick WebGL).
    if (gpu) return createOfflineFor('webgpu', gpu);
    // The host's backend, else this realm's own `?renderer=` (the editor's
    // game-client iframe does carry it), else the bare adapter check for a realm with
    // no host at all.
    const requested = backend ?? readRendererOverride() ?? ((await webgpuAvailable()) ? 'webgpu' : 'webgl');
    if (requested === 'webgl') return createOfflineFor('webgl');
    try {
        return await createOfflineFor('webgpu');
    } catch (err) {
        console.error('[render] WebGPU offline init failed; falling back to WebGL2.', err);
        return createOfflineFor('webgl');
    }
}
