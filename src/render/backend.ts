// Render-backend selection + the backend contract.
//
// The engine has two render backends, `render/webgpu` and `render/webgl`, each a
// self-contained module. `engine-client` picks one at `load()` time and pulls it
// in with a dynamic `import()` so a session only ever fetches/parses the backend
// it runs (code-split). This module holds the sync selection logic and the
// `RenderBackendModule` contract the live client render path programs against.
//
// The contract is explicit — real parameter + return types, owned here — and does
// NOT reference either backend implementation. It is generic over the backend's
// opaque state handle `S`: a backend's `init()` mints its own state, and every
// other method takes it back; the client passes it through and never reads its
// internals. WebGPU satisfies `RenderBackendModule<WebGpuState>`; WebGL its own.

import type { Camera } from 'gpucat';
import type * as Performance from '../client/performance';
import type { ClientRoom } from '../client/rooms';
import type { Viewport } from '../client/viewport';
import type { Resources } from '../core/resources';
import type { Blocks } from '../core/voxels/block-registry';
import type { VoxelArenaBudget } from './common/voxels/voxel-arena';

export type RendererBackendKind = 'webgpu' | 'webgl';

// ── contract parameter types (owned by the contract, not a backend) ──────────

/** Per-frame per-room drive context passed to `updateRoom`. */
export type UpdateRoomContext = {
    /** true only for the room whose world is resident in the voxel arena; gates
     *  the mesher pass + arena metrics. */
    isActive: boolean;
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
 * The contract the room + frame loop + HMR path drive on the chosen backend.
 * Generic over the backend's opaque state handle `S` (returned by `init`, passed
 * back to every method). The client treats `S` as opaque; the backend owns it.
 */
export type RenderBackendModule<S> = {
    /** which graphics backend this module drives. */
    readonly kind: RendererBackendKind;

    // ── lifecycle ────────────────────────────────────────────────────────────
    /** construct the backend state (gpucat renderer + placeholders); sync. */
    init(): S;

    /** async device handshake; GPU objects defer their real work until here. */
    load(state: S): Promise<void>;
    dispose(state: S): void;
    resize(state: S, width: number, height: number): void;
    setInspectorVisible(state: S, visible: boolean): void;

    // ── client-global resources ────────────────────────────────────────────
    initResources(state: S, opts: InitResourcesOpts): void;
    loadResources(state: S, opts: LoadResourcesOpts): Promise<void>;
    disposeResources(state: S): void;

    // ── per-room visuals ─────────────────────────────────────────────────────
    createRoomVisuals(state: S, room: ClientRoom): void;
    disposeRoomVisuals(state: S, room: ClientRoom): void;
    updateRoom(state: S, room: ClientRoom, ctx: UpdateRoomContext): void;
    /** mount the room's world into the (single-world) voxel arena. */
    mountRoom(state: S, room: ClientRoom): void;
    /** release the currently-mounted world's arena residency. */
    unmountRoom(state: S): void;

    // ── per-frame render ─────────────────────────────────────────────────────
    render(state: S, room: ClientRoom, camera: Camera | null, voxelViewChunkRadius: number): void;

    // ── HMR / registry-dispatch driven resource + visual rebuilds ────────────
    /** returns whether the block/voxel resources actually swapped. */
    refreshBlockResources(state: S, opts: RefreshBlockResourcesOpts, activeRoom: ClientRoom | null): Promise<boolean>;
    /** returns whether the sprite atlas actually changed. */
    refreshSpriteResources(state: S, opts: RefreshSpriteResourcesOpts): Promise<boolean>;
}

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
