// ── MODEL_LIQUID mesher behaviour ───────────────────────────────────
//
// covers:
//   - top quad emitted at y+h for surface cells
//   - side faces clipped to height h
//   - same-fluid neighbours merge top/bottom (no internal slabs)
//   - solid neighbour culls liquid side, but liquid does NOT cull solid
//     cube faces (the cube branch checks fluidGroup before culling)

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CullType, MaterialType } from './blocks';
import { type ChunkMeshResult, buildMeshInput, createMeshOutput, meshChunk, QUAD_STRIDE_U32S } from './chunk-mesher';
import { buildTestRegistry as buildVoxelTestRegistry, resetVoxelRegistry } from './test-helpers';
import { createChunk, createVoxels, setChunkBlock } from './voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

type BlockSpec = {
    id: string;
    cull?: CullType;
    material?: MaterialType;
    surfaceHeight?: number;
    fluidGroup?: string;
};

function buildTestRegistry(blocks: BlockSpec[]) {
    return buildVoxelTestRegistry(
        blocks.map((b) => ({
            id: b.id,
            texId: b.id,
            cull: b.cull,
            material: b.material,
            surfaceHeight: b.surfaceHeight,
            fluidGroup: b.fluidGroup,
            collision: b.surfaceHeight !== undefined ? false : undefined,
            liquid: b.surfaceHeight !== undefined ? { viscosity: 1 } : undefined,
        })),
    );
}

/** count quads in a pass. unified all-quads format — cube + liquid + mesh
 *  all live in the same PassMesh; tests rely on per-pass material routing
 *  (lava=opaque liquid, water=translucent liquid, stone=opaque cube) to
 *  isolate sources. */
function countCubeFaces(mesh: ChunkMeshResult | null, pass: 'opaque' | 'translucent'): number {
    if (!mesh) return 0;
    const p = pass === 'opaque' ? mesh.opaque : mesh.translucent;
    return p?.quadCount ?? 0;
}

/** count liquid faces — same as cube count under unified format; pass
 *  routing keeps the two sources separate (caller picks a pass that
 *  contains only liquid). */
function countLiquidFaces(mesh: ChunkMeshResult | null, pass: 'opaque' | 'translucent'): number {
    return countCubeFaces(mesh, pass);
}

/** decode the Y component of a corner (0..3) of a quad. quad header bytes
 *  0..11 of u32[0..2] are [x0,y0,z0,x1,y1,z1,x2,y2,z2,x3,y3,z3] at 1/16 voxel. */
function cornerY(quads: Uint32Array, quadIdx: number, corner: number): number {
    const u32 = quads[quadIdx * QUAD_STRIDE_U32S + ((corner * 3 + 1) >> 2)]!;
    const byte = (u32 >>> (((corner * 3 + 1) & 3) * 8)) & 0xff;
    return byte / 16;
}

function maxLiquidVertexY(mesh: ChunkMeshResult, pass: 'opaque' | 'translucent'): number {
    const p = pass === 'opaque' ? mesh.opaque : mesh.translucent;
    if (!p) return -Infinity;
    let max = -Infinity;
    for (let q = 0; q < p.quadCount; q++) {
        for (let c = 0; c < 4; c++) {
            const y = cornerY(p.quads, q, c);
            if (y > max) max = y;
        }
    }
    return max;
}

function hasLiquidVertexAtY(mesh: ChunkMeshResult, pass: 'opaque' | 'translucent', targetY: number): boolean {
    const p = pass === 'opaque' ? mesh.opaque : mesh.translucent;
    if (!p) return false;
    for (let q = 0; q < p.quadCount; q++) {
        for (let c = 0; c < 4; c++) {
            if (Math.abs(cornerY(p.quads, q, c) - targetY) < 1e-2) return true;
        }
    }
    return false;
}

