/**
 * character — presentation layer for a humanoid character entity:
 * visuals (avatar model + procedural limb swing) + sfx (footstep audio) +
 * vfx (block-dust particles). pairs with CharacterControllerTrait —
 * the controller drives state (position, velocity, grounded, bobPhase,
 * sprint, groundBlockState), this trait renders/sounds it.
 *
 * Data-driven: `def.modelId` (intent — what should be mounted) +
 * `state.modelId` (fact — what IS mounted). A single WorldTrait-hosted
 * script reconciles them each frame and, on client, drives presentation:
 *
 *   - rig reconciler — runs on every side. When `def.modelId !==
 *     state.modelId`: if the target is in `Resources`, unmount the
 *     previous rig (if any) and mount the target; otherwise install
 *     `BUILTIN_BASE_AVATAR_ID` as a placeholder so gameplay code can
 *     name-resolve bones (`head`, `arm_left`, …) from frame zero. The
 *     server avatar pipeline writes `def.modelId` once its load lands
 *     (`server/avatars.ts`) — the reconciler picks it up next frame.
 *     Loading state is `def.modelId !== state.modelId` for any consumer
 *     that needs it.
 *
 *   - locomotion (client). procedural arm/leg swing keyed off
 *     `cc.bobPhase` and horizontal speed, plus head-look orientation.
 *     No clips, no animator state — bones are written directly each
 *     frame, so `AnimatorTrait` ticks (which run after) naturally
 *     override any bones whose channels game code is driving (e.g. an
 *     upper-body emote masks the arm swing while the legs still cycle).
 *     Opt out per-character with `t.config.animation = false` to drive
 *     every bone yourself.
 *
 *   - POV visibility / proximity dither (client). Hide own body in
 *     first-person / orbit / fly POV; screen-door fade other characters
 *     the active camera is standing inside of.
 *
 *   - sfx + vfx (client). Fires footstep audio + block-dust particles
 *     on bob-phase crossings and landing edges. Owner plays
 *     non-positional (`playMono`) at a louder fixed gain — their own
 *     footsteps should sit up in the mix and not pan around the
 *     listener; remote characters play positional via `playAt`.
 *     Ground-block resolution: `cc.groundBlockState` (synced uint16)
 *     indexes directly into `BlockRegistry.sounds[]` and `.particles[]`
 *     so owner + remote follow one lookup, no drift. Particles emit on
 *     landing edges always, on phase crossings only when sprinting —
 *     walking is quiet visually, sprinting kicks dust.
 *
 * Crossing-detector "previous" values come from `cc.state.previousGrounded`
 * and `cc.state.previousBobPhase`, snapshotted by the controller at the
 * end of each tick — robust to multiple controller ticks per frame.
 */

type CharacterConfig = {
    animation: boolean;
    footstepVolume: number;
    ownFootstepVolume: number;
    landingVolume: number;
    ownLandingVolume: number;
    landingCooldown: number;
    proximityFadeRange: number;
};

type CharacterState = {
    /** what IS currently mounted on the player node (the *fact*, paired
     *  with `def.modelId` — the *intent*). The WorldTrait reconciler
     *  converges them each frame: when `state.modelId !== modelId`, it
     *  mounts (placeholder first, then the target once `getModel(ctx, id)`
     *  returns non-null) and writes the new value here. `null` means nothing is
     *  mounted yet — first reconciler tick after trait add will install
     *  baseAvatar as a placeholder. */
    modelId: string | null;
    /** the resolved ModelHandle for `state.modelId`. The reconciler writes
     *  this on every mount so consumers (crouch drop, future rest-pose
     *  lookups) can read `state.modelHandle.nodes.<bone>` directly without
     *  re-resolving each frame. `null` mirrors `state.modelId === null`;
     *  consumers gate on `state.modelId` instead. */
    modelHandle: ModelHandle | null;
    breathPhase: number;
    landingCooldownRemaining: number;
    /** screen-door dither contribution from the "loading" placeholder
     *  state (intent.modelId not yet hydrated → placeholder mounted).
     *  Pulses while loading, decays linearly to 0 once the target lands
     *  so the swap eases instead of snapping. Combined with the proximity
     *  fade dither via max() in the presentation step. */
    loadingDither: number;
    /** last dither value applied via setCharacterSubtreeDither. Used to
     *  skip the subtree walk on frames where the resolved value didn't
     *  change — steady-state characters (loaded, out of proximity range)
     *  pay one numeric compare per frame instead of a full rig traversal. */
    appliedDither: number;
    /** extra screen-door dither a game script can drive (e.g. fading out a
     *  dead body). `max()`'d with the proximity + loading dither in the
     *  presentation step, so the engine stays the single writer of mesh
     *  dither and the script's intent can't be undone by the proximity fade.
     *  Set it via `getTrait(node, CharacterTrait).state.externalDither = v`
     *  instead of walking the rig and calling setMeshDither yourself. */
    externalDither: number;
    /** the current model's nodes that `mountRig` added on top of the enforced
     *  skeleton (its mesh/visual nodes). `unmountRig` removes exactly these on
     *  a swap and leaves runtime attachments (gear) alone — ownership by node
     *  identity, not name. Per-side, runtime-only; fresh per instance. */
    modelNodes: Set<Node>;
};

