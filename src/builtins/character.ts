/**
 * character, presentation layer for a humanoid character entity:
 * visuals (avatar model + procedural limb swing) + sfx (footstep audio) +
 * vfx (block-dust particles). pairs with CharacterControllerTrait,
 * the controller drives state (position, velocity, grounded, bobPhase,
 * sprint, groundBlockState), this trait renders/sounds it.
 *
 * Data-driven: `def.modelId` (intent, what should be mounted) +
 * `state.modelId` (fact, what IS mounted). A single WorldTrait-hosted
 * script reconciles them each frame and, on client, drives presentation:
 *
 *   - rig reconciler, runs on every side. When `def.modelId !==
 *     state.modelId`: if the target is in `Resources`, unmount the
 *     previous rig (if any) and mount the target; otherwise install
 *     `BUILTIN_BASE_AVATAR_ID` as a placeholder so gameplay code can
 *     name-resolve bones (`head`, `arm_left`, …) from frame zero. The
 *     server avatar pipeline writes `def.modelId` once its load lands
 *     (`server/avatars.ts`), the reconciler picks it up next frame.
 *     Loading state is `def.modelId !== state.modelId` for any consumer
 *     that needs it.
 *
 *   - locomotion (client). procedural arm/leg swing keyed off
 *     `cc.bobPhase` and horizontal speed, plus head-look orientation.
 *     No clips, no animator state, bones are written directly each
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
 *     non-positional (`playMono`) at a louder fixed gain, their own
 *     footsteps should sit up in the mix and not pan around the
 *     listener; remote characters play positional via `playAt`.
 *     Ground-block resolution: `cc.groundBlockState` (synced uint16)
 *     indexes directly into `BlockRegistry.sounds[]` and `.particles[]`
 *     so owner + remote follow one lookup, no drift. Particles emit on
 *     landing edges always, on phase crossings only when sprinting,
 *     walking is quiet visually, sprinting kicks dust.
 *
 * Crossing-detector "previous" values come from `cc.state.previousGrounded`
 * and `cc.state.previousBobPhase`, snapshotted by the controller at the
 * end of each tick, robust to multiple controller ticks per frame.
 */

type CharacterConfig = {
    animation: boolean;
    footstepVolume: number;
    ownFootstepVolume: number;
    landingVolume: number;
    ownLandingVolume: number;
    landingCooldown: number;
    proximityFadeRange: number;
    dither: number;
};

type CharacterState = {
    /** what IS currently mounted on the player node (the *fact*, paired
     *  with `def.modelId`, the *intent*). The WorldTrait reconciler
     *  converges them each frame: when `state.modelId !== modelId`, it
     *  mounts (placeholder first, then the target once `getModel(ctx, id)`
     *  returns non-null) and writes the new value here. `null` means nothing is
     *  mounted yet, first reconciler tick after trait add will install
     *  baseAvatar.def as a placeholder. */
    modelId: string | null;
    /** the resolved ModelDef for `state.modelId`. The reconciler writes
     *  this on every mount so consumers (crouch drop, future rest-pose
     *  lookups) can read `state.modelDef.nodes.<bone>` directly without
     *  re-resolving each frame. `null` mirrors `state.modelId === null`;
     *  consumers gate on `state.modelId` instead. */
    modelDef: ModelDef | null;
    breathPhase: number;
    /** eased turn lean (rad, Z roll on the waist). tracks the body's yaw
     *  rate; see `TURN_BANK_PER_RAD_S`. */
    turnBank: number;
    /** previous frame's visual body yaw (rad), the differencing input for
     *  `turnBank`. `turnBankInit` gates the first frame, whose delta would
     *  otherwise be a full-circle spike against the 0 default. */
    previousVisualYaw: number;
    turnBankInit: boolean;
    /** peak downward speed (m/s) since the character last left the ground,
     *  the landing reaction's strength input. Consumed and reset on
     *  touchdown. Read off `cc.state.velocity`, which is the owner's own
     *  integration and the synced value on a remote, so both sides react. */
    fallSpeedPeak: number;
    /** landing compression: 1 is a full-strength impact, negative is the
     *  spring's rebound past rest (hips lift, legs stretch, feet stay put).
     *  Spring position, integrated against `landingSpringVelocity`. */
    landingSquash: number;
    landingSpringVelocity: number;
    /** decaying visual offset absorbing the sim's `bobPhase` re-anchors;
     *  see `BOB_PHASE_CATCHUP_RATE`. Wrapped to ±π. */
    bobPhaseCatchUp: number;
    /** previous frame's raw `cc.state.bobPhase`, the differencing input that
     *  spots those re-anchors. */
    previousRawBobPhase: number;
    /** the two idle head-drift clocks (rad); see `IDLE_DRIFT_YAW_RATE`. */
    idleDriftYawPhase: number;
    idleDriftPitchPhase: number;
    /** seconds until this character's next idle weight shift. Counts down
     *  only while idle, and is re-rolled per shift so characters stay out
     *  of step with each other. */
    idleBreakDelay: number;
    /** progress through the current weight shift, 0 → 1; 1 means none is
     *  running. */
    idleBreakProgress: number;
    /** which hip the next shift moves onto, ±1, alternating. */
    idleBreakSide: number;
    /** idle head drift, written by `updateIdleLife` and added by
     *  `updateHeadOrientation`. Read a frame later than written (the head
     *  is posed before the locomotion pass), which at these rates is
     *  invisible, and stays 0 when `config.animation` is off since nothing
     *  advances it. */
    headDriftYaw: number;
    headDriftPitch: number;
    landingCooldownRemaining: number;
    /** screen-door dither contribution from the "loading" placeholder
     *  state (intent.modelId not yet hydrated → placeholder mounted).
     *  Pulses while loading, decays linearly to 0 once the target lands
     *  so the swap eases instead of snapping. Combined with the proximity
     *  fade dither via max() in the presentation step. */
    loadingDither: number;
    /** last dither value applied via setCharacterSubtreeDither, or null when nothing has
     *  been applied yet. Used to skip the subtree walk on frames where the resolved value
     *  didn't change: steady-state characters (loaded, out of proximity range) pay one
     *  compare per frame instead of a full rig traversal. `mountRig` nulls it, because
     *  freshly added meshes carry the trait default rather than the applied value. */
    appliedDither: number | null;

    /** the current model's nodes that `mountRig` added on top of the enforced
     *  skeleton (its mesh/visual nodes). `unmountRig` removes exactly these on
     *  a swap and leaves runtime attachments (gear) alone, ownership by node
     *  identity, not name. Per-side, runtime-only; fresh per instance. */
    modelNodes: Set<Node>;
    /** this character's live canonical rig nodes, by name. The runtime counterpart to
     *  `ModelDef.nodes` (which is the shared asset's template): these are the nodes
     *  actually under this character.
     *
     *  Rebuilt by `ensureCanonicalBones` on every mount, which is every path that could
     *  invalidate it (placeholder mount, real-model mount, re-mount after a payload wipe).
     *  Safe to hold across model swaps because `unmountRig` only resets a canonical bone's
     *  TRS, never destroys it, so node identity survives.
     *
     *  Its validity condition is the invariant `unmountRig` already relies on: canonical
     *  bones stay in their canonical parent positions. Attach gear TO these nodes freely;
     *  do not reparent the nodes themselves. */
    nodes: RigNodes;
};

/** the enforced skeleton's node names; see `RIG_6BONE_PERSISTENT_NODES`. */
type RigNodeName = (typeof RIG_6BONE_PERSISTENT_NODES)[number];
/** fixed-shape name -> node map for the enforced skeleton. Fixed keys rather than a loose
 *  record so the per-frame reads are monomorphic. A slot is null until the first mount, and
 *  stays null for a rig that genuinely lacks that node. */
type RigNodes = Record<RigNodeName, Node | null>;

