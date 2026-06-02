import { box, createWorld, MotionType, registerAllShapes, rigidBody, sphere } from 'crashcat';
import type { Box3, Vec3 } from 'mathcat';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBodyCandidateGather, gatherBodyCandidates } from './body-shape-sweep';
import { OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_VOXELS, settings as physicsSettings } from './physics';

beforeAll(() => {
    registerAllShapes();
});

function makeWorld() {
    return createWorld(physicsSettings);
}

const SWEEP_BOUNDS: Box3 = [-10, -10, -10, 10, 10, 10];
const NO_DISP: Vec3 = [0, 0, 0];

describe('body-shape-sweep', () => {
    it('emits a candidate for a box body', () => {
        const world = makeWorld();
        const body = rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.STATIC,
            position: [2, 0, 0],
        });

        const gather = createBodyCandidateGather(world);
        const out = gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, -1);

        expect(out).toHaveLength(1);
        expect(out[0]!.bodyId).toBe(body.id);
        expect(out[0]!.body).toBe(body);
    });

    it('emits a candidate for a sphere body', () => {
        const world = makeWorld();
        const body = rigidBody.create(world, {
            shape: sphere.create({ radius: 0.5 }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.STATIC,
            position: [3, 0, 0],
        });

        const gather = createBodyCandidateGather(world);
        const out = gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, -1);

        expect(out).toHaveLength(1);
        expect(out[0]!.bodyId).toBe(body.id);
        expect(out[0]!.body).toBe(body);
    });

    it('excludes the body matching selfBodyId', () => {
        const world = makeWorld();
        const self = rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.KINEMATIC,
            position: [0, 0, 0],
        });
        const other = rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.STATIC,
            position: [3, 0, 0],
        });

        const gather = createBodyCandidateGather(world);
        const out = gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, self.id);

        expect(out).toHaveLength(1);
        expect(out[0]!.bodyId).toBe(other.id);
    });

    it('excludes voxel-layer bodies via the layer filter', () => {
        const world = makeWorld();
        rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_VOXELS,
            motionType: MotionType.STATIC,
            position: [2, 0, 0],
        });
        const want = rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.STATIC,
            position: [-2, 0, 0],
        });

        const gather = createBodyCandidateGather(world);
        const out = gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, -1);

        expect(out).toHaveLength(1);
        expect(out[0]!.bodyId).toBe(want.id);
    });

    it('clears out array between calls', () => {
        const world = makeWorld();
        rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.STATIC,
            position: [0, 0, 0],
        });

        const gather = createBodyCandidateGather(world);
        gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, -1);
        const out2 = gatherBodyCandidates(gather, world, SWEEP_BOUNDS, NO_DISP, -1);

        expect(out2).toHaveLength(1);
    });
});