import type { ScriptContext } from '../core/scene/scripts';
import type { Quat, Vec3 } from 'mathcat';
import { degreesToRadians, quat, vec3 } from 'mathcat';
import { RIG_6BONE_ATTACH_NODES, RIG_6BONE_BACK, RIG_6BONE_REQUIRED_NODES, RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import { wrapPi } from '../core/math/angles';
import type { ModelHandle } from '../core/models/handle';
import { baseAvatar, BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';
import { ensureModel, getModel } from '../api/models';
import { pack } from '../core/scene/pack';
import { BLOCK_FLAG_LIQUID } from '../core/voxels/block-registry';
import type { BlockParticleConfig, BlockSoundConfig } from '../core/voxels/blocks';
import { Animation } from '../api/animation';
import { env } from '../api/env';
import {
    addChild,
    addTrait,
    cloneNode,
    createNode,
    destroyNode,
    findByName,
    getTrait,
    hasTrait,
    isLocalNode,
    type Node,
} from '../api/scene-graph';
import type { TraitProps } from '../core/scene/nodes';
import { getControlNode, isOwner, onFrame, query, script } from '../api/scripts';
import { sync, trait, type TraitType } from '../api/traits';
import { setPosition, setQuaternion, setTransform } from '../api/transforms';
import { playAt, playMono } from '../api/audio';
import { spawnParticle } from '../api/particles';
import { AnimatorTrait } from './animator';
import { CharacterControllerTrait } from './character-controller';
import { FlyControllerTrait } from './fly-controller';
import { MeshTrait, setMeshDither } from './mesh';
import { ModelTrait } from './model';
import { getControlCamera } from './camera';
import { OrbitControllerTrait } from './orbit-controller';
import { PlayerControllerTrait } from './player-controller';
import { TransformTrait } from './transform';
import { WorldTrait } from './world';

const TAU = Math.PI * 2;
// sin(bobPhase) trough — when the camera bob is at its lowest. that's
// the foot-plant moment in this controller's bob convention.
const FOOT_PHASE = (3 * Math.PI) / 2;

// max head pitch (rad). real necks crane ~60° up / ~75° down; symmetric
// 60° is a fine starting point — past this the head would clip into the
// torso visually.
const HEAD_PITCH_LIMIT_RAD = degreesToRadians(60);

const _qHeadYaw = quat.create();
const _qHeadPitch = quat.create();
const _qHead = quat.create();
const _HEAD_UP: Vec3 = [0, 1, 0];
const _HEAD_RIGHT: Vec3 = [1, 0, 0];

/** extract yaw (rad) from a pure-Y-axis quaternion. body yaw is written
 *  as `setAxisAngle(UP, θ)` so q = (0, sin(θ/2), 0, cos(θ/2)); inverting
 *  gives θ = 2·atan2(qy, qw). */
function bodyYawFromQuat(q: Quat): number {
    return 2 * Math.atan2(q[1], q[3]);
}

// per-event puff count. three is enough for a visible kick without
// blowing the 8192 pool on a long sprint.
const FOOTSTEP_DUST_COUNT = 3;

// voxel-light sample height (m) above the rig root. the root sits at the
// feet (y=0), so sampling there reads the floor block the character stands
// on; push the sample up to ~half the standing height (1.8 / 2) so it lands
// in the torso interior and the model is lit by the space it occupies.
const LIGHT_SAMPLE_HEIGHT = 0.9;

// ── loading-state dither pulse ─────────────────────────────────────
// While the intended `modelId` hasn't hydrated yet (placeholder rig
// shown), pulse the screen-door dither between two values so the
// character reads as "loading in" rather than as a final asset. Decays
// linearly to 0 once the target lands so the visual hand-off eases
// instead of snapping. Driven off a global clock so every loading
// character pulses in sync — cheaper than per-character phase, and
// a coherent group pulse reads better visually anyway.
const LOAD_PULSE_RATE_HZ = 1.2;
const LOAD_PULSE_MIN = 0.35;
const LOAD_PULSE_MAX = 0.75;
const LOAD_DECAY_PER_SEC = 12; // 1.0 → 0 in ~83ms

// half-range of per-step random detune in cents (100 = 1 semitone). each
// footstep picks uniformly in ±this so consecutive steps don't read as a
// metronome. 300 ≈ ±3 semitones — chunky enough to register on repeats
// without sounding broken.
const FOOTSTEP_DETUNE_CENTS = 400;

// procedural limb-swing tuning. peak swing angle (rad) reached when
// `horizSpeed >= SWING_SPEED_REF`; below that we lerp linearly to 0.
// matches the controller's sprint speed so a casual jog reads as a half-
// amplitude swing.
const LEG_SWING_MAX_RAD = degreesToRadians(55);
const ARM_SWING_MAX_RAD = degreesToRadians(35);
const SWING_SPEED_REF = 5.0;

// arm outward tilt (Z roll) — minecraft-style. small baseline + slow
// sine on top of it (~breathing). idle stays subtle; sprinting widens
// both the baseline and the breathing oscillation.
const ARM_IDLE_TILT_RAD = degreesToRadians(4);
const ARM_IDLE_BREATH_RAD = degreesToRadians(2);
const ARM_RUN_TILT_RAD = degreesToRadians(12);
const ARM_RUN_BREATH_RAD = degreesToRadians(5);
// breath sine rate (rad/s). ~0.5 Hz = π rad/s; matches a slow inhale-
// exhale and stays distinct from gait frequencies so they don't beat.
const ARM_BREATH_RATE = Math.PI;

// minecraft-style sneak pose. body bone pitches backward (negative X) so
// the chest tucks under the head and the silhouette reads as a hunched
// squat; the waist bone drops in Y so the whole upper subtree (body +
// head + arms) sinks while the legs — siblings of the waist — stay
// rooted to the feet, giving a knee-bend illusion without knee joints.
// head pitch is offset by `BODY_PITCH` so the face still aims at
// `cc.look`. amount is driven by `cc.state.crouchAmount` (eased on the
// controller) so the visual pose and the camera eye-height drop stay
// locked in step on the same source.
const CROUCH_BODY_PITCH_RAD = -degreesToRadians(28);
const CROUCH_WAIST_DROP = 0.15;
// shift the waist (and therefore the whole upper subtree) backward in
// the rig's local frame on top of the drop + pitch. counter-balances
// the body's forward tuck so the silhouette reads as a real squat
// rather than a face-plant. small — over-shifting unmoors the head
// from the feet in third-person.
const CROUCH_WAIST_BACK = 0.1;

const _waistPos: Vec3 = [0, 0, 0];

// rotation axes for limb decomposition — X is the forward/back swing
// axis (pitch), Z is the outward-tilt axis (roll). compose as `Qx · Qz`
// so the tilt happens in the body frame first then the swing rides
// on top of it; both small-angle so order is barely visible anyway.
const _LIMB_X_AXIS: Vec3 = [1, 0, 0];
const _LIMB_Z_AXIS: Vec3 = [0, 0, 1];
const _qSwingX = quat.create();
const _qTiltZ = quat.create();
const _qLimbOut = quat.create();

const _identityPos: Vec3 = [0, 0, 0];
const _identityQuat: Quat = [0, 0, 0, 1];
const _identityScale: Vec3 = [1, 1, 1];

export const CharacterTrait = trait(
    'character',
    {
        /** intent — what should be mounted. Any model id registered with
         *  `Resources`. Server-set (engine join lifecycle writes the
         *  resolved player avatar here; game scripts write it for NPCs),
         *  dirty-synced to clients via `modelIdSync`. Defaults to
         *  `BUILTIN_BASE_AVATAR_ID` — the canonical 6-bone rig — so
         *  characters that never receive a custom assignment render as
         *  the placeholder.
         *
         *  Pairs with `state.modelId` (the fact). The WorldTrait reconciler
         *  converges them: writes to `state.modelId = modelId` once the
         *  payload is in Resources, mounting the rig in the same pass.
         *  Loading state is `modelId !== state.modelId`. Reassign at
         *  runtime to swap the avatar — next frame the reconciler does
         *  the rest. */
        modelId: BUILTIN_BASE_AVATAR_ID as string,

        /** rig contract of the currently-set avatar. set in lock-step
         *  with `modelId` by whoever sets up the character (the avatar
         *  subsystem for players, game code for NPCs) so game scripts
         *  can branch on rig type. defaults to the canonical 6bone rig. */
        rigType: RIG_TYPE_6BONE as string,

        /** user-tunable knobs. `animation` opts out of the engine's
         *  procedural arm/leg swing + head-look (e.g. an AnimatorTrait
         *  clip owns legs, or a custom controller writes bone TRS each
         *  frame); the volume / cooldown / fade settings tune the
         *  client-side sfx + visibility behavior. `proximityFadeRange`
         *  is the distance (m) at which the active camera starts fading
         *  this character via screen-door dither (0 disables; only ever
         *  applies to non-POV characters). */
        config: (): CharacterConfig => ({
            animation: true,
            footstepVolume: 0.3,
            ownFootstepVolume: 0.5,
            landingVolume: 0.5,
            ownLandingVolume: 0.7,
            landingCooldown: 0.18,
            proximityFadeRange: 1.5,
        }),

        /** runtime bookkeeping. `modelId` + `modelHandle` are the reconciler's
         *  fact-state (see field doc-comments — start `null`, reconciler
         *  populates on first tick). `breathPhase` is the accumulated
         *  breath-sine phase (rad) used by the arm idle tilt — advances
         *  at `ARM_BREATH_RATE` so idle characters still breathe; wraps
         *  mod 2π. `landingCooldownRemaining` is seconds left on the
         *  landing-thud cooldown (suppresses grounded chatter on stair
         *  edges / voxel seams / low-arc hops). */
        state: (): CharacterState => ({
            modelId: null,
            modelHandle: null,
            breathPhase: 0,
            landingCooldownRemaining: 0,
            loadingDither: 0,
            appliedDither: 0,
            externalDither: 0,
            modelNodes: new Set(),
        }),
    },
    { persist: false },
);

export type CharacterTrait = TraitType<typeof CharacterTrait>;

/** server-set, dirty-synced. clients read `modelId` to know which url to
 *  fetch + register via `Resources.setModel` (the engine broadcast pairs
 *  the id with a client-side `.glb` url). */
export const modelIdSync = sync(CharacterTrait, 'model-id', {
    schema: pack.string(),
    pack: (t) => t.modelId,
    unpack: (v, t) => {
        t.modelId = v;
    },
    rate: 'dirty',
});

// ── per-frame character systems (world-script) ──────────────────────
//
// One onFrame, two queries. The split lets the rig load and present
// for ANY character holding a CharacterTrait (NPCs, ball-controllers,
// ragdolls), while controller-driven concerns stay gated on having a
// CharacterControllerTrait.
//
// Pass 1 — [CharacterTrait, TransformTrait]:
//   1. rig reconciler — converges `def.modelId` (intent) toward
//      `state.modelId` (fact). Runs on BOTH sides. First pass per
//      character mounts the baseAvatar placeholder so subsequent
//      frames have bones to write to; once the target `def.modelId`
//      is in Resources, unmounts and re-mounts the real rig. Loading
//      state is `def.modelId !== state.modelId`.
//   2. loading-state pulse — pulsing dither while the target rig
//      hasn't resolved; decays off once it lands. max()'d with the
//      proximity dither below so a loading character near camera
//      still reads as loading, not as faded.
//   3. POV visibility / proximity dither — hide own body in
//      first-person / orbit / fly POV; screen-door fade other
//      characters the active camera is standing inside of.
//
// Pass 2 — [CharacterTrait, CharacterControllerTrait, TransformTrait]:
//   4. locomotion — procedural head/limb pose. Writes bone TRS each
//      frame (no clips, no animator state). Inputs (`cc.input.look`,
//      `cc.state.bobPhase`, player yaw) are synced or locally-
//      integrated on both sides, so running client-only still
//      produces the same pose every client sees.
//   5. footstep + landing thud sfx + dust/droplet vfx — bob-phase
//      bucket crossings drive cadence, edge detectors drive landings
//      and liquid entry.
//
// (1) runs on every side. The rest is client-only and skips when
// `state.modelId` is null (no bones yet — first reconciler tick).
// AnimatorTrait scripts tick after this onFrame and overwrite any
// bone whose currently-playing clip channels target it — that's the
// emote / upper-body-mask path. To opt out of engine-driven limb
// swing, set `t.config.animation = false` and own the bones yourself.
script(WorldTrait, 'character', (ctx) => {
    const qChars = query(ctx, [CharacterTrait, TransformTrait]);
    const qLocomotion = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);

    onFrame(ctx, ({ delta }) => {
        const controlNode = getControlNode(ctx);
        const camera = getControlCamera(ctx);

        // ── pass 1: every character ─────────────────────────────
        for (const [t, transform] of qChars.matches) {
            const node = t._node;

            // ── rig reconciler ─────────────────────────────────────
            // Reconcile the mounted rig against LIVE payload state, not a cached
            // fact. `getModel` returns a handle only while the target model's
            // payload is ready *right now*, so a play/stop payload wipe (which
            // clears Resources) self-heals on the next frame instead of getting
            // stuck on a stale "already mounted" flag. Runs on every side; both
            // server and client need bones for `findByName(node, 'head')` and for
            // animator ticks.
            const handle = getModel(ctx, t.modelId);
            if (handle) {
                // target ready → mount it unless it's already the mounted handle.
                if (t.state.modelHandle !== handle) {
                    unmountRig(node);
                    mountRig(node, handle);
                    t.state.modelId = t.modelId;
                    t.state.modelHandle = handle;
                }
            } else {
                // target not ready (still loading, or its payload was wiped under
                // us). Keep the lazy load going and show the placeholder — reverting
                // a now-stale real model so the null→ready edge re-mounts cleanly.
                // The player avatar pipeline also ensures on a player's behalf, but
                // a game that sets `modelId` directly (NPCs) relies on this.
                ensureModel(ctx, t.modelId);
                if (t.state.modelHandle !== baseAvatar) {
                    unmountRig(node);
                    mountRig(node, baseAvatar);
                    t.state.modelId = BUILTIN_BASE_AVATAR_ID;
                    t.state.modelHandle = baseAvatar;
                }
            }

            // The remaining systems are client-only presentation; skip
            // them on the server (which does need the reconciler above
            // for logical bone access).
            if (!env.client) continue;

            // No bones yet — reconciler will install the placeholder
            // next call. Skip presentation work for this character.
            if (t.state.modelId === null) continue;

            // ── loading-state pulse ────────────────────────────────
            const loading = t.state.modelId !== t.modelId;
            if (loading) {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() * (TAU * LOAD_PULSE_RATE_HZ) / 1000);
                t.state.loadingDither = LOAD_PULSE_MIN + (LOAD_PULSE_MAX - LOAD_PULSE_MIN) * pulse;
            } else if (t.state.loadingDither > 0) {
                t.state.loadingDither = Math.max(0, t.state.loadingDither - delta * LOAD_DECAY_PER_SEC);
            }

            // ── POV visibility / proximity dither ──────────────────
            // Compute the per-frame dither value first, then only walk
            // the rig subtree when it changes vs the last applied value.
            // Steady-state characters (loaded, out of fade range) write
            // zero, compare-equals the cache, and skip the walk.
            let finalDither: number;
            if (controlNode === node) {
                const pc = getTrait(node, PlayerControllerTrait);
                const hide =
                    (pc && pc.config.perspective === 'first') ||
                    !!getTrait(node, OrbitControllerTrait) ||
                    !!getTrait(node, FlyControllerTrait);
                setCharacterSubtreeVisible(node, !hide);
                // POV character can still be loading (own avatar streaming
                // in) — apply the load dither alone; proximity fade never
                // applies to own body. a script-driven dither (e.g. own death
                // fade) still composes in.
                finalDither = hide ? 0 : Math.max(t.state.loadingDither, t.state.externalDither);
            } else {
                setCharacterSubtreeVisible(node, true);
                const range = t.config.proximityFadeRange;
                let proxDither = 0;
                if (range > 0 && camera) {
                    // measure against character center (~1m above the foot
                    // transform) so a camera at eye-level standing inside
                    // reads as ~0 distance.
                    const dx = camera.position[0] - transform.position[0];
                    const dy = camera.position[1] - (transform.position[1] + 1);
                    const dz = camera.position[2] - transform.position[2];
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    proxDither = dist >= range ? 0 : 1 - dist / range;
                }
                finalDither = Math.max(proxDither, t.state.loadingDither, t.state.externalDither);
            }
            if (t.state.appliedDither !== finalDither) {
                setCharacterSubtreeDither(node, finalDither);
                t.state.appliedDither = finalDither;
            }
        }

        // ── pass 2: controller-driven characters ────────────────
        // Locomotion + footstep sfx are client-only and depend on the
        // rig being mounted (pass 1 above). Servers skip this pass
        // entirely.
        if (!env.client) return;

        for (const [t, cc, transform] of qLocomotion.matches) {
            if (t.state.modelId === null) continue;
            const node = t._node;

            // ── locomotion ──────────────────────────────────────────
            // head bone follow: every side derives head local rotation
            // from the synced `cc.input.look` + the synced player
            // transform yaw. independent of `t.config.animation`; head
            // tracking is a controller affordance, not a swing clip.
            updateHeadOrientation(node, cc, transform);

            // arm/leg swing. per-character opt-out via `t.config.animation`.
            if (t.config.animation) driveProceduralLocomotion(node, t, cc, delta);

            // ── footstep sfx + dust vfx ────────────────────────────
            if (t.state.landingCooldownRemaining > 0) {
                t.state.landingCooldownRemaining -= delta;
            }

            const owner = isOwner(ctx, node);
            const footBlockState = cc.state.groundBlockState;
            const prevFootBlockState = cc.state.previousGroundBlockState;
            const inLiquid =
                footBlockState !== 0 && (ctx.blocks.flags[footBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
            const wasInLiquid =
                prevFootBlockState !== 0 && (ctx.blocks.flags[prevFootBlockState]! & BLOCK_FLAG_LIQUID) !== 0;

            // entry splash — fires on the bob-tick the foot-sample first
            // resolves to a liquid voxel. one-shot, independent of cadence.
            // played even if the bob hasn't ticked at all (e.g. dropping
            // straight in from above), so it lives outside the bucket
            // detector below.
            if (inLiquid && !wasInLiquid) {
                emitSplash(ctx, cc, transform, owner, owner ? t.config.ownLandingVolume : t.config.landingVolume);
            }

            // suppress landing thud while feet are in liquid: water entry
            // is already covered by emitSplash above, and resting at the
            // bottom of a pool flickers `grounded` on/off and retriggers
            // landings.
            const isLanding = cc.state.grounded && !cc.state.previousGrounded && !inLiquid;

            if (isLanding && t.state.landingCooldownRemaining <= 0) {
                emitFootstep(
                    ctx,
                    cc,
                    transform,
                    owner,
                    owner ? t.config.ownLandingVolume : t.config.landingVolume,
                    true, // landing always kicks dust
                );
                t.state.landingCooldownRemaining = t.config.landingCooldown;
            } else if (cc.state.grounded || inLiquid) {
                // phase-bucket crossing detector. each bucket boundary lies
                // at sin(bobPhase) = −1, i.e. the bottom of the camera dip.
                // bucket increments → one footstep per 2π of phase. dt-robust
                // (no threshold to undershoot) and amplitude-independent.
                // gated on grounded OR feet-in-liquid so the swim stroke
                // cadence drives the liquid block's `footstep` clips through
                // the same path (controller writes the liquid id into
                // `groundBlockState` while submerged).
                const idx = Math.floor((cc.state.bobPhase - FOOT_PHASE) / TAU);
                const prevIdx = Math.floor((cc.state.previousBobPhase - FOOT_PHASE) / TAU);
                if (idx > prevIdx) {
                    emitFootstep(
                        ctx,
                        cc,
                        transform,
                        owner,
                        owner ? t.config.ownFootstepVolume : t.config.footstepVolume,
                        // dust: never while swimming (water doesn't kick
                        // dust), and on ground only when sprinting — walking
                        // stays visually quiet.
                        cc.state.grounded && cc.input.sprint,
                    );
                }
            }
        }
    });
    // editor: true → this presentation runs in edit mode too, so the editor lens
    // gets the real avatar (reconciler), procedural locomotion, and the
    // first-person POV-hide when viewing through the character (control.node ===
    // playerNode), not just in play.
}, { editor: true });

/** Rotate the canonical `head` bone to point at `cc.look`. yaw is the
 *  delta between look-yaw and the body's yaw (which already tracks
 *  velocity within ±BODY_YAW_LIMIT_RAD on the controller side, so this
 *  delta is naturally bounded); pitch is `look[2] - π/2` clamped to
 *  ±HEAD_PITCH_LIMIT_RAD. composed as `Ryaw · Rpitch` so the head pitches
 *  in its own local frame after yawing — matches FPS look feel.
 *
 *  When the waist is tilted by the sneak pose (driven by
 *  `cc.state.crouchAmount` on the controller — in the flat rig the waist
 *  carries head + arms + body), subtract that pitch from the head's local
 *  pitch so the face still aims at the world look direction. Small-angle
 *  approximation — pitch and head yaw don't commute, but at ±28°/±60° the
 *  visual error is below the threshold of notice. */
function updateHeadOrientation(playerNode: Node, cc: CharacterControllerTrait, transform: TransformTrait): void {
    const headBone = findByName(playerNode, 'head');
    if (!headBone) return;
    const headTransform = getTrait(headBone, TransformTrait);
    if (!headTransform) return;

    // read yaw from the interpolated world quaternion, not the simulation
    // local. the head bone's parent chain renders against the playerNode's
    // visual (alpha-sampled) yaw — composing the head local against the
    // sim yaw would leave a `(visual - sim)` residual that wobbles by up
    // to one tick of body yaw between fixed ticks. playerNode is top-level
    // and its yaw is pure-Y, so interpolatedWorldQuaternion is also pure-Y.
    const bodyYaw = bodyYawFromQuat(transform.interpolatedWorldQuaternion);
    const headYaw = wrapPi(cc.input.look[1] - bodyYaw);
    let pitch = cc.input.look[2] - Math.PI / 2 - cc.state.crouchAmount * CROUCH_BODY_PITCH_RAD;
    if (pitch < -HEAD_PITCH_LIMIT_RAD) pitch = -HEAD_PITCH_LIMIT_RAD;
    else if (pitch > HEAD_PITCH_LIMIT_RAD) pitch = HEAD_PITCH_LIMIT_RAD;

    quat.setAxisAngle(_qHeadYaw, _HEAD_UP, headYaw);
    quat.setAxisAngle(_qHeadPitch, _HEAD_RIGHT, pitch);
    quat.multiply(_qHead, _qHeadYaw, _qHeadPitch);
    setQuaternion(headTransform, _qHead);
}

// ── skeleton + mount helpers ─────────────────────────────────────────

/**
 * Synchronously mount the placeholder (baseAvatar) rig on `node` if it has no
 * rig yet, so code running before the reconciler's first frame sees the bones.
 *
 * The reconciler builds the rig in `onFrame`, which runs *after* the server's
 * join processing — so a server `onJoin` hook that does
 * `findByName(playerNode, 'hand_right')` would otherwise get null. The server
 * calls this at player-node creation (`createPlayerNode`) so bones exist by the
 * time join hooks fire; game code spawning characters that need bones
 * immediately can call it too.
 *
 * Idempotent (no-op once a rig is mounted) and a no-op on a node without
 * `CharacterTrait`. Mounts only the placeholder — the reconciler still swaps in
 * the resolved avatar once its model loads.
 */
export function ensureCharacterRig(node: Node): void {
    const t = getTrait(node, CharacterTrait);
    if (!t || t.state.modelId !== null) return;
    mountRig(node, baseAvatar);
    t.state.modelId = BUILTIN_BASE_AVATAR_ID;
    t.state.modelHandle = baseAvatar;
}

/**
 * Add `CharacterTrait` to `node` and mount its rig immediately, so the bones
 * (`head`, `hand_right`, …) are available the same tick for attaching held
 * items / accessories. The higher-level sibling of
 * `addTrait(node, CharacterControllerTrait)` — the engine uses it for player
 * nodes (`createPlayerNode`) and game code uses it to spawn character NPCs.
 *
 * Returns the trait. Mounts the base/placeholder rig synchronously (via
 * `ensureCharacterRig`); the reconciler swaps in the resolved avatar later if
 * `props.modelId` names one that isn't loaded yet. Use `ensureCharacterRig`
 * directly when a node already carries `CharacterTrait` and you only need its
 * bones mounted now.
 */
export function addCharacter(node: Node, props?: TraitProps<CharacterTrait>): CharacterTrait {
    const t = addTrait(node, CharacterTrait, props);
    ensureCharacterRig(node);
    return t;
}

/**
 * Canonical 6bone parenting. waist hangs off `playerNode`; body, head, and
 * arms nest under waist as independent siblings (Minecraft-style parts —
 * each animates around its own pivot, and rotating waist carries the whole
 * upper body). legs are their own roots off `playerNode`, so they stay
 * planted when waist twists. Authoring tools MUST produce this hierarchy —
 * mount copies each loaded bone's *local* TRS onto its matching canonical
 * bone, so a mismatched hierarchy would apply scene-space TRS as if it were
 * local-to-parent and visually shear the rig.
 *
 *     playerNode (AnimatorTrait)
 *       ├ waist
 *       │   ├ body        (└ back)
 *       │   ├ head
 *       │   ├ arm_left    (└ hand_left)
 *       │   └ arm_right   (└ hand_right)
 *       ├ leg_left
 *       └ leg_right
 *
 * Attach sockets (hand_*, back) are also enforced + persistent, hung off their
 * bone. When a model doesn't author one, the engine derives its rest position
 * from the bone's geometry (see `deriveSocketPosition`), so creators get usable
 * mount points for free; an authored socket's TRS wins.
 */
const RIG_6BONE_PARENT_OF: Record<string, string | null> = {
    waist: null,
    leg_left: null,
    leg_right: null,
    body: 'waist',
    head: 'waist',
    arm_left: 'waist',
    arm_right: 'waist',
    // attach sockets — enforced + persistent; auto-derived from bone geometry
    // when the model doesn't author them.
    hand_left: 'arm_left',
    hand_right: 'arm_right',
    back: 'body',
};

// the enforced skeleton: bones + attach sockets. built once by
// `ensureCanonicalBones`, reused across model swaps, never dropped.
const RIG_6BONE_PERSISTENT_NODES = [...RIG_6BONE_REQUIRED_NODES, ...RIG_6BONE_ATTACH_NODES];

// default grip for an engine-derived hand socket: held items sit perpendicular to
// the arm, so an outstretched (horizontal) arm points them up and a resting (down)
// arm points them forward. items are authored upright in their own model; authored
// sockets keep their own rotation instead.
const HAND_GRIP_ROTATION = quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(90));

/**
 * Ensure the canonical 6bone hierarchy + AnimatorTrait exist under
 * `playerNode`. Idempotent — bones already in place are reused, so this
 * doubles as the placeholder install (first call from the reconciler)
 * and as the prep step for `mountRig` (re-mount after avatar swap).
 *
 * Each created bone carries an identity TransformTrait so the animator's
 * bone walker discovers it on first tick; `mountRig` overwrites that TRS
 * with the loaded value if/when the target rig lands.
 */
function ensureCanonicalBones(playerNode: Node): void {
    if (!hasTrait(playerNode, AnimatorTrait)) addTrait(playerNode, AnimatorTrait);
    const byName = new Map<string, Node>();
    for (const name of RIG_6BONE_PERSISTENT_NODES) {
        const existing = findByName(playerNode, name);
        if (existing) {
            byName.set(name, existing);
            continue;
        }
        const n = createNode({ name });
        addTrait(n, TransformTrait);
        byName.set(name, n);
    }
    // Attach in canonical parent order; parents always exist by the time
    // their children attach because `RIG_6BONE_PARENT_OF` is acyclic.
    // skip nodes that already have a parent (we found them via findByName).
    for (const name of RIG_6BONE_PERSISTENT_NODES) {
        const node = byName.get(name)!;
        if (node.parent) continue;
        const parentName = RIG_6BONE_PARENT_OF[name];
        const parent = parentName === null ? playerNode : byName.get(parentName)!;
        addChild(parent, node);
    }
}

/**
 * Install / re-install a model's rig under `playerNode`:
 *
 *   - ensure the canonical 6bone hierarchy + AnimatorTrait exist (first
 *     call also performs the placeholder install — there's no separate
 *     placeholder step).
 *   - canonical bone match (by exact name): copy the loaded node's local
 *     TRS onto the canonical bone. Node identity preserved across swaps
 *     so AnimatorTrait + AnimationAction map keys stay valid.
 *   - non-canonical descendants under a matched parent: cloned and
 *     attached under the matching canonical bone so mesh-bearing leaves
 *     render and decorative bones drive any extra clip channels.
 *
 * Caller (the reconciler) is responsible for calling `unmountRig` first
 * if a different rig is currently mounted — `mountRig` doesn't drop the
 * previous decorative children itself.
 *
 * Finally calls `Animation.invalidateRig(animator)` so the animator
 * rebuilds its parent-first bone walk against the now-populated subtree.
 */
// derive an unauthored attach socket's local rest position from its parent
// bone's mesh geometry. hands sit at the bottom-centre of the arm (the hand);
// `back` at the centre of the torso's back (+Z) face — avatars face -Z. rest
// pose is axis-aligned, so we compose local translate/scale only (no rotation).
function deriveSocketPosition(boneNode: Node, handle: ModelHandle, socket: string): Vec3 | null {
    const meshes = handle.meshes as Record<string, { aabb: ArrayLike<number> } | undefined>;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let found = false;
    const walk = (node: Node, ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void => {
        const meshName = getTrait(node, MeshTrait)?.meshId?.meshName;
        const aabb = meshName ? meshes[meshName]?.aabb : undefined;
        if (aabb) {
            found = true;
            minX = Math.min(minX, ox + sx * aabb[0]); maxX = Math.max(maxX, ox + sx * aabb[3]);
            minY = Math.min(minY, oy + sy * aabb[1]); maxY = Math.max(maxY, oy + sy * aabb[4]);
            minZ = Math.min(minZ, oz + sz * aabb[2]); maxZ = Math.max(maxZ, oz + sz * aabb[5]);
        }
        for (const child of node.children) {
            const t = getTrait(child, TransformTrait);
            walk(
                child,
                ox + sx * (t?.position[0] ?? 0), oy + sy * (t?.position[1] ?? 0), oz + sz * (t?.position[2] ?? 0),
                sx * (t?.scale[0] ?? 1), sy * (t?.scale[1] ?? 1), sz * (t?.scale[2] ?? 1),
            );
        }
    };
    walk(boneNode, 0, 0, 0, 1, 1, 1);
    if (!found) return null;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    // back → centre of the rear (+Z) face; hands → bottom-centre (the hand).
    return socket === RIG_6BONE_BACK ? [cx, cy, maxZ] : [cx, minY, cz];
}

function mountRig(playerNode: Node, handle: ModelHandle): void {
    const loadedRoot = handle.scene;
    if (!loadedRoot) return;

    ensureCanonicalBones(playerNode);

    // Who builds the model's mesh nodes: the server builds them for every node it
    // owns and replicates them to clients; a client builds only its own local nodes.
    // For a server-owned rig the meshes arrive via replication, so a client must NOT
    // clone them here — doing so double-mounts them and (because avatars share mesh
    // node names) leaves a base/loaded mix on a swap. Bones/sockets are matched +
    // TRS-copied regardless (cheap, idempotent); only the mesh clone is gated.
    const localAuthority = env.server || isLocalNode(playerNode);

    // persistent rig nodes (bones + attach sockets) are matched by name and have
    // their TRS copied from the loaded model; everything else is a model clone.
    const canonical = new Set<string>(RIG_6BONE_PERSISTENT_NODES);
    // the current model's nodes we add below are recorded on the character so
    // `unmountRig` drops exactly these on a swap, leaving runtime attachments
    // (gear) alone — ownership by node identity, never by name.
    const modelNodes = getTrait(playerNode, CharacterTrait)?.state.modelNodes;

    const visit = (loaded: Node, placeholder: Node | null): void => {
        // copy loaded TRS onto the matched placeholder (if any).
        if (placeholder) {
            const loadedTransform = getTrait(loaded, TransformTrait);
            if (loadedTransform) {
                const ph = getTrait(placeholder, TransformTrait);
                if (ph) {
                    setTransform(
                        ph,
                        loadedTransform.position,
                        loadedTransform.quaternion,
                        loadedTransform.scale,
                    );
                }
            }
        }

        for (const loadedChild of loaded.children) {
            const childName = loadedChild.name ?? '';
            if (canonical.has(childName)) {
                // canonical child → look up the placeholder bone by name
                // anywhere under playerNode (placeholder is flat, so this
                // resolves regardless of the loaded tree's shape).
                const phChild = findByName(playerNode, childName);
                visit(loadedChild, phChild);
                continue;
            }
            // non-canonical child (mesh / decorative bone), cloned under whatever
            // placeholder bone we last matched (falls back to playerNode when the
            // loaded root itself was non-canonical, e.g. the synthetic wrapper around
            // a multi-root scene). Only the locally-authoritative side builds these —
            // a client defers a server-owned rig's meshes to replication (see
            // `localAuthority`). The reconciler always unmounts before mounting, so
            // there's never an existing child to reconcile against: clone fresh and
            // record it on `modelNodes` so unmountRig destroys exactly it on the swap.
            if (!localAuthority) continue;
            const parent = placeholder ?? playerNode;
            const fresh = cloneNode(loadedChild);
            addChild(parent, fresh);
            modelNodes?.add(fresh);
        }
    };

    // Seed the walk: if the loaded root is itself canonical, match it;
    // otherwise it's a synthetic / decorative wrapper — skip the TRS
    // copy and just recurse into its children.
    const rootName = loadedRoot.name ?? '';
    const rootPlaceholder = canonical.has(rootName)
        ? findByName(playerNode, rootName)
        : null;
    visit(loadedRoot, rootPlaceholder);

    // drive any attach socket the model didn't author from its parent bone's
    // geometry, so gear has a usable mount point without the author placing one.
    // An authored socket was matched + TRS-copied by the visit above; skip it.
    const handleNodes = handle.nodes as Record<string, Node | undefined>;
    for (const socket of RIG_6BONE_ATTACH_NODES) {
        if (handleNodes[socket]) continue;
        const parentName = RIG_6BONE_PARENT_OF[socket];
        const boneNode = parentName ? handleNodes[parentName] : undefined;
        const socketNode = findByName(playerNode, socket);
        const socketTransform = socketNode ? getTrait(socketNode, TransformTrait) : undefined;
        if (!boneNode || !socketTransform) continue;
        const pos = deriveSocketPosition(boneNode, handle, socket);
        if (!pos) continue;
        setPosition(socketTransform, pos);
        // hands get the grip rotation so a held item sits perpendicular to the arm
        // (an outstretched arm points it up); back stays flat (identity).
        if (socket !== RIG_6BONE_BACK) setQuaternion(socketTransform, HAND_GRIP_ROTATION);
    }

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);

    // Sample voxel light from the torso center, not the feet. The animator
    // installs the shared-light ModelTrait on this node; ensure it exists
    // (server has no animator) and point its sample at half standing height.
    const model = getTrait(playerNode, ModelTrait) ?? addTrait(playerNode, ModelTrait);
    vec3.set(model.lightOffset, 0, LIGHT_SAMPLE_HEIGHT, 0);
}

/**
 * Unmount the current model: reset each canonical bone's TRS to identity and
 * remove exactly the model's nodes recorded in `state.modelNodes` (its
 * mesh/visual nodes). Runtime attachments (gear `addChild`'d by the game) are
 * NOT in that set, so they survive untouched — ownership is by node identity,
 * not by name. The canonical bones themselves are never destroyed (node +
 * AnimatorTrait identity preserved across swaps).
 */
function unmountRig(playerNode: Node): void {
    // persistent = bones + attach sockets; never dropped, only their TRS resets.
    const canonical = new Set<string>(RIG_6BONE_PERSISTENT_NODES);
    const modelNodes = getTrait(playerNode, CharacterTrait)?.state.modelNodes;

    // Recurse into each canonical bone: reset its TRS, recurse into canonical
    // sub-bones, and remove only the nodes recorded as the model's. Anything
    // else (runtime gear) is left in place.
    const resetBone = (node: Node): void => {
        const transform = getTrait(node, TransformTrait);
        if (transform) {
            setTransform(transform, _identityPos, _identityQuat, _identityScale);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            const child = node.children[i]!;
            if (canonical.has(child.name ?? '')) {
                resetBone(child);
            } else if (modelNodes?.has(child)) {
                // destroyNode (not removeChild) so the removal parks in the discovery
                // dirty set and replicates as `node_destroyed` — else clients keep the
                // old mesh nodes (replicated) and show a base/loaded mix on a swap.
                destroyNode(child);
            }
        }
    };

    for (let i = playerNode.children.length - 1; i >= 0; i--) {
        const child = playerNode.children[i]!;
        if (canonical.has(child.name ?? '')) {
            resetBone(child);
        } else if (modelNodes?.has(child)) {
            destroyNode(child);
        }
    }

    // every recorded model node is now removed (subtrees and all); clear the
    // set so the next mount starts fresh.
    modelNodes?.clear();

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);
}

