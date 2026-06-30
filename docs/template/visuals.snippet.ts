// Typechecked snippets for Rendering & visuals.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    CameraTrait,
    configureFloodFillLighting,
    ENVIRONMENT_OVERWORLD,
    getTrait,
    onInit,
    particle,
    particleUpdate,
    script,
    setEnvironment,
    spawnParticle,
    sprite,
    WorldTrait,
} from 'bongle';

/* SNIPPET_START: camera */
// the room already has a camera node; read its CameraTrait to set field of view
script(WorldTrait, 'camera-setup', (ctx) => {
    onInit(ctx, () => {
        if (!ctx.client) return;
        const camera = getTrait(ctx.client.camera, CameraTrait);
        if (camera) camera.fov = (60 * Math.PI) / 180;
    });
});
/* SNIPPET_END: camera */

/* SNIPPET_START: lighting */
// sky preset + voxel flood-fill lighting, set once on the world
script(
    WorldTrait,
    'lighting',
    (ctx) => {
        onInit(ctx, () => {
            setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
            if (ctx.server) configureFloodFillLighting(ctx, { enabled: true, minLevel: 4 });
        });
    },
    { editor: true },
);
/* SNIPPET_END: lighting */

/* SNIPPET_START: particles */
// a particle type pairs a sprite with a motion update
const SmokeSprite = sprite('smoke', { src: new URL('./assets/smoke.png', import.meta.url) });
const SmokeParticle = particle('smoke', {
    sprite: SmokeSprite,
    playback: 'stretch',
    update: particleUpdate.smoke,
});

script(WorldTrait, 'smoke-puffs', (ctx) => {
    onInit(ctx, () => {
        // emit one at a position; no-ops on the server
        spawnParticle(ctx, SmokeParticle, [0, 2, 0]);
    });
});
/* SNIPPET_END: particles */
