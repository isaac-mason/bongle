// Typechecked snippets for Physics & movement.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import type { Node } from 'bongle';
import type { Vec3 } from 'mathcat';
import {
    addChild,
    addTrait,
    COLLISION_GROUP_CHARACTERS,
    ContactsTrait,
    createNode,
    defineCollisionGroups,
    destroyNode,
    env,
    exceptGroups,
    log,
    MotionType,
    OBJECT_LAYER_NODE_MOVING,
    onInit,
    onlyGroups,
    onPostPhysicsStep,
    PlayerTrait,
    query,
    RigidBodyTrait,
    script,
    setPosition,
    trait,
    TransformTrait,
    WorldTrait,
} from 'bongle';
import { box, rigidBody } from 'crashcat';

/* SNIPPET_START: drop-body */
// a dynamic body is a node with a RigidBodyTrait. assign its `def` to build one.
script(WorldTrait, 'drop-ball', (ctx) => {
    if (!env.server) return; // spawn on the server; physics replicates to clients

    onInit(ctx, () => {
        const ball = createNode({ name: 'ball' });
        const transform = addTrait(ball, TransformTrait);
        setPosition(transform, [0, 15, 0]);

        const bodyTrait = addTrait(ball, RigidBodyTrait);
        bodyTrait.def = { shape: { type: 'sphere', radius: 0.5 }, restitution: 0.4, friction: 0.5 };

        addChild(ctx.node, ball);
    });
});
/* SNIPPET_END: drop-body */

/* SNIPPET_START: adopt-body */
// "adopt mode": leave `def` null and hand the trait a crashcat body you built
// yourself, for shapes or settings the declarative def does not expose. the trait
// replicates it and tears it down on dispose, just as if it had built it.
script(WorldTrait, 'custom-body', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const crate = createNode({ name: 'crate' });
        addTrait(crate, TransformTrait); // the body's transform syncs onto this node

        const body = rigidBody.create(ctx.physics.rigid.world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.DYNAMIC,
            position: [0, 12, 0],
            restitution: 0.4,
        });

        const bodyTrait = addTrait(crate, RigidBodyTrait); // def stays null
        bodyTrait.body = body; // adopt the body; the trait owns and replicates it from here

        addChild(ctx.node, crate);
    });
});
/* SNIPPET_END: adopt-body */

/* SNIPPET_START: coin-pickup */
// CoinTrait marks a pickup; `value` is how much it is worth.
const CoinTrait = trait('coin', { value: 1 });

// a coin is a static sensor body carrying a ContactsTrait, so players pass
// through it but still register a contact.
function spawnCoin(parent: Node, position: Vec3) {
    const coin = createNode({ name: 'coin' });
    setPosition(addTrait(coin, TransformTrait), position);
    addTrait(coin, CoinTrait);
    addTrait(coin, ContactsTrait);
    addTrait(coin, RigidBodyTrait).def = {
        shape: { type: 'sphere', radius: 0.5 },
        motionType: MotionType.STATIC,
        sensor: true,
    };
    addChild(parent, coin);
}

script(WorldTrait, 'coins', (ctx) => {
    if (!env.server) return; // the server owns pickups

    // per-room running total. factory-scope state lives in this one script
    // instance (one per world node), never module scope, which every room shares.
    let coinsCollected = 0;

    const coins = query(ctx, [CoinTrait, ContactsTrait]);
    const players = query(ctx, [PlayerTrait]);

    onInit(ctx, () => {
        spawnCoin(ctx.node, [2, 1, 0]);
        spawnCoin(ctx.node, [4, 1, 0]);
    });

    // ContactsTrait fills `added` after each physics step; award and despawn any
    // coin a player's body just touched.
    onPostPhysicsStep(ctx, () => {
        const playerNodeIds = new Set<number>();
        for (const [player] of players) playerNodeIds.add(player._node.id);

        for (const [coin, contacts] of coins) {
            const touchedByPlayer = contacts.added.some(
                (c) => c.type === 'rigidBody' && playerNodeIds.has(c.nodeId),
            );
            if (touchedByPlayer) {
                coinsCollected += coin.value;
                log(ctx, `coin collected (total ${coinsCollected})`);
                destroyNode(coin._node);
            }
        }
    });
});
/* SNIPPET_END: coin-pickup */

/* SNIPPET_START: collision-groups */
// declare a game's groups once, in a fixed order. each name gets a bit above the
// engine-reserved range; assignment is positional, so it is identical on every
// side (groups are not synced, so never build the list conditionally).
const Groups = defineCollisionGroups('enemies', 'pickups');

script(WorldTrait, 'group-demo', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        // an enemy ignores other enemies but still collides with the world and
        // everything else. `exceptGroups` = "collide with all but these".
        const enemy = createNode({ name: 'enemy' });
        setPosition(addTrait(enemy, TransformTrait), [0, 5, 0]);
        addTrait(enemy, RigidBodyTrait).def = {
            shape: { type: 'sphere', radius: 0.4 },
            collisionGroups: Groups.enemies,
            collisionMask: exceptGroups(Groups.enemies),
        };
        addChild(ctx.node, enemy);

        // a pickup only reacts to characters (players / npcs), nothing else.
        // `onlyGroups` = "collide with only these".
        const pickup = createNode({ name: 'pickup' });
        setPosition(addTrait(pickup, TransformTrait), [2, 1, 0]);
        addTrait(pickup, RigidBodyTrait).def = {
            shape: { type: 'sphere', radius: 0.5 },
            motionType: MotionType.STATIC,
            sensor: true,
            collisionGroups: Groups.pickups,
            collisionMask: onlyGroups(COLLISION_GROUP_CHARACTERS),
        };
        addChild(ctx.node, pickup);
    });
});
/* SNIPPET_END: collision-groups */
