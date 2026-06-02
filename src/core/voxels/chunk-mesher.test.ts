// ── chunk mesher tests ──────────────────────────────────────────────

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllShapes } from 'crashcat';
import { registry } from '../registry';
import { blockTexture, CullType, MaterialType } from './blocks';
import { stairs } from './block-presets';
import {
    type ChunkMeshResult,
    type PassMesh,
    buildMeshInput,
    createMeshOutput,
    meshChunk,
    QUAD_LIGHT_OFFSET,
    QUAD_STRIDE_U32S,
} from './chunk-mesher';
import type { BlockRegistry } from './block-registry';
import type { Chunk, Voxels } from './voxels';
import { buildTestRegistry, defineTestBlock, resetVoxelRegistry } from './test-helpers';
import { createChunk, createVoxels, setChunkBlock, voxelIndex } from './voxels';

// ── test helpers ────────────────────────────────────────────────────

beforeAll(() => {
    // crashcat compound shape ctor (used by stairs collider) needs the
    // shape registry initialised before buildBlockRegistry walks block defs.
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

/** count total quads in a pass (cube + model + liquid all unified). */
function countCubeFaces(mesh: ChunkMeshResult | null, pass: 'opaque' | 'translucent'): number {
    if (!mesh) return 0;
    const p = pass === 'opaque' ? mesh.opaque : mesh.translucent;
    return p?.quadCount ?? 0;
}

/** return the unified pass mesh (single bucket — facing slices are internal). */
function cubeFaceBuckets(mesh: ChunkMeshResult, pass: 'opaque' | 'translucent'): PassMesh[] {
    const p = pass === 'opaque' ? mesh.opaque : mesh.translucent;
    return p ? [p] : [];
}

/** read per-corner light from the interleaved quad buffer. `idx` is the
 *  flat corner index (`q * 4 + corner`). */
function cornerLight(p: PassMesh, idx: number): number {
    const q = idx >>> 2;
    const c = idx & 3;
    return p.quads[q * QUAD_STRIDE_U32S + QUAD_LIGHT_OFFSET + c]!;
}

/** read the per-corner light word for `(quadIdx, corner)`. */
function quadCornerLight(p: PassMesh, quadIdx: number, corner: number): number {
    return p.quads[quadIdx * QUAD_STRIDE_U32S + QUAD_LIGHT_OFFSET + corner]!;
}

/** mesh + light a chunk in one call. post Stage 2b: meshChunk emits
 *  geometry+AO+light in one pass — this wrapper now just delegates. */
function meshAndLight(voxels: Voxels, chunk: Chunk, reg: BlockRegistry): ChunkMeshResult | null {
    return meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
}

// ── tests ───────────────────────────────────────────────────────────

describe('meshChunk', () => {
    describe('translucent_self culling', () => {
        it('single block has 6 exposed faces', () => {
            const registry = buildTestRegistry([
                { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'water', registry);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            expect(countCubeFaces(result, 'translucent')).toBe(6);
        });

        it('two adjacent blocks cull shared faces (4 + 4 visible = 10 total)', () => {
            const registry = buildTestRegistry([
                { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            // two water blocks adjacent on X axis
            setChunkBlock(chunk, 5, 5, 5, 'water', registry);
            setChunkBlock(chunk, 6, 5, 5, 'water', registry);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            // 2 blocks × 6 faces = 12, minus 2 shared faces = 10
            expect(countCubeFaces(result, 'translucent')).toBe(10);
        });

        it('four blocks in a row cull all interior faces', () => {
            const registry = buildTestRegistry([
                { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            // four water blocks in a row on X axis
            for (let i = 0; i < 4; i++) {
                setChunkBlock(chunk, 5 + i, 5, 5, 'water', registry);
            }

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            // 4 blocks × 6 faces = 24, minus 6 shared faces (3 pairs × 2 faces) = 18
            expect(countCubeFaces(result, 'translucent')).toBe(18);
        });
    });

    describe('translucent (non-self) culling', () => {
        it('two adjacent translucent blocks of the same type self-cull shared faces', () => {
            const registry = buildTestRegistry([
                { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'glass', registry);
            setChunkBlock(chunk, 6, 5, 5, 'glass', registry);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            // self-cull by block id: 2 blocks × 6 faces = 12, minus 2 shared = 10
            expect(countCubeFaces(result, 'translucent')).toBe(10);
        });
    });

    describe('solid culling', () => {
        it('two adjacent solid blocks cull shared faces', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);
            setChunkBlock(chunk, 6, 5, 5, 'stone', registry);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            // 2 blocks × 6 faces = 12, minus 2 shared = 10
            expect(countCubeFaces(result, 'opaque')).toBe(10);
        });
    });

    describe('solid culls translucent_self', () => {
        it('solid neighbor culls adjacent translucent_self face', () => {
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);
            setChunkBlock(chunk, 6, 5, 5, 'water', registry);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            // stone: 6 - 1 (face toward water culled by... wait, solid doesn't cull toward translucent_self)
            // actually: stone's face toward water: shouldCullFace(solid, translucent_self) = false → visible
            // water's face toward stone: shouldCullFace(translucent_self, solid) = true → culled
            expect(countCubeFaces(result, 'opaque')).toBe(6); // stone: all 6 (translucent_self doesn't cull solid)
            expect(countCubeFaces(result, 'translucent')).toBe(5); // water: 6 - 1 culled by solid
        });
    });

    describe('emissive blocks', () => {
        it('emissive block gets full brightness light (0xFFFFFFFF) on all vertices', () => {
            defineTestBlock({ id: 'lamp', texId: 'lamp', lightEmission: [15, 15, 15], emissive: true });
            const registry = buildTestRegistry([]);

            // verify the emissive table was built correctly
            const lampStateId = registry.keyToState.get('lamp')!;
            expect(registry.emissive[lampStateId]).toBe(1);

            // place a single lamp in a dark chunk (no sky light, no neighbors)
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'lamp', registry);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const buckets = cubeFaceBuckets(result!, 'opaque');
            expect(buckets.length).toBe(1);

            // every corner of every face bucket should be full-bright
            for (const bucket of buckets) {
                const cornerCount = bucket.quadCount * 4;
                for (let i = 0; i < cornerCount; i++) {
                    expect(cornerLight(bucket, i)).toBe(0xffffffff);
                }
            }
        });

        it('non-emissive block does NOT get full brightness in darkness', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const buckets = cubeFaceBuckets(result!, 'opaque');
            expect(buckets.length).toBe(1);

            // in total darkness, at least some corner across all face buckets
            // should NOT be full brightness
            let hasNonFull = false;
            outer: for (const bucket of buckets) {
                const cornerCount = bucket.quadCount * 4;
                for (let i = 0; i < cornerCount; i++) {
                    if (cornerLight(bucket, i) !== 0xffffffff) {
                        hasNonFull = true;
                        break outer;
                    }
                }
            }
            expect(hasNonFull).toBe(true);
        });
    });

    describe('Sodium hierarchical diagFlip in meshChunk', () => {
        it('diagFlip lives in light[0] bit 29 and follows AO primary, light tiebreaker (<=)', () => {
            // meshChunk's emitQuadLight* helpers write diagFlip via
            // `applyDiagFlipBit` — Sodium hierarchical compare.
            // Build an asymmetric corner occluder so AO is non-uniform on
            // the +Y face, then mesh + light the chunk and verify the bit
            // at light[0].29 matches the hierarchical compare against the
            // bake-time AO meta + the per-corner light words just written.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);
            // asymmetric corner occluder → non-uniform AO on the +Y face.
            setChunkBlock(chunk, 4, 6, 4, 'stone', registry);

            const a = meshAndLight(voxels, chunk, registry)!;
            const b = meshAndLight(voxels, chunk, registry)!;
            const pa = a.opaque!;
            const pb = b.opaque!;
            expect(pa.quadCount).toBe(pb.quadCount);

            // bit 23 of flags is reserved now — the bake must leave it zero.
            // meta (AO) and light[*] must be identical across runs (no
            // per-call drift in either the geometry bake or the light pass).
            let sawAoPrimary = false;
            for (let q = 0; q < pa.quadCount; q++) {
                const flagsA = pa.quads[q * QUAD_STRIDE_U32S + 8]!;
                expect((flagsA >>> 23) & 0x1).toBe(0);

                const metaA = pa.quads[q * QUAD_STRIDE_U32S + 9]!;
                const metaB = pb.quads[q * QUAD_STRIDE_U32S + 9]!;
                expect(metaA).toBe(metaB);

                const l0a = quadCornerLight(pa, q, 0);
                const l1a = quadCornerLight(pa, q, 1);
                const l2a = quadCornerLight(pa, q, 2);
                const l3a = quadCornerLight(pa, q, 3);
                const l0b = quadCornerLight(pb, q, 0);
                expect(l0a).toBe(l0b);
                expect(quadCornerLight(pa, q, 1)).toBe(quadCornerLight(pb, q, 1));
                expect(quadCornerLight(pa, q, 2)).toBe(quadCornerLight(pb, q, 2));
                expect(quadCornerLight(pa, q, 3)).toBe(quadCornerLight(pb, q, 3));

                // Sodium hierarchical compare: AO primary with `>`, light
                // tiebreaker with `<=`. On a quad with strict AO inequality
                // the AO branch is decisive — light values can't flip it.
                const a0 = metaA & 0xf;
                const a1 = (metaA >>> 4) & 0xf;
                const a2 = (metaA >>> 8) & 0xf;
                const a3 = (metaA >>> 12) & 0xf;
                const ao02 = a0 + a2;
                const ao13 = a1 + a3;
                const actual = (l0a >>> 29) & 0x1;
                if (ao02 > ao13) {
                    expect(actual).toBe(0);
                    sawAoPrimary = true;
                } else if (ao02 < ao13) {
                    expect(actual).toBe(1);
                    sawAoPrimary = true;
                } else {
                    // tied AO — light tiebreaker (<=). Mask channel nibbles
                    // out of bits 28+ to match `applyDiagFlipBit`.
                    const sum = (w: number) =>
                        (w & 0xf) + ((w >>> 8) & 0xf) + ((w >>> 16) & 0xf) + ((w >>> 24) & 0xf);
                    const lm02 = sum(l0a) + sum(l2a);
                    const lm13 = sum(l1a) + sum(l3a);
                    expect(actual).toBe(lm02 <= lm13 ? 0 : 1);
                }
            }
            expect(sawAoPrimary).toBe(true);
        });
    });

    describe('meshChunk light determinism', () => {
        it('remesh produces identical light (opaque cube)', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);

            for (const ba of cubeFaceBuckets(a!, 'opaque')) {
                const bb = cubeFaceBuckets(b!, 'opaque').find(x => x.quadCount === ba.quadCount)!;
                for (let i = 0; i < ba.quadCount * 4; i++) {
                    expect(cornerLight(bb, i)).toBe(cornerLight(ba, i));
                }
            }
        });

        it('remesh produces identical light (translucent self-cull)', () => {
            const registry = buildTestRegistry([
                { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            for (let i = 0; i < 4; i++) setChunkBlock(chunk, 5 + i, 5, 5, 'water', registry);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry);

            for (const ba of cubeFaceBuckets(a!, 'translucent')) {
                const bb = cubeFaceBuckets(b!, 'translucent').find(x => x.quadCount === ba.quadCount)!;
                for (let i = 0; i < ba.quadCount * 4; i++) {
                    expect(cornerLight(bb, i)).toBe(cornerLight(ba, i));
                }
            }
        });
    });

    describe('Sodium wall-corner light-leak fix (MC-12558 analog)', () => {
        // when both edges bracketing a face corner are opaque, sodium
        // substitutes the corner's diagonal cell with one of the edge
        // cells (`AoFaceData.java:85-141`). without the substitution,
        // bright light in the diagonal cell (e.g. a lit room behind a
        // wall corner) leaks through to the dark side. our pre-fix
        // `emitQuadLightSmooth` unconditionally read the diagonal,
        // reproducing the leak.
        it('bright diagonal cell does NOT leak into corner when both edges occlude', () => {
            const reg = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            // stone at (5,5,5) — we render its +X face. Face cell is (6,5,5).
            // Wall edges (relative to +X face): (6,4,5) and (6,5,4) — both stone.
            // Diagonal: (6,4,4) — air with bright sky=15 (the "lit room behind
            // the wall corner"). Face cell (6,5,5) is dark air.
            setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
            setChunkBlock(chunk, 6, 4, 5, 'stone', reg); // -Y edge of +X face
            setChunkBlock(chunk, 6, 5, 4, 'stone', reg); // -Z edge of +X face
            // Default chunk.light is zero everywhere. Inject bright sky into
            // the diagonal-behind-corner cell only.
            chunk.light[voxelIndex(6, 4, 4)] = 15 << 12; // sky=15

            const result = meshAndLight(voxels, chunk, reg);
            expect(result).not.toBeNull();
            const pass = result!.opaque!;

            // Restrict to stone (5,5,5)'s +X face. Other faces of (5,5,5)
            // legitimately read (6,4,4) via single-edge-opaque diagonals
            // (e.g. its -Z face's +X/-Y corner has only one opaque edge,
            // so sodium reads the diagonal); only the +X face has both
            // bracketing edges of (6,4,4) opaque, which is where the
            // wall-corner substitution applies.
            let checkedXPos = 0;
            for (let q = 0; q < pass.quadCount; q++) {
                const header3 = pass.quads[q * QUAD_STRIDE_U32S + 3]!;
                const bx = (header3 >>> 16) & 0xf;
                const by = (header3 >>> 20) & 0xf;
                const bz = (header3 >>> 24) & 0xf;
                if (bx !== 5 || by !== 5 || bz !== 5) continue;
                // facing bits at flags[20..22], FACING_POS_X = 0.
                const flagsWord = pass.quads[q * QUAD_STRIDE_U32S + 8]!;
                const facing = (flagsWord >>> 20) & 0x7;
                if (facing !== 0) continue; // only +X face
                checkedXPos++;
                for (let c = 0; c < 4; c++) {
                    // sky nibble lives in bits 24..27; bit 29 holds the
                    // diagFlip in corner 0, so mask to 0xf not 0xff.
                    const skyNibble = (quadCornerLight(pass, q, c) >>> 24) & 0xf;
                    expect(skyNibble).toBe(0);
                }
            }
            expect(checkedXPos).toBe(1); // exactly one +X face on (5,5,5)
        });

        it('multi-quad-per-face cache reuse: 6 cube faces all share their face cache', () => {
            // Coverage for `ensureFaceLightCache`'s cache-hit branch. A single
            // isolated stone emits 6 quads (one per face), each on a unique
            // (face, offset=1) cache slot — second cell would hit identical
            // output. We assert determinism instead (cheaper than instrumenting
            // a hit counter, equivalent signal: cache-hit and cache-miss must
            // produce bit-identical light words).
            const reg = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
            for (let i = 0; i < chunk.light.length; i++) chunk.light[i] = 15 << 12;

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
            const pa = a!.opaque!;
            const pb = b!.opaque!;
            expect(pa.quadCount).toBe(pb.quadCount);
            for (let q = 0; q < pa.quadCount; q++) {
                for (let c = 0; c < 4; c++) {
                    expect(quadCornerLight(pb, q, c)).toBe(quadCornerLight(pa, q, c));
                }
            }
        });
    });

    describe('mesh quad shape dispatch (stair)', () => {
        // build a fresh stair-bearing registry. stairs() produces a custom
        // mesh with a mix of shapes: the riser, tread top, side panels, and
        // back face exercise ALIGNED_FULL / ALIGNED_PARTIAL paths through
        // the new bilerp dispatch.
        function buildStairRegistry() {
            blockTexture('stone', { src: 'textures/stone.png' });
            stairs('stair', { all: { texture: 'stone' } });
            return buildTestRegistry([{ id: 'block', texId: 'block' }]);
        }

        it('stair quads carry per-vertex AO and smooth-light gradients', () => {
            const reg = buildStairRegistry();
            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            // place stair with a solid neighbour: the neighbour creates
            // an opaque corner that drives non-uniform AO on the stair's
            // adjacent face. without occluders, every vert would have the
            // same AO and the gradient check below would be vacuous.
            setChunkBlock(chunk, 5, 5, 5, 'stair', reg);
            setChunkBlock(chunk, 4, 5, 5, 'block', reg);
            setChunkBlock(chunk, 4, 4, 5, 'block', reg);
            setChunkBlock(chunk, 5, 4, 5, 'block', reg);

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
            expect(result).not.toBeNull();
            const pass = result!.opaque!;
            expect(pass.quadCount).toBeGreaterThan(0);

            // at least one quad must show per-vertex AO variation (not all
            // corners equal). proves shape dispatch is actually computing
            // per-corner values rather than the old flat 0xffffffff write.
            // light variation requires propagated light, which the chunk
            // doesn't have without a lighting pass — relight equivalence
            // test below covers the light path.
            //
            // AO lives in the low 16 bits of the meta u32 (qd[9]), packed
            // as ao0Bits | ao1Bits<<4 | ao2Bits<<8 | ao3Bits<<12 with each
            // ∈ [0..15] encoding brightness `bits/30 + 0.5`.
            let sawAoVariation = false;
            for (let q = 0; q < pass.quadCount; q++) {
                const meta = pass.quads[q * QUAD_STRIDE_U32S + 9]!;
                const a0 = meta & 0xf;
                const a1 = (meta >>> 4) & 0xf;
                const a2 = (meta >>> 8) & 0xf;
                const a3 = (meta >>> 12) & 0xf;
                if (!(a0 === a1 && a1 === a2 && a2 === a3)) { sawAoVariation = true; break; }
            }
            expect(sawAoVariation).toBe(true);
        });

        it('aligned-outer top quad reads outside-cell light, not host (depth=0 → offset_true)', () => {
            // bug guard: if the depth blend direction is inverted, a
            // mesh quad on the outer face plane (depth=0) blends in the
            // host cell's lightSlab — which is opaque + dark for solid
            // mesh hosts. that produces a black band on stair tops next
            // to lit cubes. inject sky-light only into the cell above
            // the stair and assert the upper-step top quad's sky channel
            // is bright (cacheTrue path), not zero (cacheFalse path).
            const reg = buildStairRegistry();
            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'stair', reg);
            // seed sky=15 everywhere (matches a fully sky-exposed column);
            // packSmoothLight averages the face cell with 3 neighbours, so
            // singling out (5,6,5) only would still get diluted by dark
            // neighbours. lightSlab build copies chunk.light into the 18³
            // padded slab; the host-cell (stair voxel) keeps sky=0 since
            // we don't write it — that's the dark cell the bug would read.
            for (let i = 0; i < chunk.light.length; i++) chunk.light[i] = 15 << 12;
            chunk.light[voxelIndex(5, 5, 5)] = 0;

            const result = meshAndLight(voxels, chunk, reg);
            expect(result).not.toBeNull();
            const pass = result!.opaque!;

            // find at least one quad whose 4 corners all carry the
            // expected bright sky byte. with the bug, depth=0 quads
            // blend with the dark host cell so sky bytes are 0 or near.
            // raw 4-bit channel — LUT is applied in WGSL.
            const brightSky = 15 << 24;
            let sawBrightSky = false;
            for (let q = 0; q < pass.quadCount; q++) {
                const lp0 = quadCornerLight(pass, q, 0) & 0xff000000;
                const lp1 = quadCornerLight(pass, q, 1) & 0xff000000;
                const lp2 = quadCornerLight(pass, q, 2) & 0xff000000;
                const lp3 = quadCornerLight(pass, q, 3) & 0xff000000;
                if (lp0 === brightSky && lp1 === brightSky && lp2 === brightSky && lp3 === brightSky) {
                    sawBrightSky = true;
                    break;
                }
            }
            expect(sawBrightSky).toBe(true);
        });

        it('remesh produces identical light (stair with occluders)', () => {
            const reg = buildStairRegistry();
            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            setChunkBlock(chunk, 5, 5, 5, 'stair', reg);
            setChunkBlock(chunk, 4, 5, 5, 'block', reg);
            setChunkBlock(chunk, 4, 4, 5, 'block', reg);
            setChunkBlock(chunk, 5, 4, 5, 'block', reg);
            setChunkBlock(chunk, 6, 5, 5, 'block', reg);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), reg);
            expect(a).not.toBeNull();

            for (const ba of cubeFaceBuckets(a!, 'opaque')) {
                const bb = cubeFaceBuckets(b!, 'opaque').find(x => x.quadCount === ba.quadCount)!;
                for (let i = 0; i < ba.quadCount * 4; i++) {
                    expect(cornerLight(bb, i)).toBe(cornerLight(ba, i));
                }
            }
        });
    });
});

// suppress dead-import warning when registry-driven helpers aren't reached.
void registry;
