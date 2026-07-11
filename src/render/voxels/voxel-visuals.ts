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
// frame (active room only):
//   update(visuals, voxelRes, voxels, registry, cameraPos);    // remesh dirty chunks
//   cullCPU(voxelRes, camera, viewChunkRadius);                // build visibleSlices + indirect
//   const dispatches = expandDispatches(voxelRes);             // fan slices → visibleQuads
//   renderer.compute(dispatches); renderer.render(...);        // 3 drawIndirect calls
//
// each frame is exactly 3 drawIndirect calls (one per pass), with
// vertexCount=6 and instanceCount=visibleQuadCount. instance i pulls
// `visibleQuads[i] = {slot, localIdx}`, looks up `chunkInfo[slot]` for
// `{origin, arenaBase}`, and renders 1 quad at `arenaBase + localIdx`.

import type { Camera, ComputeDispatch, Scene } from 'gpucat';
import { frustum, Mesh, packTo } from 'gpucat';
import { plane3, type Vec3 } from 'mathcat';

import type { BlockRegistry } from '../../core/voxels/block-registry';
import { buildMeshInput, type ChunkMeshResult, meshChunk, TRANSLUCENT_SORT_DYNAMIC } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, CHUNK_VOLUME, type Chunk, chunkKey, type Voxels } from '../../core/voxels/voxels';
import { flushMeshQueue, isInFlight, type MeshPerf, queueMesh, readMeshPerf } from './mesh-dispatcher';
import type { VoxelPass } from './voxel-material';
import {
    CULL_WG_SIZE,
    PASSES,
    packerClearAll,
    packerEvictChunk,
    packerHas,
    packerKeys,
    packerSetCameraPos,
    packerUpsertChunk,
    SORT_CAP,
    TRANSLUCENT_SORT_ENTRY_STRIDE,
    TranslucentSortEntry,
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

            // a starving normal-tier chunk spills off its (saturated) affinity
            // worker to any idle one instead of stalling. urgent bypasses the
            // queue gate, so it needs neither spill nor a `continue`-retry.
            const firstSeen = state.dirtyFirstSeen.get(key);
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

    // drain this frame's dispatch instrumentation for the debug HUD / console.
    if (voxelResources.meshDispatcher !== null) {
        const perf = readMeshPerf(voxelResources.meshDispatcher);
        state.lastMeshPerf = perf;
        logMeshPerf(perf);
    }
}

// ── dispatch perf logging (dev instrumentation) ─────────────────────
// accumulates per-frame perf over a ~1s window and logs a one-liner when
// there was dispatch activity. peakMainMs is the worst single-frame
// main-thread cost (build + postMessage) — that's the hitch to watch.
const _perfLog = { frames: 0, enqueues: 0, results: 0, buildMs: 0, postMs: 0, workUs: 0, peakMainMs: 0, peakEnq: 0 };

