/**
 * audio example — showcases the script-facing audio API:
 *
 *   1) `playMono`            non-positional one-shot (UI ding, music)
 *   2) `playMono` + detune   pitch-shift a clip with a single opt
 *   3) `playOnNode` + loop   spatial source that follows a moving node;
 *                            panner refreshes every frame from the node's
 *                            world transform
 *   4) PlaybackHandle        imperative handle for setVolume / stop(fade)
 *
 * No user-supplied audio assets — every clip comes from `sounds.*` in
 * `bongle/starter` (Minetest CC BY-SA 3.0). Same for the Stone block
 * and Spark model used as the orbiter visual.
 *
 * Browser tab must be focused + clicked once before audio plays —
 * AudioContext requires a user gesture before it can output anything.
 * The runtime resumes it on the first play call.
 */

import {
    addChild,
    addTrait,
    BLOCK_AIR,
    CharacterControllerTrait,
    CharacterTrait,
    characterLook,
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
    PlayerControllerTrait,
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
import { blocks, models, sounds } from 'bongle/starter';

matchmaking({ maxPlayers: 1 });

// ── terrain ─────────────────────────────────────────────────────────
// minimal stone floor so the character has somewhere to stand. Stone +
// Spark come from bongle/starter so the example doesn't ship its own
// texture/model assets.

// ── trait + server bootstrap ────────────────────────────────────────

const ExampleTrait = trait('example');

script(ExampleTrait, 'spawn', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        // 32×32 stone slab around spawn — wide enough to walk away from the
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
        addTrait(playerNode, CharacterControllerTrait);
        addTrait(playerNode, CharacterTrait);
        addTrait(playerNode, PlayerControllerTrait);
        const cc = getTrait(playerNode, CharacterControllerTrait)!;
        // theta=π → face +Z so the orbiter at (0,2,4) is straight ahead.
        characterLook(cc, Math.PI);
    });
});

// ── client demo ─────────────────────────────────────────────────────

/** cycles through detune values (in cents) on each press of key `2`. */
const DETUNE_STEPS = [0, 700, 1200, -700, -1200] as const;

/** orbit parameters for the moving spatial source (key `3`). */
const ORBIT_RADIUS = 6;
const ORBIT_SPEED = 0.6; // rad/sec
const ORBIT_Y = 2;

/** fixed-position spatial source — sits at scene origin, slightly elevated. */
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
        // moving spatial source — `playOnNode` ties the panner to this
        // node's interpolated world transform, refreshed every frame by
        // the audio coordinator. clone the spark gltf so the source has
        // a visual you can track as it orbits. attach as a child of the
        // root so it shares the scene's lifecycle but not a player's.
        orbiterNode = cloneModel(models.spark.scene, { aabb: models.spark.aabb });
        orbiterNode.name = 'orbiter';
        orbiterNode.persist = false;
        const t = addTrait(orbiterNode, TransformTrait);
        setPosition(t, [ORBIT_RADIUS, ORBIT_Y, 0]);
        addChild(ctx.node, orbiterNode);

        // looped, spatial, mid-volume so it doesn't drown out the
        // one-shots. the cool-lava clip is a short tonal loop — fine
        // for demo purposes even though it wasn't designed to loop.
        orbitHandle = playOnNode(ctx, sounds.coolLava1, orbiterNode, {
            loop: true,
            volume: 0.4,
            falloff: { ref: 2, max: 30, model: 'inverse', rolloff: 1.2 },
        });

        // stationary spatial source — `playAt` snapshots the position
        // once; the panner doesn't refresh, so walking around it produces
        // the inverse pan/attenuation of the orbiter (you move, source
        // stays put). different clip so it's easy to distinguish from
        // the orbiting one in the mix.
        staticHandle = playAt(ctx, sounds.furnaceActive, STATIC_POS, {
            loop: true,
            volume: 0.5,
            falloff: { ref: 2, max: 25, model: 'inverse', rolloff: 1.4 },
        });

        showHud(ctx);
    });

    onDispose(ctx, () => {
        // stop the loops explicitly — the audio runtime's per-frame reaper
        // would catch the node removal, but being explicit means no clip
        // tail hangs around past teardown.
        orbitHandle?.stop();
        orbitHandle = null;
        staticHandle?.stop();
        staticHandle = null;
    });

    onFrame(ctx, ({ delta }) => {
        // animate the orbiter — panner position refreshes from the
        // node's world transform every frame, so this drives the audio.
        if (orbiterNode) {
            orbitTime += delta;
            const x = Math.cos(orbitTime * ORBIT_SPEED) * ORBIT_RADIUS;
            const z = Math.sin(orbitTime * ORBIT_SPEED) * ORBIT_RADIUS;
            const t = getTrait(orbiterNode, TransformTrait);
            if (t) setPosition(t, [x, ORBIT_Y, z]);
        }

        const mk = ctx.client?.input?.mouseKeyboard;
        if (!mk) return;

        // ── 1: non-positional one-shot ──────────────────────────────
        // playMono goes straight to master gain, no panner. UI feel.
        if (isKeyJustDown(mk, 'Digit1')) {
            playMono(ctx, sounds.chestOpen);
        }

        // ── 2: pitch-shift via detune ───────────────────────────────
        // detune is in cents; 100c = 1 semitone, 1200c = octave. cycling
        // makes the same source clip read very differently.
        if (isKeyJustDown(mk, 'Digit2')) {
            const cents = DETUNE_STEPS[detuneIdx]!;
            detuneIdx = (detuneIdx + 1) % DETUNE_STEPS.length;
            playMono(ctx, sounds.digCracky1, { detune: cents });
        }

        // ── 3: mute/unmute the looped spatial source ────────────────
        // setVolume on a captured handle — instant, no re-trigger.
        if (isKeyJustDown(mk, 'Digit3')) {
            orbitMuted = !orbitMuted;
            orbitHandle?.setVolume(orbitMuted ? 0 : 0.4);
        }

        // ── 4: fade-stop + restart the orbiter loop ─────────────────
        // stop({ fade }) ramps the gain to zero over `fade` seconds and
        // releases the source. demonstrates handle ownership — once
        // stopped, the old handle is inert and a fresh play is needed.
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

// ── HUD ─────────────────────────────────────────────────────────────
// screen-anchored panel with the key bindings. HtmlTrait in `screen`
// mode keeps it fixed in the corner regardless of camera movement.

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
                spark = orbiting source · center @ y=3 = furnace loop<br/>
                walk around to hear panning + falloff
            </div>
        </div>
    `;
}
