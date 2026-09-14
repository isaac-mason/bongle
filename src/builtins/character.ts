type CharacterConfig = {
    /** false opts out of the engine's procedural arm/leg swing + head-look. */
    animation: boolean;
    footstepVolume: number;
    ownFootstepVolume: number;
    landingVolume: number;
    ownLandingVolume: number;
    landingCooldown: number;
    /** distance (m) at which the active camera starts screen-door-fading this character; 0 disables. */
    proximityFadeRange: number;
    /** script-driven fade, 0 solid to 1 gone; max()'d with the proximity + loading fades. */
    dither: number;
};

type CharacterState = {
    /** fact of what's mounted, paired with `def.modelId` (intent); the reconciler converges them. */
    modelId: string | null;
    /** resolved ModelDef for `state.modelId`, null iff `modelId` is null. */
    modelDef: ModelDef | null;
    breathPhase: number;
    /** eased turn lean (rad, Z roll on the waist); see `TURN_BANK_PER_RAD_S`. */
    turnBank: number;
    previousVisualYaw: number;
    turnBankInit: boolean;
    /** peak downward speed (m/s) since leaving the ground; landing reaction's strength input. */
    fallSpeedPeak: number;
    /** landing spring position: 1 is full-strength impact, negative is rebound past rest. */
    landingSquash: number;
    landingSpringVelocity: number;
    /** decaying visual offset absorbing the sim's `bobPhase` re-anchors; see `BOB_PHASE_CATCHUP_RATE`. wrapped to +-pi. */
    bobPhaseCatchUp: number;
    previousRawBobPhase: number;
    /** the two idle head-drift clocks (rad); see `IDLE_DRIFT_YAW_RATE`. */
    idleDriftYawPhase: number;
    idleDriftPitchPhase: number;
    /** seconds until the next idle weight shift; counts down only while idle. */
    idleBreakDelay: number;
    /** progress through the current weight shift, 0 to 1; 1 means none running. */
    idleBreakProgress: number;
    /** which hip the next shift moves onto, +-1, alternating. */
    idleBreakSide: number;
    headDriftYaw: number;
    headDriftPitch: number;
    landingCooldownRemaining: number;
    /** screen-door dither while the target model hasn't hydrated; decays to 0 once it lands. */
    loadingDither: number;
    /** last dither value stamped across the rig meshes; null skips the subtree walk when unchanged. */
    appliedDither: number | null;
    /** last visibility stamped across the rig meshes; null skips the subtree walk when unchanged. */
    appliedVisible: boolean | null;

    /** the current model's mesh/visual nodes added by `mountRig`; `unmountRig` removes exactly these. */
    modelNodes: Set<Node>;
    /** this character's live canonical rig nodes, by name; rebuilt by `ensureCanonicalBones` on every mount. */
    nodes: RigNodes;
};

type RigNodeName = (typeof RIG_6BONE_PERSISTENT_NODES)[number];
/** fixed-shape name -> node map for the enforced skeleton, so per-frame reads stay monomorphic. */
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
import { OrbitControllerTrait } from './orbit-controller';
import { PlayerControllerTrait } from './player-controller';
import { TransformTrait } from './transform';
import { WorldTrait } from './world';

const TAU = Math.PI * 2;
// sin(bobPhase) trough: the foot-plant moment in this controller's bob convention.
const FOOT_PHASE = (3 * Math.PI) / 2;

const HEAD_PITCH_LIMIT_RAD = degreesToRadians(60);

const _qHeadYaw = quat.create();
const _qHeadPitch = quat.create();
const _qHead = quat.create();
const _HEAD_UP: Vec3 = [0, 1, 0];
const _HEAD_RIGHT: Vec3 = [1, 0, 0];

/** extract yaw (rad) from a pure-Y-axis quaternion written as `setAxisAngle(UP, theta)`. */
function bodyYawFromQuat(q: Quat): number {
    return 2 * Math.atan2(q[1], q[3]);
}

const FOOTSTEP_DUST_COUNT = 3;

// pulses the screen-door dither between two values while the target model hasn't hydrated, decaying to 0 once it lands.
const LOAD_PULSE_RATE_HZ = 1.2;
const LOAD_PULSE_MIN = 0.35;
const LOAD_PULSE_MAX = 0.75;
const LOAD_DECAY_PER_SEC = 12;