function logMeshPerf(p: MeshPerf): void {
    _perfLog.frames++;
    _perfLog.enqueues += p.enqueues;
    _perfLog.results += p.results;
    _perfLog.buildMs += p.buildMs;
    _perfLog.postMs += p.postMs;
    _perfLog.workUs += p.workUs;
    const mainMs = p.buildMs + p.postMs;
    if (mainMs > _perfLog.peakMainMs) _perfLog.peakMainMs = mainMs;
    if (p.enqueues > _perfLog.peakEnq) _perfLog.peakEnq = p.enqueues;

    if (_perfLog.frames < 60) return;
    const l = _perfLog;
    if (l.enqueues > 0) {
        const perPostBuild = ((l.buildMs / l.enqueues) * 1000).toFixed(1);
        const perPostPost = ((l.postMs / l.enqueues) * 1000).toFixed(1);
        console.log(
            `[mesh] ${l.frames}f | posts→ ${l.enqueues} (peak ${l.peakEnq}/f) results← ${l.results} | ` +
                `main: build ${l.buildMs.toFixed(1)}ms + post ${l.postMs.toFixed(1)}ms | ` +
                `PEAK main/frame ${l.peakMainMs.toFixed(2)}ms | worker ${(l.workUs / 1000).toFixed(1)}ms | ` +
                `per-post: build ${perPostBuild}µs post ${perPostPost}µs`,
        );
    }
    _perfLog.frames = 0;
    _perfLog.enqueues = 0;
    _perfLog.results = 0;
    _perfLog.buildMs = 0;
    _perfLog.postMs = 0;
    _perfLog.workUs = 0;
    _perfLog.peakMainMs = 0;
    _perfLog.peakEnq = 0;
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

// ── render-time CPU work ────────────────────────────────────────────

const _cullFrustum = frustum.create();

/** Write the per-frame camera view (5 pre-shifted, camera-relative frustum
 *  planes + camera chunk/frac) into `cullView`, and reset the GPU cull/emit
 *  counters. The visibility test + slice emission now run on the GPU via
 *  `cullDispatches`; this just prepares their per-frame inputs. Must run before
 *  those dispatches.
 *
 *  Planes are expressed camera-relative and the world coords go in as integer
 *  chunk coords + sub-chunk frac, so the whole cull stays f32-exact at
 *  Minecraft world scale. `viewChunkRadius` is read live from settings, so a
 *  tier flip applies next frame. */
export function updateCull(voxelResources: VoxelResources, camera: Camera, viewChunkRadius: number): void {
    frustum.setFromViewProjectionMatrix(_cullFrustum, camera.projectionMatrix, camera.matrixWorldInverse);
    const cx = camera.position[0];
    const cy = camera.position[1];
    const cz = camera.position[2];
    const camCx = Math.floor(cx / CHUNK_SIZE);
    const camCy = Math.floor(cy / CHUNK_SIZE);
    const camCz = Math.floor(cz / CHUNK_SIZE);

    // 5 planes (drop the far plane, index 5 — the view-radius test bounds it),
    // camera-relative with the section half-extent folded into `.w`:
    //   dot(plane.xyz, relCenter) + plane.w >= 0  keeps the section.
    const data = voxelResources.cullViewData;
    const half = CHUNK_SIZE * 0.5;
    for (let i = 0; i < 5; i++) {
        const p = _cullFrustum[i]!;
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];
        // (n·cam + constant), folded with the box support along n; all in f64.
        const w = plane3.distanceToPoint(p, camera.position) + half * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
        const base = i * 4;
        data[base + 0] = nx;
        data[base + 1] = ny;
        data[base + 2] = nz;
        data[base + 3] = w;
    }
    // camMeta = (camChunk.xyz, recordCount); camFrac = (fracXYZ, viewDist²).
    const viewDist = viewChunkRadius * CHUNK_SIZE;
    data[20] = camCx;
    data[21] = camCy;
    data[22] = camCz;
    data[23] = voxelResources.arenas.packer.chunks.length;
    data[24] = cx - camCx * CHUNK_SIZE;
    data[25] = cy - camCy * CHUNK_SIZE;
    data[26] = cz - camCz * CHUNK_SIZE;
    data[27] = viewDist * viewDist;
    voxelResources.cullView.addUpdateRange(0, data.length);
    voxelResources.cullView.needsUpdate = true;

    // reset the cull append counter (emitArgs[0]); [1]=7, [2]=1 stay.
    voxelResources.emitArgsData[0] = 0;
    voxelResources.emitArgs.addUpdateRange(0, voxelResources.emitArgsData.length);
    voxelResources.emitArgs.needsUpdate = true;

    // zero the per-bucket quad tallies for this frame's count pass (the CPU
    // mirror stays all-zero; re-uploading it clears the GPU buffer). The draw
    // instanceCounts are written by the finalize pass, not reset here.
    voxelResources.bucketQuads.addUpdateRange(0, voxelResources.bucketQuadsData.length);
    voxelResources.bucketQuads.needsUpdate = true;

    buildTranslucentSortEntries(voxelResources, cx, cy, cz);
}

