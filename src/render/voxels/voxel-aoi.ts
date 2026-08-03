// ── voxel AOI (area of interest) ─────────────────────────────────────
//
// The policy layer for voxel visuals: the one thing that decides which chunks are
// live for visuals. Given the camera plus the world's dirty set, it prioritises which
// chunks to (re)mesh and queues them to the mesh worker pool; empty / fully-occluded
// chunks it forgets. It decides; it does not execute meshing (the mesher) or store
// meshes (the producer).
//
// Arena-free: no-visible-surface chunks are staged onto a `toForget` list the
// consumer evicts, and eviction is reactive (driven by the consumer). The scheduling
// state is held on `VoxelVisuals`, which structurally satisfies `VoxelAoiState`.

import type { Vec3 } from 'mathcat';
import { CHUNK_SIZE, type Chunk, chunkKey, NEIGHBOR_COUNT, type Voxels } from '../../core/voxels/voxels';
import { isInFlight, type Mesher, queueMesh } from './mesher';
import { hasNoVisibleSurface } from './voxel-arena';

/** frames a chunk can sit dirty before starvation boost kicks in. */
const STARVATION_GRACE_FRAMES = 30;
const STARVATION_BOOST_PER_FRAME = (CHUNK_SIZE * CHUNK_SIZE) / 2;

/** frames a streaming chunk waits for its full 26-neighbourhood to arrive before
 *  meshing anyway. covers the view frontier (outer neighbours are beyond the stream
 *  radius and never come) and slow streams. */
const NEIGHBOURHOOD_GRACE_FRAMES = 20;

/** chunks within this Chebyshev radius of the camera's chunk dispatch urgently (jump
 *  the worker queue), so the block you're editing meshes next frame instead of behind
 *  streaming backlog. CHUNK_SIZE=16, so 2 chunks is the chunk you're in plus its ring. */
const URGENT_REMESH_RADIUS_CHUNKS = 2;

/** the scheduling memory the AOI reads and updates each frame. `VoxelVisuals`
 *  structurally satisfies this shape. */
export type VoxelAoiState = {
    frame: number;
    /** chunk key to frame first seen dirty; the starvation-boost bookkeeping. */
    dirtyFirstSeen: Map<string, number>;
    /** one-shot: closest N candidates dispatched URGENT after a room swap. */
    roomSwapUrgentBurst: number;
};

/** Re-dirty chunks whose worker crashed so the next scan re-dispatches them. The
 *  dispatcher already cleared its in-flight tracking + replenished the buffer pool;
 *  we just re-flip the dirty bit. */
export function reDirtyLost(dispatcher: Mesher, voxels: Voxels): void {
    if (dispatcher.lost.length === 0) return;
    const lost = dispatcher.lost;
    for (let i = 0; i < lost.length; i++) {
        const chunk = voxels.chunks.get(lost[i]!);
        if (!chunk) continue;
        chunk.dirty = true;
        voxels.dirty.blocks.add(chunk);
    }
    lost.length = 0;
}

/**
 * Prioritised remesh scan. Sort dirty chunks by squared distance from the camera (minus a
 * starvation boost) and dispatch each off-thread: URGENT when within
 * URGENT_REMESH_RADIUS Chebyshev of the camera or under the room-swap burst;
 * otherwise normal-tier with starvation spill. Streaming chunks defer until their
 * full 26-neighbourhood has arrived (so they mesh once with correct boundary AO),
 * unless urgent or past NEIGHBOURHOOD_GRACE_FRAMES. Empty / fully-occluded chunks are
 * staged onto `toForget` (arena-free) for the consumer to evict. Each successful
 * enqueue clears the chunk's dirty bit + drops it from `voxels.dirty.blocks`; results
 * stage in `dispatcher.results` for the producer.
 *
 * Only queues work into the mesher; the caller runs `flushMeshQueue` itself AFTER
 * the producer has drained last frame's results, because the flush recycles output
 * buffers back to the workers and would detach them out from under an undrained
 * result (see mesher.ts). So the per-frame order is: scheduleDirtyChunks, then
 * consume (drain), then flushMeshQueue.
 */
