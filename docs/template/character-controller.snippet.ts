// Typechecked snippets for the character controller: respawning. Compiles
// against `bongle`; regions are pulled into docs.md by build.js. (Launch pads
// live in recipe-launch-pad.snippet.ts.)

import { CharacterControllerTrait, getTrait, type Node, setPosition, TransformTrait } from 'bongle';
import { type Vec3, vec3 } from 'mathcat';

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
