// VoxelResources, engine-global GPU resources backing all voxel rendering.
//
// Owns the texture array atlas, the per-layer texture-animation buffer,
// the unified chunk-renderer quad materials (one per pass), the GPU
// expansion compute, and the engine-level voxel arenas + per-pass
// render scratch + geometries. Rooms own only the per-pass `Mesh`
// objects (added to their scene) and per-room dirty/voxel state.
//
// One instance per `EngineClient` (and one per offline-render task);
// shared across every room. The active room owns the arena state; on
// room swap, `packerClearAll` resets the arena and the new room's
// chunks re-mesh via the existing prioritised remesh path.
//
// Lifetime is tied to the active project module: built once on engine
// load from `module.blocks`, rebuilt on script reload (block defs and
// textures may have changed).

import type { ArrayTexture, Material, WebGPURenderer } from 'gpucat';
import {
    abs,
    add,
    and,
    atomicAdd,
    atomicLoad,
    atomicStore,
    BufferLifecycle,
    createIndirectBuffer,
    createStorageBuffer,
    DrawIndirect,
    d,
    dot,
    Fn,
    f32,
    Geometry,
    globalId,
    GpuBuffer,
    i32,
    If,
    index,
    layoutStrideOf,
    localId,
    Loop,
    min,
    or,
    packTo,
    Return,
    select,
    storage,
    struct,
    sub,
    u32,
    vec3f,
    vec4f,
    While,
    workgroupBarrier,
    workgroupId,
    WorkgroupVar,
} from 'gpucat';
import type { ComputeNode } from 'gpucat/dist/nodes/nodes';
import type { Box3, Vec3 } from 'mathcat';
import type { Resources } from '../../core/resources';
import type { BlockRegistry } from '../../core/voxels/block-registry';
import {
    type ChunkMeshResult,
    createMeshOutput,
    type MeshOutput,
    type PassMesh,
    QUAD_STRIDE_U32S,
} from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment';
import * as Performance from '../performance';
import {
    createMeshDispatcher,
    disposeMeshDispatcher,
    type MeshDispatcher,
    type MeshDispatcherResult,
    setMeshRegistry,
} from './mesh-dispatcher';
import { createOffsetAllocator, type OffsetAllocator, oaAllocate, oaFree, oaStorageReport } from './offset-allocator';
import { createQuadMaterial, decodeQuadCentroid, decodeQuadNormal, type VoxelPass } from './voxel-material';
import {
    type BlockTextureAtlasMetadata,
    createVoxelTextureArray,
    fetchBlockTextureAtlasMetadata,
    loadBlockTextureAtlasIntoTextureArray,
    writeBlockTextureAtlasIntoTextureArray,
} from './voxel-texture-array';

export const PASSES: readonly VoxelPass[] = ['opaque', 'transparent', 'translucent'];

// ── ChunkInfo ───────────────────────────────────────────────────────
//
// per-section GPU side-table. one entry per occupied SectionTable slot;
// the VS reads chunkInfo[slot] to recover the chunk's worldspace origin
// and arena base. tightly packed (16B) so a workgroup-coherent read of
// adjacent slots stays in cache.
//
// arenaBase = the section's dataStart in the shared quadArena. combined
// with VisibleQuad.localIdx in the VS to produce the absolute realQuadId
// for quads / light lookups.

export const ChunkInfo = /* @__PURE__ */ struct('VoxelChunkInfo', {
    origin: d.vec3f,
    arenaBase: d.u32,
});

// ── VisibleQuad ─────────────────────────────────────────────────────
//
// per-frame GPU-built table: one entry per visible quad. VS reads
// visibleQuads[instanceIndex] → (slot, localIdx), derefs chunkInfo[slot]
// for arenaBase + origin, and computes realQuadId = arenaBase + localIdx
// to index quads / light.

export const VisibleQuad = /* @__PURE__ */ struct('VoxelVisibleQuad', {
    slot: d.u32,
    localIdx: d.u32,
});

// ── TranslucentSortEntry ────────────────────────────────────────────
//
// Level-B gated quad sort input, one entry per *triggered* DYNAMIC translucent
// section (CPU-built each frame, dense). The sort compute runs one workgroup per
// entry, orders the section's quads by camera distance, and overwrites its
// `quadOrder` slice. Everything the shader needs is folded in so it binds only
// `quads` + `quadOrder` (no meta/chunkInfo): `relOrigin` is the section min-corner
// camera-relative (CPU computes it as worldOrigin − cameraPos, small + f32-exact
// within render distance), and arenaBase/quadOrderStart/dataCount locate the
// section's quads + order slice. dataCount is CPU-capped to SORT_CAP.

export const TranslucentSortEntry = /* @__PURE__ */ struct('VoxelTranslucentSortEntry', {
    relOrigin: d.vec3f,
    arenaBase: d.u32,
    quadOrderStart: d.u32,
    dataCount: d.u32,
});

export const TRANSLUCENT_SORT_ENTRY_STRIDE = /* @__PURE__ */ layoutStrideOf(TranslucentSortEntry);

// max quads a section can sort in one workgroup (workgroup-memory bound:
// SORT_CAP × (f32 key + u32 index) = 8 KiB at 1024). DYNAMIC sections above this
// keep their previous/identity order — the CPU trigger loop filters + logs them.
export const SORT_CAP = 1024;
const SORT_WG = 256;

// ── ChunkCullRecord ─────────────────────────────────────────────────
//
// GPU cull input, one entry per resident chunk, mirroring `packer.chunks`
// 1:1 (same array index). Consumed by the cull compute (frustum, once per
// chunk) and — for survivors — the emit compute (per-facing back-face cull
// + quad write).
//
// Chunk coords are INTEGERS: the cull/emit reconstruct the section center
// camera-relative (`(cx - camCx) * CHUNK_SIZE …`), keeping the frustum math
// in a small, f32-exact domain even at Minecraft world scale (absolute f32
// world coords lose precision past ~2^24).
//
// Per-pass section slots index that pass's SectionTable / metaBuffer /
// visibleQuads; -1 means the chunk has no geometry in that pass.

export const ChunkCullRecord = /* @__PURE__ */ struct('VoxelChunkCullRecord', {
    cx: d.i32,
    cy: d.i32,
    cz: d.i32,
    opaqueSlot: d.i32,
    transparentSlot: d.i32,
    translucentSlot: d.i32,
});

export const CHUNK_CULL_RECORD_STRIDE = /* @__PURE__ */ layoutStrideOf(ChunkCullRecord);
const CHUNK_CULL_RECORD_U32S = CHUNK_CULL_RECORD_STRIDE / 4;

// ── VisibleChunk ────────────────────────────────────────────────────
//
// Cull output: one entry per *surviving* chunk (compacted). Carries the
// per-pass section slots, the camera-relative section center (so the emit /
// count passes can run the per-facing back-face cone-cull without re-reading
// camera state), and the distance bucket for Level-A ordering. `relCenter.w`
// is unused padding.

export const VisibleChunk = /* @__PURE__ */ struct('VoxelVisibleChunk', {
    opaqueSlot: d.i32,
    transparentSlot: d.i32,
    translucentSlot: d.i32,
    /** coarse distance bucket [0, BUCKET_COUNT): 0 = nearest. */
    bucket: d.u32,
    relCenter: d.vec4f,
});

// Coarse distance buckets for section ordering. Chunks are bucketed by distance
// (even in distance, via sqrt), then instance ranges are assigned bucket-by-
// bucket: ascending → front-to-back (opaque/transparent, early-Z), descending →
// back-to-front (translucent inter-section).
export const BUCKET_COUNT = 256;

export const VISIBLE_QUAD_STRIDE = /* @__PURE__ */ layoutStrideOf(VisibleQuad);
export const DRAW_INDIRECT_STRIDE = /* @__PURE__ */ layoutStrideOf(DrawIndirect);

// ── GPU cull ────────────────────────────────────────────────────────
//
// Per-frame camera state the cull compute reads. Everything is expressed
// so the frustum test runs in a small, f32-exact domain regardless of how
// far the camera is from the world origin (Minecraft-scale coords):
//   - camMeta.xyz = camera chunk coords (integers, f32-exact well past MC range)
//   - camMeta.w   = live record count (cull dispatch bound)
//   - camFrac.xyz = camera offset within its chunk [0, CHUNK_SIZE)
//   - camFrac.w   = squared view-radius cutoff (camera-relative distance²)
//   - plane0..4   = 5 frustum planes (far plane dropped; view radius bounds it),
//                   camera-relative with the section half-extent folded into .w
//                   (Sodium's trick), so the test is `dot(plane.xyz, rel) + plane.w >= 0`.

export const CullView = /* @__PURE__ */ struct('VoxelCullView', {
    plane0: d.vec4f,
    plane1: d.vec4f,
    plane2: d.vec4f,
    plane3: d.vec4f,
    plane4: d.vec4f,
    camMeta: d.vec4f,
    camFrac: d.vec4f,
});

export const CULL_VIEW_STRIDE = /* @__PURE__ */ layoutStrideOf(CullView);

export const CULL_WG_SIZE = 64;

