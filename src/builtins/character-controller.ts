import type { RigidBody } from 'crashcat';
import { rigidBody } from 'crashcat';
import type { Quat, Spherical, Vec3 } from 'math';
import { degreesToRadians, quat, vec2, vec3 } from 'math';
import { pack } from '../api/pack';
import { COLLISION_GROUP_CHARACTERS, exceptGroups, type Physics } from '../api/physics';
import { getTrait } from '../api/scene-tree';
import { isOwner, onDispose, onFrame, onInit, onTick } from '../api/scripts';
import type { TraitType } from '../api/traits';
import { getWorldPosition, setInterpolation, setQuaternion, setWorldPosition } from '../api/transforms';
import { wrapPi } from '../core/math/angles';
import { pushVccRigidContact, pushVccVoxelContact } from '../core/physics/physics';
import * as vcc from '../core/physics/vcc/vcc';
import { script, sync, trait } from '../core/registry';
import {
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_SNEAK_GUARD,
    type Blocks,
    SHAPE_AABBS,
} from '../core/voxels/block-registry';
import { getBlockState, type Voxels } from '../core/voxels/voxels';
import { TransformTrait } from './transform';

// box character, feet at y=0; crouch swaps the inner shape via vcc.resize, binary off the synced input, not the visual ease.

const _forward = vec3.create();
const _right = vec3.create();
const _movementDir = vec3.create();
const _newVel = vec3.create();
const _horizVel = vec3.create();
const _identityQuat: Quat = [0, 0, 0, 1];
const _bodyYawAxis: Vec3 = [0, 1, 0];
const _bodyYawQuat = quat.create();

// scratch state for the reusable vcc contact listener, set from the trait before each vcc.move().
type VccListenerState = {
    /** character is intentionally moving this tick (gates preventSlide). */
    isIntentional: boolean;
    /** block-state-id -> restitution table, for voxel bounce lookups. */
    blockRestitution: Float32Array | null;
    physics: Physics | null;
    /** output: set when the listener applies a bounce this move; the tick then clears `grounded`. */
    bounced: boolean;
};

const _vccListenerState: VccListenerState = {
    isIntentional: false,
    blockRestitution: null,
    physics: null,
    bounced: false,
};

// minimum approach speed (m/s) into a surface to bounce, so a decaying bounce settles once below this.
const BOUNCE_MIN_SPEED = 1.0;

// reflects a contact into a bounce along its normal; contactNormal points into the surface, tangential component untouched.
function applyContactBounce(
    contactNormal: Vec3,
    characterVelocity: Vec3,
    ioCharacterVelocity: Vec3,
    restitution: number,
): boolean {
    if (restitution <= 0) return false;
    const approach =
        characterVelocity[0] * contactNormal[0] +
        characterVelocity[1] * contactNormal[1] +
        characterVelocity[2] * contactNormal[2];
    if (approach <= BOUNCE_MIN_SPEED) return false;
    const currentNormalSpeed =
        ioCharacterVelocity[0] * contactNormal[0] +
        ioCharacterVelocity[1] * contactNormal[1] +
        ioCharacterVelocity[2] * contactNormal[2];
    const delta = -restitution * approach - currentNormalSpeed;
    ioCharacterVelocity[0] += delta * contactNormal[0];
    ioCharacterVelocity[1] += delta * contactNormal[1];
    ioCharacterVelocity[2] += delta * contactNormal[2];
    return true;
}

// max body-vs-head yaw difference (rad); past this the body snaps to keep the neck within a plausible twist.
const BODY_YAW_LIMIT_RAD = degreesToRadians(40);

// min horizontal speed (m/s) above which velocity drives the body-yaw target; below it the target falls back to look-yaw.
const BODY_VEL_YAW_MIN_SPEED = 0.5;

// exponential-approach rate (1/s) for body yaw chasing its target; half-life = ln(2)/rate.
const BODY_YAW_RESPONSE_RATE = 12;

// half-angle (rad) of the cone behind the player where velocity-driven body yaw is suppressed; precomputed cosine.
const BODY_YAW_BACK_CONE_RAD = degreesToRadians(30);
const BODY_YAW_BACK_CONE_COS = Math.cos(BODY_YAW_BACK_CONE_RAD);

