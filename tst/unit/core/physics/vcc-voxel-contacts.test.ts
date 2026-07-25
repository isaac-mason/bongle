import { box, MotionType, registerAllShapes, rigidBody } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContactsTrait } from '../../../../src/builtins/contacts';
import * as Physics from '../../../../src/core/physics/physics';
import { objectLayerForMotionType } from '../../../../src/core/physics/rigid/rigid-world';
import { addChild, addTrait, createNode, createSceneTree, getTrait } from '../../../../src/core/scene/scene-tree';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createVoxels } from '../../../../src/core/voxels/voxels';

// The character VCC sweeps voxels itself, outside the rigid solver's manifold
// path, so its terrain contacts never reach the contact fan-out on their own.
// `pushVccVoxelContact` stages them and `ingestVccVoxelContacts` (run inside
// Physics.tick's contacts frame) replays them into the shared stream so they
// fan out to the character node's ContactsTrait as VoxelContacts. These tests
// drive that whole path through the coordinator.

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

/** minimal coordinator with one character-like node that owns a kinematic box
 *  body (standing in for a VCC inner body), mapped so contacts resolve to it. */
function setup() {
    const registry = buildTestRegistry([{ id: 'lava', texId: 'white' }]);
    const voxels = createVoxels(registry);

    const sceneTree = createSceneTree();
    const player = createNode({ name: 'player', persist: false });
    addChild(sceneTree.root, player);
    // fan-out only visits nodes with a ContactsTrait; add it before init so the
    // coordinator's query includes the node.
    addTrait(player, ContactsTrait);

    const physics = Physics.init(sceneTree, voxels, registry);

    // stands in for the VCC's kinematic inner body, registered so resolveSide
    // maps it back to `player`.
    const body = rigidBody.create(physics.rigid.world, {
        shape: box.create({ halfExtents: [0.3, 0.9, 0.3] }),
        objectLayer: objectLayerForMotionType(MotionType.KINEMATIC),
        motionType: MotionType.KINEMATIC,
        position: [0.5, 5, 0.5],
    });
    physics.rigid.nodeToBody.set(player.id, body.id);
    physics.rigid.bodyToNode.set(body.id, player.id);

    return { sceneTree, physics, player, body };
}

const voxelContacts = (_physics: Physics.Physics, player: ReturnType<typeof setup>['player']) =>
    getTrait(player, ContactsTrait)!.active.filter((c) => c.type === 'voxel');

describe('vcc voxel contacts -> ContactsTrait', () => {
    it('a staged VCC voxel contact fans out to the node as a VoxelContact', () => {
        const { sceneTree, physics, player, body } = setup();

        // the character is standing on the lava block at (3, 4, 7); surface->
        // character normal points up.
        Physics.pushVccVoxelContact(physics, body.id, 3, 4, 7, /* stateId */ 42, /* subAabbIndex */ -1, 0.5, 4, 0.5, 0, 1, 0, /* penetration */ 0);

        Physics.tick(physics, sceneTree, 1 / 60);

        const found = voxelContacts(physics, player);
        expect(found).toHaveLength(1);

        const c = found[0]!;
        if (c.type !== 'voxel') throw new Error('unreachable');
        expect(c.voxelX).toBe(3);
        expect(c.voxelY).toBe(4);
        expect(c.voxelZ).toBe(7);
        expect(c.stateId).toBe(42);
        // ContactsTrait normal points AWAY from the observer (the character);
        // for a floor you stand on, that is downward.
        expect(c.normal[1]).toBeLessThan(0);
    });

    it('no staged contact -> no voxel contacts', () => {
        const { sceneTree, physics, player } = setup();
        Physics.tick(physics, sceneTree, 1 / 60);
        expect(voxelContacts(physics, player)).toHaveLength(0);
    });

    it('the staging buffer is drained each tick (no stale carry-over)', () => {
        const { sceneTree, physics, player, body } = setup();

        Physics.pushVccVoxelContact(physics, body.id, 3, 4, 7, 42, -1, 0.5, 4, 0.5, 0, 1, 0, 0);
        Physics.tick(physics, sceneTree, 1 / 60);
        expect(voxelContacts(physics, player)).toHaveLength(1);

        // second tick with nothing staged: the contact is gone.
        Physics.tick(physics, sceneTree, 1 / 60);
        expect(voxelContacts(physics, player)).toHaveLength(0);
    });
});