// one thread per resident ChunkCullRecord; frustum + distance test once per
// chunk, compact survivors into `visibleChunks`. Uses workgroup-local
// compaction: survivors bump a shared counter, then lane 0 reserves the whole
// workgroup's output range with ONE global atomic into `emitArgs[0]` (instead
// of one global atomic per surviving chunk — the contention that dominated the
// pass). `emitArgs` is pre-seeded `[0, 7, 1]`, so after the pass it *is* the
// per-facing emit dispatch `[visibleChunkCount, 7, 1]`.
function createCullCompute(): ComputeNode {
    const wgCount = WorkgroupVar('wgCount', d.atomic(d.u32)); // workgroup survivor count
    const wgBase = WorkgroupVar('wgBase', d.u32); // this workgroup's global output base
    return Fn(() => {
        const records = storage('cullRecords', d.array(ChunkCullRecord), 'read');
        const view = storage('cullView', d.array(CullView), 'read');
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read_write');
        const emitArgs = storage('emitArgs', d.array(d.atomic(d.u32)), 'read_write');

        // reset the shared counter (workgroup memory is undefined at dispatch start).
        If(localId.x.equal(u32(0)), () => {
            atomicStore(wgCount, u32(0));
        });
        workgroupBarrier();

        const vw = view.element(u32(0));
        const camMeta = vw.field('camMeta').toVar('camMeta');
        const camFrac = vw.field('camFrac').toVar('camFrac');

        const i = globalId.x;
        const rec = records.element(i);
        // camera-relative section center: (chunk − camChunk)·CHUNK_SIZE stays in
        // int-exact range, + (half − frac) puts the origin near the camera.
        const half = f32(CHUNK_SIZE * 0.5);
        const relX = sub(rec.field('cx').toF32(), camMeta.x).mul(f32(CHUNK_SIZE)).add(sub(half, camFrac.x));
        const relY = sub(rec.field('cy').toF32(), camMeta.y).mul(f32(CHUNK_SIZE)).add(sub(half, camFrac.y));
        const relZ = sub(rec.field('cz').toF32(), camMeta.z).mul(f32(CHUNK_SIZE)).add(sub(half, camFrac.z));
        const rel = vec3f(relX, relY, relZ).toVar('rel');

        const p0 = vw.field('plane0');
        const p1 = vw.field('plane1');
        const p2 = vw.field('plane2');
        const p3 = vw.field('plane3');
        const p4 = vw.field('plane4');
        // single `survive` bool — no early return, so every lane reaches the
        // barriers below. `i >= recordCount` tail threads fail `inRange`; their
        // out-of-bounds record read is clamped-safe (WebGPU robustness) and
        // discarded by the AND.
        const distSq = dot(rel, rel).toVar('distSq');
        const survive = and(
            and(
                and(and(and(and(i.toF32().lessThan(camMeta.w), dot(p0.xyz, rel).add(p0.w).greaterThanEqual(f32(0))), dot(p1.xyz, rel).add(p1.w).greaterThanEqual(f32(0))), dot(p2.xyz, rel).add(p2.w).greaterThanEqual(f32(0))), dot(p3.xyz, rel).add(p3.w).greaterThanEqual(f32(0))),
                dot(p4.xyz, rel).add(p4.w).greaterThanEqual(f32(0)),
            ),
            distSq.lessThanEqual(camFrac.w),
        ).toVar('survive');

        // workgroup-local slot for survivors.
        const localSlot = u32(0).toVar('localSlot');
        If(survive, () => {
            localSlot.assign(atomicAdd(wgCount, u32(1)).toU32());
        });
        workgroupBarrier();

        // lane 0 reserves [wgBase, wgBase + survivorCount) with one global atomic.
        If(localId.x.equal(u32(0)), () => {
            wgBase.assign(atomicAdd(index(emitArgs, u32(0)), atomicLoad(wgCount).toU32()).toU32());
        });
        workgroupBarrier();

        If(survive, () => {
            // L1 (Manhattan) chunk-cell distance bucket. If section A occludes B
            // along any ray, per-axis betweenness gives L1(A) < L1(B) by ≥1 whole
            // cell — so sections in the SAME bucket can never occlude each other,
            // making the same-bucket atomic-reservation order provably invisible
            // (kills the radial-quantization flicker). Integer, no sqrt. Max L1 =
            // 3·viewChunkRadius, clamped to K-1.
            const dcx = abs(sub(rec.field('cx').toF32(), camMeta.x));
            const dcy = abs(sub(rec.field('cy').toF32(), camMeta.y));
            const dcz = abs(sub(rec.field('cz').toF32(), camMeta.z));
            const bucket = min(add(dcx, add(dcy, dcz)), f32(BUCKET_COUNT - 1)).toU32();
            const out = visible.element(add(wgBase, localSlot)).fields();
            out.opaqueSlot.assign(rec.field('opaqueSlot'));
            out.transparentSlot.assign(rec.field('transparentSlot'));
            out.translucentSlot.assign(rec.field('translucentSlot'));
            out.bucket.assign(bucket);
            out.relCenter.assign(vec4f(rel.x, rel.y, rel.z, f32(0)));
        });
    }).compute({ workgroupSize: [CULL_WG_SIZE, 1, 1], name: 'voxel-cull' });
}

export const EMIT_WG_SIZE = 64;

// per-facing emit for the OPAQUE / TRANSPARENT passes (translucent uses the
// whole-section emit below). dispatched per pass over `visibleChunks` with a 2D
// shape [visibleChunkCount, 7, 1]: workgroupId.x = visible-chunk index, .y =
// facing (0..5 cardinal, 6 UNASSIGNED). Reads this pass's section slot from the
// record (3-way select on emitConfig.pass), back-face cone-culls cardinal
// facings, then the lanes stride-write the facing's quads straight into
// `visibleQuads` at their distance bucket's base.
//
// emitConfig: [0] = pass (0 opaque, 1 transparent, 2 translucent), [1] = 1 to
// back-face cull (opaque/transparent), 0 to emit every facing (translucent).
function createEmitCompute(): ComputeNode {
    // workgroup-shared base index for this facing's instance range, reserved
    // once (by lane 0) so the atomicAdd isn't run per-lane.
    const emitBase = WorkgroupVar('emitBase', d.u32);
    return Fn(() => {
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read');
        const meta = storage('sectionMeta', d.array(d.u32), 'read');
        const visibleQuads = storage('visibleQuads', d.array(VisibleQuad), 'read_write');
        const bucketBase = storage('bucketBase', d.array(d.u32), 'read');
        const bucketCursor = storage('bucketCursor', d.array(d.atomic(d.u32)), 'read_write');
        const cfg = storage('emitConfig', d.array(d.u32), 'read');

        const chunkIdx = workgroupId.x;
        const facing = workgroupId.y.toVar('facing');
        const vc = visible.element(chunkIdx);
        const passN = index(cfg, u32(0)).toVar('pass');

        // 3-way slot select: pass 0→opaque, 1→transparent, 2→translucent.
        const slotI = select(
            vc.field('opaqueSlot'),
            select(vc.field('transparentSlot'), vc.field('translucentSlot'), passN.equal(u32(2))),
            passN.notEqual(u32(0)),
        ).toVar('slot');
        If(slotI.lessThan(i32(0)), () => {
            Return(); // chunk has no geometry in this pass
        });

        const slotU = slotI.toU32().toVar('slotU');
        const metaBase = slotU.mul(u32(SECTION_META_U32S)).toVar('metaBase');
        // GPU meta layout: [faceOffsets[0..6], faceCounts[0..6]].
        const faceCount = index(meta, add(metaBase, add(u32(7), facing))).toVar('faceCount');
        If(faceCount.equal(u32(0)), () => {
            Return();
        });
        const faceOffset = index(meta, add(metaBase, facing)).toVar('faceOffset');

        // back-face cone-cull: cardinal facing f visible iff its outward face
        // is toward the camera. Uses the camera-relative center; +face (even f)
        // visible when axis < +half, −face (odd f) when axis > −half. Skipped
        // when emitConfig[1] == 0 (translucent) or facing == 6 (UNASSIGNED).
        const doCull = and(index(cfg, u32(1)).notEqual(u32(0)), facing.lessThan(u32(6)));
        const rel = vc.field('relCenter');
        const half = f32(CHUNK_SIZE * 0.5);
        const negHalf = f32(-CHUNK_SIZE * 0.5);
        const axisVal = select(select(rel.z, rel.y, facing.lessThan(u32(4))), rel.x, facing.lessThan(u32(2))).toVar('axisVal');
        const isPlus = facing.mod(u32(2)).equal(u32(0));
        const facingVisible = select(axisVal.greaterThan(negHalf), axisVal.lessThan(half), isPlus);
        If(and(doCull, facingVisible.not()), () => {
            Return();
        });

        // reserve this facing's instance range ONCE per workgroup (lane 0): its
        // distance bucket's base plus a running within-bucket cursor bump. This
        // places the quads in bucket order (front-to-back, or back-to-front for
        // translucent via the reversed bucket index — matching the count pass).
        // Per-lane would inflate the count ~64× and scatter the writes. The
        // early-outs above are workgroup-uniform, so every lane reaches the barrier.
        If(localId.x.equal(u32(0)), () => {
            const b = vc.field('bucket');
            const bIdx = select(b, sub(u32(BUCKET_COUNT - 1), b), passN.equal(u32(2)));
            const idx = add(passN.mul(u32(BUCKET_COUNT)), bIdx);
            emitBase.assign(add(index(bucketBase, idx), atomicAdd(index(bucketCursor, idx), faceCount).toU32()));
        });
        workgroupBarrier();

        const qi = localId.x.toVar('qi');
        While(qi.lessThan(faceCount), () => {
            const o = visibleQuads.element(add(emitBase, qi)).fields();
            o.slot.assign(slotU);
            o.localIdx.assign(add(faceOffset, qi));
            qi.addAssign(u32(EMIT_WG_SIZE));
        });
    }).compute({ workgroupSize: [EMIT_WG_SIZE, 1, 1], name: 'voxel-emit' });
}

// whole-section emit for the TRANSLUCENT pass. Back-to-front blend order mixes
// facings (a +Y water quad can sit behind a +X glass quad), so translucent can't
// use the per-facing emit — its order is a single per-section permutation. And it
// never back-face-culls (every facing draws), so the per-facing split buys it
// nothing anyway. Dispatched [visibleChunkCount, 7, 1] on the same emitArgs as the
// per-facing emit, but only workgroupId.y == 0 does work (one workgroup per chunk);
// the section's quads are emitted in `quadOrder` order (identity for NONE-sorted
// sections, distance-sorted for DYNAMIC once the Level-B gated sort runs).
function createTranslucentEmitCompute(): ComputeNode {
    const emitBase = WorkgroupVar('emitBase', d.u32);
    return Fn(() => {
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read');
        const meta = storage('sectionMeta', d.array(d.u32), 'read');
        const visibleQuads = storage('visibleQuads', d.array(VisibleQuad), 'read_write');
        const bucketBase = storage('bucketBase', d.array(d.u32), 'read');
        const bucketCursor = storage('bucketCursor', d.array(d.atomic(d.u32)), 'read_write');
        const quadOrder = storage('quadOrder', d.array(d.u32), 'read');

        // one workgroup per chunk: the emitArgs shape is [count, 7, 1] (shared with
        // the per-facing emit), so drop the 6 extra facing-workgroups. Uniform.
        If(workgroupId.y.notEqual(u32(0)), () => {
            Return();
        });

        const vc = visible.element(workgroupId.x);
        const slotI = vc.field('translucentSlot').toVar('slot');
        If(slotI.lessThan(i32(0)), () => {
            Return();
        });
        const slotU = slotI.toU32().toVar('slotU');
        const metaBase = slotU.mul(u32(SECTION_META_U32S)).toVar('metaBase');
        // total quads = faceOffsets[6] + faceCounts[6] (facings laid out contiguously).
        const dataCount = add(index(meta, add(metaBase, u32(6))), index(meta, add(metaBase, u32(13)))).toVar('dataCount');
        If(dataCount.equal(u32(0)), () => {
            Return();
        });
        const quadOrderStart = index(meta, add(metaBase, u32(SECTION_META_QUAD_ORDER_START))).toVar('quadOrderStart');

        // reserve the whole section's instance range in its reversed (far→near)
        // distance bucket — matching the count pass's per-facing tally, which sums
        // to dataCount since translucent never back-face-culls.
        If(localId.x.equal(u32(0)), () => {
            const bIdx = sub(u32(BUCKET_COUNT - 1), vc.field('bucket'));
            const idx = add(u32(2 * BUCKET_COUNT), bIdx);
            emitBase.assign(add(index(bucketBase, idx), atomicAdd(index(bucketCursor, idx), dataCount).toU32()));
        });
        workgroupBarrier();

        const qi = localId.x.toVar('qi');
        While(qi.lessThan(dataCount), () => {
            const o = visibleQuads.element(add(emitBase, qi)).fields();
            o.slot.assign(slotU);
            // section-local quad index in draw order; VS adds arenaBase → realQuadId.
            o.localIdx.assign(index(quadOrder, add(quadOrderStart, qi)));
            qi.addAssign(u32(EMIT_WG_SIZE));
        });
    }).compute({ workgroupSize: [EMIT_WG_SIZE, 1, 1], name: 'voxel-emit-translucent' });
}

