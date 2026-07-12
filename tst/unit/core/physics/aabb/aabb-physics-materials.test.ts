import { createWorld, registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlockDef } from '../../../../../src/core/voxels/blocks';
import { buildTestRegistry, resetVoxelRegistry, type TestBlockSpec } from '../../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, linkChunkNeighbors, setChunkBlock } from '../../../../../src/core/voxels/voxels';
import { settings as physicsSettings } from '../../../../../src/core/physics/physics';
import * as AabbPhysics from '../../../../../src/core/physics/aabb';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

const NULL_SINK: AabbPhysics.PairSink = { record() {} };

function buildMaterialRegistry(blocks: { id: string; def: Omit<TestBlockSpec, 'id' | 'texId'> }[]) {
    return buildTestRegistry(blocks.map((b) => ({ id: b.id, texId: 'white', ...b.def })));
}

/** place a 5x5 floor plate at world y=0 of `key` blocks, with chunks linked
 *  so voxel sweeps see them as a contiguous surface. */
function setupFloor(voxels: ReturnType<typeof createVoxels>, key: string) {
    const dirtyChunks = new Set<string>();
    for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
            const cx = x >> 4;
            const cy = 0;
            const cz = z >> 4;
            const k = `${cx},${cy},${cz}`;
            let chunk = voxels.chunks.get(k);
            if (!chunk) {
                chunk = createChunk(cx, cy, cz);
                voxels.chunks.set(k, chunk);
                dirtyChunks.add(k);
            }
            setChunkBlock(voxels, chunk, x & 15, 0, z & 15, key);
        }
    }
    for (const k of dirtyChunks) linkChunkNeighbors(voxels, voxels.chunks.get(k)!);
}

function setupWorld(blocks: { id: string; def: Partial<BlockDef> }[]) {
    const registry = buildMaterialRegistry(blocks);
    const voxels = createVoxels(registry);
    const crashWorld = createWorld(physicsSettings);
    const world = AabbPhysics.createWorld(voxels, {
        // disable the noa-style minimum so tests can probe small-impact bounces.
        minBounceVelocity: 0.01,
    });
    return { registry, voxels, crashWorld, world };
}

