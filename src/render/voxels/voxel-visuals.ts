// ── voxel world renderer (per-room mesh wrappers) ───────────────────
//
// Per-room renderer state for voxel chunks: the 3 per-pass `Mesh` instances added
// to the room's `Scene` (each wrapping the active backend's engine-global per-pass
// `Geometry` + quad `Material`), plus the per-room AOI scheduling memory (frame
// counter + starvation bookkeeping + room-swap urgent burst).
//
// This is only the per-room half of the frame. The engine-global arena, the
// prioritised remesh scan, and the per-backend consume + cull all live elsewhere:
// the backend's `voxel-resources-*` owns the arena + `consume`, `voxel-aoi` owns
// the scan, and the per-backend render loop drives them. `VoxelVisuals`
// structurally satisfies `voxel-aoi`'s `VoxelAoiState`, so the loop passes it in
// directly as the scheduling memory.

import type { Geometry, Material, Scene } from 'gpucat';
import { Mesh } from 'gpucat';

import type { Voxels } from '../../core/voxels/voxels';
import type { MeshPerf } from './mesher';
import { PASSES } from './voxel-arena';
import type { VoxelPass } from './voxel-material';

export type VoxelVisuals = {
    /** per-room `Mesh` instances added to the room's `Scene`. each wraps
     *  one engine-global `Geometry` + `Material` pair; swapping room is
     *  free (just hide/show the meshes via the scene). */
    meshes: Record<VoxelPass, Mesh>;
    /** frame counter, bumped by the AOI's `scheduleDirtyChunks` each scan. used for
     *  the starvation boost. */
    frame: number;
    /** chunk key to frame at which it was first observed dirty (remesh). cleared on remesh. */
    dirtyFirstSeen: Map<string, number>;
    /** one-shot count of closest dirty chunks to dispatch URGENT on the next scan.
     *  set by `mountRoom` so a freshly-mounted room fills a chunk halo around the
     *  camera immediately (urgent jumps the worker queue) instead of trickling in
     *  over normal-tier streaming. Zeroed after consumed. */
    roomSwapUrgentBurst: number;
    /** last frame's mesh-dispatch perf (main-thread build vs postMessage split,
     *  posts/frame, worker time). drained from the mesher each frame by the per-
     *  backend render loop; read by the debug HUD / console. null until the first
     *  dispatched frame. */
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

/** closest dirty chunks dispatched urgently on the first frame after a room is
 *  mounted (`mountRoom`), so the scene fills in immediately instead of
 *  trickling in behind normal-tier streaming. */
const ROOM_SWAP_URGENT_BURST = 20;

/** Mount a room into the active backend's arena: mark every non-empty chunk dirty
 *  so the prioritised remesh path meshes it in over the next few frames. Per-room
 *  and additive; does not touch any other room's residency (no arena-wide clear).
 *  Call when a room becomes active, or after an arena rebuild. Pairs with the
 *  backend producer's `unmountRoom`.
 *
 *  (Skips nonAirCount=0 chunks: sparse "discovered empty" stubs pushed by
 *  `voxel_chunk_empty` that have no blocks to mesh and would only pollute the
 *  remesh candidate scan.) */
export function mountRoom(state: VoxelVisuals, voxels: Voxels): void {
    for (const chunk of voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        chunk.dirty = true;
        voxels.dirty.blocks.add(chunk);
    }
    // fresh arena for this room: any pending removals from a prior residency are
    // moot (nothing of theirs is in the arena now).
    voxels.dirty.removed.clear();
    state.dirtyFirstSeen.clear();
    state.roomSwapUrgentBurst = ROOM_SWAP_URGENT_BURST;
}

export function dispose(state: VoxelVisuals, scene: Scene): void {
    for (const pass of PASSES) {
        scene.remove(state.meshes[pass]!);
    }
}
