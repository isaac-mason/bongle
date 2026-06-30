// Typechecked snippets for Math.
// Compiles against `bongle` (+ mathcat); regions are pulled into guide.md by build.js.

import { getTrait, getWorldPosition, onTick, script, setPosition, trait, TransformTrait } from 'bongle';
import { type Vec3, vec3 } from 'mathcat';

const MoverTrait = trait('mover', { speed: 3 });

/* SNIPPET_START: scratch */
script(MoverTrait, 'move-to-target', (ctx) => {
    // scratch buffers live in the script and are reused every tick, so the hot
    // path allocates nothing. the leading underscore marks them as throwaway
    // working memory, not state to read elsewhere.
    const _toTarget: Vec3 = vec3.create();
    const _step: Vec3 = vec3.create();
    const target: Vec3 = [10, 1, 5];

    onTick(ctx, ({ delta }) => {
        const transform = getTrait(ctx.node, TransformTrait);
        if (!transform) return;
        const position = getWorldPosition(transform);

        // step `speed` metres/second toward the target, writing through the
        // scratch buffers instead of allocating a new vector each tick
        vec3.subtract(_toTarget, target, position);
        vec3.normalize(_toTarget, _toTarget);
        vec3.scaleAndAdd(_step, position, _toTarget, ctx.trait.speed * delta);
        setPosition(transform, _step);
    });
});
/* SNIPPET_END: scratch */