// half-range of per-step random detune in cents, so consecutive footsteps don't read as a metronome.
const FOOTSTEP_DETUNE_CENTS = 400;

// peak swing angle (rad) reached at `horizSpeed >= SWING_SPEED_REF`; lerps linearly to 0 below that.
const LEG_SWING_MAX_RAD = degreesToRadians(55);
const ARM_SWING_MAX_RAD = degreesToRadians(35);
const SWING_SPEED_REF = 5.0;

// waist weight-shift, on the same sin(bobPhase) clock as the limb swing.
const WAIST_BOB_DROP = 0.03;
const WAIST_STRIDE_ROLL_RAD = degreesToRadians(1);

// scales limb swing reach from 1 at walk speed to this at sprint speed.
const SPRINT_SWING_BOOST = 1.15;

// hip drop: the vertical currency crouch, gait settle and landing reaction share; clamped per leg so effects can't invert it.
const MAX_HIP_DROP_FRACTION = 0.5;
const MIN_HIP_HEIGHT = 0.05;

// chest lean/heave/fold, applied to `body` so head and arms (waist siblings) stay out of it.
const CHEST_WALK_LEAN_RAD = degreesToRadians(3);
const CHEST_RUN_LEAN_RAD = degreesToRadians(9);
const CHEST_HEAVE_RAD = degreesToRadians(4);
const CHEST_HEAVE_PHASE_LAG = 0.5;
const CHEST_LANDING_FOLD_RAD = degreesToRadians(14);
const LANDING_ARM_RAISE_RAD = degreesToRadians(16);

// landing reaction: strength ramps from MIN to REF; enters the damped spring as a velocity impulse so the hips swing back up.
const LANDING_MIN_SPEED = 2;
const LANDING_REF_SPEED = 9;
const LANDING_DROP = 0.22;
const LANDING_SPRING_STIFFNESS = 120;
const LANDING_SPRING_DAMPING = 13;
const LANDING_SPRING_IMPULSE = 22;
const LANDING_SPRING_MAX_VELOCITY = 33;
const LANDING_REBOUND_LIMIT = -0.35;
const LANDING_SPRING_MAX_STEP = 1 / 30;

// the controller re-anchors bobPhase hard; presentation absorbs the jump into a decaying visual offset instead of teleporting.
const BOB_PHASE_MAX_ADVANCE_PER_S = 25;
const BOB_PHASE_CATCHUP_RATE = 9;

// idle life: breathing, a two-clock head drift and a periodic weight shift, all scaled by `idle` so they fade as it moves.
const IDLE_SPEED_REF = 0.6;
const IDLE_BREATH_RISE = 0.009;
const IDLE_BREATH_CHEST_RAD = degreesToRadians(1.2);
const IDLE_DRIFT_YAW_RATE = 0.55;
const IDLE_DRIFT_PITCH_RATE = 0.34;
const IDLE_HEAD_DRIFT_YAW_RAD = degreesToRadians(3);
const IDLE_HEAD_DRIFT_PITCH_RAD = degreesToRadians(1.5);
// per-character random delay so a crowd doesn't shift weight in unison; client-local, unsynced.
const IDLE_BREAK_MIN_DELAY = 4;
const IDLE_BREAK_MAX_DELAY = 9;
const IDLE_BREAK_DURATION = 1.6;
const IDLE_SHIFT_ROLL_RAD = degreesToRadians(2.5);
const IDLE_SHIFT_LATERAL = 0.02;

/** scratch for `updateIdleLife`'s outputs, reused per call rather than allocated per frame. */
const _idlePose = { rise: 0, chestPitch: 0, roll: 0, lateral: 0 };

function nextIdleBreakDelay(): number {
    return IDLE_BREAK_MIN_DELAY + Math.random() * (IDLE_BREAK_MAX_DELAY - IDLE_BREAK_MIN_DELAY);
}

// turn bank: body yaw rate -> outward-to-inward lean, derived from the visual body yaw so owner and remote read the same signal.
const TURN_BANK_PER_RAD_S = 0.1;
const TURN_BANK_MAX_RAD = degreesToRadians(10);
const TURN_BANK_RESPONSE_RATE = 8;

