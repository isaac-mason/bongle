// audio example: the script-facing audio API.
//
//   1. playMono            non-positional one-shot, like a UI ding or music.
//   2. playMono + detune   pitch-shift a clip with a single option.
//   3. playOnNode + loop   spatial source that follows a moving node; the
//                          panner refreshes every frame from the node's
//                          world transform.
//   4. PlaybackHandle      imperative handle for setVolume and stop with fade.
//
// Every clip comes from sounds.* in bongle/kit, so the example ships no audio
// assets of its own. Same for the Stone block and Spark model used as the
// orbiter visual.
//
// The browser tab must be focused and clicked once before audio plays, because
// AudioContext needs a user gesture before it can output anything. The runtime
// resumes it on the first play call.

import {
    addChild,
    addTrait,
    BLOCK_AIR,
    CharacterControllerTrait,
    setCharacterLook,
    cloneModel,
    createNode,
    env,
    getTrait,
    HtmlTrait,
    isKeyJustDown,
    matchmaking,
    onDispose,
    onFrame,
    onInit,
    onJoin,
    type PlaybackHandle,
    playAt,
    playMono,
    playOnNode,
    type ScriptContext,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
} from 'bongle';
import { blocks, models, sounds } from 'bongle/kit';

matchmaking({ maxPlayers: 1 });

const ExampleTrait = trait('example');

script(ExampleTrait, 'spawn', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        // 32 by 32 stone slab around spawn, wide enough to walk away from the
        // orbiter and hear the panning shift.
        const half = 16;
        for (let wx = -half; wx <= half; wx++) {
            for (let wz = -half; wz <= half; wz++) {
                setBlock(ctx.voxels, wx, 0, wz, blocks.stone.defaultKey());
                for (let dy = 1; dy <= 3; dy++) {
                    setBlock(ctx.voxels, wx, dy, wz, BLOCK_AIR);
                }
            }
        }
    });

    onJoin(ctx, ({ playerNode }) => {
        const t = getTrait(playerNode, TransformTrait)!;
        setPosition(t, [0, 1, 0]);
        const cc = getTrait(playerNode, CharacterControllerTrait)!;
        // A look angle of PI faces +Z, so the orbiter at (0, 2, 4) is straight ahead.
        setCharacterLook(cc, Math.PI);
    });
});

/** cycles through detune values, in cents, on each press of key `2`. */
const DETUNE_STEPS = [0, 700, 1200, -700, -1200] as const;

/** orbit parameters for the moving spatial source, driven by key `3`. */
const ORBIT_RADIUS = 6;
const ORBIT_SPEED = 0.6; // radians per second
const ORBIT_Y = 2;

/** fixed-position spatial source. Sits at the scene origin, slightly elevated. */
const STATIC_POS: [number, number, number] = [0, 3, 0];

