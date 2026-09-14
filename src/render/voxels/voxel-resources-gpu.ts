import type { Camera, ComputeDispatch, Material, WebGPURenderer } from 'gpucat';
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
import type { Vec3 } from 'math';
import type { Resources } from '../../core/resources';
import type { Blocks } from '../../core/voxels/block-registry';
import {
    buildMeshInput,
    type ChunkMeshResult,
    type MeshOutput,
    meshChunk,
    type PassMesh,
    QUAD_STRIDE_U32S,
} from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, type Chunk, chunkKey, markChunkDirty, type Voxels } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment/environment';
import type { TimeResources } from '../time';
import { createMesher, disposeMesher, loadMeshWorker, type Mesher, resetMeshCaches, setMeshRegistry } from './mesher';
import {
    arenaAlloc,
    arenaDispose,
    arenaFree,
    arenaWrite,
    BUCKET_COUNT,
    buildCullView,
    type ChunkAlloc,
    ChunkCullRecord,
    ChunkInfo,
    createQuadArena,
    DRAW_INDIRECT_STRIDE,
    hasNoVisibleSurface,
    PASSES,
    type QuadArena,
    SECTION_META_U32S,
    type SectionEntryFields,
    VISIBLE_QUAD_STRIDE,
    VisibleChunk,
    VisibleQuad,
    type VoxelArenaBudget,
} from './voxel-arena';
import { lightVolumeConfigOf, routeLightVolumeBuffers } from './voxel-light-sample';
import { createLightVolume, evictChunkLightByKey, type LightVolume } from './voxel-light-volume';
import { createGpuQuadMaterial, decodeOct16, decodeQuadCentroid, type VoxelPass } from './voxel-material';
import {
    createVoxelTextures,
    loadAtlasMeta,
    loadVoxelTextures,
    type TileAtlasMetadata,
    type VoxelTextures,
} from './voxel-textures';

// Translucent quads draw back-to-front via a stable 4-pass LSD radix sort over key = [cellL1:10][intraDist:20][facing:1], gated by updateTranslucentSortGate to skip when the order can't change; key-ordering correctness is verified in tst/unit/render/voxels/tsort-radix-model.test.ts.
const RADIX_WG = 256;
const RADIX_ITEMS = 4;
const RADIX_BLOCK = RADIX_WG * RADIX_ITEMS;
const RADIX_DIGITS = 256;
const TSORT_EXPAND_WG = 256;
const TSORT_CELL_LEVELS = 1024; // 10-bit owner-cell L1
const TSORT_DIST_LEVELS = 1 << 20; // 20-bit within-cell distance

// camMeta = (camChunkX, camChunkY, camChunkZ, liveRecordCount); camFrac = (subChunkOffset.xyz, viewRadiusSq); plane0..4 are camera-relative frustum planes (far plane dropped) with the section half-extent folded into .w, so the test is dot(plane.xyz, rel) + plane.w >= 0.
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

