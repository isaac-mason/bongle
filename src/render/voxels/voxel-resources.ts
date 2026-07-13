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

import type { ArrayTexture, Camera, ComputeDispatch, Material, WebGPURenderer } from 'gpucat';
import {
    abs,
    add,
    and,
    atomicAdd,
    atomicLoad,
    atomicStore,
    BufferLifecycle,
    clamp,
    createIndirectBuffer,
    createStorageBuffer,
    DrawIndirect,
    d,
    div,
    dot,
    Fn,
    f32,
    floor,
    frustum,
    Geometry,
    GpuBuffer,
    globalId,
    If,
    i32,
    index,
    Loop,
    layoutStrideOf,
    length,
    localId,
    max,
    min,
    or,
    packTo,
    Return,
    select,
    shiftLeft,
    storage,
    storageBarrier,
    struct,
    sub,
    u32,
    vec3f,
    vec4f,
    While,
    WorkgroupVar,
    workgroupBarrier,
    workgroupId,
} from 'gpucat';
import type { ComputeNode } from 'gpucat/dist/nodes/nodes';
import { type Box3, plane3, type Vec3 } from 'mathcat';
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
import { createQuadMaterial, decodeOct16, decodeQuadCentroid, type VoxelPass } from './voxel-material';
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

// ── translucent global stable radix sort ────────────────────────────
//
// The translucent pass draws back-to-front. A stable 4-pass (8 bits/pass) LSD
// radix sort turns every visible translucent quad's key into the `visibleQuads`
// draw permutation, gated to re-run only when the order can change (see
// `updateTranslucentSortGate`).
//
// key = [ cellL1:10 ][ intraDist:20 ][ facing:1 ]  (31 bits; ascending ⇒ far first)
//
//   cellL1    = 1023 − Manhattan distance of the quad's OWNER cell from the
//               camera's cell. Exact and load-bearing: a quad never leaves its
//               owner cube, and along any ray cell L1 strictly increases (per-
//               axis monotonicity), so a farther cell's quad can never be hit
//               before a nearer one's. This orders every cross-cell pair per-
//               pixel-correctly — including coincident interface faces, as
//               "nearer cell on top" — with no tiebreak convention and no
//               quantisation bands; the order only changes when the camera
//               crosses a cell boundary. Same-L1 cells can't occlude (same
//               proof) so need no refinement. 1023 ⇒ ≤21-chunk view ceiling.
//   intraDist = within-cell refinement (per-section-normalised nearest-point
//               distance, far first). Exact for a convex cell's own faces,
//               best-effort for multi-quad models. Cross-cell pairs never reach
//               it, so its quantisation can't reintroduce tie-band flicker.
//   facing    = camera-facing ⇒ drawn last; splits crossed same-cell model
//               quads (unorderable per-quad, but kept deterministic).
//
// Residual exact ties keep expand order (the sort is STABLE) = within-section
// arena order — fixed and view-independent, Sodium's `onPlaneQuads` semantics.
//
// Stable multi-pass (not single-pass counting sort): WebGPU has no forward-
// progress guarantee, so the scatter is stable via a deterministic per-block
// rank (zero rank atomics) built with reduce-then-scan — no decoupled-lookback
// spin, no subgroups.
//
// Chain (11 dispatches): expand → prep → count₀ → [scan → scatter]×4. Passes
// shuffle (key, index) A→B→A→B (8 B/item, not the payload); the last scatter
// gathers the payload into `visibleQuads`. Each non-last scatter fused-counts
// the next pass's digit in-register, so only pass 0 needs a standalone count.
// The two histograms ping-pong (counts for digit p in hist[p%2]); scan p reads
// hist[p%2] into bases AND zeroes hist[(p+1)%2] up to `zeroTo` = max(this,
// previous fire's block count) for the fused count. Rows use a FIXED maxBlocks
// stride so cross-fire staleness stays addressable.
const RADIX_WG = 256; // threads per radix workgroup
const RADIX_ITEMS = 4; // items per thread in count/scatter
const RADIX_BLOCK = RADIX_WG * RADIX_ITEMS; // 1024 items per workgroup-block
const RADIX_DIGITS = 256; // 8-bit digit ⇒ 4 LSD passes
const TSORT_EXPAND_WG = 256; // expand threads/section
const TSORT_CELL_LEVELS = 1024; // 10-bit owner-cell L1 (≈21-chunk view ceiling)
const TSORT_DIST_LEVELS = 1 << 20; // 20-bit within-cell distance refinement

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
        // fused count (opaque/transparent only): a surviving chunk's per-facing
        // quad counts go straight into `bucketQuads` here — no separate [1,1,1]
        // count pass. The translucent pass is ordered by the global counting sort
        // instead of Level-A buckets, so it isn't tallied here. Layout mirrors the
        // 2 SectionTable metaBuffers (indexed by pass) + the shared bucket tally.
        const metas = [storage('opaqueMeta', d.array(d.u32), 'read'), storage('transparentMeta', d.array(d.u32), 'read')];
        const bucketQuads = storage('bucketQuads', d.array(d.atomic(d.u32)), 'read_write');

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
                and(
                    and(
                        and(
                            and(i.toF32().lessThan(camMeta.w), dot(p0.xyz, rel).add(p0.w).greaterThanEqual(f32(0))),
                            dot(p1.xyz, rel).add(p1.w).greaterThanEqual(f32(0)),
                        ),
                        dot(p2.xyz, rel).add(p2.w).greaterThanEqual(f32(0)),
                    ),
                    dot(p3.xyz, rel).add(p3.w).greaterThanEqual(f32(0)),
                ),
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
            const bucket = min(add(dcx, add(dcy, dcz)), f32(BUCKET_COUNT - 1))
                .toU32()
                .toVar('bucket');
            const out = visible.element(add(wgBase, localSlot)).fields();
            out.opaqueSlot.assign(rec.field('opaqueSlot'));
            out.transparentSlot.assign(rec.field('transparentSlot'));
            out.translucentSlot.assign(rec.field('translucentSlot'));
            out.bucket.assign(bucket);
            out.relCenter.assign(vec4f(rel.x, rel.y, rel.z, f32(0)));

            // ── fused count (opaque/transparent) ─────────────────────────
            // Tally each visible facing's quads into its distance bucket, so
            // `finalize` can prefix-sum them into instance bases. Replaces the
            // separate [1,1,1] count pass. Back-face cone-cull matches the emit
            // (same `rel` = section center), so counts == emitted (gap-free).
            // +axis (even f) visible when rel.axis < +half; -axis when > -half.
            // The translucent pass is ordered by the global counting sort, not
            // Level-A buckets, so it is not tallied here.
            const cHalf = f32(CHUNK_SIZE * 0.5);
            const cNegHalf = f32(-CHUNK_SIZE * 0.5);
            const slotFields = ['opaqueSlot', 'transparentSlot'] as const;
            for (let p = 0; p < 2; p++) {
                const slotI = rec.field(slotFields[p]).toVar(`countSlot${p}`);
                If(slotI.greaterThanEqual(i32(0)), () => {
                    const metaBase = slotI.toU32().mul(u32(SECTION_META_U32S)).toVar(`countMetaBase${p}`);
                    const bqBase = add(u32(p * BUCKET_COUNT), bucket).toVar(`bqBase${p}`);
                    for (let f = 0; f < 7; f++) {
                        const fc = index(metas[p], add(metaBase, u32(7 + f))).toVar(`fc${p}_${f}`);
                        if (f < 6) {
                            const relAxis = f >> 1 === 0 ? rel.x : f >> 1 === 1 ? rel.y : rel.z;
                            const facingVisible = f % 2 === 0 ? relAxis.lessThan(cHalf) : relAxis.greaterThan(cNegHalf);
                            If(and(fc.greaterThan(u32(0)), facingVisible), () => {
                                atomicAdd(index(bucketQuads, bqBase), fc);
                            });
                        } else {
                            If(fc.greaterThan(u32(0)), () => {
                                atomicAdd(index(bucketQuads, bqBase), fc);
                            });
                        }
                    }
                });
            }
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

