// ── voxel world renderer (per-room mesh wrappers) ───────────────────
//
// per-room renderer state for voxel chunks. owns only:
//   - 3 per-pass `Mesh` instances added to the room's `Scene`, wrapping
//     engine-global `quadMaterials` + `geometries` from `VoxelResources`
//   - dirty first-seen tracking (for the starvation boost
//     in the prioritised remesh path)
//   - per-room frame counter
//
// the heavy state — arenas, SectionTables, ArenaPacker, PassRender,
// Geometries — all lives on engine-global `VoxelResources`. on room
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
import { frustum, Mesh } from 'gpucat';
import type { Box3, Vec3 } from 'mathcat';

import type { BlockRegistry } from '../../core/voxels/block-registry';
import {
    buildMeshInput,
    type ChunkMeshResult,
    meshChunk,
} from '../../core/voxels/chunk-mesher';
import { type Chunk, CHUNK_SIZE, chunkKey, type Voxels } from '../../core/voxels/voxels';
import { enqueueMesh, isInFlight } from './mesh-dispatcher';
import type { VoxelPass } from './voxel-material';
import {
    type ChunkAlloc,
    EXPAND_WG_SIZE,
    PASSES,
    type PassRender,
    packerClearAll,
    packerEvictChunk,
    packerHas,
    packerKeys,
    packerSetCameraPos,
    packerUpsertChunk,
    VISIBLE_SLICE_STRIDE,
    type VoxelResources,
    WG_INFO_STRIDE,
} from './voxel-resources';

const VISIBLE_SLICE_U32S = VISIBLE_SLICE_STRIDE / 4;
const WG_INFO_U32S = WG_INFO_STRIDE / 4;

/** 0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z — matches SectionEntry.face* ordering.
 *  index 6 (UNASSIGNED) is never cone-culled. */
const FACE_AXIS = [0, 0, 1, 1, 2, 2] as const;
/** sign of the outward normal along FACE_AXIS for facing 0..5. */
const FACE_SIGN = [+1, -1, +1, -1, +1, -1] as const;

export type VoxelVisuals = {
    /** per-room `Mesh` instances added to the room's `Scene`. each wraps
     *  one engine-global `Geometry` + `Material` pair; swapping room is
     *  free (just hide/show the meshes via the scene). */
    meshes: Record<VoxelPass, Mesh>;
    /** frame counter, incremented on each update() call. used for starvation boost. */
    frame: number;
    /** chunk key → frame at which it was first observed dirty (remesh). cleared on remesh. */
    dirtyFirstSeen: Map<string, number>;
    /** one-shot extra remesh budget added to `maxRemeshes` on the next `update()`.
     *  set by `activateRoom` so the post-swap frame populates a chunk halo around
     *  the camera in one spike instead of trickling in over hundreds of frames.
     *  Zeroed after being consumed. */
    remeshAdditionalBudget: number;
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
        remeshAdditionalBudget: 0,
    };
}

/** chunks eagerly remeshed on the first frame after `activateRoom`. one
 *  spiky frame is preferable to multi-second pop-in at the per-frame cap. */
const ROOM_SWAP_REMESH_BUDGET = 20;

// ── update ──────────────────────────────────────────────────────────

/** frames a chunk can sit dirty before starvation boost kicks in. */
const STARVATION_GRACE_FRAMES = 30;
const STARVATION_BOOST_PER_FRAME = (CHUNK_SIZE * CHUNK_SIZE) / 2;

/** sync (main-thread) remesh only fires for chunks within this Chebyshev
 *  radius of the camera's chunk. Everything outside is enqueued to the
 *  worker pool. Keeps the main thread responsive while still hiding
 *  one-frame latency for the chunk the player is editing in front of
 *  themselves. CHUNK_SIZE=16 → 2 chunks = the chunk you're in plus its
 *  immediate ring on each axis. */
const MAIN_THREAD_REMESH_RADIUS_CHUNKS = 2;