script(ExampleTrait, 'demo', (ctx) => {
    if (!env.client) return;

    let detuneIdx = 0;
    let orbiterNode: ReturnType<typeof createNode> | null = null;
    let orbitTime = 0;
    let orbitHandle: PlaybackHandle | null = null;
    let orbitMuted = false;
    let staticHandle: PlaybackHandle | null = null;

    onInit(ctx, () => {
        // Moving spatial source. playOnNode ties the panner to this node's
        // interpolated world transform, refreshed every frame by the audio
        // coordinator. Clone the spark gltf so the source has a visual you can
        // track as it orbits, and attach it as a child of the root so it shares
        // the scene's lifecycle but not a player's.
        orbiterNode = cloneModel(models.spark.scene);
        orbiterNode.name = 'orbiter';
        orbiterNode.persist = false;
        const t = addTrait(orbiterNode, TransformTrait);
        setPosition(t, [ORBIT_RADIUS, ORBIT_Y, 0]);
        addChild(ctx.node, orbiterNode);

        // Looped, spatial, mid-volume so it doesn't drown out the one-shots.
        // The cool-lava clip is a short tonal loop, fine for a demo even though
        // it wasn't designed to loop.
        orbitHandle = playOnNode(ctx, sounds.coolLava1, orbiterNode, {
            loop: true,
            volume: 0.4,
            falloff: { ref: 2, max: 30, model: 'inverse', rolloff: 1.2 },
        });

        // Stationary spatial source. playAt snapshots the position once and the
        // panner never refreshes, so walking around it produces the inverse pan
        // and attenuation of the orbiter: you move, the source stays put. A
        // different clip makes it easy to tell apart from the orbiting one.
        staticHandle = playAt(ctx, sounds.furnaceActive, STATIC_POS, {
            loop: true,
            volume: 0.5,
            falloff: { ref: 2, max: 25, model: 'inverse', rolloff: 1.4 },
        });

        showHud(ctx);
    });

    onDispose(ctx, () => {
        // Stop the loops explicitly. The audio runtime's per-frame reaper would
        // catch the node removal, but being explicit means no clip tail hangs
        // around past teardown.
        orbitHandle?.stop();
        orbitHandle = null;
        staticHandle?.stop();
        staticHandle = null;
    });

    onFrame(ctx, ({ delta }) => {
        // Animate the orbiter. The panner position refreshes from the node's
        // world transform every frame, so this drives the audio.
        if (orbiterNode) {
            orbitTime += delta;
            const x = Math.cos(orbitTime * ORBIT_SPEED) * ORBIT_RADIUS;
            const z = Math.sin(orbitTime * ORBIT_SPEED) * ORBIT_RADIUS;
            const t = getTrait(orbiterNode, TransformTrait);
            if (t) setPosition(t, [x, ORBIT_Y, z]);
        }

        const mk = ctx.client?.input?.mouseKeyboard;
        if (!mk) return;

        // 1: non-positional one-shot. playMono goes straight to master gain
        // with no panner.
        if (isKeyJustDown(mk, 'Digit1')) {
            playMono(ctx, sounds.chestOpen);
        }

        // 2: pitch-shift via detune. Detune is in cents: 100 is one semitone,
        // 1200 is an octave. Cycling makes the same clip read very differently.
        if (isKeyJustDown(mk, 'Digit2')) {
            const cents = DETUNE_STEPS[detuneIdx]!;
            detuneIdx = (detuneIdx + 1) % DETUNE_STEPS.length;
            playMono(ctx, sounds.digCracky1, { detune: cents });
        }

        // 3: mute or unmute the looped spatial source. setVolume on a captured
        // handle is instant, with no re-trigger.
        if (isKeyJustDown(mk, 'Digit3')) {
            orbitMuted = !orbitMuted;
            orbitHandle?.setVolume(orbitMuted ? 0 : 0.4);
        }

        // 4: fade-stop and restart the orbiter loop. stop({ fade }) ramps the
        // gain to zero over `fade` seconds and releases the source. Once
        // stopped the old handle is inert, so a fresh play is needed.
        if (isKeyJustDown(mk, 'Digit4')) {
            if (orbitHandle?.isPlaying) {
                orbitHandle.stop({ fade: 0.8 });
            } else if (orbiterNode) {
                orbitHandle = playOnNode(ctx, sounds.coolLava1, orbiterNode, {
                    loop: true,
                    volume: orbitMuted ? 0 : 0.4,
                    falloff: { ref: 2, max: 30, model: 'inverse', rolloff: 1.2 },
                });
            }
        }
    });
});

// Screen-anchored panel with the key bindings. HtmlTrait in `screen` mode keeps
// it fixed in the corner regardless of camera movement.
function showHud(ctx: ScriptContext): void {
    const node = createNode({ name: 'audio-hud', persist: false });
    setPosition(addTrait(node, TransformTrait), [0, 0, 0]);
    const html = addTrait(node, HtmlTrait, {
        mode: 'screen',
        center: false,
        pointerEvents: false,
    });
    addChild(ctx.node, node);

    html.element!.innerHTML = `
        <div style="
            position: fixed;
            top: 16px; left: 16px;
            background: #fff;
            border: 2px solid #000;
            box-shadow: 4px 4px 0 #000;
            padding: 10px 14px;
            font: 12px/1.45 ui-monospace, monospace;
            color: #000;
            white-space: nowrap;
        ">
            <div style="font-weight:700; margin-bottom:6px;">audio demo</div>
            <div><b>1</b> &nbsp; playMono (chest open)</div>
            <div><b>2</b> &nbsp; playMono + detune cycle</div>
            <div><b>3</b> &nbsp; mute/unmute looped source</div>
            <div><b>4</b> &nbsp; fade-stop / restart orbit loop</div>
            <div style="margin-top:6px; opacity:0.6;">
                spark = orbiting source, center @ y=3 = furnace loop<br/>
                walk around to hear panning + falloff
            </div>
        </div>
    `;
}
