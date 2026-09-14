// ── chunk mesher tests ──────────────────────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registry, tile } from '../../../../src/core/registry';
import { stairs } from '../../../../src/core/voxels/block-presets';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import {
    buildMeshInput,
    type ChunkMeshResult,
    createMeshOutput,
    META_OFFSET,
    meshChunk,
    QUAD_STRIDE_U32S,
} from '../../../../src/core/voxels/chunk-mesher';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, setChunkBlock } from '../../../../src/core/voxels/voxels';

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

/** read per-corner light from the interleaved quad buffer. `idx` is the
 *  flat corner index (`q * 4 + corner`). */
/** read the per-corner light word for `(quadIdx, corner)`. */
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

            setChunkBlock(voxels, chunk, 5, 5, 5, 'water');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
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
            setChunkBlock(voxels, chunk, 5, 5, 5, 'water');
            setChunkBlock(voxels, chunk, 6, 5, 5, 'water');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
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
                setChunkBlock(voxels, chunk, 5 + i, 5, 5, 'water');
            }

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
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

            setChunkBlock(voxels, chunk, 5, 5, 5, 'glass');
            setChunkBlock(voxels, chunk, 6, 5, 5, 'glass');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
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

            setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');
            setChunkBlock(voxels, chunk, 6, 5, 5, 'stone');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
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

            setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');
            setChunkBlock(voxels, chunk, 6, 5, 5, 'water');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
            // stone: 6 - 1 (face toward water culled by... wait, solid doesn't cull toward translucent_self)
            // actually: stone's face toward water: shouldCullFace(solid, translucent_self) = false → visible
            // water's face toward stone: shouldCullFace(translucent_self, solid) = true → culled
            expect(countCubeFaces(result, 'opaque')).toBe(6); // stone: all 6 (translucent_self doesn't cull solid)
            expect(countCubeFaces(result, 'translucent')).toBe(5); // water: 6 - 1 culled by solid
        });
    });

    describe('mesh quad shape dispatch (stair)', () => {
        // build a fresh stair-bearing registry. stairs() produces a custom
        // mesh with a mix of shapes: the riser, tread top, side panels, and
        // back face exercise ALIGNED_FULL / ALIGNED_PARTIAL paths through
        // the new bilerp dispatch.
        function buildStairRegistry() {
            const stoneTex = tile('stone', { src: 'textures/stone.png' });
            stairs('stair', { tiles: stoneTex });
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
            setChunkBlock(voxels, chunk, 5, 5, 5, 'stair');
            setChunkBlock(voxels, chunk, 4, 5, 5, 'block');
            setChunkBlock(voxels, chunk, 4, 4, 5, 'block');
            setChunkBlock(voxels, chunk, 5, 4, 5, 'block');

            const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), reg);
            expect(result).not.toBeNull();
            const pass = result!.opaque!;
            expect(pass.quadCount).toBeGreaterThan(0);

            // at least one quad must show per-vertex AO variation (not all
            // corners equal). proves shape dispatch is actually computing
            // per-corner values rather than the old flat 0xffffffff write.
            // light variation requires propagated light, which the chunk
            // doesn't have without a lighting pass, relight equivalence
            // test below covers the light path.
            //
            // AO lives in the low 16 bits of the meta u32 (qd[9]), packed
            // as ao0Bits | ao1Bits<<4 | ao2Bits<<8 | ao3Bits<<12 with each
            // ∈ [0..15] encoding brightness `bits/30 + 0.5`.
            let sawAoVariation = false;
            for (let q = 0; q < pass.quadCount; q++) {
                const meta = pass.quads[q * QUAD_STRIDE_U32S + META_OFFSET]!;
                const a0 = meta & 0xf;
                const a1 = (meta >>> 4) & 0xf;
                const a2 = (meta >>> 8) & 0xf;
                const a3 = (meta >>> 12) & 0xf;
                if (!(a0 === a1 && a1 === a2 && a2 === a3)) {
                    sawAoVariation = true;
                    break;
                }
            }
            expect(sawAoVariation).toBe(true);
        });
    });
});

// suppress dead-import warning when registry-driven helpers aren't reached.
void registry;