// replays the contact so a fast body that passed through the character's kinematic inner body still fires ContactsTrait.
function recordVccRigidContact(vccInstance: vcc.VCC, body: RigidBody, contactPosition: Vec3, contactNormal: Vec3): void {
    if (_vccListenerState.physics === null) return;
    pushVccRigidContact(
        _vccListenerState.physics,
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
        recordVccRigidContact(vccInstance, body, contactPosition, contactNormal);
    },
    onContactPersisted(vccInstance, body, _subShapeId, contactPosition, contactNormal) {
        recordVccRigidContact(vccInstance, body, contactPosition, contactNormal);
    },
    onContactSolve(
        _vccInstance,
        _body,
        _stateId,
        _contactPos,
        contactNormal,
        contactVelocity,
        characterVelocity,
        ioCharacterVelocity,
    ) {
        // voxel contact: restitution from the block table; slide + ground state are already resolved, only bounce is left.
        if (_stateId !== 0) {
            const restitution = _vccListenerState.blockRestitution?.[_stateId] ?? 0;
            if (applyContactBounce(contactNormal, characterVelocity, ioCharacterVelocity, restitution)) {
                _vccListenerState.bounced = true;
            }
            return;
        }

        // body contact: bounce reads the rigid body's own restitution.
        const inAir = _vccInstance.groundState === vcc.GROUND_STATE_IN_AIR;
        const contactVelSq =
            contactVelocity[0] * contactVelocity[0] +
            contactVelocity[1] * contactVelocity[1] +
            contactVelocity[2] * contactVelocity[2];

        // contactNormal points into the surface, so the upward component is -contactNormal[1].
        const isSteep = -contactNormal[1] < _vccInstance.cosMaxSlopeAngle;

        const preventSlide = !inAir && !_vccListenerState.isIntentional && contactVelSq < 0.1 && !isSteep;

        if (preventSlide) {
            ioCharacterVelocity[0] = 0;
            ioCharacterVelocity[2] = 0;
            return;
        }

        // cancel upward velocity into a ceiling.
        if (contactNormal[1] < -0.3 && characterVelocity[1] > 0) {
            ioCharacterVelocity[1] = 0;
        }

        if (applyContactBounce(contactNormal, characterVelocity, ioCharacterVelocity, _body?.restitution ?? 0)) {
            _vccListenerState.bounced = true;
        }
    },
};

type CharacterControllerInput = {
    /** [r, theta, phi] spherical; theta = yaw around +Y (drives wish direction), phi = polar from +Y, r unused. */
    look: Spherical;
    /** [strafe, forward] in [-1, 1]. */
    move: ReturnType<typeof vec2.create>;
    jump: boolean;
    sprint: boolean;
    crouch: boolean;
    /** when true, sim is bypassed and the writer must move the transform. */
    noclip: boolean;
    /** userland override forcing climb mode regardless of voxel sampling. */
    climbOverride: boolean;
};

type CharacterControllerConfig = {
    /** inner-body half-extents for the standing and crouching posture shapes. */
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
    /** ground drag rate (1/s); block friction multiplies this. */
    groundDragRate: number;
    /** drag rate in air (1/s); softer than ground so sprint-jumpers keep more liftoff momentum. */
    airDragRate: number;
    /** wish-direction acceleration in air (m/s^2), much smaller than ground accel. */
    airAccel: number;
    /** horizontal kick (m/s) added along the wish direction at jump takeoff while sprinting. */
    sprintJumpImpulse: number;
    /** vertical climb speed when in a climbable block / climbOverride. */
    climbSpeed: number;
    /** slow downward speed on a ladder with no input. */
    climbDescendSpeed: number;
    swimSpeed: number;
    /** horizontal accel cap while swimming. */
    swimAccel: number;
    /** downward "gravity" in a liquid, much smaller than `gravity`. */
    liquidSink: number;
    /** drag coefficient applied per tick as v *= exp(-liquidDrag * viscosity * dt). */
    liquidDrag: number;
    /** lerp factor for the per-state amplitude ramp, applied as dt*rate per frame. */
    bobAmpLerpRate: number;
    /** lerp factor for the bobOffsetX/Y settle on stop and the item-sway offset. */
    bobOffsetLerpRate: number;
    /** ease rate (1/s) for `state.crouchAmount`. */
    crouchLerpRate: number;
    /** standing eye height (m above feet). */
    eyeHeight: number;
    /** crouched eye height (m); `state.eyeHeight` lerps between the two by `crouchAmount`. */
    crouchEyeHeight: number;
    /** collision group bitfield for the character's inner body + sweeps. */
    collisionGroups: number;
    /** which collision groups the character collides with; defaults to everything except `COLLISION_GROUP_CHARACTERS`. */
    collisionMask: number;
};