export function scheduleDirtyChunks(
    aoi: VoxelAoiState,
    dispatcher: Mesher,
    voxels: Voxels,
    cameraPos: Vec3,
    deferIncomplete: boolean,
    toForget: string[],
): void {
    aoi.frame++; // the AOI owns its scan counter (starvation-boost bookkeeping).
    const cx = cameraPos[0];
    const cy = cameraPos[1];
    const cz = cameraPos[2];
    const remeshCandidates: { key: string; chunk: Chunk; score: number }[] = [];

    for (const chunk of voxels.dirty.blocks) {
        const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
        const dx = chunk.wx + CHUNK_SIZE * 0.5 - cx;
        const dy = chunk.wy + CHUNK_SIZE * 0.5 - cy;
        const dz = chunk.wz + CHUNK_SIZE * 0.5 - cz;
        const distSq = dx * dx + dy * dy + dz * dz;
        let firstSeen = aoi.dirtyFirstSeen.get(key);
        if (firstSeen === undefined) {
            firstSeen = aoi.frame;
            aoi.dirtyFirstSeen.set(key, firstSeen);
        }
        const boost = Math.max(0, aoi.frame - firstSeen - STARVATION_GRACE_FRAMES) * STARVATION_BOOST_PER_FRAME;
        remeshCandidates.push({ key, chunk, score: distSq - boost });
    }

    remeshCandidates.sort((a, b) => a.score - b.score);
    let roomSwapUrgentBurst = aoi.roomSwapUrgentBurst;
    aoi.roomSwapUrgentBurst = 0;

    const camCx = Math.floor(cx / CHUNK_SIZE);
    const camCy = Math.floor(cy / CHUNK_SIZE);
    const camCz = Math.floor(cz / CHUNK_SIZE);
    for (let i = 0; i < remeshCandidates.length; i++) {
        const { key, chunk } = remeshCandidates[i]!;

        // chunks with no visible geometry (all-air, or a fully-opaque interior boxed
        // in by fully-opaque neighbors) stage onto `toForget` for the consumer to evict,
        // rather than shipping a ~700 KB no-op job to a worker.
        if (chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)) {
            chunk.dirty = false;
            voxels.dirty.blocks.delete(chunk);
            aoi.dirtyFirstSeen.delete(key);
            toForget.push(key); // arena-free: the consumer evicts these
            continue;
        }

        if (isInFlight(dispatcher, key)) continue;

        const chebyshevChunks = Math.max(Math.abs(chunk.cx - camCx), Math.abs(chunk.cy - camCy), Math.abs(chunk.cz - camCz));
        let urgent = chebyshevChunks <= URGENT_REMESH_RADIUS_CHUNKS;
        if (!urgent && roomSwapUrgentBurst > 0) {
            urgent = true;
            roomSwapUrgentBurst--;
        }

        const firstSeen = aoi.dirtyFirstSeen.get(key);

        // streaming rooms: defer until the full 26-neighbourhood has arrived; urgent
        // chunks bypass; the view frontier falls through after NEIGHBOURHOOD_GRACE_FRAMES.
        if (deferIncomplete && !urgent && chunk.knownNeighbourCount < NEIGHBOR_COUNT) {
            const waited = firstSeen !== undefined && aoi.frame - firstSeen > NEIGHBOURHOOD_GRACE_FRAMES;
            if (!waited) continue;
        }

        // a starving normal-tier chunk spills off its (saturated) affinity worker to
        // any idle one instead of stalling. urgent bypasses the queue gate.
        const starving = firstSeen !== undefined && aoi.frame - firstSeen > STARVATION_GRACE_FRAMES;
        const ok = queueMesh(dispatcher, chunk, chunk.meshGen, urgent ? { urgent: true } : { allowSpill: starving });
        if (!ok) continue;
        chunk.dirty = false;
        voxels.dirty.blocks.delete(chunk);
        aoi.dirtyFirstSeen.delete(key);
    }
}
