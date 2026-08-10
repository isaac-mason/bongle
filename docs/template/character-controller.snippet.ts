// Typechecked snippets for the character controller — driving, launching, respawning.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    CharacterControllerTrait,
    env,
    getTrait,
    getWorldPosition,
    type Node,
    onTick,
    script,
    setPosition,
    TransformTrait,
} from 'bongle';
import { type Vec3, vec3 } from 'mathcat';

/* SNIPPET_START: launch */
// launching a character is just writing its velocity. this is THE knob for jump
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

// a jump pad: when our player stands on the pad tile, fling them straight up.
// actor-style — one instance per node carrying a CharacterControllerTrait.
script(CharacterControllerTrait, 'jump-pad', (ctx) => {
    if (!env.server) return; // launch on the server; the result replicates

    const transform = getTrait(ctx.node, TransformTrait);
    if (!transform) return;

    onTick(ctx, () => {
        const pos = getWorldPosition(transform);
        const onPad = pos[0] > -1 && pos[0] < 1 && pos[2] > -1 && pos[2] < 1;
        if (onPad && ctx.trait.state.grounded) launch(ctx.node, [0, 14, 0]);
    });
});
/* SNIPPET_END: launch */

/* SNIPPET_START: respawn */
// respawn: teleport the feet and zero velocity so accumulated fall speed doesn't
// carry into the new position and immediately fling the player off it.
export function respawn(node: Node, feet: Vec3): void {
    const transform = getTrait(node, TransformTrait);
    const controller = getTrait(node, CharacterControllerTrait);
    if (transform) setPosition(transform, feet);
    if (controller) vec3.set(controller.state.velocity, 0, 0, 0);
}
/* SNIPPET_END: respawn */
