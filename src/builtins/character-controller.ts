/**
 * character controller, trait, simulation, and script.
 *
 * the simulation is a custom swept-AABB slide:
 *   - voxels: analytical sweep against the chunk grid (no GJK).
 *   - bodies: crashcat `castShape` against any non-voxel body shape
 *     (sphere, capsule, hull, mesh, rotated box, all flow through it).
 *
 * the controller still owns a kinematic inner body in the world so other
 * bodies + queries can collide with the character; we exclude that body
 * from our own slide via a bodyFilter closure.
 *
 * inputs (facing/move/jump/sprint/crouch/noclip) are replicated owner→server.
 * the player-side `PlayerControllerTrait` writes these from real input; an
 * NPC system would write them from AI. either way the sim is identical.
 *
 * trait fields are grouped into three buckets:
 *   - `input`, owner-authoritative knobs scripts write (look, move, jump…)
 *   - `config`, static tunables scripts read+write (walkSpeed, gravity…)
 *   - `state`, per-tick runtime scripts read (velocity, grounded, bobPhase,
 *                isClimbing, …) for animations, sfx, vfx, debug, etc.
 */

import type { RigidBody } from 'crashcat';
import { rigidBody } from 'crashcat';
import type { Quat, Spherical, Vec3 } from 'mathcat';
import { degreesToRadians, quat, vec2, vec3 } from 'mathcat';
import { pack } from '../api/pack';
import { COLLISION_GROUP_CHARACTERS, exceptGroups, type Physics } from '../api/physics';
import { getTrait } from '../api/scene-graph';
import { isOwner, onDispose, onFrame, onInit, onTick, script } from '../api/scripts';
import { sync, type TraitType, trait } from '../api/traits';
import { getWorldPosition, setInterpolation, setQuaternion, setWorldPosition } from '../api/transforms';
import { wrapPi } from '../core/math/angles';
import { pushVccContact, type World as RigidWorld } from '../core/physics/rigid-physics';
import * as vcc from '../core/physics/vcc';
import {
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_SNEAK_GUARD,
    type BlockRegistry,
    SHAPE_AABBS,
} from '../core/voxels/block-registry';
import { unpackVoxelHitInfo } from '../core/voxels/voxel-physics-shape';
import { getBlockState, type Voxels } from '../core/voxels/voxels';
import { TransformTrait } from './transform';

// ── character shape ──────────────────────────────────────────────────
//
// box character, defaults match Minecraft (standing 0.6 x 1.8 x 0.6,
// crouching 0.6 x 1.3 x 0.6). feet at y=0. vcc.create owns the inner
// kinematic body + foot-pivot transform internally, so the trait just
// hands it `position` (= feet) and `linearVelocity`. crouch swaps the
// inner shape via `vcc.resize`, binary, the instant the input flips (and,
// on release, once there's headroom to stand), so the collider is a pure
// sim decision off the synced input, never gated on the visual ease. the
// visual `crouchAmount` (presentation only) eases to catch up.

const _forward = vec3.create();
const _right = vec3.create();
const _movementDir = vec3.create();
const _newVel = vec3.create();
const _horizVel = vec3.create();
const _identityQuat: Quat = [0, 0, 0, 1];
const _bodyYawAxis: Vec3 = [0, 1, 0];
const _bodyYawQuat = quat.create();

// reusable listener, closure vars below are set from the trait before
// vcc.move() runs each tick so the listener sees the right values.
let _vccListenerIsIntentional = false;
let _vccListenerTerrainBodyId = -1;
let _vccListenerBlockRest: Float32Array | null = null;
// rigid world the VCC's body contacts are replayed into (see pushVccContact /
// ingestVccContacts). set before each vcc.move so the listener can record the
// bodies the character touched this frame.
let _vccListenerRigid: RigidWorld | null = null;

// minimum downward speed (m/s) at landing to consider a bounce. avoids
// reflecting near-zero velocities (settled rest contacts).
const BOUNCE_MIN_DOWN_SPEED = 0.5;

// max body-vs-head yaw difference (rad). voxelibre uses 40°; same here,
// past this the body snaps to keep the neck within a plausible twist.
const BODY_YAW_LIMIT_RAD = degreesToRadians(40);

// min horizontal speed (m/s) above which the velocity vector drives the
// body-yaw target. below this, the target falls back to look-yaw so the
// body unwinds to face the head when standing still.
const BODY_VEL_YAW_MIN_SPEED = 0.5;

// exponential-approach rate (1/s) for body yaw chasing its target.
// each frame, body yaw moves a fraction `1 - exp(-rate · dt)` of the
// remaining gap, critically-damped feel with no velocity state.
// half-life ≈ ln(2) / rate, so 12/s ≈ 58 ms half-life: turn starts fast
// and eases as it closes, with no constant-rate kink at start/finish.
const BODY_YAW_RESPONSE_RATE = 12;

// half-angle (rad) of the cone behind the player inside which velocity-
// driven body yaw is suppressed and the body snaps to look-yaw. straight
// backwards is exactly inside; back-strafe at 45° off pure-back falls
// outside, so it still gets the velocity yaw + clamp tilt. precomputed
// cosine for the dot-product test in tickCharacterController.
const BODY_YAW_BACK_CONE_RAD = degreesToRadians(30);
const BODY_YAW_BACK_CONE_COS = Math.cos(BODY_YAW_BACK_CONE_RAD);

// surface every body the VCC touches into the contact stream. the VCC slides
// the character off these bodies and teleport-follows its kinematic inner body,
// so the solver never forms the manifold, replaying the contact is the only way
// a fast body (an arrow) that passed "through" the character produces a contact
// event on both bodies' ContactsTrait. added + persisted both report (a body can
// linger a frame before the reactor that consumes the hit removes it).
function recordVccBodyContact(vccInstance: vcc.VCC, body: RigidBody, contactPosition: Vec3, contactNormal: Vec3): void {
    if (_vccListenerRigid === null) return;
    pushVccContact(
        _vccListenerRigid,
        vccInstance.innerBodyId,
        body.id,
        contactPosition[0],
        contactPosition[1],
        contactPosition[2],
        contactNormal[0],
        contactNormal[1],
        contactNormal[2],
        0,
    );
}

const _vccListener: vcc.VccListener = {
    onContactAdded(vccInstance, body, _subShapeId, contactPosition, contactNormal) {
        recordVccBodyContact(vccInstance, body, contactPosition, contactNormal);
    },
    onContactPersisted(vccInstance, body, _subShapeId, contactPosition, contactNormal) {
        recordVccBodyContact(vccInstance, body, contactPosition, contactNormal);
    },
    onContactSolve(
        _vccInstance,
        _body,
        _subShapeId,
        _contactPos,
        contactNormal,
        contactVelocity,
        characterVelocity,
        ioCharacterVelocity,
    ) {
        const inAir = _vccInstance.groundState === vcc.GROUND_STATE_IN_AIR;
        const contactVelSq =
            contactVelocity[0] * contactVelocity[0] +
            contactVelocity[1] * contactVelocity[1] +
            contactVelocity[2] * contactVelocity[2];

        // contactNormal points into the surface (away from character), so the
        // upward component of the surface normal is -contactNormal[1].
        const isSteep = -contactNormal[1] < _vccInstance.cosMaxSlopeAngle;

        const preventSlide = !inAir && !_vccListenerIsIntentional && contactVelSq < 0.1 && !isSteep;

        if (preventSlide) {
            ioCharacterVelocity[0] = 0;
            ioCharacterVelocity[2] = 0;
            return;
        }

        // cancel upward velocity into a ceiling.
        if (contactNormal[1] < -0.3 && characterVelocity[1] > 0) {
            ioCharacterVelocity[1] = 0;
        }

        // trampoline reflect: landing on a non-steep terrain voxel with
        // restitution > 0 bounces the character. body-side restitution is
        // implicitly 1 here (vcc doesn't expose a per-body restitution),
        // so the block value drives the bounce strength.
        if (
            _vccListenerBlockRest !== null &&
            _body.id === _vccListenerTerrainBodyId &&
            !isSteep &&
            characterVelocity[1] < -BOUNCE_MIN_DOWN_SPEED
        ) {
            const info = unpackVoxelHitInfo(_subShapeId);
            const restitution = _vccListenerBlockRest[info.stateId] ?? 0;
            if (restitution > 0) {
                ioCharacterVelocity[1] = -restitution * characterVelocity[1];
            }
        }
    },
};

// ── trait ─────────────────────────────────────────────────────────────

type CharacterControllerInput = {
    /** look direction as [r, theta, phi] spherical. theta = yaw around +Y
     *  (drives wish direction); phi = polar from +Y, π/2 = horizon (drives
     *  camera pitch + head/neck visuals). r is unused, Spherical is reused
     *  so this can pass through mathcat's spherical helpers unchanged. */
    look: Spherical;
    /** [strafe, forward] in [-1, 1]. */
    move: ReturnType<typeof vec2.create>;
    /** whether the jump button is pressed. */
    jump: boolean;
    /** whether the sprint button is pressed. */
    sprint: boolean;
    /** whether the crouch button is pressed. */
    crouch: boolean;
    /** when true, sim is bypassed and the writer must move the transform. */
    noclip: boolean;
    /** userland override, when true, the sim treats the character as
     *  climbing regardless of voxel sampling. lets scripts force climb
     *  mode on contact with custom geometry (e.g. rope meshes). */
    climbOverride: boolean;
};

