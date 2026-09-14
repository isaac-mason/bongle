import { OrthographicCamera, RenderTarget } from 'gpucat';
import { PRESETS } from '../api/environment';
import { registry as engineRegistry } from '../core/registry';
import { type Blocks, MODEL_NONE } from '../core/voxels/block-registry';
import { createMeshOutput } from '../core/voxels/chunk-mesher';
import { chunkLight, ensureChunk, setBlock } from '../core/voxels/voxels';
import * as Environment from '../render/environment/environment';
import { applyConfig as applyEnvConfig } from './environment';
import { createRenderRoom, disposeRenderRoom, type RenderRoomDeps } from './rooms';

/** icon tile size; part of the icon bake's cache key (see asset-pipeline/icons). */
export const ICON_PX = 128;
const CAM_DIST = 64;
// half-extent of the ortho frustum; a unit cube projects to ~1.4 units wide at
// 45 degrees azimuth, so 1.0 gives a snug fit with a small margin.
const HALF_EXTENT = 1.0;
// every icon reuses one arena slot via the packer's upsert-replace path.
const ICON_CHUNK_KEY = '0,0,0';

export type BlockIconAtlas = {
    /** tightly-packed RGBA8 atlas pixels, length = atlasWidth*atlasHeight*4. */
    pixels: Uint8Array;
    atlasWidth: number;
    atlasHeight: number;
    /** blockKey to [col, row] tile position in the atlas grid. */
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

/** state ids that get an icon tile, skipping AIR, MISSING, MODEL_NONE states, and keyless states.
 *  shared with the icon bake's cache key, so the gate can't drift from what's rendered. */
export function renderableBlockStates(blocks: Blocks): number[] {
    const states: number[] = [];
    for (let sid = 2; sid < blocks.totalStates; sid++) {
        if (blocks.modelType[sid] === MODEL_NONE) continue;
        if (!blocks.stateToKey[sid]) continue;
        states.push(sid);
    }
    return states;
}

/** renders every renderable block state into a single icon atlas, in-browser.
 *  safe to reuse the engine-global cull scratch since the world isn't rendering mid-call. */
export async function renderBlockIconAtlas(deps: RenderRoomDeps): Promise<BlockIconAtlas> {
    const registry = engineRegistry.blockRegistry;

    const renderable = renderableBlockStates(registry).map((sid) => registry.stateToKey[sid]!);
    if (renderable.length === 0) return EMPTY_ATLAS;

    // `deps` is render-ready when `buildRenderDeps` returns (atlas uploaded +
    // backend voxel producer ready), so no per-baker readiness gate here.

    const cols = Math.ceil(Math.sqrt(renderable.length));
    const rows = Math.ceil(renderable.length / cols);
    const atlasWidth = cols * ICON_PX;
    const atlasHeight = rows * ICON_PX;
    const coords: Record<string, [number, number]> = {};

    const room = createRenderRoom(deps);
    // flat, full-bright inventory-icon look: disable the env so an overhead sun
    // doesn't crush the side faces and the sky/cloud meshes don't bleed in.
    applyEnvConfig(room.environment, { enabled: false, sun: { intensity: 0 } }, PRESETS);
    Environment.flushActive(room.environment, deps.environmentResources);
    // no per-frame updateForCamera on the offline icon path, so sync visibility directly.
    Environment.syncEnvVisibility(room.envVisuals, room.environment);

    // isometric ortho camera framing the block centered at voxel (1.5,1.5,1.5),
    // the voxel the mesher places spanning (1,1,1) to (2,2,2).
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

    // two phases into one grid, then one readback: composite each block's geometry into
    // its cell of an HDR scene-color grid via the target's scissor (composeSceneToTarget
    // draws directly, not through a PassNode, which owns its own texture and would ignore
    // the scissor), then run the fullscreen fxaa + tonemap once over the grid into the atlas.
    const sceneColor = new RenderTarget(atlasWidth, atlasHeight, {
        colorFormat: 'rgba16float',
        depthFormat: 'depth24plus',
        samples: 1,
    });
    const atlas = new RenderTarget(atlasWidth, atlasHeight, { colorFormat: 'rgba8unorm', depthBuffer: false, samples: 1 });
    const postPipeline = deps.offline.createPostPipeline(sceneColor);
    const meshOutput = createMeshOutput();

    // one reused chunk in the room's voxels; the block at (1,1,1) is replaced
    // per icon (all 6 faces exposed to air), light held at full sky brightness.
    ensureChunk(room.voxels, 0, 0, 0);
    const chunk = room.voxels.chunks.get(ICON_CHUNK_KEY)!;

    let atlasPixels: Uint8Array;
    // the first icon that actually renders clears the whole scene-color grid; the
    // rest load into their own cell, so disjoint tiles composite into one target.
    let cleared = false;
    try {
        for (let i = 0; i < renderable.length; i++) {
            const key = renderable[i]!;
            const col = i % cols;
            const row = Math.floor(i / cols);
            coords[key] = [col, row];

            setBlock(room.voxels, 1, 1, 1, key);
            chunkLight(chunk).fill(0xf000);

            // remeshChunkInto evicts any prior slot when the chunk is all-air after culling
            // (shouldn't happen for a solid block); skip rendering an empty tile if so.
            if (!deps.offline.remeshChunkInto(deps, room.voxels, registry, chunk, meshOutput)) continue;

            deps.offline.composeSceneToTarget(deps, room, camera, sceneColor, Number.POSITIVE_INFINITY, {
                rect: [col * ICON_PX, row * ICON_PX, ICON_PX, ICON_PX],
                clear: !cleared,
            });
            cleared = true;
        }
        if (cleared) {
            // one fullscreen post over the whole grid, then one readback of the atlas.
            deps.offline.renderPostToTarget(atlas, postPipeline);
            atlasPixels = await deps.offline.readTarget(atlas);
        } else {
            atlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);
        }
    } finally {
        postPipeline.dispose();
        sceneColor.dispose();
        atlas.dispose();
        disposeRenderRoom(deps, room);
    }

    return { pixels: atlasPixels, atlasWidth, atlasHeight, coords, iconPx: ICON_PX, cols, rows };
}