import type { Quat, Vec3 } from 'math';
import { degreesToRadians, quat } from 'math';
import { RIG_6BONE_ATTACH_NODES, RIG_6BONE_BACK, RIG_6BONE_REQUIRED_NODES, RIG_TYPE_6BONE } from '../../avatar/rig';
import { Animation } from '../api/animation';
import { playAt, playMono } from '../api/audio';
import { ensureModel, getModel } from '../api/models';
import { spawnParticle } from '../api/particles';
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
} from '../api/scene-tree';
import { isOwner, onDispose, onFrame, onInit, query } from '../api/scripts';
import { getCamera, getSubject } from '../api/subject';
import { dirty, type TraitType } from '../api/traits';
import {
    getVisualWorldQuaternion,
    getWorldPosition,
    setPosition,
    setQuaternion,
    setScale,
    setTransform,
} from '../api/transforms';
import { wrapPi } from '../core/math/angles';
import type { ModelDef } from '../core/models/handle';
import { BUILTIN_BASE_AVATAR_ID, baseAvatar } from '../core/player/base-avatar';
import { script, sync, trait } from '../core/registry';
import { pack } from '../core/scene/pack';
import type { TraitProps } from '../core/scene/scene-tree';
import type { ScriptContext } from '../core/scene/scripts';
import { BLOCK_FLAG_LIQUID } from '../core/voxels/block-registry';
import type { BlockParticleConfig, BlockSoundConfig } from '../core/voxels/blocks';
import { env } from '../env';
import { AnimatorTrait } from './animator';
import { CharacterControllerTrait } from './character-controller';
import { FlyControllerTrait } from './fly-controller';
import { MeshTrait } from './mesh';
import { ModelTrait } from './model';
import { OrbitControllerTrait } from './orbit-controller';
import { PlayerControllerTrait } from './player-controller';
import { TransformTrait } from './transform';
import { WorldTrait } from './world';

const TAU = Math.PI * 2;
// sin(bobPhase) trough, when the camera bob is at its lowest. that's
// the foot-plant moment in this controller's bob convention.
const FOOT_PHASE = (3 * Math.PI) / 2;

// max head pitch (rad). real necks crane ~60° up / ~75° down; symmetric
// 60° is a fine starting point, past this the head would clip into the
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

// ── loading-state dither pulse ─────────────────────────────────────
// While the intended `modelId` hasn't hydrated yet (placeholder rig
// shown), pulse the screen-door dither between two values so the
// character reads as "loading in" rather than as a final asset. Decays
// linearly to 0 once the target lands so the visual hand-off eases
// instead of snapping. Driven off a global clock so every loading
// character pulses in sync, cheaper than per-character phase, and
// a coherent group pulse reads better visually anyway.
const LOAD_PULSE_RATE_HZ = 1.2;
const LOAD_PULSE_MIN = 0.35;
const LOAD_PULSE_MAX = 0.75;
const LOAD_DECAY_PER_SEC = 12; // 1.0 → 0 in ~83ms

// half-range of per-step random detune in cents (100 = 1 semitone). each
// footstep picks uniformly in ±this so consecutive steps don't read as a
// metronome. 300 ≈ ±3 semitones, chunky enough to register on repeats
// without sounding broken.
const FOOTSTEP_DETUNE_CENTS = 400;

// procedural limb-swing tuning. peak swing angle (rad) reached when
// `horizSpeed >= SWING_SPEED_REF`; below that we lerp linearly to 0.
// matches the controller's sprint speed so a casual jog reads as a half-
// amplitude swing.
const LEG_SWING_MAX_RAD = degreesToRadians(55);
const ARM_SWING_MAX_RAD = degreesToRadians(35);
const SWING_SPEED_REF = 5.0;

// weight-shift on the waist, both terms on the same `sin(bobPhase)` clock
// as the limb swing. vertical is a dip only, never a rise: 0 at the top of
// the bob and -WAIST_BOB_DROP at the trough (`sin(bobPhase) = −1`, the same
// one the camera bob and the footstep detector use), so the torso settles
// onto each step instead of floating. roll rocks the upper body toward the
// leading leg, deepest exactly where the settle is.
const WAIST_BOB_DROP = 0.03;
const WAIST_STRIDE_ROLL_RAD = degreesToRadians(1);

// stride reach at speed. `amp` saturates at `SWING_SPEED_REF`, which the
// default walk already hits, so without this a sprint is a walk cycle
// played faster: same reach, and the legs read as sliding rather than
// driving. Scales the limb swing (not the waist terms) from 1 at walk
// speed to this at sprint speed, so a run covers more ground per step.
const SPRINT_SWING_BOOST = 1.15;

// hip drop, the one vertical currency the crouch, the gait settle and the
// landing reaction all pay into. The waist sinks by it and each leg both
// sinks by it and scales its Y by `(hip - drop) / hip`, so the leg (pivoted
// at the hip, geometry hanging to y=0) still exactly reaches the ground:
// hips down, feet planted, leg visibly compressed. That's the squat the
// 6bone rig can't get from a knee joint it doesn't have.
//
// Clamped per leg to a fraction of that leg's own rest hip height, so
// stacking crouch + a hard landing can't invert the leg or fold the
// character into the floor. A rig whose leg pivot isn't the hip (origin at
// or below the foot, no length to compress) is posed by rotation alone.
const MAX_HIP_DROP_FRACTION = 0.5;
const MIN_HIP_HEIGHT = 0.05;

// chest, on the `body` bone. Its siblings under the waist are the head and
// the arms, so this leans the torso alone: the face keeps aiming true (no
// head-look compensation needed, unlike the waist's crouch pitch) and the
// arms keep swinging from the shoulders. Negative X pitches forward.
//   - lean: grows with speed, walk baseline widening toward the run value.
//   - heave: pitch oscillation at step rate, lagging the legs slightly so
//     the torso reads as following the stride rather than driving it.
//   - fold: extra forward pitch under the landing reaction, the torso
//     absorbing the impact.
const CHEST_WALK_LEAN_RAD = degreesToRadians(3);
const CHEST_RUN_LEAN_RAD = degreesToRadians(9);
const CHEST_HEAVE_RAD = degreesToRadians(4);
const CHEST_HEAVE_PHASE_LAG = 0.5;
const CHEST_LANDING_FOLD_RAD = degreesToRadians(14);
// arms swing forward under the same impact (positive X swings a hanging arm
// toward -Z, the facing direction), so the landing reads as a whole-body
// absorb instead of the hips dipping under a rigid upper body.
const LANDING_ARM_RAISE_RAD = degreesToRadians(16);

// landing reaction. Impact strength is the peak fall speed since takeoff,
// ramped from MIN (below it, stepping off a slab does nothing) to REF (a
// full-strength compression). The floor is low on purpose: every jump bobs,
// including a hop on the spot, which lands at about `jumpSpeed` = 7 m/s and
// so reads at ~0.7. MIN is there to keep stepping off a slab from twitching,
// not to reserve the reaction for real falls; anything from height saturates.
//
// Strength enters the damped spring as a *velocity impulse*, not a position:
// the hips travel down over ~0.1s, bottom out, and swing back up, which is
// the bob a body actually does. Setting the position instead would put the
// character at full compression on the impact frame and animate only the
// recovery, reading as a teleport. The rebound carries slightly past rest,
// where the legs stretch rather than lift because the feet stay pinned.
// IMPULSE is scaled so full strength peaks at ~1: for x'' = −kx − cx' the
// peak of an impulse response is v0·0.046 at this stiffness and damping.
// The spring step's delta is capped: a long frame would integrate to
// nonsense at this stiffness.
const LANDING_MIN_SPEED = 2;
const LANDING_REF_SPEED = 9;
const LANDING_DROP = 0.22;
const LANDING_SPRING_STIFFNESS = 120;
const LANDING_SPRING_DAMPING = 13;
const LANDING_SPRING_IMPULSE = 22;
const LANDING_SPRING_MAX_VELOCITY = 33;
const LANDING_REBOUND_LIMIT = -0.35;
const LANDING_SPRING_MAX_STEP = 1 / 30;

