// In-browser prefab-icon render.
//
// Same shape as block icons — build a headless `RenderRoom`, populate, render
// into a `RenderTarget` at the room's arena index, tear it down — but the
// subject is a prefab: it's instantiated into `room.nodes` and ticked to a
// fixpoint (which stamps its voxels into `room.voxels` and spawns its model
// nodes), then models are preloaded/uploaded, the scene is framed by an
// isometric ortho camera fit to its AABB, and rendered. One prefab → one tile;
// the caller caches by id and invalidates on registry change.

import { OrthographicCamera, readPixels, RenderTarget } from 'gpucat';
import { MeshTrait } from '../builtins/mesh';
import { computeWorldTransforms, getVisualWorldMatrix, TransformTrait } from '../builtins/transform';
import { VoxelMeshTrait } from '../builtins/voxel-mesh';
import { PRESETS } from '../api/environment';
import { registry as engineRegistry } from '../core/registry';
import * as Resources from '../core/resources';
import * as Prefab from '../core/scene/prefab';
import { addChild, createNode, createPrefabConfig, query, setPrefab } from '../core/scene/scene-tree';
import { AIR, MISSING } from '../core/voxels/block-registry';
import { buildMeshInput, createMeshOutput, meshChunk } from '../core/voxels/chunk-mesher';
import { CHUNK_SIZE, chunkKey, markChunkDirty, voxelIndex } from '../core/voxels/voxels';
import * as Environment from '../render/environment';
import * as Interpolation from '../render/interpolation';
import { meshInfoIndexOf } from '../render/models/model-resources';
import * as ModelResources from '../render/models/model-resources';
import * as ModelVisuals from '../render/models/model-visuals';
import * as Renderer from '../render/renderer';
import * as VoxelMeshVisuals from '../render/voxels/voxel-mesh-visuals';
import * as VoxelResources from '../render/voxels/voxel-resources';
import { createRenderRoom, disposeRenderRoom, type RenderRoom, type RenderRoomDeps } from './rooms';

const ICON_PX = 256;
const CAM_DIST = 128;
/** small margin around the exact corner-projection fit. */
const FRAME_MARGIN = 1.05;
const WAIT_TIMEOUT_MS = 5000;
const WAIT_STEP_MS = 16;
/** post-upload settle for image decode + atlas patch. */
const TEXTURE_SETTLE_MS = 300;
/** safety cap on the prefab-drain loop, far above any real nesting depth. */
const MAX_PREFAB_TICKS = 16;

export type PrefabIcon = { pixels: Uint8Array; pxSize: number };

/** Render one prefab into an RGBA8 icon tile, in-browser. Returns null when the
 *  prefab id is unknown or the instantiated content is empty (nothing to draw). */