describe('MODEL_LIQUID mesher', () => {
    it('isolated liquid cell: 6 faces, top emitted at y+h', () => {
        const registry = buildTestRegistry([
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 0.875, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(chunk, 5, 5, 5, 'water', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        expect(countLiquidFaces(result, 'translucent')).toBe(6);
        // top vertex Y should be y(5) + h(0.875) = 5.875, not 6
        expect(maxLiquidVertexY(result, 'translucent')).toBeCloseTo(5.875);
    });

    it('full-height liquid surrounded by solid on every side: nothing visible', () => {
        // a lowered surface (< 1) stays visible through the gap under a solid
        // block (see open-top pool), so full occlusion only holds for a
        // full-height liquid flush against the block above.
        const registry = buildTestRegistry([
            { id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE },
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 1, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        // single water cell, stone in all 6 neighbours
        setChunkBlock(chunk, 5, 5, 5, 'water', registry);
        setChunkBlock(chunk, 4, 5, 5, 'stone', registry);
        setChunkBlock(chunk, 6, 5, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 4, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 6, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 5, 4, 'stone', registry);
        setChunkBlock(chunk, 5, 5, 6, 'stone', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        expect(countLiquidFaces(result, 'translucent')).toBe(0);
    });

    it('open-top pool (solid sides+floor, air above): only top quad emitted', () => {
        const registry = buildTestRegistry([
            { id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE },
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 0.875, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        setChunkBlock(chunk, 5, 5, 5, 'water', registry);
        setChunkBlock(chunk, 4, 5, 5, 'stone', registry);
        setChunkBlock(chunk, 6, 5, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 4, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 5, 4, 'stone', registry);
        setChunkBlock(chunk, 5, 5, 6, 'stone', registry);
        // y+1 left as air

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        expect(countLiquidFaces(result, 'translucent')).toBe(1);
        // top vertex sits at the meniscus
        expect(maxLiquidVertexY(result, 'translucent')).toBeCloseTo(5.875);
    });

    it('stacked column: only the top cell emits its meniscus top', () => {
        const registry = buildTestRegistry([
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 0.875, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        // 2-tall water column in open air
        setChunkBlock(chunk, 5, 5, 5, 'water', registry);
        setChunkBlock(chunk, 5, 6, 5, 'water', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        // top vertex Y must be the top of the upper cell (6 + 0.875 = 6.875),
        // confirming the lower cell does NOT emit an internal top at y=5.875.
        expect(maxLiquidVertexY(result, 'translucent')).toBeCloseTo(6.875);
    });

    it('column merge: same-fluid neighbour above extends the cell to y+1 (no internal slab)', () => {
        const registry = buildTestRegistry([
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 0.875, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        setChunkBlock(chunk, 5, 5, 5, 'water', registry);
        setChunkBlock(chunk, 5, 6, 5, 'water', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        // no vertex should sit at the seam (y=5.875): the lower cell merges
        // upward to y=6, the upper cell renders the meniscus at y=6.875.
        expect(hasLiquidVertexAtY(result, 'translucent', 5.875)).toBe(false);
    });

    it('different fluidGroups do not self-merge — culling falls back to cull-type', () => {
        // water (translucent, CULL_SELF) next to lava (opaque, CULL_SOLID):
        // - water side vs lava: lava is CULL_SOLID, not same-fluid → cull water side
        // - lava side vs water: water is CULL_SELF (not CULL_SOLID), not same-fluid → emit
        // confirms different fluidGroups skip the merge path entirely.
        const registry = buildTestRegistry([
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 1, fluidGroup: 'water' },
            { id: 'lava', cull: CullType.SOLID, material: MaterialType.OPAQUE, surfaceHeight: 1, fluidGroup: 'lava' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        setChunkBlock(chunk, 5, 5, 5, 'water', registry);
        setChunkBlock(chunk, 6, 5, 5, 'lava', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        // lava (opaque liquid) → model.opaque; water (translucent liquid) → model.translucent
        expect(countLiquidFaces(result, 'opaque')).toBe(6);
        expect(countLiquidFaces(result, 'translucent')).toBe(5);
    });

    it('solid cube does NOT cull its face against a liquid neighbour', () => {
        // regression: cube branch must skip cull when the neighbour is a
        // liquid (fluidGroup != 0). otherwise the floor under a pool gets
        // its top stripped and you see through the world.
        const registry = buildTestRegistry([
            { id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE },
            { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, surfaceHeight: 0.875, fluidGroup: 'water' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        // stone floor with water on top
        setChunkBlock(chunk, 5, 5, 5, 'stone', registry);
        setChunkBlock(chunk, 5, 6, 5, 'water', registry);

        const result = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk), registry)!;
        // stone (cube path) emits all 6 faces (its top is NOT culled by liquid above)
        expect(countCubeFaces(result, 'opaque')).toBe(6);
    });
});
