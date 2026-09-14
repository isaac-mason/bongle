import type { Camera, DeviceLostInfo, PerspectiveCamera } from 'gpucat';
import type * as Performance from '../client/performance';
import type { ClientRoom } from '../client/rooms';
import type { Viewport } from '../client/viewport';
import type * as Debug from '../core/debug';
import type { Resources } from '../core/resources';
import type { Blocks } from '../core/voxels/block-registry';
import type { SpriteResources } from './sprites/sprite-resources';
import type { TimeResources } from './time';
import type { VoxelArenaBudget } from './voxels/voxel-arena';
import type { VoxelTextures } from './voxels/voxel-textures';

/** `none` draws nothing and is never auto-selected; it exists for headless load generation. */
export type RendererBackendKind = 'webgpu' | 'webgl' | 'none';

/** Per-frame drive context passed to `updateFrame`. */
export type FrameContext = {
    viewport: Viewport;
    resources: Resources;
    /** Seconds, `performance.now() / 1000`, sampled once for the frame. */
    now: number;
    /** The renderer's phases are spans inside the frame the client loop opened. */
    profiler: Debug.Profiler;
    /** The active room's POV camera, resolved by the client into `Renderer.camera`; null when the active room has no POV. */
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

/** Backend-neutral GPU device capabilities, read once the device is acquired. */
export type RenderDeviceCaps = {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
    adapterInfo: { vendor: string; architecture: string; description: string };
};

export type RendererAtlases = {
    voxel: VoxelTextures | null;
    sprite: SpriteResources | null;
};

/** One stateful handle: `create()` builds the internal state, and every method operates on that closed-over state. */
export type Renderer = {
    readonly kind: RendererBackendKind;

    /** Async device handshake; GPU objects defer their real work until here. */
    load(): Promise<RenderDeviceCaps>;
    dispose(): void;
    /** Set by the client to observe a lost GPU device/context; the device can't be recovered in place. */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    resize(width: number, height: number, pixelRatio: number): void;
    setInspectorVisible(visible: boolean): void;
    readonly time: TimeResources;
    readonly camera: PerspectiveCamera;
    /** The single display canvas the backend renders into; only one room renders at a time. */
    readonly canvas: HTMLCanvasElement;

    initResources(opts: InitResourcesOpts): void;
    loadResources(opts: LoadResourcesOpts): Promise<void>;
    disposeResources(): void;
    atlases(): RendererAtlases;

    /** Reconciles the active-room visual slot to `activeRoom` (null tears down and renders nothing), then drives visuals for a frame. */
    updateFrame(activeRoom: ClientRoom | null, ctx: FrameContext): void;

    /** Draws the active room with `camera`. No-op when there is no active room. */
    render(voxelViewChunkRadius: number): void;

    /** Whether the mounted room's world has a resident mesh and nothing queued or in flight for the mesher. True for a backend with no mesher. */
    voxelWorldDrawable(): boolean;

    /** Returns whether the block/voxel resources actually swapped, rebuilding the active room's voxel visuals when they do. */
    refreshBlockResources(opts: RefreshBlockResourcesOpts): Promise<boolean>;
    refreshSpriteResources(opts: RefreshSpriteResourcesOpts): Promise<boolean>;
};

/** `?renderer=webgl|webgpu|none` override, normally set by the host. Returns null when unset or in a non-DOM context. */
export function readRendererOverride(): RendererBackendKind | null {
    if (typeof location === 'undefined' || !location.search) return null;
    const v = new URLSearchParams(location.search).get('renderer');
    return v === 'webgl' || v === 'webgpu' || v === 'none' ? v : null;
}

/** Fallback backend check for a realm with no host: whether a WebGPU adapter materializes. Not proof the device works; a real render is needed for that. */
export async function webgpuAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
        return (await navigator.gpu.requestAdapter()) !== null;
    } catch {
        return false;
    }
}
