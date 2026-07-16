// Typechecked snippets for Rendering & visuals.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    asset,
    CameraTrait,
    configureFloodFillLighting,
    ENVIRONMENT_OVERWORLD,
    getCamera,
    getSubject,
    getTrait,
    type Node,
    onFrame,
    onInit,
    particle,
    particleUpdate,
    type ScriptContext,
    script,
    setEnvironment,
    setSubject,
    spawnParticle,
    sprite,
    system,
    TransformTrait,
    trait,
} from 'bongle';

/* SNIPPET_START: camera */
// the room already has a camera node; read its CameraTrait to set field of view
system('camera-setup', (ctx) => {
    onInit(ctx, () => {
        if (!ctx.client) return;
        const camera = getTrait(ctx.client.camera, CameraTrait);
        if (camera) camera.fov = (60 * Math.PI) / 180;
    });
});
/* SNIPPET_END: camera */

/* SNIPPET_START: subject */
// The subject is the node local input drives and the engine treats as this
// client's point of view (camera + audio). `getSubject(ctx)` returns it; it
// defaults to the player node.
//
// A minimal DIY controller: gate on being the subject, then drive the active
// camera node's transform yourself. Same shape the builtin orbit / fly / player
// controllers use, so you can write bespoke camera behaviour without the engine.
const FollowCam = trait('follow-cam');
script(FollowCam, 'drive', (ctx) => {
    onFrame(ctx, () => {
        if (getSubject(ctx) !== ctx.node) return; // only the active subject drives the view
        const cameraNode = getCamera(ctx); // the active render camera node
        if (!cameraNode) return; // no camera wired (e.g. offline icon render)
        const camera = getTrait(cameraNode, TransformTrait);
        const self = getTrait(ctx.node, TransformTrait);
        if (!camera || !self) return;
        // ...position `camera` relative to `self` here (follow / orbit / first-person).
    });
});

// Possess a node you control: a free-flying spectator / death cam, or a vehicle
// you own. It needs its own controller (like FollowCam above) so your input
// drives it and the camera follows, setSubject alone only redirects input + POV.
// Purely local: never changes ownership or the server-side streaming anchor (the
// player node stays put, so the world keeps streaming around it). To merely VIEW
// something you don't control (another player, a fixed shot), use setCamera
// instead. Restore control with the client's `defaultSubject`.
export function possess(ctx: ScriptContext, node: Node): void {
    setSubject(ctx, node);
}
export function release(ctx: ScriptContext): void {
    if (ctx.client) setSubject(ctx, ctx.client.defaultSubject);
}
/* SNIPPET_END: subject */

/* SNIPPET_START: lighting */
// sky preset + voxel flood-fill lighting, set once on the world
system(
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
const SmokeSprite = sprite('smoke', { src: asset('./assets/smoke.png', import.meta.url) });
const SmokeParticle = particle('smoke', {
    sprite: SmokeSprite,
    playback: 'stretch',
    update: particleUpdate.smoke,
});

system('smoke-puffs', (ctx) => {
    onInit(ctx, () => {
        // emit one at a position; no-ops on the server
        spawnParticle(ctx, SmokeParticle, [0, 2, 0]);
    });
});
/* SNIPPET_END: particles */

/* SNIPPET_START: varied */
// for effects past the presets, write your own update: it runs per live particle each
// tick over a pooled buffer, composing the particleUpdate.* primitives and mutating
// the particle's velocity, size, and tint directly.
const SparkSprite = sprite('spark', { src: asset('./assets/spark.png', import.meta.url) });
const SparkParticle = particle('spark', {
    sprite: SparkSprite,
    playback: 'stretch', // map age across the sprite's frames over the lifetime
    glow: 1, // self-lit, ignores world shadow
    update: (pool, i, dt, voxels) => {
        particleUpdate.gravity(pool, i, dt, -14); // pull down
        particleUpdate.drag(pool, i, dt, 0.98); // air resistance
        particleUpdate.integrate(pool, i, dt); // advance position by velocity
        particleUpdate.collideBounce(pool, i, dt, voxels, 0.3); // bounce off blocks
        particleUpdate.fadeAlpha(pool, i, dt, 1.2); // fade the alpha out over time
        pool.size[i]! *= 0.99; // shrink a little each tick
    },
});

system('sparks', (ctx) => {
    onInit(ctx, () => {
        // a scattered burst: randomize each particle's velocity, lifetime, and size at
        // spawn so no two move alike.
        for (let n = 0; n < 24; n++) {
            spawnParticle(ctx, SparkParticle, [0, 3, 0], {
                velX: (Math.random() - 0.5) * 6,
                velY: Math.random() * 8,
                velZ: (Math.random() - 0.5) * 6,
                lifetime: 0.6 + Math.random() * 0.6,
                size: 0.2 + Math.random() * 0.2,
            });
        }
    });
});
/* SNIPPET_END: varied */
