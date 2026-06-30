import { MaterialCombineMode, MotionQuality, MotionType, type RigidBody } from 'crashcat';

export { MaterialCombineMode, MotionQuality, MotionType } from 'crashcat';

import { type Vec3, vec3 } from 'mathcat';
import { pack } from '../api/pack';
import { prop, propToPack } from '../api/prop';
import { control, sync, syncRate, type TraitType, trait } from '../api/traits';

// observer-normalized contact lifecycle lives on `ContactsTrait` (see
// builtins/contacts.ts) and is driven by physics.ts fan-out.

/* ── shape defs ─────────────────────────────────────────────────── */

export const AutoShapeDef = prop.object({
    type: prop.literal('auto'),
    /** shape type to generate from model geometry (default: box) */
    shape: prop.enumeration(['box', 'sphere', 'capsule', 'hull', 'mesh']),
});

export const BoxShapeDef = prop.object({
    type: prop.literal('box'),
    halfExtents: prop.vec3(),
});

export const SphereShapeDef = prop.object({
    type: prop.literal('sphere'),
    radius: prop.number(),
});

export const TransformedShapeDef = prop.object({
    type: prop.literal('transformed'),
    shape: prop.union('type', [BoxShapeDef, SphereShapeDef]),
    position: prop.vec3(),
    quaternion: prop.quaternion(),
});

export const CompoundShapeDef = prop.object({
    type: prop.literal('compound'),
    shapes: prop.list(
        prop.object({
            shape: prop.union('type', [BoxShapeDef, SphereShapeDef]),
            position: prop.vec3(),
            quaternion: prop.quaternion(),
        }),
    ),
});

export const ShapeDef = prop.union('type', [AutoShapeDef, BoxShapeDef, SphereShapeDef, TransformedShapeDef, CompoundShapeDef]);

export type ShapeDef = prop.SchemaType<typeof ShapeDef>;

/* ── rigid body def ─────────────────────────────────────────────── */

/**
 * declarative body recipe. when the trait carries a `def`, the installer
 * builds + owns the body from it. matches the optional fields on crashcat's
 * `RigidBodySettings` so the editor / serialized scenes can drive the full
 * surface without ceremony.
 */
export const RigidBodyDef = prop.object({
    shape: ShapeDef,
    motionType: prop.optional(
        prop.enumeration([
            { label: 'static', value: MotionType.STATIC },
            { label: 'kinematic', value: MotionType.KINEMATIC },
            { label: 'dynamic', value: MotionType.DYNAMIC },
        ]),
    ),
    prediction: prop.optional(prop.boolean()),
    collisionGroups: prop.optional(prop.number()),
    collisionMask: prop.optional(prop.number()),
    friction: prop.optional(prop.number()),
    restitution: prop.optional(prop.number()),
    sensor: prop.optional(prop.boolean()),
    allowedDegreesOfFreedom: prop.optional(prop.number()),
    gravityFactor: prop.optional(prop.number()),
    linearDamping: prop.optional(prop.number()),
    angularDamping: prop.optional(prop.number()),
    maxLinearVelocity: prop.optional(prop.number()),
    maxAngularVelocity: prop.optional(prop.number()),
    mass: prop.optional(prop.number()),
    motionQuality: prop.optional(
        prop.enumeration([
            { label: 'discrete', value: MotionQuality.DISCRETE },
            { label: 'linear cast', value: MotionQuality.LINEAR_CAST },
        ]),
    ),
    allowSleeping: prop.optional(prop.boolean()),
    enhancedInternalEdgeRemoval: prop.optional(prop.boolean()),
    frictionCombineMode: prop.optional(
        prop.enumeration([
            { label: 'average', value: MaterialCombineMode.AVERAGE },
            { label: 'min', value: MaterialCombineMode.MIN },
            { label: 'multiply', value: MaterialCombineMode.MULTIPLY },
            { label: 'max', value: MaterialCombineMode.MAX },
        ]),
    ),
    restitutionCombineMode: prop.optional(
        prop.enumeration([
            { label: 'average', value: MaterialCombineMode.AVERAGE },
            { label: 'min', value: MaterialCombineMode.MIN },
            { label: 'multiply', value: MaterialCombineMode.MULTIPLY },
            { label: 'max', value: MaterialCombineMode.MAX },
        ]),
    ),
    collideKinematicVsNonDynamic: prop.optional(prop.boolean()),
});

