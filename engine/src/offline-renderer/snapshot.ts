// snapshot — render-target + tile-blit primitive shared by all
// offline-renderer tasks that produce sprite atlases (block-icons,
// prefab-icons, ...). owns the per-tile gpucat RenderTarget and the
// readback-into-atlas-buffer copy. the caller drives the actual render
// call between begin and captureTile, so this module stays agnostic of
// how the render is performed (bare gpucat scene/camera vs. a room's
// RenderPipeline + cull computes).
//
// Headless / DOM-free. The atlas is a tightly-packed RGBA8 Uint8Array
// the caller owns; tile reads are blitted into it row-by-row. The
// renderer is left configured to render into the session's RenderTarget
// — the caller restores any pre-session state via `endSnapshotSession`.

import { readPixels, RenderTarget, type WebGPURenderer } from 'gpucat';

export type SnapshotSession = {
    renderer: WebGPURenderer;
    pxSize: number;
    target: RenderTarget;
    /** atlas pixel buffer the caller owns; tightly-packed rgba8 rows. */
    atlasPixels: Uint8Array;
    atlasWidth: number;
    /** restore the renderer's pre-session renderTarget. */
    _restore: () => void;
};

/**
 * Create a per-tile RenderTarget at `pxSize × pxSize` and bind it on the
 * renderer. The caller renders between begin/captureTile/end, with each
 * captureTile reading the target back and blitting into `atlasPixels` at
 * (col, row).
 */
export function beginSnapshotSession(
    renderer: WebGPURenderer,
    pxSize: number,
    atlasPixels: Uint8Array,
    atlasWidth: number,
): SnapshotSession {
    // rgba8unorm so `readPixels` returns the texture verbatim (no
    // sRGB encode on readback). callers should render through
    // `renderOutput()` if they want sRGB-encoded output.
    const target = new RenderTarget(pxSize, pxSize, {
        colorFormat: 'rgba8unorm',
        depthFormat: 'depth24plus',
        samples: 1,
    });
    const originalTarget = renderer.renderTarget;
    // Renderer.clearColor defaults to [0,0,0,1] opaque black; block-icons
    // uses `renderer.render(scene, camera)` directly so the target gets
    // cleared with that. Force transparent for icon tiles, restore on end.
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

    return { renderer, pxSize, target, atlasPixels, atlasWidth, _restore };
}

/**
 * Read the current target back, blit into the atlas buffer at tile
 * (col, row). Call after the caller's render() has populated the target.
 */
export async function captureTile(
    session: SnapshotSession,
    col: number,
    row: number,
): Promise<void> {
    const tilePixels = await readPixels(session.renderer, session.target);
    blitTile(session.atlasPixels, session.atlasWidth, tilePixels, session.pxSize, col, row);
}

/** Restore the renderer's prior renderTarget and dispose the per-tile target. */
export function endSnapshotSession(session: SnapshotSession): void {
    session._restore();
    session.target.dispose();
}

/**
 * Row-by-row copy of a tightly-packed RGBA tile (`tilePixels`, pxSize×pxSize)
 * into a tightly-packed RGBA atlas (`atlasPixels`, atlasWidth × *) at the
 * given (col, row) grid position.
 */
function blitTile(
    atlasPixels: Uint8Array,
    atlasWidth: number,
    tilePixels: Uint8Array,
    pxSize: number,
    col: number,
    row: number,
): void {
    const BPP = 4;
    const atlasStride = atlasWidth * BPP;
    const tileStride = pxSize * BPP;
    const dstX = col * pxSize;
    const dstY = row * pxSize;
    for (let y = 0; y < pxSize; y++) {
        const srcOffset = y * tileStride;
        const dstOffset = (dstY + y) * atlasStride + dstX * BPP;
        atlasPixels.set(tilePixels.subarray(srcOffset, srcOffset + tileStride), dstOffset);
    }
}
