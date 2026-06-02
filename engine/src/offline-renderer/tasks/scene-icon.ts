// renders one scene's icon. mirrors prefab-icons.ts but the subject is a
// `SceneHandle` (voxels + node children) rather than a prefab anchor — no
// Prefab.tick, just deserialize voxels into a fresh offline room and clone
// the handle's children under the room root.
//
//   1. look up SceneHandle by id from registry.scenes
//   2. deserialize the scene's voxels into a fresh offline room
//   3. clone every child of handle.node under room.nodes.root
//   4. wait for any referenced models to land
//   5. snapshot + interpolate, fill light, refresh voxel mesh
//   6. compute scene AABB → fitOrthoIsometric → per-pass pipeline
//   7. render → captureTile (one 256² tile)
//   8. dispose room
//
// Always-render now (returns pixels for any renderable scene; empty
// Uint8Array when nothing to render). Hash-gating + iteration over the
// scene set lives in the orchestrator.

import type { ComputeDispatch } from 'gpucat';
import type { EngineClient } from '../../client/engine-client';
import * as ModelResources from '../../client/models/model-resources';
import { meshInfoIndexOf } from '../../client/models/model-resources';
import * as ModelVisuals from '../../client/models/model-visuals';
import { type ClientRoom, createOfflineRoom, disposeRoom } from '../../client/rooms';
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
import { addChild, deserializeNode, query } from '../../core/scene/nodes';
import { loadVoxels } from '../../core/voxels/voxel-savefile';
import { registry as engineRegistry } from '../../core/registry';
import * as Interpolation from '../../client/interpolation';
import * as Transforms from '../../builtins/transform';
import { box3, type Box3, type Mat4 } from 'mathcat';
import { fitOrthoIsometric } from '../camera-fit';
import { beginSnapshotSession, captureTile, endSnapshotSession } from '../snapshot';

const SCENE_ICON_PX = 256;

const WAIT_TIMEOUT_MS = 5000;
const WAIT_STEP_MS = 16;
const TEXTURE_SETTLE_MS = 300;

export type SceneIconResult = {
    /** tightly-packed RGBA8 bytes, length = SCENE_ICON_PX² × 4. empty when
     *  the scene had nothing renderable (no voxels + no mesh nodes). */
    pixels: Uint8Array;
    pxSize: number;
};

/** Render a single scene's icon. Returns empty pixels if the scene isn't
 *  registered, the payload is missing, or there's nothing to render. */
export async function runSceneIcon(state: EngineClient, id: string): Promise<SceneIconResult> {
    const handleEntry = engineRegistry.scenes.byId.get(id);
    if (!handleEntry) {
        return { pixels: new Uint8Array(0), pxSize: SCENE_ICON_PX };
    }
    const handle = handleEntry.payload;

    const room = createOfflineRoom(state);
    await state.voxelResources.atlasReady;
    await waitFor(
        () => room.modelVisuals.cullCompute !== null,
        'cull computes',
    );

    const tileBuffer = new Uint8Array(SCENE_ICON_PX * SCENE_ICON_PX * 4);
    const session = beginSnapshotSession(state.renderer.renderer, SCENE_ICON_PX, tileBuffer, SCENE_ICON_PX);

    let rendered = false;
    try {
        rendered = await renderOne(state, room, handle, session);
    } finally {
        endSnapshotSession(session);
        disposeRoom(room);
    }

    if (!rendered) return { pixels: new Uint8Array(0), pxSize: SCENE_ICON_PX };
    return { pixels: new Uint8Array(tileBuffer), pxSize: SCENE_ICON_PX };
}

async function renderOne(
    state: EngineClient,
    room: ClientRoom,
    handle: { node: { children: ReadonlyArray<unknown> }; voxels: unknown; _payload: unknown },
    session: ReturnType<typeof beginSnapshotSession>,
): Promise<boolean> {
    // pull the authored payload — handle.node/voxels are mutated in place by
    // populateScene on every reload, but _payload holds the canonical
    // serialized form.
    const payload = handle._payload as
        | { nodes: { root: { children: unknown[] } }; voxels: import('../../core/voxels/voxel-savefile').SavedVoxels | null }
        | null;
    if (!payload) return false;

    if (payload.voxels) {
        try {
            loadVoxels(room.voxels, payload.voxels, room.voxels.registry);
        } catch (e) {
            console.warn('[scene-icon] loadVoxels failed — skipping:', e);
            return false;
        }
    }

    for (const childData of payload.nodes.root.children) {
        addChild(room.nodes.root, deserializeNode(childData as Parameters<typeof deserializeNode>[0]));
    }

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
            }, 'scene models');
        } catch (e) {
            console.warn('[scene-icon]', e);
        }

        ModelResources.update(state.modelResources, state.resources);

        try {
            await waitFor(() => {
                for (const key of meshKeys) {
                    if (meshInfoIndexOf(state.modelResources.meshInfo, key) === null) return false;
                }
                return true;
            }, 'scene meshInfo');
        } catch (e) {
            console.warn('[scene-icon]', e);
        }

        await new Promise((r) => setTimeout(r, TEXTURE_SETTLE_MS));
    }

    Interpolation.snapshot(room.interpolation);
    Transforms.computeWorldTransforms(room.nodes);
    Interpolation.interpolate(room.interpolation, 1.0, null);

    for (const chunk of room.voxels.chunks.values()) {
        chunk.light.fill(0xffff);
        markChunkDirty(room.voxels, chunk);
    }

    VoxelVisuals.update(room.voxelVisuals, state.voxelResources, room.voxels, room.voxels.registry, undefined, Infinity);

    const aabb = computeSceneAabb(room, state);
    if (!aabb) return false;

    const camera = fitOrthoIsometric([aabb[0], aabb[1], aabb[2]], [aabb[3], aabb[4], aabb[5]], { margin: 1.02 });

    for (const [meshTrait] of query(room.nodes, [MeshTrait])) {
        meshTrait.unlit = true;
        meshTrait._version++;
    }
    for (const [vmTrait] of query(room.nodes, [VoxelMeshTrait])) {
        vmTrait.unlit = true;
    }

    VoxelMeshVisuals.update(room.voxelMeshVisuals, room.voxels);
    ModelVisuals.update(room.modelVisuals, state.modelResources, state.resources);

    room.scene.updateWorldMatrix();
    VoxelVisuals.cullCPU(state.voxelResources, camera, Infinity);

    const pipeline = Renderer.createOfflinePipeline(state.renderer, room.scene, camera);
    try {
        const gpuRenderer = state.renderer.renderer;
        const dispatches: ComputeDispatch[] = [];
        for (const d of VoxelVisuals.expandDispatches(state.voxelResources)) dispatches.push(d);
        gpuRenderer.beginFrame();
        gpuRenderer.compute(dispatches);
        pipeline.render();
        gpuRenderer.endFrame();
        await captureTile(session, 0, 0);
    } finally {
        pipeline.dispose();
    }

    return true;
}

/* ── AABB collection ──────────────────────────────────────────────── */

const _localAabb: Box3 = box3.create();
const _worldAabb: Box3 = box3.create();

function computeSceneAabb(room: ClientRoom, state: EngineClient): [number, number, number, number, number, number] | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;

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

    if (!any) return null;
    return [minX, minY, minZ, maxX, maxY, maxZ];
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
    const start = performance.now();
    while (!predicate()) {
        if (performance.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out: ${label}`);
        }
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    }
}
