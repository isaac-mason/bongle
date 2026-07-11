// ── voxel world renderer (per-room mesh wrappers) ───────────────────
//
// per-room renderer state for voxel chunks. owns only:
//   - 3 per-pass `Mesh` instances added to the room's `Scene`, wrapping
//     engine-global `quadMaterials` + `geometries` from `VoxelResources`
//   - dirty first-seen tracking (for the starvation boost
//     in the prioritised remesh path)
//   - per-room frame counter
//
// the heavy state, arenas, SectionTables, ArenaPacker, PassRender,
// Geometries, all lives on engine-global `VoxelResources`. on room
// activation, the new active room's chunks are re-meshed into the
// shared arena via the existing prioritised remesh path.
//
// this file is the per-room half of the frame; the engine-global GPU frame
// graph — `updateCull` (per-frame cull view + sort gate), `cullDispatches`
// (the cull → emit → translucent-sort dispatch list), and `removeChunkMesh` —
// lives in `voxel-resources.ts` next to the kernels + buffers it drives:
//   update(visuals, voxelRes, voxels, registry, cameraPos);    // remesh dirty chunks (here)
//   VoxelResources.updateCull / cullDispatches(voxelRes);      // GPU frame graph (there)
//
// each frame is exactly 3 drawIndirect calls (one per pass), with
// vertexCount=6 and instanceCount=visibleQuadCount. instance i pulls
// `visibleQuads[i] = {slot, localIdx}`, looks up `chunkInfo[slot]` for
// `{origin, arenaBase}`, and renders 1 quad at `arenaBase + localIdx`.

import type { Scene } from 'gpucat';
import { Mesh } from 'gpucat';
import type { Vec3 } from 'mathcat';

import type { BlockRegistry } from '../../core/voxels/block-registry';
import { buildMeshInput, type ChunkMeshResult, meshChunk } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, CHUNK_VOLUME, type Chunk, chunkKey, NEIGHBOR_COUNT, type Voxels } from '../../core/voxels/voxels';
import { flushMeshQueue, isInFlight, type MeshPerf, queueMesh, readMeshPerf } from './mesh-dispatcher';
import type { VoxelPass } from './voxel-material';
import {
    PASSES,
    packerClearAll,
    packerEvictChunk,
    packerHas,
    packerKeys,
    packerSetCameraPos,
    packerUpsertChunk,
    type VoxelResources,
} from './voxel-resources';

export type VoxelVisuals = {
    /** per-room `Mesh` instances added to the room's `Scene`. each wraps
     *  one engine-global `Geometry` + `Material` pair; swapping room is
     *  free (just hide/show the meshes via the scene). */
    meshes: Record<VoxelPass, Mesh>;
    /** frame counter, incremented on each update() call. used for starvation boost. */
    frame: number;
    /** chunk key → frame at which it was first observed dirty (remesh). cleared on remesh. */
    dirtyFirstSeen: Map<string, number>;
    /** one-shot count of closest dirty chunks to dispatch URGENT on the next
     *  `update()`. set by `activateRoom` so the post-swap frame fills a chunk halo
     *  around the camera immediately (urgent jumps the worker queue) instead of
     *  trickling in over normal-tier streaming. Zeroed after being consumed. */
    roomSwapUrgentBurst: number;
    /** last frame's mesh-dispatch perf (main-thread build vs postMessage split,
     *  posts/frame, worker time). drained from the dispatcher each update; read
     *  by the debug HUD / console. null until the first dispatched frame. */
    lastMeshPerf: MeshPerf | null;
};

