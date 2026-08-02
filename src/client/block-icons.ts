// In-browser block-icon atlas render.
//
// Runs against the live engine (shared device, voxel atlas, shared arena) with
// no offline asset-pipeline. Transient + on-demand: called when the block/
// texture registry changes, it builds a headless `RenderRoom`, renders every
// renderable block into one atlas at the room's own arena index (so the block
// chunk coexists with the resident world instead of evicting it), and tears the
// room down. Same `createRenderRoom` → populate → `renderRoomToTarget` → dispose
// shape as prefab icons — blocks just populate one voxel instead of a prefab.

import { OrthographicCamera, RenderTarget } from 'gpucat';
import { PRESETS } from '../api/environment';
import { registry as engineRegistry } from '../core/registry';
import { MODEL_NONE } from '../core/voxels/block-registry';
import { createMeshOutput } from '../core/voxels/chunk-mesher';
import { ensureChunk, setBlock } from '../core/voxels/voxels';
import * as Environment from '../render/environment/environment';
import { remeshChunkInto } from '../render/voxels/voxel-remesh';
import { applyConfig as applyEnvConfig } from './environment';
import { createRenderRoom, disposeRenderRoom, type RenderRoomDeps } from './rooms';

const ICON_PX = 128;
const CAM_DIST = 64;
// half-extent of the ortho frustum. a unit cube projects to ~1.4 units wide at
// 45° azimuth, so 1.0 gives a snug fit with a small margin.
const HALF_EXTENT = 1.0;
// every icon reuses one arena slot via the packer's upsert-replace path.
const ICON_CHUNK_KEY = '0,0,0';

export type BlockIconAtlas = {
    /** tightly-packed RGBA8 atlas pixels, length = atlasWidth*atlasHeight*4. */
    pixels: Uint8Array;
    atlasWidth: number;
    atlasHeight: number;
    /** blockKey → [col, row] tile position in the atlas grid. */
    coords: Record<string, [number, number]>;
    iconPx: number;
    cols: number;
    rows: number;
};

const EMPTY_ATLAS: BlockIconAtlas = {
    pixels: new Uint8Array(0),
    atlasWidth: 0,
    atlasHeight: 0,
    coords: {},
    iconPx: ICON_PX,
    cols: 0,
    rows: 0,
};

/**
 * Render every renderable block state into a single icon atlas, in-browser.
 * Synchronous burst (safe to reuse the engine-global cull scratch since the
 * world isn't rendering mid-call; the world re-flushes its environment next
 * frame).
 */
export async function renderBlockIconAtlas(deps: RenderRoomDeps): Promise<BlockIconAtlas> {
    const registry = engineRegistry.blockRegistry;
    const voxelResources = deps.voxelResources;

    // renderable states: skip AIR (0), MISSING (1), and any MODEL_NONE state.
    const renderable: string[] = [];
    for (let sid = 2; sid < registry.totalStates; sid++) {
        if (registry.modelType[sid] === MODEL_NONE) continue;
        const key = registry.stateToKey[sid];
        if (key) renderable.push(key);
    }
    if (renderable.length === 0) return EMPTY_ATLAS;

    // `deps` is render-ready when `buildRenderDeps` returns (atlas uploaded +
    // backend voxel producer ready), so no per-baker readiness gate here.

    const cols = Math.ceil(Math.sqrt(renderable.length));
    const rows = Math.ceil(renderable.length / cols);
    const atlasWidth = cols * ICON_PX;
    const atlasHeight = rows * ICON_PX;
    const atlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);
    const coords: Record<string, [number, number]> = {};

    const room = createRenderRoom(deps);
    // flat + full-bright: disable the env so an overhead sun doesn't crush the
    // side faces and the sky/cloud meshes don't bleed in — the classic
    // inventory-icon look (per-face directional factor still gives the 3D read).
    applyEnvConfig(room.environment, { enabled: false, sun: { intensity: 0 } }, PRESETS);
    Environment.flushActive(room.environment, deps.environmentResources);
    // hide the sky/cloud meshes (config.enabled=false) — no per-frame
    // updateForCamera on the offline icon path, so sync visibility directly.
    Environment.syncEnvVisibility(room.envVisuals, room.environment);

    // isometric ortho camera, framing the block centered at voxel (1.5,1.5,1.5)
    // (the mesher places the block spanning (1,1,1)→(2,2,2)).
    const elev = Math.PI / 6;
    const azim = Math.PI / 4;
    const cx = 1.5;
    const cy = 1.5;
    const cz = 1.5;
    const camera = new OrthographicCamera(-HALF_EXTENT, HALF_EXTENT, HALF_EXTENT, -HALF_EXTENT, 0.1, CAM_DIST * 2);
    camera.position[0] = cx + Math.sin(azim) * Math.cos(elev) * CAM_DIST;
    camera.position[1] = cy + Math.sin(elev) * CAM_DIST;
    camera.position[2] = cz + Math.cos(azim) * Math.cos(elev) * CAM_DIST;
    camera.lookAt([cx, cy, cz]);
    camera.updateProjectionMatrix();
    camera.updateWorldMatrix();
    camera.updateViewMatrix(); // the offline path has no controls to refresh the view matrix

    const target = new RenderTarget(ICON_PX, ICON_PX, {
        colorFormat: 'rgba8unorm',
        depthFormat: 'depth24plus',
        samples: 1,
    });
    const pipeline = deps.offline.createPipeline(room.scene, camera);
    const meshOutput = createMeshOutput();
    const arenas = voxelResources.arenas;

    // one reused chunk in the room's voxels; the block at (1,1,1) is replaced
    // per icon (all 6 faces exposed to air), light held at full sky brightness.
    ensureChunk(room.voxels, 0, 0, 0);
    const chunk = room.voxels.chunks.get(ICON_CHUNK_KEY)!;

    try {
        for (let i = 0; i < renderable.length; i++) {
            const key = renderable[i]!;
            const col = i % cols;
            const row = Math.floor(i / cols);
            coords[key] = [col, row];

            setBlock(room.voxels, 1, 1, 1, key);
            chunk.light.fill(0xf000);

            // remeshChunkInto evicts any prior slot when the chunk is all-air after culling
            // (shouldn't happen for a solid block); skip rendering an empty tile if so.
            if (!remeshChunkInto(arenas, room.voxels, registry, chunk, meshOutput)) continue;

            deps.offline.renderToTarget(deps, room, camera, target, pipeline, Number.POSITIVE_INFINITY);
            blitTile(atlasPixels, atlasWidth, await deps.offline.readTarget(target), ICON_PX, col, row);
        }
    } finally {
        pipeline.dispose();
        target.dispose();
        disposeRenderRoom(deps, room);
    }

    return { pixels: atlasPixels, atlasWidth, atlasHeight, coords, iconPx: ICON_PX, cols, rows };
}

/** Copy a tightly-packed RGBA tile into (col,row) of the atlas, row by row. */
function blitTile(atlas: Uint8Array, atlasWidth: number, tile: Uint8Array, px: number, col: number, row: number): void {
    const x0 = col * px;
    const y0 = row * px;
    const rowBytes = px * 4;
    for (let y = 0; y < px; y++) {
        const src = y * rowBytes;
        const dst = ((y0 + y) * atlasWidth + x0) * 4;
        atlas.set(tile.subarray(src, src + rowBytes), dst);
    }
}
