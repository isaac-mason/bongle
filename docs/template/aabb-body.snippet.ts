// Typechecked snippets for Physics & movement — AABB bodies.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { aabbBody, AabbBodyTrait, addChild, addTrait, createNode, env, onInit, onTick, script, setPosition, TransformTrait, WorldTrait } from 'bongle';

/* SNIPPET_START: create */
// spawn a light, axis-aligned mover. no rotation and no full rigid-body solve, so you
// can afford many of them; it still falls under gravity and collides with voxels.
script(WorldTrait, 'spawn-pellet', (ctx) => {
    if (!env.server) return; // the server simulates; AABB bodies replicate to clients

    onInit(ctx, () => {
        const pellet = createNode({ name: 'pellet' });
        setPosition(addTrait(pellet, TransformTrait), [0, 12, 0]);
        addTrait(pellet, AabbBodyTrait, {
            halfExtents: [0.25, 0.25, 0.25],
            linearVelocity: [6, 0, 0], // initial launch; bounces off voxels on impact
            restitution: 0.6,
        });
        addChild(ctx.node, pellet);
    });
});
/* SNIPPET_END: create */

/* SNIPPET_START: drive */
// actor-style: one instance per node carrying an AabbBodyTrait. drive it imperatively
// each tick, where the declarative `linearVelocity` field can't express the logic.
script(AabbBodyTrait, 'hover', (ctx) => {
    if (!env.server) return;

    onTick(ctx, () => {
        const body = ctx.trait.body; // the live AABB body, installed by the first tick
        if (body.position[1] < 3) {
            // push up when it dips too low; setVelocity wakes a sleeping body.
            aabbBody.setVelocity(ctx.physics.aabb, body, 0, 5, 0);
        }
    });
});
/* SNIPPET_END: drive */