// arm outward tilt (Z roll): small baseline + slow breathing sine, both widening while sprinting.
const ARM_IDLE_TILT_RAD = degreesToRadians(4);
const ARM_IDLE_BREATH_RAD = degreesToRadians(2);
const ARM_RUN_TILT_RAD = degreesToRadians(12);
const ARM_RUN_BREATH_RAD = degreesToRadians(5);
const ARM_BREATH_RATE = Math.PI;

// sneak pose: `body` pitches backward, `waist` drops in Y, giving a knee-bend illusion without knee joints.
const CROUCH_BODY_PITCH_RAD = -degreesToRadians(28);
const CROUCH_WAIST_DROP = 0.15;
// backward shift counter-balancing the forward tuck so the silhouette reads as a squat, not a face-plant.
const CROUCH_WAIST_BACK = 0.1;

const _waistPos: Vec3 = [0, 0, 0];
const _legPos: Vec3 = [0, 0, 0];
const _legScale: Vec3 = [1, 1, 1];

// X is the fore/aft swing axis (pitch), Z is the outward-tilt axis (roll); composed as Qx*Qz.
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
        /** model id to mount, any id registered with `Resources`; reassign at runtime to swap the avatar. */
        modelId: BUILTIN_BASE_AVATAR_ID as string,

        /** rig contract of the currently-set avatar, so scripts can branch on rig type. */
        rigType: RIG_TYPE_6BONE as string,

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
            // random from frame zero, so characters that spawn together don't shift weight in lockstep on the first cycle.
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
            appliedVisible: null,
            modelNodes: new Set(),
            nodes: emptyRigNodes(),
        }),
    },
    { icon: 'kit:icon:character', persist: false },
);

export type CharacterTrait = TraitType<typeof CharacterTrait>;

/** clients pair the synced id with a client-side .glb url via `Resources.setModel`. */
export const modelIdSync = sync(CharacterTrait, 'model-id', {
    schema: pack.string(),
    pack: (t) => t.modelId,
    unpack: (v, t) => {
        t.modelId = v;
    },
    dirty: dirty.explicit(),
});