type CharacterControllerState = {
    velocity: Vec3;
    grounded: boolean;
    /** state id of the voxel at the character's foot sample; 0 when neither grounded nor in liquid. owner-written, synced uint16. */
    groundBlockState: number;
    /** body-bob phase (radians); jammed to 3*pi/2 on landing so footsteps stay evenly spaced. */
    bobPhase: number;
    /** `sin(bobPhase)` cached so the footstep system can detect crossings without recomputing. */
    bobSineValue: number;
    bobSineValuePrevious: number;
    /** eased peak amplitudes (units) for lateral (sin(phase/2)), vertical (sin(phase)) and item-sway bob axes. */
    bobLateralAmplitude: number;
    bobVerticalAmplitude: number;
    bobItemSwayAmplitude: number;
    /** head-displacement scalars (units); cameras add these along yaw-aligned right and world up. */
    bobOffsetX: number;
    bobOffsetY: number;
    /** item-sway scalars for held-tool transforms, added along the weapon's local axes. */
    bobItemSwayOffsetX: number;
    bobItemSwayOffsetY: number;

    /** lazy vcc handle (owner-only). */
    vcc: vcc.VCC | undefined;
    isIntentionalMovement: boolean;
    /** downward camera offset written by the sim after stair step-ups; camera decays it in onFrame. */
    stepSmoothOffset: number;
    /** state id of the voxel directly under feet, 0 = air. */
    standingStateId: number;
    isClimbing: boolean;
    /** sampled per-tick with hysteresis (enter low, exit high). */
    inLiquid: boolean;
    /** feet-deep liquid sample, no hysteresis; owner-only, remote sides derive it from `groundBlockState` instead. */
    inLiquidStable: boolean;
    /** 0..1 viscosity of the liquid we're in (0 if not in liquid). */
    liquidViscosity: number;
    /** state id sampled at body-mid; owner-only scratch carried into `groundBlockState` post-move. */
    feetStateId: number;
    /** crouch-guard anchor voxel coords; undefined when not engaged. */
    sneakNode: [number, number, number] | undefined;
    /** crouch-guard anchor's union AABB in voxel-local [0,1]^3 coords. */
    sneakNodeBbTop: [number, number, number, number, number, number] | undefined;
    /** true when the anchor engaged because we're crouched on a ladder. */
    sneakOnLadder: boolean;
    /** previous tick's wishvel got truncated by a wall; drives ladder climb-on-wall-push, one-tick lag. */
    horizontalCollision: boolean;
    /** previous tick's `grounded`, for landing-edge detection. */
    previousGrounded: boolean;
    previousBobPhase: number;
    /** previous bob-tick's `groundBlockState`, for spotting foot-sample transitions. */
    previousGroundBlockState: number;
    /** persistent body yaw (rad around +Y), clamped within `BODY_YAW_LIMIT_RAD` of `input.look[1]`. */
    bodyYaw: number;
    /** lazy init flag: first owner tick snaps `bodyYaw` to `look[1]`. */
    bodyYawInit: boolean;
    /** binary sim posture on `state.vcc.innerBody`, owner-only; not synced. */
    isCrouchShape: boolean;
    /** visual-only 0..1 crouch, eased toward `input.crouch` at `config.crouchLerpRate`. */
    crouchAmount: number;
    /** current eased eye height (m), lerped `eyeHeight`<->`crouchEyeHeight` by `crouchAmount`. */
    eyeHeight: number;
};

/** the character's look ray this frame: eye `origin` (world space) plus unit `direction` from `input.look`. */
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
            airDragRate: 0.85,
            airAccel: 13,
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
    { icon: 'kit:icon:controller', persist: false },
);

export type CharacterControllerTrait = TraitType<typeof CharacterControllerTrait>;

// only theta + phi sync over the wire; r is unused.
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

// exponential drag (v *= exp(-rate*dt)) plus wishDir*accel*dt, with no dot product against current velocity.

function applyHorizontalDrag(vel: Vec3, dragRate: number, dt: number): void {
    const k = Math.exp(-dragRate * dt);
    vel[0] *= k;
    vel[2] *= k;
}

function applyGroundWishAccel(vel: Vec3, wishDir: Vec3, dragRate: number, wishSpeed: number, dt: number): void {
    // accel = dragRate*wishSpeed makes the equilibrium speed exactly wishSpeed*wishDir.
    if (wishSpeed <= 0) return;
    const a = dragRate * wishSpeed * dt;
    vel[0] += wishDir[0] * a;
    vel[2] += wishDir[2] * a;
}

function applyAirWishAccel(vel: Vec3, wishDir: Vec3, airAccel: number, wishSpeed: number, dt: number): void {
    if (wishSpeed <= 0) return;
    // projected air accel: only adds speed up to wishSpeed along wishDir; perpendicular momentum is untouched.
    const currentSpeed = vel[0] * wishDir[0] + vel[2] * wishDir[2];
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(airAccel * dt, addSpeed);
    vel[0] += wishDir[0] * accelSpeed;
    vel[2] += wishDir[2] * accelSpeed;
}