/**
 * Per-frame procedural locomotion. Writes arm/leg bone rotations as a
 * composition of two small rotations:
 *
 *   - X swing (fore/aft): `sin(bobPhase + offset) * amp * MAX`. one leg
 *     cycle per foot-plant (2π of bobPhase). gait-correct alternation
 *     would want `bobPhase * 0.5` (one stride pair per cycle), but the
 *     faster scissor reads more energetic at the tradeoff that both
 *     legs return to the same position each plant.
 *     `amp = clamp(horizSpeed / SWING_SPEED_REF, 0, 1)` so a walk swings
 *     less than a sprint and a stationary character sits at rest.
 *     opposing legs are π out of phase; arms counter-swing so the
 *     same-side arm and leg move opposite (matches real gait).
 *
 *   - Z tilt (arms only — outward roll): `baseline + breath * sin(t)`.
 *     idle gives a subtle outward lean that breathes; running widens
 *     both terms via lerp on `amp` so sprinting arms splay further
 *     and oscillate harder. breath phase is an independent slow clock
 *     (`ARM_BREATH_RATE`) so it doesn't stall when the character is
 *     standing still and doesn't beat against gait frequencies.
 *
 * Assumes canonical arm/leg bones are authored with identity rotation
 * (hanging at rest). If a future avatar bakes a non-identity rest into
 * its limbs, add a rest-quaternion compose step here.
 */