// ── Level-B translucent quad sort ───────────────────────────────────
//
// Gated per-section sort: one workgroup per triggered DYNAMIC section (dispatched
// [triggeredCount, 1, 1] — the count is CPU-known, so a direct dispatch). Loads
// the section's quad centroids (decoded in-shader, camera-relative), bitonic-sorts
// them by distance, and overwrites `quadOrder[start..]` with the far→near
// permutation the whole-section translucent emit reads. Runs before the cull chain
// (separate pass); `quadOrder` persists between sorts, so untriggered sections
// keep their last order. The bitonic network is fixed-size (SORT_CAP), unrolled at
// graph-build time — 55 compare stages, cheap for the few sections triggered/frame.
function createTranslucentSortCompute(): ComputeNode {
    // Sort each section's quads back-to-front. Lexicographic key per quad:
    //   primary   = |camRel|²    (radial distance² to the quad centroid)
    //   tie-break = -(n·camRel)   (signed facing)
    // Both terms are ROTATION-INVARIANT (depend only on positions, not the view
    // direction), so a translation-only re-sort gate is sound and orbiting-in-place
    // needs no re-sort. Radial distance is the Sodium/Minecraft DYNAMIC key: it
    // orders quads of any orientation by their actual distance (unlike a plane-
    // distance key, which mis-ranks perpendicular faces). COINCIDENT interface faces
    // of two adjacent translucent blocks share a centroid (equal primary) and have
    // opposite normals, so the tie-break resolves them by facing. Residual: a per-
    // quad scalar can't perfectly rank quads at ~equal radial distance but different
    // depth (grazing/perpendicular) — that's the BSP end-state's job.
    const wgKey = WorkgroupVar('sortKey', d.sizedArray(d.f32, SORT_CAP));
    const wgKey2 = WorkgroupVar('sortKey2', d.sizedArray(d.f32, SORT_CAP));
    const wgIdx = WorkgroupVar('sortIdx', d.sizedArray(d.u32, SORT_CAP));
    return Fn(() => {
        const entries = storage('sortEntries', d.array(TranslucentSortEntry), 'read');
        const quads = storage('quads', d.array(d.u32), 'read');
        const quadOrder = storage('quadOrder', d.array(d.u32), 'read_write');

        const e = entries.element(workgroupId.x);
        const relOrigin = e.field('relOrigin').toVar('relOrigin');
        const arenaBase = e.field('arenaBase').toVar('arenaBase');
        const quadOrderStart = e.field('quadOrderStart').toVar('quadOrderStart');
        const dataCount = e.field('dataCount').toVar('dataCount');
        const lid = localId.x;

        // load keys: real quads → (radial dist², signed facing); padding → +inf.
        for (let t = 0; t < SORT_CAP / SORT_WG; t++) {
            const slot = lid.add(u32(t * SORT_WG)).toVar(`loadSlot${t}`);
            If(slot.lessThan(dataCount), () => {
                const centroidByte = decodeQuadCentroid(quads, arenaBase.add(slot)).toVar(`cb${t}`);
                const camRel = relOrigin.add(centroidByte.mul(f32(CHUNK_SIZE / 255))).toVar(`camRel${t}`);
                const normal = decodeQuadNormal(quads, arenaBase.add(slot)).toVar(`nrm${t}`);
                // primary: radial distance² from the camera to the quad centroid
                // (Sodium/Minecraft DYNAMIC key). Rotation-invariant — depends only
                // on positions — so the translation-only re-sort gate stays sound.
                // Orders quads of ANY orientation by actual distance (a plane-distance
                // key mis-ranks perpendicular faces; radial doesn't).
                wgKey.element(slot).assign(dot(camRel, camRel));
                // tie-break: coincident faces share a centroid (equal primary) and
                // have opposite normals — the camera-facing one (n·camRel<0 → key>0)
                // sorts later → drawn first = the farther block's front surface.
                wgKey2.element(slot).assign(dot(normal, camRel).mul(f32(-1)));
            }).Else(() => {
                // +inf sentinel (< 1e21 so gpucat's float formatter doesn't emit a
                // JS exponent → invalid WGSL `3e+38.0`); far above any real key.
                wgKey.element(slot).assign(f32(1e20));
                wgKey2.element(slot).assign(f32(1e20));
            });
            wgIdx.element(slot).assign(slot);
        }
        workgroupBarrier();

        // bitonic sort ascending by (wgKey, wgKey2) lexicographically. `bit`/
        // `lowMask` are graph-build constants, so the partner index is a constant-
        // shift bit-insert (each of the SORT_CAP/2 pairs handled once, no guard).
        for (let k = 2; k <= SORT_CAP; k <<= 1) {
            for (let j = k >> 1; j > 0; j >>= 1) {
                const bit = Math.log2(j);
                const lowMask = (1 << bit) - 1;
                for (let t = 0; t < SORT_CAP / 2 / SORT_WG; t++) {
                    const c = lid.add(u32(t * SORT_WG));
                    const idxE = c.shiftRight(u32(bit)).shiftLeft(u32(bit + 1)).bitwiseOr(c.bitwiseAnd(u32(lowMask))).toVar(`e${k}_${j}_${t}`);
                    const idxP = idxE.bitwiseOr(u32(j)).toVar(`p${k}_${j}_${t}`);
                    const ascending = idxE.bitwiseAnd(u32(k)).equal(u32(0));
                    const keyE = wgKey.element(idxE).toVar(`ke${k}_${j}_${t}`);
                    const keyP = wgKey.element(idxP).toVar(`kp${k}_${j}_${t}`);
                    const key2E = wgKey2.element(idxE).toVar(`2e${k}_${j}_${t}`);
                    const key2P = wgKey2.element(idxP).toVar(`2p${k}_${j}_${t}`);
                    // lexicographic: depth first, normal tie-break on equal depth.
                    const primEq = keyE.equal(keyP);
                    const eGreater = or(keyE.greaterThan(keyP), and(primEq, key2E.greaterThan(key2P)));
                    const eLess = or(keyE.lessThan(keyP), and(primEq, key2E.lessThan(key2P)));
                    // ascending region wants E ≤ P (swap if greater); descending inverts.
                    const needSwap = select(eLess, eGreater, ascending);
                    If(needSwap, () => {
                        const iE = wgIdx.element(idxE).toVar(`ie${k}_${j}_${t}`);
                        wgKey.element(idxE).assign(keyP);
                        wgKey.element(idxP).assign(keyE);
                        wgKey2.element(idxE).assign(key2P);
                        wgKey2.element(idxP).assign(key2E);
                        wgIdx.element(idxE).assign(wgIdx.element(idxP));
                        wgIdx.element(idxP).assign(iE);
                    });
                }
                workgroupBarrier();
            }
        }

        // writeback reversed: quadOrder[start+0] = farthest quad (drawn first for
        // back-to-front blending). ascending sort put nearest at index 0.
        for (let t = 0; t < SORT_CAP / SORT_WG; t++) {
            const pos = lid.add(u32(t * SORT_WG)).toVar(`wbPos${t}`);
            If(pos.lessThan(dataCount), () => {
                const src = sub(sub(dataCount, u32(1)), pos);
                quadOrder.element(add(quadOrderStart, pos)).assign(wgIdx.element(src));
            });
        }
    }).compute({ workgroupSize: [SORT_WG, 1, 1], name: 'voxel-sort-translucent' });
}

// Level-A section ordering: count → finalize → bucketed emit.
//
// `bucketQuads`/`bucketBase`/`bucketCursor` are laid out `[pass*BUCKET_COUNT + b]`.
// Opaque/transparent use the bucket directly (near→far, front-to-back); the
// translucent pass reverses it (`BUCKET_COUNT-1-b`, far→near) so its instances
// come out back-to-front for correct blending.

/** count pass: one thread per (visible chunk, facing). Repeats the emit's slot
 *  select + back-face cone-cull, then adds the facing's quad count into its
 *  distance bucket. Dispatched `[visibleChunkCount, 7, 1]` (indirect). */