type CharacterControllerConfig = {
    /** inner-body half-extents (x, y, z) for the two posture shapes.
     *  `standing` is the default; `crouching` is swapped in (binary, via
     *  `isCrouchShape`) the instant `input.crouch` is held, and back once
     *  there's headroom to stand. defaults match MC's
     *  hitbox: standing 0.6×1.8×0.6, crouching 0.6×1.5×0.6. swap
     *  rebuilds the inner kinematic body's shape; eye-height +
     *  sneak-guard math read `state.vcc.halfExtents` live so they
     *  follow automatically. */
    halfExtents: {
        standing: Vec3;
        crouching: Vec3;
    };
    walkSpeed: number;
    sprintSpeed: number;
    crouchSpeed: number;
    jumpSpeed: number;
    terminalVelocity: number;
    gravity: number;
    stepHeight: number;
    /** drag rate on ground (1/s). horizontal velocity decays as
     *  `v *= exp(-rate · dt)` each frame, and ground acceleration is
     *  sized so steady-state = wish speed for the current input. block
     *  friction multiplies this: slippery blocks (friction < 1) reduce
     *  drag and lengthen coast; grippy blocks (friction > 1) increase
     *  drag. derived from MC's per-tick inertia `friction · 0.91`
     *  (≈ 0.546 at 20Hz on default blocks ⇒ -ln(0.546)/0.05 ≈ 12.1). */
    groundDragRate: number;
    /** drag rate in air (1/s). softer than MC's 1.9/s, sprint-jumpers
     *  keep more of their liftoff momentum, so a chain of sprint-jumps
     *  carries well ahead of plain running. */
    airDragRate: number;
    /** wish-direction acceleration applied in air (m/s²). much smaller
     *  than the implicit ground accel so jumps feel committed: you can
     *  steer but can't accelerate to walk speed mid-flight. matches
     *  MC's `0.02/tick` air control coefficient. */
    airAccel: number;
    /** horizontal kick (m/s) added along the wish direction at jump
     *  takeoff when sprinting, MC's +4 m/s, so sprint-jumping carries
     *  noticeably faster than running. */
    sprintJumpImpulse: number;
    /** vertical climb speed when in a climbable block / climbOverride. */
    climbSpeed: number;
    /** slow downward speed when on a ladder with no input (no wall push,
     * no jump, no crouch). MC-style: you don't hover, you trickle down. */
    climbDescendSpeed: number;
    /** vertical swim speed when in a liquid. */
    swimSpeed: number;
    /** horizontal accel cap while swimming. */
    swimAccel: number;
    /** downward "gravity" in a liquid, much smaller than `gravity`. */
    liquidSink: number;
    /** drag coefficient applied per tick as v *= exp(-liquidDrag * viscosity * dt). */
    liquidDrag: number;
    /** lerp factor for the per-state amplitude ramp, applied as
     *  `dt · rate` per frame. */
    bobAmpLerpRate: number;
    /** lerp factor for the bobOffsetX/Y settle on stop and for the
     *  item-sway offset (which is always lerped, motion or not). */
    bobOffsetLerpRate: number;
    /** ease rate (1/s) for `state.crouchAmount` toward the input. drives
     *  both the visual sneak pose (CharacterTrait body lean) and the
     *  camera eye-height drop (PlayerController), so they stay locked in
     *  step regardless of who reads it. */
    crouchLerpRate: number;
    /** standing eye height (m above feet), the look-ray origin used by the
     *  camera and `view.origin`. */
    eyeHeight: number;
    /** crouched eye height (m); the eased `state.eyeHeight` (and the camera +
     *  `view.origin`) lerp between the two by `state.crouchAmount`. */
    crouchEyeHeight: number;
    /** collision group bitfield for the character's inner body + all of its
     *  own sweeps. defaults to `COLLISION_GROUP_CHARACTERS`. pushed onto the
     *  live VCC every tick, so runtime changes take effect immediately. */
    collisionGroups: number;
    /** which collision groups the character collides with. defaults to
     *  everything EXCEPT `COLLISION_GROUP_CHARACTERS`, so characters pass
     *  through each other (Minecraft-style) while still colliding with the
     *  world + node/aabb bodies. set to `0xffffffff` to re-enable
     *  character-vs-character collision. applied live each tick. */
    collisionMask: number;
};

type CharacterControllerState = {
    /** current velocity of the character. */
    velocity: Vec3;
    /** whether the character is grounded. */
    grounded: boolean;
    /** state id of the voxel "at the character's foot sample",
     *  the standing block when grounded, the liquid voxel when
     *  feet-deep in a liquid, 0 otherwise. owner writes after the
     *  per-tick environment sample; remote clients read it for
     *  footstep / splash SFX and footstep particle resolution (since
     *  they have no `vcc`). minimal, uint16, syncs only on change.
     *  the swim case follows luanti's `getFootstepNodePos`, when
     *  `inLiquidStable` is true, this points at the liquid so the
     *  same SFX lookup picks up the liquid's `footstep` / `splash`
     *  clips for free. */
    groundBlockState: number;
    /** body-bob phase, radians. advances at `phaseVel · dt` while
     *  grounded and intending to move; resets to 0 when input
     *  displacement is zero, and is jammed to `3π/2` on landing so
     *  footsteps stay evenly spaced. one cycle = two footsteps.
     *  integrated locally on every client from `velocity`,
     *  `grounded`, and inputs so remote characters bob too. */
    bobPhase: number;
    /** `sin(bobPhase)` cached so the footstep system can detect
     *  threshold crossings without recomputing. */
    bobSineValue: number;
    bobSineValuePrevious: number;
    /** eased peak amplitudes (units). ramp toward per-state targets
     *  while bobbing, snap to 0 on stop. three independent axes,
     *  lateral (`sin(phase/2)`), vertical (`sin(phase)`), and item
     *  sway, so consumers can scale each without round-tripping
     *  through a unified 0..1. */
    bobLateralAmplitude: number;
    bobVerticalAmplitude: number;
    bobItemSwayAmplitude: number;
    /** head-displacement scalars (units). while bobbing these are
     *  written directly as `sin(phase/2) · lateralAmp` and
     *  `sin(phase) · verticalAmp`. on stop they lerp to zero so
     *  the camera glides home rather than snapping. cameras add
     *  `bobOffsetX` along the yaw-aligned right vector and
     *  `bobOffsetY` along world up. */
    bobOffsetX: number;
    bobOffsetY: number;
    /** item-sway scalars for held-tool / weapon transforms. lerped
     *  every frame (both into and out of motion) so weapon overlays
     *  glide smoothly. consumers add `bobItemSwayOffsetX` along the
     *  weapon's local right and `bobItemSwayOffsetY` along its local
     *  up. no weapon system here yet, exposed for later. */
    bobItemSwayOffsetX: number;
    bobItemSwayOffsetY: number;

    /** lazy vcc handle (owner-only). */
    vcc: vcc.VCC | undefined;
    isIntentionalMovement: boolean;
    /** sim writes a downward camera offset after stair step-ups; camera
     * decays it to zero in onFrame. lives here so the sim can write
     * without reaching across traits. */
    stepSmoothOffset: number;
    /** sampled per-tick: state id of the voxel directly under feet.
     * 0 = air. used for friction + sneak-guard flag checks. */
    standingStateId: number;
    /** sampled per-tick: true when feet sample voxel is climbable or
     * climbOverride is set. */
    isClimbing: boolean;
    /** sampled per-tick with hysteresis (enter low, exit high). */
    inLiquid: boolean;
    /** feet-deep liquid sample, true the moment the foot voxel is a
     *  liquid, no hysteresis. owner-only, not synced. presentation
     *  traits derive this remotely from `groundBlockState + BlockRegistry
     *  flags` (when the foot is in a liquid, `groundBlockState` is the
     *  liquid voxel state and its `BLOCK_FLAG_LIQUID` flag is set), so
     *  no separate field has to ride the wire. */
    inLiquidStable: boolean;
    /** 0..1 viscosity of the liquid we're in (0 if not in liquid). */
    liquidViscosity: number;
    /** state id of the voxel sampled at body-mid each `sampleEnvironment`
     *  call. carried over into `groundBlockState` post-move when the
     *  feet are in a liquid, so the SFX path picks up the liquid's
     *  `footstep` / `splash` clips. owner-only scratch, never synced. */
    feetStateId: number;
    /** crouch-guard anchor voxel coords (x, y, z). undefined when not
     *  engaged. matches luanti's `m_sneak_node`. */
    sneakNode: [number, number, number] | undefined;
    /** crouch-guard anchor: union AABB of the anchor voxel's collision
     *  shape, in VOXEL-LOCAL [0,1]³ coords. add `sneakNode` per-axis to
     *  get world bmin/bmax. matches luanti's `m_sneak_node_bb_top`.
     *  undefined when not engaged. */
    sneakNodeBbTop: [number, number, number, number, number, number] | undefined;
    /** true when the anchor was engaged because we're crouched on a
     *  ladder (rather than a normal sneak-guarded floor). suppresses the
     *  Y pull so the climb branch can manage vertical velocity. */
    sneakOnLadder: boolean;
    /** previous tick's wishvel got truncated by a wall. drives MC-style
     * climb: pushing into a wall on a ladder ascends. one-tick lag is
     * expected and matches Minecraft's `horizontalCollision` flag. */
    horizontalCollision: boolean;
    /** previous tick's `grounded`. used by the bob update to re-anchor
     *  `bobPhase` on landing, and exposed for downstream consumers
     *  (CharacterTrait footsteps, etc.) so they detect the landing edge
     *  against a snapshot taken from the same controller tick that wrote
     *  the current value, robust to multiple ticks per frame. */
    previousGrounded: boolean;
    /** previous tick's `bobPhase`. snapshotted at the start of
     *  `updateCharacterBob`, before any mutation, so consumers (footstep
     *  bucket-crossing detectors, etc.) see a real one-tick delta
     *  regardless of onFrame ordering. */
    previousBobPhase: number;
    /** previous bob-tick's `groundBlockState`. snapshotted at the end of
     *  `updateCharacterBob` (mirrors `previousGrounded`). presentation
     *  traits diff this against the current id to spot foot-sample
     *  transitions, entry splash fires when the new id is a liquid and
     *  the old one wasn't. */
    previousGroundBlockState: number;
    /** persistent body yaw (radians around +Y). while moving, tracks
     *  the velocity-direction yaw; while stationary, lingers. always
     *  clamped to within `BODY_YAW_LIMIT_RAD` of `input.look[1]` so the
     *  head never twists more than ~40° off the body. owner-written each
     *  tick into `transform.quaternion`; remote sides re-derive it
     *  from the synced quaternion when rotating the head bone. */
    bodyYaw: number;
    /** lazy init flag, first owner tick snaps `bodyYaw` to `look[1]`
     *  so spawning characters don't start with the body twisted 40°
     *  off their look direction. */
    bodyYawInit: boolean;
    /** which posture is currently active on `state.vcc.innerBody`. binary
     *  sim state: flips to true the instant `input.crouch` is held, and back
     *  to false on release *once there's headroom to stand*, owner-only
     *  (vcc is owner-only). the trait re-reads this each tick to detect the
     *  edge that drives `vcc.resize`; not synced because remote sides
     *  reconstruct posture from `input.crouch` for visuals. */
    isCrouchShape: boolean;
    /** VISUAL-ONLY 0..1 crouch, eased per-frame toward `input.crouch ? 1 : 0`
     *  at `config.crouchLerpRate` (in `updateCharacterBob`). the collider is
     *  binary (`isCrouchShape`) and never reads this, so the ease is pure
     *  presentation catch-up and render cadence can't drive a sim decision.
     *  shared signal: CharacterTrait drives the body lean off it and
     *  PlayerController the eye-height drop, so pose + camera stay locked in
     *  step. integrated locally on every client (input is synced) so remote
     *  viewers see the same eased pose as the owner. */
    crouchAmount: number;
    /** current eased eye height (m), lerped `eyeHeight`↔`crouchEyeHeight` by
     *  `crouchAmount`. the camera and `view.origin` read this. */
    eyeHeight: number;
};

