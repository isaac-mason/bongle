// renders all block states into a single icon atlas. each block is
// rendered individually into an ICON_PX x ICON_PX tile via a gpucat
// RenderTarget, read back as RGBA8 pixels, and blitted into a single
// Uint8Array atlas.
//
// for each renderable state, builds a one-block voxel chunk, meshes it
// with `meshChunk`, installs the result into the offline room's voxel
// arena via `packerUpsertChunk` (replacing any prior icon's chunk under
// the same key), and renders via the shared cull→expand→drawIndirect
// path. A tight isometric ortho camera frames the cube.
//
// Always-render now: the orchestrator (kit/pipeline/orchestrator.ts)
// hash-gates calls; this fn just produces pixels.

import { type ComputeDispatch, OrthographicCamera } from 'gpucat';
import { PRESETS } from '../../api/environment';
import { registry as engineRegistry } from '../../core/registry';
import { MODEL_NONE } from '../../core/voxels/block-registry';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../core/voxels/chunk-mesher';
import { createVoxels, ensureChunk, setBlock } from '../../core/voxels/voxels';
import { applyConfig, flushActive } from '../../render/environment';
import * as Renderer from '../../render/renderer';
import * as VoxelResources from '../../render/voxels/voxel-resources';
import * as VoxelVisuals from '../../render/voxels/voxel-visuals';
import type { State } from '../engine';
import { createRoom, disposeRoom } from '../rooms';
import { beginSnapshotSession, captureTile, endSnapshotSession } from '../snapshot';

const ICON_PX = 128;
const CAM_DIST = 64;

// half-extent of the ortho frustum, frames a single block with the
// isometric rotation. a unit cube projects to ~1.4 units wide at 45deg
// azimuth, so 1.0 gives a snug fit with a small margin.
const HALF_EXTENT = 1.0;

// shared chunk key, every icon reuses the same arena slot via the
// packer's upsert-replace path.
const ICON_CHUNK_KEY = '0,0,0';

export type BlockIconAtlasResult = {
    /** tightly-packed RGBA8 atlas pixels, length = atlasWidth*atlasHeight*4. */
    pixels: Uint8Array;
    atlasWidth: number;
    atlasHeight: number;
    coords: Record<string, [number, number]>;
    iconPx: number;
    cols: number;
    rows: number;
};

