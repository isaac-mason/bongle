// ── voxel remesh ────────────────────────────────────────────────────
//
// Turning a chunk into an arena entry: mesh it (unless all-air or fully
// occluded) and upsert the result into the packer, or evict a stale entry.
// Shared by the live worker-drain (voxel-visuals, which meshes off-thread and
// writes the result here) and the offline synchronous icon bakers (block-icons /
// prefab-icons, which mesh on the main thread via `remeshChunkInto`).

import type { Blocks } from '../../core/voxels/block-registry';
import { buildMeshInput, type ChunkMeshResult, type MeshOutput, meshChunk } from '../../core/voxels/chunk-mesher';
import { CHUNK_VOLUME, type Chunk, chunkKey, type Voxels } from '../../core/voxels/voxels';
import { packerEvictChunk, packerHas, packerUpsertChunk, type VoxelArena } from './voxel-arena';

/** a fully-opaque chunk whose 6 face-neighbors are all fully opaque has no
 *  visible surface: every boundary face is culled against a solid neighbor
 *  and the interior self-culls. Such a chunk can skip meshing entirely and
 *  have its arena entry evicted, exactly like an all-air chunk.
 *
 *  A missing neighbor (unloaded, or the world edge) counts as non-occluding,
 *  so the exposed face still meshes. This is safe because any state change
 *  that could reveal a face already re-dirties this chunk: a boundary block
 *  edit in a neighbor (applyVoxelChunkOps) and a neighbor chunk load/update
 *  (dirtyAllNeighborChunks) both mark it dirty for face-cull reasons, so the
 *  occlusion test is re-evaluated before the newly-exposed face could show. */
export function hasNoVisibleSurface(chunk: Chunk): boolean {
    if (chunk.solidCount !== CHUNK_VOLUME) return false;
    for (let dir = 0; dir < 6; dir++) {
        const neighbor = chunk.neighbors[dir];
        if (neighbor === null || neighbor.solidCount !== CHUNK_VOLUME) return false;
    }
    return true;
}

/** upsert a mesh result into the engine-global arena packer (or evict if the chunk
 *  is all-air / has no geometry). Called from the live worker-drain path and from
 *  {@link remeshChunkInto}. */
export function writeChunkMesh(arenas: VoxelArena, key: string, chunk: Chunk, mesh: ChunkMeshResult | null): void {
    const packer = arenas.packer;
    if (mesh === null || chunk.nonAirCount === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

/** Synchronously mesh a chunk (unless all-air or fully occluded) and place it in the
 *  arena at its own key/origin. The main-thread path used by the offline icon bakers,
 *  which fill the arena directly instead of dispatching to the worker pool.
 *  `meshOutput` is caller-owned scratch, reused across chunks. Returns the mesh (or
 *  null when the chunk was skipped/evicted) so a caller can, e.g., skip rendering an
 *  empty tile. */
export function remeshChunkInto(
    arenas: VoxelArena,
    voxels: Voxels,
    registry: Blocks,
    chunk: Chunk,
    meshOutput: MeshOutput,
): ChunkMeshResult | null {
    const mesh =
        chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)
            ? null
            : meshChunk(meshOutput, buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
    writeChunkMesh(arenas, chunkKey(chunk.cx, chunk.cy, chunk.cz), chunk, mesh);
    return mesh;
}