export function initRoomMeshes(scene: Scene, voxelResources: VoxelResources): VoxelVisuals {
    const meshes = {} as Record<VoxelPass, Mesh>;
    for (const pass of PASSES) {
        const mesh = new Mesh(voxelResources.geometries[pass], voxelResources.quadMaterials[pass]);
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

/** closest dirty chunks dispatched urgently on the first frame after
 *  `activateRoom`, so the scene fills in immediately instead of trickling in
 *  behind normal-tier streaming. */
const ROOM_SWAP_URGENT_BURST = 20;

// ── update ──────────────────────────────────────────────────────────

/** frames a chunk can sit dirty before starvation boost kicks in. */
const STARVATION_GRACE_FRAMES = 30;
const STARVATION_BOOST_PER_FRAME = (CHUNK_SIZE * CHUNK_SIZE) / 2;

/** frames a streaming chunk waits for its full 26-neighbourhood to arrive before
 *  meshing anyway. covers the view frontier (outer neighbours are beyond the
 *  stream radius and never come) and slow streams. */
const NEIGHBOURHOOD_GRACE_FRAMES = 20;

/** chunks within this Chebyshev radius of the camera's chunk dispatch URGENT
 *  (jump the worker queue) — the block the player is editing in front of
 *  themselves meshes next frame instead of behind streaming backlog. Everything
 *  outside is normal-tier. CHUNK_SIZE=16 → 2 chunks = the chunk you're in plus
 *  its immediate ring on each axis. */
const URGENT_REMESH_RADIUS_CHUNKS = 2;

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
function hasNoVisibleSurface(chunk: Chunk): boolean {
    if (chunk.solidCount !== CHUNK_VOLUME) return false;
    for (let dir = 0; dir < 6; dir++) {
        const neighbor = chunk.neighbors[dir];
        if (neighbor === null || neighbor.solidCount !== CHUNK_VOLUME) return false;
    }
    return true;
}

/**
 * scan all chunks for dirty flags and either main-thread-remesh them or
 * dispatch them to the worker pool, then upsert results into the engine-
 * global arena packer.
 *
 * Two modes:
 * - `cameraPos === undefined` OR no worker pool (asset-pipeline, tests,
 *   workers disabled): every dirty chunk meshes synchronously in one
 *   pass, no caps — there's nothing to prioritise onto.
 * - live client with workers: dirty chunks sort by distance² from camera
 *   (with starvation boost) and ALL dispatch to `meshDispatcher`. A chunk
 *   within `URGENT_REMESH_RADIUS_CHUNKS` Chebyshev of the camera (or under
 *   the room-swap burst) dispatches URGENT — it jumps the worker's queue so
 *   the block you're editing meshes next frame instead of behind streaming
 *   backlog. Everything else is normal-tier; overflow stays dirty and
 *   retries next frame.
 *
 * dirty flags are cleared on (re)mesh OR on successful enqueue; chunks
 * with zero geometry (all air) are evicted from the arena. Worker
 * results are drained at the top of update(), stale results (chunk
 * meshGen has moved on) are discarded.
 */
export function update(
    state: VoxelVisuals,
    voxelResources: VoxelResources,
    voxels: Voxels,
    registry: BlockRegistry,
    cameraPos: Vec3 | undefined,
    deferIncomplete: boolean,
): void {
    const arenas = voxelResources.arenas;
    state.frame++;

    // give the packer this frame's camera so its OOM eviction policy
    // (farthest-from-camera) has a reference point. null in the offline
    // path, packer falls back to evicting an arbitrary chunk.
    packerSetCameraPos(arenas.packer, cameraPos ?? null);

    // drain worker results from last frame. each result carries the
    // meshGen we dispatched at; chunk.meshGen has only stayed equal if
    // nothing mutated it since, otherwise drop (chunk is back in
    // dirty.blocks for a fresh dispatch).
    if (voxelResources.pendingMeshResults.length > 0) {
        const pending = voxelResources.pendingMeshResults;
        for (let i = 0; i < pending.length; i++) {
            const r = pending[i]!;
            const chunk = voxels.chunks.get(r.chunkKey);
            if (!chunk) continue;
            if (chunk.meshGen !== r.gen) continue;
            writeChunkMesh(voxelResources, r.chunkKey, chunk, r);
        }
        pending.length = 0;
    }

    // drain worker crash recovery: any chunks whose worker died goes
    // back on the dirty list so we re-dispatch next frame. dispatcher
    // already cleared its inFlight tracking + replenished the buffer
    // pool; we just have to re-flip the dirty bit.
    if (voxelResources.pendingLostChunkKeys.length > 0) {
        const lost = voxelResources.pendingLostChunkKeys;
        for (let i = 0; i < lost.length; i++) {
            const chunk = voxels.chunks.get(lost[i]!);
            if (!chunk) continue;
            chunk.dirty = true;
            voxels.dirty.blocks.add(chunk);
        }
        lost.length = 0;
    }

    const dispatcher = voxelResources.meshDispatcher;
    if (cameraPos === undefined || dispatcher === null) {
        // unprioritised: full synchronous remesh of every dirty chunk in one pass.
        // the offline (asset-pipeline / test) path, and the workers-disabled
        // fallback — with no worker pool there's nothing to prioritise onto.
        for (const chunk of voxels.dirty.blocks) {
            const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
            chunk.dirty = false;
            state.dirtyFirstSeen.delete(key);
            remeshChunk(voxelResources, voxels, registry, key, chunk);
        }
        voxels.dirty.blocks.clear();
    } else {
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
            let firstSeen = state.dirtyFirstSeen.get(key);
            if (firstSeen === undefined) {
                firstSeen = state.frame;
                state.dirtyFirstSeen.set(key, firstSeen);
            }
            const boost = Math.max(0, state.frame - firstSeen - STARVATION_GRACE_FRAMES) * STARVATION_BOOST_PER_FRAME;
            remeshCandidates.push({ key, chunk, score: distSq - boost });
        }

        remeshCandidates.sort((a, b) => a.score - b.score);
        // one-shot urgent burst after a room swap: the closest N candidates are
        // meshed urgently so the scene fills in immediately rather than popping
        // in over several frames of normal-tier streaming.
        let roomSwapUrgentBurst = state.roomSwapUrgentBurst;
        state.roomSwapUrgentBurst = 0;

        // Single pass over sorted (closest-first) candidates, all off-thread.
        // A candidate is dispatched URGENT if it's within URGENT_REMESH_RADIUS
        // Chebyshev of the camera (the block you're editing in front of you) or
        // covered by the room-swap burst; everything else is normal-tier with
        // starvation spill. Each successful enqueue clears chunk.dirty and drops
        // it from voxels.dirty.blocks so we don't re-dispatch while in flight. A
        // mutation during flight re-sets dirty + bumps meshGen → stale result
        // dropped on drain, chunk re-dispatched next frame.
        const camCx = Math.floor(cx / CHUNK_SIZE);
        const camCy = Math.floor(cy / CHUNK_SIZE);
        const camCz = Math.floor(cz / CHUNK_SIZE);
        for (let i = 0; i < remeshCandidates.length; i++) {
            const { key, chunk } = remeshCandidates[i]!;

            // chunks with no visible geometry (all-air, or a fully-opaque
            // interior boxed in by fully-opaque neighbors) evict any prior
            // arena entry inline rather than shipping a ~700 KB no-op job to
            // a worker. matches the sync path's check in `remeshChunk`.
            if (chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)) {
                chunk.dirty = false;
                voxels.dirty.blocks.delete(chunk);
                state.dirtyFirstSeen.delete(key);
                writeChunkMesh(voxelResources, key, chunk, null);
                continue;
            }

            if (isInFlight(dispatcher, key)) continue;

            const chebyshevChunks = Math.max(Math.abs(chunk.cx - camCx), Math.abs(chunk.cy - camCy), Math.abs(chunk.cz - camCz));
            let urgent = chebyshevChunks <= URGENT_REMESH_RADIUS_CHUNKS;
            if (!urgent && roomSwapUrgentBurst > 0) {
                urgent = true;
                roomSwapUrgentBurst--;
            }

            const firstSeen = state.dirtyFirstSeen.get(key);

            // streaming rooms: defer until the full 26-neighbourhood has arrived, so
            // the chunk meshes once with correct boundary AO/light instead of
            // re-meshing as each neighbour streams in. urgent chunks bypass; the view
            // frontier (never completes) falls through after NEIGHBOURHOOD_GRACE_FRAMES.
            // deferred chunks stay dirty and are re-evaluated next frame.
            if (deferIncomplete && !urgent && chunk.knownNeighbourCount < NEIGHBOR_COUNT) {
                const waited = firstSeen !== undefined && state.frame - firstSeen > NEIGHBOURHOOD_GRACE_FRAMES;
                if (!waited) continue;
            }

            // a starving normal-tier chunk spills off its (saturated) affinity
            // worker to any idle one instead of stalling. urgent bypasses the
            // queue gate, so it needs neither spill nor a `continue`-retry.
            const starving = firstSeen !== undefined && state.frame - firstSeen > STARVATION_GRACE_FRAMES;
            const ok = queueMesh(dispatcher, voxels, chunk, chunk.meshGen, urgent ? { urgent: true } : { allowSpill: starving });
            if (!ok) continue;
            chunk.dirty = false;
            voxels.dirty.blocks.delete(chunk);
            state.dirtyFirstSeen.delete(key);
        }
    }

    // drain each worker's accumulated pending into one batched packet per worker
    // (a worker meshing K chunks costs a single postMessage, not K).
    if (dispatcher !== null) flushMeshQueue(dispatcher, voxels);

    // evict any arena-held chunk the server has dropped from voxels.chunks.
    // (server discovery owns chunk membership; we just mirror it.)
    for (const key of packerKeys(arenas.packer)) {
        if (!voxels.chunks.has(key)) {
            packerEvictChunk(arenas.packer, key);
        }
    }

    // drain this frame's dispatch perf for the debug HUD.
    if (voxelResources.meshDispatcher !== null) {
        state.lastMeshPerf = readMeshPerf(voxelResources.meshDispatcher);
    }
}