function createCountCompute(): ComputeNode {
    return Fn(() => {
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read');
        const meta = storage('sectionMeta', d.array(d.u32), 'read');
        const bucketQuads = storage('bucketQuads', d.array(d.atomic(d.u32)), 'read_write');
        const cfg = storage('emitConfig', d.array(d.u32), 'read');

        const facing = workgroupId.y.toVar('facing');
        const vc = visible.element(workgroupId.x);
        const passN = index(cfg, u32(0)).toVar('pass');

        const slotI = select(
            vc.field('opaqueSlot'),
            select(vc.field('transparentSlot'), vc.field('translucentSlot'), passN.equal(u32(2))),
            passN.notEqual(u32(0)),
        ).toVar('slot');
        If(slotI.lessThan(i32(0)), () => {
            Return();
        });
        const metaBase = slotI.toU32().mul(u32(SECTION_META_U32S)).toVar('metaBase');
        const faceCount = index(meta, add(metaBase, add(u32(7), facing))).toVar('faceCount');
        If(faceCount.equal(u32(0)), () => {
            Return();
        });

        const doCull = and(index(cfg, u32(1)).notEqual(u32(0)), facing.lessThan(u32(6)));
        const rel = vc.field('relCenter');
        const half = f32(CHUNK_SIZE * 0.5);
        const negHalf = f32(-CHUNK_SIZE * 0.5);
        const axisVal = select(select(rel.z, rel.y, facing.lessThan(u32(4))), rel.x, facing.lessThan(u32(2))).toVar('axisVal');
        const isPlus = facing.mod(u32(2)).equal(u32(0));
        const facingVisible = select(axisVal.greaterThan(negHalf), axisVal.lessThan(half), isPlus);
        If(and(doCull, facingVisible.not()), () => {
            Return();
        });

        // translucent (pass 2) reverses the bucket → far→near.
        const b = vc.field('bucket').toVar('b');
        const bIdx = select(b, sub(u32(BUCKET_COUNT - 1), b), passN.equal(u32(2)));
        atomicAdd(index(bucketQuads, add(passN.mul(u32(BUCKET_COUNT)), bIdx)), faceCount);
    }).compute({ workgroupSize: [1, 1, 1], name: 'voxel-count' });
}

/** finalize pass (single thread): exclusive prefix-sum each pass's buckets into
 *  `bucketBase`, reset `bucketCursor`, and write each pass's draw instanceCount
 *  (bucket total). Runs after count, before emit. */
function createFinalizeCompute(): ComputeNode {
    return Fn(() => {
        const bucketQuads = storage('bucketQuads', d.array(d.atomic(d.u32)), 'read_write');
        const bucketBase = storage('bucketBase', d.array(d.u32), 'read_write');
        const bucketCursor = storage('bucketCursor', d.array(d.atomic(d.u32)), 'read_write');
        const draws = [
            storage('drawOpaque', d.array(d.u32), 'read_write'),
            storage('drawTransparent', d.array(d.u32), 'read_write'),
            storage('drawTranslucent', d.array(d.u32), 'read_write'),
        ];
        for (let p = 0; p < 3; p++) {
            const running = u32(0).toVar(`running${p}`);
            Loop({ start: 0, end: BUCKET_COUNT, type: d.u32 }, ({ i }) => {
                const idx = add(u32(p * BUCKET_COUNT), i);
                bucketBase.element(idx).assign(running);
                running.addAssign(atomicLoad(index(bucketQuads, idx)).toU32());
                atomicStore(index(bucketCursor, idx), u32(0));
            });
            // draw indirect: [vertexCount=6, instanceCount, 0, 0].
            draws[p]!.element(u32(1)).assign(running);
        }
    }).compute({ workgroupSize: [1, 1, 1], name: 'voxel-finalize' });
}

// ── PassRender ──────────────────────────────────────────────────────
//
// per-pass render-side resources rebuilt each frame by `cullCPU` and
// consumed by the expansion compute + draw. one engine-global instance
// per pass, populated by whichever room is active.

export type PassRender = {
    /** GPU emit output. one entry per visible quad; instance i of the draw
     *  reads visibleQuads[i]. sized to a worst-case bound. */
    visibleQuadsBuffer: GpuBuffer;
    /** single-entry indirect: vertexCount=6, instanceCount written by the
     *  emit compute's atomicAdd (reset to 0 each frame by `updateCull`). */
    indirectBuffer: GpuBuffer;
    indirectData: Uint32Array;
};

// ── SegmentArena ────────────────────────────────────────────────────
//
// fixed-count, slot-indexed allocator over N lock-stepped GpuBuffer
// streams. each stream has its own `perSlot` element count but slot
// indices are shared, allocating slot range [s, s+k) gives you the
// same range in every stream.
//
// suballocator is OffsetAllocator (TLSF-style, 256 bins, 3-bit
// mantissa). constant-time alloc/free, ≤12.5% per-allocation internal
// fragmentation. handles are stored in `slotToNode` so callers keep
// using the slot index as the alloc identity (no API ripple).

export type StreamSpec = {
    schema: d.Any;
    perSlot: number;
};

const DEFAULT_MAX_ALLOCS = 16_384;

export type SegmentArena<S extends Record<string, StreamSpec>> = {
    slotCount: number;
    streams: S;
    buffers: { [K in keyof S]: GpuBuffer };
    allocator: OffsetAllocator;
    /** slot offset → OffsetAllocator node index, so arenaFree(start) can
     *  rebuild the handle without callers tracking it. */
    slotToNode: Map<number, number>;
};

export function createSegmentArena<S extends Record<string, StreamSpec>>(opts: {
    slotCount: number;
    streams: S;
    maxAllocs?: number;
}): SegmentArena<S> {
    const { slotCount, streams } = opts;
    const buffers = {} as { [K in keyof S]: GpuBuffer };
    for (const key in streams) {
        const spec = streams[key]!;
        // gpucat's `count:` path picks Float32Array for `d.array(d.u32)`,
        // which silently rounds u32 writes to f32. provide an explicit
        // Uint32Array via `data:` so .set(Uint32...) is a bit-exact copy.
        const elementCount = slotCount * spec.perSlot;
        buffers[key] = new GpuBuffer(d.array(spec.schema), {
            data: new Uint32Array(elementCount) as d.TypedArrayFor<d.Any>,
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        });
    }

    return {
        slotCount,
        streams,
        buffers,
        allocator: createOffsetAllocator(slotCount, opts.maxAllocs ?? DEFAULT_MAX_ALLOCS),
        slotToNode: new Map(),
    };
}

export function arenaAlloc<S extends Record<string, StreamSpec>>(a: SegmentArena<S>, slots: number): number {
    if (slots <= 0) throw new Error('SegmentArena.alloc: slots must be > 0');
    const h = oaAllocate(a.allocator, slots);
    if (!h) {
        const r = oaStorageReport(a.allocator);
        throw new Error(
            `SegmentArena OOM: need ${slots}, totalFree ${r.totalFree}, largestFree ${r.largestFree} (/${a.slotCount})`,
        );
    }
    const prev = a.slotToNode.get(h.offset);
    if (prev !== undefined) {
        // OA handed back an offset whose slotToNode entry was never cleared
        // by a matching arenaFree, bookkeeping drift. (See [voxel-drift].)
        throw new Error(
            `[voxel-drift][alloc-collision] arenaAlloc returned offset=${h.offset} but slotToNode still holds node=${prev}; new node=${h.node}, slots=${slots}`,
        );
    }
    a.slotToNode.set(h.offset, h.node);
    return h.offset;
}

export function arenaFree<S extends Record<string, StreamSpec>>(a: SegmentArena<S>, start: number): void {
    const node = a.slotToNode.get(start);
    if (node === undefined) {
        // forensic dump: nearest 5 live offsets on either side.
        const offsets = [...a.slotToNode.keys()].sort((x, y) => x - y);
        let pivot = 0;
        while (pivot < offsets.length && offsets[pivot]! < start) pivot++;
        const lo = Math.max(0, pivot - 5);
        const hi = Math.min(offsets.length, pivot + 5);
        const near = offsets
            .slice(lo, hi)
            .map((o) => `${o}=>node${a.slotToNode.get(o)}`)
            .join(',');
        throw new Error(
            `[voxel-drift][free-miss] SegmentArena.free: no live alloc at slot ${start} (nearbyLive=[${near}], totalLive=${offsets.length})`,
        );
    }
    a.slotToNode.delete(start);
    oaFree(a.allocator, { offset: start, node });
}

export type SegmentArenaReport = {
    slotCount: number;
    used: number;
    totalFree: number;
    largestFree: number;
    allocs: number;
};

export function arenaReport<S extends Record<string, StreamSpec>>(a: SegmentArena<S>): SegmentArenaReport {
    const r = oaStorageReport(a.allocator);
    return {
        slotCount: a.slotCount,
        used: a.slotCount - r.totalFree,
        totalFree: r.totalFree,
        largestFree: r.largestFree,
        allocs: a.slotToNode.size,
    };
}

export function arenaWrite<S extends Record<string, StreamSpec>, K extends keyof S>(
    a: SegmentArena<S>,
    stream: K,
    slotStart: number,
    slots: number,
    src: d.TypedArrayFor<d.Any>,
): void {
    const buf = a.buffers[stream];
    const perSlot = a.streams[stream]!.perSlot;
    const elementOffset = slotStart * perSlot;
    const elementCount = slots * perSlot;
    const dst = buf.array as d.TypedArrayFor<d.Any>;
    dst.set(src.subarray(0, elementCount), elementOffset);
    buf.addUpdateRange(elementOffset, elementCount);
}

export function arenaDispose<S extends Record<string, StreamSpec>>(a: SegmentArena<S>): void {
    for (const key in a.buffers) a.buffers[key].dispose();
}

// ── arena factories ─────────────────────────────────────────────────

export const QUAD_ORDER_U32S_PER_SLOT = 1;

const BYTES_PER_QUAD = QUAD_STRIDE_U32S * 4; // 56, interleaved header (40 B) + light (16 B)
const BYTES_PER_ORDER = QUAD_ORDER_U32S_PER_SLOT * 4; // 4

export type QuadArenaStreams = {
    quads: { schema: d.u32; perSlot: number };
};

export type QuadOrderArenaStreams = {
    quadOrder: { schema: d.u32; perSlot: number };
};

export type QuadArena = SegmentArena<QuadArenaStreams>;
export type QuadOrderArena = SegmentArena<QuadOrderArenaStreams>;

export function createQuadArena(byteBudget: number, maxAllocs?: number): QuadArena {
    const slots = Math.max(1024, Math.floor(byteBudget / BYTES_PER_QUAD));
    return createSegmentArena({
        slotCount: slots,
        maxAllocs,
        streams: {
            quads: { schema: d.u32, perSlot: QUAD_STRIDE_U32S },
        },
    });
}

export function createQuadOrderArena(byteBudget: number, maxAllocs?: number): QuadOrderArena {
    const slots = Math.max(1024, Math.floor(byteBudget / BYTES_PER_ORDER));
    return createSegmentArena({
        slotCount: slots,
        maxAllocs,
        streams: {
            quadOrder: { schema: d.u32, perSlot: QUAD_ORDER_U32S_PER_SLOT },
        },
    });
}

// ── SectionTable ────────────────────────────────────────────────────