function sampleEnvironment(cc: CharacterControllerTrait, voxels: Voxels): void {
    const registry: Blocks = voxels.registry;
    const flags = registry.flags;
    const viscosity = registry.liquidViscosity;
    const state = cc.state;

    const feet = state.vcc!.position;
    const fx = Math.floor(feet[0]);
    const fz = Math.floor(feet[2]);
    const headY = Math.floor(feet[1] + 1.5);
    const belowY = Math.floor(feet[1] - 0.05);

    // sub-voxel hysteresis: enter when the +0.5 sample is wet, exit only once the +0.1 sample is also dry.
    const liquidProbeY = Math.floor(feet[1] + (state.inLiquid ? 0.1 : 0.5));
    const liquidProbeState = getBlockState(voxels, fx, liquidProbeY, fz);
    const liquidProbeIsLiquid = flags[liquidProbeState]! & BLOCK_FLAG_LIQUID;

    const headState = getBlockState(voxels, fx, headY, fz);
    const feetStateForFlags = getBlockState(voxels, fx, Math.floor(feet[1] + 0.1), fz);
    const belowState = getBlockState(voxels, fx, belowY, fz);
    const climbable = (flags[headState]! | flags[feetStateForFlags]! | flags[belowState]!) & BLOCK_FLAG_CLIMBABLE;
    state.isClimbing = cc.input.climbOverride || climbable !== 0;

    state.liquidViscosity = liquidProbeIsLiquid ? viscosity[liquidProbeState]! : 0;
    state.inLiquid = liquidProbeIsLiquid !== 0;
    state.inLiquidStable = (flags[feetStateForFlags]! & BLOCK_FLAG_LIQUID) !== 0;
    state.feetStateId = feetStateForFlags;

    // standing voxel for friction + sneak-guard: prefer vcc.contacts (robust to overhangs), falling back to the column probe.
    const standingFromContacts = deriveStandingStateFromContacts(state.vcc!);
    state.standingStateId = standingFromContacts !== 0 ? standingFromContacts : getBlockState(voxels, fx, belowY, fz);
}

/** picks the most up-facing voxel contact above the slope threshold, 0 if none. */
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

/** reports the passable cells (liquids, plants, hazards) the character swept through this tick as `solid: false` voxel contacts. */
function pushSweptOverlapContacts(physics: Physics, v: vcc.VCC): void {
    const crossed = v.sweep.crossed;
    for (let i = 0; i < crossed.count; i++) {
        const cell = crossed.cells[i]!;
        pushVccVoxelContact(
            physics,
            v.innerBody.id,
            cell.x,
            cell.y,
            cell.z,
            cell.stateId,
            -1, // subAabbIndex: whole cell
            cell.x + 0.5, // point: cell center (no real contact surface)
            cell.y + 0.5,
            cell.z + 0.5,
            0, // normal: up, arbitrary for an overlap
            1,
            0,
            cell.depth, // how far the box got into the block's shape
            false, // solid: passable/liquid cell, not a collision
        );
    }
}

// crouch edge guard: after the solver runs, clamp position to the previous anchor's union AABB and pull smoothly toward its top.

// player center can extend this fraction of the body's half-extents past the anchor's AABB edge before the clamp engages.
const SNEAK_HALF_EXTENT_FACTOR = 0.98;

// max XZ distance from player center to a candidate anchor's AABB center during the 3x3 search.
const SNEAK_ALLOWED_RANGE = 0.55;

// cells above the candidate anchor voxel that must be non-collidable for the guard to engage; bump for taller shapes.
const SNEAK_HEADROOM_CELLS = 2;

// y_diff threshold below which the XZ clamp + Y pull engage.
const SNEAK_STEPHEIGHT = 0.6;

// Y pull rate and per-frame bias, spreading the pull across ~3 frames on a 0.5 step rise.
const SNEAK_Y_PULL_RATE = 22;
const SNEAK_Y_PULL_BIAS = 0.01;

