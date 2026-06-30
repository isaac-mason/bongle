// Typechecked snippets for Players & input — the player controller.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { onInit, PlayerControllerTrait, script } from 'bongle';

/* SNIPPET_START: configure */
// view config is per-client, so configure it on the client. actor-style: one instance
// per PlayerControllerTrait node, gated to our own player.
script(PlayerControllerTrait, 'view-setup', (ctx) => {
    if (!ctx.client || ctx.node !== ctx.client.player) return;

    onInit(ctx, () => {
        ctx.trait.config.perspective = 'third-back';
        ctx.trait.config.thirdPersonDistance = 6;
        ctx.trait.config.fov = (80 * Math.PI) / 180; // radians
    });
});
/* SNIPPET_END: configure */
