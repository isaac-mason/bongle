// WebGPU backend: per-room render visuals.
//
// The eight per-room visual sets (7 `*-visuals.ts` + the CanvasTrait overlay
// `domUi`, which builds a gpucat overlay material and is therefore renderer-
// concerned). Owned by the backend, keyed by the `ClientRoom` object in
// `renderer.rooms`. Bundles the init / per-frame update / dispose that used to be
// scattered across `rooms.ts` (create/dispose) and the `engine-client` frame loop.

import * as DomUi from '../../client/dom-ui';
import type { ClientRoom } from '../../client/rooms';
import * as Debug from '../../core/debug';
import type { UpdateRoomContext } from '../backend';
import * as Environment from '../common/environment/environment';
import * as ModelVisuals from '../common/models/model-visuals';
import * as ParticleVisuals from '../common/particles/particle-visuals';
import * as ShadowVisuals from '../common/shadows/shadow-visuals';
import * as ExtrudedSpriteVisuals from '../common/sprites/extruded-sprite-visuals';
import * as SpriteVisuals from '../common/sprites/sprite-visuals';
import * as VoxelArena from '../common/voxels/voxel-arena';
import * as VoxelMeshVisuals from '../common/voxels/voxel-mesh-visuals';
import * as VoxelVisuals from '../common/voxels/voxel-visuals';
import type { WebGpuState } from './index';

/** the per-room GPU visual sets, one bundle per live `ClientRoom`. */
export type RoomVisuals = {
    voxel: VoxelVisuals.VoxelVisuals;
    voxelMesh: VoxelMeshVisuals.VoxelMeshVisuals;
    model: ModelVisuals.ModelVisuals;
    domUi: DomUi.DomUi;
    sprite: SpriteVisuals.SpriteVisuals;
    extrudedSprite: ExtrudedSpriteVisuals.ExtrudedSpriteVisuals;
    shadow: ShadowVisuals.ShadowVisuals;
    particle: ParticleVisuals.ParticleVisuals;
    /** per-room env render state (sky/sun/moon/star meshes + cloud anchor).
     *  driven each frame from the room's client-side `environment` config. */
    env: Environment.EnvVisuals;
};

/**
 * build the room's visual bundle and store it in `renderer.rooms`, keyed by the
 * room object. Reads the room's scene graph (`scene` / `overlayScene` / `nodes` /
 * `viewport`) and the backend's client-global resources + env buffers + pipeline.
 * The caller (createRoomCore) must have populated those room fields first.
 */
export function createRoomVisuals(renderer: WebGpuState, room: ClientRoom): void {
    const res = renderer.resources;
    const { scene, overlayScene, nodes } = room;

    const voxel = VoxelVisuals.initRoomMeshes(scene, res.voxel);
    const voxelMesh = VoxelMeshVisuals.init(scene, nodes, res.voxelMesh);
    const model = ModelVisuals.init(scene, nodes, res.model);
    // CanvasTrait quads render in the overlay scene (crisp, post-fxaa); HtmlTrait
    // panels are DOM. the scene depth node lets canvas materials discard fragments
    // occluded by world geometry.
    const domUi = DomUi.init(overlayScene, room.viewport, nodes, renderer.pipeline.sceneDepthNode);
    const sprite = SpriteVisuals.init(scene, nodes, res.sprite);
    const extrudedSprite = ExtrudedSpriteVisuals.init(scene, nodes, res.extrudedSprite);
    const shadow = ShadowVisuals.init(scene, nodes, res.shadow);
    const particle = ParticleVisuals.init(scene, res.sprite, res.particle);
    // env render state: sky/sun/moon/star meshes + cloud anchor, drawn with the
    // engine-global env + cloud resources. The room's env *config* is client data
    // (`room.environment`) the renderer reads each frame.
    const env = Environment.initEnvVisuals(scene, renderer.environmentResources, res.cloud);

    renderer.rooms.set(room, { voxel, voxelMesh, model, domUi, sprite, extrudedSprite, shadow, particle, env });
}

/**
 * per-frame per-room visual update. Order + Debug labels mirror the old
 * engine-client frame loop exactly. The voxel mesher + arena metrics run only for
 * the active room (its world is the one resident in the arena); everything else
 * runs for every room the client holds.
 */
