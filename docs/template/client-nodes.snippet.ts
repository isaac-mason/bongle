// Typechecked snippets for Multiplayer — client-only nodes.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    addChild,
    addTrait,
    createNode,
    findChildByName,
    HtmlTrait,
    onFrame,
    PlayerTrait,
    script,
    setPosition,
    TransformTrait,
} from 'bongle';

/* SNIPPET_START: client-node */
// give every player a name tag, built and kept entirely on the client.
// (minimalized from wizard-game's wizard nameplate.)
script(PlayerTrait, 'nameplate', (ctx) => {
    if (!ctx.client) return; // a local visual; this never runs on the server

    onFrame(ctx, () => {
        // create the child once, idempotently, since onFrame runs every frame
        if (findChildByName(ctx.node, 'nameplate')) return;

        // realm 'client': lives on this client alone, never replicated or serialized.
        // as a child of the shared player node it rides the player's transform and is
        // removed automatically when the player leaves.
        const plate = createNode({ realm: 'client', name: 'nameplate' });
        setPosition(addTrait(plate, TransformTrait), [0, 3.1, 0]);

        // a screen-space DOM overlay at constant css size (distanceFactor null), so it
        // stays readable at any distance instead of shrinking like a world quad.
        const html = addTrait(plate, HtmlTrait, { mode: 'screen', center: true, distanceFactor: null });
        if (html.element) {
            html.element.textContent = ctx.trait.username;
            html.element.style.cssText = 'color:#fff; font:bold 12px ui-monospace, monospace; pointer-events:none;';
        }
        addChild(ctx.node, plate);
    });
});
/* SNIPPET_END: client-node */