export async function renderPrefabIcon(deps: RenderRoomDeps, prefabId: string): Promise<PrefabIcon | null> {
    const def = engineRegistry.prefabs.byId.get(prefabId)?.payload;
    if (!def) return null;

    await deps.voxelResources.atlasReady;
    // wait for the shared voxel compute pipelines to compile before the offline
    // render dispatches them (see block-icons for the same guard).
    await deps.voxelResources.computeReady;

    const room = createRenderRoom(deps);
    Environment.applyConfig(room.environment, { enabled: false, sun: { intensity: 0 } }, PRESETS);
    Environment.flushActive(room.environment);

    const target = new RenderTarget(ICON_PX, ICON_PX, {
        colorFormat: 'rgba8unorm',
        depthFormat: 'depth24plus',
        samples: 1,
    });

    try {
        // ── instantiate the prefab + drain nested prefabs to a fixpoint ──
        const anchor = createNode({ name: `prefab-icon:${prefabId}`, persist: false });
        addChild(room.nodes.root, anchor);
        setPrefab(anchor, createPrefabConfig(prefabId));
        let guard = 0;
        do {
            Prefab.tick(room.nodes, room.scriptRuntime, deps.resources, room.voxels, 'client');
        } while (room.nodes._prefabsDirty.size > 0 && ++guard < MAX_PREFAB_TICKS);

        // ── preload referenced models + upload to the GPU pools ──
        const modelIds = new Set<string>();
        const meshKeys = new Set<string>();
        for (const [meshTrait] of query(room.nodes, [MeshTrait, TransformTrait])) {
            const id = meshTrait.meshId;
            if (!id) continue;
            modelIds.add(id.modelId);
            meshKeys.add(`${id.modelId}/${id.meshName}`);
        }
        for (const id of modelIds) Resources.ensureModel(deps.resources, id);
        if (modelIds.size > 0) {
            await waitFor(() => {
                for (const id of modelIds) if (!Resources.hasModel(deps.resources, id)) return false;
                return true;
            });
            ModelResources.update(deps.modelResources, deps.resources);
            await waitFor(() => {
                for (const k of meshKeys) if (meshInfoIndexOf(deps.modelResources.meshInfo, k) === null) return false;
                return true;
            });
            await sleep(TEXTURE_SETTLE_MS);
        }

        // ── world transforms (via interpolation, held at alpha=1) ──
        Interpolation.snapshot(room.interpolation);
        computeWorldTransforms(room.nodes);
        Interpolation.interpolate(room.interpolation, 1.0, 0);

        // ── full-bright voxels, meshed synchronously into the arena at our index ──
        const packer = deps.voxelResources.arenas.packer;
        const meshOutput = createMeshOutput();
        for (const chunk of room.voxels.chunks.values()) {
            chunk.light.fill(0xffff);
            markChunkDirty(room.voxels, chunk);
            if (chunk.nonAirCount === 0) continue;
            const mesh = meshChunk(meshOutput, buildMeshInput(room.voxels, chunk.cx, chunk.cy, chunk.cz), room.voxels.registry);
            if (mesh) {
                VoxelResources.packerUpsertChunk(
                    packer,
                    chunkKey(chunk.cx, chunk.cy, chunk.cz),
                    [chunk.wx, chunk.wy, chunk.wz],
                    mesh,
                    room.roomLocalIndex,
                );
            }
        }

        // unlit for the flat icon read.
        for (const [meshTrait] of query(room.nodes, [MeshTrait])) {
            meshTrait.unlit = true;
            meshTrait._version++;
        }
        for (const [vmTrait] of query(room.nodes, [VoxelMeshTrait])) {
            vmTrait.unlit = true;
        }

        // model + voxel-mesh visuals (register cull entries; offline pass draws all).
        ModelVisuals.update(room.modelVisuals, deps.modelResources, deps.resources, room.visibility);
        VoxelMeshVisuals.update(room.voxelMeshVisuals, room.voxels, room.visibility);

        // ── frame + render ──
        const aabb = computeSceneAabb(room, deps);
        if (!aabb) return null;
        const camera = fitOrthoIsometric(aabb);
        const pipeline = Renderer.createOfflinePipeline(deps.renderer, room.scene, camera);
        try {
            room.scene.updateWorldMatrix();
            Renderer.renderRoomToTarget(
                deps.renderer,
                deps.voxelResources,
                room.scene,
                camera,
                room.roomLocalIndex,
                target,
                pipeline,
                Number.POSITIVE_INFINITY,
            );
            const pixels = await readPixels(deps.renderer.renderer, target);
            return { pixels, pxSize: ICON_PX };
        } finally {
            pipeline.dispose();
        }
    } finally {
        target.dispose();
        disposeRenderRoom(deps, room);
    }
}

/* ── framing ─────────────────────────────────────────────────────── */

type Aabb = [number, number, number, number, number, number];

/** Isometric ortho camera framing an AABB *exactly*: orient the camera, project
 *  the 8 AABB corners into view space, and size the (square) ortho frustum to the
 *  max corner spread around the look-at point. Robust for any prefab shape/size —
 *  no heuristic fudge factor. */
