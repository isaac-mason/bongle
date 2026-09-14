import type { Vec3 } from 'math';
import { CHUNK_SIZE, type Chunk, chunkKey, NEIGHBOR_COUNT, type Voxels } from '../../core/voxels/voxels';
import { isInFlight, type Mesher, queueMesh } from './mesher';
import { hasNoVisibleSurface } from './voxel-arena';
import { type LightVolume, lookupPayload, withinLightGrid } from './voxel-light-volume';

/** camera chunk coords, reused per scan. */
const _camChunk: Vec3 = [0, 0, 0];

/** frames a chunk can sit dirty before starvation boost kicks in. */
const STARVATION_GRACE_FRAMES = 30;
const STARVATION_BOOST_PER_FRAME = (CHUNK_SIZE * CHUNK_SIZE) / 2;

/** frames a streaming chunk waits for its full 26-neighbourhood before meshing anyway,
 *  covering the view frontier (outer neighbours never arrive) and slow streams. */
const NEIGHBOURHOOD_GRACE_FRAMES = 20;

/** Chebyshev radius (in chunks) that dispatches urgently, jumping the worker queue. */
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

/** Re-dirty chunks whose worker crashed so the next scan re-dispatches them. */
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
 * Prioritised remesh scan: sorts dirty chunks by squared distance from the camera (minus a
 * starvation boost) and dispatches each off-thread, urgent within URGENT_REMESH_RADIUS_CHUNKS
 * or under the room-swap burst, otherwise normal-tier with starvation spill.
 *
 * Only queues work into the mesher; the caller must run flushMeshQueue itself after the
 * producer has drained last frame's results, since flushing recycles output buffers back
 * to the workers and would detach them out from under an undrained result. Per-frame order:
 * scheduleDirtyChunks, then consume, then flushMeshQueue.
 */
export function scheduleDirtyChunks(
    aoi: VoxelAoiState,
    dispatcher: Mesher,
    voxels: Voxels,
    lightVolume: LightVolume,
    cameraPos: Vec3,
    deferIncomplete: boolean,
    toForget: string[],
): void {
    aoi.frame++;
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
    _camChunk[0] = camCx;
    _camChunk[1] = camCy;
    _camChunk[2] = camCz;
    for (let i = 0; i < remeshCandidates.length; i++) {
        const { key, chunk } = remeshCandidates[i]!;

        // no visible geometry (all-air, or opaque interior boxed in by opaque neighbors):
        // stage for eviction rather than shipping a no-op job to a worker.
        if (chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)) {
            chunk.dirty = false;
            voxels.dirty.blocks.delete(chunk);
            aoi.dirtyFirstSeen.delete(key);
            // the AOI granted light admission, so it revokes it here too.
            chunk.lightWanted = false;
            voxels.dirty.lightVolume.delete(chunk);
            toForget.push(key);
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

        // defer until the full 26-neighbourhood has arrived, so boundary AO is correct; urgent
        // chunks bypass, and the view frontier falls through after NEIGHBOURHOOD_GRACE_FRAMES.
        if (deferIncomplete && !urgent && chunk.knownNeighbourCount < NEIGHBOR_COUNT) {
            const waited = firstSeen !== undefined && aoi.frame - firstSeen > NEIGHBOURHOOD_GRACE_FRAMES;
            if (!waited) continue;
        }

        // a chunk must be light-resident before its mesh can exist; queue the bake and retry
        // next frame. Urgency does not bypass this: a mesh against a missing tile is wrong,
        // where a mesh a frame late is merely late. This is also the only admission point
        // into the light pool, keeping its working set bounded by the mesh budget.
        if (lookupPayload(lightVolume, chunk.cx, chunk.cy, chunk.cz) === 0) {
            // the residency grid wraps, so a chunk outside its radius would alias onto a
            // nearer chunk's cell and the two would clobber each other forever.
            if (!withinLightGrid(lightVolume, chunk.cx, chunk.cy, chunk.cz, _camChunk)) continue;
            chunk.lightWanted = true;
            voxels.dirty.lightVolume.add(chunk);
            continue;
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
