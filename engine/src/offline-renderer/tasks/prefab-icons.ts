// renders all prefabs into a 256-px-tile icon atlas. spins up a real
// headless ClientRoom (createOfflineRoom in client/rooms.ts), drives the same Prefab
// instantiation + visuals update path the live editor uses, and renders
// each prefab's full scene through a per-pass RenderPipeline tied to an
// isometric ortho camera.
//
// per prefab:
//   1. attach a node with prefab=createPrefabConfig(...) under the room root
//   2. Prefab.tick → instantiates scene children, runs apply(), stamps voxels (mode='play')
//   3. wait for any referenced models to load + upload to GPU pools
//   4. snapshot transforms + interpolate so interpolatedWorldMatrix is fresh
//   5. update voxel + model visuals
//   6. compute scene AABB → fitOrthoIsometric → fresh per-pass pipeline
//   7. Renderer.render (cull computes + pipeline.render) → captureTile
//   8. tear down prefab anchor + clear voxels for next iteration
//
// Always-render now: hash-gating lives in the orchestrator.

import type { ComputeDispatch } from 'gpucat';
import type { EngineClient } from '../../client/engine-client';
import * as ModelResources from '../../client/models/model-resources';
import { meshInfoIndexOf } from '../../client/models/model-resources';
import * as ModelVisuals from '../../client/models/model-visuals';
import { type ClientRoom, clearRoomVoxels, createOfflineRoom, disposeRoom } from '../../client/rooms';
import * as Renderer from '../../client/renderer';
import * as VoxelMeshVisuals from '../../client/voxels/voxel-mesh-visuals';
import * as VoxelVisuals from '../../client/voxels/voxel-visuals';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import { getVisualWorldMatrix } from '../../api/transforms';
import { AIR, MISSING } from '../../core/voxels/block-registry';
import { CHUNK_SIZE, markChunkDirty, voxelIndex } from '../../core/voxels/voxels';
import * as Resources from '../../core/resources';
import {
    addChild,
    createNode,
    createPrefabConfig,
    destroyNode,
    query,
} from '../../core/scene/nodes';
import { registry as engineRegistry } from '../../core/registry';
import * as Prefab from '../../core/scene/prefab';
import * as Interpolation from '../../client/interpolation';
import * as Transforms from '../../builtins/transform';
import { box3, type Box3, type Mat4 } from 'mathcat';
import { fitOrthoIsometric } from '../camera-fit';
import { beginSnapshotSession, captureTile, endSnapshotSession } from '../snapshot';

const PREFAB_ICON_PX = 256;

/** poll budget for async loads (atlas + models + cull-compute compile). */
const WAIT_TIMEOUT_MS = 5000;
const WAIT_STEP_MS = 16;
/** post-upload settle for image decode + atlas patch — generous so textures land. */
const TEXTURE_SETTLE_MS = 300;

export type PrefabIconAtlasResult = {
    /** tightly-packed RGBA8 atlas pixels, length = atlasWidth*atlasHeight*4. */
    pixels: Uint8Array;
    atlasWidth: number;
    atlasHeight: number;
    coords: Record<string, [number, number]>;
    iconPx: number;
    cols: number;
    rows: number;
};