// ── translucent global stable-radix kernels ─────────────────────────

// expand: one workgroup per visible translucent section (dispatched on the
// shared [visibleChunkCount, 7, 1] emitArgs; only workgroupId.y == 0 works).
// Lane 0 reserves the section's flat range with one atomic; lanes stride-write
// each quad's key (see the key description above), payload, and identity index.
export function createTranslucentExpandCompute(): ComputeNode {
    const wgBase = WorkgroupVar('wgBase', d.u32);
    return Fn(() => {
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read');
        const meta = storage('sectionMeta', d.array(d.u32), 'read');
        const chunkInfo = storage('chunkInfo', d.array(ChunkInfo), 'read');
        const quads = storage('quads', d.array(d.u32), 'read');
        const sortKeys = storage('sortKeys', d.array(d.u32), 'read_write');
        const sortIdx = storage('sortIdx', d.array(d.u32), 'read_write');
        const sortPayload = storage('sortPayload', d.array(VisibleQuad), 'read_write');
        const sortCount = storage('sortCount', d.array(d.atomic(d.u32)), 'read_write');

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
        const arenaBase = chunkInfo.element(slotU).field('arenaBase').toVar('arenaBase');

        // section geometry, camera-relative (f32-exact at any world position).
        const half = f32(CHUNK_SIZE * 0.5);
        const cs = f32(CHUNK_SIZE);
        const rc = vc.field('relCenter');
        const relOrigin = vec3f(sub(rc.x, half), sub(rc.y, half), sub(rc.z, half)).toVar('relOrigin');
        // [near, far] AABB distance range, for normalising the within-cell term.
        const maxCorner = relOrigin.add(vec3f(cs, cs, cs)).toVar('maxCorner');
        const nearC = clamp(vec3f(f32(0), f32(0), f32(0)), relOrigin, maxCorner).toVar('nearC');
        const nearDist = length(nearC).toVar('nearDist');
        const farC = max(abs(relOrigin), abs(maxCorner)).toVar('farC');
        const farDist = length(farC).toVar('farDist');
        const distSpan = max(sub(farDist, nearDist), f32(1e-4)).toVar('distSpan');
        // camera's cell in section-local coords (camera sits at −relOrigin);
        // camera-relative integers ⇒ f32-exact at MC scale, consistent across
        // sections.
        const camCellX = floor(sub(f32(0), relOrigin.x)).toVar('camCellX');
        const camCellY = floor(sub(f32(0), relOrigin.y)).toVar('camCellY');
        const camCellZ = floor(sub(f32(0), relOrigin.z)).toVar('camCellZ');

        // reserve this section's flat key range with one atomic (lane 0).
        If(localId.x.equal(u32(0)), () => {
            wgBase.assign(atomicAdd(index(sortCount, u32(0)), dataCount).toU32());
        });
        workgroupBarrier();

        const qi = localId.x.toVar('qi');
        While(qi.lessThan(dataCount), () => {
            const realQuadId = add(arenaBase, qi).toVar('realQuadId');
            // word 3 packs both the oct16 normal (low 16) and the owner block's
            // chunk-local cell (bits 16..27) — one load feeds cellL1 and facing.
            const w3 = index(quads, add(realQuadId.mul(u32(QUAD_STRIDE_U32S)), u32(3))).toVar('w3');
            // cellL1 = |owner cell − camera cell|₁ (the exact cross-cell term).
            const ownDx = abs(w3.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().sub(camCellX)).toVar('ownDx');
            const ownDy = abs(w3.shiftRight(u32(20)).bitwiseAnd(u32(0xf)).toF32().sub(camCellY)).toVar('ownDy');
            const ownDz = abs(w3.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().sub(camCellZ)).toVar('ownDz');
            const cellL1 = min(add(ownDx, add(ownDy, ownDz)), f32(TSORT_CELL_LEVELS - 1))
                .toU32()
                .toVar('cellL1');
            const cellKey = sub(u32(TSORT_CELL_LEVELS - 1), cellL1).toVar('cellKey');
            // intraDist = normalised centroid distance (within-cell refinement).
            const centroidByte = decodeQuadCentroid(quads, realQuadId).toVar('cb');
            const camRel = relOrigin.add(centroidByte.mul(f32(CHUNK_SIZE / 255))).toVar('camRel');
            const dist = length(camRel).toVar('dist');
            const norm = clamp(div(sub(dist, nearDist), distSpan), f32(0), f32(1)).toVar('norm');
            const distLevel = min(floor(norm.mul(f32(TSORT_DIST_LEVELS))).toU32(), u32(TSORT_DIST_LEVELS - 1)).toVar('distLevel');
            const distKey = sub(u32(TSORT_DIST_LEVELS - 1), distLevel).toVar('distKey');
            // facing: camera-facing ⇒ drawn last (camRel is on the quad's plane
            // for axis-aligned faces, so the sign is exact).
            const normal = decodeOct16(w3.bitwiseAnd(u32(0xffff))).toVar('nrm');
            const facing = select(u32(1), u32(0), dot(normal, camRel).greaterThanEqual(f32(0))).toVar('facing');
            const key = shiftLeft(cellKey, u32(21))
                .bitwiseOr(shiftLeft(distKey, u32(1)))
                .bitwiseOr(facing)
                .toVar('key');

            const outPos = add(wgBase, qi).toVar('outPos');
            sortKeys.element(outPos).assign(key);
            sortIdx.element(outPos).assign(outPos); // identity: idx == expand position
            const pl = sortPayload.element(outPos).fields();
            pl.slot.assign(slotU);
            pl.localIdx.assign(qi);
            qi.addAssign(u32(TSORT_EXPAND_WG));
        });
    }).compute({ workgroupSize: [TSORT_EXPAND_WG, 1, 1], name: 'voxel-tsort-expand' });
}