/**
 * scan all chunks for dirty flags and either main-thread-remesh them or
 * dispatch them to the worker pool, then upsert results into the engine-
 * global arena packer.
 *
 * Two modes:
 * - `cameraPos === undefined` (offline-renderer): every dirty chunk
 *   meshes synchronously in one pass, no caps.
 * - `cameraPos !== undefined` (live client): dirty chunks sort by
 *   distance² from camera (with starvation boost). A candidate runs on
 *   the main thread only if (a) `mainThreadRemeshBudget` not yet spent
 *   AND (b) the chunk sits within `MAIN_THREAD_REMESH_RADIUS_CHUNKS`
 *   Chebyshev of the camera's chunk. Everything else goes to
 *   `meshDispatcher` (workers); overflow stays dirty and retries next
 *   frame.
 *
 * dirty flags are cleared on (re)mesh OR on successful enqueue; chunks
 * with zero geometry (all air) are evicted from the arena. Worker
 * results are drained at the top of update() — stale results (chunk
 * meshGen has moved on) are discarded.
 */
export function update(
    state: VoxelVisuals,
    voxelResources: VoxelResources,
    voxels: Voxels,
    registry: BlockRegistry,
    cameraPos: Vec3 | undefined,
    mainThreadRemeshBudget: number,
): void {
    const arenas = voxelResources.arenas;
    state.frame++;

    // give the packer this frame's camera so its OOM eviction policy
    // (farthest-from-camera) has a reference point. null in the offline
    // path — packer falls back to evicting an arbitrary chunk.
    packerSetCameraPos(arenas.packer, cameraPos ?? null);

    // drain worker results from last frame. each result carries the
    // meshGen we dispatched at; chunk.meshGen has only stayed equal if
    // nothing mutated it since — otherwise drop (chunk is back in
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

    if (cameraPos === undefined) {
        // unprioritised: full remesh of every dirty chunk in one pass.
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
        const remeshBudget = mainThreadRemeshBudget + state.remeshAdditionalBudget;
        state.remeshAdditionalBudget = 0;

        // Single pass over sorted (closest-first) candidates. A candidate
        // sync-remeshes only if (a) we still have main-thread budget AND
        // (b) it sits within MAIN_THREAD_REMESH_RADIUS_CHUNKS Chebyshev of
        // the camera. Anything else → dispatcher. Each successful enqueue
        // clears chunk.dirty and removes from voxels.dirty.blocks so we
        // don't re-dispatch every frame while a job is in flight. A
        // mutation during flight re-sets dirty + bumps meshGen → stale
        // result dropped on drain, chunk re-dispatched next frame.
        const camCx = Math.floor(cx / CHUNK_SIZE);
        const camCy = Math.floor(cy / CHUNK_SIZE);
        const camCz = Math.floor(cz / CHUNK_SIZE);
        const dispatcher = voxelResources.meshDispatcher;
        let syncDone = 0;
        for (let i = 0; i < remeshCandidates.length; i++) {
            const { key, chunk } = remeshCandidates[i]!;
            const chebyshevChunks = Math.max(
                Math.abs(chunk.cx - camCx),
                Math.abs(chunk.cy - camCy),
                Math.abs(chunk.cz - camCz),
            );
            const canSync = syncDone < remeshBudget
                && chebyshevChunks <= MAIN_THREAD_REMESH_RADIUS_CHUNKS;

            // all-air chunks have no geometry to mesh — evict any prior
            // arena entry inline rather than shipping a ~700 KB no-op job
            // to a worker. matches the sync path's check in `remeshChunk`.
            if (chunk.aggregate === 0) {
                chunk.dirty = false;
                voxels.dirty.blocks.delete(chunk);
                state.dirtyFirstSeen.delete(key);
                writeChunkMesh(voxelResources, key, chunk, null);
                continue;
            }

            if (canSync) {
                chunk.dirty = false;
                voxels.dirty.blocks.delete(chunk);
                state.dirtyFirstSeen.delete(key);
                remeshChunk(voxelResources, voxels, registry, key, chunk);
                syncDone++;
            } else if (dispatcher !== null) {
                if (isInFlight(dispatcher, key)) continue;
                const ok = enqueueMesh(dispatcher, voxels, chunk, chunk.meshGen);
                if (!ok) break;
                chunk.dirty = false;
                voxels.dirty.blocks.delete(chunk);
                state.dirtyFirstSeen.delete(key);
            }
        }
    }

    // evict any arena-held chunk the server has dropped from voxels.chunks.
    // (server discovery owns chunk membership; we just mirror it.)
    for (const key of packerKeys(arenas.packer)) {
        if (!voxels.chunks.has(key)) {
            packerEvictChunk(arenas.packer, key);
        }
    }
}