function driveProceduralLocomotion(
    playerNode: Node,
    t: CharacterTrait,
    cc: CharacterControllerTrait,
    delta: number,
): void {
    const vx = cc.state.velocity[0];
    const vz = cc.state.velocity[2];
    const horizSpeed = Math.sqrt(vx * vx + vz * vz);
    const amp = Math.min(horizSpeed / SWING_SPEED_REF, 1);

    const swing = Math.sin(cc.state.bobPhase) * amp;

    // crouch lean rides `waist` — it carries body + head + arms in the flat rig,
    // so one tilt leans the whole upper body while the legs (separate roots) stay
    // planted. head-look cancels this same pitch so the face keeps aiming true.
    applyLimb(playerNode, 'waist', cc.state.crouchAmount * CROUCH_BODY_PITCH_RAD, 0);
    applyWaistCrouchDrop(playerNode, t, cc.state.crouchAmount);

    t.state.breathPhase = (t.state.breathPhase + delta * ARM_BREATH_RATE) % TAU;
    const baselineTilt = ARM_IDLE_TILT_RAD + (ARM_RUN_TILT_RAD - ARM_IDLE_TILT_RAD) * amp;
    const breathAmp = ARM_IDLE_BREATH_RAD + (ARM_RUN_BREATH_RAD - ARM_IDLE_BREATH_RAD) * amp;
    const tiltOut = baselineTilt + Math.sin(t.state.breathPhase) * breathAmp;

    applyLimb(playerNode, 'leg_left', swing * LEG_SWING_MAX_RAD, 0);
    applyLimb(playerNode, 'leg_right', -swing * LEG_SWING_MAX_RAD, 0);
    // arms counter-swing fore/aft; tilt outward — opposite Z sign per side.
    applyLimb(playerNode, 'arm_left', -swing * ARM_SWING_MAX_RAD, -tiltOut);
    applyLimb(playerNode, 'arm_right', swing * ARM_SWING_MAX_RAD, tiltOut);
}

