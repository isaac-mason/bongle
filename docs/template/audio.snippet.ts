// Typechecked snippets for Audio.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { asset, onInit, playOnNode, sound, system } from 'bongle';

/* SNIPPET_START: play */
// declare a sound at module scope, then play it following a node
const ChimeSound = sound('chime', { src: asset('./assets/chime.ogg', import.meta.url) });

system('play-chime', (ctx) => {
    onInit(ctx, () => {
        // panner tracks the node each frame; safely no-ops on the server
        playOnNode(ctx, ChimeSound, ctx.node);
    });
});
/* SNIPPET_END: play */