// prep: single thread. Turns the expand's atomic count N into the radix
// count/scatter indirect dispatch args:
//   [0..2] = [numBlocks, 1, 1]     block-grid size, ceil(N/RADIX_BLOCK)
//   [3]    = N                     for per-item tail-masking
//   [4]    = numBlocks (persisted) the PREVIOUS fire's block count next time
//   [5]    = zeroTo = max(numBlocks, previous fire's numBlocks) — the exact
//            per-digit-row bound the scans must zero in the OTHER histogram so
//            fused counts land on clean cells (covers cross-fire staleness).
// The buffer is INDIRECT|STORAGE so the radix kernels also bind it as storage.
// Also writes the translucent draw's instanceCount and self-resets `sortCount`.
export function createTranslucentPrepCompute(): ComputeNode {
    return Fn(() => {
        // atomic storage buffers must be read_write in WGSL even for a load.
        const sortCount = storage('sortCount', d.array(d.atomic(d.u32)), 'read_write');
        const args = storage('sortIndirectArgs', d.array(d.u32), 'read_write');
        const draw = storage('drawTranslucent', d.array(d.u32), 'read_write');
        const n = atomicLoad(index(sortCount, u32(0)))
            .toU32()
            .toVar('n');
        // ceil(N / RADIX_BLOCK) with RADIX_BLOCK = 1024 = 2^10.
        const nb = add(n, u32(RADIX_BLOCK - 1))
            .shiftRight(u32(10))
            .toVar('nb');
        const prevNb = index(args, u32(4)).toVar('prevNb');
        args.element(u32(0)).assign(nb);
        args.element(u32(1)).assign(u32(1));
        args.element(u32(2)).assign(u32(1));
        args.element(u32(3)).assign(n);
        args.element(u32(4)).assign(nb);
        args.element(u32(5)).assign(max(nb, prevNb));
        // drawIndirect: [vertexCount=6, instanceCount, 0, 0].
        draw.element(u32(1)).assign(n);
        atomicStore(index(sortCount, u32(0)), u32(0)); // self-reset for the next run
    }).compute({ workgroupSize: [1, 1, 1], name: 'voxel-tsort-prep' });
}

// radix count (per pass): workgroup b histograms its RADIX_BLOCK items' current
// 8-bit digit into `radixHist[digit * numBlocks + b]` (digit-major, so the scan's
// flat prefix-sum yields exactly "where block b's run of digit d starts").
// Device atomics, but each block only touches its own 256 cells — the cells are
// zeroed by this same workgroup first (storage+workgroup barrier between), so no
// separate clear pass and no cross-fire staleness. Only PASS 0 uses this kernel
// (digit shift hardcoded 0); later passes' counts are fused into the scatters.
// Histogram rows use the FIXED `maxBlocks` stride.
export function createRadixCountCompute(maxBlocks: number): ComputeNode {
    return Fn(() => {
        const args = storage('sortIndirectArgs', d.array(d.u32), 'read');
        const srcKeys = storage('srcKeys', d.array(d.u32), 'read');
        const hist = storage('radixHist', d.array(d.atomic(d.u32)), 'read_write');
        const t = localId.x;
        const b = workgroupId.x;
        const n = index(args, u32(3)).toVar('n');

        // zero this block's histogram column, then tally into it.
        atomicStore(index(hist, add(t.mul(u32(maxBlocks)), b)), u32(0));
        storageBarrier();
        workgroupBarrier();

        const blockBase = b.mul(u32(RADIX_BLOCK)).toVar('blockBase');
        for (let k = 0; k < RADIX_ITEMS; k++) {
            const item = add(blockBase, add(t.mul(u32(RADIX_ITEMS)), u32(k))).toVar(`cItem${k}`);
            If(item.lessThan(n), () => {
                const dig = index(srcKeys, item).bitwiseAnd(u32(255)); // pass-0 digit
                atomicAdd(index(hist, add(dig.mul(u32(maxBlocks)), b)), u32(1));
            });
        }
    }).compute({ workgroupSize: [RADIX_WG, 1, 1], name: 'voxel-tsort-count' });
}

// radix scan (per pass): ONE workgroup. Exclusive prefix-sum of the digit-major
// `radixHist[256 × maxBlocks]` IN PLACE — after it, hist[d*MB + b] = global
// position where block b's run of digit d starts. Thread t owns digit t's row
// (numBlocks live entries, serial), then thread 0 scans the 256 row totals.
// ALSO zeroes its row in the OTHER histogram (up to `zeroTo` = args[5]) so the
// following scatter's fused next-digit count lands on clean cells.
export function createRadixScanCompute(maxBlocks: number): ComputeNode {
    const partial = WorkgroupVar('scanPartial', d.sizedArray(d.u32, RADIX_WG));
    return Fn(() => {
        const args = storage('sortIndirectArgs', d.array(d.u32), 'read');
        const hist = storage('radixHist', d.array(d.atomic(d.u32)), 'read_write');
        const histNext = storage('radixHistNext', d.array(d.atomic(d.u32)), 'read_write');
        const t = localId.x;
        const nb = index(args, u32(0)).toVar('nb');
        const zeroTo = index(args, u32(5)).toVar('zeroTo');
        const rowBase0 = t.mul(u32(maxBlocks)).toVar('rowBase0');

        // phase 0: zero this digit-row in the OTHER histogram for the fused
        // count that follows. `zeroTo` covers this AND the previous fire's
        // dirty cells (counts or dead bases), so no clear pass is ever needed.
        const iz = u32(0).toVar('rowIz');
        While(iz.lessThan(zeroTo), () => {
            atomicStore(index(histNext, add(rowBase0, iz)), u32(0));
            iz.addAssign(u32(1));
        });

        // phase 1: exclusive-scan own digit row in place; partial[t] = row total.
        const running = u32(0).toVar('rowRun');
        const i = u32(0).toVar('rowI');
        While(i.lessThan(nb), () => {
            const idx = add(rowBase0, i).toVar('rowIdx');
            const v = atomicLoad(index(hist, idx)).toU32().toVar('rowV');
            atomicStore(index(hist, idx), running);
            running.addAssign(v);
            i.addAssign(u32(1));
        });
        partial.element(t).assign(running);
        workgroupBarrier();

        // phase 2: thread 0 exclusive-scans the 256 row totals in place.
        If(t.equal(u32(0)), () => {
            const acc = u32(0).toVar('rowAcc');
            Loop({ start: 0, end: RADIX_WG, type: d.u32 }, ({ i: j }) => {
                const v = partial.element(j).toVar('rowPv');
                partial.element(j).assign(acc);
                acc.addAssign(v);
            });
        });
        workgroupBarrier();

        // phase 3: add the digit-row base onto the row's per-block prefixes.
        const rowBase = partial.element(t).toVar('rowBase');
        const i2 = u32(0).toVar('rowI2');
        While(i2.lessThan(nb), () => {
            const idx = add(rowBase0, i2).toVar('rowIdx2');
            atomicStore(index(hist, idx), atomicLoad(index(hist, idx)).toU32().add(rowBase));
            i2.addAssign(u32(1));
        });
    }).compute({ workgroupSize: [RADIX_WG, 1, 1], name: 'voxel-tsort-scan' });
}