// two queries so the rig loads/presents for any CharacterTrait while controller-driven concerns stay gated on also having one.
script(
    WorldTrait,
    'character',
    (ctx) => {
        const qChars = query(ctx, [CharacterTrait, TransformTrait]);
        const qLocomotion = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);

        onFrame(ctx, ({ delta }) => {
            const subjectNode = getSubject(ctx);
            // active camera pose off its transform, for the proximity fade below; null when no camera is wired.
            const cameraNode = getCamera(ctx);
            const cameraTransform = cameraNode ? getTrait(cameraNode, TransformTrait) : null;
            const cameraPos = cameraTransform ? getWorldPosition(cameraTransform) : null;

            for (const [t, transform] of qChars.matches) {
                const node = t._node;

                // reconcile against LIVE payload state, not a cached fact, so a play/stop payload wipe self-heals next frame.
                const handle = getModel(ctx, t.modelId);
                if (handle) {
                    if (t.state.modelDef !== handle) {
                        unmountRig(node);
                        mountRig(node, handle);
                        t.state.modelId = t.modelId;
                        t.state.modelDef = handle;
                    }
                } else {
                    ensureModel(ctx, t.modelId);
                    if (t.state.modelDef !== baseAvatar.def) {
                        unmountRig(node);
                        mountRig(node, baseAvatar.def);
                        t.state.modelId = BUILTIN_BASE_AVATAR_ID;
                        t.state.modelDef = baseAvatar.def;
                    }
                }

                // the rest is client-only presentation; the server only needs the reconciler above.
                if (!env.client) continue;
                if (t.state.modelId === null) continue;

                const loading = t.state.modelId !== t.modelId;
                if (loading) {
                    const pulse = 0.5 + 0.5 * Math.sin((performance.now() * (TAU * LOAD_PULSE_RATE_HZ)) / 1000);
                    t.state.loadingDither = LOAD_PULSE_MIN + (LOAD_PULSE_MAX - LOAD_PULSE_MIN) * pulse;
                } else if (t.state.loadingDither > 0) {
                    t.state.loadingDither = Math.max(0, t.state.loadingDither - delta * LOAD_DECAY_PER_SEC);
                }

                // compute the dither first, only walk the rig subtree when it changes.
                let finalDither: number;
                let visible: boolean;
                if (subjectNode === node) {
                    const pc = getTrait(node, PlayerControllerTrait);
                    const hide =
                        (pc && pc.config.perspective === 'first') ||
                        !!getTrait(node, OrbitControllerTrait) ||
                        !!getTrait(node, FlyControllerTrait);
                    visible = !hide;
                    // proximity fade never applies to own body; a script-driven dither still composes in.
                    finalDither = hide ? 0 : Math.max(t.state.loadingDither, t.config.dither);
                } else {
                    visible = true;
                    const range = t.config.proximityFadeRange;
                    let proxDither = 0;
                    if (range > 0 && cameraPos) {
                        // measured against character center (~1m above the foot transform).
                        const dx = cameraPos[0] - transform.position[0];
                        const dy = cameraPos[1] - (transform.position[1] + 1);
                        const dz = cameraPos[2] - transform.position[2];
                        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        proxDither = dist >= range ? 0 : 1 - dist / range;
                    }
                    finalDither = Math.max(proxDither, t.state.loadingDither, t.config.dither);
                }
                // both stamp every mesh under the rig, so only walk when one of them actually moves.
                if (t.state.appliedDither !== finalDither || t.state.appliedVisible !== visible) {
                    setCharacterSubtreeVisuals(node, finalDither, visible);
                    t.state.appliedDither = finalDither;
                    t.state.appliedVisible = visible;
                }
            }

            // locomotion + footstep sfx are client-only and depend on the rig being mounted above.
            if (!env.client) return;

            for (const [t, cc, transform] of qLocomotion.matches) {
                if (t.state.modelId === null) continue;
                const node = t._node;

                updateHeadOrientation(t, cc, transform);
                if (t.config.animation) driveProceduralLocomotion(t, cc, transform, delta);

                if (t.state.landingCooldownRemaining > 0) {
                    t.state.landingCooldownRemaining -= delta;
                }

                const owner = isOwner(ctx, node);
                const footBlockState = cc.state.groundBlockState;
                const prevFootBlockState = cc.state.previousGroundBlockState;
                const inLiquid = footBlockState !== 0 && (ctx.blocks.flags[footBlockState]! & BLOCK_FLAG_LIQUID) !== 0;
                const wasInLiquid = prevFootBlockState !== 0 && (ctx.blocks.flags[prevFootBlockState]! & BLOCK_FLAG_LIQUID) !== 0;

                // one-shot on the bob-tick feet first resolve to a liquid voxel, independent of cadence.
                if (inLiquid && !wasInLiquid) {
                    emitSplash(ctx, cc, transform, owner, owner ? t.config.ownLandingVolume : t.config.landingVolume);
                }

                // liquid entry already played emitSplash; resting at a pool bottom flickers `grounded` and would retrigger landings.
                const isLanding = cc.state.grounded && !cc.state.previousGrounded && !inLiquid;

                if (isLanding && t.state.landingCooldownRemaining <= 0) {
                    emitFootstep(ctx, cc, transform, owner, owner ? t.config.ownLandingVolume : t.config.landingVolume, true);
                    t.state.landingCooldownRemaining = t.config.landingCooldown;
                } else if (cc.state.grounded || inLiquid) {
                    // phase-bucket crossing: each boundary is sin(bobPhase) = -1, one footstep per 2*pi of phase.
                    const idx = Math.floor((cc.state.bobPhase - FOOT_PHASE) / TAU);
                    const prevIdx = Math.floor((cc.state.previousBobPhase - FOOT_PHASE) / TAU);
                    if (idx > prevIdx) {
                        emitFootstep(
                            ctx,
                            cc,
                            transform,
                            owner,
                            owner ? t.config.ownFootstepVolume : t.config.footstepVolume,
                            cc.state.grounded && cc.input.sprint,
                        );
                    }
                }
            }
        });
    },
    { editor: true },
);