/** the character's look ray this frame: eye `origin` (world space) + unit
 *  `direction` from `input.look`. populated every frame for every character,
 *  players AND npcs, so scripts can fire / raycast / aim from the eyes without
 *  reaching for the camera (which doesn't exist server-side or for npcs). */
export type CharacterView = {
    origin: Vec3;
    direction: Vec3;
};

export const CharacterControllerTrait = trait(
    'character-controller',
    {
        input: (): CharacterControllerInput => ({
            look: [0, 0, Math.PI / 2],
            move: vec2.create(),
            jump: false,
            sprint: false,
            crouch: false,
            noclip: false,
            climbOverride: false,
        }),

        config: (): CharacterControllerConfig => ({
            halfExtents: {
                standing: vec3.fromValues(0.3, 0.9, 0.3),
                crouching: vec3.fromValues(0.3, 0.75, 0.3),
            },
            walkSpeed: 5,
            sprintSpeed: 6.5,
            crouchSpeed: 1.3,
            jumpSpeed: 7,
            terminalVelocity: 40,
            gravity: 20,
            stepHeight: 0.55,
            groundDragRate: 12,
            airDragRate: 0.6,
            airAccel: 2,
            sprintJumpImpulse: 4,
            climbSpeed: 3,
            climbDescendSpeed: 1.5,
            swimSpeed: 4,
            swimAccel: 4,
            liquidSink: 1,
            liquidDrag: 4,
            bobAmpLerpRate: 15,
            bobOffsetLerpRate: 15,
            crouchLerpRate: 12,
            eyeHeight: 1.62,
            crouchEyeHeight: 1.37,
            collisionGroups: COLLISION_GROUP_CHARACTERS,
            collisionMask: exceptGroups(COLLISION_GROUP_CHARACTERS),
        }),

        state: (): CharacterControllerState => ({
            velocity: vec3.create(),
            grounded: true,
            groundBlockState: 0,
            bobPhase: 0,
            bobSineValue: 0,
            bobSineValuePrevious: 0,
            bobLateralAmplitude: 0,
            bobVerticalAmplitude: 0,
            bobItemSwayAmplitude: 0,
            bobOffsetX: 0,
            bobOffsetY: 0,
            bobItemSwayOffsetX: 0,
            bobItemSwayOffsetY: 0,
            vcc: undefined,
            isIntentionalMovement: false,
            stepSmoothOffset: 0,
            standingStateId: 0,
            isClimbing: false,
            inLiquid: false,
            inLiquidStable: false,
            liquidViscosity: 0,
            feetStateId: 0,
            sneakNode: undefined,
            sneakNodeBbTop: undefined,
            sneakOnLadder: false,
            horizontalCollision: false,
            previousGrounded: true,
            previousBobPhase: 0,
            previousGroundBlockState: 0,
            bodyYaw: 0,
            bodyYawInit: false,
            isCrouchShape: false,
            crouchAmount: 0,
            eyeHeight: 1.62,
        }),

        view: (): CharacterView => ({
            origin: vec3.create(),
            direction: vec3.create(),
        }),
    },
    { persist: false },
);

export type CharacterControllerTrait = TraitType<typeof CharacterControllerTrait>;

/* ── syncs ── */

