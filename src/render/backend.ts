// Render backend selection + the `Renderer` contract.
//
// The engine has two render backends, `render/webgpu` and `render/webgl`, each a
// self-contained module exporting `create(): Renderer`. `engine-client` picks one
// at `load()` time and pulls it in with a dynamic `import()` (see `render/load`)
// so a session only ever fetches/parses the backend it runs (code-split).
//
// `Renderer` is ONE stateful object: the backend's `create()` mints its internal
// state and returns this handle, whose methods carry no state parameter — the
// client drives rendering entirely through it and never reads backend internals.
// The former reach-throughs (perf detect, chunk removal, model-resource tick,
// camera resolution, env flush) are methods here. The contract is explicit and
// references neither backend implementation.

import type { Camera, DeviceLostInfo, PerspectiveCamera } from 'gpucat';
import type * as Performance from '../client/performance';
import type { ClientRoom } from '../client/rooms';
import type { Viewport } from '../client/viewport';
import type { Resources } from '../core/resources';
import type { Blocks } from '../core/voxels/block-registry';
import type { TimeResources } from './time';
import type { VoxelArenaBudget } from './voxels/voxel-arena';

export type RendererBackendKind = 'webgpu' | 'webgl';

// ── contract parameter types (owned by the contract, not a backend) ──────────

/** Per-frame drive context passed to `updateFrame`: the engine-global per-frame
 *  inputs the active room's visuals read, including the client-resolved POV camera. */
export type FrameContext = {
    /** engine-global viewport dims (for the DOM overlay layout). */
    viewport: Viewport;
    /** engine-global model/animation resources (visuals read them). */
    resources: Resources;
    /** seconds, `performance.now() / 1000`, sampled once for the frame. */
    now: number;
    /** the active room's POV camera, resolved by the client into `Renderer.camera`
     *  (via `render/common/camera`); null when the active room has no POV. Drives
     *  the mesher/dom-ui/sprite/shadow visuals. */
    povCamera: Camera | null;
};

/** Options for `initResources` (sync client-global resource build). */
export type InitResourcesOpts = { blockRegistry: Blocks; voxelBudget: VoxelArenaBudget };
/** Options for `loadResources` (async atlas/pipeline load). */
export type LoadResourcesOpts = { blockRegistry: Blocks; settings: Performance.Settings; resources: Resources };
/** Options for `refreshBlockResources` (HMR block-registry / atlas change). */
export type RefreshBlockResourcesOpts = {
    blockRegistry: Blocks;
    voxelBudget: VoxelArenaBudget;
    settings: Performance.Settings;
    resources: Resources;
};
/** Options for `refreshSpriteResources` (HMR sprite-atlas change). */
export type RefreshSpriteResourcesOpts = { resources: Resources };

/** Backend-neutral GPU device capabilities, read once the device is acquired.
 *  The client's Performance.detect builds the tier Profile from these. */
export type RenderDeviceCaps = {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
    adapterInfo: { vendor: string; architecture: string; description: string };
};

/**
 * The render backend as one stateful handle. `create()` builds the internal state
 * and returns this; every method operates on that closed-over state, so the client
 * holds a single `Renderer` and never sees backend internals.
 */
export type Renderer = {
    /** which graphics backend this drives. */
    readonly kind: RendererBackendKind;

    // ── lifecycle ────────────────────────────────────────────────────────────
    /** async device handshake; GPU objects defer their real work until here.
     *  Returns the acquired device's capabilities (the client derives its perf
     *  tier from them via `Performance.detect`). */
    load(): Promise<RenderDeviceCaps>;
    dispose(): void;
    /** Set by the client to observe a lost GPU device/context (driver reset, GPU-process
     *  crash, too many live contexts). Forwarded to the underlying backend renderer; the
     *  device can't be recovered in place, so the client halts and surfaces a reload. */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    resize(width: number, height: number): void;
    setInspectorVisible(visible: boolean): void;
    /** the engine-global shared render clock. in-scene editor materials
     *  (selection/inspect rainbow) bind its `elapsedTime` node by identity, the
     *  same shared clock the voxel/cloud materials use. */
    readonly time: TimeResources;
    /** the backend's render camera (a stable gpucat PerspectiveCamera the pass
     *  binds). The client resolves it per-frame into the active room's POV via
     *  `render/common/camera` — for its own cull + to hand back through `FrameContext`
     *  — and the editor reads it. Backend-neutral math; not a device resource. */
    readonly camera: PerspectiveCamera;

    // ── client-global resources ────────────────────────────────────────────
    initResources(opts: InitResourcesOpts): void;
    loadResources(opts: LoadResourcesOpts): Promise<void>;
    disposeResources(): void;

    // ── active-room visuals ──────────────────────────────────────────────────
    // Only ONE room renders at a time. The client owns which room is active; the
    // renderer reconciles its visual bundle to match inside `updateFrame` (build on
    // entry, teardown on exit) — no explicit activate/deactivate. Simulation runs
    // for every room the client holds; visuals + render are active-room only.
    /** the per-frame render tick. Reconciles the active-room visual slot to
     *  `activeRoom` (null → tear down + render nothing): builds visuals + mounts the
     *  world + flushes env on entry, tears them down on exit. Then, if a room is
     *  active, polls the client-global model pools + drives its visuals (mesher,
     *  models, sprites, dom-ui, ...), resolving the camera internally. */
    updateFrame(activeRoom: ClientRoom | null, ctx: FrameContext): void;

    // ── render ────────────────────────────────────────────────────────────────
    /** render the active room, drawing with `camera` (resolved by the client before
     *  this call). No-op when there is no active room. */
    render(voxelViewChunkRadius: number): void;

    // ── HMR / registry-dispatch driven resource + visual rebuilds ────────────
    /** returns whether the block/voxel resources actually swapped. rebuilds the
     *  active room's voxel visuals + remounts its world when they do. */
    refreshBlockResources(opts: RefreshBlockResourcesOpts): Promise<boolean>;
    /** returns whether the sprite atlas actually changed. */
    refreshSpriteResources(opts: RefreshSpriteResourcesOpts): Promise<boolean>;
};

/** `?renderer=webgl` / `?renderer=webgpu` forces a backend (QA / debugging).
 *  Returns null when unset or in a non-DOM context. */
export function readRendererOverride(): RendererBackendKind | null {
    if (typeof location === 'undefined' || !location.search) return null;
    const v = new URLSearchParams(location.search).get('renderer');
    return v === 'webgl' || v === 'webgpu' ? v : null;
}

/**
 * Choose the render backend for this session. A `?renderer=` override wins;
 * otherwise pick WebGPU when the platform exposes it, falling back to WebGL2.
 *
 * Sync + presence-only (`navigator.gpu`): it can't tell whether the adapter will
 * actually come up. The browser client doesn't use this — `loadRenderBackend`
 * (render/load) probes the real adapter and falls back to WebGL2. This stays for
 * the offline/bake path (render/offline), which runs where an adapter is injected
 * or known-good, so presence is enough.
 */
export function selectBackend(): RendererBackendKind {
    const override = readRendererOverride();
    if (override) return override;
    if (typeof navigator !== 'undefined' && (navigator as Navigator & { gpu?: unknown }).gpu) return 'webgpu';
    return 'webgl';
}