export type RigidBodyDef = {
    shape: ShapeDef;
    motionType?: MotionType;
    collisionGroups?: number;
    collisionMask?: number;
    friction?: number;
    restitution?: number;
    sensor?: boolean;
    allowedDegreesOfFreedom?: number;
    gravityFactor?: number;
    linearDamping?: number;
    angularDamping?: number;
    maxLinearVelocity?: number;
    maxAngularVelocity?: number;
    mass?: number;
    motionQuality?: MotionQuality;
    allowSleeping?: boolean;
    enhancedInternalEdgeRemoval?: boolean;
    frictionCombineMode?: MaterialCombineMode;
    restitutionCombineMode?: MaterialCombineMode;
    collideKinematicVsNonDynamic?: boolean;
};

/* ── trait ───────────────────────────────────────────────────────── */

export const RigidBodyTrait = trait('rigidbody', {
    /**
     * declarative recipe. when set, the installer builds + owns the body
     * from this. ref-change at runtime → installer destroys the previous
     * installer-owned body and builds a new one. when null, the trait is
     * in adopt mode: a script assigns `body` directly.
     */
    def: null as RigidBodyDef | null,

    /**
     * the live crashcat body, either installer-built (from `def`) or
     * script-adopted. trait owns teardown either way: removed on dispose
     * unless the script nulls `body` first (escape hatch for bodies shared
     * across traits).
     */
    body: null as RigidBody | null,

    /**
     * intent, drives `effectiveMotionType` under authority/prediction
     * rules. seeded from `def.motionType` at install time when present;
     * otherwise defaults to DYNAMIC. user can reassign at runtime.
     */
    motionType: MotionType.DYNAMIC as MotionType,

    /**
     * if true, non-owner clients run dynamic locally for prediction. seeded
     * from `def.prediction` at install time when present.
     */
    prediction: true,

    /**
     * canonical velocity. pre-tick trait→body push + post-tick body→trait
     * pull. doubles as the pre-body inbox: network unpack writes here, and
     * the first pre-tick push after the body comes online applies the
     * buffered value.
     */
    linearVelocity: vec3.create() as Vec3,
    angularVelocity: vec3.create() as Vec3,
});

/** instance type for RigidBodyTrait */
export type RigidBodyTrait = TraitType<typeof RigidBodyTrait>;

/* ── controls (editor + persistence) ── */

control(RigidBodyTrait, 'def', {
    label: 'Rigid Body',
    schema: prop.nullable(RigidBodyDef),
    get: (t) => t.def,
    set: (t, v) => {
        t.def = (v ?? null) as RigidBodyDef | null;
    },
});

/* ── syncs (replication) ── */

const defSchema = propToPack(prop.nullable(RigidBodyDef));
if (!defSchema) throw new Error('RigidBodyDef has no packable schema');
sync(RigidBodyTrait, 'def', {
    schema: defSchema,
    pack: (t) => t.def,
    unpack: (v, t) => {
        t.def = (v ?? null) as RigidBodyDef | null;
    },
});

sync(RigidBodyTrait, 'motionType', {
    schema: pack.uint8(),
    pack: (t) => t.motionType,
    unpack: (v, t) => {
        t.motionType = v;
    },
});

sync(RigidBodyTrait, 'prediction', {
    schema: pack.boolean(),
    pack: (t) => t.prediction,
    unpack: (v, t) => {
        t.prediction = v;
    },
});

sync(RigidBodyTrait, 'linear-velocity', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.linearVelocity,
    unpack: (v, t) => {
        vec3.copy(t.linearVelocity, v as Vec3);
    },
    rate: syncRate.distance(0.1), // resting bodies go silent
});

sync(RigidBodyTrait, 'angular-velocity', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.angularVelocity,
    unpack: (v, t) => {
        vec3.copy(t.angularVelocity, v as Vec3);
    },
    rate: syncRate.distance(0.1), // resting bodies go silent
});
