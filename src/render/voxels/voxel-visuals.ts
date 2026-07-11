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
//   updateCull(voxelRes, camera, viewChunkRadius);             // per-frame cull view + sort gate
//   const dispatches = cullDispatches(voxelRes);               // cull → emit → translucent sort
//   renderer.compute(dispatches); renderer.render(...);        // 3 drawIndirect calls
//
// each frame is exactly 3 drawIndirect calls (one per pass), with
// vertexCount=6 and instanceCount=visibleQuadCount. instance i pulls
// `visibleQuads[i] = {slot, localIdx}`, looks up `chunkInfo[slot]` for
// `{origin, arenaBase}`, and renders 1 quad at `arenaBase + localIdx`.

import type { Camera, ComputeDispatch, Scene } from 'gpucat';
import { frustum, Mesh } from 'gpucat';
import { plane3, type Vec3 } from 'mathcat';

import type { BlockRegistry } from '../../core/voxels/block-registry';
import { buildMeshInput, type ChunkMeshResult, meshChunk } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, CHUNK_VOLUME, type Chunk, chunkKey, NEIGHBOR_COUNT, type Voxels } from '../../core/voxels/voxels';
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

    // translucent sort gate: the counting-sort output persists across frames and
    // only re-runs when the back-to-front order can change. The key is rotation-
    // invariant (radial distance), so orbiting in place needs no re-sort — but the
    // visible SET changes on rotation, and a translucent arena mutation would leave
    // the persisted `{slot, localIdx}` dangling. Gate = translation ∨ rotation ∨
    // arena mutation ∨ first-run. When skipped, last frame's permutation + draw
    // count stand. Cheap enough (one flat O(N) sort) that any camera motion re-runs.
    updateTranslucentSortGate(voxelResources, cx, cy, cz, _cullFrustum[4]!.normal);
}

// distance the camera must move before the translucent sort re-runs. Tight: a
// small translation reorders near geometry (e.g. diving through a water surface),
// and the whole sort is one cheap flat pass, so we only truly skip when static.
const TSORT_MOVE_TRIGGER_SQ = 0.1 * 0.1; // 0.1 block
// re-run once the camera forward turns past this (cos of the angle). The visible
// set shifts on rotation, so newly-entered translucent sections must be sorted in.
const TSORT_ROTATE_TRIGGER_COS = 0.9998; // ≈ 1.1°

/** Decide whether the translucent counting sort re-runs this frame, and refresh
 *  the gate baseline when it does. `fwd` is the camera-forward (near-plane inward
 *  normal). Sets `runTranslucentSort` for `cullDispatches`. */
function updateTranslucentSortGate(voxelResources: VoxelResources, camX: number, camY: number, camZ: number, fwd: Vec3): void {
    const gate = voxelResources.tsortGate;
    const packer = voxelResources.arenas.packer;
    let run = !gate.valid || packer.translucentDirty;
    if (!run) {
        const mx = camX - gate.camX;
        const my = camY - gate.camY;
        const mz = camZ - gate.camZ;
        run = mx * mx + my * my + mz * mz > TSORT_MOVE_TRIGGER_SQ;
    }
    if (!run) {
        const dotFwd = fwd[0] * gate.fwdX + fwd[1] * gate.fwdY + fwd[2] * gate.fwdZ;
        run = dotFwd < TSORT_ROTATE_TRIGGER_COS;
    }
    if (run) {
        gate.camX = camX;
        gate.camY = camY;
        gate.camZ = camZ;
        gate.fwdX = fwd[0];
        gate.fwdY = fwd[1];
        gate.fwdZ = fwd[2];
        gate.valid = true;
        packer.translucentDirty = false;
    }
    voxelResources.runTranslucentSort = run;
}

/** GPU cull + Level-A ordered emit dispatch chain. gpucat runs each dispatch in
 *  its own compute pass, so the `cull → finalize → emit` data dependencies hold.
 *  Push into the renderer's dispatch list before `renderer.compute(...)`. Empty
 *  when no chunks are resident.
 *
 *  1. cull: one thread per resident chunk; frustum-test, compact survivors into
 *     `visibleChunks` (+ distance bucket), write the emit dispatch args, AND tally
 *     each survivor's visible opaque/transparent facings into `bucketQuads`.
 *  2. finalize: prefix-sum opaque/transparent buckets → instance bases + draw counts.
 *  3. emit (opaque/transparent): back-face-cull facings, write `visibleQuads`
 *     front-to-back at the bucket base.
 *  4. translucent global counting sort (gated — see `runTranslucentSort`):
 *     expand → prep → hist → scan → scatter, producing the back-to-front
 *     translucent `visibleQuads` permutation + its draw count. Skipped when the
 *     camera is static and the arena unchanged; last frame's result persists. */