export function updateRoom(renderer: WebGpuState, room: ClientRoom, ctx: UpdateRoomContext): void {
    const rv = renderer.rooms.get(room);
    if (!rv) return;
    const res = renderer.resources;
    const { povCamera } = ctx;

    if (ctx.isActive) {
        Debug.begin(room.clientMetrics, 'mesh');
        // streaming rooms defer meshing a chunk until its 26-neighbourhood has
        // arrived (mesh once, correct AO/light); local rooms load all at once so
        // there's no trickle to dedupe — mesh immediately.
        VoxelVisuals.update(rv.voxel, res.voxel, room.voxels, room.voxels.registry, povCamera.position, !room.local);
        Debug.end(room.clientMetrics, 'mesh');

        // arena occupancy + fragmentation, recorded post-update so the sample
        // reflects this frame's allocs.
        if (room.clientMetrics.enabled) {
            const quadR = VoxelArena.arenaReport(res.voxel.arenas.quadArena);
            Debug.record(room.clientMetrics, 'voxels/arena/quad/usedPct', (100 * quadR.used) / quadR.slotCount, '%');
            Debug.record(
                room.clientMetrics,
                'voxels/arena/quad/largestFreePct',
                (100 * quadR.largestFree) / quadR.slotCount,
                '%',
            );
            Debug.record(room.clientMetrics, 'voxels/arena/quad/allocs', quadR.allocs, 'count');
        }
    }

    Debug.begin(room.clientMetrics, 'voxel-mesh');
    VoxelMeshVisuals.update(rv.voxelMesh, room.voxels, room.visibility);
    Debug.end(room.clientMetrics, 'voxel-mesh');

    Debug.begin(room.clientMetrics, 'model');
    ModelVisuals.update(rv.model, res.model, ctx.resources, room.visibility);
    Debug.end(room.clientMetrics, 'model');

    Debug.begin(room.clientMetrics, 'dom-ui');
    DomUi.update(rv.domUi, povCamera, ctx.viewport);
    Debug.end(room.clientMetrics, 'dom-ui');

    Debug.begin(room.clientMetrics, 'sprite');
    SpriteVisuals.update(rv.sprite, res.sprite, room.voxels, povCamera, room.visibility);
    Debug.end(room.clientMetrics, 'sprite');

    Debug.begin(room.clientMetrics, 'extruded-sprite');
    ExtrudedSpriteVisuals.update(rv.extrudedSprite, res.extrudedSprite, room.voxels, room.visibility);
    Debug.end(room.clientMetrics, 'extruded-sprite');

    Debug.begin(room.clientMetrics, 'shadow');
    ShadowVisuals.update(rv.shadow, room.voxels, povCamera);
    Debug.end(room.clientMetrics, 'shadow');

    // particle visuals reads pool[0..count) directly, no scene-graph traits. runs
    // after Particles.update (per-frame loop) so freshly-stepped positions feed
    // this frame's pose buffer.
    Debug.begin(room.clientMetrics, 'particle');
    ParticleVisuals.update(rv.particle, room.particles, room.voxels, ctx.now);
    Debug.end(room.clientMetrics, 'particle');
}

/** dispose the room's visual bundle and drop it from the map. Mirrors the prior
 *  disposeRoom order, including releasing the active world's arena chunks. */
export function disposeRoomVisuals(renderer: WebGpuState, room: ClientRoom): void {
    const rv = renderer.rooms.get(room);
    if (!rv) return;
    VoxelVisuals.dispose(rv.voxel, room.scene);
    // release the active world's chunks from the arena + mesh worker cache.
    VoxelVisuals.unmountRoom(renderer.resources.voxel);
    VoxelMeshVisuals.dispose(rv.voxelMesh, room.scene, room.visibility);
    ModelVisuals.dispose(rv.model, room.visibility);
    DomUi.dispose(rv.domUi);
    SpriteVisuals.dispose(rv.sprite, room.visibility);
    ExtrudedSpriteVisuals.dispose(rv.extrudedSprite, renderer.resources.extrudedSprite, room.visibility);
    ShadowVisuals.dispose(rv.shadow);
    ParticleVisuals.dispose(rv.particle);
    Environment.disposeEnvVisuals(rv.env);
    renderer.rooms.delete(room);
}

/** mount the room's world into the (single-world) voxel arena, marking chunks
 *  dirty so the prioritised remesh path refills it. */
export function mountRoom(renderer: WebGpuState, room: ClientRoom): void {
    const rv = renderer.rooms.get(room);
    if (!rv) return;
    VoxelVisuals.mountRoom(rv.voxel, room.voxels);
}

/** release the currently-mounted world's arena chunks + mesh worker cache. */
export function unmountRoom(renderer: WebGpuState): void {
    VoxelVisuals.unmountRoom(renderer.resources.voxel);
}

/**
 * HMR: rebuild a room's voxel + voxel-mesh visuals against freshly-swapped
 * resources. The engine-global arenas/geometries/materials moved to the new
 * `renderer.resources.voxel`/`voxelMesh`; the old per-room meshes still point at
 * the disposed ones, so drop + re-init.
 */
export function rebuildVoxelVisuals(renderer: WebGpuState, room: ClientRoom): void {
    const rv = renderer.rooms.get(room);
    if (!rv) return;
    VoxelVisuals.dispose(rv.voxel, room.scene);
    VoxelMeshVisuals.dispose(rv.voxelMesh, room.scene, room.visibility);
    rv.voxel = VoxelVisuals.initRoomMeshes(room.scene, renderer.resources.voxel);
    rv.voxelMesh = VoxelMeshVisuals.init(room.scene, room.nodes, renderer.resources.voxelMesh);
}

/**
 * HMR: rebuild a room's extruded-sprite visuals after the sprite atlas swapped.
 * Its alive states hold now-dangling GeometrySlot refs into the cleared pool;
 * dropping them lets next frame's update lazily re-acquire into the fresh pool.
 */
export function rebuildExtrudedSpriteVisuals(renderer: WebGpuState, room: ClientRoom): void {
    const rv = renderer.rooms.get(room);
    if (!rv) return;
    ExtrudedSpriteVisuals.dispose(rv.extrudedSprite, renderer.resources.extrudedSprite, room.visibility);
    rv.extrudedSprite = ExtrudedSpriteVisuals.init(room.scene, room.nodes, renderer.resources.extrudedSprite);
}