// radix scatter (per pass): the STABLE reorder. Workgroup b stable-sorts its
// RADIX_BLOCK items by the pass digit entirely in workgroup memory (4 rounds of
// 2-bit split — counters packed as 2×16-bit fields across two words, since a
// block total reaches 1024 and would overflow 8-bit fields; one Hillis-Steele
// scan per round), then writes each item to `hist[digit*nb + b] +
// rankInBlockDigitRun`. ZERO atomics → fully deterministic: the same camera
// state always produces the same order.
// Tail items beyond N get digit 0xFF and (by stability, being last in input
// order) sink to the end of the local ordering, past any real 0xFF items — they
// tally into local bin 255 harmlessly and are skipped at write-out.
// The integer math is mirrored + property-tested against a reference stable
// sort in tst/unit/render/voxels/tsort-radix-model.test.ts — keep them in sync.
//
// Two compiled variants (`last`):
//   - regular (passes 0..2): shuffles (key, idx) src→dst AND fused-counts the
//     NEXT pass's digit into `radixHistNext` while the key is in-register —
//     this replaces the standalone count kernel for passes 1..3.
//   - last (pass 3): no key/idx/histogram writes at all — gathers
//     `sortPayload[idx]` straight into the translucent `visibleQuads`.
export function createRadixScatterCompute(maxBlocks: number, last: boolean): ComputeNode {
    // 4 digits packed per u32, indexed by local item >> 2 (thread t owns items
    // t*4..t*4+3, so it writes wgDigits[t] alone — no races).
    const wgDigits = WorkgroupVar('wgDigits', d.sizedArray(d.u32, RADIX_WG));
    const wgIdxA = WorkgroupVar('wgIdxA', d.sizedArray(d.u32, RADIX_BLOCK));
    const wgIdxB = WorkgroupVar('wgIdxB', d.sizedArray(d.u32, RADIX_BLOCK));
    // split counters: lo = count(v=0) | count(v=1)<<16, hi = v=2 / v=3.
    const wgScanLo = WorkgroupVar('wgScanLo', d.sizedArray(d.u32, RADIX_WG));
    const wgScanHi = WorkgroupVar('wgScanHi', d.sizedArray(d.u32, RADIX_WG));
    const wgStart = WorkgroupVar('wgStart', d.sizedArray(d.u32, RADIX_DIGITS));
    return Fn(() => {
        const args = storage('sortIndirectArgs', d.array(d.u32), 'read');
        const srcKeys = storage('srcKeys', d.array(d.u32), 'read');
        const srcIdx = storage('srcIdx', d.array(d.u32), 'read');
        const hist = storage('radixHist', d.array(d.atomic(d.u32)), 'read_write');
        const cfg = storage('radixPassConfig', d.array(d.u32), 'read');
        // variant-specific bindings (declared inside the graph builder, so each
        // compiled variant only binds what it uses — regular sits exactly at the
        // 8-storage-buffer floor, last at 7).
        const histNext = last ? null : storage('radixHistNext', d.array(d.atomic(d.u32)), 'read_write');
        const dstKeys = last ? null : storage('dstKeys', d.array(d.u32), 'read_write');
        const dstIdx = last ? null : storage('dstIdx', d.array(d.u32), 'read_write');
        const sortPayload = last ? storage('sortPayload', d.array(VisibleQuad), 'read') : null;
        const visibleQuads = last ? storage('visibleQuads', d.array(VisibleQuad), 'read_write') : null;
        const t = localId.x;
        const b = workgroupId.x;
        const n = index(args, u32(3)).toVar('n');
        const shift = index(cfg, u32(0)).toVar('shift');
        const blockBase = b.mul(u32(RADIX_BLOCK)).toVar('blockBase');
        // b < nb ⇒ blockBase < n, so this never underflows.
        const blockCount = min(u32(RADIX_BLOCK), sub(n, blockBase)).toVar('blockCount');

        // load: pack this thread's 4 item digits (pads ⇒ 0xFF) + identity perm.
        // OOB srcKeys reads for pads are robustness-clamped and select-discarded.
        const packed = u32(0).toVar('packed');
        for (let k = 0; k < RADIX_ITEMS; k++) {
            const li = add(t.mul(u32(RADIX_ITEMS)), u32(k)).toVar(`li${k}`);
            const dig = select(
                u32(255),
                index(srcKeys, add(blockBase, li)).shiftRight(shift).bitwiseAnd(u32(255)),
                li.lessThan(blockCount),
            ).toVar(`ld${k}`);
            packed.assign(packed.bitwiseOr(dig.shiftLeft(u32(8 * k))));
            wgIdxA.element(li).assign(li);
        }
        wgDigits.element(t).assign(packed);
        workgroupBarrier();

        // digit of local item i, from the packed cache.
        const digitOf = (item: ReturnType<typeof u32>) =>
            wgDigits
                .element(item.shiftRight(u32(2)))
                .shiftRight(item.bitwiseAnd(u32(3)).mul(u32(8)))
                .bitwiseAnd(u32(255));

        // 4 rounds of stable 2-bit split, ping-pong A→B→A→B→A.
        for (let r = 0; r < 4; r++) {
            const cur = r % 2 === 0 ? wgIdxA : wgIdxB;
            const nxt = r % 2 === 0 ? wgIdxB : wgIdxA;
            // count this thread's 4 slots into 2×16-bit fields per word.
            const cntLo = u32(0).toVar(`cntLo${r}`);
            const cntHi = u32(0).toVar(`cntHi${r}`);
            for (let k = 0; k < RADIX_ITEMS; k++) {
                const slot = add(t.mul(u32(RADIX_ITEMS)), u32(k));
                const v = digitOf(cur.element(slot).toU32())
                    .shiftRight(u32(2 * r))
                    .bitwiseAnd(u32(3))
                    .toVar(`cv${r}_${k}`);
                // v<2 → lo word (field v), v≥2 → hi word (field v−2).
                const field = shiftLeft(u32(1), v.bitwiseAnd(u32(1)).mul(u32(16)));
                cntLo.addAssign(select(u32(0), field, v.lessThan(u32(2))));
                cntHi.addAssign(select(field, u32(0), v.lessThan(u32(2))));
            }
            wgScanLo.element(t).assign(cntLo);
            wgScanHi.element(t).assign(cntHi);
            workgroupBarrier();
            // Hillis-Steele inclusive scan over both packed-counter words.
            for (let s = 1; s < RADIX_WG; s <<= 1) {
                // safe index (t<s reads slot 0, then masked to 0 by the select).
                const safeIdx = sub(max(t, u32(s)), u32(s)).toVar(`hs${r}_${s}`);
                const inRange = t.greaterThanEqual(u32(s));
                const tmpLo = select(u32(0), wgScanLo.element(safeIdx).toU32(), inRange).toVar(`hl${r}_${s}`);
                const tmpHi = select(u32(0), wgScanHi.element(safeIdx).toU32(), inRange).toVar(`hh${r}_${s}`);
                workgroupBarrier();
                wgScanLo.element(t).assign(wgScanLo.element(t).toU32().add(tmpLo));
                wgScanHi.element(t).assign(wgScanHi.element(t).toU32().add(tmpHi));
                workgroupBarrier();
            }
            const totalLo = wgScanLo
                .element(u32(RADIX_WG - 1))
                .toU32()
                .toVar(`totLo${r}`);
            const totalHi = wgScanHi
                .element(u32(RADIX_WG - 1))
                .toU32()
                .toVar(`totHi${r}`);
            const exclLo = sub(wgScanLo.element(t).toU32(), cntLo).toVar(`exLo${r}`);
            const exclHi = sub(wgScanHi.element(t).toU32(), cntHi).toVar(`exHi${r}`);
            // block-wide bases per 2-bit value, then this thread's running starts.
            const base1 = totalLo.bitwiseAnd(u32(0xffff)).toVar(`b1_${r}`);
            const base2 = add(base1, totalLo.shiftRight(u32(16))).toVar(`b2_${r}`);
            const base3 = add(base2, totalHi.bitwiseAnd(u32(0xffff))).toVar(`b3_${r}`);
            const s0 = exclLo.bitwiseAnd(u32(0xffff)).toVar(`s0_${r}`);
            const s1 = add(base1, exclLo.shiftRight(u32(16))).toVar(`s1_${r}`);
            const s2 = add(base2, exclHi.bitwiseAnd(u32(0xffff))).toVar(`s2_${r}`);
            const s3 = add(base3, exclHi.shiftRight(u32(16))).toVar(`s3_${r}`);
            // place own 4 items in order (sequential per thread ⇒ stable).
            for (let k = 0; k < RADIX_ITEMS; k++) {
                const slot = add(t.mul(u32(RADIX_ITEMS)), u32(k));
                const item = cur.element(slot).toU32().toVar(`pi${r}_${k}`);
                const v = digitOf(item)
                    .shiftRight(u32(2 * r))
                    .bitwiseAnd(u32(3))
                    .toVar(`pv${r}_${k}`);
                const pos = select(select(s3, s2, v.equal(u32(2))), select(s1, s0, v.equal(u32(0))), v.lessThan(u32(2)));
                nxt.element(pos).assign(item);
                s0.addAssign(select(u32(0), u32(1), v.equal(u32(0))));
                s1.addAssign(select(u32(0), u32(1), v.equal(u32(1))));
                s2.addAssign(select(u32(0), u32(1), v.equal(u32(2))));
                s3.addAssign(select(u32(0), u32(1), v.equal(u32(3))));
            }
            workgroupBarrier();
        }
        // final stable-by-digit ordering is in wgIdxA (4 swaps: A→B→A→B→A).

        // run starts: sorted position j begins digit d's run iff j==0 or the
        // digit changes. unique writer per cell ⇒ plain stores.
        for (let k = 0; k < RADIX_ITEMS; k++) {
            const j = add(t.mul(u32(RADIX_ITEMS)), u32(k)).toVar(`rj${k}`);
            const dig = digitOf(wgIdxA.element(j).toU32()).toVar(`rd${k}`);
            const prevJ = sub(max(j, u32(1)), u32(1));
            const prevDig = digitOf(wgIdxA.element(prevJ).toU32());
            If(or(j.equal(u32(0)), dig.notEqual(prevDig)), () => {
                wgStart.element(dig).assign(j);
            });
        }
        workgroupBarrier();

        // write-out: dst = hist[dig*MB + b] (block's global run base, from the
        // scan) + (j − runStart) (stable rank within the block's digit run).
        for (let k = 0; k < RADIX_ITEMS; k++) {
            const j = add(t.mul(u32(RADIX_ITEMS)), u32(k)).toVar(`wj${k}`);
            const item = wgIdxA.element(j).toU32().toVar(`wi${k}`);
            If(item.lessThan(blockCount), () => {
                const gidx = add(blockBase, item).toVar(`wg${k}`);
                const key = index(srcKeys, gidx).toVar(`wk${k}`);
                const idx0 = index(srcIdx, gidx).toVar(`wx${k}`);
                const dig = key.shiftRight(shift).bitwiseAnd(u32(255)).toVar(`wd${k}`);
                const rank = sub(j, wgStart.element(dig).toU32());
                const dstPos = add(atomicLoad(index(hist, add(dig.mul(u32(maxBlocks)), b))).toU32(), rank).toVar(`wp${k}`);
                if (last) {
                    // final pass: gather the payload by original index straight
                    // into the sorted draw buffer; keys/idx are dead now.
                    const sp = sortPayload!.element(idx0);
                    const dp = visibleQuads!.element(dstPos).fields();
                    dp.slot.assign(sp.field('slot'));
                    dp.localIdx.assign(sp.field('localIdx'));
                } else {
                    dstKeys!.element(dstPos).assign(key);
                    dstIdx!.element(dstPos).assign(idx0);
                    // fused count for the NEXT pass: tally the next digit into
                    // the destination block's column of the OTHER histogram
                    // (zeroed by the scan that just ran).
                    const dig1 = key.shiftRight(add(shift, u32(8))).bitwiseAnd(u32(255));
                    atomicAdd(index(histNext!, add(dig1.mul(u32(maxBlocks)), dstPos.shiftRight(u32(10)))), u32(1));
                }
            });
        }
    }).compute({
        workgroupSize: [RADIX_WG, 1, 1],
        name: last ? 'voxel-tsort-scatter-last' : 'voxel-tsort-scatter',
    });
}

