/**
 * src/asset-pipeline/rooms.ts, the offline asset pipeline's room.
 *
 * A third room composition alongside `src/client` (createRoomCore) and
 * `src/server`. Like the server, it builds the engine's core simulation
 * primitives itself (voxels, nodes, physics, clock, a NodesContext) rather than
 * reusing the client's `createRoomCore`. On top of the core it adds ONLY the
 * render subsystems an icon render needs: a Scene + voxel/voxel-mesh/model
 * visuals + a (disabled) Environment + visibility + interpolation.
 *
 * Deliberately absent, the asset pipeline never needs them: canvas / viewport /
 * touch overlay / dom-ui (no presentation), input, audio, sprite / extruded /
 * particle / cloud-presentation / shadow visuals, networking, multi-room
 * bookkeeping, a player/camera node (tasks build their own framing camera), and
 * ModelLighting (icons render unlit, see asset-pipeline/subject.ts).
 */

import { Scene } from 'gpucat';
import { ENVIRONMENT_DEFAULT } from '../api/environment';
import { attachWorldTrait } from '../builtins/world';
import type { PlayerId } from '../core/client';
import * as Clock from '../core/clock';
import * as Physics from '../core/physics/physics';
import { registry } from '../core/registry';
import type { Resources } from '../core/resources';
import * as Rpc from '../core/rpc';
import * as Nodes from '../core/scene/nodes';
import type { NodesContext } from '../core/scene/scripts';
import * as Voxels from '../core/voxels/voxels';
import type * as CloudResources from '../render/cloud-resources';
import * as Environment from '../render/environment';
import * as Interpolation from '../render/interpolation';
import type * as ModelResources from '../render/models/model-resources';
import * as ModelVisuals from '../render/models/model-visuals';
import type * as Renderer from '../render/renderer';
import * as Visibility from '../render/visibility';
import type * as VoxelMeshResources from '../render/voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from '../render/voxels/voxel-mesh-visuals';
import type * as VoxelResources from '../render/voxels/voxel-resources';
import * as VoxelVisuals from '../render/voxels/voxel-visuals';

/** No real player exists offline; Interpolation needs a PlayerId. No node is
 *  owned by this id, so every node interpolates uniformly, fine for a static
 *  icon frame. */
const ASSET_PIPELINE_PLAYER_ID = -1 as PlayerId;

/** The offline path never networks or fires script hooks, but NodesContext
 *  requires an rpc driver. Drop everything. */
const NOOP_RPC_DRIVER: Rpc.RpcDriver = {
    send() {},
    broadcast() {},
};

export type AssetPipelineRoom = {
    scene: Scene;
    nodes: Nodes.Nodes;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    scriptRuntime: NodesContext;
    environment: Environment.Environment;
    voxelVisuals: VoxelVisuals.VoxelVisuals;
    voxelMeshVisuals: VoxelMeshVisuals.VoxelMeshVisuals;
    modelVisuals: ModelVisuals.ModelVisuals;
    visibility: Visibility.Visibility;
    interpolation: Interpolation.Interpolation;
};

/** Engine-global resources the room's per-room visuals reference (built once in
 *  EngineAssetPipeline.load, shared across every room this run). */
export type AssetPipelineRoomDeps = {
    resources: Resources;
    renderer: Renderer.Renderer;
    voxelResources: VoxelResources.VoxelResources;
    voxelMeshResources: VoxelMeshResources.VoxelMeshResources;
    modelResources: ModelResources.ModelResources;
    cloudResources: CloudResources.CloudResources;
};

export function createRoom(deps: AssetPipelineRoomDeps): AssetPipelineRoom {
    const blocks = registry.blockRegistry;
    const env = deps.renderer.environmentResources;

    const voxels = Voxels.createVoxels(blocks);
    const nodes = Nodes.createSceneGraph({ mode: 'play', roomMode: 'play' });
    const physics = Physics.init(nodes, voxels, blocks);
    const clock = Clock.init();
    const scene = new Scene();

    const scriptRuntime: NodesContext = {
        roomId: 'asset-pipeline',
        resources: deps.resources,
        rpc: Rpc.init(NOOP_RPC_DRIVER),
        client: undefined,
        server: undefined,
        voxels,
        physics,
        clock,
        blocks,
        instances: new Map(),
    };
    nodes.runtime = scriptRuntime;

    const environment = Environment.init(scene, env, ENVIRONMENT_DEFAULT, deps.cloudResources);
    const voxelVisuals = VoxelVisuals.initRoomMeshes(scene, deps.voxelResources);
    const voxelMeshVisuals = VoxelMeshVisuals.init(scene, nodes, deps.voxelMeshResources, env);
    const modelVisuals = ModelVisuals.init(scene, nodes, deps.modelResources, env);
    const visibility = Visibility.init();
    const interpolation = Interpolation.init(nodes, ASSET_PIPELINE_PLAYER_ID);

    // host trait at the root, its env onInit no-ops offline (no live scene
    // graph init runs), matching the client's offline room.
    attachWorldTrait(nodes.root);

    return {
        scene,
        nodes,
        voxels,
        physics,
        clock,
        scriptRuntime,
        environment,
        voxelVisuals,
        voxelMeshVisuals,
        modelVisuals,
        visibility,
        interpolation,
    };
}

export function disposeRoom(room: AssetPipelineRoom): void {
    Physics.dispose(room.physics);
    VoxelVisuals.dispose(room.voxelVisuals, room.scene);
    VoxelMeshVisuals.dispose(room.voxelMeshVisuals, room.scene, room.visibility);
    ModelVisuals.dispose(room.modelVisuals, room.visibility);
    Environment.dispose(room.environment);
}