function fitOrthoIsometric(aabb: Aabb): OrthographicCamera {
    const cx = (aabb[0] + aabb[3]) / 2;
    const cy = (aabb[1] + aabb[4]) / 2;
    const cz = (aabb[2] + aabb[5]) / 2;
    const elev = Math.PI / 6;
    const azim = Math.PI / 4;

    // position + orient first — the frustum doesn't affect the view matrix.
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, CAM_DIST * 2);
    camera.position[0] = cx + Math.sin(azim) * Math.cos(elev) * CAM_DIST;
    camera.position[1] = cy + Math.sin(elev) * CAM_DIST;
    camera.position[2] = cz + Math.cos(azim) * Math.cos(elev) * CAM_DIST;
    camera.lookAt([cx, cy, cz]);
    camera.updateWorldMatrix();
    camera.updateViewMatrix(); // matrixWorldInverse (the view matrix) is now current

    // the look-at point projects to view-space (0, 0); the 8 corners spread
    // around it. the tight square half-extent is the max |x|,|y| over corners.
    const v = camera.matrixWorldInverse;
    let half = 0;
    for (let c = 0; c < 8; c++) {
        const x = c & 1 ? aabb[3] : aabb[0];
        const y = c & 2 ? aabb[4] : aabb[1];
        const z = c & 4 ? aabb[5] : aabb[2];
        const vx = v[0]! * x + v[4]! * y + v[8]! * z + v[12]!;
        const vy = v[1]! * x + v[5]! * y + v[9]! * z + v[13]!;
        half = Math.max(half, Math.abs(vx), Math.abs(vy));
    }
    half = (half || 0.5) * FRAME_MARGIN; // guard a degenerate single-point AABB

    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
    return camera;
}

/** Union AABB of the room's renderable content: non-air voxels + MeshTrait
 *  world bounds. Returns null when there's nothing to render. */
function computeSceneAabb(room: RenderRoom, deps: RenderRoomDeps): Aabb | null {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let any = false;

    for (const chunk of room.voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        const { wx, wy, wz, data, palette } = chunk;
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const stateId = palette[data[voxelIndex(x, y, z)]!]!;
                    if (stateId === AIR || stateId === MISSING) continue;
                    const vx = wx + x;
                    const vy = wy + y;
                    const vz = wz + z;
                    if (vx < minX) minX = vx;
                    if (vy < minY) minY = vy;
                    if (vz < minZ) minZ = vz;
                    if (vx + 1 > maxX) maxX = vx + 1;
                    if (vy + 1 > maxY) maxY = vy + 1;
                    if (vz + 1 > maxZ) maxZ = vz + 1;
                    any = true;
                }
            }
        }
    }

    for (const [meshTrait, transformTrait] of query(room.nodes, [MeshTrait, TransformTrait])) {
        const id = meshTrait.meshId;
        if (!id) continue;
        const slot = meshInfoIndexOf(deps.modelResources.meshInfo, `${id.modelId}/${id.meshName}`);
        if (slot === null) continue;
        const entry = deps.modelResources.meshInfo.entries[slot];
        if (!entry) continue;
        // transform the 8 local-AABB corners by the node's world matrix.
        const m = getVisualWorldMatrix(transformTrait);
        const lo = entry.aabbMin;
        const hi = entry.aabbMax;
        for (let c = 0; c < 8; c++) {
            const lx = c & 1 ? hi[0]! : lo[0]!;
            const ly = c & 2 ? hi[1]! : lo[1]!;
            const lz = c & 4 ? hi[2]! : lo[2]!;
            const wx = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
            const wy = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
            const wz = m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!;
            if (wx < minX) minX = wx;
            if (wy < minY) minY = wy;
            if (wz < minZ) minZ = wz;
            if (wx > maxX) maxX = wx;
            if (wy > maxY) maxY = wy;
            if (wz > maxZ) maxZ = wz;
            any = true;
        }
    }

    if (!any) return null;
    return [minX, minY, minZ, maxX, maxY, maxZ];
}

/* ── async helpers ───────────────────────────────────────────────── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
    const start = performance.now();
    while (!predicate()) {
        if (performance.now() - start > timeoutMs) return; // give up quietly; render what's ready
        await sleep(WAIT_STEP_MS);
    }
}