// Level-A section ordering (opaque/transparent): fused count → finalize → bucketed
// emit. `bucketQuads`/`bucketBase`/`bucketCursor` are laid out
// `[pass*BUCKET_COUNT + b]`, front-to-back (near→far) for early-Z. The translucent
// pass is ordered by the global counting sort instead, so finalize skips it (and
// must NOT write drawTranslucent — that instanceCount is owned by the sort's prep
// and persists between gated re-runs).

// (The per-bucket quad tally that used to be a separate `count` pass is now fused
// into `createCullCompute` — each surviving section tallies its visible facings'
// quad counts into `bucketQuads` directly, avoiding the [1,1,1] count launch storm.)

/** finalize pass (single thread): exclusive prefix-sum the opaque/transparent
 *  buckets into `bucketBase`, reset `bucketCursor`, and write each pass's draw
 *  instanceCount (bucket total). Runs after the cull's fused tally, before emit. */
function createFinalizeCompute(): ComputeNode {
    return Fn(() => {
        const bucketQuads = storage('bucketQuads', d.array(d.atomic(d.u32)), 'read_write');
        const bucketBase = storage('bucketBase', d.array(d.u32), 'read_write');
        const bucketCursor = storage('bucketCursor', d.array(d.atomic(d.u32)), 'read_write');
        const draws = [
            storage('drawOpaque', d.array(d.u32), 'read_write'),
            storage('drawTransparent', d.array(d.u32), 'read_write'),
        ];
        for (let p = 0; p < 2; p++) {
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

const BYTES_PER_QUAD = QUAD_STRIDE_U32S * 4; // 56, interleaved header (40 B) + light (16 B)

export type QuadArenaStreams = {
    quads: { schema: d.u32; perSlot: number };
};

export type QuadArena = SegmentArena<QuadArenaStreams>;

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

// ── SectionTable ────────────────────────────────────────────────────

// GPU-resident per-slot cull metadata, the device mirror of
// `cpuFaceOffsets` + `cpuFaceCounts`:
//   [faceOffsets[0..6], faceCounts[0..6]].
// Read by the GPU cull/emit/expand computes to size + back-face-cull each of the
// 7 facing slices (and, for translucent, to total the section's quads). Unused by
// the VS (which reads ChunkInfo for origin + arenaBase instead).
export const SECTION_META_U32S = 14;

export type SectionEntryFields = {
    originX: number;
    originY: number;
    originZ: number;
    dataStart: number;
    dataCount: number;
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
        // GPU side-table only carries origin + arenaBase. cull mirrors below
        // hold faceOffsets / faceCounts / dataCount, none of which the VS needs
        // at draw time.
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
            // GPU mirror layout: [faceOffsets[0..6], faceCounts[0..6]].
            metaU32[metaBase + i] = off;
            metaU32[metaBase + 7 + i] = cnt;
        }
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
};

export type ChunkAlloc = {
    opaque: PassAlloc | null;
    transparent: PassAlloc | null;
    translucent: PassAlloc | null;
    /** chunk-level AABB, shared across all 3 passes. */
    aabb: Box3;
    /** this alloc's index in `packer.chunks` (== its cull-record index).
     *  Maintained across push/swap-pop so record updates + eviction are O(1).
     *  -1 until first push. */
    chunkIndex: number;
};

export type ArenaPacker = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, SectionTable>;
    allocs: Map<string, ChunkAlloc>;
    /** dense list of currently-held ChunkAllocs, in insertion order.
     *  cullCPU iterates this for the frustum + back-face pass.
     *  swap-pop on evict, push on first upsert. */
    chunks: ChunkAlloc[];
    /** per-chunk origin (worldspace min corner). populated on upsertChunk;
     *  consumed by OOM eviction policy (farthest-from-camera). */
    origins: Map<string, [number, number, number]>;
    cameraPos: Vec3 | null;
    /** set whenever a translucent PassAlloc is created/freed/moved (upsert,
     *  evict, clearAll). The translucent counting-sort persists its output
     *  between gated re-runs, so a mutation here must force a re-sort — else the
     *  persisted `{slot, localIdx}` dangle onto reallocated/zeroed arena data.
     *  Read + cleared by `updateCull`'s gate. */
    translucentDirty: boolean;
    /** GPU cull input, one `ChunkCullRecord` per resident chunk, kept in
     *  lockstep with `chunks` by array index (push/swap-pop mirror below).
     *  Dispatched over `chunks.length` by the cull compute. */
    cullRecordsBuffer: GpuBuffer;
    /** u32 view over `cullRecordsBuffer.array` for bit-exact int writes. */
    cullRecordsU32: Uint32Array;
};

export function createArenaPacker(opts: { quadArena: QuadArena; tables: Record<VoxelPass, SectionTable> }): ArenaPacker {
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
        tables: opts.tables,
        allocs: new Map(),
        chunks: [],
        origins: new Map(),
        cameraPos: null,
        translucentDirty: false,
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
    if (pass === 'translucent') packer.translucentDirty = true;
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
        chunkIndex: -1,
    };
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

        if (cur) arenaFree(packer.quadArena, cur.dataStart);
        const dataStart = packerAllocWithEviction(packer, chunkKey, needQuads);
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        const table = packer.tables[pass];
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, chunkKey, pass);

        table.writeEntry(sectionSlot, {
            originX: origin[0],
            originY: origin[1],
            originZ: origin[2],
            dataStart,
            dataCount: needQuads,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });

        // a fresh translucent mesh reallocates arena data → the persisted sort
        // permutation is stale; flag it so the gate forces a re-sort.
        if (pass === 'translucent') packer.translucentDirty = true;
        next[pass] = { sectionSlot, dataStart, dataCount: needQuads };
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
    // a room swap invalidates any persisted translucent sort permutation.
    packer.translucentDirty = true;
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
    /** bytes for the shared quadArena (all 3 passes). */
    quadArenaBytes: number;
    /** max chunk×pass slots per SectionTable (one table per pass). */
    maxSections: number;
    /** OffsetAllocator node-pool size for the quad arena. */
    maxAllocs: number;
};