export async function runPrefabIcons(state: EngineClient): Promise<PrefabIconAtlasResult> {
    const prefabs = Array.from(engineRegistry.prefabs.byId.values())
        .map((h) => h.payload)
        .sort((a, b) => a.id.localeCompare(b.id));
    console.log(`[prefab-icons] prefabs: ${prefabs.length}`);

    if (prefabs.length === 0) {
        return {
            pixels: new Uint8Array(0),
            atlasWidth: 0,
            atlasHeight: 0,
            coords: {},
            iconPx: PREFAB_ICON_PX,
            cols: 0,
            rows: 0,
        };
    }

    const cols = Math.ceil(Math.sqrt(prefabs.length));
    const rows = Math.ceil(prefabs.length / cols);
    const atlasWidth = cols * PREFAB_ICON_PX;
    const atlasHeight = rows * PREFAB_ICON_PX;
    const atlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);
    console.log(`[prefab-icons] grid: ${cols}x${rows}, atlas: ${atlasWidth}x${atlasHeight}`);

    const room = createOfflineRoom(state);

    // wait for the atlas + cull-compute compiles before any render.
    await state.voxelResources.atlasReady;
    await waitFor(
        () => room.modelVisuals.cullCompute !== null,
        'cull computes',
    );

    // pre-load every registered model before the per-prefab loop. Prefab.tick
    // doesn't gate on AST-detected deps (only user-declared `deps: [...]`),
    // and most prefab bodies dereference ModelHandle.scene / .meshes inside
    // `fn` — without a loaded payload, `cloneModel(undefined)` throws and
    // the prefab's coord never lands. The per-render wait further down only
    // covers MeshTraits already in the room, which don't exist when tick
    // was a no-op. Eager-loading once here is cheaper than per-prefab and
    // covers prefabs that don't declare deps explicitly.
    await preloadAllModels(state);

    const session = beginSnapshotSession(state.renderer.renderer, PREFAB_ICON_PX, atlasPixels, atlasWidth);

    const coords: Record<string, [number, number]> = {};

    try {
        for (let i = 0; i < prefabs.length; i++) {
            const def = prefabs[i]!;
            const col = i % cols;
            const row = Math.floor(i / cols);

            const ok = await renderOne(state, room, def, session, col, row);
            if (ok) coords[def.id] = [col, row];

            // tear down for next prefab
            for (const child of [...room.nodes.root.children]) destroyNode(room.nodes, child);
            clearRoomVoxels(room, state.voxelResources);
        }
    } finally {
        endSnapshotSession(session);
        disposeRoom(room);
    }

    return { pixels: atlasPixels, atlasWidth, atlasHeight, coords, iconPx: PREFAB_ICON_PX, cols, rows };
}

