import { type Vec3, vec3 } from 'mathcat';
import { pack } from '../api/pack';
import { prop } from '../api/prop';
import { control, sync, syncRate, type TraitType, trait } from '../api/traits';
import * as AabbPhysics from '../core/physics/aabb-physics';
import { COLLISION_GROUP_NODES } from '../core/physics/crashcat';
import { BLOCK_FLAG_COLLISION } from '../core/voxels/block-registry';

// lightweight axis-aligned body trait. wraps an `AabbPhysics.Body` from the
// `AabbPhysics.World` and routes its contacts through `ContactsTrait` fan-out.
// for callers that need many bodies and don't want trait/node overhead, use
// the imperative `AabbPhysics.createBody(physics.aabb, ...)` API directly.

export const AabbBodyMotionType = AabbPhysics.MotionType;
export type AabbBodyMotionType = AabbPhysics.MotionType;

export const AabbBodyTrait = trait('aabbbody', {
    halfExtents: [0.5, 0.5, 0.5] as Vec3,

    motionType: AabbBodyMotionType.DYNAMIC as AabbBodyMotionType,

    mass: 1,

    prediction: true,

    linearVelocity: vec3.create(),

    gravityFactor: 1,

    collisionGroups: COLLISION_GROUP_NODES,

    collisionMask: 0xffffffff,

    voxelFlagsMask: BLOCK_FLAG_COLLISION,

    friction: 0.5,

    restitution: 0,

    sensor: false,

    pushable: false,

    rigidBodyImpostor: false,

    /** runtime: the live AabbPhysics.Body. always non-null after install. */
    body: null as unknown as AabbPhysics.Body,
});

export type AabbBodyTrait = TraitType<typeof AabbBodyTrait>;

/* ── controls (editor + persistence) ── */

control(AabbBodyTrait, 'halfExtents', {
    label: 'Half Extents',
    schema: prop.vec3(),
    get: (t) => t.halfExtents,
    set: (t, v) => {
        vec3.copy(t.halfExtents, v as Vec3);
    },
});

control(AabbBodyTrait, 'motionType', {
    label: 'Motion Type',
    schema: prop.enumeration([
        { label: 'static', value: AabbBodyMotionType.STATIC },
        { label: 'kinematic', value: AabbBodyMotionType.KINEMATIC },
        { label: 'dynamic', value: AabbBodyMotionType.DYNAMIC },
    ]),
    get: (t) => t.motionType,
    set: (t, v) => {
        t.motionType = v;
    },
});

control(AabbBodyTrait, 'mass', {
    label: 'Mass',
    schema: prop.number(),
    get: (t) => t.mass,
    set: (t, v) => {
        t.mass = v;
    },
});

control(AabbBodyTrait, 'prediction', {
    label: 'Prediction',
    schema: prop.boolean(),
    get: (t) => t.prediction,
    set: (t, v) => {
        t.prediction = v;
    },
});

control(AabbBodyTrait, 'pushable', {
    label: 'Pushable',
    schema: prop.boolean(),
    get: (t) => t.pushable,
    set: (t, v) => {
        t.pushable = v;
    },
});

control(AabbBodyTrait, 'rigidBodyImpostor', {
    label: 'Rigid Body Impostor',
    schema: prop.boolean(),
    get: (t) => t.rigidBodyImpostor,
    set: (t, v) => {
        t.rigidBodyImpostor = v;
    },
});

/* ── syncs (replication) ── */

sync(AabbBodyTrait, 'halfExtents', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.halfExtents,
    unpack: (v, t) => {
        vec3.copy(t.halfExtents, v as Vec3);
    },
});

sync(AabbBodyTrait, 'motionType', {
    schema: pack.uint8(),
    pack: (t) => t.motionType,
    unpack: (v, t) => {
        t.motionType = v;
    },
});

sync(AabbBodyTrait, 'mass', {
    schema: pack.float32(),
    pack: (t) => t.mass,
    unpack: (v, t) => {
        t.mass = v;
    },
});

sync(AabbBodyTrait, 'prediction', {
    schema: pack.boolean(),
    pack: (t) => t.prediction,
    unpack: (v, t) => {
        t.prediction = v;
    },
});

sync(AabbBodyTrait, 'linearVelocity', {
    schema: pack.list(pack.float32(), 3),
    pack: (t) => t.linearVelocity,
    unpack: (v, t) => {
        vec3.copy(t.linearVelocity, v as Vec3);
    },
    rate: syncRate.distance(0.1), // 0.1 m/s, resting bodies go silent
});

sync(AabbBodyTrait, 'gravityFactor', {
    schema: pack.float32(),
    pack: (t) => t.gravityFactor,
    unpack: (v, t) => {
        t.gravityFactor = v;
    },
});

sync(AabbBodyTrait, 'collisionGroups', {
    schema: pack.uint32(),
    pack: (t) => t.collisionGroups,
    unpack: (v, t) => {
        t.collisionGroups = v;
    },
});

sync(AabbBodyTrait, 'collisionMask', {
    schema: pack.uint32(),
    pack: (t) => t.collisionMask,
    unpack: (v, t) => {
        t.collisionMask = v;
    },
});

sync(AabbBodyTrait, 'voxelFlagsMask', {
    schema: pack.uint32(),
    pack: (t) => t.voxelFlagsMask,
    unpack: (v, t) => {
        t.voxelFlagsMask = v;
    },
});

sync(AabbBodyTrait, 'friction', {
    schema: pack.float32(),
    pack: (t) => t.friction,
    unpack: (v, t) => {
        t.friction = v;
    },
});

sync(AabbBodyTrait, 'restitution', {
    schema: pack.float32(),
    pack: (t) => t.restitution,
    unpack: (v, t) => {
        t.restitution = v;
    },
});

sync(AabbBodyTrait, 'sensor', {
    schema: pack.boolean(),
    pack: (t) => t.sensor,
    unpack: (v, t) => {
        t.sensor = v;
    },
});

sync(AabbBodyTrait, 'pushable', {
    schema: pack.boolean(),
    pack: (t) => t.pushable,
    unpack: (v, t) => {
        t.pushable = v;
    },
});

sync(AabbBodyTrait, 'rigidBodyImpostor', {
    schema: pack.boolean(),
    pack: (t) => t.rigidBodyImpostor,
    unpack: (v, t) => {
        t.rigidBodyImpostor = v;
    },
});
