// shared asset-pipeline machinery for rendering a populated room into a
// single 256² icon tile. scene-icon and prefab-icon differ only in how they
// SEED the room (deserialize a scene's voxels + nodes vs. tick a prefab
// anchor); everything after — preload models, wait for referenced models +
// GPU upload, light, frame, render, read back — is identical and lives here.

import type { ComputeDispatch } from 'gpucat';
import type { State } from './engine';
import * as ModelResources from '../client/models/model-resources';
import { meshInfoIndexOf } from '../client/models/model-resources';
import * as ModelVisuals from '../client/models/model-visuals';
import type { AssetPipelineRoom } from './rooms';
import * as Renderer from '../client/renderer';
import * as VoxelMeshVisuals from '../client/voxels/voxel-mesh-visuals';
import * as VoxelVisuals from '../client/voxels/voxel-visuals';
import { MeshTrait } from '../builtins/mesh';
import { TransformTrait } from '../builtins/transform';
import { VoxelMeshTrait } from '../builtins/voxel-mesh';
import { getVisualWorldMatrix } from '../api/transforms';
import { AIR, MISSING } from '../core/voxels/block-registry';
import { CHUNK_SIZE, markChunkDirty, voxelIndex } from '../core/voxels/voxels';
import * as Resources from '../core/resources';
import { query } from '../core/scene/nodes';
import * as Prefab from '../core/scene/prefab';
import * as Interpolation from '../client/interpolation';
import * as Transforms from '../builtins/transform';
import { box3, type Box3, type Mat4 } from 'mathcat';
import { fitOrthoIsometric } from './camera-fit';
import { captureTile, type SnapshotSession } from './snapshot';

export const SUBJECT_ICON_PX = 256;

/** poll budget for async loads (atlas + models + cull-compute compile). */
const WAIT_TIMEOUT_MS = 5000;
const WAIT_STEP_MS = 16;
/** post-upload settle for image decode + atlas patch — generous so textures land. */
const TEXTURE_SETTLE_MS = 300;