// `bobPhase` is re-anchored hard by the controller (jammed to FOOT_PHASE on
// landing / liquid entry, to 0 when you stop) to keep the footstep cadence
// exact. Presentation can't take that as a step: a phase jump teleports the
// legs mid-swing. So any implausible jump in the sim phase is absorbed into
// a decaying visual offset, wrapped to ±π since the swing is 2π-periodic,
// and the legs glide into the new cadence over ~150ms. The sim phase and
// therefore the footstep bucket detector are untouched.
const BOB_PHASE_MAX_ADVANCE_PER_S = 25;
const BOB_PHASE_CATCHUP_RATE = 9;

// idle life. Standing still is where a character most reads as a prop, so
// three things run only there: the breath (already driving the arm tilt)
// also lifts the waist and expands the chest, the head drifts on two slow
// non-harmonic clocks so it wanders instead of ticking, and every few
// seconds the character shifts its weight onto one hip.
//
// All of it scales by `idle`, 1 when stationary and 0 by IDLE_SPEED_REF, so
// it fades out the instant you walk rather than fighting the gait, and is
// off entirely in the air. The weight-shift timer only counts down while
// idle, otherwise a long walk would burn through the delay and fire a shift
// the moment you stopped.
const IDLE_SPEED_REF = 0.6;
const IDLE_BREATH_RISE = 0.009;
const IDLE_BREATH_CHEST_RAD = degreesToRadians(1.2);
// two clocks rather than one, at a deliberately non-harmonic ratio: the
// head traces a slow open path instead of retracing one line. Each wraps at
// its own 2π, so neither jumps when the other does.
const IDLE_DRIFT_YAW_RATE = 0.55;
const IDLE_DRIFT_PITCH_RATE = 0.34;
const IDLE_HEAD_DRIFT_YAW_RAD = degreesToRadians(3);
const IDLE_HEAD_DRIFT_PITCH_RAD = degreesToRadians(1.5);
// weight shift: waist rolls and slides onto one hip, alternating sides,
// eased 0 → 1 → 0 across the move. The delay is per character and random,
// so a crowd doesn't shift in unison; it's client-local and unsynced,
// nobody can tell that two viewers see the same character shift at
// different moments.
const IDLE_BREAK_MIN_DELAY = 4;
const IDLE_BREAK_MAX_DELAY = 9;
const IDLE_BREAK_DURATION = 1.6;
const IDLE_SHIFT_ROLL_RAD = degreesToRadians(2.5);
const IDLE_SHIFT_LATERAL = 0.02;

/** scratch for `updateIdleLife`'s four outputs; one struct reused per call
 *  rather than an allocation per character per frame. */
const _idlePose = { rise: 0, chestPitch: 0, roll: 0, lateral: 0 };

function nextIdleBreakDelay(): number {
    return IDLE_BREAK_MIN_DELAY + Math.random() * (IDLE_BREAK_MAX_DELAY - IDLE_BREAK_MIN_DELAY);
}

// turn bank. body yaw rate (rad/s) → outward-to-inward lean, like a
// bike: turning left rolls the torso left. derived from the *visual*
// body yaw rather than `cc.state.bodyYaw` so owner and remote read the
// same interpolated signal. scaled by the swing amp so a mouse flick
// while standing still doesn't lean the body, and eased so the lean
// builds and releases instead of tracking per-frame yaw jitter.
const TURN_BANK_PER_RAD_S = 0.1;
const TURN_BANK_MAX_RAD = degreesToRadians(10);
const TURN_BANK_RESPONSE_RATE = 8;

// arm outward tilt (Z roll), minecraft-style. small baseline + slow
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
// head + arms) sinks while the legs, siblings of the waist, stay
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
// rather than a face-plant. small, over-shifting unmoors the head
// from the feet in third-person.
const CROUCH_WAIST_BACK = 0.1;

const _waistPos: Vec3 = [0, 0, 0];
const _legPos: Vec3 = [0, 0, 0];
const _legScale: Vec3 = [1, 1, 1];

// rotation axes for limb decomposition, X is the forward/back swing
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
        /** intent, what should be mounted. Any model id registered with
         *  `Resources`. Server-set (engine join lifecycle writes the
         *  resolved player avatar here; game scripts write it for NPCs),
         *  dirty-synced to clients via `modelIdSync`. Defaults to
         *  `BUILTIN_BASE_AVATAR_ID`, the canonical 6-bone rig, so
         *  characters that never receive a custom assignment render as
         *  the placeholder.
         *
         *  Pairs with `state.modelId` (the fact). The WorldTrait reconciler
         *  converges them: writes to `state.modelId = modelId` once the
         *  payload is in Resources, mounting the rig in the same pass.
         *  Loading state is `modelId !== state.modelId`. Reassign at
         *  runtime to swap the avatar, next frame the reconciler does
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
         *  applies to non-POV characters). `dither` is the script-driven
         *  screen-door fade (0 solid, 1 gone; e.g. fading out a dead body),
         *  `max()`'d with the proximity + loading fades in the presentation
         *  step so the engine stays the single writer of mesh dither and the
         *  script's intent can't be undone by the proximity fade. Set it
         *  instead of walking the rig and calling setMeshDither yourself. */
        config: (): CharacterConfig => ({
            animation: true,
            footstepVolume: 0.3,
            ownFootstepVolume: 0.3,
            landingVolume: 0.5,
            ownLandingVolume: 0.7,
            landingCooldown: 0.18,
            proximityFadeRange: 1.5,
            dither: 0,
        }),

        /** runtime bookkeeping. `modelId` + `modelDef` are the reconciler's
         *  fact-state (see field doc-comments, start `null`, reconciler
         *  populates on first tick). `breathPhase` is the accumulated
         *  breath-sine phase (rad) used by the arm idle tilt, advances
         *  at `ARM_BREATH_RATE` so idle characters still breathe; wraps
         *  mod 2π. `landingCooldownRemaining` is seconds left on the
         *  landing-thud cooldown (suppresses grounded chatter on stair
         *  edges / voxel seams / low-arc hops). */
        state: (): CharacterState => ({
            modelId: null,
            modelDef: null,
            breathPhase: 0,
            turnBank: 0,
            previousVisualYaw: 0,
            turnBankInit: false,
            fallSpeedPeak: 0,
            landingSquash: 0,
            landingSpringVelocity: 0,
            bobPhaseCatchUp: 0,
            previousRawBobPhase: 0,
            // random from frame zero, so characters that spawn together
            // don't shift their weight in lockstep on the first cycle.
            idleDriftYawPhase: Math.random() * TAU,
            idleDriftPitchPhase: Math.random() * TAU,
            idleBreakDelay: nextIdleBreakDelay(),
            idleBreakProgress: 1,
            idleBreakSide: 1,
            headDriftYaw: 0,
            headDriftPitch: 0,
            landingCooldownRemaining: 0,
            loadingDither: 0,
            appliedDither: null,
            modelNodes: new Set(),
            nodes: emptyRigNodes(),
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
    dirty: dirty.explicit(),
});

