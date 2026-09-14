import type { Geometry, Material, Scene } from 'gpucat';
import { Mesh } from 'gpucat';

import type { Voxels } from '../../core/voxels/voxels';
import type { MeshPerf } from './mesher';
import { PASSES } from './voxel-arena';
import type { VoxelPass } from './voxel-material';

export type VoxelVisuals = {
    /** wraps one engine-global Geometry + Material pair; swapping room just hides/shows via the scene. */
    meshes: Record<VoxelPass, Mesh>;
    /** bumped by scheduleDirtyChunks each scan; drives the starvation boost. */
    frame: number;
    /** chunk key to frame at which it was first observed dirty. cleared on remesh. */
    dirtyFirstSeen: Map<string, number>;
    /** count of closest dirty chunks to dispatch urgently on the next scan, set by mountRoom. */
    roomSwapUrgentBurst: number;
    /** last frame's mesh-dispatch perf, read by the debug HUD. null until the first dispatched frame. */
    lastMeshPerf: MeshPerf | null;
};

export function initRoomMeshes(
    scene: Scene,
    geometries: Record<VoxelPass, Geometry>,
    quadMaterials: Record<VoxelPass, Material>,
): VoxelVisuals {
    const meshes = {} as Record<VoxelPass, Mesh>;
    for (const pass of PASSES) {
        const mesh = new Mesh(geometries[pass], quadMaterials[pass]);
        mesh.name = `voxel-visuals-${pass}`;
        mesh.frustumCulled = false; // CPU cull is upstream of the draw.
        scene.add(mesh);
        meshes[pass] = mesh;
    }
    return {
        meshes,
        frame: 0,
        dirtyFirstSeen: new Map(),
        roomSwapUrgentBurst: 0,
        lastMeshPerf: null,
    };
}

/** dirty chunks dispatched urgently on the first frame after mountRoom, so the scene fills in immediately. */
const ROOM_SWAP_URGENT_BURST = 20;

/** Marks every non-empty chunk dirty so the prioritised remesh path meshes them in over the next few frames.
 *  Per-room and additive; does not touch any other room's residency. Pairs with the backend producer's unmountRoom. */
export function mountRoom(state: VoxelVisuals, voxels: Voxels): void {
    for (const chunk of voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        chunk.dirty = true;
        voxels.dirty.blocks.add(chunk);
    }
    voxels.dirty.removed.clear();
    state.dirtyFirstSeen.clear();
    state.roomSwapUrgentBurst = ROOM_SWAP_URGENT_BURST;
}

export function dispose(state: VoxelVisuals, scene: Scene): void {
    for (const pass of PASSES) {
        scene.remove(state.meshes[pass]!);
    }
}