/** main-thread remesh: run `meshChunk` against the room's shared
 *  `meshOutput`, then install the result via `writeChunkMesh`. */
function remeshChunk(voxelResources: VoxelResources, voxels: Voxels, registry: BlockRegistry, key: string, chunk: Chunk): void {
    const mesh =
        chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)
            ? null
            : meshChunk(voxelResources.meshOutput, buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
    writeChunkMesh(voxelResources, key, chunk, mesh);
}

/** upsert a mesh result into the engine-global arena packer (or evict
 *  if the chunk is all-air / has no geometry). Shared between the main-
 *  thread `remeshChunk` path and the worker drain path. */
function writeChunkMesh(voxelResources: VoxelResources, key: string, chunk: Chunk, mesh: ChunkMeshResult | null): void {
    const packer = voxelResources.arenas.packer;
    if (mesh === null || chunk.nonAirCount === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

/** swap arena residency to a new active room. clears every chunk from
 *  the engine-global packer and marks every chunk in `voxels` dirty so
 *  the next `update()` cycles them back in via the prioritised remesh
 *  path. resets the new room's first-seen tracking too. */
export function activateRoom(voxelResources: VoxelResources, state: VoxelVisuals, voxels: Voxels): void {
    packerClearAll(voxelResources.arenas.packer);
    // skip nonAirCount=0 chunks, those are sparse "discovered empty" stubs
    // pushed by `voxel_chunk_empty`. they have no blocks to mesh and would
    // otherwise pollute `remeshCandidates` (sort cost) and waste budget on
    // applyRemesh early-returns.
    for (const chunk of voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        chunk.dirty = true;
        voxels.dirty.blocks.add(chunk);
    }
    state.dirtyFirstSeen.clear();
    state.roomSwapUrgentBurst = ROOM_SWAP_URGENT_BURST;
}

export function dispose(state: VoxelVisuals, scene: Scene): void {
    for (const pass of PASSES) {
        scene.remove(state.meshes[pass]!);
    }
}
