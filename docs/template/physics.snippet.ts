// Typechecked snippets for Physics & movement.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import type { Node } from 'bongle';
import {
    addChild,
    addTrait,
    ContactsTrait,
    createNode,
    destroyNode,
    env,
    log,
    MotionType,
    onInit,
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

/* SNIPPET_START: drop-body */
// a dynamic body is a node with a RigidBodyTrait. assign its `def` to build one.
script(WorldTrait, 'drop-ball', (ctx) => {
    if (!env.server) return; // spawn on the server; physics replicates to clients

    onInit(ctx, () => {
        const ball = createNode({ name: 'ball' });
        const transform = addTrait(ball, TransformTrait);
        setPosition(transform, [0, 15, 0]);

        const rb = addTrait(ball, RigidBodyTrait);
        rb.def = { shape: { type: 'sphere', radius: 0.5 }, restitution: 0.4, friction: 0.5 };

        addChild(ctx.node, ball);
    });
});
/* SNIPPET_END: drop-body */

/* SNIPPET_START: coin-pickup */
// CoinTrait marks a pickup; `value` is how much it is worth.
const CoinTrait = trait('coin', { value: 1 });

// a coin is a static sensor body carrying a ContactsTrait, so players pass
// through it but still register a contact.
function spawnCoin(parent: Node, position: [number, number, number]) {
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

let coinsCollected = 0;

script(WorldTrait, 'coins', (ctx) => {
    if (!env.server) return; // the server owns pickups

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