/** rotates the canonical `head` bone to point at `cc.look`, composed as Ryaw*Rpitch so pitch stays in the head's local frame. */
function updateHeadOrientation(t: CharacterTrait, cc: CharacterControllerTrait, transform: TransformTrait): void {
    const headBone = t.state.nodes.head;
    if (!headBone) return;
    const headTransform = getTrait(headBone, TransformTrait);
    if (!headTransform) return;

    // visual (alpha-sampled) yaw, not sim yaw, so it doesn't wobble between fixed ticks.
    const bodyYaw = bodyYawFromQuat(getVisualWorldQuaternion(transform));
    // idle drift affects only the visual head; cc.view (the aim ray) is unmoved.
    const headYaw = wrapPi(cc.input.look[1] - bodyYaw) + t.state.headDriftYaw;
    let pitch = cc.input.look[2] - Math.PI / 2 - cc.state.crouchAmount * CROUCH_BODY_PITCH_RAD + t.state.headDriftPitch;
    if (pitch < -HEAD_PITCH_LIMIT_RAD) pitch = -HEAD_PITCH_LIMIT_RAD;
    else if (pitch > HEAD_PITCH_LIMIT_RAD) pitch = HEAD_PITCH_LIMIT_RAD;

    quat.setAxisAngle(_qHeadYaw, _HEAD_UP, headYaw);
    quat.setAxisAngle(_qHeadPitch, _HEAD_RIGHT, pitch);
    quat.multiply(_qHead, _qHeadYaw, _qHeadPitch);
    setQuaternion(headTransform, _qHead);
}

/** synchronously mounts the placeholder rig if `node` has none yet, so a server `onJoin` hook sees bones immediately. */
export function ensureCharacterRig(node: Node): void {
    const t = getTrait(node, CharacterTrait);
    if (!t || t.state.modelId !== null) return;
    mountRig(node, baseAvatar.def);
    t.state.modelId = BUILTIN_BASE_AVATAR_ID;
    t.state.modelDef = baseAvatar.def;
}

// rig lifecycle is bound to the trait's: onDispose fires on removeTrait and node destroy but not on reparent.
script(CharacterTrait, 'rig', (ctx) => {
    const node = ctx.node;
    onInit(ctx, () => ensureCharacterRig(node));
    onDispose(ctx, () => unmountRig(node));
});

/** adds `CharacterTrait` and mounts its rig immediately, so bones are available the same tick for attaching held items. */
export function addCharacter(node: Node, props?: TraitProps<CharacterTrait>): CharacterTrait {
    const t = addTrait(node, CharacterTrait, props);
    ensureCharacterRig(node);
    return t;
}

// canonical 6bone parenting: waist hangs off playerNode; body/head/arms nest under waist; legs are their own roots.
const RIG_6BONE_PARENT_OF: Record<string, string | null> = {
    waist: null,
    leg_left: null,
    leg_right: null,
    body: 'waist',
    head: 'waist',
    arm_left: 'waist',
    arm_right: 'waist',
    hand_left: 'arm_left',
    hand_right: 'arm_right',
    back: 'body',
};

// the enforced skeleton: bones + attach sockets, built once by `ensureCanonicalBones`, reused across model swaps, never dropped.
const RIG_6BONE_PERSISTENT_NODES = [...RIG_6BONE_REQUIRED_NODES, ...RIG_6BONE_ATTACH_NODES];

// held items sit perpendicular to the arm; authored sockets keep their own rotation instead.
const HAND_GRIP_ROTATION = quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(90));

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
    // parents always exist by the time their children attach, RIG_6BONE_PARENT_OF is acyclic; skip already-parented nodes.
    for (const name of RIG_6BONE_PERSISTENT_NODES) {
        const node = byName.get(name)!;
        if (node.parent) continue;
        const parentName = RIG_6BONE_PARENT_OF[name];
        const parent = parentName === null ? playerNode : byName.get(parentName)!;
        addChild(parent, node);
    }

    // publish here (not lazily) so the cache can't outlive the rig it describes; avoids a findByName DFS per frame.
    const character = getTrait(playerNode, CharacterTrait);
    if (character) {
        const nodes = character.state.nodes;
        for (const name of RIG_6BONE_PERSISTENT_NODES) nodes[name] = byName.get(name) ?? null;
    }
}