describe('aabb-physics — friction combine', () => {
    it('block friction multiplies body friction (ice = slippery, stone = grippy)', () => {
        // run two parallel sims, stone vs ice, same body params, compare
        // post-tick horizontal velocity. ice (μ=0.1) damps less than stone (μ=1).
        const stone = setupWorld([{ id: 'stone', def: { friction: 1.0 } }]);
        setupFloor(stone.voxels, 'stone');
        const stoneBody = AabbPhysics.createBody(stone.world, stone.crashWorld, {
            position: [0, 1.5, 0],
            halfExtents: [0.4, 0.5, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            friction: 1.0,
        });
        // first tick: gravity pulls body onto floor, sets resting + restingStateId.
        // second tick: prevResting now populated; friction will apply when we add
        // horizontal velocity.
        AabbPhysics.tick(stone.world, stone.crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.tick(stone.world, stone.crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.setVelocity(stone.world, stoneBody, 5, 0, 0);
        AabbPhysics.tick(stone.world, stone.crashWorld, 1 / 60, NULL_SINK);
        const stoneVx = stoneBody.linearVelocity[0];

        const ice = setupWorld([{ id: 'ice', def: { friction: 0.1 } }]);
        setupFloor(ice.voxels, 'ice');
        const iceBody = AabbPhysics.createBody(ice.world, ice.crashWorld, {
            position: [0, 1.5, 0],
            halfExtents: [0.4, 0.5, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            friction: 1.0,
        });
        AabbPhysics.tick(ice.world, ice.crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.tick(ice.world, ice.crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.setVelocity(ice.world, iceBody, 5, 0, 0);
        AabbPhysics.tick(ice.world, ice.crashWorld, 1 / 60, NULL_SINK);
        const iceVx = iceBody.linearVelocity[0];

        // ice retains more velocity than stone.
        expect(iceVx).toBeGreaterThan(stoneVx);
        // both lose some, friction was applied (sanity).
        expect(stoneVx).toBeLessThan(5);
        expect(iceVx).toBeLessThan(5);
        // and the ratio of damping should track block friction ratio (~10x).
        const stoneDamping = 5 - stoneVx;
        const iceDamping = 5 - iceVx;
        expect(stoneDamping).toBeGreaterThan(iceDamping * 5);
    });

    it('body friction = 0 disables friction regardless of block', () => {
        const { voxels, crashWorld, world } = setupWorld([{ id: 'stone', def: { friction: 1.0 } }]);
        setupFloor(voxels, 'stone');
        const body = AabbPhysics.createBody(world, crashWorld, {
            position: [0, 1.5, 0],
            halfExtents: [0.4, 0.5, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            friction: 0,
        });
        AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        AabbPhysics.setVelocity(world, body, 5, 0, 0);
        AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        // zero body friction → no damping → velocity unchanged.
        expect(body.linearVelocity[0]).toBeCloseTo(5);
    });
});

describe('aabb-physics — restitution combine', () => {
    it('trampoline (block rest=0.8) × body rest=0.5 → 0.4 bounce', () => {
        const { voxels, crashWorld, world } = setupWorld([{ id: 'trampoline', def: { restitution: 0.8 } }]);
        setupFloor(voxels, 'trampoline');
        const body = AabbPhysics.createBody(world, crashWorld, {
            position: [0, 2, 0],
            halfExtents: [0.4, 0.4, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            restitution: 0.5,
            friction: 0,
            gravityFactor: 0,
            linearVelocity: [0, -10, 0],
        });
        // tick enough for body to reach floor and bounce. impact vY = -10,
        // combined e = 0.5 * 0.8 = 0.4 → post-bounce vY = -10 - (0.4 * -10) = -6
        // wait, bounce code does `v -= e * vImpact`. After slideResolve zeroes
        // vY on contact (vY = 0), bounce adds -0.4 * -10 = +4. So vY ≈ +4.
        for (let i = 0; i < 30; i++) AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        expect(body.linearVelocity[1]).toBeGreaterThan(3);
        expect(body.linearVelocity[1]).toBeLessThan(5);
    });

    it('default block restitution = 0 kills bounce even with body rest > 0', () => {
        const { voxels, crashWorld, world } = setupWorld([{ id: 'stone', def: {} }]);
        setupFloor(voxels, 'stone');
        const body = AabbPhysics.createBody(world, crashWorld, {
            position: [0, 2, 0],
            halfExtents: [0.4, 0.4, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            restitution: 1.0,
            friction: 0,
            gravityFactor: 0,
            linearVelocity: [0, -10, 0],
        });
        for (let i = 0; i < 30; i++) AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        // stone rest = 0 → e_combined = 0 → no bounce; vY rests at 0.
        expect(body.linearVelocity[1]).toBeCloseTo(0);
    });

    it('per-axis restitution: trampoline floor bounces Y; X velocity preserved', () => {
        const { voxels, crashWorld, world } = setupWorld([{ id: 'trampoline', def: { restitution: 0.8 } }]);
        setupFloor(voxels, 'trampoline');
        const body = AabbPhysics.createBody(world, crashWorld, {
            position: [0, 2, 0],
            halfExtents: [0.4, 0.4, 0.4],
            motionType: AabbPhysics.MotionType.DYNAMIC,
            restitution: 0.5,
            friction: 0,
            gravityFactor: 0,
            linearVelocity: [3, -10, 0],
        });
        for (let i = 0; i < 30; i++) AabbPhysics.tick(world, crashWorld, 1 / 60, NULL_SINK);
        // Y bounces (positive); X axis never contacted a wall so X velocity unchanged.
        expect(body.linearVelocity[1]).toBeGreaterThan(3);
        expect(body.linearVelocity[0]).toBeCloseTo(3);
    });
});