// ── per-frame character systems (world-script) ──────────────────────
//
// One onFrame, two queries. The split lets the rig load and present
// for ANY character holding a CharacterTrait (NPCs, ball-controllers,
// ragdolls), while controller-driven concerns stay gated on having a
// CharacterControllerTrait.
//
// Pass 1, [CharacterTrait, TransformTrait]:
//   1. rig reconciler, converges `def.modelId` (intent) toward
//      `state.modelId` (fact). Runs on BOTH sides. First pass per
//      character mounts the baseAvatar.def placeholder so subsequent
//      frames have bones to write to; once the target `def.modelId`
//      is in Resources, unmounts and re-mounts the real rig. Loading
//      state is `def.modelId !== state.modelId`.
//   2. loading-state pulse, pulsing dither while the target rig
//      hasn't resolved; decays off once it lands. max()'d with the
//      proximity dither below so a loading character near camera
//      still reads as loading, not as faded.
//   3. POV visibility / proximity dither, hide own body in
//      first-person / orbit / fly POV; screen-door fade other
//      characters the active camera is standing inside of.
//
// Pass 2, [CharacterTrait, CharacterControllerTrait, TransformTrait]:
//   4. locomotion, procedural head/limb pose. Writes bone TRS each
//      frame (no clips, no animator state). Inputs (`cc.input.look`,
//      `cc.state.bobPhase`, player yaw) are synced or locally-
//      integrated on both sides, so running client-only still
//      produces the same pose every client sees.
//   5. footstep + landing thud sfx + dust/droplet vfx, bob-phase
//      bucket crossings drive cadence, edge detectors drive landings
//      and liquid entry.
//
// (1) runs on every side. The rest is client-only and skips when
// `state.modelId` is null (no bones yet, first reconciler tick).
// AnimatorTrait scripts tick after this onFrame and overwrite any
// bone whose currently-playing clip channels target it, that's the
// emote / upper-body-mask path. To opt out of engine-driven limb
// swing, set `t.config.animation = false` and own the bones yourself.
script(
    WorldTrait,
    'character',
    (ctx) => {
        const qChars = query(ctx, [CharacterTrait, TransformTrait]);
        const qLocomotion = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);

        onFrame(ctx, ({ delta }) => {
            const subjectNode = getSubject(ctx);
            // active camera pose off its transform, for the proximity fade below.
            // null when no camera is wired: this reconciler runs unconditionally,
            // including the offline icon renderer, which has no room camera. the
            // render camera object itself is renderer-private.
            const cameraNode = getCamera(ctx);
            const cameraTransform = cameraNode ? getTrait(cameraNode, TransformTrait) : null;
            const cameraPos = cameraTransform ? getWorldPosition(cameraTransform) : null;

            // ── pass 1: every character ─────────────────────────────
            for (const [t, transform] of qChars.matches) {
                const node = t._node;

                // ── rig reconciler ─────────────────────────────────────
                // Reconcile the mounted rig against LIVE payload state, not a cached
                // fact. `getModel` returns a handle only while the target model's
                // payload is ready *right now*, so a play/stop payload wipe (which
                // clears Resources) self-heals on the next frame instead of getting
                // stuck on a stale "already mounted" flag. Runs on every side; both
                // server and client need the skeleton: locomotion reads it through
                // `state.nodes`, and animator ticks walk it.
                const handle = getModel(ctx, t.modelId);
                if (handle) {
                    // target ready → mount it unless it's already the mounted handle.
                    if (t.state.modelDef !== handle) {
                        unmountRig(node);
                        mountRig(node, handle);
                        t.state.modelId = t.modelId;
                        t.state.modelDef = handle;
                    }
                } else {
                    // target not ready (still loading, or its payload was wiped under
                    // us). Keep the lazy load going and show the placeholder, reverting
                    // a now-stale real model so the null→ready edge re-mounts cleanly.
                    // The player avatar pipeline also ensures on a player's behalf, but
                    // a game that sets `modelId` directly (NPCs) relies on this.
                    ensureModel(ctx, t.modelId);
                    if (t.state.modelDef !== baseAvatar.def) {
                        unmountRig(node);
                        mountRig(node, baseAvatar.def);
                        t.state.modelId = BUILTIN_BASE_AVATAR_ID;
                        t.state.modelDef = baseAvatar.def;
                    }
                }

                // The remaining systems are client-only presentation; skip
                // them on the server (which does need the reconciler above
                // for logical bone access).
                if (!env.client) continue;

                // No bones yet, reconciler will install the placeholder
                // next call. Skip presentation work for this character.
                if (t.state.modelId === null) continue;

                // ── loading-state pulse ────────────────────────────────
                const loading = t.state.modelId !== t.modelId;
                if (loading) {
                    const pulse = 0.5 + 0.5 * Math.sin((performance.now() * (TAU * LOAD_PULSE_RATE_HZ)) / 1000);
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
                let visible: boolean;
                if (subjectNode === node) {
                    const pc = getTrait(node, PlayerControllerTrait);
                    const hide =
                        (pc && pc.config.perspective === 'first') ||
                        !!getTrait(node, OrbitControllerTrait) ||
                        !!getTrait(node, FlyControllerTrait);
                    visible = !hide;
                    // POV character can still be loading (own avatar streaming
                    // in), apply the load dither alone; proximity fade never
                    // applies to own body. a script-driven dither (e.g. own death
                    // fade) still composes in.
                    finalDither = hide ? 0 : Math.max(t.state.loadingDither, t.config.dither);
                } else {
                    visible = true;
                    const range = t.config.proximityFadeRange;
                    let proxDither = 0;
                    if (range > 0 && cameraPos) {
                        // measure against character center (~1m above the foot
                        // transform) so a camera at eye-level standing inside
                        // reads as ~0 distance.
                        const dx = cameraPos[0] - transform.position[0];
                        const dy = cameraPos[1] - (transform.position[1] + 1);
                        const dz = cameraPos[2] - transform.position[2];
                        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        proxDither = dist >= range ? 0 : 1 - dist / range;
                    }
                    finalDither = Math.max(proxDither, t.state.loadingDither, t.config.dither);
                }
                // inherited visibility: one write on the rig root, which every mesh under it
                // reads through the renderer's already-resolved `Up(ModelTrait)`. Leaves each
                // mesh's own `visible` alone, so a script hiding one mesh survives a
                // first-person toggle.
                const characterModel = getTrait(node, ModelTrait);
                if (characterModel) characterModel.visible = visible;
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
                updateHeadOrientation(t, cc, transform);

                // arm/leg swing. per-character opt-out via `t.config.animation`.
                if (t.config.animation) driveProceduralLocomotion(t, cc, transform, delta);

                // ── footstep sfx + dust vfx ────────────────────────────
                if (t.state.landingCooldownRemaining > 0) {
                    t.state.landingCooldownRemaining -= delta;
                }

                const owner = isOwner(ctx, node);
                const footBlockState = cc.state.groundBlockState;
                const prevFootBlockState = cc.state.previousGroundBlockState;
                const inLiquid = footBlockState !== 0 && (ctx.blocks.flags[footBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
                const wasInLiquid = prevFootBlockState !== 0 && (ctx.blocks.flags[prevFootBlockState]! & BLOCK_FLAG_LIQUID) !== 0;

                // entry splash, fires on the bob-tick the foot-sample first
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
                            // dust), and on ground only when sprinting, walking
                            // stays visually quiet.
                            cc.state.grounded && cc.input.sprint,
                        );
                    }
                }
            }
        });
        // editor: true → this presentation runs in edit mode too, so the editor lens
        // gets the real avatar (reconciler), procedural locomotion, and the
        // first-person POV-hide when viewing through the character (subject ===
        // playerNode), not just in play.
    },
    { editor: true },
);

/** Rotate the canonical `head` bone to point at `cc.look`. yaw is the
 *  delta between look-yaw and the body's yaw (which already tracks
 *  velocity within ±BODY_YAW_LIMIT_RAD on the controller side, so this
 *  delta is naturally bounded); pitch is `look[2] - π/2` clamped to
 *  ±HEAD_PITCH_LIMIT_RAD. composed as `Ryaw · Rpitch` so the head pitches
 *  in its own local frame after yawing, matches FPS look feel.
 *
 *  When the waist is tilted by the sneak pose (driven by
 *  `cc.state.crouchAmount` on the controller, in the flat rig the waist
 *  carries head + arms + body), subtract that pitch from the head's local
 *  pitch so the face still aims at the world look direction. Small-angle
 *  approximation, pitch and head yaw don't commute, but at ±28°/±60° the
 *  visual error is below the threshold of notice. */
