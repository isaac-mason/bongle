// snapshot — render-target + readback primitive shared by every
// offline-renderer icon task. owns the per-tile gpucat RenderTarget and the
// readback into a tightly-packed RGBA8 buffer. the caller drives the actual
// render call between begin and captureTile, so this module stays agnostic
// of how the render is performed (bare gpucat scene/camera vs. a room's
// RenderPipeline + cull computes) AND of what the caller does with the tile:
// single-tile tasks (scene + prefab icons) use the returned pixels directly;
// the block-icons atlas task blits each tile into its own packed buffer.
//
// Headless / DOM-free. The renderer is left configured to render into the
// session's RenderTarget — the caller restores pre-session state via
// `endSnapshotSession`.

import { readPixels, RenderTarget, type WebGPURenderer } from 'gpucat';

export type SnapshotSession = {
    renderer: WebGPURenderer;
    pxSize: number;
    target: RenderTarget;
    /** restore the renderer's pre-session renderTarget. */
    _restore: () => void;
};

/**
 * Create a per-tile RenderTarget at `pxSize × pxSize` and bind it on the
 * renderer. The caller renders between begin/captureTile/end; each
 * captureTile reads the target back and returns the tile's RGBA8 pixels.
 */
export function beginSnapshotSession(renderer: WebGPURenderer, pxSize: number): SnapshotSession {
    // rgba8unorm so `readPixels` returns the texture verbatim (no
    // sRGB encode on readback). callers should render through
    // `renderOutput()` if they want sRGB-encoded output.
    const target = new RenderTarget(pxSize, pxSize, {
        colorFormat: 'rgba8unorm',
        depthFormat: 'depth24plus',
        samples: 1,
    });
    const originalTarget = renderer.renderTarget;
    // Renderer.clearColor defaults to [0,0,0,1] opaque black. Force
    // transparent for icon tiles (restore on end) as a defensive default —
    // current callers render through `createOfflinePipeline`, whose pass sets
    // its own [0,0,0,0] clear, but this keeps any bare-render caller honest.
    const originalClearColor: [number, number, number, number] = [
        renderer.clearColor[0],
        renderer.clearColor[1],
        renderer.clearColor[2],
        renderer.clearColor[3],
    ];
    renderer.renderTarget = target;
    renderer.clearColor = [0, 0, 0, 0];

    const _restore = () => {
        renderer.renderTarget = originalTarget;
        renderer.clearColor = originalClearColor;
    };

    return { renderer, pxSize, target, _restore };
}

/**
 * Read the current target back and return its tightly-packed RGBA8 pixels
 * (length = pxSize² × 4). Call after the caller's render() has populated the
 * target. Single-tile tasks use the buffer directly; atlas tasks blit it.
 */
export function captureTile(session: SnapshotSession): Promise<Uint8Array> {
    return readPixels(session.renderer, session.target);
}

/** Restore the renderer's prior renderTarget and dispose the per-tile target. */
export function endSnapshotSession(session: SnapshotSession): void {
    session._restore();
    session.target.dispose();
}