async function renderOne(
    state: EngineClient,
    room: ClientRoom,
    def: { id: string; args?: { default: unknown } },
    session: ReturnType<typeof beginSnapshotSession>,
    col: number,
    row: number,
): Promise<boolean> {
    // attach a prefab anchor under the room root. mode='play' on the room
    // means Prefab.tick stamps voxels into the world automatically.
    const anchor = createNode({ name: def.id });
    anchor.prefab = createPrefabConfig(def.id, {
        args: def.args ? structuredClone(def.args.default) : {},
    });
    addChild(room.nodes.root, anchor);

    try {
        Prefab.tick(room.nodes, room.scriptRuntime, state.resources, room.voxels, 'client');
    } catch (e) {
        console.warn(`[prefab-icons] "${def.id}" Prefab.tick threw — skipping:`, e);
        return false;
    }

    // collect referenced models from the instantiated tree, kick off
    // loads, and wait for payloads to land. Models referenced via
    // MeshTrait pull from state.resources (client-global, shared across rooms).
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
            }, `models for "${def.id}"`);
        } catch (e) {
            console.warn(`[prefab-icons] "${def.id}":`, e);
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
            }, `meshInfo for "${def.id}"`);
        } catch (e) {
            console.warn(`[prefab-icons] "${def.id}":`, e);
        }

        // give image decode + atlas blit a beat to land before rendering.
        await new Promise((r) => setTimeout(r, TEXTURE_SETTLE_MS));
    }

    // populate world transforms + interpolated matrices for ModelVisuals.
    Interpolation.snapshot(room.interpolation);
    Transforms.computeWorldTransforms(room.nodes);
    Interpolation.interpolate(room.interpolation, 1.0, null);

    // force fully-lit voxels: no light propagation runs in the offline-renderer,
    // so without this every stamped voxel renders pitch-black. 0xFFFF =
    // packLight(15, 15, 15, 15) — max sky + max RGB across every voxel.
    for (const chunk of room.voxels.chunks.values()) {
        chunk.light.fill(0xffff);
        markChunkDirty(room.voxels, chunk);
    }

    // refresh voxel chunk meshes for any chunks the prefab stamped.
    VoxelVisuals.update(room.voxelVisuals, state.voxelResources, room.voxels, room.voxels.registry, undefined, Infinity);

    // compute scene AABB. needs to happen BEFORE the visuals updates so
    // the camera matches the camera those updates use for frustum culling.
    const aabb = computeSceneAabb(room, state);
    if (!aabb) {
        // nothing renderable
        return false;
    }

    // small margin — AABB is tight (per-voxel + per-mesh) and the square frustum
    // already centers non-square content.
    const camera = fitOrthoIsometric([aabb[0], aabb[1], aabb[2]], [aabb[3], aabb[4], aabb[5]], { margin: 1.02 });

    // render previews unlit — icon thumbnails should read flat and consistent
    // regardless of where the prefab would have stood under a real sky.
    // (chunk voxels are still affected by the 0xFFFF light fill above; this
    // covers MeshTrait + VoxelMeshTrait instances which have their own paths.)
    for (const [meshTrait] of query(room.nodes, [MeshTrait])) {
        meshTrait.unlit = true;
        meshTrait._version++;
    }
    for (const [vmTrait] of query(room.nodes, [VoxelMeshTrait])) {
        vmTrait.unlit = true;
    }

    // now run model + voxel-mesh visuals updates. voxel-mesh culls on the
    // CPU per-trait via BoundsTrait; voxel-visuals still needs the camera.
    VoxelMeshVisuals.update(room.voxelMeshVisuals, room.voxels);
    ModelVisuals.update(room.modelVisuals, state.modelResources, state.resources);

    room.scene.updateWorldMatrix();
    VoxelVisuals.cullCPU(state.voxelResources, camera, Infinity);

    // build a per-pass pipeline tied to the framing camera. offline icons
    // don't go through the engine-global pipeline (custom camera/framing
    // + transparent clear + no fog/tint) — drive cull + render directly.
    const pipeline = Renderer.createOfflinePipeline(state.renderer, room.scene, camera);
    try {
        const gpuRenderer = state.renderer.renderer;
        const dispatches: ComputeDispatch[] = [];
        for (const d of VoxelVisuals.expandDispatches(state.voxelResources)) dispatches.push(d);
        gpuRenderer.beginFrame();
        gpuRenderer.compute(dispatches);
        pipeline.render();
        gpuRenderer.endFrame();
        await captureTile(session, col, row);
    } finally {
        pipeline.dispose();
    }

    return true;
}

/* ── AABB collection ──────────────────────────────────────────────── */

const _localAabb: Box3 = box3.create();
const _worldAabb: Box3 = box3.create();

/**
 * Compute the union AABB of the room's renderable content:
 *   - voxels (tight per-voxel scan, skipping AIR/MISSING — single 1-voxel
 *     prefabs get a 1-unit AABB, not a 16-unit chunk-aligned one)
 *   - MeshTrait+TransformTrait nodes (per-mesh local AABB transformed by world matrix)
 *
 * Returns null if there's nothing to render.
 */
function computeSceneAabb(room: ClientRoom, state: EngineClient): [number, number, number, number, number, number] | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
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
                    const vx = wx + x, vy = wy + y, vz = wz + z;
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

/* ── async helpers ────────────────────────────────────────────────── */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
    const start = performance.now();
    while (!predicate()) {
        if (performance.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out: ${label}`);
        }
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    }
}

async function preloadAllModels(state: EngineClient): Promise<void> {
    const ids = Array.from(state.resources.models.keys());
    if (ids.length === 0) return;
    for (const id of ids) Resources.ensureModel(state.resources, id);
    try {
        await waitFor(() => {
            for (const id of ids) if (!Resources.hasModel(state.resources, id)) return false;
            return true;
        }, `all models (${ids.length})`);
    } catch (e) {
        console.warn('[prefab-icons] preloadAllModels:', e);
    }
    ModelResources.update(state.modelResources, state.resources);
    await new Promise((r) => setTimeout(r, TEXTURE_SETTLE_MS));
}
