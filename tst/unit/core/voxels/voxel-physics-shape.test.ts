// ── voxel physics shape tests ────────────────────────────────────────

import {
    box as boxShape,
    castRayVsShape,
    castShapeVsShape,
    collidePointVsShape,
    collideShapeVsShape,
    createAllCastRayCollector,
    createAllCastShapeCollector,
    createAllCollidePointCollector,
    createAllCollideShapeCollector,
    createDefaultCastRaySettings,
    createDefaultCastShapeSettings,
    createDefaultCollidePointSettings,
    createDefaultCollideShapeSettings,
    EMPTY_SUB_SHAPE_ID,
    registerAllShapes,
    registerShapes,
    sphere,
} from 'crashcat';
import { type Box3, vec3 } from 'mathcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aabbs } from '../../../../src/core/voxels/block-collider';
import { box } from '../../../../src/core/voxels/block-model';
import { CullType } from '../../../../src/core/voxels/blocks';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import {
    createVoxelPhysicsShape,
    type VoxelPhysicsShape,
    voxelPhysicsShapeDef,
} from '../../../../src/core/voxels/voxel-physics-shape';
import { createChunk, createVoxels, setChunkBlock } from '../../../../src/core/voxels/voxels';

// ── test helpers ────────────────────────────────────────────────────

// crashcat Shape is a discriminated union of built-in shapes. our custom USER_1 type
// isn't part of that union, so we need to cast when passing to narrowphase functions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asShape = (s: VoxelPhysicsShape): any => s;

beforeEach(() => {
    resetVoxelRegistry();
});

// ── shared setup ────────────────────────────────────────────────────

// identity transform for the voxel shape (origin, no rotation, unit scale)
const SHAPE_POS_X = 0;
const SHAPE_POS_Y = 0;
const SHAPE_POS_Z = 0;
const SHAPE_QUAT_X = 0;
const SHAPE_QUAT_Y = 0;
const SHAPE_QUAT_Z = 0;
const SHAPE_QUAT_W = 1;
const SHAPE_SCALE_X = 1;
const SHAPE_SCALE_Y = 1;
const SHAPE_SCALE_Z = 1;

const SUB_SHAPE_ID = EMPTY_SUB_SHAPE_ID;
const SUB_SHAPE_ID_BITS = 0;

beforeAll(() => {
    registerAllShapes();
    registerShapes([voxelPhysicsShapeDef]);
});

// ── castRay ─────────────────────────────────────────────────────────