/** main-thread remesh: run `meshChunk` against the room's shared
 *  `meshOutput`, then install the result via `writeChunkMesh`. */
function remeshChunk(
    voxelResources: VoxelResources,
    voxels: Voxels,
    registry: BlockRegistry,
    key: string,
    chunk: Chunk,
): void {
    const mesh = chunk.aggregate === 0
        ? null
        : meshChunk(voxelResources.meshOutput, buildMeshInput(voxels, chunk), registry);
    writeChunkMesh(voxelResources, key, chunk, mesh);
}

/** upsert a mesh result into the engine-global arena packer (or evict
 *  if the chunk is all-air / has no geometry). Shared between the main-
 *  thread `remeshChunk` path and the worker drain path. */
function writeChunkMesh(
    voxelResources: VoxelResources,
    key: string,
    chunk: Chunk,
    mesh: ChunkMeshResult | null,
): void {
    const packer = voxelResources.arenas.packer;
    if (mesh === null || chunk.aggregate === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

// ── render-time CPU work ────────────────────────────────────────────

const _cpuFrustum = frustum.create();

/** scratch survivor list, reused across frames. one entry per chunk
 *  that passed the shared frustum test, with sort key (distSq to camera
 *  center). sorted ascending; opaque/transparent iterate forward (near→
 *  far early-Z), translucent iterates backward (far→near blend). */
type _Survivor = { alloc: ChunkAlloc; key: number };
const _survivors: _Survivor[] = [];
const _cmpAsc = (a: _Survivor, b: _Survivor) => a.key - b.key;

/** per-pass running counters during emit; mutated in place by
 *  `emitFacingSlices` / inline translucent emit. */
type _PassCounters = { sliceCount: number; instStart: number; wgCount: number };
const _countersO:  _PassCounters = { sliceCount: 0, instStart: 0, wgCount: 0 };
const _countersT:  _PassCounters = { sliceCount: 0, instStart: 0, wgCount: 0 };
const _countersTr: _PassCounters = { sliceCount: 0, instStart: 0, wgCount: 0 };

/** opaque / transparent 7-facing emit. fans the section's facing slices,
 *  cone-culls the 6 axis-aligned ones against camera, and appends each
 *  surviving slice (+ its wgInfo entries) to the pass's output buffers.
 *  inlined as a helper because opaque + transparent run identical logic. */
function emitFacingSlices(
    c: _PassCounters,
    sliceOut: Uint32Array,
    wgOut: Uint32Array,
    faceOffsets: Uint32Array,
    faceCounts: Uint32Array,
    slot: number,
    aabb: Box3,
    cx: number, cy: number, cz: number,
): void {
    const facingBase = slot * 7;
    for (let face = 0; face < 7; face++) {
        const quadCount = faceCounts[facingBase + face]!;
        if (quadCount === 0) continue;

        if (face < 6) {
            // back-face test: for axis-aligned n=±axis, "camera in front
            // of any point on the section's face" reduces to a 1-D bound.
            //   +face back-facing iff camera ≤ aabb.min[axis]
            //   −face back-facing iff camera ≥ aabb.max[axis]
            const axis = FACE_AXIS[face]!;
            const sign = FACE_SIGN[face]!;
            const aMin = aabb[axis]!;
            const aMax = aabb[3 + axis]!;
            const camAxis = axis === 0 ? cx : axis === 1 ? cy : cz;
            if (sign > 0 ? camAxis <= aMin : camAxis >= aMax) continue;
        }

        const base = c.sliceCount * VISIBLE_SLICE_U32S;
        sliceOut[base + 0] = c.instStart;
        sliceOut[base + 1] = slot;
        sliceOut[base + 2] = quadCount;
        sliceOut[base + 3] = faceOffsets[facingBase + face]!;
        for (let q = 0; q < quadCount; q += EXPAND_WG_SIZE) {
            const wgBase = c.wgCount * WG_INFO_U32S;
            wgOut[wgBase + 0] = c.sliceCount;
            wgOut[wgBase + 1] = q;
            c.wgCount++;
        }
        c.sliceCount++;
        c.instStart += quadCount;
    }
}

/** CPU cull: one frustum + distance pass over the active arena's
 *  `packer.chunks`, one sort, then per-pass slice emit. opaque/transparent
 *  emit inside the forward loop (near→far for early-Z); translucent runs
 *  a separate reverse loop (far→near for blend). populates each pass's
 *  `visibleSlicesBuffer` + `wgInfoBuffer` + single `indirectBuffer`
 *  (instanceCount = visibleQuads).
 *
 *  reads/writes only engine-global state on `voxelResources`; no per-room
 *  VoxelVisuals reference needed. must run before `expandDispatches(voxelRes)`
 *  + the per-pass drawIndirect. */
export function cullCPU(voxelResources: VoxelResources, camera: Camera, viewChunkRadius: number): void {
    frustum.setFromViewProjectionMatrix(_cpuFrustum, camera.projectionMatrix, camera.matrixWorldInverse);
    const cx = camera.position[0];
    const cy = camera.position[1];
    const cz = camera.position[2];

    // shared frustum + view-radius cull — one test per chunk, AABB lives on
    // ChunkAlloc. `viewChunkRadius` is read live from settings by the caller,
    // so a tier flip or settings-panel slider applies on the next frame.
    const viewDist = viewChunkRadius * CHUNK_SIZE;
    const viewDistSq = viewDist * viewDist;
    const arenas = voxelResources.arenas;
    const chunks = arenas.packer.chunks;
    _survivors.length = 0;
    for (let i = 0; i < chunks.length; i++) {
        const alloc = chunks[i]!;
        const aabb = alloc.aabb;
        if (!frustum.intersectsBox3(_cpuFrustum, aabb)) continue;
        const dx = (aabb[0] + aabb[3]) * 0.5 - cx;
        const dy = (aabb[1] + aabb[4]) * 0.5 - cy;
        const dz = (aabb[2] + aabb[5]) * 0.5 - cz;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > viewDistSq) continue;
        _survivors.push({ alloc, key: distSq });
    }
    _survivors.sort(_cmpAsc);

    const rO  = voxelResources.passRender.opaque;
    const rT  = voxelResources.passRender.transparent;
    const rTr = voxelResources.passRender.translucent;
    const tO  = arenas.tables.opaque;
    const tT  = arenas.tables.transparent;
    const tTr = arenas.tables.translucent;

    _countersO.sliceCount = 0;  _countersO.instStart = 0;  _countersO.wgCount = 0;
    _countersT.sliceCount = 0;  _countersT.instStart = 0;  _countersT.wgCount = 0;
    _countersTr.sliceCount = 0; _countersTr.instStart = 0; _countersTr.wgCount = 0;

    // forward loop (near→far): opaque + transparent.
    for (let i = 0; i < _survivors.length; i++) {
        const alloc = _survivors[i]!.alloc;
        const aabb = alloc.aabb;

        if (alloc.opaque) {
            emitFacingSlices(_countersO, rO.visibleSlicesData, rO.wgInfoData,
                tO.cpuFaceOffsets, tO.cpuFaceCounts,
                alloc.opaque.sectionSlot, aabb, cx, cy, cz);
        }
        if (alloc.transparent) {
            emitFacingSlices(_countersT, rT.visibleSlicesData, rT.wgInfoData,
                tT.cpuFaceOffsets, tT.cpuFaceCounts,
                alloc.transparent.sectionSlot, aabb, cx, cy, cz);
        }
    }

    // reverse loop (far→near): translucent. one slice per section, no
    // facing fan-out — quadOrder handles in-section ordering.
    const sliceOutTr = rTr.visibleSlicesData;
    const wgOutTr    = rTr.wgInfoData;
    const dataCountTr = tTr.cpuDataCount;
    for (let i = _survivors.length - 1; i >= 0; i--) {
        const alloc = _survivors[i]!.alloc;
        if (!alloc.translucent) continue;
        const slot = alloc.translucent.sectionSlot;
        const quadCount = dataCountTr[slot]!;
        if (quadCount === 0) continue;
        const base = _countersTr.sliceCount * VISIBLE_SLICE_U32S;
        sliceOutTr[base + 0] = _countersTr.instStart;
        sliceOutTr[base + 1] = slot;
        sliceOutTr[base + 2] = quadCount;
        sliceOutTr[base + 3] = 0;             // localBase: identity quadOrder
        for (let q = 0; q < quadCount; q += EXPAND_WG_SIZE) {
            const wgBase = _countersTr.wgCount * WG_INFO_U32S;
            wgOutTr[wgBase + 0] = _countersTr.sliceCount;
            wgOutTr[wgBase + 1] = q;
            _countersTr.wgCount++;
        }
        _countersTr.sliceCount++;
        _countersTr.instStart += quadCount;
    }

    // commit + upload per pass.
    commitPass(rO,  _countersO);
    commitPass(rT,  _countersT);
    commitPass(rTr, _countersTr);
}

function commitPass(r: PassRender, c: _PassCounters): void {
    r.visibleSliceCount = c.sliceCount;
    r.wgCount = c.wgCount;
    r.visibleQuadCount = c.instStart;

    if (c.sliceCount > 0) {
        r.visibleSlicesBuffer.addUpdateRange(0, c.sliceCount * VISIBLE_SLICE_U32S);
        r.visibleSlicesBuffer.needsUpdate = true;
    }
    if (c.wgCount > 0) {
        r.wgInfoBuffer.addUpdateRange(0, c.wgCount * WG_INFO_U32S);
        r.wgInfoBuffer.needsUpdate = true;
    }
    // single-entry indirect: {vertexCount=6, instanceCount, 0, 0}.
    r.indirectData[1] = c.instStart;
    r.indirectBuffer.addUpdateRange(0, r.indirectData.length);
    r.indirectBuffer.needsUpdate = true;
}

/** engine-global expansion compute dispatches — fans every visible slice
 *  out into per-quad `visibleQuads` entries. push into the renderer's
 *  per-frame dispatch list before `renderer.compute(...)`. one dispatch
 *  per pass; skipped if the pass has zero visible slices this frame. */
export function expandDispatches(voxelResources: VoxelResources): ComputeDispatch[] {
    const out: ComputeDispatch[] = [];
    for (const pass of PASSES) {
        const r = voxelResources.passRender[pass];
        if (r.wgCount === 0) continue;
        out.push({
            node: voxelResources.expandSlices,
            dispatch: [r.wgCount, 1, 1],
            buffers: {
                wgInfo: r.wgInfoBuffer,
                visibleSlices: r.visibleSlicesBuffer,
                visibleQuads: r.visibleQuadsBuffer,
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
    // skip aggregate=0 chunks — those are sparse "discovered empty" stubs
    // pushed by `voxel_chunk_empty`. they have no blocks to mesh and would
    // otherwise pollute `remeshCandidates` (sort cost) and waste budget on
    // applyRemesh early-returns.
    for (const chunk of voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        chunk.dirty = true;
        voxels.dirty.blocks.add(chunk);
    }
    state.dirtyFirstSeen.clear();
    state.remeshAdditionalBudget = ROOM_SWAP_REMESH_BUDGET;
}

export function dispose(state: VoxelVisuals, scene: Scene): void {
    for (const pass of PASSES) {
        scene.remove(state.meshes[pass]!);
    }
}