export function voxelArenaBudgetForTier(profile: Performance.Profile): VoxelArenaBudget {
    const s = Performance.settingsForTier(profile);
    const cap = Math.floor(profile.limits.maxArenaBytes * 0.25);
    const desired = s.voxelArenaDesiredMB * 1024 * 1024;
    const total = Math.min(desired, cap);
    return {
        quadArenaBytes: total,
        maxSections: s.voxelMaxSections,
        maxAllocs: s.voxelArenaMaxAllocs,
    };
}

// ── VoxelArenaResources ─────────────────────────────────────────────

export type VoxelArenaResources = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, SectionTable>;
    packer: ArenaPacker;
};

export function createVoxelArenaResources(budget: VoxelArenaBudget): VoxelArenaResources {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    const tables: Record<VoxelPass, SectionTable> = {
        opaque: createSectionTable({ name: 'sectionTable-opaque', slotCount: budget.maxSections }),
        transparent: createSectionTable({ name: 'sectionTable-transparent', slotCount: budget.maxSections }),
        translucent: createSectionTable({ name: 'sectionTable-translucent', slotCount: budget.maxSections }),
    };
    const packer = createArenaPacker({ quadArena, tables });
    return { quadArena, tables, packer };
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
    /** Level-A finalize compute: prefix-sums opaque/transparent buckets → base +
     *  draw counts. Does NOT touch the translucent draw (owned by `tsortPrep`). */
    finalize: ComputeNode;
    /** translucent global stable-radix sort chain. Runs (gated) as
     *  expand → prep → count₀ → 4 × (scan → scatter); the last scatter is the
     *  dedicated payload-gather variant. See the `RADIX_*` description above. */
    tsortExpand: ComputeNode;
    tsortPrep: ComputeNode;
    radixCount: ComputeNode;
    radixScan: ComputeNode;
    radixScatter: ComputeNode;
    radixScatterLast: ComputeNode;
    /** flat per-quad (key, ORIGINAL-INDEX) ping-pong pairs for the radix passes
     *  (A→B→A→B) + the single payload buffer the last scatter gathers from.
     *  Sized to the worst case (all quads translucent) = quadArena.slotCount. */
    sortKeys: GpuBuffer;
    sortKeysAlt: GpuBuffer;
    sortIdx: GpuBuffer;
    sortIdxAlt: GpuBuffer;
    sortPayload: GpuBuffer;
    /** digit-major radix histogram/base tables `[digit * maxBlocks + block]`
     *  (FIXED stride), 256 × maxBlocks each. Ping-pong: counts for digit p live
     *  in hist[p%2] (count₀ / the fused scatter counts), scan p consumes them
     *  into bases in place and zeroes the other buffer for the next fused
     *  count. No CPU clears. */
    radixHist: GpuBuffer;
    radixHistAlt: GpuBuffer;
    /** per-pass digit shift `[0] / [8] / [16] / [24]`, bound per dispatch. */
    radixPassConfig: GpuBuffer[];
    /** atomic append counter (= N visible translucent quads); self-reset by prep. */
    sortCount: GpuBuffer;
    /** radix count/scatter indirect dispatch args
     *  `[numBlocks, 1, 1, N, prevNumBlocks, zeroTo]`; written by prep (word 4
     *  persists across fires to bound the scans' zeroing exactly). */
    sortIndirectArgs: GpuBuffer;
    /** translucent sort re-run gate: the sort output persists across frames and
     *  only re-runs when the order could change (translation / rotation / arena
     *  mutation / room activation). `valid` false forces the first run. */
    tsortGate: { valid: boolean; camX: number; camY: number; camZ: number; fwdX: number; fwdY: number; fwdZ: number };
    /** set by `updateCull` each frame; read by `cullDispatches` to enqueue the
     *  translucent sort chain (or skip it and reuse last frame's permutation). */
    runTranslucentSort: boolean;
    /** per-bucket quad tallies `[pass*BUCKET_COUNT + b]` (atomic); CPU-zeroed
     *  each frame, written by the cull's fused count, read by `finalize`. */
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
    /** engine-global arenas (quadArena + per-pass section tables + packer).
     *  active room owns the contents at any given time; `packerClearAll`
     *  resets on activation. */
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

    // arenas first: the radix kernels bake the histogram row stride (maxBlocks,
    // derived from the arena's slot capacity) into their compiled graphs.
    const arenas = createVoxelArenaResources(budget);
    const passRender = createPassRender(arenas);
    const geometries = createGeometries(arenas, passRender, env);
    const sortCap = arenas.quadArena.slotCount;
    const maxRadixBlocks = Math.ceil(sortCap / RADIX_BLOCK);

    const cull = createCullCompute();
    const emit = createEmitCompute();
    const finalize = createFinalizeCompute();
    const tsortExpand = createTranslucentExpandCompute();
    const tsortPrep = createTranslucentPrepCompute();
    const radixCount = createRadixCountCompute(maxRadixBlocks);
    const radixScan = createRadixScanCompute(maxRadixBlocks);
    const radixScatter = createRadixScatterCompute(maxRadixBlocks, false);
    const radixScatterLast = createRadixScatterCompute(maxRadixBlocks, true);

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
        opaque: new GpuBuffer(d.array(d.u32), {
            data: new Uint32Array([0, 1]),
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        }),
        transparent: new GpuBuffer(d.array(d.u32), {
            data: new Uint32Array([1, 1]),
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        }),
        translucent: new GpuBuffer(d.array(d.u32), {
            data: new Uint32Array([2, 0]),
            usage: 'storage',
            lifecycle: BufferLifecycle.MANUAL,
        }),
    };

    // Level-A bucket scratch: 3 passes × BUCKET_COUNT (the translucent slice is
    // unused — that pass sorts globally — but the layout stays pass-indexed).
    // `bucketQuads` is CPU-zeroed each frame; base/cursor are GPU-managed by finalize.
    const bucketCount3 = 3 * BUCKET_COUNT;
    const bucketQuadsData = new Uint32Array(bucketCount3);
    const bucketQuads = new GpuBuffer(d.array(d.atomic(d.u32)), {
        data: bucketQuadsData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const bucketBase = new GpuBuffer(d.array(d.u32), { data: new Uint32Array(bucketCount3), usage: 'storage' });
    const bucketCursor = new GpuBuffer(d.array(d.atomic(d.u32)), { data: new Uint32Array(bucketCount3), usage: 'storage' });

    // translucent global stable-radix scratch. (key, idx) ping-pong pairs +
    // single payload buffer, sized to the worst case (every quad translucent) =
    // quadArena.slotCount — standalone flat buffers indexed by global sort
    // position (NOT part of the arena). Histograms are compute-managed (count₀
    // self-zeroes its columns; the scans zero the other buffer up to `zeroTo`).
    const sortKeys = new GpuBuffer(d.array(d.u32), { count: sortCap, usage: 'storage' });
    const sortKeysAlt = new GpuBuffer(d.array(d.u32), { count: sortCap, usage: 'storage' });
    const sortIdx = new GpuBuffer(d.array(d.u32), { count: sortCap, usage: 'storage' });
    const sortIdxAlt = new GpuBuffer(d.array(d.u32), { count: sortCap, usage: 'storage' });
    const sortPayload = new GpuBuffer(d.array(VisibleQuad), { count: sortCap, usage: 'storage' });
    const radixHist = new GpuBuffer(d.array(d.atomic(d.u32)), { count: RADIX_DIGITS * maxRadixBlocks, usage: 'storage' });
    const radixHistAlt = new GpuBuffer(d.array(d.atomic(d.u32)), { count: RADIX_DIGITS * maxRadixBlocks, usage: 'storage' });
    const radixPassConfig: GpuBuffer[] = [0, 8, 16, 24].map(
        (shift) =>
            new GpuBuffer(d.array(d.u32), {
                data: new Uint32Array([shift]),
                usage: 'storage',
                lifecycle: BufferLifecycle.MANUAL,
            }),
    );
    const sortCount = new GpuBuffer(d.array(d.atomic(d.u32)), { count: 1, usage: 'storage' });
    // indirect args [numBlocks, 1, 1, N, prevNumBlocks, zeroTo]; prep writes
    // them, the radix kernels dispatch from + bind them as storage (gpucat gives
    // indirect buffers INDIRECT|STORAGE).
    const sortIndirectArgs = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array([0, 1, 1, 0, 0, 0]),
        usage: 'indirect',
        lifecycle: BufferLifecycle.MANUAL,
    });

    return {
        atlas,
        texAnimBuffer,
        quadMaterials,
        cull,
        emit,
        finalize,
        tsortExpand,
        tsortPrep,
        radixCount,
        radixScan,
        radixScatter,
        radixScatterLast,
        sortKeys,
        sortKeysAlt,
        sortIdx,
        sortIdxAlt,
        sortPayload,
        radixHist,
        radixHistAlt,
        radixPassConfig,
        sortCount,
        sortIndirectArgs,
        tsortGate: { valid: false, camX: 0, camY: 0, camZ: 0, fwdX: 0, fwdY: 0, fwdZ: 0 },
        runTranslucentSort: false,
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
        computeReady = Promise.all([
            renderer.compileCompute(res.cull),
            renderer.compileCompute(res.finalize),
            renderer.compileCompute(res.emit),
            renderer.compileCompute(res.tsortExpand),
            renderer.compileCompute(res.tsortPrep),
            renderer.compileCompute(res.radixCount),
            renderer.compileCompute(res.radixScan),
            renderer.compileCompute(res.radixScatter),
            renderer.compileCompute(res.radixScatterLast),
        ]).then(() => {});
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
        computeReady = Promise.all([
            renderer.compileCompute(res.cull),
            renderer.compileCompute(res.finalize),
            renderer.compileCompute(res.emit),
            renderer.compileCompute(res.tsortExpand),
            renderer.compileCompute(res.tsortPrep),
            renderer.compileCompute(res.radixCount),
            renderer.compileCompute(res.radixScan),
            renderer.compileCompute(res.radixScatter),
            renderer.compileCompute(res.radixScatterLast),
        ]).then(() => {});
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
    for (const pass of PASSES) state.arenas.tables[pass].dispose();
    state.arenas.packer.cullRecordsBuffer.dispose();
    state.cullView.dispose();
    state.visibleChunks.dispose();
    state.emitArgs.dispose();
    for (const pass of PASSES) state.emitConfig[pass].dispose();
    state.bucketQuads.dispose();
    state.bucketBase.dispose();
    state.bucketCursor.dispose();
    state.sortKeys.dispose();
    state.sortKeysAlt.dispose();
    state.sortIdx.dispose();
    state.sortIdxAlt.dispose();
    state.sortPayload.dispose();
    state.radixHist.dispose();
    state.radixHistAlt.dispose();
    for (const cfg of state.radixPassConfig) cfg.dispose();
    state.sortCount.dispose();
    state.sortIndirectArgs.dispose();
    if (state.meshDispatcher) disposeMeshDispatcher(state.meshDispatcher);
    state.pendingMeshResults.length = 0;
    state.pendingLostChunkKeys.length = 0;
}