/** union AABB of a block's collision shape in voxel-local [0,1]^3 coords; cube and non-AABB shapes return the unit box. */
function blockUnionAabbLocal(registry: Blocks, stateId: number): [number, number, number, number, number, number] {
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

/** `SNEAK_HEADROOM_CELLS` cells above `(x, fy, z)` must be non-collidable. */
function hasSneakHeadroom(voxels: Voxels, x: number, fy: number, z: number): boolean {
    const flags = voxels.registry.flags;
    for (let y = 1; y <= SNEAK_HEADROOM_CELLS; y++) {
        if ((flags[getBlockState(voxels, x, fy + y, z)]! & BLOCK_FLAG_COLLISION) !== 0) return false;
    }
    return true;
}

/** whether the band the standing hull adds above the crouch hull is clear of collidable voxels; conservative for partial blocks. */
function canStandUp(cc: CharacterControllerTrait, voxels: Voxels): boolean {
    const v = cc.state.vcc;
    if (!v) return true;
    const flags = voxels.registry.flags;
    const feet = v.position;
    const half = cc.config.halfExtents;
    // only the slice above the crouch top is new, so scan [crouchTop, standingTop).
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

// 3x3 neighbor offsets for the sneak anchor search: center voxel first, then 4 cardinals, then 4 diagonals.
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

/** finds a sneak-guardable voxel within the 3x3 around the foot voxel and stores it on `state.sneakNode`/`sneakNodeBbTop`. */
function updateSneakNode(cc: CharacterControllerTrait, voxels: Voxels): boolean {
    const state = cc.state;
    const v = state.vcc!;
    const registry = voxels.registry;
    const flags = registry.flags;

    // finds the foot voxel even on a non-cube surface; if a previous anchor is engaged, use its local-coord top minus 0.02.
    let positionYMod = 0.02;
    if (state.sneakNodeBbTop) positionYMod = state.sneakNodeBbTop[4] - 0.02;

    const cx = Math.floor(v.position[0]);
    const cz = Math.floor(v.position[2]);
    const fy = Math.floor(v.position[1] - positionYMod);

    // keep the current sneak node if its coords still match and it's still guardable.
    if (state.sneakNode && state.sneakNode[0] === cx && state.sneakNode[1] === fy && state.sneakNode[2] === cz) {
        const stateId = getBlockState(voxels, cx, fy, cz);
        if ((flags[stateId]! & BLOCK_FLAG_SNEAK_GUARD) !== 0) return true;
    }

    // 3x3 search around (cx, fy, cz), picking the guardable candidate nearest the player's XZ.
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

/** applies the post-collision sneak clamp + smoothened Y pull using the anchor from the start of this tick. */
function applySneakClamp(cc: CharacterControllerTrait, dt: number): boolean {
    const state = cc.state;
    const v = state.vcc!;
    const node = state.sneakNode;
    const box = state.sneakNodeBbTop;
    if (!node || !box) return false;

    // ladder grip: XZ clamp to the ladder voxel's unit footprint, no Y pull.
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

    // floor sneak: bmin/bmax in world space = node + box's local min/max edges.
    const bminX = node[0] + box[0];
    const bmaxX = node[0] + box[3];
    const bminZ = node[2] + box[2];
    const bmaxZ = node[2] + box[5];
    const bmaxY = node[1] + box[4];
    const sneakMaxX = v.halfExtents[0] * SNEAK_HALF_EXTENT_FACTOR;
    const sneakMaxZ = v.halfExtents[2] * SNEAK_HALF_EXTENT_FACTOR;
    const yDiff = bmaxY - v.position[1];

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

    // smoothened Y pull: player below anchor top and not jumping up, so a stair-step pulls up gradually instead of snapping.
    if (yDiff > 0 && v.linearVelocity[1] <= 0 && yDiff < SNEAK_STEPHEIGHT) {
        const newY = v.position[1] + yDiff * dt * SNEAK_Y_PULL_RATE + SNEAK_Y_PULL_BIAS;
        v.position[1] = Math.min(newY, bmaxY);
        v.linearVelocity[1] = 0;
    }

    return true;
}

/** post-move sneak processing: clamp using the previous anchor, then re-pick it; returns true if the player should be force-grounded. */
function processCrouchGuard(cc: CharacterControllerTrait, voxels: Voxels, dt: number): boolean {
    const state = cc.state;
    const input = cc.input;
    const v = state.vcc!;

    const onLadder = state.isClimbing && input.crouch;
    const couldSneakFloor = input.crouch && !state.inLiquid && !input.noclip && !input.jump && !state.isClimbing;
    const engaged = onLadder || couldSneakFloor;

    if (!engaged) {
        state.sneakNode = undefined;
        state.sneakNodeBbTop = undefined;
        state.sneakOnLadder = false;
        return false;
    }

    const hadAnchor = applySneakClamp(cc, dt);

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
        return false;
    }

    state.sneakOnLadder = false;
    updateSneakNode(cc, voxels);
    return hadAnchor;
}

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
    // attributes contact events on the VCC inner body back to this node for ContactsTrait fan-out.
    physics.rigid.bodyToNode.set(cc.state.vcc.innerBodyId, cc._node.id);
}

function disposeVCC(cc: CharacterControllerTrait, physics: Physics): void {
    if (!cc.state.vcc) return;
    physics.rigid.bodyToNode.delete(cc.state.vcc.innerBodyId);
    vcc.destroy(physics.rigid.world, cc.state.vcc);
    cc.state.vcc = undefined;
}

// runs on every side, binary and driven by the already-synced `input.crouch`, so the inner body stays coherent everywhere.
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

// pushes the config's collision group/mask onto the live VCC every tick so a runtime script change takes effect live.
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

function tickCharacterController(cc: CharacterControllerTrait, transform: TransformTrait, physics: Physics, dt: number): void {
    const input = cc.input;
    const config = cc.config;
    const state = cc.state;
    const v = state.vcc!;
    const voxels = physics.rigid.terrainShape.voxels;
    const world = physics.rigid.world;
    const aabbWorld = physics.aabb;
    const registry = voxels.registry;

    // sync vcc position up-front so sampleEnvironment sees the current feet location.
    const feet = getWorldPosition(transform);
    v.position[0] = feet[0];
    v.position[1] = feet[1];
    v.position[2] = feet[2];

    sampleEnvironment(cc, voxels);
    const isClimbing = state.isClimbing;
    const inLiquid = state.inLiquid;

    const theta = input.look[1];
    const strafe = input.move[0];
    const fwd = input.move[1];
    vec3.set(_forward, -Math.sin(theta), 0, -Math.cos(theta));
    vec3.set(_right, Math.cos(theta), 0, -Math.sin(theta));
    vec3.set(_movementDir, _forward[0] * fwd + _right[0] * strafe, 0, _forward[2] * fwd + _right[2] * strafe);
    const movLen = vec3.length(_movementDir);
    state.isIntentionalMovement = movLen > 1e-6;
    if (state.isIntentionalMovement) vec3.scale(_movementDir, _movementDir, 1 / movLen);

    // clamp input magnitude to 1 so keyboard diagonals (movLen = sqrt(2)) don't exceed cardinal wishSpeed.
    const inputMag = movLen > 1 ? 1 : movLen;
    const wishSpeed = inputMag * (input.sprint ? config.sprintSpeed : input.crouch ? config.crouchSpeed : config.walkSpeed);
    const wasGrounded = state.grounded;
    // normal-mode jump only; climb/liquid consume the jump key for their own up-ascend.
    const wantsJump = input.jump && wasGrounded && !isClimbing && !inLiquid;

    vec3.copy(_newVel, state.velocity);
    const vertVel = _newVel[1];
    vec3.copy(_horizVel, _newVel);
    _horizVel[1] = 0;

    let newVert: number;
    if (isClimbing) {
        // ladder: crouch grabs on; jump or "pushed into a wall last tick" ascends; otherwise trickle down.
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
        // air-style additive accel; velocity is capped by the viscosity drag applied below.
        applyAirWishAccel(_horizVel, _movementDir, config.swimAccel, wishSpeed, dt);
        const drag = Math.exp(-config.liquidDrag * state.liquidViscosity * dt);
        _horizVel[0] *= drag;
        _horizVel[2] *= drag;
        newVert *= drag;
    } else {
        if (wantsJump) {
            newVert = config.jumpSpeed - config.gravity * dt;
            // sprint-jump kick along wishDir at takeoff.
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
            // air: steer momentum, don't add to it; total speed is clamped back to what you already had.
            applyHorizontalDrag(_horizVel, config.airDragRate, dt);
            const airSpeedCap = Math.max(Math.hypot(_horizVel[0], _horizVel[2]), wishSpeed);
            applyAirWishAccel(_horizVel, _movementDir, config.airAccel, wishSpeed, dt);
            const airSpeed = Math.hypot(_horizVel[0], _horizVel[2]);
            if (airSpeed > airSpeedCap) {
                const scale = airSpeedCap / airSpeed;
                _horizVel[0] *= scale;
                _horizVel[2] *= scale;
            }
        } else {
            // ground: add surface velocity, then drag + accel; block friction multiplies the drag rate.
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

    const startX = feet[0];
    const startZ = feet[2];

    _vccListenerState.isIntentional = state.isIntentionalMovement;
    _vccListenerState.blockRestitution = registry.restitution;
    _vccListenerState.bounced = false;
    _vccListenerState.physics = physics;

    vcc.move(world, voxels, aabbWorld, v, dt, _vccListener);

    // surface the VCC's own terrain contacts to the character node's ContactsTrait; the VCC sweeps voxels outside the solver.
    for (let i = 0; i < v.contacts.length; i++) {
        const c = v.contacts[i]!;
        if (c.stateId === 0 || !c.hadCollision || c.wasDiscarded) continue;
        pushVccVoxelContact(
            physics,
            v.innerBody.id,
            c.voxelX,
            c.voxelY,
            c.voxelZ,
            c.stateId,
            c.subAabbIndex,
            c.positionX,
            c.positionY,
            c.positionZ,
            c.surfaceNormalX,
            c.surfaceNormalY,
            c.surfaceNormalZ,
            c.overlapDepth,
            true, // solid: the VCC only sweeps collidable blocks
        );
    }

    let grounded = v.groundState === vcc.GROUND_STATE_ON_GROUND;

    // ladder climb-on-wall-push: project post-move displacement onto the raw wish direction; read by the climb branch next tick.
    const wishMag = wishSpeed * dt;
    if (state.isIntentionalMovement && wishMag > 1e-4) {
        const gotInDir = (v.position[0] - startX) * _movementDir[0] + (v.position[2] - startZ) * _movementDir[2];
        state.horizontalCollision = gotInDir < wishMag * 0.3;
    } else {
        state.horizontalCollision = false;
    }

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

    // surface the passable/liquid cells swept through this tick as solid: false voxel contacts, after stick/stairs.
    pushSweptOverlapContacts(physics, v);

    if (processCrouchGuard(cc, voxels, dt)) grounded = true;

    if (isClimbing) grounded = true;
    else if (inLiquid) grounded = false;

    // a bounce launches the character off the surface: read as airborne so next tick's vertical integration carries it.
    if (_vccListenerState.bounced) grounded = false;

    state.grounded = grounded;
    // foot-sample resolution for SFX + particles: real ground contact wins, else feet-in-liquid, else 0 (airborne).
    let footState = 0;
    if (grounded && v.groundVoxelStateId !== 0) footState = v.groundVoxelStateId;
    else if (state.inLiquidStable) footState = state.feetStateId;
    state.groundBlockState = footState;
    // horizontal velocity reflects the effective post-solve motion, since v.linearVelocity still carries the pre-collision request.
    const invDt = dt > 0 ? 1 / dt : 0;
    state.velocity[0] = (v.position[0] - startX) * invDt;
    state.velocity[1] = v.linearVelocity[1];
    state.velocity[2] = (v.position[2] - startZ) * invDt;

    feet[0] = v.position[0];
    feet[1] = v.position[1];
    feet[2] = v.position[2];
    setWorldPosition(transform, feet);

    // decoupled head/body yaw: body tracks velocity-direction yaw while moving, clamped within BODY_YAW_LIMIT_RAD of look[1].
    if (!state.bodyYawInit) {
        state.bodyYaw = input.look[1];
        state.bodyYawInit = true;
    }
    const bvx = state.velocity[0];
    const bvz = state.velocity[2];
    const bodyHorizSpeed = Math.sqrt(bvx * bvx + bvz * bvz);
    // target body yaw: stopped or inside the back-cone snaps to look-yaw; otherwise uses velocity-direction yaw, mirrored behind.
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
    // exponential approach toward target, taking the short way round the +-pi seam.
    const slewDelta = wrapPi(targetBodyYaw - state.bodyYaw);
    const k = 1 - Math.exp(-BODY_YAW_RESPONSE_RATE * dt);
    state.bodyYaw = wrapPi(state.bodyYaw + slewDelta * k);
    // safety net: even mid-slew, never let the body stray more than BODY_YAW_LIMIT_RAD from look.
    let bodyYawDelta = wrapPi(state.bodyYaw - input.look[1]);
    if (bodyYawDelta > BODY_YAW_LIMIT_RAD) bodyYawDelta = BODY_YAW_LIMIT_RAD;
    else if (bodyYawDelta < -BODY_YAW_LIMIT_RAD) bodyYawDelta = -BODY_YAW_LIMIT_RAD;
    state.bodyYaw = input.look[1] + bodyYawDelta;
    quat.setAxisAngle(_bodyYawQuat, _bodyYawAxis, state.bodyYaw);
    setQuaternion(transform, _bodyYawQuat);
}

// the writer (PlayerController or AI) supplies world-space velocity; this translates the transform and follows the inner body.
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

// integrates body-bob phase + per-axis amplitudes on every client, driven by inputs + actual velocity + grounded state.

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

// phase velocity is linear in actual horizontal speed, capped so a fall/dash can't spin legs unbounded.
const BOB_PHASE_VEL_PER_M_S = 2.5;
const BOB_PHASE_VEL_MAX = 22;
// extra phase-rate multiplier while sprinting.
const BOB_PHASE_VEL_SPRINT_FACTOR = 1.1;
// swim stroke is slower than walking gait, halving the bob/footstep cadence.
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

function updateCharacterBob(cc: CharacterControllerTrait, registry: Blocks, dt: number): void {
    const state = cc.state;
    const config = cc.config;
    const input = cc.input;

    // visual-only crouch catch-up (the collider is binary, `isCrouchShape`), eased so the head/waist drop reads smooth.
    state.crouchAmount += ((input.crouch ? 1 : 0) - state.crouchAmount) * (1 - Math.exp(-config.crouchLerpRate * dt));

    state.previousBobPhase = state.bobPhase;

    // re-anchor edges jam phase to the bottom of the cycle on landing or feet entering liquid, off the synced `groundBlockState`.
    const footBlockState = state.groundBlockState;
    const prevFootBlockState = state.previousGroundBlockState;
    const liquidNow = footBlockState !== 0 && (registry.flags[footBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
    const liquidPrev = prevFootBlockState !== 0 && (registry.flags[prevFootBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
    if ((state.grounded && !state.previousGrounded) || (liquidNow && !liquidPrev)) {
        state.bobPhase = (3 * Math.PI) / 2;
    }

    // driven by velocity (not wish-speed) so running into a wall stops the leg cycle; ungated on grounded.
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
        // not actually moving, reset so the next walk starts at the foot-plant.
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

        // item sway: always lerped (both amp and offset) so the weapon overlay glides into the bob rather than snapping.
        state.bobItemSwayAmplitude += (targets.itemSwayAmplitude - state.bobItemSwayAmplitude) * ampK;
        if (state.bobItemSwayAmplitude > 0) {
            const arcValue = Math.cos(state.bobPhase * 0.5);
            const dipValue = bobSineValueHalf * bobSineValueHalf;
            state.bobItemSwayOffsetX += (arcValue * state.bobItemSwayAmplitude - state.bobItemSwayOffsetX) * offK;
            state.bobItemSwayOffsetY += (-dipValue * state.bobItemSwayAmplitude - state.bobItemSwayOffsetY) * offK;
        }

        // camera lateral: sin(phase/2), written directly so it tracks the sinusoid exactly.
        state.bobLateralAmplitude += (targets.horizontalAmplitude - state.bobLateralAmplitude) * ampK;
        if (state.bobLateralAmplitude > 0) {
            state.bobOffsetX = bobSineValueHalf * state.bobLateralAmplitude;
        }

        state.bobVerticalAmplitude += (targets.verticalAmplitude - state.bobVerticalAmplitude) * ampK;
        if (state.bobVerticalAmplitude > 0) {
            state.bobOffsetY = bobSineValue * state.bobVerticalAmplitude;
        }
    } else {
        // settle: amplitudes hard-zero, all offsets lerp home instead of snapping.
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

// pitch is the spherical phi (pi/2 = horizon, 0 = look down, pi = look up), matching the camera convention in player-controller.
function writeLook(cc: CharacterControllerTrait, theta: number, phi: number | undefined): void {
    cc.input.look[1] = theta;
    if (phi !== undefined) cc.input.look[2] = phi;
}

/** point a character at yaw (+ optional pitch). leaves pitch alone if omitted. */
export function setCharacterLook(cc: CharacterControllerTrait, yaw: number, pitch?: number): void {
    writeLook(cc, yaw, pitch);
}

/** orient a character at a world target, using its `state.eyeHeight` as the look origin. */
export function setCharacterLookAt(cc: CharacterControllerTrait, transform: TransformTrait, target: Vec3): void {
    const p = getWorldPosition(transform);
    const dx = target[0] - p[0];
    const dy = target[1] - (p[1] + cc.state.eyeHeight);
    const dz = target[2] - p[2];
    const horiz = Math.sqrt(dx * dx + dz * dz);
    // -dy because phi=0 means "look down".
    writeLook(cc, Math.atan2(-dx, -dz), Math.atan2(horiz, -dy));
}

/** world-space forward unit vector from a `[_, yaw, pitch]` look spherical; yaw=0, pitch=pi/2 gives -Z. */
function lookForward(look: Vec3, out: Vec3): Vec3 {
    const theta = look[1];
    const phi = look[2];
    const sinPhi = Math.sin(phi);
    out[0] = -Math.sin(theta) * sinPhi;
    out[1] = -Math.cos(phi);
    out[2] = -Math.cos(theta) * sinPhi;
    return out;
}

/** refresh `cc.view` (eye origin + look direction) and the eased `state.eyeHeight`. */
function updateCharacterView(cc: CharacterControllerTrait, transform: TransformTrait): void {
    const config = cc.config;
    const state = cc.state;
    const crouchT = state.isClimbing ? 0 : state.crouchAmount;
    state.eyeHeight = config.eyeHeight + (config.crouchEyeHeight - config.eyeHeight) * crouchT;
    const p = getWorldPosition(transform);
    vec3.set(cc.view.origin, p[0], p[1] + state.eyeHeight + state.stepSmoothOffset, p[2]);
    lookForward(cc.input.look, cc.view.direction);
}

script(
    CharacterControllerTrait,
    'controller',
    (ctx) => {
        // mirror position into the play node each tick so its owner-synced TransformTrait reaches the server.
        const room = ctx.client?.room ?? null;

        onInit(ctx, () => {
            setInterpolation(ctx.node, true);
        });

        onDispose(ctx, () => {
            disposeVCC(ctx.trait, ctx.physics);
            setInterpolation(ctx.node, false);
        });

        onTick(ctx, ({ step }) => {
            const cc = ctx.trait;
            const transform = getTrait(ctx.node, TransformTrait);
            if (!transform) return;
            // every side maintains the VCC inner body so contacts/raycasts/queries work uniformly; only the owner steps the sim.
            ensureVCC(cc, transform, ctx.physics);
            updateCrouchShape(cc, ctx.physics);
            syncCollisionFilter(cc);

            if (isOwner(ctx, ctx.node)) {
                // noclip drives motion from the writer (PlayerController); the sim bails so it doesn't fight the displacement.
                if (cc.input.noclip) return;
                tickCharacterController(cc, transform, ctx.physics, step);
                if (room && ctx.node !== room.playerNode) {
                    const pt = getTrait(room.playerNode, TransformTrait);
                    if (pt) setWorldPosition(pt, getWorldPosition(transform));
                }
            } else {
                // non-owner: drive the inner body from the replicated transform so sensor triggers and queries stay accurate.
                const p = getWorldPosition(transform);
                vcc.setPosition(ctx.physics.rigid.world, cc.state.vcc!, p[0], p[1], p[2]);
            }
        });

        // bob runs on every client, not just the owner, so remote viewers can drive animations off bobPhase / bobOffsetX/Y.
        onFrame(ctx, ({ delta }) => {
            updateCharacterBob(ctx.trait, ctx.blocks, delta);
            // refresh the look ray after the bob/crouch ease so every character exposes `cc.view` for aiming/firing.
            const transform = getTrait(ctx.node, TransformTrait);
            if (transform) updateCharacterView(ctx.trait, transform);
        });
    },
    { editor: true },
);