// GPU-resident per-slot cull metadata, the device mirror of
// `cpuFaceOffsets` + `cpuFaceCounts`:
//   [faceOffsets[0..6], faceCounts[0..6], quadOrderStart].
// [0..13] read by the GPU cull/count/emit computes to size + back-face-cull
// each of the 7 facing slices; [14] is the section's base in the translucent
// quadOrderArena (0 for opaque/transparent), read by the whole-section
// translucent emit to resolve its per-quad draw order. Unused by the VS.
export const SECTION_META_U32S = 15;
/** meta index of the translucent section's quadOrderArena base. */
export const SECTION_META_QUAD_ORDER_START = 14;

export type SectionEntryFields = {
    originX: number;
    originY: number;
    originZ: number;
    dataStart: number;
    dataCount: number;
    quadOrderStart: number;
    faceOffsets: ArrayLike<number>;
    faceCounts: ArrayLike<number>;
    flags: number;
};

export type SectionTable = {
    readonly slotCount: number;
    readonly buffer: GpuBuffer;
    readonly entryU32s: number;
    /** CPU mirrors of the per-slot fields cullCPU needs to size + emit
     *  slices. AABB + iteration order live on the per-chunk `ChunkAlloc`
     *  (shared across passes), frustum cull runs once per chunk now. */
    readonly cpuDataCount: Uint32Array; // 1 per slot (translucent slice quadCount)
    readonly cpuFaceOffsets: Uint32Array; // 7 per slot (opaque/transparent localBase per facing)
    readonly cpuFaceCounts: Uint32Array; // 7 per slot
    /** GPU mirror of cpuFaceOffsets+cpuFaceCounts, SECTION_META_U32S per slot.
     *  Read by the GPU cull compute; never touched by the draw-time VS. */
    readonly metaBuffer: GpuBuffer;
    allocSlot(): number;
    freeSlot(slot: number): void;
    writeEntry(slot: number, entry: SectionEntryFields): void;
    dispose(): void;
    readonly used: () => number;
};

export function createSectionTable(opts: { name: string; slotCount: number }): SectionTable {
    const { slotCount } = opts;
    // GPU buffer holds tight ChunkInfo (16B/entry): origin + arenaBase.
    // everything else cull needs (faceOffsets, faceCounts, dataCount,
    // dataStart) lives in CPU mirrors below. AABB lives on ChunkAlloc.
    const buffer = new GpuBuffer(d.array(ChunkInfo), {
        count: slotCount,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const arrF32 = buffer.array as Float32Array;
    const dataU32 = new Uint32Array(arrF32.buffer, arrF32.byteOffset, arrF32.length);
    const entryU32s = arrF32.length / slotCount;

    // GPU mirror of the face offsets/counts (14 u32/slot) for the GPU cull
    // compute. Explicit `data:` (not `count:`) so the backing store is a
    // Uint32Array, keeping u32 writes bit-exact (the `count:` path would pick
    // Float32Array and round them).
    const metaBuffer = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(slotCount * SECTION_META_U32S),
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const metaU32 = metaBuffer.array as Uint32Array;

    const freeStack: number[] = new Array(slotCount);
    for (let i = 0; i < slotCount; i++) freeStack[i] = slotCount - 1 - i;
    const cpuDataCount = new Uint32Array(slotCount);
    const cpuFaceOffsets = new Uint32Array(slotCount * 7);
    const cpuFaceCounts = new Uint32Array(slotCount * 7);
    let used = 0;

    function allocSlot(): number {
        const slot = freeStack.pop();
        if (slot === undefined) throw new Error(`SectionTable OOM at ${slotCount}`);
        used++;
        return slot;
    }

    function freeSlot(slot: number): void {
        const base = slot * entryU32s;
        for (let i = 0; i < entryU32s; i++) dataU32[base + i] = 0;
        buffer.addUpdateRange(base, entryU32s);

        // zero CPU mirrors so a stale read can't sneak through.
        cpuDataCount[slot] = 0;
        const facingBase = slot * 7;
        for (let i = 0; i < 7; i++) {
            cpuFaceOffsets[facingBase + i] = 0;
            cpuFaceCounts[facingBase + i] = 0;
        }

        // zero the GPU cull mirror too (a freed slot must contribute nothing).
        const metaBase = slot * SECTION_META_U32S;
        for (let i = 0; i < SECTION_META_U32S; i++) metaU32[metaBase + i] = 0;
        metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);

        freeStack.push(slot);
        used--;
    }

    function writeEntry(slot: number, entry: SectionEntryFields): void {
        const base = slot * entryU32s;
        // GPU side-table only carries origin + arenaBase. cull mirrors
        // below hold faceOffsets / faceCounts / dataCount /
        // quadOrderStart, none of which the VS needs at draw time.
        packTo(ChunkInfo, dataU32, base * 4, {
            origin: [entry.originX, entry.originY, entry.originZ],
            arenaBase: entry.dataStart,
        });
        buffer.addUpdateRange(base, entryU32s);

        cpuDataCount[slot] = entry.dataCount;
        const facingBase = slot * 7;
        const metaBase = slot * SECTION_META_U32S;
        for (let i = 0; i < 7; i++) {
            const off = entry.faceOffsets[i]!;
            const cnt = entry.faceCounts[i]!;
            cpuFaceOffsets[facingBase + i] = off;
            cpuFaceCounts[facingBase + i] = cnt;
            // GPU mirror layout: [faceOffsets[0..6], faceCounts[0..6], quadOrderStart].
            metaU32[metaBase + i] = off;
            metaU32[metaBase + 7 + i] = cnt;
        }
        metaU32[metaBase + SECTION_META_QUAD_ORDER_START] = entry.quadOrderStart;
        metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);
    }

    function dispose(): void {
        buffer.dispose();
        metaBuffer.dispose();
    }

    return {
        slotCount,
        buffer,
        entryU32s,
        cpuDataCount,
        cpuFaceOffsets,
        cpuFaceCounts,
        metaBuffer,
        allocSlot,
        freeSlot,
        writeEntry,
        dispose,
        used: () => used,
    };
}

// ── ArenaPacker ─────────────────────────────────────────────────────

export type PassAlloc = {
    sectionSlot: number;
    dataStart: number;
    dataCount: number;
    quadOrderStart: number;
    quadOrderCount: number;
    /** translucent quad-sort class (`TRANSLUCENT_SORT_*`); NONE(0) for
     *  opaque/transparent and for translucent sections that need no reordering. */
    sortType: number;
    /** camera position when this section's quads were last GPU-sorted — the
     *  baseline the per-frame distance/angle triggers compare against. */
    sortCamX: number;
    sortCamY: number;
    sortCamZ: number;
    /** false until the first sort (or after a re-mesh rewrites identity order),
     *  forcing an initial sort the next time the section is in range. */
    sortValid: boolean;
};

export type ChunkAlloc = {
    opaque: PassAlloc | null;
    transparent: PassAlloc | null;
    translucent: PassAlloc | null;
    /** chunk-level AABB, shared across all 3 passes. */
    aabb: Box3;
    /** section world min-corner (chunk coord × CHUNK_SIZE); quad-local corner
     *  bytes are relative to this. Used by the translucent sort trigger to build
     *  the camera-relative `relOrigin` without a chunkKey → origins lookup. */
    originX: number;
    originY: number;
    originZ: number;
    /** this alloc's index in `packer.chunks` (== its cull-record index).
     *  Maintained across push/swap-pop so record updates + eviction are O(1).
     *  -1 until first push. */
    chunkIndex: number;
};

export type ArenaPacker = {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
    allocs: Map<string, ChunkAlloc>;
    /** dense list of currently-held ChunkAllocs, in insertion order.
     *  cullCPU iterates this for the frustum + back-face pass.
     *  swap-pop on evict, push on first upsert. */
    chunks: ChunkAlloc[];
    /** per-chunk origin (worldspace min corner). populated on upsertChunk;
     *  consumed by OOM eviction policy (farthest-from-camera). */
    origins: Map<string, [number, number, number]>;
    orderScratch: Uint32Array;
    cameraPos: Vec3 | null;
    /** GPU cull input, one `ChunkCullRecord` per resident chunk, kept in
     *  lockstep with `chunks` by array index (push/swap-pop mirror below).
     *  Dispatched over `chunks.length` by the cull compute. */
    cullRecordsBuffer: GpuBuffer;
    /** u32 view over `cullRecordsBuffer.array` for bit-exact int writes. */
    cullRecordsU32: Uint32Array;
};