// One thread per resident chunk: frustum/distance test, then workgroup-local compaction of survivors (one global atomic per workgroup, not per chunk) into visibleChunks and the emit dispatch args.
function createCullCompute(): ComputeNode {
    const wgCount = WorkgroupVar('wgCount', d.atomic(d.u32));
    const wgBase = WorkgroupVar('wgBase', d.u32);
    return Fn(() => {
        const records = storage('cullRecords', d.array(ChunkCullRecord), 'read');
        const view = storage('cullView', d.array(CullView), 'read');
        const visible = storage('visibleChunks', d.array(VisibleChunk), 'read_write');
        const emitArgs = storage('emitArgs', d.array(d.atomic(d.u32)), 'read_write');
        // Fused count for opaque/transparent only; translucent is ordered by the global sort instead.
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
        // Camera-relative section center stays int-exact: (chunk - camChunk) * CHUNK_SIZE + (half - frac).
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
        // No early return (every lane must reach the barriers below); out-of-range tail threads are discarded by the and() chain.
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
            // L1 (Manhattan) distance bucket: same-bucket sections can never occlude each other.
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

            // Tally each visible facing's quads into its distance bucket so finalize can prefix-sum instance bases; back-face cull here matches emit so counts equal emitted quads.
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

// Per-facing emit for opaque/transparent, dispatched [visibleChunkCount, 7, 1] (workgroupId.x = chunk, .y = facing 0..5 cardinal, 6 unassigned); back-face cone-culls cardinal facings then stride-writes quads into visibleQuads.
// emitConfig: [0] = pass (0 opaque, 1 transparent, 2 translucent), [1] = 1 to back-face cull, 0 to emit every facing.
function createEmitCompute(): ComputeNode {
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

        // 3-way slot select: pass 0 is opaque, 1 transparent, 2 translucent.
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

        // Back-face cull: +face (even f) visible when axis < +half, -face (odd f) when axis > -half; skipped for translucent or facing 6.
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

        // Reserve this facing's instance range once per workgroup (lane 0): bucket base plus a running within-bucket cursor bump.
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

// One workgroup per visible translucent section (dispatched on [visibleChunkCount, 7, 1]; only workgroupId.y == 0 runs); lane 0 reserves the flat range, lanes write each quad's key/payload/index.
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
        // Camera's cell in section-local coords (camera sits at -relOrigin); stays f32-exact at world scale.
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
            // Word 6 packs the oct16 normal (low 16 bits) and the owner cell (bits 16..27); one load feeds cellL1 and facing.
            const w3 = index(quads, add(realQuadId.mul(u32(QUAD_STRIDE_U32S)), u32(6))).toVar('w3');
            // cellL1 = L1 distance between owner cell and camera cell (the exact cross-cell term).
            const ownDx = abs(w3.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().sub(camCellX)).toVar('ownDx');
            const ownDy = abs(w3.shiftRight(u32(20)).bitwiseAnd(u32(0xf)).toF32().sub(camCellY)).toVar('ownDy');
            const ownDz = abs(w3.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().sub(camCellZ)).toVar('ownDz');
            const cellL1 = min(add(ownDx, add(ownDy, ownDz)), f32(TSORT_CELL_LEVELS - 1))
                .toU32()
                .toVar('cellL1');
            const cellKey = sub(u32(TSORT_CELL_LEVELS - 1), cellL1).toVar('cellKey');
            // intraDist = normalised centroid distance (within-cell refinement).
            const centroidByte = decodeQuadCentroid(quads, realQuadId).toVar('cb');
            // `decodeQuadCentroid` already returns voxels, so no scale here.
            const camRel = relOrigin.add(centroidByte).toVar('camRel');
            const dist = length(camRel).toVar('dist');
            const norm = clamp(div(sub(dist, nearDist), distSpan), f32(0), f32(1)).toVar('norm');
            const distLevel = min(floor(norm.mul(f32(TSORT_DIST_LEVELS))).toU32(), u32(TSORT_DIST_LEVELS - 1)).toVar('distLevel');
            const distKey = sub(u32(TSORT_DIST_LEVELS - 1), distLevel).toVar('distKey');
            // Facing: camera-facing is drawn last (camRel lies on the quad's plane for axis-aligned faces, so the sign is exact).
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

// Single thread: turns the expand's atomic count N into the radix indirect dispatch args [numBlocks,1,1,N,prevNumBlocks,zeroTo], writes the translucent draw's instanceCount, and self-resets sortCount.
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

// Workgroup b histograms its block's items into radixHist[digit * maxBlocks + b] (digit-major), zeroing its own columns first; only pass 0 uses this kernel, later passes fuse counts into the scatter.
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

// One workgroup: exclusive prefix-sums radixHist in place so hist[d*maxBlocks+b] becomes the global start of block b's digit-d run, and zeroes the other histogram's row up to zeroTo for the next fused count.
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

        // Zero this digit-row in the other histogram; zeroTo covers this and the previous fire's dirty cells, so no separate clear pass is needed.
        const iz = u32(0).toVar('rowIz');
        While(iz.lessThan(zeroTo), () => {
            atomicStore(index(histNext, add(rowBase0, iz)), u32(0));
            iz.addAssign(u32(1));
        });

        // Exclusive-scan own digit row in place; partial[t] ends up holding the row total.
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

        // Thread 0 exclusive-scans the 256 row totals in place.
        If(t.equal(u32(0)), () => {
            const acc = u32(0).toVar('rowAcc');
            Loop({ start: 0, end: RADIX_WG, type: d.u32 }, ({ i: j }) => {
                const v = partial.element(j).toVar('rowPv');
                partial.element(j).assign(acc);
                acc.addAssign(v);
            });
        });
        workgroupBarrier();

        // Add the digit-row base onto the row's per-block prefixes.
        const rowBase = partial.element(t).toVar('rowBase');
        const i2 = u32(0).toVar('rowI2');
        While(i2.lessThan(nb), () => {
            const idx = add(rowBase0, i2).toVar('rowIdx2');
            atomicStore(index(hist, idx), atomicLoad(index(hist, idx)).toU32().add(rowBase));
            i2.addAssign(u32(1));
        });
    }).compute({ workgroupSize: [RADIX_WG, 1, 1], name: 'voxel-tsort-scan' });
}

// Workgroup b stable-sorts its block by the pass digit in workgroup memory (4 rounds of 2-bit split via Hillis-Steele scan), then writes each item to hist[digit*maxBlocks+b] + rankInBlockDigitRun; zero atomics keeps it fully deterministic. Mirrored and property-tested in tst/unit/render/voxels/tsort-radix-model.test.ts.
// last=false (passes 0..2) shuffles (key, idx) and fused-counts the next digit into radixHistNext; last=true (pass 3) instead gathers sortPayload[idx] straight into visibleQuads.
export function createRadixScatterCompute(maxBlocks: number, last: boolean): ComputeNode {
    // 4 digits packed per u32, indexed by item>>2; thread t owns items t*4..t*4+3 so it writes wgDigits[t] alone, no races.
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
        // Variant-specific bindings: regular sits at the 8-storage-buffer floor, last at 7.
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
        // b < nb implies blockBase < n, so this never underflows.
        const blockCount = min(u32(RADIX_BLOCK), sub(n, blockBase)).toVar('blockCount');

        // Pack this thread's 4 item digits (pads become 0xFF) plus identity perm; OOB pad reads are robustness-clamped and select-discarded.
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

        // 4 rounds of stable 2-bit split, ping-pong A-B-A-B-A.
        for (let r = 0; r < 4; r++) {
            const cur = r % 2 === 0 ? wgIdxA : wgIdxB;
            const nxt = r % 2 === 0 ? wgIdxB : wgIdxA;
            // count this thread's 4 slots into 2x16-bit fields per word.
            const cntLo = u32(0).toVar(`cntLo${r}`);
            const cntHi = u32(0).toVar(`cntHi${r}`);
            for (let k = 0; k < RADIX_ITEMS; k++) {
                const slot = add(t.mul(u32(RADIX_ITEMS)), u32(k));
                const v = digitOf(cur.element(slot).toU32())
                    .shiftRight(u32(2 * r))
                    .bitwiseAnd(u32(3))
                    .toVar(`cv${r}_${k}`);
                // v<2 goes to the lo word (field v), v>=2 to the hi word (field v-2).
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
            // place own 4 items in order (sequential per thread, so stable).
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
        // final stable-by-digit ordering is in wgIdxA (4 swaps: A-B-A-B-A).

        // Sorted position j begins digit d's run iff j==0 or the digit changes; unique writer per cell, so plain stores.
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

        // Write-out: dst = hist[dig*maxBlocks+b] (block's global run base) + (j - runStart) (stable rank within the run).
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
                    // Final pass: gather the payload by original index straight into the sorted draw buffer; keys/idx are dead now.
                    const sp = sortPayload!.element(idx0);
                    const dp = visibleQuads!.element(dstPos).fields();
                    dp.slot.assign(sp.field('slot'));
                    dp.localIdx.assign(sp.field('localIdx'));
                } else {
                    dstKeys!.element(dstPos).assign(key);
                    dstIdx!.element(dstPos).assign(idx0);
                    // Fused count for the next pass: tally the next digit into the destination block's column of the other histogram, already zeroed by the scan.
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

// Section ordering for opaque/transparent: bucketQuads/bucketBase/bucketCursor are [pass*BUCKET_COUNT+b], front-to-back for early-Z; finalize skips translucent since its instanceCount is owned by the sort's prep.
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

// This backend owns its arena end to end (quad arena, per-pass section tables, residency/eviction packer with cull-record buffer + sort gate); residency/eviction code is duplicated in the WebGL backend rather than shared.
const CHUNK_CULL_RECORD_U32S = layoutStrideOf(ChunkCullRecord) / 4;

// Plain state; sectionAllocSlot/sectionFreeSlot/sectionWriteEntry/sectionDispose are standalone fns over it.
type GpuSectionTable = {
    readonly slotCount: number;
    // ChunkInfo {origin, arenaBase}, bound as 'chunkInfo' on each pass geometry.
    readonly buffer: GpuBuffer;
    // u32 view over buffer.array, for packing/zeroing entries in place.
    readonly dataU32: Uint32Array;
    readonly entryU32s: number;
    // GPU mirror of face offsets/counts (SECTION_META_U32S per slot), read by cull/emit/expand.
    readonly metaBuffer: GpuBuffer;
    // u32 view over metaBuffer.array, for bit-exact face writes.
    readonly metaU32: Uint32Array;
    // free slot indices (LIFO); a slot is live iff it's not on the stack.
    readonly freeStack: number[];
};

function createGpuSectionTable(slotCount: number): GpuSectionTable {
    // GPU side-table (16B/entry): origin + arenaBase; face offsets/counts live in metaBuffer below, AABB lives on ChunkAlloc.
    const buffer = new GpuBuffer(d.array(ChunkInfo), {
        count: slotCount,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const arrF32 = buffer.array as Float32Array;
    const dataU32 = new Uint32Array(arrF32.buffer, arrF32.byteOffset, arrF32.length);

    // Face offsets/counts (14 u32/slot) for the cull compute; explicit data: (not count:) keeps the backing store a Uint32Array for bit-exact writes.
    const metaBuffer = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(slotCount * SECTION_META_U32S),
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });

    const freeStack: number[] = new Array(slotCount);
    for (let i = 0; i < slotCount; i++) freeStack[i] = slotCount - 1 - i;
    return {
        slotCount,
        buffer,
        dataU32,
        entryU32s: arrF32.length / slotCount,
        metaBuffer,
        metaU32: metaBuffer.array as Uint32Array,
        freeStack,
    };
}

function sectionAllocSlot(t: GpuSectionTable): number {
    const slot = t.freeStack.pop();
    if (slot === undefined) throw new Error(`SectionTable OOM at ${t.slotCount}`);
    return slot;
}

function sectionFreeSlot(t: GpuSectionTable, slot: number): void {
    const base = slot * t.entryU32s;
    for (let i = 0; i < t.entryU32s; i++) t.dataU32[base + i] = 0;
    t.buffer.addUpdateRange(base, t.entryU32s);
    // zero the GPU cull mirror too (a freed slot must contribute nothing).
    const metaBase = slot * SECTION_META_U32S;
    for (let i = 0; i < SECTION_META_U32S; i++) t.metaU32[metaBase + i] = 0;
    t.metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);
    t.freeStack.push(slot);
}

function sectionWriteEntry(t: GpuSectionTable, slot: number, entry: SectionEntryFields): void {
    const base = slot * t.entryU32s;
    packTo(ChunkInfo, t.dataU32, base * 4, {
        origin: [entry.originX, entry.originY, entry.originZ],
        arenaBase: entry.dataStart,
    });
    t.buffer.addUpdateRange(base, t.entryU32s);
    const metaBase = slot * SECTION_META_U32S;
    for (let i = 0; i < 7; i++) {
        // GPU mirror layout: [faceOffsets[0..6], faceCounts[0..6]].
        t.metaU32[metaBase + i] = entry.faceOffsets[i]!;
        t.metaU32[metaBase + 7 + i] = entry.faceCounts[i]!;
    }
    t.metaBuffer.addUpdateRange(metaBase, SECTION_META_U32S);
}

function sectionDispose(t: GpuSectionTable): void {
    t.buffer.dispose();
    t.metaBuffer.dispose();
}

// The arena is its own residency manager: the packer* fns below are the residency layer over the raw quadArena slab + section tables.
type GpuVoxelArena = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, GpuSectionTable>;
    // keyed by bare chunk coord key (arena holds one world at a time).
    allocs: Map<string, ChunkAlloc>;
    residentKeys: Set<string>;
    // dense list of held ChunkAllocs, kept in lockstep with cullRecordsBuffer by array index.
    chunks: ChunkAlloc[];
    // per-chunk worldspace min corner; consumed by OOM eviction (farthest-first).
    origins: Map<string, [number, number, number]>;
    // camera position, so eviction measures distance in world space; null offline.
    camera: Vec3 | null;
    // chunk keys evicted under memory pressure this frame; self-heal re-dirties them.
    evicted: Set<string>;
    // GPU cull input, one ChunkCullRecord per resident chunk, mirroring chunks 1:1 by index.
    cullRecordsBuffer: GpuBuffer;
    // u32 view over cullRecordsBuffer.array for bit-exact int writes.
    cullRecordsU32: Uint32Array;
    // true if translucent geometry mutated since the sort last ran, forcing a re-sort; read/cleared by updateTranslucentSortGate.
    translucentDirty: boolean;
    // translucent sort re-run gate baseline (camera pos + forward); valid=false forces the first run.
    tsortGate: { valid: boolean; camX: number; camY: number; camZ: number; fwdX: number; fwdY: number; fwdZ: number };
};

function createGpuVoxelArena(budget: VoxelArenaBudget): GpuVoxelArena {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    const tables: Record<VoxelPass, GpuSectionTable> = {
        opaque: createGpuSectionTable(budget.maxSections),
        transparent: createGpuSectionTable(budget.maxSections),
        translucent: createGpuSectionTable(budget.maxSections),
    };
    // A chunk occupies >= 1 section slot across the 3 tables, so live chunk count is bounded by the sum of table capacities.
    const maxChunks = tables.opaque.slotCount + tables.transparent.slotCount + tables.translucent.slotCount;
    const cullRecordsBuffer = new GpuBuffer(d.array(ChunkCullRecord), {
        count: maxChunks,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const recF32 = cullRecordsBuffer.array as Float32Array;
    return {
        quadArena,
        tables,
        allocs: new Map(),
        residentKeys: new Set(),
        chunks: [],
        origins: new Map(),
        camera: null,
        evicted: new Set(),
        cullRecordsBuffer,
        cullRecordsU32: new Uint32Array(recF32.buffer, recF32.byteOffset, recF32.length),
        translucentDirty: false,
        tsortGate: { valid: false, camX: 0, camY: 0, camZ: 0, fwdX: 0, fwdY: 0, fwdZ: 0 },
    };
}

// Writes the cull record for the chunk at packer.chunks[index]; records mirror that array 1:1, and signed slots (-1 = pass absent) round-trip bit-exactly through the u32 view.
function writeChunkCullRecord(packer: GpuVoxelArena, index: number, origin: [number, number, number], alloc: ChunkAlloc): void {
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

// Copies the cull record at from to to (mirrors a swap-pop in chunks).
function moveChunkCullRecord(packer: GpuVoxelArena, from: number, to: number): void {
    const u = packer.cullRecordsU32;
    const fromBase = from * CHUNK_CULL_RECORD_U32S;
    const toBase = to * CHUNK_CULL_RECORD_U32S;
    for (let i = 0; i < CHUNK_CULL_RECORD_U32S; i++) u[toBase + i] = u[fromBase + i];
    packer.cullRecordsBuffer.addUpdateRange(toBase, CHUNK_CULL_RECORD_U32S);
}

function packerFreePass(packer: GpuVoxelArena, pass: VoxelPass, a: { sectionSlot: number; dataStart: number }): void {
    arenaFree(packer.quadArena, a.dataStart);
    if (pass === 'translucent') packer.translucentDirty = true;
    sectionFreeSlot(packer.tables[pass], a.sectionSlot);
}

// Swap-pop the chunk at idx out of packer.chunks and mirror the move in the cull-record buffer; O(1).
function removeChunkAt(packer: GpuVoxelArena, idx: number): void {
    if (idx < 0) return;
    const last = packer.chunks.pop()!;
    const lastIdx = packer.chunks.length;
    if (idx < lastIdx) {
        packer.chunks[idx] = last;
        last.chunkIndex = idx;
        moveChunkCullRecord(packer, lastIdx, idx);
    }
}

function packerUpsertChunk(packer: GpuVoxelArena, key: string, origin: [number, number, number], mesh: ChunkMeshResult): void {
    const prev = packer.allocs.get(key);
    const next: ChunkAlloc = prev ?? {
        opaque: null,
        transparent: null,
        translucent: null,
        aabb: [0, 0, 0, 0, 0, 0],
        key,
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
        // free cur's prior quad range up front (re-upsert reallocates it below).
        if (cur) arenaFree(packer.quadArena, cur.dataStart);
        const dataStart = packerAllocWithEviction(packer, key, needQuads);
        // graceful degrade: arena full and nothing evictable, drop this pass.
        if (dataStart < 0) {
            if (cur) {
                sectionFreeSlot(packer.tables[pass], cur.sectionSlot);
                if (pass === 'translucent') packer.translucentDirty = true;
            }
            next[pass] = null;
            continue;
        }
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        const table = packer.tables[pass];
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, key, pass);
        if (sectionSlot < 0) {
            arenaFree(packer.quadArena, dataStart);
            next[pass] = null;
            continue;
        }

        sectionWriteEntry(table, sectionSlot, {
            originX: origin[0],
            originY: origin[1],
            originZ: origin[2],
            dataStart,
            dataCount: needQuads,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });
        // A fresh translucent mesh reallocates arena data, staling the persisted sort permutation; flag it so the gate forces a re-sort.
        if (pass === 'translucent') packer.translucentDirty = true;
        next[pass] = { sectionSlot, dataStart, dataCount: needQuads };
    }

    const empty = !next.opaque && !next.transparent && !next.translucent;
    if (empty) {
        if (prev) removeChunkAt(packer, prev.chunkIndex);
        packer.allocs.delete(key);
        packer.origins.delete(key);
        packer.residentKeys.delete(key);
    } else {
        if (!prev) {
            next.chunkIndex = packer.chunks.length;
            packer.chunks.push(next);
        }
        // (re)write the record: a re-upsert may have moved section slots.
        writeChunkCullRecord(packer, next.chunkIndex, origin, next);
        packer.allocs.set(key, next);
        packer.origins.set(key, origin);
        packer.residentKeys.add(key);
    }
}

function packerClearAll(packer: GpuVoxelArena): void {
    for (const alloc of packer.allocs.values()) {
        for (const pass of PASSES) {
            const a = alloc[pass];
            if (a) packerFreePass(packer, pass, a);
        }
    }
    packer.allocs.clear();
    packer.origins.clear();
    packer.residentKeys.clear();
    packer.chunks.length = 0;
    // Hard reset: the persisted translucent permutation is now stale, so invalidate the sort gate to force a re-sort.
    packer.translucentDirty = false;
    packer.tsortGate.valid = false;
    packer.evicted.clear();
}

function packerEvictChunk(packer: GpuVoxelArena, key: string): void {
    const cur = packer.allocs.get(key);
    if (!cur) return;
    for (const pass of PASSES) {
        const a = cur[pass];
        if (a) packerFreePass(packer, pass, a);
    }
    removeChunkAt(packer, cur.chunkIndex);
    packer.allocs.delete(key);
    packer.origins.delete(key);
    packer.residentKeys.delete(key);
}

function packerHas(packer: GpuVoxelArena, key: string): boolean {
    return packer.allocs.has(key);
}

// Picks the chunk farthest from the camera to evict (excluding the one being upserted); returns null when nothing else is resident.
function evictionVictim(packer: GpuVoxelArena, excludeKey: string): string | null {
    const cam = packer.camera;
    let bestKey: string | null = null;
    let bestDistSq = -1;
    for (const [key, origin] of packer.origins) {
        if (key === excludeKey) continue;
        const distSq = cam
            ? (origin[0] + CHUNK_SIZE * 0.5 - cam[0]) ** 2 +
              (origin[1] + CHUNK_SIZE * 0.5 - cam[1]) ** 2 +
              (origin[2] + CHUNK_SIZE * 0.5 - cam[2]) ** 2
            : Number.POSITIVE_INFINITY; // no camera (offline): evict first
        if (distSq > bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey;
}

// Queues a pressure-evicted chunk to re-mesh next frame; only forced eviction records here, not deliberate evicts.
function recordEviction(packer: GpuVoxelArena, key: string): void {
    if (packer.allocs.has(key)) packer.evicted.add(key);
}

function packerAllocWithEviction(packer: GpuVoxelArena, upsertKey: string, slots: number): number {
    for (;;) {
        try {
            return arenaAlloc(packer.quadArena, slots);
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocSlotWithEviction(packer: GpuVoxelArena, upsertKey: string, pass: VoxelPass): number {
    for (;;) {
        try {
            return sectionAllocSlot(packer.tables[pass]);
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

// Per-pass render-side resources rebuilt each frame by cullDispatches; one engine-global instance per pass.
export type PassRender = {
    // GPU emit output, one entry per visible quad; instance i of the draw reads visibleQuads[i].
    visibleQuadsBuffer: GpuBuffer;
    // single-entry indirect: vertexCount=6, instanceCount written by the emit compute's atomicAdd (reset each frame by updateCull).
    indirectBuffer: GpuBuffer;
    indirectData: Uint32Array;
};

function createPassRender(arenas: GpuVoxelArena): Record<VoxelPass, PassRender> {
    // Worst-case per-pass visible-quad cap: each quad belongs to exactly one (chunk, pass), so per-pass total visible is <= arena.slotCount.
    const visibleQuadCap = arenas.quadArena.slotCount;

    const out = {} as Record<VoxelPass, PassRender>;
    for (const pass of PASSES) {
        // Compute-written, never CPU-touched: skip MANUAL lifecycle so gpucat auto-allocates on first use.
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
    arenas: GpuVoxelArena,
    passRender: Record<VoxelPass, PassRender>,
    lightVolume: LightVolume,
): Record<VoxelPass, Geometry> {
    const out = {} as Record<VoxelPass, Geometry>;
    for (const pass of PASSES) {
        const g = new Geometry();
        // shared quadArena bound by name, same buffers across all 3 passes.
        g.setBuffer('quads', arenas.quadArena.buffers.quads);
        // engine-global visible-quad table; VS reads visibleQuads[instanceIndex] to get (slot, localIdx).
        g.setBuffer('visibleQuads', passRender[pass].visibleQuadsBuffer);
        // ChunkInfo per-slot {origin, arenaBase}; VS uses chunkInfo[slot] to resolve worldspace origin + arena base.
        g.setBuffer('chunkInfo', arenas.tables[pass].buffer);
        // per-chunk light tiles + residency grid, sampled per corner in the VS.
        routeLightVolumeBuffers(g, lightVolume);
        g.indirect = passRender[pass].indirectBuffer;
        out[pass] = g;
    }
    return out;
}

// WebGPU voxel resource handle: atlas, arena, mesher, per-pass geometries/materials, plus this backend's GPU compute frame; flat and standalone, no shared base with the WebGL handle.
export type VoxelResources = {
    textures: VoxelTextures;
    // unified per-pass quad materials, bound on each per-room Mesh alongside geometries.
    quadMaterials: Record<VoxelPass, Material>;
    // engine-global per-pass geometry (WebGPU binds indirect + visibleQuads).
    geometries: Record<VoxelPass, Geometry>;
    // this backend's owned arena: quadArena + per-pass GPU section tables + residency/eviction packer.
    arenas: GpuVoxelArena;
    // off-thread mesh worker pool; null on asset-pipeline paths (workerCount=0).
    meshDispatcher: Mesher | null;
    // GPU-resident per-chunk light tiles + residency grid; light is the root residency fact, released only when the chunk is gone from voxels.chunks, not when the mesh is evicted.
    lightVolume: LightVolume;

    // GPU cull compute: dispatched once per frame over cullRecordsBuffer, compacts visible chunks into visibleChunks, produces the emit dispatch args.
    cull: ComputeNode;
    // GPU emit compute: dispatched per pass (indirect, [visibleChunkCount,7,1]); back-face-culls facings and writes visibleQuads.
    emit: ComputeNode;
    // prefix-sums opaque/transparent buckets into base + draw counts; does not touch the translucent draw, owned by tsortPrep.
    finalize: ComputeNode;
    // translucent global stable-radix sort chain: expand, prep, count0, then 4x(scan,scatter); the last scatter gathers the payload.
    tsortExpand: ComputeNode;
    tsortPrep: ComputeNode;
    radixCount: ComputeNode;
    radixScan: ComputeNode;
    radixScatter: ComputeNode;
    radixScatterLast: ComputeNode;
    // flat per-quad (key, original-index) ping-pong pairs for the radix passes, plus the payload buffer the last scatter gathers from; sized to the worst case (quadArena.slotCount).
    sortKeys: GpuBuffer;
    sortKeysAlt: GpuBuffer;
    sortIdx: GpuBuffer;
    sortIdxAlt: GpuBuffer;
    sortPayload: GpuBuffer;
    // digit-major radix histogram tables [digit*maxBlocks+block]; ping-pong, scan consumes one into bases while zeroing the other for the next fused count.
    radixHist: GpuBuffer;
    radixHistAlt: GpuBuffer;
    // per-pass digit shift [0]/[8]/[16]/[24], bound per dispatch.
    radixPassConfig: GpuBuffer[];
    // atomic append counter (N visible translucent quads); self-reset by prep.
    sortCount: GpuBuffer;
    // radix indirect dispatch args [numBlocks,1,1,N,prevNumBlocks,zeroTo], written by prep.
    sortIndirectArgs: GpuBuffer;
    // set by updateCull each frame; read by cullDispatches to decide whether to enqueue the sort chain.
    runTranslucentSort: boolean;
    // per-bucket quad tallies [pass*BUCKET_COUNT+b] (atomic); CPU-zeroed each frame, written by cull's fused count, read by finalize.
    bucketQuads: GpuBuffer;
    bucketQuadsData: Uint32Array;
    // exclusive prefix (instance base) per bucket; written by finalize.
    bucketBase: GpuBuffer;
    // running within-bucket offset (atomic); reset by finalize, bumped by emit.
    bucketCursor: GpuBuffer;
    // per-frame camera view for the cull compute (5 pre-shifted planes + camera chunk/frac); CPU-written each frame.
    cullView: GpuBuffer;
    cullViewData: Float32Array;
    // cull output: compacted visible chunks (GPU-written, emit-read).
    visibleChunks: GpuBuffer;
    // emit dispatch args [visibleChunkCount,7,1] (indirect); cull's atomic append counter lives in element 0, CPU-reset each frame.
    emitArgs: GpuBuffer;
    emitArgsData: Uint32Array;
    // per-pass static emit config [passIndex, backFaceCull].
    emitConfig: Record<VoxelPass, GpuBuffer>;
    // per-frame cull/expand scratch + indirect buffers (visibleQuads + DrawIndirect per pass), bound by name in geometries above.
    passRender: Record<VoxelPass, PassRender>;
    // resolves once the cull/emit/finalize/sort pipelines finish compiling; anything dispatching voxel computes off the main render loop must await this first.
    computeReady: Promise<void>;
    // @internal, settled once the compute pipelines compile.
    _resolveComputeReady: () => void;
};

export function init(registry: Blocks, env: EnvironmentResources, budget: VoxelArenaBudget, time: TimeResources): VoxelResources {
    console.log(`[voxel-resources] init, ${registry.textures.length} textures, ${registry.totalStates} states`);

    const textures = createVoxelTextures(registry);

    const { promise: computeReady, resolve: _resolveComputeReady } = Promise.withResolvers<void>();

    const elapsedTime = time.elapsedTime;
    const quadMaterials: Record<VoxelPass, Material> = {
        opaque: createGpuQuadMaterial({ textures, pass: 'opaque', elapsedTime, env }),
        transparent: createGpuQuadMaterial({ textures, pass: 'transparent', elapsedTime, env }),
        translucent: createGpuQuadMaterial({ textures, pass: 'translucent', elapsedTime, env }),
    };

    // Arenas first: the radix kernels bake the histogram row stride (maxBlocks, derived from arena slot capacity) into their compiled graphs.
    const arenas = createGpuVoxelArena(budget);
    const passRender = createPassRender(arenas);
    // built before the geometries: they bind its buffers by name.
    const lightVolume = createLightVolume(budget.lightGridChunkRadius, budget.maxLightTiles);
    env.lightVolumeConfig.value = lightVolumeConfigOf(lightVolume);
    const geometries = createGeometries(arenas, passRender, lightVolume);
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

    // GPU-cull scratch; visibleChunks is bounded by resident chunk count, itself bounded by the sum of the 3 section tables' capacities.
    const maxChunks = budget.maxSections * 3;
    const cullViewData = new Float32Array(CULL_VIEW_STRIDE / 4);
    const cullView = new GpuBuffer(d.array(CullView), {
        data: cullViewData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const visibleChunks = new GpuBuffer(d.array(VisibleChunk), { count: maxChunks, usage: 'storage' });
    // indirect emit dispatch args; element 0 is the cull's atomic append counter (reset each frame), [_,7,1] = the 7 facings.
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

    // Bucket scratch: 3 passes x BUCKET_COUNT (translucent slice unused since it sorts globally); bucketQuads is CPU-zeroed each frame, base/cursor are GPU-managed by finalize.
    const bucketCount3 = 3 * BUCKET_COUNT;
    const bucketQuadsData = new Uint32Array(bucketCount3);
    const bucketQuads = new GpuBuffer(d.array(d.atomic(d.u32)), {
        data: bucketQuadsData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const bucketBase = new GpuBuffer(d.array(d.u32), { data: new Uint32Array(bucketCount3), usage: 'storage' });
    const bucketCursor = new GpuBuffer(d.array(d.atomic(d.u32)), { data: new Uint32Array(bucketCount3), usage: 'storage' });

    // Radix scratch: (key,idx) ping-pong pairs + payload buffer, sized to the worst case (quadArena.slotCount); flat buffers indexed by global sort position, not part of the arena. Histograms self-zero: count0 zeroes its columns, scans zero the other buffer up to zeroTo.
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
    // indirect args [numBlocks,1,1,N,prevNumBlocks,zeroTo]; prep writes them, radix kernels dispatch from + bind as storage (gpucat gives indirect buffers INDIRECT|STORAGE).
    const sortIndirectArgs = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array([0, 1, 1, 0, 0, 0]),
        usage: 'indirect',
        lifecycle: BufferLifecycle.MANUAL,
    });

    return {
        lightVolume,
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
        textures,
        computeReady,
        _resolveComputeReady,
        meshDispatcher: null,
    };
}

// Async side of construction: fetches the atlas, kicks off its pixel upload, compiles the compute pipelines, and spawns the mesh worker pool; mutates res in place.
export async function load(
    res: VoxelResources,
    registry: Blocks,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    renderer?: WebGPURenderer,
    meta?: TileAtlasMetadata | null,
): Promise<void> {
    // On the asset pipeline (decodeImage present) the atlas decode is native libvips work that segfaults if it overlaps a Dawn pipeline compile, so await the atlas first there; on the client the two run concurrently.
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

    await loadVoxelTextures(res.textures, registry, resources.loader, meta, serializeAtlasBeforeCompute);

    // Now safe to compile, the atlas decode has finished.
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
        // loadMeshWorker() dynamic-imports the worker bundle; runtimes that never spawn workers (guarded by typeof Worker) never resolve that import and fall through to inline meshing.
        await loadMeshWorker();
        const meshDispatcher = createMesher({ workerCount, queueDepth: workerQueueDepth });
        setMeshRegistry(meshDispatcher, registry);
        res.meshDispatcher = meshDispatcher;
    }

    await computeReady;
    res._resolveComputeReady();
}

// Build new resources, or reuse prev if the atlas + animation metadata are unchanged.
export async function refresh(
    prev: VoxelResources | null,
    registry: Blocks,
    env: EnvironmentResources,
    budget: VoxelArenaBudget,
    time: TimeResources,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    renderer?: WebGPURenderer,
): Promise<{ resources: VoxelResources; changed: boolean }> {
    const meta = await loadAtlasMeta(resources.loader);
    if (
        prev &&
        meta !== null &&
        prev.textures.hash !== null &&
        meta.hash === prev.textures.hash &&
        f32Equal(prev.textures.texAnimData, registry.texAnimData)
    ) {
        // Atlas + texAnim unchanged, so reuse; push the new registry to the workers since BlockRegistry may have been rebuilt (in-flight jobs finish with the old one and get gen-dropped by callers).
        if (prev.meshDispatcher) setMeshRegistry(prev.meshDispatcher, registry);
        return { resources: prev, changed: false };
    }
    // Build and load the replacement before disposing prev: the caller keeps rendering prev across load's async gap, and prev/built coexist transiently in VRAM for a safe swap.
    const built = init(registry, env, budget, time);
    await load(built, registry, workerCount, workerQueueDepth, resources, renderer, meta);
    if (prev) dispose(prev);
    return { resources: built, changed: true };
}

function f32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function dispose(state: VoxelResources): void {
    state.textures.atlas.dispose();
    state.textures.entriesBuffer.dispose();
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
    for (const pass of PASSES) sectionDispose(state.arenas.tables[pass]);
    state.arenas.cullRecordsBuffer.dispose();
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
    if (state.meshDispatcher) disposeMesher(state.meshDispatcher);
}

// These drive the engine-global compute resources above each frame; the active room calls updateCull then cullDispatches each frame.

const _cullFrustum = frustum.create();

// Writes the per-frame camera view into cullView and resets the GPU cull/emit counters; must run before cullDispatches, which does the actual GPU work.
export function updateCull(voxelResources: VoxelResources, camera: Camera, viewChunkRadius: number): void {
    // buildCullView fills the shared plane/camMeta/camFrac math; the live record count (data[23]) is WebGPU-specific, so we write it here.
    const data = voxelResources.cullViewData;
    buildCullView(data, camera, viewChunkRadius);
    data[23] = voxelResources.arenas.chunks.length;
    voxelResources.cullView.addUpdateRange(0, data.length);
    voxelResources.cullView.needsUpdate = true;

    // reset the cull append counter (emitArgs[0]); [1]=7, [2]=1 stay.
    voxelResources.emitArgsData[0] = 0;
    voxelResources.emitArgs.addUpdateRange(0, voxelResources.emitArgsData.length);
    voxelResources.emitArgs.needsUpdate = true;

    // Zero the per-bucket quad tallies for this frame's count pass by re-uploading the all-zero CPU mirror.
    voxelResources.bucketQuads.addUpdateRange(0, voxelResources.bucketQuadsData.length);
    voxelResources.bucketQuads.needsUpdate = true;

    // Empty arena: cullDispatches returns no dispatches, so zero the per-pass draw instanceCounts on the CPU or stale quads from the previous room would keep drawing.
    if (voxelResources.arenas.chunks.length === 0) {
        for (const pass of PASSES) {
            const pr = voxelResources.passRender[pass];
            pr.indirectData[1] = 0; // DrawIndirect: [vertexCount, instanceCount, ...]
            pr.indirectBuffer.needsUpdate = true;
        }
    }

    // Translucent sort gate re-runs on translation, rotation, arena mutation, or first-run (see updateTranslucentSortGate); otherwise last frame's permutation and draw count stand.
    frustum.setFromViewProjectionMatrix(
        _cullFrustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
        camera.coordinateSystem,
    );
    updateTranslucentSortGate(
        voxelResources,
        camera.position[0],
        camera.position[1],
        camera.position[2],
        _cullFrustum[4]!.normal,
    );
}

// Distance the camera must move before the sort re-runs; tight since a small translation can reorder near geometry and the sort is cheap.
const TSORT_MOVE_TRIGGER_SQ = 0.1 * 0.1; // 0.1 block
// Re-run once camera forward turns past this cosine; the visible set shifts on rotation.
const TSORT_ROTATE_TRIGGER_COS = 0.9998; // ~1.1 degrees

// Decides whether the translucent radix sort re-runs this frame and refreshes the gate baseline when it does; sets runTranslucentSort for cullDispatches.
function updateTranslucentSortGate(voxelResources: VoxelResources, camX: number, camY: number, camZ: number, fwd: Vec3): void {
    const packer = voxelResources.arenas;
    const gate = packer.tsortGate;
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

// GPU cull -> finalize -> emit (opaque/transparent) -> translucent radix sort (gated) dispatch chain; push into the renderer's dispatch list before renderer.compute(); empty when no chunks are resident.
export function cullDispatches(voxelResources: VoxelResources): ComputeDispatch[] {
    const packer = voxelResources.arenas;
    const recordCount = packer.chunks.length;
    const out: ComputeDispatch[] = [];
    // Empty arena: skip the whole chain (a dispatch would be zero-workgroup no-ops Dawn warns about); updateCull already zeroed the draw instanceCounts.
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

    // Translucent radix sort (gated): reads this frame's visibleChunks, chain is expand, prep, count0, then 4x(scan,scatter); the last scatter gathers sortPayload[idx] straight into visibleQuads.
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

// Upserts a mesh result into this backend's arena, or evicts if the chunk is all-air / has no geometry.
export function upsertChunk(res: VoxelResources, key: string, chunk: Chunk, mesh: ChunkMeshResult | null): void {
    const packer = res.arenas;
    if (mesh === null || chunk.nonAirCount === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

// Removes a chunk from this backend's arena and releases its light tile with it, so the light pool stays bounded by the mesh budget.
export function removeChunk(res: VoxelResources, key: string): void {
    const packer = res.arenas;
    if (packerHas(packer, key)) packerEvictChunk(packer, key);
    evictChunkLightByKey(res.lightVolume, key);
}

// Synchronously meshes a chunk (unless all-air or fully occluded) and places it in this backend's arena; the main-thread path used by offline icon bakers. Returns null when skipped/evicted.
export function remeshChunkInto(
    res: VoxelResources,
    voxels: Voxels,
    registry: Blocks,
    chunk: Chunk,
    meshOutput: MeshOutput,
): ChunkMeshResult | null {
    const mesh =
        chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)
            ? null
            : meshChunk(meshOutput, buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
    upsertChunk(res, chunkKey(chunk.cx, chunk.cy, chunk.cz), chunk, mesh);
    return mesh;
}

// Drains the mesher's staged results into this backend's arena, reconciles residency (evicts toForget/server-dropped/gone keys), and self-heals pressure-evictions; runs each frame before the GPU frame graph reads the arena.
export function consume(res: VoxelResources, mesher: Mesher, voxels: Voxels, cameraPos: Vec3, toForget: string[]): void {
    const packer = res.arenas;
    packer.camera = cameraPos;

    // Drain worker results from last frame; drop stale-gen ones (the chunk mutated since dispatch and is back in dirty.blocks for a fresh mesh).
    if (mesher.results.length > 0) {
        const results = mesher.results;
        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            const chunk = voxels.chunks.get(result.chunkKey);
            if (!chunk) continue;
            if (chunk.meshGen !== result.gen) continue;
            upsertChunk(res, result.chunkKey, chunk, result);
        }
        results.length = 0;
    }

    // evict meshes for chunks the server dropped (voxel_region_del queued their keys).
    if (voxels.dirty.removed.size > 0) {
        for (const key of voxels.dirty.removed) {
            removeChunk(res, key);
            evictChunkLightByKey(res.lightVolume, key);
        }
        voxels.dirty.removed.clear();
    }

    // evict the empty / fully-occluded chunks the AOI forgot this frame.
    for (let i = 0; i < toForget.length; i++) removeChunk(res, toForget[i]!);

    // evict any arena-held chunk the server has dropped from voxels.chunks.
    for (const key of packer.residentKeys) {
        if (!voxels.chunks.has(key)) {
            packerEvictChunk(packer, key);
            evictChunkLightByKey(res.lightVolume, key);
        }
    }

    // self-heal: re-dirty any chunk lost to memory pressure so it re-meshes.
    if (packer.evicted.size > 0) {
        for (const key of packer.evicted) {
            const chunk = voxels.chunks.get(key);
            if (chunk) markChunkDirty(voxels, chunk);
        }
        packer.evicted.clear();
    }
}

// Clears the active world from this backend's arena and mesh worker cache; voxel data survives in voxels.chunks so a later mountRoom simply remeshes it.
export function unmountRoom(res: VoxelResources, mesher: Mesher | null): void {
    packerClearAll(res.arenas);
    // the mesh worker holds one world at a time; drop its cache + queued results.
    if (mesher !== null) resetMeshCaches(mesher);
}
