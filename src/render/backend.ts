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

import type { Camera, PerspectiveCamera } from 'gpucat';
import type * as Performance from '../client/performance';
import type { ClientRoom } from '../client/rooms';
import type { Viewport } from '../client/viewport';
import type { Resources } from '../core/resources';
import type { Blocks } from '../core/voxels/block-registry';
import type { SpriteResources } from './common/sprites/sprite-resources';
import type { TimeResources } from './common/time';
import type { VoxelArenaBudget } from './common/voxels/voxel-arena';

export type RendererBackendKind = 'webgpu' | 'webgl';

// ── contract parameter types (owned by the contract, not a backend) ──────────

/** Per-frame per-room drive context passed to `updateRoom`. */
export type UpdateRoomContext = {
    /** true only for the room whose world is resident in the voxel arena; gates
     *  the mesher pass + arena metrics. */
    isActive: boolean;
    /** the room's live render camera (resolved once via `getRenderCamera`, also
     *  used by the client's per-frame frustum cull). */
    povCamera: Camera;
    /** engine-global viewport dims (for the DOM overlay layout). */
    viewport: Viewport;
    /** engine-global model/animation resources (visuals read them). */
    resources: Resources;
    /** seconds, `performance.now() / 1000`, sampled once for the frame. */
    now: number;
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

/**
 * The render backend as one stateful handle. `create()` builds the internal state
 * and returns this; every method operates on that closed-over state, so the client
 * holds a single `Renderer` and never sees backend internals.
 */
export type Renderer = {
    /** which graphics backend this drives. */
    readonly kind: RendererBackendKind;

    // ── lifecycle ────────────────────────────────────────────────────────────
    /** async device handshake; GPU objects defer their real work until here. */
    load(): Promise<void>;
    dispose(): void;
    resize(width: number, height: number): void;
    setInspectorVisible(visible: boolean): void;
    /** detect the GPU performance tier from the (now-resolved) adapter. */
    detectPerformance(): Performance.Profile;
    /** the engine-global shared render clock. in-scene editor materials
     *  (selection/inspect rainbow) bind its `elapsedTime` node by identity, the
     *  same shared clock the voxel/cloud materials use. */
    renderClock(): TimeResources;

    // ── client-global resources ────────────────────────────────────────────
    initResources(opts: InitResourcesOpts): void;
    loadResources(opts: LoadResourcesOpts): Promise<void>;
    disposeResources(): void;
    /** per-frame poll of the model-resource pools (uploads newly-ready models). */
    updateModelResources(resources: Resources): void;
    /** drop a chunk's mesh from the voxel arena (edit path). */
    removeChunkMesh(key: string): void;
    /** the client-global sprite resources (atlas texture + metadata), or null
     *  before `initResources`. Script-API escape hatch (`spriteAtlasTexture`,
     *  `spriteWorldSize`) for advanced sprite sampling. */
    spriteResources(): SpriteResources | null;

    // ── per-room visuals ─────────────────────────────────────────────────────
    createRoomVisuals(room: ClientRoom): void;
    disposeRoomVisuals(room: ClientRoom): void;
    updateRoom(room: ClientRoom, ctx: UpdateRoomContext): void;
    /** mount the room's world into the (single-world) voxel arena. */
    mountRoom(room: ClientRoom): void;
    /** release the currently-mounted world's arena residency. */
    unmountRoom(): void;
    /** force-push a room's env config into the engine-global env UBOs (on activation). */
    flushRoomEnv(room: ClientRoom): void;

    // ── camera + render ──────────────────────────────────────────────────────
    /** resolve the room's live render camera: sync the engine-global pipeline
     *  camera from the room's active CameraTrait, bind the viewport aspect, and
     *  return it. Used by the client's per-frame cull + the editor tools. */
    getRenderCamera(room: ClientRoom): PerspectiveCamera | null;
    /** render the room. Resolves its camera internally (no camera argument). */
    render(room: ClientRoom, voxelViewChunkRadius: number): void;

    // ── HMR / registry-dispatch driven resource + visual rebuilds ────────────
    /** returns whether the block/voxel resources actually swapped. */
    refreshBlockResources(opts: RefreshBlockResourcesOpts, activeRoom: ClientRoom | null): Promise<boolean>;
    /** returns whether the sprite atlas actually changed. */
    refreshSpriteResources(opts: RefreshSpriteResourcesOpts): Promise<boolean>;
};

/** `?renderer=webgl` / `?renderer=webgpu` forces a backend (QA / debugging).
 *  Returns null when unset or in a non-DOM context. */
function readRendererOverride(): RendererBackendKind | null {
    if (typeof location === 'undefined' || !location.search) return null;
    const v = new URLSearchParams(location.search).get('renderer');
    return v === 'webgl' || v === 'webgpu' ? v : null;
}

/**
 * Choose the render backend for this session. A `?renderer=` override wins;
 * otherwise pick WebGPU when the platform exposes it, falling back to WebGL.
 *
 * Sync + presence-only (`navigator.gpu`) on purpose: the real adapter handshake
 * happens in the backend's async `load()`. A robust "requestAdapter failed ->
 * WebGL" path lands with the real WebGL backend (see llm/plan-webgl2-renderer.md).
 */
export function selectBackend(): RendererBackendKind {
    const override = readRendererOverride();
    if (override) return override;
    if (typeof navigator !== 'undefined' && (navigator as Navigator & { gpu?: unknown }).gpu) return 'webgpu';
    return 'webgl';
}