export function createArenaPacker(opts: {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
}): ArenaPacker {
    // A chunk occupies ≥1 section slot across the 3 tables, so the live chunk
    // count is bounded by the sum of table capacities.
    const maxChunks = opts.tables.opaque.slotCount + opts.tables.transparent.slotCount + opts.tables.translucent.slotCount;
    const cullRecordsBuffer = new GpuBuffer(d.array(ChunkCullRecord), {
        count: maxChunks,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const recF32 = cullRecordsBuffer.array as Float32Array;
    const cullRecordsU32 = new Uint32Array(recF32.buffer, recF32.byteOffset, recF32.length);
    return {
        quadArena: opts.quadArena,
        quadOrderArena: opts.quadOrderArena,
        tables: opts.tables,
        allocs: new Map(),
        chunks: [],
        origins: new Map(),
        orderScratch: new Uint32Array(4096),
        cameraPos: null,
        cullRecordsBuffer,
        cullRecordsU32,
    };
}

/** Write the cull record for the chunk currently at `index` in `packer.chunks`
 *  (records mirror that array 1:1). `origin` is the chunk's world min-corner;
 *  chunk coords are `origin / CHUNK_SIZE`. Signed slots (-1 = pass absent) round-
 *  trip through the u32 view bit-exactly. */
function writeChunkCullRecord(packer: ArenaPacker, index: number, origin: [number, number, number], alloc: ChunkAlloc): void {
    const base = index * CHUNK_CULL_RECORD_U32S;
    const u = packer.cullRecordsU32;
    u[base + 0] = origin[0] / CHUNK_SIZE;
    u[base + 1] = origin[1] / CHUNK_SIZE;
    u[base + 2] = origin[2] / CHUNK_SIZE;
    u[base + 3] = alloc.opaque ? alloc.opaque.sectionSlot : -1;
    u[base + 4] = alloc.transparent ? alloc.transparent.sectionSlot : -1;
    u[base + 5] = alloc.translucent ? alloc.translucent.sectionSlot : -1;
    packer.cullRecordsBuffer.addUpdateRange(base, CHUNK_CULL_RECORD_U32S);
}

/** Copy the cull record at `from` to `to` (mirrors a swap-pop in `chunks`). */
function moveChunkCullRecord(packer: ArenaPacker, from: number, to: number): void {
    const u = packer.cullRecordsU32;
    const fromBase = from * CHUNK_CULL_RECORD_U32S;
    const toBase = to * CHUNK_CULL_RECORD_U32S;
    for (let i = 0; i < CHUNK_CULL_RECORD_U32S; i++) u[toBase + i] = u[fromBase + i];
    packer.cullRecordsBuffer.addUpdateRange(toBase, CHUNK_CULL_RECORD_U32S);
}

function packerFreePass(packer: ArenaPacker, pass: VoxelPass, a: PassAlloc): void {
    arenaFree(packer.quadArena, a.dataStart);
    if (pass === 'translucent' && a.quadOrderCount > 0) {
        arenaFree(packer.quadOrderArena, a.quadOrderStart);
    }
    packer.tables[pass].freeSlot(a.sectionSlot);
}

export function packerUpsertChunk(
    packer: ArenaPacker,
    chunkKey: string,
    origin: [number, number, number],
    mesh: ChunkMeshResult,
): void {
    const prev = packer.allocs.get(chunkKey);
    // reuse the prev alloc object (and its slot in packer.chunks) on
    // re-upsert; aabb is overwritten below from mesh.aabb.
    const next: ChunkAlloc = prev ?? {
        opaque: null,
        transparent: null,
        translucent: null,
        aabb: [0, 0, 0, 0, 0, 0],
        originX: 0,
        originY: 0,
        originZ: 0,
        chunkIndex: -1,
    };
    next.originX = origin[0];
    next.originY = origin[1];
    next.originZ = origin[2];
    const meshAabb = mesh.aabb;
    if (meshAabb) {
        next.aabb[0] = meshAabb.min[0];
        next.aabb[1] = meshAabb.min[1];
        next.aabb[2] = meshAabb.min[2];
        next.aabb[3] = meshAabb.max[0];
        next.aabb[4] = meshAabb.max[1];
        next.aabb[5] = meshAabb.max[2];
    } else {
        next.aabb[0] = 0;
        next.aabb[1] = 0;
        next.aabb[2] = 0;
        next.aabb[3] = 0;
        next.aabb[4] = 0;
        next.aabb[5] = 0;
    }

    for (const pass of PASSES) {
        const passMesh: PassMesh | null = mesh[pass];
        const cur = next[pass];

        if (!passMesh || passMesh.quadCount === 0) {
            if (cur) {
                packerFreePass(packer, pass, cur);
                next[pass] = null;
            }
            continue;
        }

        const needQuads = passMesh.quadCount;

        if (cur) {
            arenaFree(packer.quadArena, cur.dataStart);
            if (pass === 'translucent' && cur.quadOrderCount > 0) {
                arenaFree(packer.quadOrderArena, cur.quadOrderStart);
            }
        }
        const dataStart = packerAllocWithEviction(packer, chunkKey, needQuads);
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        let quadOrderStart = 0;
        let quadOrderCount = 0;
        if (pass === 'translucent') {
            quadOrderCount = needQuads;
            quadOrderStart = packerAllocOrderWithEviction(packer, chunkKey, needQuads);
            if (packer.orderScratch.length < needQuads) {
                packer.orderScratch = new Uint32Array(Math.max(needQuads, packer.orderScratch.length * 2));
            }
            // identity permutation, section-LOCAL (0..needQuads): the whole-section
            // translucent emit writes VisibleQuad.localIdx = quadOrder[start+i], and
            // the VS resolves realQuadId = arenaBase + localIdx. The gated GPU sort
            // (Level B) overwrites this with a distance-ordered permutation.
            for (let i = 0; i < needQuads; i++) packer.orderScratch[i] = i;
            arenaWrite(packer.quadOrderArena, 'quadOrder', quadOrderStart, needQuads, packer.orderScratch);
        }

        const table = packer.tables[pass];
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, chunkKey, pass);

        table.writeEntry(sectionSlot, {
            originX: origin[0],
            originY: origin[1],
            originZ: origin[2],
            dataStart,
            dataCount: needQuads,
            quadOrderStart,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });

        // a fresh mesh rewrites identity quadOrder, so any prior sort is stale →
        // sortValid=false forces a re-sort. sortType drives whether it's DYNAMIC.
        next[pass] = {
            sectionSlot,
            dataStart,
            dataCount: needQuads,
            quadOrderStart,
            quadOrderCount,
            sortType: passMesh.sortType,
            sortCamX: 0,
            sortCamY: 0,
            sortCamZ: 0,
            sortValid: false,
        };
    }

    const empty = !next.opaque && !next.transparent && !next.translucent;
    if (empty) {
        if (prev) removeChunkAt(packer, prev.chunkIndex);
        packer.allocs.delete(chunkKey);
        packer.origins.delete(chunkKey);
    } else {
        if (!prev) {
            next.chunkIndex = packer.chunks.length;
            packer.chunks.push(next);
        }
        // (re)write the record: a re-upsert may have moved section slots.
        writeChunkCullRecord(packer, next.chunkIndex, origin, next);
        packer.allocs.set(chunkKey, next);
        packer.origins.set(chunkKey, origin);
    }
}

/** Swap-pop the chunk at `idx` out of `packer.chunks` and mirror the move in
 *  the cull-record buffer. The last chunk backfills the hole (its `chunkIndex`
 *  and record follow). O(1). */
function removeChunkAt(packer: ArenaPacker, idx: number): void {
    if (idx < 0) return;
    const last = packer.chunks.pop()!;
    const lastIdx = packer.chunks.length; // index `last` occupied before pop
    if (idx < lastIdx) {
        packer.chunks[idx] = last;
        last.chunkIndex = idx;
        moveChunkCullRecord(packer, lastIdx, idx);
    }
}

/** drop every chunk from the packer. frees per-pass arena ranges + section
 *  slots, then empties the bookkeeping maps. used on room activation to
 *  hand the engine-global arena over to the new active room without
 *  reallocating any GpuBuffers. */
export function packerClearAll(packer: ArenaPacker): void {
    for (const alloc of packer.allocs.values()) {
        for (const pass of PASSES) {
            const a = alloc[pass];
            if (a) packerFreePass(packer, pass, a);
        }
    }
    packer.allocs.clear();
    packer.origins.clear();
    packer.chunks.length = 0;
}

export function packerEvictChunk(packer: ArenaPacker, chunkKey: string): void {
    const cur = packer.allocs.get(chunkKey);
    if (!cur) return;
    for (const pass of PASSES) {
        const a = cur[pass];
        if (a) packerFreePass(packer, pass, a);
    }
    removeChunkAt(packer, cur.chunkIndex);
    packer.allocs.delete(chunkKey);
    packer.origins.delete(chunkKey);
}

export function packerHas(packer: ArenaPacker, chunkKey: string): boolean {
    return packer.allocs.has(chunkKey);
}

export function packerKeys(packer: ArenaPacker): IterableIterator<string> {
    return packer.allocs.keys();
}

export function packerSetCameraPos(packer: ArenaPacker, pos: Vec3 | null): void {
    packer.cameraPos = pos;
}

// ── OOM eviction ────────────────────────────────────────────────────
//
// when one of the underlying arenas / section tables runs out of room,
// evict the chunk farthest from the current camera (excluding the one
// being upserted) and retry. without a camera reference, evict an
// arbitrary chunk (offline path, should never OOM in practice).

function farthestChunkKey(packer: ArenaPacker, excludeKey: string): string | null {
    let bestKey: string | null = null;
    const cam = packer.cameraPos;
    if (!cam) {
        for (const key of packer.allocs.keys()) {
            if (key !== excludeKey) return key;
        }
        return null;
    }
    let bestDistSq = -1;
    for (const [key, origin] of packer.origins) {
        if (key === excludeKey) continue;
        const dx = origin[0] + CHUNK_SIZE * 0.5 - cam[0];
        const dy = origin[1] + CHUNK_SIZE * 0.5 - cam[1];
        const dz = origin[2] + CHUNK_SIZE * 0.5 - cam[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey;
}

function packerAllocWithEviction(packer: ArenaPacker, upsertKey: string, slots: number): number {
    for (;;) {
        try {
            return arenaAlloc(packer.quadArena, slots);
        } catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocOrderWithEviction(packer: ArenaPacker, upsertKey: string, slots: number): number {
    for (;;) {
        try {
            return arenaAlloc(packer.quadOrderArena, slots);
        } catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocSlotWithEviction(packer: ArenaPacker, upsertKey: string, pass: VoxelPass): number {
    for (;;) {
        try {
            return packer.tables[pass].allocSlot();
        } catch (e) {
            const victim = farthestChunkKey(packer, upsertKey);
            if (!victim) throw e;
            packerEvictChunk(packer, victim);
        }
    }
}

// ── arena tier sizing ───────────────────────────────────────────────

export type VoxelArenaBudget = {
    /** bytes for the shared quadArena (sum of both streams). */
    quadArenaBytes: number;
    /** bytes for the translucent-only quadOrderArena. */
    quadOrderBytes: number;
    /** max chunk×pass slots per SectionTable (one table per pass). */
    maxSections: number;
    /** OffsetAllocator node-pool size for both quad arenas. */
    maxAllocs: number;
};

export function voxelArenaBudgetForTier(profile: Performance.Profile): VoxelArenaBudget {
    const s = Performance.settingsForTier(profile);
    const cap = Math.floor(profile.limits.maxArenaBytes * 0.25);
    const desired = s.voxelArenaDesiredMB * 1024 * 1024;
    const total = Math.min(desired, cap);
    return {
        quadArenaBytes: Math.floor(total * 0.95),
        quadOrderBytes: Math.floor(total * 0.05),
        maxSections: s.voxelMaxSections,
        maxAllocs: s.voxelArenaMaxAllocs,
    };
}

// ── VoxelArenaResources ─────────────────────────────────────────────

export type VoxelArenaResources = {
    quadArena: QuadArena;
    quadOrderArena: QuadOrderArena;
    tables: Record<VoxelPass, SectionTable>;
    packer: ArenaPacker;
};

export function createVoxelArenaResources(budget: VoxelArenaBudget): VoxelArenaResources {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    const quadOrderArena = createQuadOrderArena(budget.quadOrderBytes, budget.maxAllocs);
    const tables: Record<VoxelPass, SectionTable> = {
        opaque: createSectionTable({ name: 'sectionTable-opaque', slotCount: budget.maxSections }),
        transparent: createSectionTable({ name: 'sectionTable-transparent', slotCount: budget.maxSections }),
        translucent: createSectionTable({ name: 'sectionTable-translucent', slotCount: budget.maxSections }),
    };
    const packer = createArenaPacker({ quadArena, quadOrderArena, tables });
    return { quadArena, quadOrderArena, tables, packer };
}

function createPassRender(arenas: VoxelArenaResources): Record<VoxelPass, PassRender> {
    // worst-case per-pass visible-quad cap. each quad in the arena belongs to
    // exactly one (chunk, pass), so per-pass total visible ≤ arena.slotCount.
    const visibleQuadCap = arenas.quadArena.slotCount;

    const out = {} as Record<VoxelPass, PassRender>;
    for (const pass of PASSES) {
        // compute-written, never CPU-touched: skip MANUAL lifecycle so
        // gpucat auto-allocates on first use.
        const visibleQuadsBuffer = new GpuBuffer(d.array(VisibleQuad), {
            data: new Uint32Array(visibleQuadCap * (VISIBLE_QUAD_STRIDE / 4)),
            usage: 'storage',
        });

        const indirectData = new Uint32Array(DRAW_INDIRECT_STRIDE / 4);
        // pre-seed vertexCount=6 (6 verts per instance, 1 quad each).
        indirectData[0] = 6;
        const indirectBuffer = createIndirectBuffer(d.array(DrawIndirect), indirectData);

        out[pass] = { visibleQuadsBuffer, indirectBuffer, indirectData };
    }
    return out;
}

function createGeometries(
    arenas: VoxelArenaResources,
    passRender: Record<VoxelPass, PassRender>,
    env: EnvironmentResources,
): Record<VoxelPass, Geometry> {
    const out = {} as Record<VoxelPass, Geometry>;
    for (const pass of PASSES) {
        const g = new Geometry();
        // shared quadArena bound by name, same buffers across all 3 passes.
        g.setBuffer('quads', arenas.quadArena.buffers.quads);
        // engine-global GPU-built visible-quad table; VS reads
        // visibleQuads[instanceIndex] → (slot, localIdx).
        g.setBuffer('visibleQuads', passRender[pass].visibleQuadsBuffer);
        // ChunkInfo: per-slot {origin, arenaBase}. VS uses chunkInfo[slot]
        // to resolve worldspace origin and the arena base for realQuadId.
        g.setBuffer('chunkInfo', arenas.tables[pass].buffer);
        // env (envConfig) bound by name so the engine-global material
        // resolves the engine-global env config (the active room's
        // shadow is flushed into this buffer by Environment.tick).
        g.setBuffer('env', env.envConfigBuffer);
        g.indirect = passRender[pass].indirectBuffer;
        out[pass] = g;
    }
    return out;
}

// ── VoxelResources ──────────────────────────────────────────────────

export type VoxelResources = {
    /** gpucat array texture atlas */
    atlas: ArrayTexture;
    /** per-layer animation metadata storage buffer */
    texAnimBuffer: GpuBuffer;
    /** unified chunk-renderer quad materials (quad-pull VS), one per pass.
     *  bound on per-room `Mesh` along with the engine-shared `geometries`. */
    quadMaterials: Record<VoxelPass, Material>;
    /** engine-global GPU cull compute. one node dispatched once per frame over
     *  `packer.cullRecordsBuffer`; compacts visible chunks into `visibleChunks`
     *  and produces the per-facing emit dispatch args. */
    cull: ComputeNode;
    /** engine-global GPU emit compute. dispatched once per pass (indirect,
     *  [visibleChunkCount, 7, 1]) with per-pass meta/quads/drawIndirect/config
     *  bound by name; back-face-culls facings and writes visibleQuads. */
    emit: ComputeNode;
    /** whole-section translucent emit. dispatched on the same emitArgs shape as
     *  `emit` but only workgroupId.y==0 works; emits a section's quads in
     *  `quadOrder` order for correct back-to-front blending. */
    translucentEmit: ComputeNode;
    /** Level-A count compute (per pass): tallies per-bucket quad counts. */
    count: ComputeNode;
    /** Level-A finalize compute: prefix-sums buckets → base + draw counts. */
    finalize: ComputeNode;
    /** Level-B translucent quad sort: one workgroup per triggered DYNAMIC
     *  section, bitonic-orders its quads far→near into `quadOrder`. */
    translucentSort: ComputeNode;
    /** per-triggered-section sort input (`TranslucentSortEntry[]`), CPU-built
     *  each frame; dispatched `[translucentSortCount, 1, 1]`. */
    translucentSortEntries: GpuBuffer;
    /** u32 view over `translucentSortEntries.array` for CPU packing. */
    translucentSortEntriesData: Uint32Array;
    /** number of DYNAMIC sections triggered this frame (sort dispatch bound). */
    translucentSortCount: number;
    /** per-bucket quad tallies `[pass*BUCKET_COUNT + b]` (atomic); CPU-zeroed
     *  each frame, written by `count`, read by `finalize`. */
    bucketQuads: GpuBuffer;
    bucketQuadsData: Uint32Array;
    /** exclusive prefix (instance base) per bucket; written by `finalize`. */
    bucketBase: GpuBuffer;
    /** running within-bucket offset (atomic); reset by `finalize`, bumped by emit. */
    bucketCursor: GpuBuffer;
    /** per-frame camera view for the cull compute (5 pre-shifted planes +
     *  camera chunk/frac). CPU-written each frame from the active camera. */
    cullView: GpuBuffer;
    cullViewData: Float32Array;
    /** cull output: compacted visible chunks (GPU-written, emit-read). */
    visibleChunks: GpuBuffer;
    /** emit dispatch args `[visibleChunkCount, 7, 1]` (indirect). The cull's
     *  atomic append counter lives in element 0; CPU resets it to 0 each frame. */
    emitArgs: GpuBuffer;
    emitArgsData: Uint32Array;
    /** per-pass static emit config `[passIndex, backFaceCull]`. */
    emitConfig: Record<VoxelPass, GpuBuffer>;
    /** engine-global arenas (quadArena + quadOrderArena + per-pass
     *  section tables + packer). active room owns the contents at any
     *  given time; `packerClearAll` resets on activation. */
    arenas: VoxelArenaResources;
    /** engine-global per-frame cull/expand scratch + indirect buffers.
     *  populated by the active room's `cullCPU`. */
    passRender: Record<VoxelPass, PassRender>;
    /** engine-global per-pass Geometry. all bindings are engine-global
     *  buffers, bound once at construction, never rebound on room swap. */
    geometries: Record<VoxelPass, Geometry>;
    /** resolves when the texture atlas has been fully loaded into the array texture */
    atlasReady: Promise<void>;
    /** @internal, settled by VoxelResources.load() once atlas pixels finish uploading. */
    _resolveAtlasReady: () => void;
    /** atlas manifest hash this struct was built against (null if the
     *  manifest fetch failed). */
    atlasHash: string | null;
    /** registry.texAnimData this struct was built against. */
    texAnimData: Float32Array;
    /** off-thread mesh worker pool. null on asset-pipeline paths where
     *  the synchronous remesh loop is preferred (callers pass workerCount=0). */
    meshDispatcher: MeshDispatcher | null;
    /** queue of completed worker jobs, drained at the top of
     *  `voxel-visuals.update()`. Populated by `meshDispatcher`'s onResult. */
    pendingMeshResults: MeshDispatcherResult[];
    /** chunk keys whose in-flight worker jobs were lost to a worker
     *  crash. Drained at the top of `voxel-visuals.update()`, each is
     *  put back on `voxels.dirty.blocks` so the chunk gets re-dispatched
     *  next frame. */
    pendingLostChunkKeys: string[];
    /** scratch `MeshOutput` shared by every main-thread sync remesh. One
     *  instance is enough because each `meshChunk` call is consumed
     *  (copied into the arena) before the next call begins. */
    meshOutput: MeshOutput;
};

export function init(registry: BlockRegistry, env: EnvironmentResources, budget: VoxelArenaBudget): VoxelResources {
    console.log(`[voxel-resources] init, ${registry.textures.length} textures, ${registry.totalStates} states`);

    const atlas = createVoxelTextureArray(registry.textures.length);

    const texAnimBuffer = createStorageBuffer(d.array(d.vec4f), registry.texAnimData);

    const { promise: atlasReady, resolve: _resolveAtlasReady } = Promise.withResolvers<void>();

    const quadMaterials: Record<VoxelPass, Material> = {
        opaque: createQuadMaterial({ atlas, texAnimBuffer, pass: 'opaque' }),
        transparent: createQuadMaterial({ atlas, texAnimBuffer, pass: 'transparent' }),
        translucent: createQuadMaterial({ atlas, texAnimBuffer, pass: 'translucent' }),
    };

    const cull = createCullCompute();
    const emit = createEmitCompute();
    const translucentEmit = createTranslucentEmitCompute();
    const count = createCountCompute();
    const finalize = createFinalizeCompute();
    const translucentSort = createTranslucentSortCompute();

    const arenas = createVoxelArenaResources(budget);
    const passRender = createPassRender(arenas);
    const geometries = createGeometries(arenas, passRender, env);

    // GPU-cull scratch. `visibleChunks` is bounded by the resident chunk count,
    // itself bounded by the sum of the 3 section tables' capacities.
    const maxChunks = budget.maxSections * 3;
    const cullViewData = new Float32Array(CULL_VIEW_STRIDE / 4);
    const cullView = new GpuBuffer(d.array(CullView), {
        data: cullViewData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const visibleChunks = new GpuBuffer(d.array(VisibleChunk), { count: maxChunks, usage: 'storage' });
    // indirect emit dispatch args; element 0 is the cull's atomic append counter,
    // reset to 0 each frame. [_, 7, 1] = the 7 facings.
    const emitArgsData = new Uint32Array([0, 7, 1]);
    const emitArgs = new GpuBuffer(d.array(d.u32), {
        data: emitArgsData,
        usage: 'indirect',
        lifecycle: BufferLifecycle.MANUAL,
    });
    // static per-pass config: [passIndex, backFaceCull]. translucent emits every facing.
    const emitConfig: Record<VoxelPass, GpuBuffer> = {
        opaque: new GpuBuffer(d.array(d.u32), { data: new Uint32Array([0, 1]), usage: 'storage', lifecycle: BufferLifecycle.MANUAL }),
        transparent: new GpuBuffer(d.array(d.u32), { data: new Uint32Array([1, 1]), usage: 'storage', lifecycle: BufferLifecycle.MANUAL }),
        translucent: new GpuBuffer(d.array(d.u32), { data: new Uint32Array([2, 0]), usage: 'storage', lifecycle: BufferLifecycle.MANUAL }),
    };

    // Level-A bucket scratch: 3 passes × BUCKET_COUNT. `bucketQuads` is CPU-
    // zeroed each frame; base/cursor are GPU-managed by finalize.
    const bucketCount3 = 3 * BUCKET_COUNT;
    const bucketQuadsData = new Uint32Array(bucketCount3);
    const bucketQuads = new GpuBuffer(d.array(d.atomic(d.u32)), {
        data: bucketQuadsData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const bucketBase = new GpuBuffer(d.array(d.u32), { data: new Uint32Array(bucketCount3), usage: 'storage' });
    const bucketCursor = new GpuBuffer(d.array(d.atomic(d.u32)), { data: new Uint32Array(bucketCount3), usage: 'storage' });

    // Level-B translucent quad-sort input: one entry per triggered DYNAMIC
    // section (CPU-built each frame). Bounded by the translucent table capacity.
    const translucentSortCapacity = arenas.tables.translucent.slotCount;
    const translucentSortEntries = new GpuBuffer(d.array(TranslucentSortEntry), {
        count: translucentSortCapacity,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    // u32 view over the same backing for CPU packing (relOrigin f32 + u32 fields
    // are written bit-exactly via packTo's DataView, same as `cullRecordsBuffer`).
    const tseF32 = translucentSortEntries.array as Float32Array;
    const translucentSortEntriesData = new Uint32Array(tseF32.buffer, tseF32.byteOffset, tseF32.length);

    return {
        atlas,
        texAnimBuffer,
        quadMaterials,
        cull,
        emit,
        translucentEmit,
        count,
        finalize,
        translucentSort,
        translucentSortEntries,
        translucentSortEntriesData,
        translucentSortCount: 0,
        bucketQuads,
        bucketQuadsData,
        bucketBase,
        bucketCursor,
        cullView,
        cullViewData,
        visibleChunks,
        emitArgs,
        emitArgsData,
        emitConfig,
        arenas,
        passRender,
        geometries,
        atlasReady,
        _resolveAtlasReady,
        atlasHash: null,
        texAnimData: registry.texAnimData,
        meshDispatcher: null,
        pendingMeshResults: [],
        pendingLostChunkKeys: [],
        meshOutput: createMeshOutput(),
    };
}

/** Load the atlas manifest. Client fetches it (assetUrl); the asset pipeline
 *  reads it off disk via the injected loader. */
async function loadAtlasMeta(resources: Resources): Promise<BlockTextureAtlasMetadata | null> {
    if (resources.loader.decodeImage) {
        try {
            const bytes = await resources.loader.loadBytes('voxels-atlas.json');
            return JSON.parse(new TextDecoder().decode(bytes)) as BlockTextureAtlasMetadata;
        } catch (e) {
            console.warn('[voxel-resources] atlas manifest load failed:', e);
            return null;
        }
    }
    return fetchBlockTextureAtlasMetadata();
}

/** Decode + write the atlas pixels into the array texture. Client takes the
 *  browser fetch+canvas path verbatim; the asset pipeline reads disk bytes and
 *  decodes via its injected `decodeImage` (sharp) → RGBA. The pipeline's
 *  `decodeImage` returns pre-decoded bytes, so sharp never overlaps the Dawn
 *  compute compile kicked in `load`. */
async function writeAtlasPixels(
    res: VoxelResources,
    textureNames: string[],
    textureCutout: Uint8Array,
    meta: BlockTextureAtlasMetadata,
    resources: Resources,
): Promise<void> {
    const decodeImage = resources.loader.decodeImage;
    if (decodeImage) {
        const bytes = await resources.loader.loadBytes('voxels-atlas.png');
        const { rgba } = await decodeImage(bytes, 'image/png');
        writeBlockTextureAtlasIntoTextureArray(res.atlas, textureNames, meta, rgba, textureCutout);
        return;
    }
    return loadBlockTextureAtlasIntoTextureArray(res.atlas, textureNames, meta, textureCutout);
}

/** Async side of construction: pre-warms the expansion compute pipeline,
 *  fetches the atlas manifest, kicks off the atlas pixel upload (settles
 *  `res.atlasReady`), and spawns the mesh worker pool. `meta` may be passed
 *  in by `refresh` (which already fetched it to compare hashes); otherwise
 *  `load` fetches it itself. Mutates `res` in place. */
export async function load(
    res: VoxelResources,
    registry: BlockRegistry,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    renderer?: WebGPURenderer,
    meta?: BlockTextureAtlasMetadata | null,
): Promise<void> {
    // Compile the cull compute pipeline (awaited at the end so the first render
    // never binds a still-null cached pipeline). Timing relative to the atlas
    // load differs by environment:
    //  - client (no `decodeImage`): kick it up front and let the atlas
    //    fetch+canvas run fire-and-forget alongside it, non-blocking, unchanged.
    //  - asset pipeline (`decodeImage` present): the atlas decode is sharp
    //    (libvips) native work that segfaults if it overlaps a Dawn pipeline
    //    compile, so await the atlas FIRST, then compile. The pipeline isn't
    //    latency-sensitive, so serial is fine.
    // Either way consumers gate on `res.atlasReady`.
    const serializeAtlasBeforeCompute = resources.loader.decodeImage != null;

    let computeReady: Promise<void> = Promise.resolve();
    if (!serializeAtlasBeforeCompute && renderer) {
        computeReady = Promise.all([renderer.compileCompute(res.cull), renderer.compileCompute(res.count), renderer.compileCompute(res.finalize), renderer.compileCompute(res.emit), renderer.compileCompute(res.translucentEmit), renderer.compileCompute(res.translucentSort)]).then(() => {});
    }

    {
        const resolvedMeta = meta !== undefined ? meta : await loadAtlasMeta(resources);
        res.atlasHash = resolvedMeta?.hash ?? null;
        const atlasWrite = resolvedMeta
            ? writeAtlasPixels(res, registry.textures, registry.textureCutout, resolvedMeta, resources)
            : Promise.resolve();
        if (serializeAtlasBeforeCompute) {
            await atlasWrite.catch((e) => console.warn('[voxel-resources] atlas load failed:', e));
            res._resolveAtlasReady();
        } else {
            atlasWrite
                .then(() => {
                    console.log('[voxel-resources] atlas loaded');
                    res._resolveAtlasReady();
                })
                .catch((e) => {
                    console.warn('[voxel-resources] atlas load failed:', e);
                    res._resolveAtlasReady();
                });
        }
    }

    // pipeline: now safe to compile, the atlas sharp decode has finished.
    if (serializeAtlasBeforeCompute && renderer) {
        computeReady = Promise.all([renderer.compileCompute(res.cull), renderer.compileCompute(res.count), renderer.compileCompute(res.finalize), renderer.compileCompute(res.emit), renderer.compileCompute(res.translucentEmit), renderer.compileCompute(res.translucentSort)]).then(() => {});
    }

    if (workerCount > 0 && typeof Worker !== 'undefined') {
        // Dynamic import so environments that don't support workers
        // don't reach the `?worker&inline` query suffix that lives inside
        // mesh-worker-spawn.ts. Vite resolves it at bundle time.
        // The Worker guard lets node/happy-dom test harnesses run without
        // a worker shim, they fall through to inline meshing.
        const { spawnMeshWorker } = await import('./mesh-worker-spawn');
        const meshDispatcher = createMeshDispatcher({
            workerFactory: spawnMeshWorker,
            workerCount,
            queueDepth: workerQueueDepth,
            onResult: (r) => res.pendingMeshResults.push(r),
            onLost: (key) => res.pendingLostChunkKeys.push(key),
        });
        setMeshRegistry(meshDispatcher, registry);
        res.meshDispatcher = meshDispatcher;
    }

    await computeReady;
}

/** Build new resources, or reuse `prev` if the atlas + animation metadata
 *  are unchanged. */
export async function refresh(
    prev: VoxelResources | null,
    registry: BlockRegistry,
    env: EnvironmentResources,
    budget: VoxelArenaBudget,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    renderer?: WebGPURenderer,
): Promise<{ resources: VoxelResources; changed: boolean }> {
    const meta = await loadAtlasMeta(resources);
    if (
        prev &&
        meta !== null &&
        prev.atlasHash !== null &&
        meta.hash === prev.atlasHash &&
        f32Equal(prev.texAnimData, registry.texAnimData)
    ) {
        // atlas + texAnim unchanged → reuse. But the BlockRegistry itself
        // may have been rebuilt (block tables, shape ids, ...), so push
        // the new registry to the workers; existing in-flight jobs will
        // finish with the old registry and get gen-dropped by callers.
        if (prev.meshDispatcher) setMeshRegistry(prev.meshDispatcher, registry);
        return { resources: prev, changed: false };
    }
    if (prev) dispose(prev);
    const built = init(registry, env, budget);
    await load(built, registry, workerCount, workerQueueDepth, resources, renderer, meta);
    return { resources: built, changed: true };
}

function f32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function dispose(state: VoxelResources): void {
    state.atlas.dispose();
    state.texAnimBuffer.dispose();
    state.quadMaterials.opaque.dispose();
    state.quadMaterials.transparent.dispose();
    state.quadMaterials.translucent.dispose();
    for (const pass of PASSES) {
        state.geometries[pass].dispose();
        const r = state.passRender[pass];
        r.visibleQuadsBuffer.dispose();
        r.indirectBuffer.dispose();
    }
    arenaDispose(state.arenas.quadArena);
    arenaDispose(state.arenas.quadOrderArena);
    for (const pass of PASSES) state.arenas.tables[pass].dispose();
    state.arenas.packer.cullRecordsBuffer.dispose();
    state.cullView.dispose();
    state.visibleChunks.dispose();
    state.emitArgs.dispose();
    for (const pass of PASSES) state.emitConfig[pass].dispose();
    state.bucketQuads.dispose();
    state.bucketBase.dispose();
    state.bucketCursor.dispose();
    if (state.meshDispatcher) disposeMeshDispatcher(state.meshDispatcher);
    state.pendingMeshResults.length = 0;
    state.pendingLostChunkKeys.length = 0;
}
