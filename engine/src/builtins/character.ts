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
};

import type { ScriptContext } from '../core/scene/scripts';
import type { Quat, Vec3 } from 'mathcat';
import { degreesToRadians, quat } from 'mathcat';
import { RIG_6BONE_REQUIRED_NODES, RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import { wrapPi } from '../core/math/angles';
import type { ModelHandle } from '../core/models/handle';
import { baseAvatar, BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';
import { getModel } from '../api/models';
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
    findByName,
    getTrait,
    hasTrait,
    type Node,
    removeChild,
} from '../api/scene-graph';
import { getControlNode, isOwner, onFrame, query, script } from '../api/scripts';
import { sync, trait, type TraitType } from '../api/traits';
import { setPosition, setQuaternion, setTransform } from '../api/transforms';
import { playAt, playMono } from '../api/audio';
import { spawnParticle } from '../api/particles';
import { AnimatorTrait } from './animator';
import { CharacterControllerTrait } from './character-controller';
import { FlyControllerTrait } from './fly-controller';
import { MeshTrait, setMeshDither } from './mesh';
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
// One onFrame, one pass over `q.matches` per character. Four concerns
// hosted here because they all share the same query and have no ordering
// hazard between them:
//
//   1. rig reconciler — convergence of `def.modelId` (intent) toward
//      `state.modelId` (fact). Runs on BOTH sides. First pass per
//      character mounts the baseAvatar placeholder so subsequent frames
//      have bones to write to; once the target `def.modelId` is in
//      Resources, unmounts and re-mounts the real rig. Loading state
//      is `def.modelId !== state.modelId` for any consumer that needs it.
//
//   2. locomotion — procedural head/limb pose. Writes bone TRS each
//      frame (no clips, no animator state). Inputs (`cc.velocity`,
//      `cc.bobPhase`, `cc.look`, player yaw) are synced/locally-
//      integrated on both sides, so running client-only still produces
//      the same pose every client sees.
//
//   3. POV visibility / proximity dither — hide own body in
//      first-person / orbit / fly POV; screen-door fade other
//      characters the active camera is standing inside of.
//
//   4. footstep + landing thud sfx + dust/droplet vfx — bob-phase
//      bucket crossings drive cadence, edge detectors drive landings
//      and liquid entry.
//
// (1) runs on every side. (2)–(4) are client-only and skip when
// `state.modelId` is null (no bones yet — first reconciler tick).
// AnimatorTrait scripts tick after this onFrame and overwrite any bone
// whose currently-playing clip channels target it — that's the emote /
// upper-body-mask path. To opt out of engine-driven limb swing, set
// `t.config.animation = false` and own the bones yourself.
//
// Characters without a CharacterControllerTrait (e.g. idle NPCs) drop
// out of the query naturally.
script(WorldTrait, 'character', (ctx) => {
    const q = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);

    onFrame(ctx, ({ delta }) => {
        const controlNode = getControlNode(ctx);
        const camera = getControlCamera(ctx);

        for (const [t, cc, transform] of q.matches) {
            const node = t._node;

            // ── rig reconciler ─────────────────────────────────────
            // Converge `state.modelId` (fact) toward `def.modelId`
            // (intent). Three cases:
            //   - already matches → no-op.
            //   - target's payload is hydrated → unmount previous (if
            //     any), mount target, write state.
            //   - target not loaded, nothing mounted → install
            //     baseAvatar placeholder (always present via codegen)
            //     so consumers have bones immediately. A later frame
            //     will swap once the target lands.
            // Runs on every side; both server and client need bones
            // for `findByName(node, 'head')` and for animator ticks.
            if (t.state.modelId !== t.modelId) {
                const handle = getModel(ctx, t.modelId);
                if (handle) {
                    if (t.state.modelId !== null) unmountRig(node);
                    mountRig(node, handle);
                    t.state.modelId = t.modelId;
                    t.state.modelHandle = handle;
                } else if (t.state.modelId === null) {
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

            // ── locomotion ──────────────────────────────────────────
            // head bone follow: every side derives head local rotation
            // from the synced `cc.look` + the synced player transform
            // yaw. independent of `t.config.animation`; head tracking
            // is a controller affordance, not a swing clip.
            updateHeadOrientation(node, cc, transform);

            // arm/leg swing. per-character opt-out via `t.config.animation`.
            if (t.config.animation) driveProceduralLocomotion(node, t, cc, delta);

            // ── loading-state pulse ────────────────────────────────
            // Drive a pulsing dither while the intent modelId hasn't
            // resolved (placeholder mounted), decay it off once the
            // target lands. Combined with proximity dither below via
            // max() so a loading character close to camera still reads
            // as loading, not as faded.
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
                // applies to own body.
                finalDither = hide ? 0 : t.state.loadingDither;
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
                finalDither = Math.max(proxDither, t.state.loadingDither);
            }
            if (t.state.appliedDither !== finalDither) {
                setCharacterSubtreeDither(node, finalDither);
                t.state.appliedDither = finalDither;
            }

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
});

/** Rotate the canonical `head` bone to point at `cc.look`. yaw is the
 *  delta between look-yaw and the body's yaw (which already tracks
 *  velocity within ±BODY_YAW_LIMIT_RAD on the controller side, so this
 *  delta is naturally bounded); pitch is `look[2] - π/2` clamped to
 *  ±HEAD_PITCH_LIMIT_RAD. composed as `Ryaw · Rpitch` so the head pitches
 *  in its own local frame after yawing — matches FPS look feel.
 *
 *  When the body bone is tilted by the sneak pose (driven by
 *  `cc.state.crouchAmount` on the controller), subtract the body's pitch
 *  from the head's local pitch so the face still aims at the world look
 *  direction. Small-angle approximation — body pitch and head yaw don't
 *  commute, but at ±28°/±60° the visual error is below the threshold of
 *  notice. */
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
 * Canonical 6bone parenting. waist + legs hang off `playerNode`; body
 * nests inside waist so torso rotation propagates; head + arms nest
 * inside body so they ride along. Authoring tools MUST produce this
 * hierarchy — mount copies each loaded bone's *local* TRS onto its
 * matching canonical bone, so a flat export would apply scene-space TRS
 * as if it were local-to-parent and visually shear the rig.
 *
 *     playerNode (AnimatorTrait)
 *       ├ waist
 *       │   └ body
 *       │       ├ head
 *       │       ├ arm_left
 *       │       └ arm_right
 *       ├ leg_left
 *       └ leg_right
 */
const RIG_6BONE_PARENT_OF: Record<string, string | null> = {
    waist: null,
    leg_left: null,
    leg_right: null,
    body: 'waist',
    head: 'body',
    arm_left: 'body',
    arm_right: 'body',
};

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
    for (const name of RIG_6BONE_REQUIRED_NODES) {
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
    for (const name of RIG_6BONE_REQUIRED_NODES) {
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
function mountRig(playerNode: Node, handle: ModelHandle): void {
    const loadedRoot = handle.scene;
    if (!loadedRoot) return;

    ensureCanonicalBones(playerNode);

    const canonical = new Set<string>(RIG_6BONE_REQUIRED_NODES);

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
            // non-canonical: clone subtree + attach under whatever
            // placeholder bone we last matched (falls back to playerNode
            // when the loaded root itself was non-canonical, e.g. the
            // synthetic wrapper around a multi-root scene).
            addChild(placeholder ?? playerNode, cloneNode(loadedChild));
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

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);
}

/**
 * Reset the rig back to placeholder: drop every non-canonical child
 * under each canonical bone (and any decorative clones that got
 * parented directly to the player node), and zero out canonical bone
 * TRS to identity so a subsequent mount starts from a clean rest pose.
 * The placeholder bones themselves are never destroyed (preserving
 * node + AnimatorTrait identity across swaps).
 */
function unmountRig(playerNode: Node): void {
    const canonical = new Set<string>(RIG_6BONE_REQUIRED_NODES);

    // Recurse into each canonical bone: reset its TRS to identity,
    // recurse into any canonical sub-bones, and drop everything else
    // (decorative clones from the prior mount).
    const resetBone = (node: Node): void => {
        const transform = getTrait(node, TransformTrait);
        if (transform) {
            setTransform(transform, _identityPos, _identityQuat, _identityScale);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            const child = node.children[i]!;
            if (canonical.has(child.name ?? '')) {
                resetBone(child);
            } else {
                removeChild(node, child);
            }
        }
    };

    for (let i = playerNode.children.length - 1; i >= 0; i--) {
        const child = playerNode.children[i]!;
        if (canonical.has(child.name ?? '')) {
            resetBone(child);
        } else {
            removeChild(playerNode, child);
        }
    }

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

    applyLimb(playerNode, 'body', cc.state.crouchAmount * CROUCH_BODY_PITCH_RAD, 0);
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