function applyLimb(playerNode: Node, boneName: string, xAngle: number, zAngle: number): void {
    const bone = findByName(playerNode, boneName);
    if (!bone) return;
    const transform = getTrait(bone, TransformTrait);
    if (!transform) return;
    quat.setAxisAngle(_qSwingX, _LIMB_X_AXIS, xAngle);
    quat.setAxisAngle(_qTiltZ, _LIMB_Z_AXIS, zAngle);
    quat.multiply(_qLimbOut, _qSwingX, _qTiltZ);
    setQuaternion(transform, _qLimbOut);
}

/** Sink + shift-back the `waist` bone by `crouchAmount · CROUCH_WAIST_DROP`
 *  in Y and `crouchAmount · CROUCH_WAIST_BACK` in +Z (avatars face -Z),
 *  relative to its rest position. Rest comes from `t.state.modelHandle.nodes.waist`
 *  — the reconciler writes that handle whenever it mounts a rig, so this
 *  is one indexed lookup with no `findByName` walk on the rest pose.
 *  Caller guarantees `state.modelId !== null` (skipped at the iteration
 *  guard), but the handle can still be null transiently — bail. */
function applyWaistCrouchDrop(
    playerNode: Node,
    t: CharacterTrait,
    crouchAmount: number,
): void {
    if (!t.state.modelHandle) return;
    const restWaist = t.state.modelHandle.nodes.waist;
    if (!restWaist) return;
    const restTransform = getTrait(restWaist, TransformTrait);
    if (!restTransform) return;

    const waistBone = findByName(playerNode, 'waist');
    if (!waistBone) return;
    const waistTransform = getTrait(waistBone, TransformTrait);
    if (!waistTransform) return;

    _waistPos[0] = restTransform.position[0];
    _waistPos[1] = restTransform.position[1] - crouchAmount * CROUCH_WAIST_DROP;
    // avatars are authored facing -Z, so backward in local frame is +Z.
    _waistPos[2] = restTransform.position[2] + crouchAmount * CROUCH_WAIST_BACK;
    setPosition(waistTransform, _waistPos);
}