// ── per-frame GPU frame graph ───────────────────────────────────────
//
// These drive the engine-global compute resources above each frame. They read
// and mutate only `VoxelResources` (no per-room state), so they live here next
// to the kernels + buffers they wire — a pipeline change touches one file.
// The active room calls `updateCull` then `cullDispatches` each frame (see
// voxel-visuals' per-room `update` for the remesh half).

const _cullFrustum = frustum.create();

/** Write the per-frame camera view (5 pre-shifted, camera-relative frustum
 *  planes + camera chunk/frac) into `cullView`, and reset the GPU cull/emit
 *  counters. The visibility test + slice emission run on the GPU via
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
    // mirror stays all-zero; re-uploading it clears the GPU buffer). On a normal
    // frame the draw instanceCounts are (re)written by the finalize/prep passes.
    voxelResources.bucketQuads.addUpdateRange(0, voxelResources.bucketQuadsData.length);
    voxelResources.bucketQuads.needsUpdate = true;

    // Empty arena (recordCount 0, e.g. right after a room swap cleared it):
    // `cullDispatches` returns no dispatches, so finalize/prep never run and the
    // previous room's draw instanceCounts + visibleQuads would keep drawing
    // stale quads. Zero the per-pass draw instanceCounts on the CPU so the
    // indirect draws render nothing until the arena refills.
    if (voxelResources.arenas.packer.chunks.length === 0) {
        for (const pass of PASSES) {
            const pr = voxelResources.passRender[pass];
            pr.indirectData[1] = 0; // DrawIndirect: [vertexCount, instanceCount, ...]
            pr.indirectBuffer.needsUpdate = true;
        }
    }

    // translucent sort gate: the radix output persists across frames and only
    // re-runs when the back-to-front order can change. The owner-cell key is
    // rotation-invariant, so orbiting in place needs no re-sort — but the visible
    // SET changes on rotation, and a translucent arena mutation would leave the
    // persisted `{slot, localIdx}` dangling. Gate = translation ∨ rotation ∨
    // arena mutation ∨ first-run. When skipped, last frame's permutation + draw
    // count stand.
    updateTranslucentSortGate(voxelResources, cx, cy, cz, _cullFrustum[4]!.normal);
}

// distance the camera must move before the translucent sort re-runs. Tight: a
// small translation reorders near geometry (e.g. diving through a water surface),
// and the whole sort is one cheap flat pass, so we only truly skip when static.
const TSORT_MOVE_TRIGGER_SQ = 0.1 * 0.1; // 0.1 block
// re-run once the camera forward turns past this (cos of the angle). The visible
// set shifts on rotation, so newly-entered translucent sections must be sorted in.
const TSORT_ROTATE_TRIGGER_COS = 0.9998; // ≈ 1.1°

/** Decide whether the translucent radix sort re-runs this frame, and refresh the
 *  gate baseline when it does. `fwd` is the camera-forward (near-plane inward
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

/** GPU cull + Level-A ordered emit + translucent radix dispatch chain. gpucat
 *  runs each dispatch in its own compute pass, so the data dependencies hold.
 *  Push into the renderer's dispatch list before `renderer.compute(...)`. Empty
 *  when no chunks are resident.
 *
 *  1. cull: one thread per resident chunk; frustum-test, compact survivors into
 *     `visibleChunks` (+ distance bucket), write the emit dispatch args, AND tally
 *     each survivor's visible opaque/transparent facings into `bucketQuads`.
 *  2. finalize: prefix-sum opaque/transparent buckets → instance bases + draw counts.
 *  3. emit (opaque/transparent): back-face-cull facings, write `visibleQuads`
 *     front-to-back at the bucket base.
 *  4. translucent global stable radix sort (gated — see `runTranslucentSort`):
 *     expand → prep → count₀ → 4 × (scan → scatter), producing the back-to-front
 *     translucent `visibleQuads` permutation + its draw count. Skipped when the
 *     camera is static and the arena unchanged; last frame's result persists. */
export function cullDispatches(voxelResources: VoxelResources): ComputeDispatch[] {
    const packer = voxelResources.arenas.packer;
    const recordCount = packer.chunks.length;
    const out: ComputeDispatch[] = [];
    // Empty arena (recordCount 0, e.g. right after a room swap cleared it): skip
    // the whole chain. Dispatching it would only produce record-scaled
    // zero-workgroup no-ops (which Dawn warns about), and `updateCull` has
    // already CPU-zeroed the per-pass draw instanceCounts so the indirect draws
    // render nothing this frame.
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
