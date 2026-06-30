// Typechecked snippets for UI.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { onInit, script, WorldTrait } from 'bongle';

/* SNIPPET_START: hud */
// append a screen-space overlay to the room's viewport (client only)
script(WorldTrait, 'hud', (ctx) => {
    onInit(ctx, () => {
        if (!ctx.client) return;
        const hud = document.createElement('div');
        hud.textContent = 'Score: 0';
        hud.style.pointerEvents = 'none';
        ctx.client.viewport.appendChild(hud);
    });
});
/* SNIPPET_END: hud */