/** derives an unauthored attach socket's local rest position from its parent bone's mesh geometry. */
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
    return socket === RIG_6BONE_BACK ? [cx, cy, maxZ] : [cx, minY, cz];
}

/** installs/re-installs a model's rig under `playerNode`; caller must call `unmountRig` first if a different rig is mounted. */
function mountRig(playerNode: Node, def: ModelDef): void {
    const loadedRoot = def.scene;
    if (!loadedRoot) return;

    ensureCanonicalBones(playerNode);

    // a server-owned rig's meshes arrive via replication, so a client must not clone them here (that would double-mount).
    const localAuthority = env.server || isLocalNode(playerNode);

    const canonical = new Set<string>(RIG_6BONE_PERSISTENT_NODES);
    // ownership by node identity, not name, so unmountRig drops exactly these and leaves runtime attachments (gear) alone.
    const modelNodes = getTrait(playerNode, CharacterTrait)?.state.modelNodes;

    const visit = (loaded: Node, placeholder: Node | null): void => {
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
                // placeholder is flat, so this resolves regardless of the loaded tree's shape.
                const phChild = findByName(playerNode, childName);
                visit(loadedChild, phChild);
                continue;
            }
            // mesh/decorative bone: clone under the last-matched placeholder bone, or playerNode for a synthetic multi-root wrapper.
            if (!localAuthority) continue;
            const parent = placeholder ?? playerNode;
            const fresh = cloneNode(loadedChild);
            addChild(parent, fresh);
            modelNodes?.add(fresh);
        }
    };

    // if the loaded root itself is canonical, match it; otherwise it's a synthetic/decorative wrapper, recurse into its children.
    const rootName = loadedRoot.name ?? '';
    const rootPlaceholder = canonical.has(rootName) ? findByName(playerNode, rootName) : null;
    visit(loadedRoot, rootPlaceholder);

    // drive any attach socket the model didn't author from its parent bone's geometry.
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
        if (socket !== RIG_6BONE_BACK) setQuaternion(socketTransform, HAND_GRIP_ROTATION);
    }

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);

    // freshly added meshes carry the MeshTrait defaults; drop the cache so the next presentation pass re-walks.
    const character = getTrait(playerNode, CharacterTrait);
    if (character) {
        character.state.appliedDither = null;
        character.state.appliedVisible = null;
    }
}

/** resets each canonical bone's TRS to identity and removes exactly the nodes recorded in `state.modelNodes`. */
function unmountRig(playerNode: Node): void {
    const canonical = new Set<string>(RIG_6BONE_PERSISTENT_NODES);
    const modelNodes = getTrait(playerNode, CharacterTrait)?.state.modelNodes;

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
                // destroyNode (not removeChild) so the removal replicates as `node_destroyed`, else clients show a base/loaded mix.
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

    modelNodes?.clear();

    const animator = getTrait(playerNode, AnimatorTrait);
    if (animator) Animation.invalidateRig(animator);
}

/** per-frame procedural locomotion: arm/leg swing, waist weight-shift, hip drop, chest lean/heave/fold and idle life. */
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

    // sprintSpeed <= walkSpeed (sprint disabled) makes excess 0 rather than dividing by zero.
    const speedRange = cc.config.sprintSpeed - cc.config.walkSpeed;
    const sprintExcess = speedRange > 0 ? Math.min(Math.max((horizSpeed - cc.config.walkSpeed) / speedRange, 0), 1) : 0;
    const reach = amp * (1 + (SPRINT_SWING_BOOST - 1) * sprintExcess);

    const bobPhase = updateVisualBobPhase(t, cc, delta);
    const bobSine = Math.sin(bobPhase);
    const swing = bobSine * reach;

    // breath advances on its own clock (mustn't stall while standing still), feeds idle + arm tilt.
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

    // crouch lean rides `waist`, so one tilt leans the whole upper body while the legs (separate roots) stay planted.
    applyLimb(nodes.waist, crouchAmount * CROUCH_BODY_PITCH_RAD, strideRoll + turnBank + _idlePose.roll);
    applyWaistOffset(t, crouchAmount, hipDrop, _idlePose.lateral);

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

    // legs carry the hip drop themselves (position + Y scale) so the squat compresses instead of the torso sinking through them.
    const restNodes = t.state.modelDef?.nodes;
    applyLegPose(nodes.leg_left, restNodes?.leg_left, hipDrop, swing * LEG_SWING_MAX_RAD);
    applyLegPose(nodes.leg_right, restNodes?.leg_right, hipDrop, -swing * LEG_SWING_MAX_RAD);
    // arms counter-swing fore/aft, tilt outward; the landing raise is symmetric and rides on top.
    const armRaise = landing * LANDING_ARM_RAISE_RAD;
    applyLimb(nodes.arm_left, -swing * ARM_SWING_MAX_RAD + armRaise, -tiltOut);
    applyLimb(nodes.arm_right, swing * ARM_SWING_MAX_RAD + armRaise, tiltOut);
}