/** resolve foot-sample block once, play SFX, conditionally emit dust.
 *  shared between the landing-edge branch and the phase-bucket
 *  footstep branch so the lookup never drifts between the two paths.
 *
 *  `BlockRegistry.sounds` and `.particles` are per-state arrays
 *  indexed directly by global state id — `cc.groundBlockState` is
 *  exactly that id, owner-written each tick from the post-move
 *  contacts (or the feet liquid voxel while swimming) and synced.
 *  no `stateToBlockIndex` indirection, no owner/remote drift. */
function emitFootstep(
    ctx: ScriptContext,
    cc: CharacterControllerTrait,
    transform: TransformTrait,
    owner: boolean,
    volume: number,
    spawnDust: boolean,
): void {
    const footBlockState = cc.state.groundBlockState;
    if (footBlockState === 0) return;

    const sounds: BlockSoundConfig | undefined = ctx.blocks.sounds[footBlockState];
    const clips = sounds?.footstep;
    if (clips && clips.length > 0) {
        const clip = clips[Math.floor(Math.random() * clips.length)]!;
        const detune = (Math.random() * 2 - 1) * FOOTSTEP_DETUNE_CENTS;
        if (owner) {
            playMono(ctx, clip, { volume, detune });
        } else {
            playAt(ctx, clip, transform.position, { volume, detune });
        }
    }

    if (spawnDust) {
        const particles: BlockParticleConfig | undefined = ctx.blocks.particles[footBlockState];
        if (particles) spawnFootstepDust(ctx, particles, transform.position);
    }
}

