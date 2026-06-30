// Typechecked snippets for Assets.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { block, blockTexture, draw, model, sound, sprite, use } from 'bongle';

/* SNIPPET_START: declare */
// declare each asset once at module scope; the handle is what you reference
// src is a `new URL('./file', import.meta.url)`, so each asset co-locates with the
// module that declares it and survives bundling (a plain project-root path also works)
const MascotModel = model('mascot', { src: new URL('./assets/mascot.gltf', import.meta.url) });
const ChimeSound = sound('chime', { src: new URL('./assets/chime.ogg', import.meta.url) });
const MarbleBlockTexture = blockTexture('marble', { src: new URL('./assets/marble.png', import.meta.url) });
const SmokeSprite = sprite('smoke', { src: new URL('./assets/smoke.png', import.meta.url) });

// a block texture feeds a block model
const MarbleBlock = block('guide:marble', {
    name: 'Marble',
    model: () => ({ type: 'cube', textures: { all: { texture: MarbleBlockTexture } } }),
});

// keep handles that nothing else references in code alive through bundling
use(MascotModel, ChimeSound, SmokeSprite, MarbleBlock);
/* SNIPPET_END: declare */

/* SNIPPET_START: procedural */
// a texture's src can be a draw() descriptor that paints the image at bake time,
// instead of loading a file
const CheckerBlockTexture = blockTexture('checker', {
    src: draw(
        (c) => {
            c.fillStyle = '#222';
            c.fillRect(0, 0, 16, 16);
            c.fillStyle = '#eee';
            c.fillRect(0, 0, 8, 8);
            c.fillRect(8, 8, 8, 8);
        },
        { size: [16, 16] },
    ),
});
use(CheckerBlockTexture);
/* SNIPPET_END: procedural */