// Level-B translucent quad-sort trigger. The sort key is ROTATION-INVARIANT
// (distance to each quad's plane), so orbiting the camera in place never changes
// the correct order — the only events that invalidate a persisted `quadOrder` are
// camera TRANSLATIONS (crossing a quad plane / a parallel-pair midpoint). So the
// gate is pure translation: re-sort a DYNAMIC section when the camera has moved
// far enough since that section's last sort — a tight threshold up close (a small
// move reorders near geometry, e.g. diving through a water surface), looser far
// away. First-seen / re-meshed sections (sortValid=false) always sort.
const SORT_NEAR_DIST_SQ = 32 * 32; // within ~2 chunks of the section center → "near"
const SORT_MOVE_TRIGGER_NEAR_SQ = 0.25 * 0.25; // 0.25 block of translation, near
const SORT_MOVE_TRIGGER_FAR_SQ = 1.0 * 1.0; // 1 block, far
let warnedOversizedSort = false;

function buildTranslucentSortEntries(voxelResources: VoxelResources, camX: number, camY: number, camZ: number): void {
    const packer = voxelResources.arenas.packer;
    const entries = voxelResources.translucentSortEntriesData;
    const half = CHUNK_SIZE * 0.5;
    let count = 0;
    for (const chunk of packer.chunks) {
        const t = chunk.translucent;
        if (!t || t.sortType !== TRANSLUCENT_SORT_DYNAMIC) continue;
        if (t.dataCount > SORT_CAP) {
            // one workgroup can't sort more than SORT_CAP quads; leave the section
            // on its identity order (a large far-ish blob, rarely misorder-visible).
            if (!warnedOversizedSort) {
                warnedOversizedSort = true;
                console.warn(`[voxel-sort] section has ${t.dataCount} translucent quads > SORT_CAP ${SORT_CAP}; left unsorted`);
            }
            continue;
        }

        // distance to the section center (picks the near vs far move threshold).
        const dx = chunk.originX + half - camX;
        const dy = chunk.originY + half - camY;
        const dz = chunk.originZ + half - camZ;
        const distSq = dx * dx + dy * dy + dz * dz;

        let trigger = !t.sortValid;
        if (!trigger) {
            const mx = camX - t.sortCamX;
            const my = camY - t.sortCamY;
            const mz = camZ - t.sortCamZ;
            const movedSq = mx * mx + my * my + mz * mz;
            const threshold = distSq <= SORT_NEAR_DIST_SQ ? SORT_MOVE_TRIGGER_NEAR_SQ : SORT_MOVE_TRIGGER_FAR_SQ;
            trigger = movedSq > threshold;
        }
        if (!trigger) continue;

        packTo(TranslucentSortEntry, entries, count * TRANSLUCENT_SORT_ENTRY_STRIDE, {
            relOrigin: [chunk.originX - camX, chunk.originY - camY, chunk.originZ - camZ],
            arenaBase: t.dataStart,
            quadOrderStart: t.quadOrderStart,
            dataCount: t.dataCount,
        });
        t.sortCamX = camX;
        t.sortCamY = camY;
        t.sortCamZ = camZ;
        t.sortValid = true;
        count++;
    }

    voxelResources.translucentSortCount = count;
    if (count > 0) {
        voxelResources.translucentSortEntries.addUpdateRange(0, (count * TRANSLUCENT_SORT_ENTRY_STRIDE) / 4);
        voxelResources.translucentSortEntries.needsUpdate = true;
    }
}

/** GPU cull + Level-A ordered emit dispatch chain. gpucat runs each dispatch in
 *  its own compute pass, so the `cull → count → finalize → emit` data
 *  dependencies hold. Push into the renderer's dispatch list before
 *  `renderer.compute(...)`. Empty when no chunks are resident.
 *
 *  1. cull: one thread per resident chunk; frustum-test, compact survivors into
 *     `visibleChunks` (+ distance bucket), write the emit dispatch args.
 *  2. count (per pass): tally each visible facing's quads into its distance bucket.
 *  3. finalize: prefix-sum buckets → instance bases + per-pass draw counts.
 *  4. emit (per pass): opaque/transparent back-face-cull facings and write
 *     `visibleQuads` front-to-back; translucent emits whole-section in
 *     `quadOrder` order at the reversed (back-to-front) bucket base. */
