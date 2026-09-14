import { MaterialCombineMode, MotionQuality, MotionType, type RigidBody } from 'crashcat';

export { MaterialCombineMode, MotionQuality, MotionType } from 'crashcat';

import { type Vec3, vec3 } from 'math';
import { pack } from '../api/pack';
import { prop, propToPack } from '../api/prop';
import { dirty, rate, type TraitType } from '../api/traits';
import { TRANSFORM_SEND_HZ } from '../core/clock';
import { control, sync, trait } from '../core/registry';

// observer-normalized contact lifecycle lives on `ContactsTrait` (see builtins/contacts.ts), driven by physics.ts fan-out.

export const AutoShapeDef = prop.object({
    type: prop.literal('auto'),
    /** shape type to generate from model geometry (default: box) */
    shape: prop.enumeration(['box', 'sphere', 'capsule', 'hull', 'mesh']),
});

/** a box or sphere in the body's frame; a nonzero `center` offsets it. */
export const ColliderShape = prop.union('type', [prop.box(), prop.sphere()]);

/** a collider placed by its own pose inside the body. */
export const TransformedShapeDef = prop.pose({ type: prop.literal('transformed'), shape: ColliderShape });

export const CompoundShapeDef = prop.object({
    type: prop.literal('compound'),
    shapes: prop.list(prop.pose({ shape: ColliderShape })),
});

export const ShapeDef = prop.union('type', [AutoShapeDef, prop.box(), prop.sphere(), TransformedShapeDef, CompoundShapeDef]);

export type ShapeDef = prop.SchemaType<typeof ShapeDef>;

/** declarative body recipe; when the trait carries a `def`, the installer builds + owns the body from it. */
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

export const RigidBodyTrait = trait(
    'rigidbody',
    {
        /** declarative recipe; when set, the installer builds + owns the body from this. Null puts the trait in adopt mode: a script assigns `body` directly. */
        def: null as RigidBodyDef | null,

        /** the live crashcat body, installer-built or script-adopted. Removed on dispose unless the script nulls `body` first (bodies shared across traits). */
        body: null as RigidBody | null,

        /** intent, drives `effectiveMotionType` under authority/prediction rules. Seeded from `def.motionType` at install time when present. */
        motionType: MotionType.DYNAMIC as MotionType,

        /** if true, non-owner clients run dynamic locally for prediction. Seeded from `def.prediction` at install time when present. */
        prediction: true,

        /** canonical linear velocity. */
        linearVelocity: vec3.create() as Vec3,

        /** canonical angular velocity. */
        angularVelocity: vec3.create() as Vec3,
    },
    { icon: 'kit:icon:body' },
);

export type RigidBodyTrait = TraitType<typeof RigidBodyTrait>;

control(RigidBodyTrait, 'def', {
    label: 'Rigid Body',
    schema: prop.nullable(RigidBodyDef),
    get: (t) => t.def,
    set: (t, v) => {
        t.def = (v ?? null) as RigidBodyDef | null;
    },
});

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
    authority: 'owner',
    dirty: dirty.diff(), // byte-stable when the body sleeps, silent
    rate: rate.hz(TRANSFORM_SEND_HZ), // matches the transform broadcast cadence
});

sync(RigidBodyTrait, 'angular-velocity', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.angularVelocity,
    unpack: (v, t) => {
        vec3.copy(t.angularVelocity, v as Vec3);
    },
    authority: 'owner',
    dirty: dirty.diff(), // byte-stable when the body sleeps, silent
    rate: rate.hz(TRANSFORM_SEND_HZ), // matches the transform broadcast cadence
});
