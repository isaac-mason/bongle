// Typechecked snippets for Models & characters.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    Animation,
    AnimatorTrait,
    addChild,
    cloneModel,
    findByName,
    getTrait,
    model,
    onInit,
    onPostAnimate,
    setPosition,
    system,
    TransformTrait,
} from 'bongle';

/* SNIPPET_START: place-model */
// declare a model from a glTF at module scope
const ChestModel = model('chest', { src: new URL('./assets/chest.gltf', import.meta.url) });

system('place-chest', (ctx) => {
    onInit(ctx, () => {
        // clone the model's scene and attach it; cloneModel installs the
        // render slot a visible subtree needs
        const chest = cloneModel(ChestModel.scene);
        addChild(ctx.node, chest);
    });
});
/* SNIPPET_END: place-model */

/* SNIPPET_START: reference-node */
// a model's named glTF nodes are reachable on the placed clone by name, so you can
// drive a sub-part from code: open a lid, mount an item on a hand, attach an effect.
system('open-chest', (ctx) => {
    onInit(ctx, () => {
        const chest = cloneModel(ChestModel.scene);
        addChild(ctx.node, chest);

        const lid = findByName(chest, 'lid');
        if (lid) {
            const lidTransform = getTrait(lid, TransformTrait);
            if (lidTransform) setPosition(lidTransform, [0, 0.4, -0.4]); // swing the lid up and back
        }
    });
});
/* SNIPPET_END: reference-node */

/* SNIPPET_START: animate */
// any glTF that ships clips can be animated, not just characters. bongle plays the
// glTF's TRS tracks (node translation/rotation/scale). there is no skinning.
const CrabModel = model('crab', { src: new URL('./assets/crab.gltf', import.meta.url) });

system('crab-anim', (ctx) => {
    onInit(ctx, () => {
        const node = cloneModel(CrabModel.scene);
        addChild(ctx.node, node);

        const animator = getTrait(node, AnimatorTrait);
        if (!animator) return;

        // resolve clips to actions, then blend from idle into scuttle
        const idle = Animation.clip(animator, CrabModel.animations.idle);
        const scuttle = Animation.clip(animator, CrabModel.animations.scuttle);
        Animation.play(idle);
        Animation.crossFadeTo(idle, scuttle, 0.3);
    });
});
/* SNIPPET_END: animate */

/* SNIPPET_START: procedural */
system('head-look', (ctx) => {
    // fires after the animator samples this tick's clips, before world matrices
    // recompute: write bone local TRS here to layer a head-look, spring, or
    // joint clamp on top of the sampled pose instead of being overwritten by it
    onPostAnimate(ctx, () => {
        // e.g. findByName(ctx.node, 'head') and nudge its local rotation
    });
});
/* SNIPPET_END: procedural */