function updateHeadOrientation(t: CharacterTrait, cc: CharacterControllerTrait, transform: TransformTrait): void {
    const headBone = t.state.nodes.head;
    if (!headBone) return;
    const headTransform = getTrait(headBone, TransformTrait);
    if (!headTransform) return;

    // visual yaw, not sim: the head bone renders against the playerNode's
    // alpha-sampled yaw, and composing against the sim yaw leaves a residual
    // that wobbles by up to one tick of body yaw between fixed ticks.
    const bodyYaw = bodyYawFromQuat(getVisualWorldQuaternion(transform));
    // idle drift is added to the *visual* head only; `cc.view` (the aim ray)
    // is unmoved, so a drifting head can't nudge where the character shoots.
    const headYaw = wrapPi(cc.input.look[1] - bodyYaw) + t.state.headDriftYaw;
    let pitch = cc.input.look[2] - Math.PI / 2 - cc.state.crouchAmount * CROUCH_BODY_PITCH_RAD + t.state.headDriftPitch;
    if (pitch < -HEAD_PITCH_LIMIT_RAD) pitch = -HEAD_PITCH_LIMIT_RAD;
    else if (pitch > HEAD_PITCH_LIMIT_RAD) pitch = HEAD_PITCH_LIMIT_RAD;

    quat.setAxisAngle(_qHeadYaw, _HEAD_UP, headYaw);
    quat.setAxisAngle(_qHeadPitch, _HEAD_RIGHT, pitch);
    quat.multiply(_qHead, _qHeadYaw, _qHeadPitch);
    setQuaternion(headTransform, _qHead);
}

// ── skeleton + mount helpers ─────────────────────────────────────────

/**
 * Synchronously mount the placeholder (baseAvatar.def) rig on `node` if it has no
 * rig yet, so code running before the reconciler's first frame sees the bones.
 *
 * The reconciler builds the rig in `onFrame`, which runs *after* the server's
 * join processing, so a server `onJoin` hook that does
 * `findByName(playerNode, 'hand_right')` would otherwise get null. The server
 * calls this at player-node creation (`createPlayerNode`) so bones exist by the
 * time join hooks fire; game code spawning characters that need bones
 * immediately can call it too.
 *
 * Idempotent (no-op once a rig is mounted) and a no-op on a node without
 * `CharacterTrait`. Mounts only the placeholder, the reconciler still swaps in
 * the resolved avatar once its model loads.
 */
export function ensureCharacterRig(node: Node): void {
    const t = getTrait(node, CharacterTrait);
    if (!t || t.state.modelId !== null) return;
    mountRig(node, baseAvatar.def);
    t.state.modelId = BUILTIN_BASE_AVATAR_ID;
    t.state.modelDef = baseAvatar.def;
}

// Per-node rig lifecycle: the rig's existence is bound to the trait's. `onInit`
// fires synchronously on trait add, so the bones are up the same tick for join
// hooks; `onDispose` fires when the trait/script is torn down — on `removeTrait`
// (including the remove-then-add `addTrait` does on a re-add) and node destroy,
// but NOT on reparent — so a re-created trait can never leave the previous rig's
// meshes orphaned, and moving a character in the tree doesn't drop its rig. The
// WorldTrait reconciler still owns the placeholder→real swap and animation.
script(CharacterTrait, 'rig', (ctx) => {
    const node = ctx.node;
    onInit(ctx, () => ensureCharacterRig(node));
    onDispose(ctx, () => unmountRig(node));
});

/**
 * Add `CharacterTrait` to `node` and mount its rig immediately, so the bones
 * (`head`, `hand_right`, …) are available the same tick for attaching held
 * items / accessories. The higher-level sibling of
 * `addTrait(node, CharacterControllerTrait)`, the engine uses it for player
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
 * arms nest under waist as independent siblings (Minecraft-style parts,
 * each animates around its own pivot, and rotating waist carries the whole
 * upper body). legs are their own roots off `playerNode`, so they stay
 * planted when waist twists. Authoring tools MUST produce this hierarchy,
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
    // attach sockets, enforced + persistent; auto-derived from bone geometry
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
 * `playerNode`. Idempotent, bones already in place are reused, so this
 * doubles as the placeholder install (first call from the reconciler)
 * and as the prep step for `mountRig` (re-mount after avatar swap).
 *
 * Each created bone carries an identity TransformTrait so the animator's
 * bone walker discovers it on first tick; `mountRig` overwrites that TRS
 * with the loaded value if/when the target rig lands.
 */
/** all slots null: the shape every `state.nodes` starts and stays in, so V8 sees one map. */
function emptyRigNodes(): RigNodes {
    const nodes = {} as RigNodes;
    for (const name of RIG_6BONE_PERSISTENT_NODES) nodes[name] = null;
    return nodes;
}

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

    // publish the resolved skeleton. Done here rather than lazily at first use because this
    // runs on every mount, so the cache cannot outlive the rig it describes. Before this,
    // the per-frame locomotion resolved each bone with a `findByName` DFS that allocated a
    // stack per call, seven times per character per frame.
    const character = getTrait(playerNode, CharacterTrait);
    if (character) {
        const nodes = character.state.nodes;
        for (const name of RIG_6BONE_PERSISTENT_NODES) nodes[name] = byName.get(name) ?? null;
    }
}

/**
 * Install / re-install a model's rig under `playerNode`:
 *
 *   - ensure the canonical 6bone hierarchy + AnimatorTrait exist (first
 *     call also performs the placeholder install, there's no separate
 *     placeholder step).
 *   - canonical bone match (by exact name): copy the loaded node's local
 *     TRS onto the canonical bone. Node identity preserved across swaps
 *     so AnimatorTrait + AnimationAction map keys stay valid.
 *   - non-canonical descendants under a matched parent: cloned and
 *     attached under the matching canonical bone so mesh-bearing leaves
 *     render and decorative bones drive any extra clip channels.
 *
 * Caller (the reconciler) is responsible for calling `unmountRig` first
 * if a different rig is currently mounted, `mountRig` doesn't drop the
 * previous decorative children itself.
 *
 * Finally calls `Animation.invalidateRig(animator)` so the animator
 * rebuilds its parent-first bone walk against the now-populated subtree.
 */