export async function runBlockIcons(state: State): Promise<BlockIconAtlasResult> {
    const registry = engineRegistry.blockRegistry;
    const renderer = state.renderer.renderer;

    // collect renderable states (skip AIR=0, MISSING=1, MODEL_NONE)
    const renderableStates: Array<{ sid: number; key: string }> = [];
    for (let sid = 2; sid < registry.totalStates; sid++) {
        if (registry.modelType[sid] === MODEL_NONE) continue;
        const key = registry.stateToKey[sid];
        if (!key) continue;
        renderableStates.push({ sid, key });
    }

    console.log(`[block-icons] renderable states: ${renderableStates.length}`);

    await state.voxelResources.atlasReady;

    // offline room holds the per-pass `Mesh` wrappers (added to
    // room.scene by `VoxelVisuals.initRoomMeshes`). the arena packer +
    // geometries live engine-global on `state.voxelResources`.
    //
    // light icons flat and full-bright: disabling the env pins voxel
    // skyBrightness to DISABLED_SKY_BRIGHTNESS (1.0), and sun.intensity=0
    // drops the directional sunShade term to 1.0 on every face. that
    // leaves only the per-face directional factor (top 1.0, sides 0.6/0.8)
    // to give the cube its 3D read, the classic inventory-icon look. (a
    // lit env at noon instead crushes the two visible side faces, which
    // sit perpendicular to the overhead sun, down to ~0.3-0.4.) disabling
    // the env also hides the sky + cloud meshes so they don't bleed in.
    const iconRoom = createRoom(state);
    applyConfig(iconRoom.environment, { enabled: false, sun: { intensity: 0 } }, PRESETS);
    flushActive(iconRoom.environment);

    if (renderableStates.length === 0) {
        disposeRoom(iconRoom);
        return {
            pixels: new Uint8Array(0),
            atlasWidth: 0,
            atlasHeight: 0,
            coords: {},
            iconPx: ICON_PX,
            cols: 0,
            rows: 0,
        };
    }

    const cols = Math.ceil(Math.sqrt(renderableStates.length));
    const rows = Math.ceil(renderableStates.length / cols);
    const atlasWidth = cols * ICON_PX;
    const atlasHeight = rows * ICON_PX;
    const atlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);

    console.log(`[block-icons] grid: ${cols}x${rows}, atlas: ${atlasWidth}x${atlasHeight}`);

    const session = beginSnapshotSession(renderer, ICON_PX);

    // isometric camera setup, same angle for every block, centered on
    // the block at voxel (1,1,1). the mesher places vertices from
    // (1,1,1) to (2,2,2), so the center is (1.5, 1.5, 1.5).
    const elev = Math.PI / 6;
    const azim = Math.PI / 4;
    const blockCenter: [number, number, number] = [1.5, 1.5, 1.5];

    const camera = new OrthographicCamera(-HALF_EXTENT, HALF_EXTENT, HALF_EXTENT, -HALF_EXTENT, 0.1, CAM_DIST * 2);
    camera.position[0] = blockCenter[0] + Math.sin(azim) * Math.cos(elev) * CAM_DIST;
    camera.position[1] = blockCenter[1] + Math.sin(elev) * CAM_DIST;
    camera.position[2] = blockCenter[2] + Math.cos(azim) * Math.cos(elev) * CAM_DIST;
    camera.lookAt(blockCenter);
    camera.updateProjectionMatrix();
    camera.updateWorldMatrix();
    camera.updateViewMatrix();

    const coords: Record<string, [number, number]> = {};
    const packer = state.voxelResources.arenas.packer;
    const meshOutput = createMeshOutput();

    // Render through the shared offline pipeline (scenePass → fxaa →
    // renderOutput) rather than a bare `renderer.render()`. renderOutput
    // applies the same ACES tonemap + linear→sRGB encode the on-screen view
    // uses; without it, the linear shader output lands in the snapshot's
    // rgba8unorm target verbatim and the PNG reads far too dark. The camera
    // is constant across every block, so one pipeline serves the whole atlas.
    const pipeline = Renderer.createOfflinePipeline(state.renderer, iconRoom.scene, camera);

    try {
        for (let i = 0; i < renderableStates.length; i++) {
            const { key } = renderableStates[i]!;
            const col = i % cols;
            const row = Math.floor(i / cols);
            coords[key] = [col, row];

            // fresh one-block voxel chunk per state; block sits at (1,1,1)
            // so all 6 faces are exposed to air neighbours.
            const voxels = createVoxels(registry);
            ensureChunk(voxels, 0, 0, 0);
            setBlock(voxels, 1, 1, 1, key);
            const chunk = voxels.chunks.get(ICON_CHUNK_KEY)!;

            // fill light with max sky so icons render fully lit.
            chunk.light.fill(0xf000);
            const result = meshChunk(meshOutput, buildMeshInput(voxels, chunk), registry);

            if (!result) {
                // all-air / no quads after culling: evict any prev icon's
                // alloc so the scene draws empty, then skip.
                if (VoxelResources.packerHas(packer, ICON_CHUNK_KEY)) {
                    VoxelResources.packerEvictChunk(packer, ICON_CHUNK_KEY);
                }
                continue;
            }

            // replace any prior icon's alloc under the same key.
            VoxelResources.packerUpsertChunk(packer, ICON_CHUNK_KEY, [0, 0, 0], result);

            VoxelVisuals.cullCPU(state.voxelResources, camera, Infinity);

            const dispatches: ComputeDispatch[] = VoxelVisuals.expandDispatches(state.voxelResources);

            iconRoom.scene.updateWorldMatrix();
            if (dispatches.length > 0) renderer.compute(dispatches);
            pipeline.render();

            blitTile(atlasPixels, atlasWidth, await captureTile(session), ICON_PX, col, row);
        }
    } finally {
        pipeline.dispose();
        endSnapshotSession(session);
        disposeRoom(iconRoom);
    }

    return { pixels: atlasPixels, atlasWidth, atlasHeight, coords, iconPx: ICON_PX, cols, rows };
}

/**
 * Row-by-row copy of a tightly-packed RGBA tile (`tilePixels`, pxSize²) into
 * a tightly-packed RGBA atlas (`atlasPixels`, atlasWidth × *) at grid (col,
 * row). block-icons is the only atlas task, so the blit lives here rather
 * than in the shared snapshot primitive.
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