/** one-shot on the feet-enter-liquid edge — plays the liquid block's
 *  `footstep` clips (same pool the swim stroke cadence draws from)
 *  at the louder landing volume so it reads as a splash, and spawns
 *  a droplet burst reusing the auto-derived `dust` variants. */
function emitSplash(
    ctx: ScriptContext,
    cc: CharacterControllerTrait,
    transform: TransformTrait,
    owner: boolean,
    volume: number,
): void {
    emitFootstep(ctx, cc, transform, owner, volume, false);
    const footBlockState = cc.state.groundBlockState;
    const particles: BlockParticleConfig | undefined = ctx.blocks.particles[footBlockState];
    if (particles) spawnSplashDroplets(ctx, particles, transform.position);
}

const SPLASH_DROPLET_COUNT = 6;

/** spawn a small burst of droplets at the character's feet on liquid
 *  entry. reuses the per-block `dust` variants (auto-derived from the
 *  top-face texture, so water blocks ship water-tinted slices for
 *  free) with splashier tuning — wider horizontal spread and higher
 *  upward velocity than the footstep puff. */
function spawnSplashDroplets(
    ctx: ScriptContext,
    particles: BlockParticleConfig,
    pos: Vec3,
): void {
    const variants = particles.dust;
    if (!variants || variants.length === 0) return;
    for (let i = 0; i < SPLASH_DROPLET_COUNT; i++) {
        const handle = variants[Math.floor(Math.random() * variants.length)]!;
        spawnParticle(ctx, handle, pos, {
            velX: (Math.random() - 0.5) * 3,
            velY: 4 + Math.random() * 2,
            velZ: (Math.random() - 0.5) * 3,
            lifetime: 0.5 + Math.random() * 0.3,
            size: 0.04 + Math.random() * 0.06,
        });
    }
}