/* ── async helpers ────────────────────────────────────────────────── */

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
    const start = performance.now();
    while (!predicate()) {
        if (performance.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out: ${label}`);
        }
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    }
}

/**
 * Eagerly load every registered model and upload it to the GPU pools.
 *
 * Both subjects need this BEFORE seeding: prefab `apply` bodies (and any
 * embedded-prefab `apply` inside a scene) dereference ModelHandle.scene /
 * .meshes during `Prefab.tick` — without a loaded payload, `cloneModel(
 * undefined)` throws and the render is lost. The per-render wait in
 * `renderPopulatedRoom` only covers MeshTraits that already exist in the
 * room, which isn't true until tick has instantiated them.
 */
export async function preloadAllModels(state: State): Promise<void> {
    const ids = Array.from(state.resources.models.keys());
    if (ids.length === 0) return;
    for (const id of ids) Resources.ensureModel(state.resources, id);
    try {
        await waitFor(() => {
            for (const id of ids) if (!Resources.hasModel(state.resources, id)) return false;
            return true;
        }, `all models (${ids.length})`);
    } catch (e) {
        console.warn('[asset-pipeline] preloadAllModels:', e);
    }
    ModelResources.update(state.modelResources, state.resources);
    await new Promise((r) => setTimeout(r, TEXTURE_SETTLE_MS));
}

/* ── prefab instantiation ─────────────────────────────────────────── */

/** safety cap on the prefab-drain loop — far above any real nesting depth. */
const MAX_PREFAB_TICKS = 16;

/**
 * Run `Prefab.tick` to a fixpoint. Each tick resolves only one level of
 * nesting — it snapshots the dirty set up front, so a prefab whose output
 * embeds another prefab just marks the inner one dirty for the NEXT pass. The
 * live render ticks every frame, so nesting resolves over frames; offline we
 * drain in a bounded loop. Without this, a scene/prefab that embeds a prefab
 * (which embeds a prefab…) renders with the inner levels un-instantiated.
 */
export function tickPrefabsToFixpoint(room: AssetPipelineRoom, state: State): void {
    let guard = 0;
    do {
        Prefab.tick(room.nodes, room.scriptRuntime, state.resources, room.voxels, 'client');
    } while (room.nodes._prefabsDirty.size > 0 && ++guard < MAX_PREFAB_TICKS);
}

/* ── render ───────────────────────────────────────────────────────── */

/**
 * Given a room that's already been seeded (voxels loaded, nodes added, any
 * prefabs ticked), wait for its referenced models + GPU upload, light it,
 * frame an isometric camera around its AABB, render, and return the tile's
 * RGBA8 pixels. Returns null when there's nothing renderable.
 *
 * `label` is woven into wait-timeout diagnostics (the subject id).
 */
export async function renderPopulatedRoom(
    state: State,
    room: AssetPipelineRoom,
    session: SnapshotSession,
    label: string,
): Promise<Uint8Array | null> {
    // collect referenced models from the instantiated tree, kick off loads,
    // and wait for payloads to land. Models referenced via MeshTrait pull from
    // state.resources (client-global, shared across rooms).
    const meshTraits = query(room.nodes, [MeshTrait, TransformTrait]);
    const modelIds = new Set<string>();
    const meshKeys = new Set<string>();
    for (const [meshTrait] of meshTraits) {
        const id = meshTrait.meshId;
        if (!id) continue;
        modelIds.add(id.modelId);
        meshKeys.add(`${id.modelId}/${id.meshName}`);
    }

    for (const modelId of modelIds) {
        Resources.ensureModel(state.resources, modelId);
    }

    if (modelIds.size > 0) {
        try {
            await waitFor(() => {
                for (const id of modelIds) if (!Resources.hasModel(state.resources, id)) return false;
                return true;
            }, `models for "${label}"`);
        } catch (e) {
            console.warn(`[asset-pipeline] "${label}":`, e);
        }

        // upload payloads to GPU pools (atlas + meshInfo + geometry).
        ModelResources.update(state.modelResources, state.resources);

        // wait for the upload to populate meshInfo entries for everything we need.
        try {
            await waitFor(() => {
                for (const key of meshKeys) {
                    if (meshInfoIndexOf(state.modelResources.meshInfo, key) === null) return false;
                }
                return true;
            }, `meshInfo for "${label}"`);
        } catch (e) {
            console.warn(`[asset-pipeline] "${label}":`, e);
        }

        // give image decode + atlas blit a beat to land before rendering.
        await new Promise((r) => setTimeout(r, TEXTURE_SETTLE_MS));
    }

    // populate world transforms + interpolated matrices for ModelVisuals.
    Interpolation.snapshot(room.interpolation);
    Transforms.computeWorldTransforms(room.nodes);
    Interpolation.interpolate(room.interpolation, 1.0, 0);

    // force fully-lit voxels: no light propagation runs in the asset-pipeline,
    // so without this every stamped voxel renders pitch-black. 0xFFFF =
    // packLight(15, 15, 15, 15) — max sky + max RGB across every voxel.
    for (const chunk of room.voxels.chunks.values()) {
        chunk.light.fill(0xffff);
        markChunkDirty(room.voxels, chunk);
    }

    // refresh voxel chunk meshes for any stamped chunks.
    VoxelVisuals.update(room.voxelVisuals, state.voxelResources, room.voxels, room.voxels.registry, undefined, Infinity);

    // compute scene AABB. needs to happen BEFORE the visuals updates so the
    // camera matches the camera those updates use for frustum culling.
    const aabb = computeSceneAabb(room, state);
    if (!aabb) return null; // nothing renderable

    // small margin — AABB is tight (per-voxel + per-mesh) and the square frustum
    // already centers non-square content.
    const camera = fitOrthoIsometric([aabb[0], aabb[1], aabb[2]], [aabb[3], aabb[4], aabb[5]], { margin: 1.02 });

    // render previews unlit — icon thumbnails should read flat and consistent
    // regardless of where the subject would have stood under a real sky.
    // (chunk voxels are still affected by the 0xFFFF light fill above; this
    // covers MeshTrait + VoxelMeshTrait instances which have their own paths.)
    for (const [meshTrait] of query(room.nodes, [MeshTrait])) {
        meshTrait.unlit = true;
        meshTrait._version++;
    }
    for (const [vmTrait] of query(room.nodes, [VoxelMeshTrait])) {
        vmTrait.unlit = true;
    }

    // now run model + voxel-mesh visuals updates. these register cull
    // entries with the room culler, but the offline pass never runs a cull,
    // so every entry stays visible — exactly what an icon render wants.
    VoxelMeshVisuals.update(room.voxelMeshVisuals, room.voxels, room.visibility);
    ModelVisuals.update(room.modelVisuals, state.modelResources, state.resources, room.visibility);

    room.scene.updateWorldMatrix();
    VoxelVisuals.cullCPU(state.voxelResources, camera, Infinity);

    // build a per-pass pipeline tied to the framing camera. offline icons
    // don't go through the engine-global pipeline (custom camera/framing +
    // transparent clear + no fog/tint) — drive cull + render directly.
    const pipeline = Renderer.createOfflinePipeline(state.renderer, room.scene, camera);
    try {
        const gpuRenderer = state.renderer.renderer;
        const dispatches: ComputeDispatch[] = [];
        for (const d of VoxelVisuals.expandDispatches(state.voxelResources)) dispatches.push(d);
        gpuRenderer.compute(dispatches);
        pipeline.render();
        return await captureTile(session);
    } finally {
        pipeline.dispose();
    }
}

/* ── AABB collection ──────────────────────────────────────────────── */

const _localAabb: Box3 = box3.create();
const _worldAabb: Box3 = box3.create();

/**
 * Compute the union AABB of the room's renderable content:
 *   - voxels (tight per-voxel scan, skipping AIR/MISSING — single 1-voxel
 *     subjects get a 1-unit AABB, not a 16-unit chunk-aligned one)
 *   - MeshTrait+TransformTrait nodes (per-mesh local AABB transformed by world matrix)
 *
 * Returns null if there's nothing to render.
 */
function computeSceneAabb(room: AssetPipelineRoom, state: State): [number, number, number, number, number, number] | null {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    let any = false;

    // voxels — tight per-voxel scan.
    for (const chunk of room.voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        const { wx, wy, wz, data, palette } = chunk;
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const stateId = palette[data[voxelIndex(x, y, z)]!]!;
                    if (stateId === AIR || stateId === MISSING) continue;
                    const vx = wx + x,
                        vy = wy + y,
                        vz = wz + z;
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

    // MeshTrait nodes — look up local AABB in modelResources.meshInfo,
    // transform by interpolatedWorldMatrix.
    for (const [meshTrait, transformTrait] of query(room.nodes, [MeshTrait, TransformTrait])) {
        const id = meshTrait.meshId;
        if (!id) continue;
        const slot = meshInfoIndexOf(state.modelResources.meshInfo, `${id.modelId}/${id.meshName}`);
        if (slot === null) continue;
        const entry = state.modelResources.meshInfo.entries[slot];
        if (!entry) continue;
        box3.set(
            _localAabb,
            entry.aabbMin[0],
            entry.aabbMin[1],
            entry.aabbMin[2],
            entry.aabbMax[0],
            entry.aabbMax[1],
            entry.aabbMax[2],
        );
        box3.transformMat4(_worldAabb, _localAabb, getVisualWorldMatrix(transformTrait) as Mat4);
        any = true;
        if (_worldAabb[0] < minX) minX = _worldAabb[0];
        if (_worldAabb[1] < minY) minY = _worldAabb[1];
        if (_worldAabb[2] < minZ) minZ = _worldAabb[2];
        if (_worldAabb[3] > maxX) maxX = _worldAabb[3];
        if (_worldAabb[4] > maxY) maxY = _worldAabb[4];
        if (_worldAabb[5] > maxZ) maxZ = _worldAabb[5];
    }

    // VoxelMeshTrait nodes are also rendered via voxelMeshVisuals — their bounds
    // are recorded on each VoxelModel's own bounds. for now they are likely
    // covered by their stamped voxels (if any). future: add VoxelMeshTrait
    // bounds collection here.

    if (!any) return null;
    return [minX, minY, minZ, maxX, maxY, maxZ];
}
