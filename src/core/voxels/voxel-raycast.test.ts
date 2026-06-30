// ── voxel raycast tests ─────────────────────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aabbs } from './block-collider';
import { box } from './block-model';
import { BLOCK_FLAG_COLLISION, BLOCK_FLAG_SELECTION } from './block-registry';
import { CullType } from './blocks';
import { buildTestRegistry, resetVoxelRegistry } from './test-helpers';
import { createVoxelRaycastResult, raycastVoxels } from './voxel-raycast';
import { createChunk, createVoxels, setChunkBlock } from './voxels';

// ── tests ───────────────────────────────────────────────────────────

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

describe('raycastVoxels', () => {
    describe('cube blocks', () => {
        it('hits a single stone block from +z', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            // ray from z=10, aimed at block center, going -z
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.voxelY).toBe(5);
            expect(out.voxelZ).toBe(5);
            expect(out.distance).toBeCloseTo(4); // z=10 to z=6 face
            // stepping -z: we enter through the +z (south) face of the block
            // south face → index 4, normal points +z
            expect(out.nz).toBe(1);
            expect(out.hitIndex).toBe(4);
        });

        it('hits a block from -x looking +x', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 0, 5.5, 5.5, 1, 0, 0, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.voxelY).toBe(5);
            expect(out.voxelZ).toBe(5);
            // entered through the -x (west) face → face index 1, normal (-1,0,0)
            expect(out.hitIndex).toBe(1);
            expect(out.nx).toBe(-1);
        });

        it('returns correct face for each axis', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);
            const out = createVoxelRaycastResult();

            // from +x looking -x → enters through east(+x) face → index 0
            raycastVoxels(out, voxels, registry, 10, 5.5, 5.5, -1, 0, 0, 20, 0);
            expect(out.hit).toBe(true);
            expect(out.hitIndex).toBe(0); // east face
            expect(out.nx).toBe(1);

            // from -y looking +y → enters through down(-y) face → index 3
            raycastVoxels(out, voxels, registry, 5.5, 0, 5.5, 0, 1, 0, 20, 0);
            expect(out.hit).toBe(true);
            expect(out.hitIndex).toBe(3); // down face
            expect(out.ny).toBe(-1);

            // from +y looking -y → enters through up(+y) face → index 2
            raycastVoxels(out, voxels, registry, 5.5, 10, 5.5, 0, -1, 0, 20, 0);
            expect(out.hit).toBe(true);
            expect(out.hitIndex).toBe(2); // up face
            expect(out.ny).toBe(1);
        });

        it('misses when no blocks in path', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            // ray going +x but block is at (5,5,5) and ray is at y=0, misses
            raycastVoxels(out, voxels, registry, 0, 0.5, 0.5, 1, 0, 0, 20, 0);

            expect(out.hit).toBe(false);
        });

        it('respects maxDistance', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 10, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            // block is at x=10 but maxDistance=5, ray starts at x=0
            raycastVoxels(out, voxels, registry, 0, 5.5, 5.5, 1, 0, 0, 5, 0);

            expect(out.hit).toBe(false);
        });

        it('hits first block when multiple are in path', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 3, 5, 5, 'stone', registry);
            setChunkBlock(chunk, 7, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 0, 5.5, 5.5, 1, 0, 0, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(3); // hits the closer one
        });
    });

    describe('chunk skipping', () => {
        it('skips empty chunks', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);

            // chunk at (0,0,0) is empty, chunk at (1,0,0) has a block
            createChunk(0, 0, 0); // empty chunk (not even added, tests missing chunk skip)
            const chunk1 = createChunk(1, 0, 0);
            voxels.chunks.set('1,0,0', chunk1);
            setChunkBlock(chunk1, 2, 5, 5, 'stone', registry); // world x=18

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 0, 5.5, 5.5, 1, 0, 0, 30, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(18);
        });

        it('skips chunk with zero aggregate', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);

            // chunk at (0,0,0) exists but is all air (aggregate=0)
            const emptyChunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', emptyChunk);

            const chunk1 = createChunk(1, 0, 0);
            voxels.chunks.set('1,0,0', chunk1);
            setChunkBlock(chunk1, 0, 5, 5, 'stone', registry); // world x=16

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 0, 5.5, 5.5, 1, 0, 0, 30, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(16);
        });

        it('returns correct face normal after skipping empty chunk (-x ray)', () => {
            // regression: empty-chunk skip must update lastStepAxis/lastStepDir
            // so the face index of the next solid hit is computed correctly.
            // user-visible symptom: build tool place fails on a face whose
            // adjacent chunk is empty, because hover normal is wrong.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);

            // voxel at world (15, 5, 5) in chunk (0,0,0); empty chunk (1,0,0)
            const chunk0 = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk0);
            setChunkBlock(chunk0, 15, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            // ray from (20, 5.5, 5.5) going -x, passes through empty chunk
            // (1,0,0), then hits the +x face of voxel (15,5,5)
            raycastVoxels(out, voxels, registry, 20, 5.5, 5.5, -1, 0, 0, 30, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(15);
            // entered through the +x (east) face → face index 0, normal (+1,0,0)
            expect(out.hitIndex).toBe(0);
            expect(out.nx).toBe(1);
            expect(out.ny).toBe(0);
            expect(out.nz).toBe(0);
        });
    });

    describe('custom model blocks', () => {
        it('hits a custom model (full box)', () => {
            const tex = 'stone';
            const tris = box([0, 0, 0], [1, 1, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                {
                    id: 'custom_box',

                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: tris }),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'custom_box', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.voxelY).toBe(5);
            expect(out.voxelZ).toBe(5);
            expect(out.distance).toBeCloseTo(4);
        });

        it('ray passes through gap above a slab (no explicit shape — unit box default)', () => {
            const tex = 'stone';
            // half-slab: [0,0,0] to [1,0.5,1]
            const tris = box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                {
                    id: 'slab',
                    cull: CullType.PARTIAL,
                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: tris }),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'slab', registry);

            const out = createVoxelRaycastResult();
            // ray aimed at y=5.75 (above visual slab top at y=5.5)
            // but the collision shape is a unit box [0,1]^3, so the ray DOES hit
            raycastVoxels(out, voxels, registry, 5.5, 5.75, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.voxelY).toBe(5);
            expect(out.voxelZ).toBe(5);
        });

        it('ray passes through gap above a slab (explicit shape — precise collision)', () => {
            const tex = 'stone';
            // half-slab: [0,0,0] to [1,0.5,1]
            const tris = box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                {
                    id: 'slab',
                    cull: CullType.PARTIAL,
                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: tris }),
                    shape: aabbs([[0, 0, 0, 1, 0.5, 1]]),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'slab', registry);

            const out = createVoxelRaycastResult();
            // ray aimed at y=5.75 (above slab top at y=5.5)
            // with explicit shape, ray passes through the gap
            raycastVoxels(out, voxels, registry, 5.5, 5.75, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(false);
        });

        it('ray hits the slab when aimed at it', () => {
            const tex = 'stone';
            const tris = box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                {
                    id: 'slab',
                    cull: CullType.PARTIAL,
                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: tris }),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'slab', registry);

            const out = createVoxelRaycastResult();
            // ray aimed at y=5.25 (within the slab)
            raycastVoxels(out, voxels, registry, 5.5, 5.25, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.voxelY).toBe(5);
            expect(out.voxelZ).toBe(5);
        });

        it('ray hits slab when aimed above visual model (no explicit shape — unit box default)', () => {
            const tex = 'stone';
            const slabTris = box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                {
                    id: 'slab',
                    cull: CullType.PARTIAL,
                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: slabTris }),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            // slab at z=5, stone wall at z=3
            setChunkBlock(chunk, 5, 5, 5, 'slab', registry);
            setChunkBlock(chunk, 5, 5, 3, 'stone', registry);

            const out = createVoxelRaycastResult();
            // ray aimed above visual slab (y=5.75), but unit box collider catches it
            raycastVoxels(out, voxels, registry, 5.5, 5.75, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelZ).toBe(5); // hits the slab (unit box), not the stone behind
        });

        it('ray hits block behind slab gap (explicit shape — precise collision)', () => {
            const tex = 'stone';
            const slabTris = box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });

            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                {
                    id: 'slab',
                    cull: CullType.PARTIAL,
                    texId: 'stone',
                    model: () => ({ type: 'custom' as const, quads: slabTris }),
                    shape: aabbs([[0, 0, 0, 1, 0.5, 1]]),
                },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            // slab at z=5, stone wall at z=3
            setChunkBlock(chunk, 5, 5, 5, 'slab', registry);
            setChunkBlock(chunk, 5, 5, 3, 'stone', registry);

            const out = createVoxelRaycastResult();
            // ray aimed above slab (y=5.75), passes through slab gap, hits stone behind
            raycastVoxels(out, voxels, registry, 5.5, 5.75, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelZ).toBe(3); // hit the stone, not the slab
        });
    });

    describe('edge cases', () => {
        it('ray origin inside a cube block', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            // origin at center of the block
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 5.5, 1, 0, 0, 20, 0);

            expect(out.hit).toBe(true);
            expect(out.voxelX).toBe(5);
            expect(out.distance).toBeCloseTo(0);
        });

        it('returns stateId of hit block', () => {
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'dirt', texId: 'stone' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'dirt', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
            // dirt should have a different stateId than stone
            const dirtId = registry.keyToState.get('dirt')!;
            expect(out.stateId).toBe(dirtId);
        });

        it('empty world returns no hit', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 0, 0, 0, 1, 0, 0, 100, 0);

            expect(out.hit).toBe(false);
        });
    });

    describe('block flags', () => {
        it('selection:false skips block when BLOCK_FLAG_SELECTION required', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', selection: false }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, BLOCK_FLAG_SELECTION);

            expect(out.hit).toBe(false);
        });

        it('selection:false block is still hit with no flags required', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', selection: false }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, 0);

            expect(out.hit).toBe(true);
        });

        it('collision:false skips block when BLOCK_FLAG_COLLISION required', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, BLOCK_FLAG_COLLISION);

            expect(out.hit).toBe(false);
        });

        it('collision:false block is still hit by selection raycast', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, BLOCK_FLAG_SELECTION);

            expect(out.hit).toBe(true);
        });

        it('ray passes through non-selectable block to hit selectable one behind', () => {
            const registry = buildTestRegistry([
                { id: 'glass', texId: 'stone', selection: false },
                { id: 'stone', texId: 'stone' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 6, 'glass', registry);
            setChunkBlock(chunk, 5, 5, 5, 'stone', registry);

            const out = createVoxelRaycastResult();
            raycastVoxels(out, voxels, registry, 5.5, 5.5, 10, 0, 0, -1, 20, BLOCK_FLAG_SELECTION);

            expect(out.hit).toBe(true);
            expect(out.voxelZ).toBe(5); // hit stone behind glass
        });
    });
});