// look: only theta + phi sync over the wire; r is unused. owner writes
// every frame (PC or NPC script) and the server forwards.
sync(CharacterControllerTrait, 'look', {
    schema: pack.list(pack.float32(), 2),
    pack: (t) => [t.input.look[1], t.input.look[2]],
    unpack: (v, t) => {
        t.input.look[1] = v[0]!;
        t.input.look[2] = v[1]!;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'move', {
    schema: pack.list(pack.float32(), 2),
    pack: (t) => t.input.move,
    unpack: (v, t) => {
        t.input.move[0] = v[0];
        t.input.move[1] = v[1];
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'jump', {
    schema: pack.boolean(),
    pack: (t) => t.input.jump,
    unpack: (v, t) => {
        t.input.jump = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'sprint', {
    schema: pack.boolean(),
    pack: (t) => t.input.sprint,
    unpack: (v, t) => {
        t.input.sprint = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'crouch', {
    schema: pack.boolean(),
    pack: (t) => t.input.crouch,
    unpack: (v, t) => {
        t.input.crouch = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'noclip', {
    schema: pack.boolean(),
    pack: (t) => t.input.noclip,
    unpack: (v, t) => {
        t.input.noclip = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'climb-override', {
    schema: pack.boolean(),
    pack: (t) => t.input.climbOverride,
    unpack: (v, t) => {
        t.input.climbOverride = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'velocity', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.state.velocity,
    unpack: (v, t) => {
        vec3.copy(t.state.velocity, v as Vec3);
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'grounded', {
    schema: pack.boolean(),
    pack: (t) => t.state.grounded,
    unpack: (v, t) => {
        t.state.grounded = v;
    },
    authority: 'owner',
});

sync(CharacterControllerTrait, 'ground-block-state', {
    schema: pack.uint16(),
    pack: (t) => t.state.groundBlockState,
    unpack: (v, t) => {
        t.state.groundBlockState = v;
    },
    authority: 'owner',
});

// ── inertia movement (minecraft-style) ────────────────────────────────
//
// each frame we apply an exponential drag (`v *= exp(-rate · dt)`) and
// then add `wishDir · accel · dt` along the input direction. no dot
// product against current velocity, so wishdir is the actual target
// direction, there is no quake-style air strafe or bunny-hop speed
// stacking. on ground, the accel coefficient is sized to make steady
// state exactly equal to wish speed; in air it's a small fixed value so
// jumps feel committed.
//
// continuous-time analogue of MC's per-tick model. MC at 20Hz does
// `v = v · friction · 0.91 + wishVel`; with default block friction 0.6
// that's a per-tick inertia of 0.546, i.e. drag rate -ln(0.546)/0.05 ≈
// 12.1/s, matching the `groundDragRate` default.

function applyHorizontalDrag(vel: Vec3, dragRate: number, dt: number): void {
    const k = Math.exp(-dragRate * dt);
    vel[0] *= k;
    vel[2] *= k;
}

function applyGroundWishAccel(vel: Vec3, wishDir: Vec3, dragRate: number, wishSpeed: number, dt: number): void {
    // accel = dragRate · wishSpeed makes the equilibrium of `dv/dt = a · wishDir
    // − dragRate · v` exactly `wishSpeed · wishDir`. with `wishSpeed = 0` (no
    // input) we add nothing and drag alone bleeds horizontal velocity.
    if (wishSpeed <= 0) return;
    const a = dragRate * wishSpeed * dt;
    vel[0] += wishDir[0] * a;
    vel[2] += wishDir[2] * a;
}

function applyAirWishAccel(vel: Vec3, wishDir: Vec3, airAccel: number, wishSpeed: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const a = airAccel * dt;
    vel[0] += wishDir[0] * a;
    vel[2] += wishDir[2] * a;
}

// ── environment sampling (climb / liquid / standing voxel) ───────────
//
// luanti-style: hysteresis on liquid (enter at center+0.5BS, exit at
// center+0.1BS), two-voxel climb sample (feet + 0.5, feet - 0.2). all
// samples are cheap: getBlock returns the global state id, then we look
// up flags in the registry's Uint32Array.

function sampleEnvironment(cc: CharacterControllerTrait, voxels: Voxels): void {
    const registry: BlockRegistry = voxels.registry;
    const flags = registry.flags;
    const viscosity = registry.liquidViscosity;
    const state = cc.state;

    const feet = state.vcc!.position;
    const fx = Math.floor(feet[0]);
    const fz = Math.floor(feet[2]);
    const headY = Math.floor(feet[1] + 1.5); // ~head sample for tall climbables
    const belowY = Math.floor(feet[1] - 0.05); // voxel under feet

    // liquid: luanti-style sub-voxel hysteresis (both probes near feet, no
    // head probe). enter when the +0.5 sample is wet, exit only once the
    // +0.1 sample is also dry. for 1-unit voxels this is sub-voxel: in any
    // pool where the feet voxel itself is liquid (even 1 block deep) both
    // samples land in that voxel and state is stable. matches
    // localplayer.cpp:266-290.
    //
    // earlier port used a head sample (feet+1.5) as the exit probe, which
    // flickered in any pool shallower than head-height because feet-voxel
    // was wet but head-voxel was air, that flicker bounced the character
    // between gravity and swim physics and retriggered landing footsteps
    // as `grounded` toggled.
    const liquidProbeY = Math.floor(feet[1] + (state.inLiquid ? 0.1 : 0.5));
    const liquidProbeState = getBlockState(voxels, fx, liquidProbeY, fz);
    const liquidProbeIsLiquid = flags[liquidProbeState]! & BLOCK_FLAG_LIQUID;

    // climb still needs the head sample (climb mode wants any body cell
    // touching a ladder, including the head voxel for tall columns).
    const headState = getBlockState(voxels, fx, headY, fz);
    const feetStateForFlags = getBlockState(voxels, fx, Math.floor(feet[1] + 0.1), fz);
    const belowState = getBlockState(voxels, fx, belowY, fz);
    const climbable = (flags[headState]! | flags[feetStateForFlags]! | flags[belowState]!) & BLOCK_FLAG_CLIMBABLE;
    state.isClimbing = cc.input.climbOverride || climbable !== 0;

    state.liquidViscosity = liquidProbeIsLiquid ? viscosity[liquidProbeState]! : 0;
    state.inLiquid = liquidProbeIsLiquid !== 0;
    state.inLiquidStable = (flags[feetStateForFlags]! & BLOCK_FLAG_LIQUID) !== 0;
    state.feetStateId = feetStateForFlags;

    // standing voxel for friction + sneak-guard. ask the solver first:
    // vcc.contacts carries each supporting voxel's stateId, which is
    // robust to overhangs (the column probe at center XZ reads air when
    // the body straddles a block's edge). fall back to the column probe
    // when no voxel contact qualifies. note: sampleEnvironment runs
    // pre-move, so this scans LAST tick's contacts, fine for steady
    // walking; on the landing tick it falls back to the column probe (a
    // one-tick friction approximation). footstep sfx/particles don't use
    // this, they read the solver's authoritative `groundVoxelStateId`.
    const standingFromContacts = deriveStandingStateFromContacts(state.vcc!);
    state.standingStateId = standingFromContacts !== 0 ? standingFromContacts : getBlockState(voxels, fx, belowY, fz);
}

/** pick the most up-facing voxel contact above the slope threshold; 0
 *  if none. used by sampleEnvironment (pre-move) and by the post-move
 *  groundBlockState assignment to catch the landing tick where the
 *  pre-move sample saw last frame's airborne (contact-less) state. */
function deriveStandingStateFromContacts(v: vcc.VCC): number {
    let stateId = 0;
    let bestNormalY = -Infinity;
    for (let i = 0; i < v.contacts.length; i++) {
        const c = v.contacts[i]!;
        if (c.stateId === 0) continue;
        if (!c.hadCollision || c.wasDiscarded) continue;
        if (c.surfaceNormalY < v.cosMaxSlopeAngle) continue;
        if (c.surfaceNormalY > bestNormalY) {
            bestNormalY = c.surfaceNormalY;
            stateId = c.stateId;
        }
    }
    return stateId;
}

// ── crouch edge guard ────────────────────────────────────────────────
//
// Faithful port of luanti's sneak-anchor (see llm/luanti/src/client/
// localplayer.cpp, lines 89-208 `updateSneakNode` and 393-444 `move`):
//
//   1. After the solver runs, if a previous anchor exists, clamp the
//      player's position to that anchor's union AABB (gated on
//      `y_diff < SNEAK_STEPHEIGHT`) and apply a smoothened Y pull
//      toward the anchor top (gated on `y_diff > 0 && vy <= 0`).
//   2. Then re-pick the anchor at the NEW (post-clamp) position via a
//      3×3 search using luanti's `position_y_mod` trick.
//
// No pre-move work, the solver runs unrestricted, then we clamp
// after. Matches luanti's order exactly. The anchor's bounds come from
// the voxel's *union* of collision boxes (`getNodeBoundingBox`), for
// stairs that's the full cube, but luanti's smoothened Y pull avoids
// the TP-up bug an instant snap would cause.

// sneak_max = m_collisionbox.getExtent() * 0.49f in luanti, i.e. the
// player's center can extend ~98% of the body's half-extents past the
// anchor's AABB edge before the clamp kicks in. without this the clamp triggers
// the moment the center reaches the block edge, locking traversal to
// integer columns, the player can never reach a block boundary to
// re-anchor. luanti's loose value also matches MC's visible "dangle".
const SNEAK_HALF_EXTENT_FACTOR = 0.98;

// max XZ distance from player center to candidate anchor's AABB center
// during the 3×3 search. luanti's value (`0.5 + 0.05` in block-size
// units), the 0.05 prevents sideways teleporting through thin walls.
const SNEAK_ALLOWED_RANGE = 0.55;

// cells above the candidate anchor voxel that must be non-collidable
// for the guard to engage. sized for the default standing height
// (1.8m → ceil = 2) and still sufficient for the default crouching
// height (1.3m → ceil = 2). stops sneak from anchoring you to a block
// you can't physically stand on. callers using taller-than-default
// shapes should bump this constant.
const SNEAK_HEADROOM_CELLS = 2;

// y_diff threshold below which the XZ clamp + Y pull engage. luanti
// uses 0.6 (`sneak_stepheight`). prevents the guard from grabbing you
// from absurd heights or depths.
const SNEAK_STEPHEIGHT = 0.6;

// Y pull rate (luanti: 22.0f) and per-frame bias (luanti: BS * 0.01).
// `position.Y += yDiff * dt * RATE + BIAS` per frame, capped at the
// anchor top. spreads the pull across ~3 frames on a 0.5 step rise.
const SNEAK_Y_PULL_RATE = 22;
const SNEAK_Y_PULL_BIAS = 0.01;

/** Union AABB of a block's collision shape in voxel-local [0,1]³
 *  coords. Matches luanti's `getNodeBoundingBox` (lines 73-86).
 *  Cube fast path (cid===0) returns the unit box without touching
 *  `shapeAabbs`. Non-AABB-shape blocks fall back to the unit box. */
function blockUnionAabbLocal(registry: BlockRegistry, stateId: number): [number, number, number, number, number, number] {
    const cid = registry.colliderId[stateId]!;
    if (cid === 0) return [0, 0, 0, 1, 1, 1];
    const kind = registry.shapeKind[cid];
    if (kind !== SHAPE_AABBS) return [0, 0, 0, 1, 1, 1];
    const boxes = registry.shapeAabbs[cid]!;
    if (boxes.length === 0) return [0, 0, 0, 1, 1, 1];
    let minX = boxes[0]![0],
        minY = boxes[0]![1],
        minZ = boxes[0]![2];
    let maxX = boxes[0]![3],
        maxY = boxes[0]![4],
        maxZ = boxes[0]![5];
    for (let i = 1; i < boxes.length; i++) {
        const b = boxes[i]!;
        if (b[0] < minX) minX = b[0];
        if (b[1] < minY) minY = b[1];
        if (b[2] < minZ) minZ = b[2];
        if (b[3] > maxX) maxX = b[3];
        if (b[4] > maxY) maxY = b[4];
        if (b[5] > maxZ) maxZ = b[5];
    }
    return [minX, minY, minZ, maxX, maxY, maxZ];
}

/** `SNEAK_HEADROOM_CELLS` cells above `(x, fy, z)` must be non-collidable.
 *  Mirrors luanti's `updateSneakNode` headroom check (lines 162-171). */
function hasSneakHeadroom(voxels: Voxels, x: number, fy: number, z: number): boolean {
    const flags = voxels.registry.flags;
    for (let y = 1; y <= SNEAK_HEADROOM_CELLS; y++) {
        if ((flags[getBlockState(voxels, x, fy + y, z)]! & BLOCK_FLAG_COLLISION) !== 0) return false;
    }
    return true;
}

/** Is the band the standing hull would add above the crouch hull clear of
 *  collidable voxels? Gates standing back up so you stay crouched under a
 *  low ceiling (MC-style). Exact for full cubes; conservative (stays
 *  crouched) for partial blocks, which is the safe direction. */
function canStandUp(cc: CharacterControllerTrait, voxels: Voxels): boolean {
    const v = cc.state.vcc;
    if (!v) return true;
    const flags = voxels.registry.flags;
    const feet = v.position;
    const half = cc.config.halfExtents;
    // feet → top: the standing hull rises `2*halfY`; only the slice above the
    // crouch top is new, so scan [crouchTop, standingTop) across the footprint.
    const bandBottom = feet[1] + half.crouching[1] * 2;
    const bandTop = feet[1] + half.standing[1] * 2;
    const x0 = Math.floor(feet[0] - half.standing[0]);
    const x1 = Math.floor(feet[0] + half.standing[0]);
    const z0 = Math.floor(feet[2] - half.standing[2]);
    const z1 = Math.floor(feet[2] + half.standing[2]);
    const y0 = Math.floor(bandBottom);
    const y1 = Math.floor(bandTop - 1e-4);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            for (let z = z0; z <= z1; z++) {
                if ((flags[getBlockState(voxels, x, y, z)]! & BLOCK_FLAG_COLLISION) !== 0) return false;
            }
        }
    }
    return true;
}

// 3×3 neighbor offsets used by the sneak anchor search, center voxel
// first, then 4 cardinals, then 4 diagonals. matches luanti's
// `dir9_center` order in localplayer.cpp (line 96).
const SNEAK_SEARCH_OFFSETS: readonly [number, number][] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
];

/** Faithful port of luanti's `updateSneakNode` (lines 89-208). Runs on
 *  the post-solver position, finds a sneak-guardable voxel within the
 *  3×3 around the foot voxel (using `position_y_mod` so the foot voxel
 *  is computed relative to the previous anchor top, not raw position),
 *  picks the nearest candidate with headroom, and stores its voxel
 *  coords + union AABB. Returns true if anchored.
 *
 *  Side effects on `state`: sets/clears `sneakNode` and `sneakNodeBbTop`. */
function updateSneakNode(cc: CharacterControllerTrait, voxels: Voxels): boolean {
    const state = cc.state;
    const v = state.vcc!;
    const registry = voxels.registry;
    const flags = registry.flags;

    // position_y_mod: luanti's trick to find the foot voxel even when
    // standing on a non-cube surface (e.g. slab top at y=N+0.5 → foot
    // voxel is N, not N-1). default 0.02; if engaged, use the previous
    // anchor's local-coord top minus 0.02.
    let positionYMod = 0.02;
    if (state.sneakNodeBbTop) positionYMod = state.sneakNodeBbTop[4] - 0.02;

    const cx = Math.floor(v.position[0]);
    const cz = Math.floor(v.position[2]);
    const fy = Math.floor(v.position[1] - positionYMod);

    // keep current sneak node if its voxel coords still match and it's
    // still guardable. cheaper than re-running the full 3×3 search.
    if (state.sneakNode && state.sneakNode[0] === cx && state.sneakNode[1] === fy && state.sneakNode[2] === cz) {
        const stateId = getBlockState(voxels, cx, fy, cz);
        if ((flags[stateId]! & BLOCK_FLAG_SNEAK_GUARD) !== 0) return true;
    }

    // 3×3 search around (cx, fy, cz). pick the guardable candidate
    // nearest the player's XZ (using union AABB center), subject to
    // per-axis range cap + headroom.
    let bestX = 0,
        bestY = 0,
        bestZ = 0;
    let bestBox: [number, number, number, number, number, number] | null = null;
    let minDistSq = Infinity;
    const sneakMaxX = v.halfExtents[0] * SNEAK_HALF_EXTENT_FACTOR;
    const sneakMaxZ = v.halfExtents[2] * SNEAK_HALF_EXTENT_FACTOR;
    const rangeCapX = SNEAK_ALLOWED_RANGE + sneakMaxX;
    const rangeCapZ = SNEAK_ALLOWED_RANGE + sneakMaxZ;
    for (let i = 0; i < SNEAK_SEARCH_OFFSETS.length; i++) {
        const dx = SNEAK_SEARCH_OFFSETS[i]![0];
        const dz = SNEAK_SEARCH_OFFSETS[i]![1];
        const x = cx + dx;
        const z = cz + dz;
        const stateId = getBlockState(voxels, x, fy, z);
        if ((flags[stateId]! & BLOCK_FLAG_SNEAK_GUARD) === 0) continue;
        const localBox = blockUnionAabbLocal(registry, stateId);
        const cxw = x + (localBox[0] + localBox[3]) * 0.5;
        const czw = z + (localBox[2] + localBox[5]) * 0.5;
        const ddx = v.position[0] - cxw;
        const ddz = v.position[2] - czw;
        const distSq = ddx * ddx + ddz * ddz;
        if (distSq > minDistSq) continue;
        if (Math.abs(ddx) > rangeCapX || Math.abs(ddz) > rangeCapZ) continue;
        if (!hasSneakHeadroom(voxels, x, fy, z)) continue;
        minDistSq = distSq;
        bestX = x;
        bestY = fy;
        bestZ = z;
        bestBox = localBox;
    }

    if (bestBox === null) {
        state.sneakNode = undefined;
        state.sneakNodeBbTop = undefined;
        return false;
    }

    if (state.sneakNode) {
        state.sneakNode[0] = bestX;
        state.sneakNode[1] = bestY;
        state.sneakNode[2] = bestZ;
    } else {
        state.sneakNode = [bestX, bestY, bestZ];
    }
    state.sneakNodeBbTop = bestBox;
    return true;
}

/** Apply luanti's post-collision sneak clamp + smoothened Y pull,
 *  using the *previous* anchor (i.e. the anchor at the start of this
 *  tick, before `updateSneakNode` re-picks). Mirrors lines 395-444 of
 *  luanti's `move()`. Returns true if a previous anchor existed (used
 *  to force grounded for the rest of the tick). */
function applySneakClamp(cc: CharacterControllerTrait, dt: number): boolean {
    const state = cc.state;
    const v = state.vcc!;
    const node = state.sneakNode;
    const box = state.sneakNodeBbTop;
    if (!node || !box) return false;

    // ladder grip: XZ clamp to the ladder voxel's unit footprint, no
    // Y pull (climb branch owns vertical motion).
    if (state.sneakOnLadder) {
        const sneakMaxX = v.halfExtents[0] * SNEAK_HALF_EXTENT_FACTOR;
        const sneakMaxZ = v.halfExtents[2] * SNEAK_HALF_EXTENT_FACTOR;
        const oldX = v.position[0];
        const oldZ = v.position[2];
        const xMin = node[0] - sneakMaxX;
        const xMax = node[0] + 1 + sneakMaxX;
        const zMin = node[2] - sneakMaxZ;
        const zMax = node[2] + 1 + sneakMaxZ;
        if (v.position[0] < xMin) v.position[0] = xMin;
        else if (v.position[0] > xMax) v.position[0] = xMax;
        if (v.position[2] < zMin) v.position[2] = zMin;
        else if (v.position[2] > zMax) v.position[2] = zMax;
        if (v.position[0] !== oldX) v.linearVelocity[0] = 0;
        if (v.position[2] !== oldZ) v.linearVelocity[2] = 0;
        return true;
    }

    // floor sneak, luanti's bmin/bmax in world space:
    //   bmin = node + box.MinEdge, bmax = node + box.MaxEdge.
    const bminX = node[0] + box[0];
    const bmaxX = node[0] + box[3];
    const bminZ = node[2] + box[2];
    const bmaxZ = node[2] + box[5];
    const bmaxY = node[1] + box[4];
    const sneakMaxX = v.halfExtents[0] * SNEAK_HALF_EXTENT_FACTOR;
    const sneakMaxZ = v.halfExtents[2] * SNEAK_HALF_EXTENT_FACTOR;
    const yDiff = bmaxY - v.position[1];

    // XZ clamp gated on yDiff < sneak_stepheight (line 404).
    if (yDiff < SNEAK_STEPHEIGHT) {
        const oldX = v.position[0];
        const oldZ = v.position[2];
        const xMin = bminX - sneakMaxX;
        const xMax = bmaxX + sneakMaxX;
        const zMin = bminZ - sneakMaxZ;
        const zMax = bmaxZ + sneakMaxZ;
        if (v.position[0] < xMin) v.position[0] = xMin;
        else if (v.position[0] > xMax) v.position[0] = xMax;
        if (v.position[2] < zMin) v.position[2] = zMin;
        else if (v.position[2] > zMax) v.position[2] = zMax;
        if (v.position[0] !== oldX) v.linearVelocity[0] = 0;
        if (v.position[2] !== oldZ) v.linearVelocity[2] = 0;
    }

    // smoothened Y pull (lines 417-428): gated on yDiff > 0 (player
    // below anchor top) AND vy <= 0 (not jumping up). also gated by
    // yDiff < sneak_stepheight, so stair-step from y=0.5 to bmax=1.0
    // (yDiff=0.5) pulls up gradually instead of instant snap.
    if (yDiff > 0 && v.linearVelocity[1] <= 0 && yDiff < SNEAK_STEPHEIGHT) {
        const newY = v.position[1] + yDiff * dt * SNEAK_Y_PULL_RATE + SNEAK_Y_PULL_BIAS;
        v.position[1] = Math.min(newY, bmaxY);
        v.linearVelocity[1] = 0;
    }

    return true;
}

/** Combined post-move sneak processing:
 *   1. apply clamp + Y pull using the previous anchor (if any)
 *   2. re-pick the anchor at the new position (floor sneak) or relock
 *      to the current voxel (ladder grip)
 *  Returns true if the player should be force-grounded this tick. */
function processCrouchGuard(cc: CharacterControllerTrait, voxels: Voxels, dt: number): boolean {
    const state = cc.state;
    const input = cc.input;
    const v = state.vcc!;

    const onLadder = state.isClimbing && input.crouch;
    const couldSneakFloor = input.crouch && !state.inLiquid && !input.noclip && !input.jump && !state.isClimbing;
    const engaged = onLadder || couldSneakFloor;

    // disengage entirely (and skip clamp) when no sneak path applies.
    if (!engaged) {
        state.sneakNode = undefined;
        state.sneakNodeBbTop = undefined;
        state.sneakOnLadder = false;
        return false;
    }

    // phase 1: clamp using the anchor from the previous tick.
    const hadAnchor = applySneakClamp(cc, dt);

    // phase 2: pick the new anchor for next tick.
    if (onLadder) {
        const cx = Math.floor(v.position[0]);
        const cy = Math.floor(v.position[1]);
        const cz = Math.floor(v.position[2]);
        if (state.sneakNode) {
            state.sneakNode[0] = cx;
            state.sneakNode[1] = cy;
            state.sneakNode[2] = cz;
        } else {
            state.sneakNode = [cx, cy, cz];
        }
        state.sneakNodeBbTop = [0, 0, 0, 1, 1, 1];
        state.sneakOnLadder = true;
        // ladder mode never claims grounded, climb branch keeps us in climb mode.
        return false;
    }

    state.sneakOnLadder = false;
    updateSneakNode(cc, voxels);
    // force grounded only if we actually clamped this tick, matches
    // luanti's `m_standing_node = m_sneak_node` (line 402), which sits
    // inside the clamp block and so only fires when an anchor existed.
    return hadAnchor;
}

// ── lazy init ────────────────────────────────────────────────────────

const MAX_SLOPE_ANGLE = degreesToRadians(45);

function ensureVCC(cc: CharacterControllerTrait, transform: TransformTrait, physics: Physics): void {
    if (cc.state.vcc) return;
    const feet = getWorldPosition(transform);
    cc.state.vcc = vcc.create(physics.rigid.world, physics.rigid.terrainShape.voxels, {
        halfExtents: cc.config.halfExtents.standing,
        position: [feet[0], feet[1], feet[2]],
        maxSlopeAngle: MAX_SLOPE_ANGLE,
        collisionGroups: cc.config.collisionGroups,
        collisionMask: cc.config.collisionMask,
    });
    cc.state.isCrouchShape = false;
    // attribute crashcat contact events on the VCC inner body back to this
    // node so the listener's resolveSide can fan them out into the node's
    // ContactsTrait. registered only in bodyToNode (not nodeToBody), the
    // VCC owns the body's lifecycle, not the rigid-body trait installer.
    physics.rigid.bodyToNode.set(cc.state.vcc.innerBodyId, cc._node.id);
}

function disposeVCC(cc: CharacterControllerTrait, physics: Physics): void {
    if (!cc.state.vcc) return;
    physics.rigid.bodyToNode.delete(cc.state.vcc.innerBodyId);
    vcc.destroy(physics.rigid.world, cc.state.vcc);
    cc.state.vcc = undefined;
}

// ── crouch shape (runs on every side) ────────────────────────────────
//
// binary, driven by the already-synced `input.crouch`: the hull swaps the
// instant the input flips (on release, only once there's headroom to stand,
// else you stay crouched under a low ceiling). running off synced input
// keeps the inner body coherent on the owner, server, and peer clients, so
// sensor triggers and raycasts hit the right hull on every side. the visual
// `crouchAmount` (presentation only) eases to catch up in `updateCharacterBob`.
// note: replicated input arrives ~50-150ms after the owner, so the shape
// flips later on non-owner sides; during that window shapes briefly disagree.
function updateCrouchShape(cc: CharacterControllerTrait, physics: Physics): void {
    const v = cc.state.vcc;
    if (!v) return;
    const state = cc.state;
    const config = cc.config;
    const voxels = physics.rigid.terrainShape.voxels;
    const wantCrouchShape = cc.input.crouch || (state.isCrouchShape && !canStandUp(cc, voxels));
    if (wantCrouchShape !== state.isCrouchShape) {
        vcc.resize(physics.rigid.world, v, wantCrouchShape ? config.halfExtents.crouching : config.halfExtents.standing);
        state.isCrouchShape = wantCrouchShape;
    }
}

// push the config's collision group/mask onto the live VCC every tick, so a
// script that flips `config.collisionMask` at runtime (team swap, ghost mode)
// takes effect like every other live config field. cheap, and keeps the three
// homes (VCC struct, inner body, body-query filter) coherent with config.
function syncCollisionFilter(cc: CharacterControllerTrait): void {
    const v = cc.state.vcc;
    if (!v) return;
    const { collisionGroups, collisionMask } = cc.config;
    v.collisionGroups = collisionGroups;
    v.collisionMask = collisionMask;
    v.innerBody.collisionGroups = collisionGroups;
    v.innerBody.collisionMask = collisionMask;
    v.bodyFilter.collisionGroups = collisionGroups;
    v.bodyFilter.collisionMask = collisionMask;
}

// ── per-tick movement ─────────────────────────────────────────────────

function tickCharacterController(
    cc: CharacterControllerTrait,
    transform: TransformTrait,
    physics: Physics,
    dt: number,
): void {
    const input = cc.input;
    const config = cc.config;
    const state = cc.state;
    const v = state.vcc!;
    const voxels = physics.rigid.terrainShape.voxels;
    const world = physics.rigid.world;
    const aabbWorld = physics.aabb;
    const registry = voxels.registry;

    // sync vcc position with transform up-front so sampleEnvironment sees
    // the current feet location, not last tick's.
    const feet = getWorldPosition(transform);
    v.position[0] = feet[0];
    v.position[1] = feet[1];
    v.position[2] = feet[2];

    sampleEnvironment(cc, voxels);
    const isClimbing = state.isClimbing;
    const inLiquid = state.inLiquid;

    // input → wish direction
    const theta = input.look[1];
    const strafe = input.move[0];
    const fwd = input.move[1];
    vec3.set(_forward, -Math.sin(theta), 0, -Math.cos(theta));
    vec3.set(_right, Math.cos(theta), 0, -Math.sin(theta));
    vec3.set(_movementDir, _forward[0] * fwd + _right[0] * strafe, 0, _forward[2] * fwd + _right[2] * strafe);
    const movLen = vec3.length(_movementDir);
    state.isIntentionalMovement = movLen > 1e-6;
    if (state.isIntentionalMovement) vec3.scale(_movementDir, _movementDir, 1 / movLen);

    // clamp input magnitude to 1 so keyboard diagonals (movLen = √2) don't
    // exceed cardinal wishSpeed, analog sticks already report |stick| ≤ 1
    // so this only kicks in for digital input.
    const inputMag = movLen > 1 ? 1 : movLen;
    const wishSpeed = inputMag * (input.sprint ? config.sprintSpeed : input.crouch ? config.crouchSpeed : config.walkSpeed);
    const wasGrounded = state.grounded;
    // normal-mode jump only, climb/liquid consume the jump key for their
    // own up-ascend.
    const wantsJump = input.jump && wasGrounded && !isClimbing && !inLiquid;

    // velocity update, MC-style drag + accel, with climb/liquid branches.
    vec3.copy(_newVel, state.velocity);
    const vertVel = _newVel[1];
    vec3.copy(_horizVel, _newVel);
    _horizVel[1] = 0;

    let newVert: number;
    if (isClimbing) {
        // MC-style ladder: crouch grabs on (vy=0, anchor clamps XZ below);
        // jump or "pushed into a wall last tick" ascends; otherwise we
        // trickle down at climbDescendSpeed. climbOverride keeps the legacy
        // hover-when-idle behavior since it has no wall to push against.
        if (input.crouch) {
            newVert = 0;
        } else if (input.jump || state.horizontalCollision) {
            newVert = config.climbSpeed;
        } else {
            newVert = input.climbOverride ? 0 : -config.climbDescendSpeed;
        }
        applyHorizontalDrag(_horizVel, config.groundDragRate, dt);
        applyGroundWishAccel(_horizVel, _movementDir, config.groundDragRate, wishSpeed, dt);
    } else if (inLiquid) {
        // swim: replace gravity with liquidSink; jump=up, crouch=down.
        if (input.jump) newVert = config.swimSpeed;
        else if (input.crouch) newVert = -config.swimSpeed;
        else newVert = Math.max(vertVel - config.liquidSink * dt, -config.terminalVelocity);
        // horizontal: air-style additive accel. velocity is naturally capped
        // by the viscosity drag applied below.
        applyAirWishAccel(_horizVel, _movementDir, config.swimAccel, wishSpeed, dt);
        // viscosity drag on the full velocity, luanti's resistance term.
        const drag = Math.exp(-config.liquidDrag * state.liquidViscosity * dt);
        _horizVel[0] *= drag;
        _horizVel[2] *= drag;
        newVert *= drag;
    } else {
        // normal mode, integrate gravity / jump.
        if (wantsJump) {
            newVert = config.jumpSpeed - config.gravity * dt;
            // MC sprint-jump kick: +4 m/s along wishDir at takeoff. paired
            // with the higher air drag to make continuous sprint-jumping
            // the fastest foot travel.
            if (input.sprint && state.isIntentionalMovement) {
                _horizVel[0] += _movementDir[0] * config.sprintJumpImpulse;
                _horizVel[2] += _movementDir[2] * config.sprintJumpImpulse;
            }
        } else if (wasGrounded) {
            newVert = 0;
        } else {
            newVert = Math.max(vertVel - config.gravity * dt, -config.terminalVelocity);
        }

        if (wantsJump || !wasGrounded) {
            // air: small fixed accel + light drag. you keep most of your
            // liftoff momentum and can steer, but can't actively build new
            // horizontal speed beyond a slow drift.
            applyHorizontalDrag(_horizVel, config.airDragRate, dt);
            applyAirWishAccel(_horizVel, _movementDir, config.airAccel, wishSpeed, dt);
        } else {
            // ground: add surface velocity, then drag + accel. block
            // friction multiplies the drag rate (ice → less drag → coasts;
            // mud → more drag → grips). steady-state remains wishSpeed
            // because the accel coefficient uses the same scaled drag.
            const gv = v.groundVelocity;
            _horizVel[0] += gv[0];
            _horizVel[2] += gv[2];
            const fs = registry.friction[state.standingStateId] ?? 1;
            const dragRate = config.groundDragRate * fs;
            applyHorizontalDrag(_horizVel, dragRate, dt);
            applyGroundWishAccel(_horizVel, _movementDir, dragRate, wishSpeed, dt);
        }
    }

    vec3.copy(_newVel, _horizVel);
    _newVel[1] = newVert;

    v.linearVelocity[0] = _newVel[0];
    v.linearVelocity[1] = _newVel[1];
    v.linearVelocity[2] = _newVel[2];

    // remember pre-move feet for stair-trigger heuristics.
    const startX = feet[0];
    const startZ = feet[2];

    // run gather → solve → sweep-verify → ground state → inner-body sync.
    _vccListenerIsIntentional = state.isIntentionalMovement;
    _vccListenerTerrainBodyId = physics.rigid.terrainBody.id;
    _vccListenerBlockRest = registry.restitution;
    _vccListenerRigid = physics.rigid;

    vcc.move(world, voxels, aabbWorld, v, dt, _vccListener);

    let grounded = v.groundState === vcc.GROUND_STATE_ON_GROUND;

    // ladder climb-on-wall-push: project post-move displacement onto the raw
    // wish direction (foot-level input, pre-friction). this is independent
    // of friction (which shrinks _newVel near a wall) and of contact-list
    // conflict-resolution (which can drop a wall contact in favor of the
    // floor when the player is grounded at the corner). when unobstructed,
    // gotInDir ≈ wishSpeed * dt; when blocked, ~0. read by the climb branch
    // next tick, one-tick lag matches MC's horizontalCollision.
    const wishMag = wishSpeed * dt;
    if (state.isIntentionalMovement && wishMag > 1e-4) {
        const gotInDir = (v.position[0] - startX) * _movementDir[0] + (v.position[2] - startZ) * _movementDir[2];
        state.horizontalCollision = gotInDir < wishMag * 0.3;
    } else {
        state.horizontalCollision = false;
    }

    // walkStairs / stickToFloor: skipped while climbing or in a liquid.
    const wishDx = _newVel[0] * dt;
    const wishDz = _newVel[2] * dt;
    const wishSq = wishDx * wishDx + wishDz * wishDz;
    if (grounded && !wantsJump && !isClimbing && !inLiquid && config.stepHeight > 0 && wishSq > 1e-8) {
        const gotDx = v.position[0] - startX;
        const gotDz = v.position[2] - startZ;
        const gotSq = gotDx * gotDx + gotDz * gotDz;
        if (gotSq < wishSq * 0.99) {
            const remDx = wishDx - gotDx;
            const remDz = wishDz - gotDz;
            const preStepY = v.position[1];
            const stepped = vcc.walkStairs(world, voxels, aabbWorld, v, config.stepHeight, remDx, remDz, remDx, remDz, 0.05);
            if (stepped) {
                v.linearVelocity[0] = _newVel[0];
                v.linearVelocity[2] = _newVel[2];
                state.stepSmoothOffset -= v.position[1] - preStepY;
                state.stepSmoothOffset = Math.max(-config.stepHeight, Math.min(config.stepHeight, state.stepSmoothOffset));
            }
        }
    }

    if (wasGrounded && !grounded && !wantsJump && !isClimbing && !inLiquid && config.stepHeight > 0) {
        const preStickY = v.position[1];
        if (vcc.stickToFloor(world, voxels, aabbWorld, v, -config.stepHeight)) {
            grounded = true;
            const drop = v.position[1] - preStickY;
            if (drop < -0.01) {
                state.stepSmoothOffset -= drop;
                state.stepSmoothOffset = Math.max(-config.stepHeight, Math.min(config.stepHeight, state.stepSmoothOffset));
            }
        }
    }

    // post-move sneak guard: clamp position + smoothened Y pull using
    // the previous anchor, then re-pick the anchor for next tick.
    // Faithful port of luanti's `move()` clamp + `updateSneakNode` (see
    // llm/luanti/src/client/localplayer.cpp:393-444 and :89-208).
    if (processCrouchGuard(cc, voxels, dt)) grounded = true;

    // climbing always reports grounded (so jump-as-ascend reaches the climb
    // branch next tick); liquid always reports airborne (so jump-as-swim
    // does the same).
    if (isClimbing) grounded = true;
    else if (inLiquid) grounded = false;

    state.grounded = grounded;
    // foot-sample resolution for SFX + particles (luanti's
    // `getFootstepNodePos` model, one field carries whichever block
    // the foot is interacting with this tick). priority:
    //   1. real ground contact wins, slabs, stairs, sand under shallow
    //      water all play their own sounds even if the body-mid probe
    //      happens to land in an adjacent liquid cell.
    //   2. otherwise feet-in-liquid → liquid voxel (drives swim cadence +
    //      entry splash).
    //   3. otherwise airborne → 0; presentation traits treat 0 as "no
    //      contact" and stay silent.
    // authoritative standing block: the solver already pinned the exact ground
    // voxel (updateGroundState / stick / walk-down) and stamped its state, so
    // read it directly instead of re-deriving from contacts + a floor-of-center
    // column probe, that mis-sampled the block at cell boundaries (wrong-block
    // footstep sfx + particles).
    let footState = 0;
    if (grounded && v.groundVoxelStateId !== 0) footState = v.groundVoxelStateId;
    else if (state.inLiquidStable) footState = state.feetStateId;
    state.groundBlockState = footState;
    // horizontal velocity reflects the *effective* post-solve motion (from
    // the actual position delta) rather than the pre-solve wishvel, the
    // vcc solver only mutates a working-copy velocity during slide, so
    // v.linearVelocity still carries our pre-collision request. without
    // this fix, walking into a wall keeps state.velocity at full forward
    // speed, which fakes bob/leg motion. vertical is left as the
    // integrated value so the gravity integrator next tick starts from a
    // clean velocity instead of half-stepping behind.
    const invDt = dt > 0 ? 1 / dt : 0;
    state.velocity[0] = (v.position[0] - startX) * invDt;
    state.velocity[1] = v.linearVelocity[1];
    state.velocity[2] = (v.position[2] - startZ) * invDt;

    feet[0] = v.position[0];
    feet[1] = v.position[1];
    feet[2] = v.position[2];
    setWorldPosition(transform, feet);

    // body yaw, voxelibre-style decoupled head/body. body tracks the
    // velocity-direction yaw while moving, lingers while stationary, and
    // is always clamped to within ±BODY_YAW_LIMIT_RAD of look[1] so the
    // head can't twist past a plausible neck range. on each side, the
    // CharacterTrait head bone re-derives its local yaw as
    // `look[1] - bodyYaw` for the matching counter-rotation.
    //
    // sign: avatars are authored facing -Z, so setAxisAngle(UP, +θ) applied
    // to (0,0,-1) yields (-sinθ, 0, -cosθ), matches engine forward in the
    // input section above. atan2(-vx, -vz) inverts to the same convention.
    if (!state.bodyYawInit) {
        state.bodyYaw = input.look[1];
        state.bodyYawInit = true;
    }
    const bvx = state.velocity[0];
    const bvz = state.velocity[2];
    const bodyHorizSpeed = Math.sqrt(bvx * bvx + bvz * bvz);
    // target body yaw, three cases:
    //   1. stopped or inside back-cone → look-yaw (no twist). without
    //      the back-cone, pure-backward velocity (≈180° from look) drags
    //      target to the opposite side and the ±BODY_YAW_LIMIT_RAD clamp
    //      visibly twists the avatar, reads as a torso tilt.
    //   2. forward-half motion → velocity-direction yaw (`atan2(-bvx,
    //      -bvz)`). body leans into the strafe direction.
    //   3. backward-half (outside cone) → mirror of velocity yaw through
    //      look, i.e. `atan2(+bvx, +bvz)` (= velYaw + π mod 2π). same
    //      strafe magnitude but flipped sign, so back-left tilts the
    //      body opposite to how forward-left does. matches the
    //      intuition that the "leading" side of backward motion is the
    //      side opposite the strafe direction.
    //
    // forward dot: engine forward is `(-sin(θ), 0, -cos(θ))`, so
    // `dot(vel, fwd) = -(bvx·sinθ + bvz·cosθ)`. inside the back-cone
    // ⇔ `velFwdDot < -cos(coneHalfAngle) · |vel|`.
    const lookSin = Math.sin(input.look[1]);
    const lookCos = Math.cos(input.look[1]);
    const velFwdDot = -(bvx * lookSin + bvz * lookCos);
    const inBackCone = velFwdDot < -BODY_YAW_BACK_CONE_COS * bodyHorizSpeed;
    let targetBodyYaw: number;
    if (bodyHorizSpeed <= BODY_VEL_YAW_MIN_SPEED || inBackCone) {
        targetBodyYaw = input.look[1];
    } else if (velFwdDot >= 0) {
        targetBodyYaw = Math.atan2(-bvx, -bvz);
    } else {
        targetBodyYaw = Math.atan2(bvx, bvz);
    }
    // exponential approach toward target, taking the short way round the
    // ±π seam. fraction-of-gap-per-frame = `1 - exp(-rate · dt)`, so the
    // turn starts fast (close approach to constant rate when delta is
    // big) and eases into the destination (rate → 0 as delta → 0).
    const slewDelta = wrapPi(targetBodyYaw - state.bodyYaw);
    const k = 1 - Math.exp(-BODY_YAW_RESPONSE_RATE * dt);
    state.bodyYaw = wrapPi(state.bodyYaw + slewDelta * k);
    // safety net: even mid-slew, never let the body stray more than
    // BODY_YAW_LIMIT_RAD from look, a fast head whip should drag the
    // body along rather than overshoot the neck twist.
    let bodyYawDelta = wrapPi(state.bodyYaw - input.look[1]);
    if (bodyYawDelta > BODY_YAW_LIMIT_RAD) bodyYawDelta = BODY_YAW_LIMIT_RAD;
    else if (bodyYawDelta < -BODY_YAW_LIMIT_RAD) bodyYawDelta = -BODY_YAW_LIMIT_RAD;
    state.bodyYaw = input.look[1] + bodyYawDelta;
    quat.setAxisAngle(_bodyYawQuat, _bodyYawAxis, state.bodyYaw);
    setQuaternion(transform, _bodyYawQuat);
}

// ── noclip displacement helper ────────────────────────────────────────
//
// the writer (PlayerController for players, AI for NPCs) supplies the
// world-space velocity. we just translate the transform by it and keep
// the kinematic inner body following so other queries don't lose track.

export function applyNoclipDisplacement(
    cc: CharacterControllerTrait,
    transform: TransformTrait,
    physics: Physics,
    velocity: Vec3,
    dt: number,
): void {
    const state = cc.state;
    const wp = getWorldPosition(transform);
    wp[0] += velocity[0] * dt;
    wp[1] += velocity[1] * dt;
    wp[2] += velocity[2] * dt;
    setWorldPosition(transform, wp);

    vec3.set(state.velocity, 0, 0, 0);
    state.grounded = false;
    state.groundBlockState = 0;

    if (state.vcc) {
        rigidBody.setTransform(physics.rigid.world, state.vcc.innerBody, wp, _identityQuat, false);
    }

    quat.setAxisAngle(_bodyYawQuat, _bodyYawAxis, cc.input.look[1]);
    setQuaternion(transform, _bodyYawQuat);
}

// ── bob ───────────────────────────────────────────────────────────────
//
// integrates body-bob phase + per-axis amplitudes on every client.
// driven by inputs + actual velocity + grounded state; outputs land on
// the trait so cameras, SFX and (later) anims can read them. remote
// viewers compute matching bob locally because all inputs sync.
//
// three-axis model:
//   - lateral camera:  sin(phase/2) · lateralAmp     (one swing/step pair)
//   - vertical camera: sin(phase)   · verticalAmp    (full sine)
//   - item sway:       cos(phase/2) · itemAmp        (lerped, x-axis)
//                      −sin²(phase/2) · itemAmp      (lerped, y-axis)
//
// amplitudes ramp toward state-specific targets (walk vs run vs crouch
// vs idle vs fall vs fly). on stop, amplitudes hard-zero and the
// camera/item offsets lerp home so the view glides back to neutral.

type BobStatus = 'walk' | 'run' | 'crouch' | 'idle' | 'fall' | 'fly';

/** per-state amplitude targets (units). */
const CHARACTER_BOB_STATE_VALUES: Record<
    BobStatus,
    {
        itemSwayAmplitude: number;
        horizontalAmplitude: number;
        verticalAmplitude: number;
    }
> = {
    walk: { itemSwayAmplitude: 0.04, horizontalAmplitude: 0, verticalAmplitude: 0.05 },
    run: { itemSwayAmplitude: 0.06, horizontalAmplitude: 0.05, verticalAmplitude: 0.05 },
    crouch: { itemSwayAmplitude: 0.04, horizontalAmplitude: 0, verticalAmplitude: 0 },
    idle: { itemSwayAmplitude: 0, horizontalAmplitude: 0, verticalAmplitude: 0 },
    fall: { itemSwayAmplitude: 0, horizontalAmplitude: 0, verticalAmplitude: 0 },
    fly: { itemSwayAmplitude: 0, horizontalAmplitude: 0, verticalAmplitude: 0 },
};

// phase velocity is pure-linear in actual horizontal speed, capped to
// BOB_PHASE_VEL_MAX so a fall/dash can't spin legs unbounded. one bob
// cycle (2π) advances at this rate, driving the walk clip's phase-driven
// playback and the footstep crossing detector together. no floor, a
// slow wall-slide at 0.5 m/s genuinely animates as slow leg swing
// instead of snapping to a "walking" cadence. camera bob and footstep
// SFX still gate on `grounded` separately (via 'fall'/'idle' amplitude
// targets and the explicit grounded check in the crossing detector).
const BOB_PHASE_VEL_PER_M_S = 2.5;
const BOB_PHASE_VEL_MAX = 22;
// extra phase-rate multiplier while sprinting, sprint speed alone only
// nudges the phase ~30% above walk, which doesn't land as visibly different
// for the camera/leg cycle. boosting it makes sprint feel epic.
const BOB_PHASE_VEL_SPRINT_FACTOR = 1.1;
// swim stroke is slower than walking gait, halves the bob/footstep cadence
// so the swim SFX doesn't fire at a frantic walking pace and the camera bob
// reads as a longer, lazier breath cycle.
const BOB_PHASE_VEL_LIQUID_FACTOR = 0.5;

function getBobStatus(cc: CharacterControllerTrait, horizontalSpeed: number): BobStatus {
    if (cc.input.noclip) return 'fly';
    if (!cc.state.grounded) return 'fall';
    if (horizontalSpeed > 0) {
        if (cc.input.sprint) return 'run';
        if (cc.input.crouch) return 'crouch';
        return 'walk';
    }
    return 'idle';
}

function updateCharacterBob(cc: CharacterControllerTrait, registry: BlockRegistry, dt: number): void {
    const state = cc.state;
    const config = cc.config;
    const input = cc.input;

    // visual crouch catch-up (presentation only, the collider is binary,
    // `isCrouchShape`). eased per-frame here so the head/waist drop reads
    // smooth instead of stepping at the tick rate.
    state.crouchAmount += ((input.crouch ? 1 : 0) - state.crouchAmount) * (1 - Math.exp(-config.crouchLerpRate * dt));

    // snapshot prev phase BEFORE any mutation this tick. consumers
    // (footstep bucket detector in CharacterTrait) compare bobPhase vs
    // previousBobPhase to detect crossings; if we snapshotted at end-of-
    // tick the two would always be equal at tick boundaries and the
    // crossing would never fire.
    state.previousBobPhase = state.bobPhase;

    // re-anchor edges, jam phase to the bottom of the cycle (sin = −1)
    // so downstream crossing detectors fire on the transition and continue
    // evenly spaced. checked here (and not on the footstep side) because
    // the re-anchor mutates bobPhase + bobSineValue together. fires on:
    //   - landing (grounded ↑), first ground footstep is on-cadence.
    //   - feet-enter liquid (groundBlockState transitions into a liquid
    //     voxel), first swim stroke fires on-cadence right after splash.
    // liquid status is derived from `groundBlockState` + the block
    // registry flags rather than the controller's `inLiquidStable` field,
    // so remote characters (who don't run `sampleEnvironment`) re-anchor
    // off the same synced signal as the owner.
    const footBlockState = state.groundBlockState;
    const prevFootBlockState = state.previousGroundBlockState;
    const liquidNow = footBlockState !== 0 && (registry.flags[footBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
    const liquidPrev = prevFootBlockState !== 0 && (registry.flags[prevFootBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
    if ((state.grounded && !state.previousGrounded) || (liquidNow && !liquidPrev)) {
        state.bobPhase = (3 * Math.PI) / 2;
    }

    // phase velocity: linear map of actual horizontal speed → angular
    // rate. driven by velocity (not wish-speed) so running into a wall
    // stops the leg cycle, and ungated on grounded so airborne motion
    // still animates the legs.
    const vx = state.velocity[0];
    const vz = state.velocity[2];
    const horizontalSpeed = Math.sqrt(vx * vx + vz * vz);

    let phaseVelocity = horizontalSpeed * BOB_PHASE_VEL_PER_M_S;
    if (input.sprint && state.grounded) phaseVelocity *= BOB_PHASE_VEL_SPRINT_FACTOR;
    if (state.inLiquidStable) phaseVelocity *= BOB_PHASE_VEL_LIQUID_FACTOR;
    if (phaseVelocity > BOB_PHASE_VEL_MAX) phaseVelocity = BOB_PHASE_VEL_MAX;

    if (phaseVelocity > 0) {
        state.bobPhase += phaseVelocity * dt;
    } else {
        // not actually moving → reset so the next walk starts at the
        // foot-plant. covers both true idle and wall-stop (input held
        // but vel = 0).
        state.bobPhase = 0;
    }

    const bobSineValue = Math.sin(state.bobPhase);
    const bobSineValueHalf = Math.sin(state.bobPhase * 0.5);

    state.bobSineValuePrevious = state.bobSineValue;
    state.bobSineValue = bobSineValue;

    const status = getBobStatus(cc, horizontalSpeed);
    const targets = CHARACTER_BOB_STATE_VALUES[status];

    if (phaseVelocity > 0) {
        const ampK = dt * config.bobAmpLerpRate;
        const offK = dt * config.bobOffsetLerpRate;

        // item sway: always lerped (both amp and offset) so the weapon
        // overlay glides into the bob rather than snapping.
        state.bobItemSwayAmplitude += (targets.itemSwayAmplitude - state.bobItemSwayAmplitude) * ampK;
        if (state.bobItemSwayAmplitude > 0) {
            const arcValue = Math.cos(state.bobPhase * 0.5);
            const dipValue = bobSineValueHalf * bobSineValueHalf; // sin² (= |sin|²)
            state.bobItemSwayOffsetX += (arcValue * state.bobItemSwayAmplitude - state.bobItemSwayOffsetX) * offK;
            state.bobItemSwayOffsetY += (-dipValue * state.bobItemSwayAmplitude - state.bobItemSwayOffsetY) * offK;
        }

        // camera lateral: sin(phase/2), written directly so it tracks
        // the sinusoid exactly. amplitude itself lerps to the target.
        state.bobLateralAmplitude += (targets.horizontalAmplitude - state.bobLateralAmplitude) * ampK;
        if (state.bobLateralAmplitude > 0) {
            state.bobOffsetX = bobSineValueHalf * state.bobLateralAmplitude;
        }

        // camera vertical: sin(phase), full sine, dips and rises.
        state.bobVerticalAmplitude += (targets.verticalAmplitude - state.bobVerticalAmplitude) * ampK;
        if (state.bobVerticalAmplitude > 0) {
            state.bobOffsetY = bobSineValue * state.bobVerticalAmplitude;
        }
    } else {
        // settle: amplitudes hard-zero, all offsets lerp home so the
        // camera + item glide back to neutral instead of snapping.
        state.bobItemSwayAmplitude = 0;
        state.bobLateralAmplitude = 0;
        state.bobVerticalAmplitude = 0;

        const resetK = dt * config.bobOffsetLerpRate;
        state.bobOffsetX += -state.bobOffsetX * resetK;
        state.bobOffsetY += -state.bobOffsetY * resetK;
        state.bobItemSwayOffsetX += -state.bobItemSwayOffsetX * resetK;
        state.bobItemSwayOffsetY += -state.bobItemSwayOffsetY * resetK;
    }

    state.previousGrounded = state.grounded;
    state.previousGroundBlockState = state.groundBlockState;
}

// ── look helpers ──────────────────────────────────────────────────────
//
// pitch is the spherical phi (π/2 = horizon, 0 = look down, π = look up,
// matching the camera convention in player-controller).

function writeLook(cc: CharacterControllerTrait, theta: number, phi: number | undefined): void {
    cc.input.look[1] = theta;
    if (phi !== undefined) cc.input.look[2] = phi;
}

/** point a character at yaw (+ optional pitch). leaves pitch alone if omitted. */
export function setCharacterLook(cc: CharacterControllerTrait, yaw: number, pitch?: number): void {
    writeLook(cc, yaw, pitch);
}

/** orient a character at a world target. uses the character's current world
 *  position + its `state.eyeHeight` as the look origin so head-height entities
 *  aim through their eyes, not their feet. */
export function setCharacterLookAt(cc: CharacterControllerTrait, transform: TransformTrait, target: Vec3): void {
    const p = getWorldPosition(transform);
    const dx = target[0] - p[0];
    const dy = target[1] - (p[1] + cc.state.eyeHeight);
    const dz = target[2] - p[2];
    const horiz = Math.sqrt(dx * dx + dz * dz);
    // engine forward = (-sinθsinφ, -cosφ, -cosθsinφ); θ from horiz components,
    // φ from vertical. -dy because phi=0 means "look down".
    writeLook(cc, Math.atan2(-dx, -dz), Math.atan2(horiz, -dy));
}

/** world-space forward unit vector from a `[_, yaw, pitch]` look spherical.
 *  engine convention: yaw=0, pitch=π/2 → -Z (matches the camera + glTF).
 *  module-private: only `updateCharacterView` needs it. */
function lookForward(look: Vec3, out: Vec3): Vec3 {
    const theta = look[1];
    const phi = look[2];
    const sinPhi = Math.sin(phi);
    out[0] = -Math.sin(theta) * sinPhi;
    out[1] = -Math.cos(phi);
    out[2] = -Math.cos(theta) * sinPhi;
    return out;
}

/** refresh `cc.view` (eye origin + look direction) and the eased `state.eyeHeight`,
 *  so any script can read the character's look ray from its eyes. eye height eases
 *  `eyeHeight`↔`crouchEyeHeight` by `crouchAmount` (climbing keeps full height).
 *  run per-frame for every character, players and npcs alike. */
function updateCharacterView(cc: CharacterControllerTrait, transform: TransformTrait): void {
    const config = cc.config;
    const state = cc.state;
    const crouchT = state.isClimbing ? 0 : state.crouchAmount;
    state.eyeHeight = config.eyeHeight + (config.crouchEyeHeight - config.eyeHeight) * crouchT;
    const p = getWorldPosition(transform);
    vec3.set(cc.view.origin, p[0], p[1] + state.eyeHeight + state.stepSmoothOffset, p[2]);
    lookForward(cc.input.look, cc.view.direction);
}

// ── script ────────────────────────────────────────────────────────────

script(
    CharacterControllerTrait,
    'controller',
    (ctx) => {
        // play playerNode transform, used as the server-side discovery anchor.
        // when ctx.node is the editorNode (client-realm, server has no copy),
        // physics-driven body motion never reaches the server's view of the
        // player, so voxel chunk streaming stays anchored at spawn. mirror
        // position into the play node each tick so its owner-synced
        // TransformTrait reaches the server. (see fly-controller for the
        // full rationale.)
        const room = ctx.client?.room ?? null;

        onInit(ctx, () => {
            setInterpolation(ctx.node, true);
        });

        onDispose(ctx, () => {
            disposeVCC(ctx.trait, ctx.physics);
            setInterpolation(ctx.node, false);
        });

        onTick(ctx, ({ delta }) => {
            const cc = ctx.trait;
            const transform = getTrait(ctx.node, TransformTrait);
            if (!transform) return;
            // every side constructs + maintains the VCC inner body so that
            // contact events, raycasts, and shape queries against the
            // character work uniformly. only the owner steps the sim.
            ensureVCC(cc, transform, ctx.physics);
            updateCrouchShape(cc, ctx.physics);
            syncCollisionFilter(cc);

            if (isOwner(ctx, ctx.node)) {
                // noclip drives motion from the writer (PlayerController);
                // the sim bails so it doesn't fight the displacement.
                if (cc.input.noclip) return;
                tickCharacterController(cc, transform, ctx.physics, delta);
                if (room && ctx.node !== room.playerNode) {
                    const pt = getTrait(room.playerNode, TransformTrait);
                    if (pt) setWorldPosition(pt, getWorldPosition(transform));
                }
            } else {
                // non-owner: drive the inner body from the replicated
                // transform so sensor triggers and queries observe the
                // character at the right place.
                const p = getWorldPosition(transform);
                vcc.setPosition(ctx.physics.rigid.world, cc.state.vcc!, p[0], p[1], p[2]);
            }
        });

        // bob runs on every client (not just the owner) so remote viewers
        // can drive animations off bobPhase / bobOffsetX/Y. inputs are
        // synced `velocity` + `grounded`. presentation-layer consumers
        // (CharacterTrait footsteps, anims, particles) read the resulting
        // signals on their own onFrame.
        onFrame(ctx, ({ delta }) => {
            updateCharacterBob(ctx.trait, ctx.blocks, delta);
            // refresh the look ray (eye origin + direction) after the bob/crouch ease, so
            // every character, players and npcs, exposes `cc.view` for aiming/firing.
            const transform = getTrait(ctx.node, TransformTrait);
            if (transform) updateCharacterView(ctx.trait, transform);
        });
    },
    { editor: true },
);
