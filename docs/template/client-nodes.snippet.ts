// Typechecked snippets for Multiplayer — client-only nodes.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { addChild, addTrait, CanvasTrait, createNode, findChildByName, onFrame, PlayerTrait, script, setPosition, TransformTrait } from 'bongle';

/* SNIPPET_START: client-node */
// give every player a client-only name tag, built and kept entirely on the client
script(PlayerTrait, 'nametag', (ctx) => {
    if (!ctx.client) return; // a local visual; this never runs on the server

    onFrame(ctx, () => {
        // client scripts run every frame, so create the child once, idempotently
        if (findChildByName(ctx.node, 'nametag')) return;

        // realm 'client': lives on this client alone, never replicated or serialized.
        // as a child of the shared player node it rides the player's transform and is
        // removed automatically when the player leaves.
        const tag = createNode({ realm: 'client', name: 'nametag' });
        setPosition(addTrait(tag, TransformTrait), [0, 2.2, 0]);
        addTrait(tag, CanvasTrait, { mode: 'y-billboard', worldScale: 1 / 64 });
        addChild(ctx.node, tag);
        // then paint its canvas to draw the player's name
    });
});
/* SNIPPET_END: client-node */