describe('voxelPhysicsShape castRay', () => {
    it('hits a cube block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        // ray from z=10, aimed at block center, going -z
        castRayVsShape(
            collector,
            settings,
            5.5,
            5.5,
            10, // origin
            0,
            0,
            -1, // direction
            20, // length
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
        // block face at z=6, ray from z=10: fraction = 4/20 = 0.2
        expect(collector.hits[0]!.fraction).toBeCloseTo(0.2);
    });

    it('misses when ray does not hit any block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        // ray going +x at y=0.5, misses block at (5,5,5)
        castRayVsShape(
            collector,
            settings,
            0,
            0.5,
            0.5,
            1,
            0,
            0,
            20,
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('hits a custom model slab', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        // ray at y=5.25 (within slab height [5.0, 5.5]), aimed -z toward the block
        castRayVsShape(
            collector,
            settings,
            5.5,
            5.25,
            10, // origin
            0,
            0,
            -1, // direction
            20, // length
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
        // slab south face at z=6, ray from z=10: fraction = 4/20 = 0.2
        expect(collector.hits[0]!.fraction).toBeCloseTo(0.2);
    });

    it('ray hits unit box above slab visual (no explicit shape — unit box default)', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        // ray at y=5.75 (above visual slab top at y=5.5), aimed -z through the block cell
        // no explicit shape → unit box collider → ray DOES hit
        castRayVsShape(
            collector,
            settings,
            5.5,
            5.75,
            10, // origin
            0,
            0,
            -1, // direction
            20, // length
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
    });

    it('ray passes through gap above a slab (explicit shape — precise collision)', () => {
        const tex = 'stone';
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        // ray at y=5.75 (above slab top at y=5.5), aimed -z through the block cell
        // explicit shape → precise slab collider → ray passes through gap
        castRayVsShape(
            collector,
            settings,
            5.5,
            5.75,
            10, // origin
            0,
            0,
            -1, // direction
            20, // length
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        // ray passes through the gap above the slab, no hit
        expect(collector.hits.length).toBe(0);
    });
});

// ── collision flag tests ────────────────────────────────────────────

describe('voxelPhysicsShape collision:false', () => {
    it('castRay skips collision:false block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);
        const collector = createAllCastRayCollector();
        const settings = createDefaultCastRaySettings();

        castRayVsShape(
            collector,
            settings,
            5.5,
            5.5,
            10,
            0,
            0,
            -1,
            20,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('collidePoint skips collision:false block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);
        const collector = createAllCollidePointCollector();
        const settings = createDefaultCollidePointSettings();

        collidePointVsShape(
            collector,
            settings,
            5.5,
            5.5,
            5.5,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('collideShape skips collision:false block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);
        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            5.5,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('castShape skips collision:false block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone', collision: false }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');
        // sweep AABB expands by one cell, without these the +Z/-Z
        // neighbor chunks would be CONTENT_IGNORE and produce spurious hits.
        voxels.chunks.set('0,0,-1', createChunk(0, 0, -1));
        voxels.chunks.set('0,0,1', createChunk(0, 0, 1));

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);
        const collector = createAllCastShapeCollector();
        const settings = createDefaultCastShapeSettings();

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.3, 0.3, 0.3), convexRadius: 0.02 });

        // box approaching from +z direction
        castShapeVsShape(
            collector,
            settings,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            5.5,
            10,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
            0,
            0,
            -10, // displacement toward block
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });
});

// ── collidePoint ────────────────────────────────────────────────────

describe('voxelPhysicsShape collidePoint', () => {
    it('detects point inside a cube block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCollidePointCollector();
        const settings = createDefaultCollidePointSettings();

        collidePointVsShape(
            collector,
            settings,
            5.5,
            5.5,
            5.5, // point inside the block
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
    });

    it('no hit for point in air', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCollidePointCollector();
        const settings = createDefaultCollidePointSettings();

        collidePointVsShape(
            collector,
            settings,
            0.5,
            0.5,
            0.5, // point in air (no block at 0,0,0)
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('detects point inside a custom model slab (within AABB)', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCollidePointCollector();
        const settings = createDefaultCollidePointSettings();

        // point at y=5.25, within slab AABB
        collidePointVsShape(
            collector,
            settings,
            5.5,
            5.25,
            5.5,
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
    });

    it('detects point above slab visual (no explicit shape — unit box default)', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const shape = createVoxelPhysicsShape(voxels, registry, aabb);

        const collector = createAllCollidePointCollector();
        const settings = createDefaultCollidePointSettings();

        // point at y=5.75, above visual slab (top at y=5.5) but inside unit box [5,6]
        // no explicit shape → unit box collider → point IS inside
        collidePointVsShape(
            collector,
            settings,
            5.5,
            5.75,
            5.5,
            asShape(shape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(1);
    });
});

// ── collideShape ────────────────────────────────────────────────────

describe('voxelPhysicsShape collideShape', () => {
    it('box overlapping a cube block produces contact', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // small box sitting on top of the stone block, slightly overlapping
        // block top face is at y=6, box center at y=6.4, half-extent 0.5 → box bottom at y=5.9
        // overlap = 0.1
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        // voxel shape A, box shape B
        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            6.4,
            5.5, // box position (overlapping top of stone block)
            0,
            0,
            0,
            1, // identity rotation
            1,
            1,
            1, // unit scale
        );

        expect(collector.hits.length).toBeGreaterThan(0);
        // penetration: collideConvexVsConvexLocal returns distance-based penetration
        // positive or negative depending on convention, just check we got a contact
    });

    it('box not overlapping produces no contact', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // box well above the stone block (block top at y=6, box bottom at y=9.5)
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            10.0,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('sphere overlapping a cube block produces contact', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // sphere at y=6.4, radius 0.5 → bottom at 5.9, overlaps block top at y=6
        const testSphere = sphere.create({ radius: 0.5 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testSphere,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            6.4,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBeGreaterThan(0);
    });

    it('works with reversed shape order (convex A vs voxel B)', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        // reversed: box is A, voxels are B
        collideShapeVsShape(
            collector,
            settings,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            6.4,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBeGreaterThan(0);
    });

    it('box overlapping a slab custom model produces contact', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // slab top is at y=5.5. box center at y=5.3, half-extent 0.4 → extends y=[4.9, 5.7]
        // clearly overlaps with slab [y=5.0 to y=5.5]
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.4, 0.4, 0.4), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            5.3,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBeGreaterThan(0);
    });

    it('box above slab gap produces no contact', () => {
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
        setChunkBlock(voxels, chunk, 5, 5, 5, 'slab');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // slab top at y=5.5, box center at y=8, well above the slab
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.4, 0.4, 0.4), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            8.0,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBe(0);
    });
});

// ── ghost-collision rejection ────────────────────────────────────────
//
// per-cube contacts whose contacted face is buried behind a solid neighbour cube
// are tessellation artifacts. the narrowphase drops them (neighbour-reject), so a
// body on a continuous cube floor never gets a spurious sideways normal, while a
// body against a genuinely exposed face still does.

const dominantAxis = (n: ArrayLike<number>): number => {
    const ax = Math.abs(n[0]!);
    const ay = Math.abs(n[1]!);
    const az = Math.abs(n[2]!);
    if (ax >= ay && ax >= az) return 0;
    if (ay >= az) return 1;
    return 2;
};

function collideBoxVsVoxels(voxelShape: VoxelPhysicsShape, bx: number, by: number, bz: number, half = 0.4) {
    const testBox = boxShape.create({ halfExtents: vec3.fromValues(half, half, half), convexRadius: 0.02 });
    const collector = createAllCollideShapeCollector();
    const settings = createDefaultCollideShapeSettings();
    collideShapeVsShape(
        collector,
        settings,
        asShape(voxelShape),
        SUB_SHAPE_ID,
        SUB_SHAPE_ID_BITS,
        SHAPE_POS_X,
        SHAPE_POS_Y,
        SHAPE_POS_Z,
        SHAPE_QUAT_X,
        SHAPE_QUAT_Y,
        SHAPE_QUAT_Z,
        SHAPE_QUAT_W,
        SHAPE_SCALE_X,
        SHAPE_SCALE_Y,
        SHAPE_SCALE_Z,
        testBox,
        SUB_SHAPE_ID,
        SUB_SHAPE_ID_BITS,
        bx,
        by,
        bz,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
    );
    return collector;
}

describe('voxelPhysicsShape ghost-collision rejection', () => {
    it('flat cube floor produces no sideways (horizontal) contacts', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        // a contiguous floor strip: cells x=4..6 at y=5, z=5. floor top at y=6.
        setChunkBlock(voxels, chunk, 4, 5, 5, 'stone');
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');
        setChunkBlock(voxels, chunk, 6, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // box penetrating the floor (bottom at y=5.7, floor top y=6 → 0.3 deep), at several
        // asymmetric straddle offsets — the configuration that makes per-cube EPA flip to a
        // horizontal normal. every surviving contact must be vertical (+Y), never sideways.
        let totalHits = 0;
        for (const bx of [5.5, 5.6, 5.65, 5.7, 5.8]) {
            const collector = collideBoxVsVoxels(voxelShape, bx, 6.1, 5.5);
            for (const h of collector.hits) {
                totalHits++;
                expect(dominantAxis(h.penetrationAxis)).toBe(1); // Y, i.e. up — never X/Z ghost
            }
        }
        expect(totalHits).toBeGreaterThan(0); // the floor is genuinely being contacted
    });

    it('exposed vertical face is preserved (a real wall still pushes sideways)', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        // a single isolated cube at (5,5,5): every face is exposed (all neighbours air).
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // box level with the cube, overlapping only its -X face (box center x=4.75, half 0.4 →
        // +X face at 5.15 into cube [5,6] by 0.15; y/z overlap 0.8, so shortest exit is -X).
        // the -X neighbour (x=4) is air, so this is a real face and must survive: X-dominant contact.
        const collector = collideBoxVsVoxels(voxelShape, 4.75, 5.5, 5.5);
        expect(collector.hits.length).toBeGreaterThan(0);
        expect(collector.hits.some((h) => dominantAxis(h.penetrationAxis) === 0)).toBe(true);
    });
});

// ── castShape ───────────────────────────────────────────────────────

describe('voxelPhysicsShape castShape', () => {
    it('box swept downward hits a cube block', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // box starts at y=8 (bottom at y=7.5), sweep -y by 5 units
        // should hit block top at y=6, travel = 7.5 - 6.0 = 1.5, fraction = 1.5/5 = 0.3
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCastShapeCollector();
        const settings = createDefaultCastShapeSettings();

        // castShape: convex A swept against voxel B
        castShapeVsShape(
            collector,
            settings,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            8.0,
            5.5, // box start position
            0,
            0,
            0,
            1, // identity rotation
            1,
            1,
            1, // unit scale
            0,
            -5,
            0, // displacement (sweep down)
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBeGreaterThan(0);
        // fraction should be roughly 0.3 (accounting for convex radius)
        expect(collector.hits[0]!.fraction).toBeGreaterThan(0.1);
        expect(collector.hits[0]!.fraction).toBeLessThan(0.5);
    });

    it('box swept away from block produces no hit', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCastShapeCollector();
        const settings = createDefaultCastShapeSettings();

        // box starts above block, swept upward, away from block
        castShapeVsShape(
            collector,
            settings,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            8.0,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
            0,
            5,
            0, // displacement upward
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
        );

        expect(collector.hits.length).toBe(0);
    });

    it('reversed order: voxel A swept against box B', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCastShapeCollector();
        const settings = createDefaultCastShapeSettings();

        // voxel A swept upward against stationary box B at y=8
        // this is the reversed direction, should still work via reversedCastShapeVsShape
        castShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            0,
            5,
            0, // voxel world moving upward
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            8.0,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        // should detect collision
        expect(collector.hits.length).toBeGreaterThan(0);
    });
});

