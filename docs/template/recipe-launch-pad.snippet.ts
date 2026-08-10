// Recipe: launch pads. The `launch` helper is the whole trick (write the
// controller's velocity); the two builds differ only in how a pad is detected,
// as a voxel block or as a placed node. Compiles against `bongle`; regions are
// pulled into docs.md by build.js.

import {
    addChild,
    addTrait,
    asset,
    block,
    CharacterControllerTrait,
    cloneModel,
    ContactsTrait,
    createPrefab,
    env,
    getTrait,
    model,
    MotionType,
    type Node,
    onInit,
    onPostPhysicsStep,
    onTick,
    PlayerTrait,
    prefab,
    query,
    RigidBodyTrait,
    setPosition,
    stateToBlock,
    system,
    trait,
    TransformTrait,
} from 'bongle';
import { blockSoundPresets, blockTextures } from 'bongle/kit';
import { type Vec3, vec3 } from 'mathcat';

/* SNIPPET_START: launch */
// launching a character is just writing its velocity. this is THE knob for launch
// pads, dashes, explosion knockback, and grappling yanks: you add to
// state.velocity and the controller integrates it next tick. add (don't overwrite)
// so successive launches stack (chained rocket jumps), and clear `grounded` so
// ground friction doesn't eat a horizontal kick the same tick.
export function launch(node: Node, impulse: Vec3): void {
    const controller = getTrait(node, CharacterControllerTrait);
    if (!controller) return;
    vec3.add(controller.state.velocity, controller.state.velocity, impulse);
    controller.state.grounded = false;
}
/* SNIPPET_END: launch */

/* SNIPPET_START: launch-pad-block */
// a launch pad block. place LaunchPadBlock anywhere in the voxel grid and every
// cell of it becomes a pad, no per-pad wiring. the controller already samples
// the block under the feet each tick and exposes it as `state.groundBlockState`
// (the standing block's state id when grounded).
const LaunchPadBlock = block('demo:launch_pad', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.slime } } }),
    sounds: blockSoundPresets.grass,
});

system('launch-pad-block', (ctx) => {
    if (!env.server) return; // launch on the server; the result replicates

    const characters = query(ctx, [CharacterControllerTrait]);

    onTick(ctx, () => {
        for (const [controller] of characters) {
            if (!controller.state.grounded) continue;
            // resolve the state id back to the block that owns it, then compare
            // by block identity. this matches EVERY state of the pad (rotations,
            // variants, on/off) — not just one exact `defaultId()` — so it stays
            // correct the moment the pad grows block-states. this is the way.
            if (stateToBlock(ctx.blocks, controller.state.groundBlockState) === LaunchPadBlock) {
                launch(controller._node, [0, 14, 0]);
            }
        }
    });
});
/* SNIPPET_END: launch-pad-block */

/* SNIPPET_START: launch-pad-node */
// a launch pad node. use this when the pad is an object rather than terrain,
// floating off the grid, or moving. a prefab bundles the model, a static sensor
// box, and its traits into one placeable template. each instance reads its OWN
// contacts and flings any player body that enters, matched by nodeId.
const LaunchPadModel = model('launch-pad', { src: asset('./assets/launch-pad.glb', import.meta.url) });
const LaunchPadTrait = trait('launch-pad');

const LaunchPadPrefab = prefab('launch-pad', {
    type: 'nodes',
    deps: [LaunchPadModel],
    fn: (ctx) => {
        const pad = cloneModel(LaunchPadModel.scene);
        const body = addTrait(pad, RigidBodyTrait);
        body.def = {
            shape: { type: 'box', halfExtents: [1, 0.25, 1] },
            motionType: MotionType.STATIC,
            sensor: true,
        };
        addTrait(pad, LaunchPadTrait);
        addTrait(pad, ContactsTrait);
        addChild(ctx.scene, pad);
    },
});

system('launch-pad-node', (ctx) => {
    if (!env.server) return;

    const pads = query(ctx, [LaunchPadTrait, ContactsTrait]);
    const players = query(ctx, [PlayerTrait]);

    onInit(ctx, () => {
        // createPrefab returns a detached anchor; position it and attach.
        const pad = createPrefab(ctx, LaunchPadPrefab);
        setPosition(addTrait(pad, TransformTrait), [4, 1, 4]);
        addChild(ctx.node, pad);
    });

    // ContactsTrait fills `added` after each physics step; fling any player whose
    // body just entered a pad's sensor.
    onPostPhysicsStep(ctx, () => {
        const playerByNodeId = new Map<number, Node>();
        for (const [player] of players) playerByNodeId.set(player._node.id, player._node);

        for (const [, contacts] of pads) {
            for (const c of contacts.added) {
                if (c.type !== 'rigidBody') continue;
                const player = playerByNodeId.get(c.nodeId);
                if (player) launch(player, [0, 14, 0]);
            }
        }
    });
});
/* SNIPPET_END: launch-pad-node */