/** spawn a small burst of dust puffs at the character's feet. picks
 *  from the resolved state's `particles.dust` (auto-derived per-block
 *  dust variants by default; user-overridable via `BlockParticleConfig`).
 *  numbers are tuned starting points — `particleUpdate.dust` already
 *  applies gravity + drag + ground-collide-destroy so the puff settles
 *  on its own. */
function spawnFootstepDust(
    ctx: ScriptContext,
    particles: BlockParticleConfig,
    pos: Vec3,
): void {
    const variants = particles.dust;
    if (!variants || variants.length === 0) return;
    for (let i = 0; i < FOOTSTEP_DUST_COUNT; i++) {
        const handle = variants[Math.floor(Math.random() * variants.length)]!;
        spawnParticle(ctx, handle, pos, {
            velX: (Math.random() - 0.5) * 1.2,
            velY: 5 + Math.random() * 0.2,
            velZ: (Math.random() - 0.5) * 1.2,
            lifetime: 0.4 + Math.random() * 0.2,
            size: 0.05 + (Math.random() * 0.1),
        });
    }
}

/** Walk the playerNode subtree and toggle `.visible` on every MeshTrait.
 *  Avatars render as meshes only (sprites / voxel-meshes never appear
 *  under a rig), so MeshTrait alone covers the visual surface.
 *  Idempotent — safe to call every frame. */
function setCharacterSubtreeVisible(root: Node, visible: boolean): void {
    const mesh = getTrait(root, MeshTrait);
    if (mesh) mesh.visible = visible;
    for (const child of root.children) {
        setCharacterSubtreeVisible(child, visible);
    }
}

/** Walk the playerNode subtree and apply `dither` to every MeshTrait.
 *  Skips the trait._version bump when the value is unchanged so the
 *  renderer doesn't re-upload InstanceParams every frame on a steady
 *  fade level. */
function setCharacterSubtreeDither(root: Node, dither: number): void {
    const mesh = getTrait(root, MeshTrait);
    if (mesh && mesh.dither !== dither) setMeshDither(mesh, dither);
    for (const child of root.children) {
        setCharacterSubtreeDither(child, dither);
    }
}