// ── multiple blocks ─────────────────────────────────────────────────

describe('voxelPhysicsShape merge-by-stateId', () => {
    // collide a wide box over two adjacent x-cells (5,5,5)+(6,5,5), return narrowphase hit count.
    // contiguous same-stateId cubes merge into one box (one hit); different kinds stay separate.
    function hitsOverAdjacentPair(idA: string, idB: string): number {
        const registry = buildTestRegistry([
            { id: 'stone', texId: 'stone' },
            { id: 'dirt', texId: 'dirt' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, idA);
        setChunkBlock(voxels, chunk, 6, 5, 5, idB);

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // wide box (x∈[4,7]) resting on top of both cells, slightly overlapping
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(1.5, 0.5, 0.5), convexRadius: 0.02 });
        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();
        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            6.4,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );
        return collector.hits.length;
    }

    it('merges adjacent same-stateId cubes into one contact', () => {
        // one merged box for the two stone cells → a single narrowphase hit
        expect(hitsOverAdjacentPair('stone', 'stone')).toBe(1);
    });

    it('does not merge adjacent different-stateId cubes', () => {
        // stone + dirt are distinct kinds → two boxes → two hits
        expect(hitsOverAdjacentPair('stone', 'dirt')).toBe(2);
    });

    it('merges a 2D patch of same-stateId cubes into one contact (x + z)', () => {
        // 2×2 patch in the xz-plane merges across both axes → a single box → one hit,
        // proving the merge is 3D (greedy x, then z, then y), not x-runs only.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');
        setChunkBlock(voxels, chunk, 6, 5, 5, 'stone');
        setChunkBlock(voxels, chunk, 5, 5, 6, 'stone');
        setChunkBlock(voxels, chunk, 6, 5, 6, 'stone');

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        // wide box (x,z ∈ [4.5,7.5]) resting on the whole patch top
        const testBox = boxShape.create({ halfExtents: vec3.fromValues(1.5, 0.5, 1.5), convexRadius: 0.02 });
        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();
        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            6.0,
            6.4,
            6.0,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );
        expect(collector.hits.length).toBe(1);
    });

    it('empty world produces no contacts', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        // explicit empty chunk, CONTENT_IGNORE treats unknown chunks as
        // a solid 16³ cell, so leaving (0,0,0) absent would produce phantom
        // hits at the chunk boundary.
        voxels.chunks.set('0,0,0', createChunk(0, 0, 0));

        const aabb = [0, 0, 0, 16, 16, 16] as Box3;
        const voxelShape = createVoxelPhysicsShape(voxels, registry, aabb);

        const testBox = boxShape.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.02 });

        const collector = createAllCollideShapeCollector();
        const settings = createDefaultCollideShapeSettings();

        collideShapeVsShape(
            collector,
            settings,
            asShape(voxelShape),
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            SHAPE_POS_X,
            SHAPE_POS_Y,
            SHAPE_POS_Z,
            SHAPE_QUAT_X,
            SHAPE_QUAT_Y,
            SHAPE_QUAT_Z,
            SHAPE_QUAT_W,
            SHAPE_SCALE_X,
            SHAPE_SCALE_Y,
            SHAPE_SCALE_Z,
            testBox,
            SUB_SHAPE_ID,
            SUB_SHAPE_ID_BITS,
            5.5,
            5.5,
            5.5,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
        );

        expect(collector.hits.length).toBe(0);
    });
});