/** eased turn lean (rad, positive = lean left), from differencing the visual body yaw frame to frame; `amp` gates it on movement. */
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

/** visual bob phase: sim phase plus a decaying offset absorbing the controller's hard re-anchors. */
function updateVisualBobPhase(t: CharacterTrait, cc: CharacterControllerTrait, delta: number): number {
    const state = t.state;
    const rawPhase = cc.state.bobPhase;
    const advance = rawPhase - state.previousRawBobPhase;
    if (advance < 0 || advance > BOB_PHASE_MAX_ADVANCE_PER_S * delta) {
        // hold the visual phase, let the offset decay to 0; wrapped since the swing is 2*pi-periodic.
        state.bobPhaseCatchUp = wrapPi(state.previousRawBobPhase + state.bobPhaseCatchUp - rawPhase);
    }
    state.previousRawBobPhase = rawPhase;
    state.bobPhaseCatchUp *= Math.exp(-BOB_PHASE_CATCHUP_RATE * delta);
    return rawPhase + state.bobPhaseCatchUp;
}

/** advances the idle clocks and fills `_idlePose` with breathing, weight shift and head drift, all scaled by `idle`. */
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

/** tracks the fall, then springs on touchdown; returns the compression, 1 at a full-strength impact, negative on rebound past rest. */
function updateLandingSpring(t: CharacterTrait, cc: CharacterControllerTrait, delta: number): number {
    const state = t.state;

    if (cc.state.grounded) {
        if (!cc.state.previousGrounded && state.fallSpeedPeak > LANDING_MIN_SPEED) {
            const strength = Math.min((state.fallSpeedPeak - LANDING_MIN_SPEED) / (LANDING_REF_SPEED - LANDING_MIN_SPEED), 1);
            // impulses add (a landing mid-recovery deepens rather than restarts), capped so repeated touchdowns can't stack.
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

/** poses one leg: rotation, plus the hip drop as a position sink and a matching Y compression that keeps the foot planted. */
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

/** one writer for the waist's position, sinking it by `hipDrop`, sliding by `lateral`, and shifting back by the crouch amount. */
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

    // same ceiling the legs clamp to, so the pelvis can't sink past the legs carrying it.
    const restHeight = restTransform.position[1];
    const maxDrop = restHeight > 0 ? restHeight * MAX_HIP_DROP_FRACTION : hipDrop;
    _waistPos[0] = restTransform.position[0] + lateral;
    _waistPos[1] = restHeight - (hipDrop < maxDrop ? hipDrop : maxDrop);
    _waistPos[2] = restTransform.position[2] + crouchAmount * CROUCH_WAIST_BACK;
    setPosition(waistTransform, _waistPos);
}

/** resolves the foot-sample block, plays SFX, conditionally emits dust. */
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

/** one-shot on the feet-enter-liquid edge: plays the liquid block's footstep clips at landing volume and spawns droplets. */
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

/** small droplet burst on liquid entry, reusing the per-block `dust` variants with splashier tuning than the footstep puff. */
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

/** small dust puff burst at the character's feet, from the resolved block's `particles.dust`. */
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

/** walks the playerNode subtree and stamps `dither` and `visible` onto every MeshTrait. */
function setCharacterSubtreeVisuals(root: Node, dither: number, visible: boolean): void {
    const mesh = getTrait(root, MeshTrait);
    if (mesh) {
        mesh.dither = dither;
        mesh.visible = visible;
    }
    for (const child of root.children) {
        setCharacterSubtreeVisuals(child, dither, visible);
    }
}