export function cullDispatches(voxelResources: VoxelResources): ComputeDispatch[] {
    const packer = voxelResources.arenas.packer;
    const recordCount = packer.chunks.length;
    const out: ComputeDispatch[] = [];
    if (recordCount === 0) return out;
    const tables = voxelResources.arenas.tables;
    const passRender = voxelResources.passRender;

    out.push({
        node: voxelResources.cull,
        dispatch: [Math.ceil(recordCount / CULL_WG_SIZE), 1, 1],
        buffers: {
            cullRecords: packer.cullRecordsBuffer,
            cullView: voxelResources.cullView,
            visibleChunks: voxelResources.visibleChunks,
            emitArgs: voxelResources.emitArgs,
            // fused count (opaque/transparent only): per-pass meta + bucket tally.
            opaqueMeta: tables.opaque.metaBuffer,
            transparentMeta: tables.transparent.metaBuffer,
            bucketQuads: voxelResources.bucketQuads,
        },
    });
    out.push({
        node: voxelResources.finalize,
        dispatch: [1, 1, 1],
        buffers: {
            bucketQuads: voxelResources.bucketQuads,
            bucketBase: voxelResources.bucketBase,
            bucketCursor: voxelResources.bucketCursor,
            drawOpaque: passRender.opaque.indirectBuffer,
            drawTransparent: passRender.transparent.indirectBuffer,
        },
    });
    // opaque/transparent per-facing emit (the translucent pass is sorted below).
    for (const pass of PASSES) {
        if (pass === 'translucent') continue;
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

    // translucent global stable radix sort (gated). Reads this frame's
    // `visibleChunks` (cull, above); output persists when skipped.
    // Chain: expand → prep → count₀ → 4 × (scan → scatter). The passes shuffle
    // (key, index) pairs A→B→A→B; each non-last scatter also fused-counts the
    // NEXT pass's digit into the other histogram (which the scan just zeroed),
    // so only pass 0 needs the standalone count. The last scatter gathers
    // `sortPayload[idx]` straight into the translucent `visibleQuads`.
    // Histograms ping-pong hist[pass % 2] (counts) ↔ hist[(pass+1) % 2] (next).
    if (voxelResources.runTranslucentSort) {
        const quads = voxelResources.arenas.quadArena.buffers.quads;
        const translucent = passRender.translucent;
        const hists = [voxelResources.radixHist, voxelResources.radixHistAlt] as const;
        out.push({
            node: voxelResources.tsortExpand,
            indirect: voxelResources.emitArgs,
            buffers: {
                visibleChunks: voxelResources.visibleChunks,
                sectionMeta: tables.translucent.metaBuffer,
                chunkInfo: tables.translucent.buffer,
                quads,
                sortKeys: voxelResources.sortKeys,
                sortIdx: voxelResources.sortIdx,
                sortPayload: voxelResources.sortPayload,
                sortCount: voxelResources.sortCount,
            },
        });
        out.push({
            node: voxelResources.tsortPrep,
            dispatch: [1, 1, 1],
            buffers: {
                sortCount: voxelResources.sortCount,
                sortIndirectArgs: voxelResources.sortIndirectArgs,
                drawTranslucent: translucent.indirectBuffer,
            },
        });
        // pass-0 digit histogram (self-zeroing; later passes are fused).
        out.push({
            node: voxelResources.radixCount,
            indirect: voxelResources.sortIndirectArgs,
            buffers: {
                sortIndirectArgs: voxelResources.sortIndirectArgs,
                srcKeys: voxelResources.sortKeys,
                radixHist: hists[0],
            },
        });
        for (let pass = 0; pass < 4; pass++) {
            const srcKeys = pass % 2 === 0 ? voxelResources.sortKeys : voxelResources.sortKeysAlt;
            const srcIdx = pass % 2 === 0 ? voxelResources.sortIdx : voxelResources.sortIdxAlt;
            const histCur = hists[pass % 2]!;
            const histNext = hists[(pass + 1) % 2]!;
            out.push({
                node: voxelResources.radixScan,
                dispatch: [1, 1, 1],
                buffers: {
                    sortIndirectArgs: voxelResources.sortIndirectArgs,
                    radixHist: histCur,
                    radixHistNext: histNext,
                },
            });
            if (pass < 3) {
                out.push({
                    node: voxelResources.radixScatter,
                    indirect: voxelResources.sortIndirectArgs,
                    buffers: {
                        sortIndirectArgs: voxelResources.sortIndirectArgs,
                        srcKeys,
                        srcIdx,
                        radixHist: histCur,
                        radixHistNext: histNext,
                        radixPassConfig: voxelResources.radixPassConfig[pass]!,
                        dstKeys: pass % 2 === 0 ? voxelResources.sortKeysAlt : voxelResources.sortKeys,
                        dstIdx: pass % 2 === 0 ? voxelResources.sortIdxAlt : voxelResources.sortIdx,
                    },
                });
            } else {
                out.push({
                    node: voxelResources.radixScatterLast,
                    indirect: voxelResources.sortIndirectArgs,
                    buffers: {
                        sortIndirectArgs: voxelResources.sortIndirectArgs,
                        srcKeys,
                        srcIdx,
                        radixHist: histCur,
                        radixPassConfig: voxelResources.radixPassConfig[pass]!,
                        sortPayload: voxelResources.sortPayload,
                        visibleQuads: translucent.visibleQuadsBuffer,
                    },
                });
            }
        }
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