export function cullDispatches(voxelResources: VoxelResources): ComputeDispatch[] {
    const packer = voxelResources.arenas.packer;
    const recordCount = packer.chunks.length;
    const out: ComputeDispatch[] = [];
    if (recordCount === 0) return out;
    const tables = voxelResources.arenas.tables;
    const passRender = voxelResources.passRender;

    // Level-B: sort triggered DYNAMIC translucent sections first (writes their
    // persisted `quadOrder`, which the translucent emit reads below). Separate
    // pass → the write is visible to the emit. Skipped when nothing triggered.
    if (voxelResources.translucentSortCount > 0) {
        out.push({
            node: voxelResources.translucentSort,
            dispatch: [voxelResources.translucentSortCount, 1, 1],
            buffers: {
                sortEntries: voxelResources.translucentSortEntries,
                quads: voxelResources.arenas.quadArena.buffers.quads,
                quadOrder: voxelResources.arenas.quadOrderArena.buffers.quadOrder,
            },
        });
    }

    out.push({
        node: voxelResources.cull,
        dispatch: [Math.ceil(recordCount / CULL_WG_SIZE), 1, 1],
        buffers: {
            cullRecords: packer.cullRecordsBuffer,
            cullView: voxelResources.cullView,
            visibleChunks: voxelResources.visibleChunks,
            emitArgs: voxelResources.emitArgs,
        },
    });
    for (const pass of PASSES) {
        out.push({
            node: voxelResources.count,
            indirect: voxelResources.emitArgs,
            buffers: {
                visibleChunks: voxelResources.visibleChunks,
                sectionMeta: tables[pass].metaBuffer,
                bucketQuads: voxelResources.bucketQuads,
                emitConfig: voxelResources.emitConfig[pass],
            },
        });
    }
    out.push({
        node: voxelResources.finalize,
        dispatch: [1, 1, 1],
        buffers: {
            bucketQuads: voxelResources.bucketQuads,
            bucketBase: voxelResources.bucketBase,
            bucketCursor: voxelResources.bucketCursor,
            drawOpaque: passRender.opaque.indirectBuffer,
            drawTransparent: passRender.transparent.indirectBuffer,
            drawTranslucent: passRender.translucent.indirectBuffer,
        },
    });
    for (const pass of PASSES) {
        // translucent emits whole-section in quadOrder order (back-to-front),
        // opaque/transparent emit per-facing with back-face cull.
        if (pass === 'translucent') {
            out.push({
                node: voxelResources.translucentEmit,
                indirect: voxelResources.emitArgs,
                buffers: {
                    visibleChunks: voxelResources.visibleChunks,
                    sectionMeta: tables[pass].metaBuffer,
                    visibleQuads: passRender[pass].visibleQuadsBuffer,
                    bucketBase: voxelResources.bucketBase,
                    bucketCursor: voxelResources.bucketCursor,
                    quadOrder: voxelResources.arenas.quadOrderArena.buffers.quadOrder,
                },
            });
            continue;
        }
        out.push({
            node: voxelResources.emit,
            indirect: voxelResources.emitArgs,
            buffers: {
                visibleChunks: voxelResources.visibleChunks,
                sectionMeta: tables[pass].metaBuffer,
                visibleQuads: passRender[pass].visibleQuadsBuffer,
                bucketBase: voxelResources.bucketBase,
                bucketCursor: voxelResources.bucketCursor,
                emitConfig: voxelResources.emitConfig[pass],
            },
        });
    }
    return out;
}

/** remove a specific chunk from the engine-global arena packer (e.g. when
 *  the chunk is unloaded from `voxels`). */
export function removeChunkMesh(voxelResources: VoxelResources, key: string): void {
    const packer = voxelResources.arenas.packer;
    if (packerHas(packer, key)) {
        packerEvictChunk(packer, key);
    }
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