// derive an unauthored attach socket's local rest position from its parent
// bone's mesh geometry. hands sit at the bottom-centre of the arm (the hand);
// `back` at the centre of the torso's back (+Z) face, avatars face -Z. rest
// pose is axis-aligned, so we compose local translate/scale only (no rotation).
function deriveSocketPosition(boneNode: Node, def: ModelDef, socket: string): Vec3 | null {
    const meshes = def.meshes as Record<string, { aabb: ArrayLike<number> } | undefined>;
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    let found = false;
    const walk = (node: Node, ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void => {
        const meshName = getTrait(node, MeshTrait)?.meshId?.meshName;
        const aabb = meshName ? meshes[meshName]?.aabb : undefined;
        if (aabb) {
            found = true;
            minX = Math.min(minX, ox + sx * aabb[0]);
            maxX = Math.max(maxX, ox + sx * aabb[3]);
            minY = Math.min(minY, oy + sy * aabb[1]);
            maxY = Math.max(maxY, oy + sy * aabb[4]);
            minZ = Math.min(minZ, oz + sz * aabb[2]);
            maxZ = Math.max(maxZ, oz + sz * aabb[5]);
        }
        for (const child of node.children) {
            const t = getTrait(child, TransformTrait);
            walk(
                child,
                ox + sx * (t?.position[0] ?? 0),
                oy + sy * (t?.position[1] ?? 0),
                oz + sz * (t?.position[2] ?? 0),
                sx * (t?.scale[0] ?? 1),
                sy * (t?.scale[1] ?? 1),
                sz * (t?.scale[2] ?? 1),
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

function mountRig(playerNode: Node, def: ModelDef): void {
    const loadedRoot = def.scene;
    if (!loadedRoot) return;

    ensureCanonicalBones(playerNode);

    // Who builds the model's mesh nodes: the server builds them for every node it
    // owns and replicates them to clients; a client builds only its own local nodes.
    // For a server-owned rig the meshes arrive via replication, so a client must NOT
    // clone them here, doing so double-mounts them and (because avatars share mesh
    // node names) leaves a base/loaded mix on a swap. Bones/sockets are matched +
    // TRS-copied regardless (cheap, idempotent); only the mesh clone is gated.
    const localAuthority = env.server || isLocalNode(playerNode);

    // persistent rig nodes (bones + attach sockets) are matched by name and have
    // their TRS copied from the loaded model; everything else is a model clone.
    const canonical = new Set<string>(RIG_6BONE_PERSISTENT_NODES);
    // the current model's nodes we add below are recorded on the character so
    // `unmountRig` drops exactly these on a swap, leaving runtime attachments
    // (gear) alone, ownership by node identity, never by name.
    const modelNodes = getTrait(playerNode, CharacterTrait)?.state.modelNodes;

    const visit = (loaded: Node, placeholder: Node | null): void => {
        // copy loaded TRS onto the matched placeholder (if any).
        if (placeholder) {
            const loadedTransform = getTrait(loaded, TransformTrait);
            if (loadedTransform) {
                const ph = getTrait(placeholder, TransformTrait);
                if (ph) {
                    setTransform(ph, loadedTransform.position, loadedTransform.quaternion, loadedTransform.scale);
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
            // a multi-root scene). Only the locally-authoritative side builds these,
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
    // otherwise it's a synthetic / decorative wrapper, skip the TRS
    // copy and just recurse into its children.
    const rootName = loadedRoot.name ?? '';
    const rootPlaceholder = canonical.has(rootName) ? findByName(playerNode, rootName) : null;
    visit(loadedRoot, rootPlaceholder);

    // drive any attach socket the model didn't author from its parent bone's
    // geometry, so gear has a usable mount point without the author placing one.
    // An authored socket was matched + TRS-copied by the visit above; skip it.
    const handleNodes = def.nodes as Record<string, Node | undefined>;
    for (const socket of RIG_6BONE_ATTACH_NODES) {
        if (handleNodes[socket]) continue;
        const parentName = RIG_6BONE_PARENT_OF[socket];
        const boneNode = parentName ? handleNodes[parentName] : undefined;
        const socketNode = findByName(playerNode, socket);
        const socketTransform = socketNode ? getTrait(socketNode, TransformTrait) : undefined;
        if (!boneNode || !socketTransform) continue;
        const pos = deriveSocketPosition(boneNode, def, socket);
        if (!pos) continue;
        setPosition(socketTransform, pos);
        // hands get the grip rotation so a held item sits perpendicular to the arm
        // (an outstretched arm points it up); back stays flat (identity).
        if (socket !== RIG_6BONE_BACK) setQuaternion(socketTransform, HAND_GRIP_ROTATION);
    }

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);

    // The animator installs the inherited-visibility ModelTrait on this node;
    // ensure it exists (the server has no animator) so the first-person body
    // toggle has something to write.
    if (!getTrait(playerNode, ModelTrait)) addTrait(playerNode, ModelTrait);

    // the meshes just added carry the MeshTrait dither default, not whatever this character
    // currently resolves to. Drop the cache so the next presentation pass re-walks and
    // brings them in line. Visibility needs no equivalent: it is inherited from the model
    // root, so a new mesh picks up the current value with nothing to re-apply.
    const character = getTrait(playerNode, CharacterTrait);
    if (character) {
        character.state.appliedDither = null;
    }
}

/**
 * Unmount the current model: reset each canonical bone's TRS to identity and
 * remove exactly the model's nodes recorded in `state.modelNodes` (its
 * mesh/visual nodes). Runtime attachments (gear `addChild`'d by the game) are
 * NOT in that set, so they survive untouched, ownership is by node identity,
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
                // dirty set and replicates as `node_destroyed`, else clients keep the
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
 *   - X swing (fore/aft): `sin(bobPhase) * reach * MAX`. one leg
 *     cycle per foot-plant (2π of bobPhase). gait-correct alternation
 *     would want `bobPhase * 0.5` (one stride pair per cycle), but the
 *     faster scissor reads more energetic at the tradeoff that both
 *     legs return to the same position each plant.
 *     `reach` is `amp = clamp(horizSpeed / SWING_SPEED_REF, 0, 1)`
 *     (so a stationary character sits at rest) scaled up toward
 *     `SPRINT_SWING_BOOST` as speed passes walk, since `amp` alone
 *     saturates at the default walk speed and leaves a sprint no
 *     further reach than a walk.
 *     opposing legs are π out of phase; arms counter-swing so the
 *     same-side arm and leg move opposite (matches real gait).
 *
 *   - Z tilt (arms only, outward roll): `baseline + breath * sin(t)`.
 *     idle gives a subtle outward lean that breathes; running widens
 *     both terms via lerp on `amp` so sprinting arms splay further
 *     and oscillate harder. breath phase is an independent slow clock
 *     (`ARM_BREATH_RATE`) so it doesn't stall when the character is
 *     standing still and doesn't beat against gait frequencies.
 *
 *   - waist weight-shift: a dip-only vertical settle plus a side-to-side
 *     roll, both on the swing's own `sin(bobPhase)` clock and scaled by
 *     `amp`, plus an eased lean into turns driven by the body's yaw
 *     rate. All three ride the waist, which carries body + head + arms
 *     while the legs stay rooted at the feet.
 *
 *   - hip drop (`MAX_HIP_DROP_FRACTION`): the crouch squat, the gait
 *     settle and the landing spring sum into one sink that the waist and
 *     both legs share, the legs compressing their Y to keep the feet on
 *     the ground.
 *
 *   - chest (`CHEST_HEAVE_RAD`): speed lean + a per-step heave + a fold
 *     under impact, on `body` so the head and arms stay out of it.
 *
 *   - idle life (`IDLE_SPEED_REF`): breathing, a slow head drift and a
 *     periodic weight shift onto one hip, all fading out as soon as the
 *     character moves.
 *
 * Assumes canonical arm/leg bones are authored with identity rotation
 * (hanging at rest). If a future avatar bakes a non-identity rest into
 * its limbs, add a rest-quaternion compose step here.
 */
function driveProceduralLocomotion(
    t: CharacterTrait,
    cc: CharacterControllerTrait,
    transform: TransformTrait,
    delta: number,
): void {
    const nodes = t.state.nodes;
    const vx = cc.state.velocity[0];
    const vz = cc.state.velocity[2];
    const horizSpeed = Math.sqrt(vx * vx + vz * vz);
    const amp = Math.min(horizSpeed / SWING_SPEED_REF, 1);

    // reach grows past walk speed even though `amp` is already saturated
    // there; `sprintSpeed <= walkSpeed` (a game that disables sprint) makes
    // the excess 0 rather than dividing by zero.
    const speedRange = cc.config.sprintSpeed - cc.config.walkSpeed;
    const sprintExcess = speedRange > 0 ? Math.min(Math.max((horizSpeed - cc.config.walkSpeed) / speedRange, 0), 1) : 0;
    const reach = amp * (1 + (SPRINT_SWING_BOOST - 1) * sprintExcess);

    const bobPhase = updateVisualBobPhase(t, cc, delta);
    const bobSine = Math.sin(bobPhase);
    const swing = bobSine * reach;

    // breath advances on its own clock (it must not stall when the character
    // stands still) and feeds both the idle pose below and the arm tilt.
    t.state.breathPhase = (t.state.breathPhase + delta * ARM_BREATH_RATE) % TAU;
    const idle = cc.state.grounded ? 1 - Math.min(horizSpeed / IDLE_SPEED_REF, 1) : 0;
    updateIdleLife(t, delta, idle);

    // vertical settle: 0 at the top of the bob, full drop at the trough.
    const bobDrop = WAIST_BOB_DROP * amp * (1 - bobSine) * 0.5;
    const strideRoll = bobSine * WAIST_STRIDE_ROLL_RAD * amp;
    const turnBank = updateTurnBank(t, transform, amp, delta);
    const landing = updateLandingSpring(t, cc, delta);

    const crouchAmount = cc.state.crouchAmount;
    // the breath lifts, so it comes off the drop.
    const hipDrop = crouchAmount * CROUCH_WAIST_DROP + landing * LANDING_DROP + bobDrop - _idlePose.rise;

    // crouch lean rides `waist`, it carries body + head + arms in the flat rig,
    // so one tilt leans the whole upper body while the legs (separate roots) stay
    // planted. head-look cancels this same pitch so the face keeps aiming true.
    applyLimb(nodes.waist, crouchAmount * CROUCH_BODY_PITCH_RAD, strideRoll + turnBank + _idlePose.roll);
    applyWaistOffset(t, crouchAmount, hipDrop, _idlePose.lateral);

    // chest, on `body`, under the leaning waist and beside the head/arms.
    const chestLean = CHEST_WALK_LEAN_RAD + (CHEST_RUN_LEAN_RAD - CHEST_WALK_LEAN_RAD) * sprintExcess;
    const chestPitch =
        -chestLean * amp +
        Math.sin(bobPhase - CHEST_HEAVE_PHASE_LAG) * CHEST_HEAVE_RAD * amp -
        landing * CHEST_LANDING_FOLD_RAD +
        _idlePose.chestPitch;
    applyLimb(nodes.body, chestPitch, 0);

    const baselineTilt = ARM_IDLE_TILT_RAD + (ARM_RUN_TILT_RAD - ARM_IDLE_TILT_RAD) * amp;
    const breathAmp = ARM_IDLE_BREATH_RAD + (ARM_RUN_BREATH_RAD - ARM_IDLE_BREATH_RAD) * amp;
    const tiltOut = baselineTilt + Math.sin(t.state.breathPhase) * breathAmp;

    // legs carry the hip drop themselves (position + Y scale) so the squat
    // compresses instead of the torso sinking through them.
    const restNodes = t.state.modelDef?.nodes;
    applyLegPose(nodes.leg_left, restNodes?.leg_left, hipDrop, swing * LEG_SWING_MAX_RAD);
    applyLegPose(nodes.leg_right, restNodes?.leg_right, hipDrop, -swing * LEG_SWING_MAX_RAD);
    // arms counter-swing fore/aft; tilt outward, opposite Z sign per side.
    // the landing raise is symmetric, so it rides on top of the swing.
    const armRaise = landing * LANDING_ARM_RAISE_RAD;
    applyLimb(nodes.arm_left, -swing * ARM_SWING_MAX_RAD + armRaise, -tiltOut);
    applyLimb(nodes.arm_right, swing * ARM_SWING_MAX_RAD + armRaise, tiltOut);
}

/** Advance and return the eased turn lean (rad, positive = lean left).
 *
 *  Yaw rate comes from differencing the *visual* body yaw frame to frame,
 *  the same signal `updateHeadOrientation` composes against, so an owner
 *  (yaw written by the controller) and a remote (yaw interpolated toward
 *  the synced transform) lean off one source. `amp` gates it on actual
 *  movement: standing still, body yaw follows the look direction, and a
 *  mouse flick should not roll the torso. */
function updateTurnBank(t: CharacterTrait, transform: TransformTrait, amp: number, delta: number): number {
    const state = t.state;
    const visualYaw = bodyYawFromQuat(getVisualWorldQuaternion(transform));

    let target = 0;
    if (state.turnBankInit && delta > 0) {
        const yawRate = wrapPi(visualYaw - state.previousVisualYaw) / delta;
        target = yawRate * TURN_BANK_PER_RAD_S * amp;
        if (target > TURN_BANK_MAX_RAD) target = TURN_BANK_MAX_RAD;
        else if (target < -TURN_BANK_MAX_RAD) target = -TURN_BANK_MAX_RAD;
    }
    state.previousVisualYaw = visualYaw;
    state.turnBankInit = true;

    state.turnBank += (target - state.turnBank) * (1 - Math.exp(-TURN_BANK_RESPONSE_RATE * delta));
    return state.turnBank;
}

/** Advance and return the *visual* bob phase: the sim phase plus a decaying
 *  offset that absorbs the controller's hard re-anchors (see
 *  `BOB_PHASE_CATCHUP_RATE`).
 *
 *  A re-anchor is spotted generically, as an advance that runs backwards or
 *  faster than any real gait could, rather than by re-deriving the specific
 *  edges the controller anchors on. That covers the landing jam, the liquid
 *  jam and the idle reset with one test, and a frame-hitch false positive is
 *  harmless: it smooths a leg jump that would have been ugly anyway. */
function updateVisualBobPhase(t: CharacterTrait, cc: CharacterControllerTrait, delta: number): number {
    const state = t.state;
    const rawPhase = cc.state.bobPhase;
    const advance = rawPhase - state.previousRawBobPhase;
    if (advance < 0 || advance > BOB_PHASE_MAX_ADVANCE_PER_S * delta) {
        // hold the visual phase exactly where it was this frame, then let the
        // offset decay to 0; wrapped because the swing can't tell 2π apart.
        state.bobPhaseCatchUp = wrapPi(state.previousRawBobPhase + state.bobPhaseCatchUp - rawPhase);
    }
    state.previousRawBobPhase = rawPhase;
    state.bobPhaseCatchUp *= Math.exp(-BOB_PHASE_CATCHUP_RATE * delta);
    return rawPhase + state.bobPhaseCatchUp;
}

/** Advance the idle clocks and fill `_idlePose` with this frame's breathing,
 *  weight shift and head drift, all scaled by `idle`.
 *
 *  Breathing reuses `breathPhase`, the clock already driving the arm tilt, so
 *  the chest, the waist and the arms inhale together instead of on three
 *  unrelated sines. The weight shift is a one-shot eased 0 → 1 → 0 arc on its
 *  own timer; the timer only advances while idle, so a character that walks
 *  for a minute doesn't bank a shift and fire it the instant it stops. */
function updateIdleLife(t: CharacterTrait, delta: number, idle: number): void {
    const state = t.state;

    state.idleDriftYawPhase = (state.idleDriftYawPhase + delta * IDLE_DRIFT_YAW_RATE) % TAU;
    state.idleDriftPitchPhase = (state.idleDriftPitchPhase + delta * IDLE_DRIFT_PITCH_RATE) % TAU;

    if (idle > 0 && state.idleBreakProgress >= 1) {
        state.idleBreakDelay -= delta * idle;
        if (state.idleBreakDelay <= 0) {
            state.idleBreakProgress = 0;
            state.idleBreakSide = -state.idleBreakSide;
            state.idleBreakDelay = nextIdleBreakDelay();
        }
    }
    if (state.idleBreakProgress < 1) {
        const advanced = state.idleBreakProgress + delta / IDLE_BREAK_DURATION;
        state.idleBreakProgress = advanced < 1 ? advanced : 1;
    }

    const breath = Math.sin(state.breathPhase);
    const shift = Math.sin(state.idleBreakProgress * Math.PI) * state.idleBreakSide * idle;

    _idlePose.rise = breath * IDLE_BREATH_RISE * idle;
    _idlePose.chestPitch = breath * IDLE_BREATH_CHEST_RAD * idle;
    _idlePose.roll = shift * IDLE_SHIFT_ROLL_RAD;
    _idlePose.lateral = shift * IDLE_SHIFT_LATERAL;

    state.headDriftYaw = Math.sin(state.idleDriftYawPhase) * IDLE_HEAD_DRIFT_YAW_RAD * idle;
    state.headDriftPitch = Math.sin(state.idleDriftPitchPhase) * IDLE_HEAD_DRIFT_PITCH_RAD * idle;
}

/** Track the fall, then spring on touchdown. Returns the compression: 1 at a
 *  full-strength impact, negative on the rebound past rest.
 *
 *  Strength is the peak fall speed since takeoff rather than the velocity at
 *  the moment of contact, which the solver has already clamped to 0 by the
 *  time `grounded` flips. The landing edge is `cc.state`'s own
 *  grounded/previousGrounded pair, the same one the footstep thud reads, so
 *  the visual reaction and the impact sound can't disagree about what a
 *  landing is. */
function updateLandingSpring(t: CharacterTrait, cc: CharacterControllerTrait, delta: number): number {
    const state = t.state;

    if (cc.state.grounded) {
        if (!cc.state.previousGrounded && state.fallSpeedPeak > LANDING_MIN_SPEED) {
            const strength = Math.min((state.fallSpeedPeak - LANDING_MIN_SPEED) / (LANDING_REF_SPEED - LANDING_MIN_SPEED), 1);
            // impulses add, so a landing mid-recovery deepens the bob instead
            // of restarting it; capped so repeated touchdowns (a stair run,
            // a flickering ground contact) can't stack into a fold.
            state.landingSpringVelocity += strength * LANDING_SPRING_IMPULSE;
            if (state.landingSpringVelocity > LANDING_SPRING_MAX_VELOCITY) {
                state.landingSpringVelocity = LANDING_SPRING_MAX_VELOCITY;
            }
        }
        state.fallSpeedPeak = 0;
    } else {
        const fallSpeed = -cc.state.velocity[1];
        if (fallSpeed > state.fallSpeedPeak) state.fallSpeedPeak = fallSpeed;
    }

    const step = delta < LANDING_SPRING_MAX_STEP ? delta : LANDING_SPRING_MAX_STEP;
    const accel = -LANDING_SPRING_STIFFNESS * state.landingSquash - LANDING_SPRING_DAMPING * state.landingSpringVelocity;
    state.landingSpringVelocity += accel * step;
    state.landingSquash += state.landingSpringVelocity * step;
    if (state.landingSquash < LANDING_REBOUND_LIMIT) {
        state.landingSquash = LANDING_REBOUND_LIMIT;
        state.landingSpringVelocity = 0;
    }
    return state.landingSquash;
}

/** Pose one leg: rotation, plus the hip drop as a position sink and a
 *  matching Y compression.
 *
 *  The leg pivots at the hip and its geometry hangs to y=0, so sinking the
 *  node by `drop` and scaling Y by `(hip − drop) / hip` puts the foot back
 *  exactly on the ground: the leg shortens by precisely the distance the
 *  hips fell. Rest TRS comes from `modelDef.nodes` (the shared template) and
 *  every frame writes from it, so nothing accumulates.
 *
 *  Rigs whose leg pivot isn't the hip have no length to work with; they get
 *  the rotation and keep their rest position. */
function applyLegPose(bone: Node | null, restBone: Node | undefined, hipDrop: number, xAngle: number): void {
    applyLimb(bone, xAngle, 0);
    if (!bone) return;
    const transform = getTrait(bone, TransformTrait);
    if (!transform) return;

    const restTransform = restBone ? getTrait(restBone, TransformTrait) : null;
    if (!restTransform) return;
    const hipHeight = restTransform.position[1];
    if (hipHeight <= MIN_HIP_HEIGHT) return;

    const maxDrop = hipHeight * MAX_HIP_DROP_FRACTION;
    const drop = hipDrop < maxDrop ? hipDrop : maxDrop;

    _legPos[0] = restTransform.position[0];
    _legPos[1] = hipHeight - drop;
    _legPos[2] = restTransform.position[2];
    setPosition(transform, _legPos);

    _legScale[0] = restTransform.scale[0];
    _legScale[1] = restTransform.scale[1] * ((hipHeight - drop) / hipHeight);
    _legScale[2] = restTransform.scale[2];
    setScale(transform, _legScale);
}

function applyLimb(bone: Node | null, xAngle: number, zAngle: number): void {
    if (!bone) return;
    const transform = getTrait(bone, TransformTrait);
    if (!transform) return;
    quat.setAxisAngle(_qSwingX, _LIMB_X_AXIS, xAngle);
    quat.setAxisAngle(_qTiltZ, _LIMB_Z_AXIS, zAngle);
    quat.multiply(_qLimbOut, _qSwingX, _qTiltZ);
    setQuaternion(transform, _qLimbOut);
}

/** Sink the `waist` bone by `hipDrop` in Y, slide it by `lateral` in X (the
 *  idle weight shift) and shift it back by `crouchAmount · CROUCH_WAIST_BACK`
 *  in +Z (avatars face -Z), relative to its rest position. One writer for the waist's position, so the crouch
 *  pose, the walk settle and the landing spring add through a single
 *  `hipDrop` rather than fighting over the bone; the legs sink by the same
 *  amount in `applyLegPose`. Both halves are indexed lookups off the two parallel
 *  maps: rest from `modelDef.nodes` (the shared asset's template) and the live bone
 *  from `state.nodes` (this character's own), neither of which searches the tree.
 *  Caller guarantees `state.modelId !== null` (skipped at the iteration
 *  guard), but the handle can still be null transiently, bail. */
function applyWaistOffset(t: CharacterTrait, crouchAmount: number, hipDrop: number, lateral: number): void {
    if (!t.state.modelDef) return;
    const restWaist = t.state.modelDef.nodes.waist;
    if (!restWaist) return;
    const restTransform = getTrait(restWaist, TransformTrait);
    if (!restTransform) return;

    const waistBone = t.state.nodes.waist;
    if (!waistBone) return;
    const waistTransform = getTrait(waistBone, TransformTrait);
    if (!waistTransform) return;

    // same ceiling the legs clamp to, off the waist's own rest height, so the
    // pelvis can't sink past the legs that are carrying it.
    const restHeight = restTransform.position[1];
    const maxDrop = restHeight > 0 ? restHeight * MAX_HIP_DROP_FRACTION : hipDrop;
    _waistPos[0] = restTransform.position[0] + lateral;
    _waistPos[1] = restHeight - (hipDrop < maxDrop ? hipDrop : maxDrop);
    // avatars are authored facing -Z, so backward in local frame is +Z.
    _waistPos[2] = restTransform.position[2] + crouchAmount * CROUCH_WAIST_BACK;
    setPosition(waistTransform, _waistPos);
}

/** resolve foot-sample block once, play SFX, conditionally emit dust.
 *  shared between the landing-edge branch and the phase-bucket
 *  footstep branch so the lookup never drifts between the two paths.
 *
 *  `BlockRegistry.sounds` and `.particles` are per-state arrays
 *  indexed directly by global state id, `cc.groundBlockState` is
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

/** one-shot on the feet-enter-liquid edge, plays the liquid block's
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
 *  free) with splashier tuning, wider horizontal spread and higher
 *  upward velocity than the footstep puff. */
function spawnSplashDroplets(ctx: ScriptContext, particles: BlockParticleConfig, pos: Vec3): void {
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
 *  numbers are tuned starting points, `particleUpdate.dust` already
 *  applies gravity + drag + ground-collide-destroy so the puff settles
 *  on its own. */
function spawnFootstepDust(ctx: ScriptContext, particles: BlockParticleConfig, pos: Vec3): void {
    const variants = particles.dust;
    if (!variants || variants.length === 0) return;
    for (let i = 0; i < FOOTSTEP_DUST_COUNT; i++) {
        const handle = variants[Math.floor(Math.random() * variants.length)]!;
        spawnParticle(ctx, handle, pos, {
            velX: (Math.random() - 0.5) * 1.2,
            velY: 5 + Math.random() * 0.2,
            velZ: (Math.random() - 0.5) * 1.2,
            lifetime: 0.4 + Math.random() * 0.2,
            size: 0.05 + Math.random() * 0.1,
        });
    }
}

/** Walk the playerNode subtree and apply `dither` to every MeshTrait.
 *  Assigning an unchanged value is free: the renderer diffs the trait's config
 *  against what it last uploaded, so a steady fade level re-uploads nothing. */
function setCharacterSubtreeDither(root: Node, dither: number): void {
    const mesh = getTrait(root, MeshTrait);
    if (mesh) mesh.dither = dither;
    for (const child of root.children) {
        setCharacterSubtreeDither(child, dither);
    }
}
