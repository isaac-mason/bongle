// sprites and particles example: three zones side by side, each isolating one
// visual primitive so they can be eyeballed independently.
//
//   left   (x from -6 to -2)  three SpriteTrait quads in billboard,
//                             y-billboard and world modes, all the same
//                             kit:smoke sprite. Shows how the orientation flag
//                             alone changes the quad's relationship to the camera.
//   middle (x=0)              a single ExtrudedSpriteMeshTrait slowly spinning
//                             on Y so the per-pixel extrusion is unmistakable.
//                             The back face vanishes when viewed edge-on.
//   right  (x from 4 to 6)    a tick-rate particle emitter spawning kit:smoke
//                             puffs from a fixed world point. Exercises
//                             spawnParticle and the particleUpdate.smoke rise.
//
// Everything uses bundled bongle/kit sprites, so the example ships no PNGs of
// its own.

import {
    addChild,
    addTrait,
    BLOCK_AIR,
    CharacterControllerTrait,
    config,
    createNode,
    ExtrudedSpriteMeshTrait,
    env,
    getTrait,
    onFrame,
    onInit,
    onJoin,
    type ParticleOptions,
    particleUpdate,
    SpriteTrait,
    scene,
    script,
    setBlock,
    setCharacterLook,
    setPosition,
    setQuaternion,
    spawnParticle,
    TransformTrait,
    trait,
} from 'bongle';
import { blocks, sprites } from 'bongle/kit';
import { quat } from 'math';

config({ server: { maxPlayers: 1 } });

const SpritesDemoTrait = trait('sprites-demo');

// Server: terrain and spawn.
script(SpritesDemoTrait, 'spawn', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        // 32 by 16 stone slab so the player can walk between zones without
        // falling. Zones span x from -8 to 8, depth z from -4 to 4.
        const halfX = 16;
        const halfZ = 8;
        for (let wx = -halfX; wx <= halfX; wx++) {
            for (let wz = -halfZ; wz <= halfZ; wz++) {
                setBlock(ctx.voxels, wx, 0, wz, blocks.stone.defaultKey());
                for (let dy = 1; dy <= 4; dy++) {
                    setBlock(ctx.voxels, wx, dy, wz, BLOCK_AIR);
                }
            }
        }
    });

    onJoin(ctx, ({ playerNode }) => {
        const t = getTrait(playerNode, TransformTrait)!;
        // stand a few steps back on -z so all three zones are in front.
        setPosition(t, [0, 1, -6]);
        const cc = getTrait(playerNode, CharacterControllerTrait)!;
        // face +Z so the zones (placed at z=2) are straight ahead.
        setCharacterLook(cc, Math.PI);
    });
});

// Client: zones and emitter.
const SPIN_SPEED = 0.6; // radians per second for the extruded mesh
const EMITTER_POS: [number, number, number] = [6, 1.5, 2];

const SPAWNS_PER_SEC = 12; // tick-rate emission, light enough to read
const PUFF_LIFETIME = 1.8; // seconds, long enough to see the rise

// one hoisted spawn drives every puff; spawnParticle copies each field eagerly.
const _puffSpawn: ParticleOptions = {
    sprite: sprites.smoke,
    update: particleUpdate.smoke,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    lifetime: PUFF_LIFETIME,
    size: 0.1,
};

script(SpritesDemoTrait, 'demo', (ctx) => {
    if (!env.client) return;

    const _qSpin = quat.create();
    let spinAngle = 0;
    let extrudedTransform: TransformTrait | null = null;
    let spawnAccum = 0;

    onInit(ctx, () => {
        // Left: SpriteTrait in 3 modes. Same sprite, same size, same world
        // position pattern; only the `mode` differs. Walk around them:
        // 'billboard' tracks fully, 'y-billboard' tracks only on yaw (tilts as
        // you change pitch), and 'world' stays anchored to its local quaternion.
        const modes: Array<['billboard' | 'y-billboard' | 'world', number]> = [
            ['billboard', -6],
            ['y-billboard', -4],
            ['world', -2],
        ];
        for (const [mode, x] of modes) {
            const node = createNode({ name: `sprite-${mode}`, persist: false });
            setPosition(addTrait(node, TransformTrait), [x, 1.5, 2]);
            addTrait(node, SpriteTrait, {
                sprite: sprites.smoke,
                mode,
                width: 16,
                height: 16,
            });
            addChild(ctx.node, node);
        }

        // Middle: ExtrudedSpriteMeshTrait, spinning. depth=4 source pixels so
        // the extrusion reads clearly. Spins on Y in onFrame below.
        const extruded = createNode({ name: 'extruded', persist: false });
        extrudedTransform = addTrait(extruded, TransformTrait);
        setPosition(extrudedTransform, [0, 1.5, 2]);
        addTrait(extruded, ExtrudedSpriteMeshTrait, {
            sprite: sprites.smoke,
            depth: 4,
        });
        addChild(ctx.node, extruded);

        // Right: emitter marker, just a static SpriteTrait so you can see where
        // particles are spawning from.
        const marker = createNode({ name: 'emitter-marker', persist: false });
        setPosition(addTrait(marker, TransformTrait), [EMITTER_POS[0], 0.5, EMITTER_POS[2]]);
        addTrait(marker, SpriteTrait, {
            sprite: sprites.dust,
            mode: 'billboard',
            width: 8,
            height: 8,
        });
        addChild(ctx.node, marker);
    });

    onFrame(ctx, ({ delta }) => {
        // spin the extruded mesh on Y.
        if (extrudedTransform) {
            spinAngle += delta * SPIN_SPEED;
            quat.setAxisAngle(_qSpin, [0, 1, 0], spinAngle);
            setQuaternion(extrudedTransform, _qSpin);
        }

        // accumulate fractional spawns so the per-second rate is stable
        // regardless of frame time.
        spawnAccum += delta * SPAWNS_PER_SEC;
        while (spawnAccum >= 1) {
            spawnAccum -= 1;
            // tiny jitter on x/z so the column isn't a perfect line.
            const jx = (Math.random() - 0.5) * 0.25;
            const jz = (Math.random() - 0.5) * 0.25;
            // Initial upward kick. particleUpdate.smoke only applies a gentle
            // buoyancy (g=0.4) under heavy drag (0.96), so without a launch
            // velocity puffs barely move. Tiny lateral spread for shape.
            const position = _puffSpawn.position;
            position[0] = EMITTER_POS[0] + jx;
            position[1] = EMITTER_POS[1];
            position[2] = EMITTER_POS[2] + jz;
            const velocity = _puffSpawn.velocity!;
            velocity[0] = (Math.random() - 0.5) * 1.2;
            velocity[1] = 2.8 + Math.random() * 0.8;
            velocity[2] = (Math.random() - 0.5) * 1.2;
            spawnParticle(ctx, _puffSpawn);
        }
    });
});
