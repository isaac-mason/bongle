import {
    type AllCollideShapeCollector,
    type BodyId,
    box,
    type CastShapeSettings,
    CastShapeStatus,
    type ClosestCastShapeCollector,
    type CollideShapeHit,
    type CollideShapeSettings,
    castShape,
    collideShape,
    createAllCollideShapeCollector,
    createClosestCastShapeCollector,
    createDefaultCastShapeSettings,
    createDefaultCollideShapeSettings,
    filter as createFilter,
    type Filter,
    MotionType,
    type RigidBody,
    rigidBody,
    type Shape,
    transformed,
    type World,
} from 'crashcat';
import type { Quat, Vec3 } from 'math';
import { vec3 } from 'math';
import type { SweepResult } from '../../physics/aabb/aabb-sweep';
import { createVoxelSweepHit, sweepAabbVsVoxels, type VoxelSweepHit } from '../../voxels/voxel-aabb-sweep';
import type { Voxels } from '../../voxels/voxels';
import * as AabbPhysics from '../aabb';
import { OBJECT_LAYER_AABB_IMPOSTOR, OBJECT_LAYER_EDITOR_NODES, OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_VOXELS } from '../physics';

// sentinel body id for non-body (voxel / aabbBody) contacts.
const INVALID_BODY_ID: BodyId = -1;

export const GROUND_STATE_ON_GROUND = 0;
export const GROUND_STATE_ON_STEEP_GROUND = 1;
export const GROUND_STATE_NOT_SUPPORTED = 2;
export const GROUND_STATE_IN_AIR = 3;

export type GroundState =
    | typeof GROUND_STATE_ON_GROUND
    | typeof GROUND_STATE_ON_STEEP_GROUND
    | typeof GROUND_STATE_NOT_SUPPORTED
    | typeof GROUND_STATE_IN_AIR;

/** one resolution surface produced by the overlap or sweep pass, surfaced to scripts. */
export type VccContact = {
    positionX: number;
    positionY: number;
    positionZ: number;

    /** surface to character; used by the solver as the constraint plane. */
    contactNormalX: number;
    contactNormalY: number;
    contactNormalZ: number;

    /** literal face normal, unlike contactNormal which may be smoothed. */
    surfaceNormalX: number;
    surfaceNormalY: number;
    surfaceNormalZ: number;

    /** signed distance to the plane; negative means penetrating. */
    distance: number;

    /** sweep TOI in [0, 1]; 0 for overlap-only contacts. */
    fraction: number;

    /** penetration depth along contactNormal; non-zero only when fraction < 0. */
    overlapDepth: number;

    /** INVALID_BODY_ID for voxel / aabbBody contacts. */
    bodyId: BodyId;

    /** -1 for voxel / rigid-body contacts. */
    aabbBodyId: AabbPhysics.BodyId;

    /** 0 for voxels and aabbBodies. */
    subShapeId: number;

    /** valid only when bodyId === INVALID_BODY_ID. */
    voxelX: number;
    voxelY: number;
    voxelZ: number;

    /** sub-aabb index for `aabbs` voxels; -1 otherwise. */
    subAabbIndex: number;

    /** voxel state id; 0 for body contacts. */
    stateId: number;

    /** body's motion type at gather time; STATIC for voxels. */
    motionType: MotionType;

    /** body's velocity, world space; 0 for voxels; stale by one frame. */
    linearVelocityX: number;
    linearVelocityY: number;
    linearVelocityZ: number;
    angularVelocityX: number;
    angularVelocityY: number;
    angularVelocityZ: number;
    bodyPositionX: number;
    bodyPositionY: number;
    bodyPositionZ: number;

    hadCollision: boolean;

    wasDiscarded: boolean;

    /** false means informational only, doesn't push the character. */
    canPushCharacter: boolean;
};

export function createVccContact(): VccContact {
    return {
        positionX: 0,
        positionY: 0,
        positionZ: 0,
        contactNormalX: 0,
        contactNormalY: 0,
        contactNormalZ: 0,
        surfaceNormalX: 0,
        surfaceNormalY: 0,
        surfaceNormalZ: 0,
        distance: 0,
        fraction: 0,
        overlapDepth: 0,
        bodyId: INVALID_BODY_ID,
        aabbBodyId: -1,
        subShapeId: 0,
        voxelX: 0,
        voxelY: 0,
        voxelZ: 0,
        subAabbIndex: -1,
        stateId: 0,
        motionType: MotionType.STATIC,
        linearVelocityX: 0,
        linearVelocityY: 0,
        linearVelocityZ: 0,
        angularVelocityX: 0,
        angularVelocityY: 0,
        angularVelocityZ: 0,
        bodyPositionX: 0,
        bodyPositionY: 0,
        bodyPositionZ: 0,
        hadCollision: false,
        wasDiscarded: false,
        canPushCharacter: true,
    };
}

export function resetVccContact(c: VccContact): void {
    c.positionX = 0;
    c.positionY = 0;
    c.positionZ = 0;
    c.contactNormalX = 0;
    c.contactNormalY = 0;
    c.contactNormalZ = 0;
    c.surfaceNormalX = 0;
    c.surfaceNormalY = 0;
    c.surfaceNormalZ = 0;
    c.distance = 0;
    c.fraction = 0;
    c.overlapDepth = 0;
    c.bodyId = INVALID_BODY_ID;
    c.aabbBodyId = -1;
    c.subShapeId = 0;
    c.voxelX = 0;
    c.voxelY = 0;
    c.voxelZ = 0;
    c.subAabbIndex = -1;
    c.stateId = 0;
    c.motionType = MotionType.STATIC;
    c.linearVelocityX = 0;
    c.linearVelocityY = 0;
    c.linearVelocityZ = 0;
    c.angularVelocityX = 0;
    c.angularVelocityY = 0;
    c.angularVelocityZ = 0;
    c.bodyPositionX = 0;
    c.bodyPositionY = 0;
    c.bodyPositionZ = 0;
    c.hadCollision = false;
    c.wasDiscarded = false;
    c.canPushCharacter = true;
}

export function copyVccContact(dst: VccContact, src: VccContact): void {
    dst.positionX = src.positionX;
    dst.positionY = src.positionY;
    dst.positionZ = src.positionZ;
    dst.contactNormalX = src.contactNormalX;
    dst.contactNormalY = src.contactNormalY;
    dst.contactNormalZ = src.contactNormalZ;
    dst.surfaceNormalX = src.surfaceNormalX;
    dst.surfaceNormalY = src.surfaceNormalY;
    dst.surfaceNormalZ = src.surfaceNormalZ;
    dst.distance = src.distance;
    dst.fraction = src.fraction;
    dst.overlapDepth = src.overlapDepth;
    dst.bodyId = src.bodyId;
    dst.aabbBodyId = src.aabbBodyId;
    dst.subShapeId = src.subShapeId;
    dst.voxelX = src.voxelX;
    dst.voxelY = src.voxelY;
    dst.voxelZ = src.voxelZ;
    dst.subAabbIndex = src.subAabbIndex;
    dst.stateId = src.stateId;
    dst.motionType = src.motionType;
    dst.linearVelocityX = src.linearVelocityX;
    dst.linearVelocityY = src.linearVelocityY;
    dst.linearVelocityZ = src.linearVelocityZ;
    dst.angularVelocityX = src.angularVelocityX;
    dst.angularVelocityY = src.angularVelocityY;
    dst.angularVelocityZ = src.angularVelocityZ;
    dst.bodyPositionX = src.bodyPositionX;
    dst.bodyPositionY = src.bodyPositionY;
    dst.bodyPositionZ = src.bodyPositionZ;
    dst.hadCollision = src.hadCollision;
    dst.wasDiscarded = src.wasDiscarded;
    dst.canPushCharacter = src.canPushCharacter;
}

/** per-contact settings that can be modified from onContactValidate / onContactAdded / onContactPersisted. */
export type VccContactSettings = {
    /** false disables pushing (informational only); default true. */
    canPushCharacter: boolean;
};

/** listener for VCC contact events. */
export type VccListener = {
    /** validates a contact before it's accepted; return false to reject it. */
    onContactValidate?: (vcc: VCC, body: RigidBody, subShapeId: number, contactPosition: Vec3, contactNormal: Vec3) => boolean;

    /** called when a new body contact is first seen this frame. */
    onContactAdded?: (
        vcc: VCC,
        body: RigidBody,
        subShapeId: number,
        contactPosition: Vec3,
        contactNormal: Vec3,
        settings: VccContactSettings,
    ) => void;

    /** called when an existing body contact persists from a previous frame. */
    onContactPersisted?: (
        vcc: VCC,
        body: RigidBody,
        subShapeId: number,
        contactPosition: Vec3,
        contactNormal: Vec3,
        settings: VccContactSettings,
    ) => void;

    /** called after character velocity is resolved for a contact; ioCharacterVelocity may be overridden. */
    onContactSolve?: (
        vcc: VCC,
        body: RigidBody | null,
        stateId: number,
        contactPosition: Vec3,
        contactNormal: Vec3,
        contactVelocity: Vec3,
        characterVelocity: Vec3,
        ioCharacterVelocity: Vec3,
    ) => void;

    /** called when a body contact is no longer present this frame. */
    onContactRemoved?: (vcc: VCC, body: RigidBody, subShapeId: number) => void;
};

type ListenerContactValue = {
    /** pool index when active, -1 when pooled */
    poolIndex: number;
    packedKey: number;
    bodyId: BodyId;
    subShapeId: number;
    /** 0 = not seen this frame, 1 = seen */
    count: number;
    settings: VccContactSettings;
};

type ListenerContactsPool = {
    active: ListenerContactValue[];
    pool: ListenerContactValue[];
};

function createListenerContactValue(): ListenerContactValue {
    return {
        poolIndex: -1,
        packedKey: 0,
        bodyId: INVALID_BODY_ID,
        subShapeId: 0,
        count: 0,
        settings: { canPushCharacter: true },
    };
}

function createListenerContactsPool(): ListenerContactsPool {
    return { active: [], pool: [] };
}

function packListenerContactKey(bodyId: BodyId, subShapeId: number): number {
    return (bodyId * 0x10000 + subShapeId) | 0;
}

function acquireListenerContact(lcp: ListenerContactsPool): ListenerContactValue {
    let v = lcp.pool.pop();
    if (!v) v = createListenerContactValue();
    v.poolIndex = lcp.active.length;
    lcp.active.push(v);
    return v;
}

function findListenerContact(lcp: ListenerContactsPool, packedKey: number): ListenerContactValue | undefined {
    for (let i = 0; i < lcp.active.length; i++) {
        if (lcp.active[i]!.packedKey === packedKey) return lcp.active[i];
    }
    return undefined;
}

function releaseAllListenerContacts(lcp: ListenerContactsPool): void {
    for (let i = 0; i < lcp.active.length; i++) {
        const v = lcp.active[i]!;
        v.poolIndex = -1;
        lcp.pool.push(v);
    }
    lcp.active.length = 0;
}

/** solver-internal constraint derived from a VccContact each moveShape iteration. */
export type VccConstraint = {
    contact: VccContact;
    /** world space, unit length; surface to character. */
    planeNormal: Vec3;
    /** mutable copy of contact.linearVelocity, adjusted during solving. */
    linearVelocity: Vec3;
    /** signed distance from character reference point to the plane. */
    planeDistance: number;
    /** dot((constraintLinearVel - characterVel), planeNormal); positive means pushing into the character. */
    projectedVelocity: number;
    toi: number;
    /** true when angle(surfaceNormal, up) exceeds maxSlopeAngle. */
    isSteepSlope: boolean;
};

function createVccConstraint(): VccConstraint {
    return {
        contact: createVccContact(),
        planeNormal: vec3.create(),
        linearVelocity: vec3.create(),
        planeDistance: 0,
        projectedVelocity: 0,
        toi: 0,
        isSteepSlope: false,
    };
}

function acquireConstraint(pool: VccConstraint[]): VccConstraint {
    if (pool.length > 0) {
        return pool.pop()!;
    }
    return createVccConstraint();
}

function releaseConstraints(active: VccConstraint[], pool: VccConstraint[]): void {
    for (let i = 0; i < active.length; i++) {
        pool.push(active[i]!);
    }
    active.length = 0;
}

function releaseContacts(active: VccContact[], pool: VccContact[]): void {
    for (let i = 0; i < active.length; i++) {
        pool.push(active[i]!);
    }
    active.length = 0;
}

/** acquires a contact slot from pool (or creates one), resets it, and appends to out. */
export function acquireVccContact(out: VccContact[], pool: VccContact[]): VccContact {
    let c: VccContact;
    if (pool.length > 0) {
        c = pool.pop()!;
        resetVccContact(c);
    } else {
        c = createVccContact();
    }
    out.push(c);
    return c;
}

/** tunables passed to create; optional fields fall back to defaults. */
export type VccSettings = {
    halfExtents: Vec3;
    /** bottom-center (feet). */
    position: Vec3;
    /** radians; surfaces with `angle(normal, up) > this` are steep. */
    maxSlopeAngle: number;

    /** collision group bitfield for the inner body and the character's sweeps; defaults to all bits set. */
    collisionGroups?: number;
    /** collision mask: which groups the character collides with; defaults to all bits set. */
    collisionMask?: number;

    /** outer slide-loop iteration cap; default 5. */
    maxCollisionIterations?: number;
    /** inner constraint-solve iteration cap; default 15. */
    maxConstraintIterations?: number;
    /** slide loop stops once remaining time drops below this; default 1e-4. */
    minTimeRemaining?: number;
    /** padding subtracted from contact distances for numerical margin; default 0.02. */
    characterPadding?: number;
    /** max separation distance for predictive contacts; default 0.1. */
    predictiveContactDistance?: number;
    /** distance threshold for a contact to count as colliding; default 0.1. */
    collisionTolerance?: number;
    /** speed at which penetrating contacts are pushed out; default 1.5. */
    penetrationRecoverySpeed?: number;
};

const DEFAULT_VCC_SETTINGS = {
    maxCollisionIterations: 5,
    maxConstraintIterations: 15,
    minTimeRemaining: 1e-4,
    characterPadding: 0.02,
    predictiveContactDistance: 0.1,
    collisionTolerance: 0.1,
    penetrationRecoverySpeed: 1.5,
} as const;

/** runtime VCC instance; position is the feet (bottom-center), linearVelocity is world-space commanded velocity. */
export type VCC = {
    halfExtents: Vec3;
    position: Vec3;
    linearVelocity: Vec3;

    /** cosine of maxSlopeAngle, precomputed. */
    cosMaxSlopeAngle: number;

    maxCollisionIterations: number;
    maxConstraintIterations: number;
    minTimeRemaining: number;
    characterPadding: number;
    predictiveContactDistance: number;
    collisionTolerance: number;
    penetrationRecoverySpeed: number;

    /** active contacts from the last move(); cleared at the start of each move. */
    contacts: VccContact[];

    /** reusable per-segment voxel sweep result; crossed accumulates passable cells for the whole move. */
    sweep: VoxelSweepHit;

    contactsPool: VccContact[];
    constraintsPool: VccConstraint[];

    groundState: GroundState;
    groundNormal: Vec3;
    groundPosition: Vec3;
    groundVelocity: Vec3;
    groundBodyId: BodyId;
    /** voxel coords of the supporting cell; valid only when ground is voxel-sourced. */
    groundVoxelX: number;
    groundVoxelY: number;
    groundVoxelZ: number;
    /** block state id at the supporting voxel; 0 when not voxel-grounded; authoritative "standing block" value. */
    groundVoxelStateId: number;

    innerBody: RigidBody;
    innerBodyId: BodyId;
    /** collision group/mask applied to both the body-query filter and the AABB-body sweep. */
    collisionGroups: number;
    collisionMask: number;
    /** body query filter; excludes voxel layer and the character's own inner body. */
    bodyFilter: Filter;
    bodyOverlapCollector: AllCollideShapeCollector;
    bodyOverlapSettings: CollideShapeSettings;
    bodyOverlapShape: Shape;
    bodyOverlapHalfExtents: Vec3;

    /** delta time of the last move(); used by stickToFloor / walkStairs. */
    lastDeltaTime: number;

    /** tracks body contacts across frames for onContactAdded/Persisted/Removed. */
    listenerContacts: ListenerContactsPool;

    /** most-up-pointing sweep hit observed during moveShape; emitted into contacts post-loop for updateGroundState. */
    bestSweepHit: VccContact;
    bestSweepHitNormalY: number;
    hasBestSweepHit: boolean;
};

/** creates a VCC instance and registers its kinematic inner body with the world. */
export function create(world: World, voxels: Voxels, settings: VccSettings): VCC {
    const halfExtents: Vec3 = [settings.halfExtents[0], settings.halfExtents[1], settings.halfExtents[2]];
    const position: Vec3 = [settings.position[0], settings.position[1], settings.position[2]];
    const cosMaxSlopeAngle = Math.cos(settings.maxSlopeAngle);
    const collisionGroups = settings.collisionGroups ?? 0xffffffff;
    const collisionMask = settings.collisionMask ?? 0xffffffff;

    // lifts the box by halfExtents[1] so the body's reference point sits at the feet.
    const innerShape: Shape = transformed.create({
        shape: box.create({ halfExtents, convexRadius: 0.1 }),
        position: [0, halfExtents[1], 0],
        quaternion: [0, 0, 0, 1],
    });
    const innerBody = rigidBody.create(world, {
        shape: innerShape,
        position,
        quaternion: [0, 0, 0, 1],
        motionType: MotionType.KINEMATIC,
        objectLayer: OBJECT_LAYER_NODE_MOVING,
        collisionGroups,
        collisionMask,
    });

    // excludes voxels, editor pick bodies, and the character's own inner body (self-collision would stall the slide loop).
    const bodyFilter = createFilter.forWorld(world);
    createFilter.disableObjectLayer(bodyFilter, world.settings.layers, OBJECT_LAYER_VOXELS);
    createFilter.disableObjectLayer(bodyFilter, world.settings.layers, OBJECT_LAYER_EDITOR_NODES);
    // excludes AABB impostors too; the character already sweeps AabbBodies directly, so the impostor would double-count.
    createFilter.disableObjectLayer(bodyFilter, world.settings.layers, OBJECT_LAYER_AABB_IMPOSTOR);
    bodyFilter.collisionGroups = collisionGroups;
    bodyFilter.collisionMask = collisionMask;
    const innerBodyId = innerBody.id;
    // sensor bodies must not block movement even though they generate contact events elsewhere.
    bodyFilter.bodyFilter = (body) => body.id !== innerBodyId && !body.sensor;

    const bodyOverlapHalfExtents: Vec3 = [halfExtents[0], halfExtents[1], halfExtents[2]];
    const bodyOverlapShape: Shape = box.create({ halfExtents: bodyOverlapHalfExtents });

    const vcc: VCC = {
        halfExtents,
        position,
        linearVelocity: vec3.create(),

        cosMaxSlopeAngle,

        maxCollisionIterations: settings.maxCollisionIterations ?? DEFAULT_VCC_SETTINGS.maxCollisionIterations,
        maxConstraintIterations: settings.maxConstraintIterations ?? DEFAULT_VCC_SETTINGS.maxConstraintIterations,
        minTimeRemaining: settings.minTimeRemaining ?? DEFAULT_VCC_SETTINGS.minTimeRemaining,
        characterPadding: settings.characterPadding ?? DEFAULT_VCC_SETTINGS.characterPadding,
        predictiveContactDistance: settings.predictiveContactDistance ?? DEFAULT_VCC_SETTINGS.predictiveContactDistance,
        collisionTolerance: settings.collisionTolerance ?? DEFAULT_VCC_SETTINGS.collisionTolerance,
        penetrationRecoverySpeed: settings.penetrationRecoverySpeed ?? DEFAULT_VCC_SETTINGS.penetrationRecoverySpeed,

        contacts: [],
        sweep: createVoxelSweepHit(),
        contactsPool: [],
        constraintsPool: [],

        groundState: GROUND_STATE_IN_AIR,
        groundNormal: [0, 1, 0],
        groundPosition: vec3.create(),
        groundVelocity: vec3.create(),
        groundBodyId: INVALID_BODY_ID,
        groundVoxelX: 0,
        groundVoxelY: 0,
        groundVoxelZ: 0,
        groundVoxelStateId: 0,

        innerBody,
        innerBodyId: innerBody.id,
        collisionGroups,
        collisionMask,
        bodyFilter,
        bodyOverlapCollector: createAllCollideShapeCollector(),
        bodyOverlapSettings: createDefaultCollideShapeSettings(),
        bodyOverlapShape,
        bodyOverlapHalfExtents,

        lastDeltaTime: 0,

        listenerContacts: createListenerContactsPool(),

        bestSweepHit: createVccContact(),
        bestSweepHitNormalY: -Infinity,
        hasBestSweepHit: false,
    };

    void voxels;
    return vcc;
}

export function destroy(world: World, vcc: VCC): void {
    rigidBody.remove(world, vcc.innerBody);
}

/** resizes the inner kinematic body; callers must gate the swap themselves (e.g. only on fully-eased crouch). */
export function resize(world: World, vcc: VCC, halfExtents: Vec3): void {
    if (vcc.halfExtents[0] === halfExtents[0] && vcc.halfExtents[1] === halfExtents[1] && vcc.halfExtents[2] === halfExtents[2])
        return;
    vcc.halfExtents[0] = halfExtents[0];
    vcc.halfExtents[1] = halfExtents[1];
    vcc.halfExtents[2] = halfExtents[2];
    vcc.innerBody.shape = transformed.create({
        shape: box.create({ halfExtents: [halfExtents[0], halfExtents[1], halfExtents[2]], convexRadius: 0.1 }),
        position: [0, halfExtents[1], 0],
        quaternion: [0, 0, 0, 1],
    });
    rigidBody.updateShape(world, vcc.innerBody);
}

/** body-local AABB center is at feet + halfHeight. */
function boxCenterFromFeet(out: Vec3, position: Vec3, halfExtents: Vec3): Vec3 {
    out[0] = position[0];
    out[1] = position[1] + halfExtents[1];
    out[2] = position[2];
    return out;
}

const UP_X = 0;
const UP_Y = 1;
const UP_Z = 0;

/** time of impact for one constraint against the character's displacement. */
export function calculateConstraintTOI(
    constraint: VccConstraint,
    velocity: Vec3,
    displacement: Vec3,
    timeRemaining: number,
): number {
    const distToPlane = vec3.dot(constraint.planeNormal, displacement) + constraint.planeDistance;

    const projectedVelocity =
        vec3.dot(constraint.linearVelocity, constraint.planeNormal) - vec3.dot(velocity, constraint.planeNormal);

    constraint.projectedVelocity = projectedVelocity;

    // not pushing into the plane.
    if (projectedVelocity < 1e-6) {
        return Number.MAX_VALUE;
    }

    // within tolerance; accept the move.
    if (distToPlane - projectedVelocity * timeRemaining > -1e-4) {
        return Number.MAX_VALUE;
    }

    return Math.max(0, distToPlane / projectedVelocity);
}

/** sort key: penetrating contacts by projectedVelocity desc, then TOI asc, then dynamic before static. */
function compareConstraints(a: VccConstraint, b: VccConstraint): number {
    if (a.toi <= 0 && b.toi <= 0) {
        if (a.projectedVelocity !== b.projectedVelocity) {
            return b.projectedVelocity - a.projectedVelocity;
        }
    }
    if (a.toi !== b.toi) {
        return a.toi - b.toi;
    }
    return b.contact.motionType - a.contact.motionType;
}

/** projects velocity onto the constraint plane, cancelling the into-plane component. */
export function slideVelocityAlongPlane(outVelocity: Vec3, velocity: Vec3, constraint: VccConstraint): void {
    const relVelDotNormal =
        vec3.dot(velocity, constraint.planeNormal) - vec3.dot(constraint.linearVelocity, constraint.planeNormal);
    vec3.scaleAndAdd(outVelocity, velocity, constraint.planeNormal, -relVelDotNormal);
}

const _slideAlongEdge_dir = vec3.create();
const _slideAlongEdge_perp1 = vec3.create();
const _slideAlongEdge_perp2 = vec3.create();

/** slides velocity along the intersection edge of two constraint planes. */
export function slideAlongEdge(outVelocity: Vec3, velocity: Vec3, c1: VccConstraint, c2: VccConstraint): void {
    vec3.cross(_slideAlongEdge_dir, c1.planeNormal, c2.planeNormal);
    const edgeLenSq = vec3.squaredLength(_slideAlongEdge_dir);
    if (edgeLenSq < 1e-12) {
        // planes parallel; falls back to single-plane slide.
        slideVelocityAlongPlane(outVelocity, velocity, c1);
        return;
    }
    vec3.normalize(_slideAlongEdge_dir, _slideAlongEdge_dir);

    const velocityAlongEdge = vec3.dot(velocity, _slideAlongEdge_dir);
    vec3.scale(outVelocity, _slideAlongEdge_dir, velocityAlongEdge);

    const v1AlongEdge = vec3.dot(c1.linearVelocity, _slideAlongEdge_dir);
    vec3.scaleAndAdd(_slideAlongEdge_perp1, c1.linearVelocity, _slideAlongEdge_dir, -v1AlongEdge);
    const v2AlongEdge = vec3.dot(c2.linearVelocity, _slideAlongEdge_dir);
    vec3.scaleAndAdd(_slideAlongEdge_perp2, c2.linearVelocity, _slideAlongEdge_dir, -v2AlongEdge);

    vec3.add(outVelocity, outVelocity, _slideAlongEdge_perp1);
    vec3.add(outVelocity, outVelocity, _slideAlongEdge_perp2);
}

const _determineContact_pen = vec3.create();
const _determineContact_horiz = vec3.create();
const _determineContact_lin = vec3.create();

/** converts contacts to constraints, spawning a companion wall plane for steep slopes. */
function determineConstraints(vcc: VCC, contacts: VccContact[], deltaTime: number, constraints: VccConstraint[]): void {
    releaseConstraints(constraints, vcc.constraintsPool);

    const invDeltaTime = deltaTime > 0 ? 1 / deltaTime : 0;

    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i]!;
        if (contact.wasDiscarded) continue;

        _determineContact_lin[0] = contact.linearVelocityX;
        _determineContact_lin[1] = contact.linearVelocityY;
        _determineContact_lin[2] = contact.linearVelocityZ;

        if (contact.distance < 0) {
            const recoverScale = contact.distance * vcc.penetrationRecoverySpeed * invDeltaTime;
            _determineContact_pen[0] = contact.contactNormalX * recoverScale;
            _determineContact_pen[1] = contact.contactNormalY * recoverScale;
            _determineContact_pen[2] = contact.contactNormalZ * recoverScale;
            vec3.subtract(_determineContact_lin, _determineContact_lin, _determineContact_pen);
        }

        const main = acquireConstraint(vcc.constraintsPool);
        constraints.push(main);
        main.contact = contact;
        main.toi = 0;
        main.projectedVelocity = 0;
        vec3.copy(main.linearVelocity, _determineContact_lin);
        main.planeNormal[0] = contact.contactNormalX;
        main.planeNormal[1] = contact.contactNormalY;
        main.planeNormal[2] = contact.contactNormalZ;
        main.planeDistance = contact.distance;
        main.isSteepSlope = false;

        const surfaceDotUp = contact.surfaceNormalX * UP_X + contact.surfaceNormalY * UP_Y + contact.surfaceNormalZ * UP_Z;
        const isSteep = surfaceDotUp > -1 && surfaceDotUp < vcc.cosMaxSlopeAngle;
        if (!isSteep) continue;

        const contactDotUp = contact.contactNormalY;
        if (contactDotUp <= 1e-3) continue;

        main.isSteepSlope = true;

        // horizontal projection becomes the wall plane, so the character can't ride the slope upward.
        _determineContact_horiz[0] = contact.contactNormalX;
        _determineContact_horiz[1] = contact.contactNormalY - contactDotUp;
        _determineContact_horiz[2] = contact.contactNormalZ;
        const horizLenSq = vec3.squaredLength(_determineContact_horiz);
        if (horizLenSq <= 1e-6) continue;
        vec3.normalize(_determineContact_horiz, _determineContact_horiz);

        const wall = acquireConstraint(vcc.constraintsPool);
        constraints.push(wall);
        wall.contact = contact;
        wall.toi = 0;
        wall.projectedVelocity = 0;

        // uses the original velocity (no penetration recovery) so adjacent steep slopes don't fight each other.
        const contactVelDotHoriz =
            contact.linearVelocityX * _determineContact_horiz[0] +
            contact.linearVelocityY * _determineContact_horiz[1] +
            contact.linearVelocityZ * _determineContact_horiz[2];
        wall.linearVelocity[0] = _determineContact_horiz[0] * contactVelDotHoriz;
        wall.linearVelocity[1] = _determineContact_horiz[1] * contactVelDotHoriz;
        wall.linearVelocity[2] = _determineContact_horiz[2] * contactVelDotHoriz;
        vec3.copy(wall.planeNormal, _determineContact_horiz);

        const normalDotContact =
            _determineContact_horiz[0] * contact.contactNormalX +
            _determineContact_horiz[1] * contact.contactNormalY +
            _determineContact_horiz[2] * contact.contactNormalZ;
        wall.planeDistance = Math.abs(normalDotContact) > 1e-6 ? contact.distance / normalDotContact : contact.distance;
        wall.isSteepSlope = true;
    }
}

// discards the shallower of two penetrating contacts whose normals oppose (e.g. a corner).
function removeConflictingContacts(contacts: VccContact[], characterPadding: number): void {
    const minRequiredPenetration = 1.25 * characterPadding;
    const n = contacts.length;
    for (let i = 0; i < n; i++) {
        const a = contacts[i]!;
        if (a.wasDiscarded) continue;
        if (a.distance > -minRequiredPenetration) continue;
        for (let j = i + 1; j < n; j++) {
            const b = contacts[j]!;
            if (b.wasDiscarded) continue;
            if (b.distance > -minRequiredPenetration) continue;

            const dot =
                a.contactNormalX * b.contactNormalX + a.contactNormalY * b.contactNormalY + a.contactNormalZ * b.contactNormalZ;
            if (dot < 0) {
                if (a.distance > b.distance) {
                    a.wasDiscarded = true;
                    break;
                }
                b.wasDiscarded = true;
            }
        }
    }
}

function compareContactsStable(a: VccContact, b: VccContact): number {
    if (a.bodyId !== b.bodyId) return a.bodyId - b.bodyId;
    if (a.subAabbIndex !== b.subAabbIndex) return a.subAabbIndex - b.subAabbIndex;
    if (a.voxelX !== b.voxelX) return a.voxelX - b.voxelX;
    if (a.voxelY !== b.voxelY) return a.voxelY - b.voxelY;
    if (a.voxelZ !== b.voxelZ) return a.voxelZ - b.voxelZ;
    return a.distance - b.distance;
}

function reduceNearDuplicateContacts(contacts: VccContact[]): void {
    const COS_MERGE = 0.999;
    for (let i = contacts.length - 1; i >= 0; i--) {
        const a = contacts[i]!;
        for (let j = i - 1; j >= 0; j--) {
            const b = contacts[j]!;
            if (a.bodyId !== b.bodyId) continue;
            if (a.subAabbIndex !== b.subAabbIndex) continue;
            const dot =
                a.contactNormalX * b.contactNormalX + a.contactNormalY * b.contactNormalY + a.contactNormalZ * b.contactNormalZ;
            if (dot <= COS_MERGE) continue;
            if (a.distance > b.distance) {
                contacts.splice(i, 1);
            } else {
                contacts.splice(j, 1);
            }
            break;
        }
    }
}

const _solver_lastVelocity = vec3.create();
const _solver_verticalNormal = vec3.create();
const _solver_relativeVelocity = vec3.create();
const _solver_newVelocity = vec3.create();
const _solver_previous: VccConstraint[] = [];
const _solver_contactPos: Vec3 = [0, 0, 0];
const _solver_contactNormal: Vec3 = [0, 0, 0];
const _solver_contactVelocity: Vec3 = [0, 0, 0];
const _solver_characterVelocity: Vec3 = [0, 0, 0];

/** iteratively solves velocity against constraints, filling outDisplacement over deltaTime; returns time actually simulated. */
export function solveConstraints(
    world: World,
    vcc: VCC,
    velocity: Vec3,
    deltaTime: number,
    constraints: VccConstraint[],
    outDisplacement: Vec3,
    listener: VccListener | undefined,
): number {
    vec3.zero(outDisplacement);

    if (constraints.length === 0) {
        vec3.scaleAndAdd(outDisplacement, outDisplacement, velocity, deltaTime);
        return deltaTime;
    }

    vec3.copy(_solver_lastVelocity, velocity);
    _solver_previous.length = 0;

    let timeRemaining = deltaTime;
    let timeSimulated = 0;

    for (let iter = 0; iter < vcc.maxConstraintIterations; iter++) {
        for (let i = 0; i < constraints.length; i++) {
            const c = constraints[i]!;
            c.toi = calculateConstraintTOI(c, velocity, outDisplacement, timeRemaining);
        }

        constraints.sort(compareConstraints);

        let active: VccConstraint | null = null;
        let reachedGoal = false;
        for (let i = 0; i < constraints.length; i++) {
            const c = constraints[i]!;
            if (c.toi >= timeRemaining) {
                vec3.scaleAndAdd(outDisplacement, outDisplacement, velocity, timeRemaining);
                timeSimulated += timeRemaining;
                reachedGoal = true;
                break;
            }
            if (c.contact.wasDiscarded) continue;
            if (c.projectedVelocity <= 1e-10) continue;
            if (!c.contact.canPushCharacter) {
                vec3.zero(c.linearVelocity);
            }
            active = c;
            break;
        }

        if (reachedGoal) break;

        if (!active) {
            vec3.scaleAndAdd(outDisplacement, outDisplacement, velocity, timeRemaining);
            timeSimulated += timeRemaining;
            break;
        }

        const moveTime = Math.max(0, active.toi);
        vec3.scaleAndAdd(outDisplacement, outDisplacement, velocity, moveTime);
        timeRemaining -= moveTime;
        timeSimulated += moveTime;

        if (timeRemaining < vcc.minTimeRemaining) break;

        // a significant move invalidates prior constraint planes.
        if (moveTime > 1e-4) {
            _solver_previous.length = 0;
        }

        if (active.isSteepSlope) {
            const dotUp = vec3.dot(active.planeNormal, [UP_X, UP_Y, UP_Z]);
            _solver_verticalNormal[0] = active.planeNormal[0] - UP_X * dotUp;
            _solver_verticalNormal[1] = active.planeNormal[1] - UP_Y * dotUp;
            _solver_verticalNormal[2] = active.planeNormal[2] - UP_Z * dotUp;

            _solver_relativeVelocity[0] = velocity[0] - active.linearVelocity[0];
            _solver_relativeVelocity[1] = velocity[1] - active.linearVelocity[1];
            _solver_relativeVelocity[2] = velocity[2] - active.linearVelocity[2];

            const relVelDotV = vec3.dot(_solver_relativeVelocity, _solver_verticalNormal);
            if (relVelDotV < 0) {
                const verticalLenSq = vec3.squaredLength(_solver_verticalNormal);
                if (verticalLenSq > 1e-8) {
                    const k = -relVelDotV / verticalLenSq;
                    velocity[0] += _solver_verticalNormal[0] * k;
                    velocity[1] += _solver_verticalNormal[1] * k;
                    velocity[2] += _solver_verticalNormal[2] * k;
                }
            }
        }

        slideVelocityAlongPlane(_solver_newVelocity, velocity, active);

        let highestPenetration = 0;
        let other: VccConstraint | null = null;
        for (let i = 0; i < _solver_previous.length; i++) {
            const prev = _solver_previous[i]!;
            if (prev === active) continue;

            const penetration = vec3.dot(prev.linearVelocity, prev.planeNormal) - vec3.dot(_solver_newVelocity, prev.planeNormal);

            if (penetration > highestPenetration) {
                const d = vec3.dot(prev.planeNormal, active.planeNormal);
                if (d < 0.984 && d > -0.984) {
                    highestPenetration = penetration;
                    other = prev;
                }
            }

            // damps the prior constraint along the active plane to avoid oscillation.
            const velDotActive = vec3.dot(prev.linearVelocity, active.planeNormal);
            if (velDotActive < 0) {
                vec3.scaleAndAdd(prev.linearVelocity, prev.linearVelocity, active.planeNormal, -velDotActive);
            }
            const activeVelDotPrev = vec3.dot(active.linearVelocity, prev.planeNormal);
            if (activeVelDotPrev < 0) {
                vec3.scaleAndAdd(active.linearVelocity, active.linearVelocity, prev.planeNormal, -activeVelDotPrev);
            }
        }

        if (other) {
            slideAlongEdge(_solver_newVelocity, velocity, active, other);
        }

        if (listener?.onContactSolve) {
            const body = rigidBody.get(world, active.contact.bodyId);
            if (body) {
                _solver_contactPos[0] = active.contact.positionX;
                _solver_contactPos[1] = active.contact.positionY;
                _solver_contactPos[2] = active.contact.positionZ;
                _solver_contactNormal[0] = -active.contact.contactNormalX;
                _solver_contactNormal[1] = -active.contact.contactNormalY;
                _solver_contactNormal[2] = -active.contact.contactNormalZ;
                _solver_contactVelocity[0] = active.linearVelocity[0];
                _solver_contactVelocity[1] = active.linearVelocity[1];
                _solver_contactVelocity[2] = active.linearVelocity[2];
                vec3.copy(_solver_characterVelocity, velocity);
                listener.onContactSolve(
                    vcc,
                    body,
                    active.contact.stateId,
                    _solver_contactPos,
                    _solver_contactNormal,
                    _solver_contactVelocity,
                    _solver_characterVelocity,
                    _solver_newVelocity,
                );
            }
        }

        vec3.copy(velocity, _solver_newVelocity);
        _solver_previous.push(active);

        if (active.projectedVelocity < 1e-8 && vec3.squaredLength(velocity) < 1e-8) break;

        const constraintVelLenSq = vec3.squaredLength(active.linearVelocity);
        if (constraintVelLenSq > 1e-16) {
            vec3.copy(_solver_lastVelocity, active.linearVelocity);
        } else if (vec3.dot(velocity, _solver_lastVelocity) < 0) {
            // velocity reversed relative to start; likely wedged in a corner.
            break;
        }
    }

    return timeSimulated;
}

// voxels are handled by the sweep-and-slide loop, not the constraint gather.
const _gatherCenter: Vec3 = [0, 0, 0];
const _gatherIdentityQuat: Quat = [0, 0, 0, 1];
const _gatherScaleOne: Vec3 = [1, 1, 1];
const _surfaceNormal: Vec3 = [0, 0, 0];
const _emit_contactPos: Vec3 = [0, 0, 0];
const _emit_contactNormal: Vec3 = [0, 0, 0];
const _emit_settings: VccContactSettings = { canPushCharacter: true };

/** converts a collide-shape hit into a VccContact. */
function emitBodyContact(
    world: World,
    vcc: VCC,
    hit: CollideShapeHit,
    out: VccContact[],
    pool: VccContact[],
    listener: VccListener | undefined,
): void {
    const c = acquireVccContact(out, pool);

    // penetrationAxis points from character to body; negate for the surface-to-character convention.
    const paLenSq =
        hit.penetrationAxis[0] * hit.penetrationAxis[0] +
        hit.penetrationAxis[1] * hit.penetrationAxis[1] +
        hit.penetrationAxis[2] * hit.penetrationAxis[2];
    if (paLenSq > 1e-12) {
        const inv = 1 / Math.sqrt(paLenSq);
        c.contactNormalX = -hit.penetrationAxis[0] * inv;
        c.contactNormalY = -hit.penetrationAxis[1] * inv;
        c.contactNormalZ = -hit.penetrationAxis[2] * inv;
    }

    // penetration axis alone would be axis-aligned, not slope-aligned, misclassifying walkable slopes as walls.
    const body: RigidBody | undefined = rigidBody.get(world, hit.bodyIdB);
    if (body !== undefined) {
        rigidBody.getSurfaceNormal(_surfaceNormal, body, hit.pointB, hit.subShapeIdB);
        // flips if hitting the back face.
        if (
            _surfaceNormal[0] * c.contactNormalX + _surfaceNormal[1] * c.contactNormalY + _surfaceNormal[2] * c.contactNormalZ <
            0
        ) {
            _surfaceNormal[0] = -_surfaceNormal[0];
            _surfaceNormal[1] = -_surfaceNormal[1];
            _surfaceNormal[2] = -_surfaceNormal[2];
        }
        // prefers whichever normal points more upward, for edges/corners.
        if (c.contactNormalY > _surfaceNormal[1]) {
            c.surfaceNormalX = c.contactNormalX;
            c.surfaceNormalY = c.contactNormalY;
            c.surfaceNormalZ = c.contactNormalZ;
        } else {
            c.surfaceNormalX = _surfaceNormal[0];
            c.surfaceNormalY = _surfaceNormal[1];
            c.surfaceNormalZ = _surfaceNormal[2];
        }

        c.motionType = body.motionType;
        c.bodyPositionX = body.position[0];
        c.bodyPositionY = body.position[1];
        c.bodyPositionZ = body.position[2];
        if (body.motionProperties !== undefined) {
            c.linearVelocityX = body.motionProperties.linearVelocity[0];
            c.linearVelocityY = body.motionProperties.linearVelocity[1];
            c.linearVelocityZ = body.motionProperties.linearVelocity[2];
            c.angularVelocityX = body.motionProperties.angularVelocity[0];
            c.angularVelocityY = body.motionProperties.angularVelocity[1];
            c.angularVelocityZ = body.motionProperties.angularVelocity[2];
        }
    } else {
        c.surfaceNormalX = c.contactNormalX;
        c.surfaceNormalY = c.contactNormalY;
        c.surfaceNormalZ = c.contactNormalZ;
    }

    // negative distance means penetrating.
    c.distance = -hit.penetration;
    c.fraction = 0;
    c.positionX = hit.pointB[0];
    c.positionY = hit.pointB[1];
    c.positionZ = hit.pointB[2];
    c.bodyId = hit.bodyIdB;
    c.subShapeId = hit.subShapeIdB;
    c.subAabbIndex = -1;
    c.stateId = 0;

    if (!listener) return;

    const listenerBody = rigidBody.get(world, hit.bodyIdB);
    if (!listenerBody) return;

    // callback contactNormal points into the surface (away from character).
    _emit_contactPos[0] = c.positionX;
    _emit_contactPos[1] = c.positionY;
    _emit_contactPos[2] = c.positionZ;
    _emit_contactNormal[0] = -c.contactNormalX;
    _emit_contactNormal[1] = -c.contactNormalY;
    _emit_contactNormal[2] = -c.contactNormalZ;

    if (listener.onContactValidate) {
        const accepted = listener.onContactValidate(vcc, listenerBody, c.subShapeId, _emit_contactPos, _emit_contactNormal);
        if (!accepted) {
            c.wasDiscarded = true;
            return;
        }
    }

    if (listener.onContactAdded || listener.onContactPersisted) {
        const packedKey = packListenerContactKey(c.bodyId, c.subShapeId);
        const tracked = findListenerContact(vcc.listenerContacts, packedKey);

        _emit_settings.canPushCharacter = true;

        if (tracked) {
            if (tracked.count === 0) {
                tracked.count = 1;
                if (listener.onContactPersisted) {
                    listener.onContactPersisted(
                        vcc,
                        listenerBody,
                        c.subShapeId,
                        _emit_contactPos,
                        _emit_contactNormal,
                        _emit_settings,
                    );
                }
                tracked.settings.canPushCharacter = _emit_settings.canPushCharacter;
            } else {
                _emit_settings.canPushCharacter = tracked.settings.canPushCharacter;
            }
        } else {
            if (listener.onContactAdded) {
                listener.onContactAdded(vcc, listenerBody, c.subShapeId, _emit_contactPos, _emit_contactNormal, _emit_settings);
            }
            const value = acquireListenerContact(vcc.listenerContacts);
            value.packedKey = packedKey;
            value.bodyId = c.bodyId;
            value.subShapeId = c.subShapeId;
            value.count = 1;
            value.settings.canPushCharacter = _emit_settings.canPushCharacter;
        }

        c.canPushCharacter = _emit_settings.canPushCharacter;
    }
}

/** gathers body contacts at the current position via overlap; voxels are handled separately by the sweep-and-slide loop. */
function getContactsAtPosition(world: World, vcc: VCC, listener: VccListener | undefined): void {
    releaseContacts(vcc.contacts, vcc.contactsPool);

    boxCenterFromFeet(_gatherCenter, vcc.position, vcc.halfExtents);

    const padding = vcc.predictiveContactDistance + vcc.characterPadding;

    // predictive contacts (maxSeparationDistance = padding) give the solver flush-wall constraints for slideAlongEdge.
    const sh = vcc.bodyOverlapHalfExtents;
    if (sh[0] !== vcc.halfExtents[0] || sh[1] !== vcc.halfExtents[1] || sh[2] !== vcc.halfExtents[2]) {
        sh[0] = vcc.halfExtents[0];
        sh[1] = vcc.halfExtents[1];
        sh[2] = vcc.halfExtents[2];
        vcc.bodyOverlapShape = box.create({ halfExtents: sh });
    }

    vcc.bodyOverlapSettings.maxSeparationDistance = padding;
    vcc.bodyOverlapSettings.collideOnlyWithActiveEdges = false;
    vcc.bodyOverlapCollector.reset();

    collideShape(
        world,
        vcc.bodyOverlapCollector,
        vcc.bodyOverlapSettings,
        vcc.bodyOverlapShape,
        _gatherCenter,
        _gatherIdentityQuat,
        _gatherScaleOne,
        vcc.bodyFilter,
    );

    const hits = vcc.bodyOverlapCollector.hits;
    for (let i = 0; i < hits.length; i++) {
        emitBodyContact(world, vcc, hits[i]!, vcc.contacts, vcc.contactsPool, listener);
    }
}

const _bodyCastSettings: CastShapeSettings = createDefaultCastShapeSettings();
const _bodyCastCollector: ClosestCastShapeCollector = createClosestCastShapeCollector();
const _sweepCenter: Vec3 = [0, 0, 0];
const _sweepDisp: Vec3 = [0, 0, 0];
const _sweepFeet: Vec3 = [0, 0, 0];
const _sweepIdentityQuat: Quat = [0, 0, 0, 1];
const _sweepScaleOne: Vec3 = [1, 1, 1];

/** finds the earliest contact along a sweep from position (feet) by displacement; fills outContact and returns true on hit. */
const _aabbSweepResult: SweepResult = {
    toi: Infinity,
    axis: -1,
    sign: 0,
    nX: 0,
    nY: 0,
    nZ: 0,
    overlapDepth: 0,
};

function getFirstContactForSweep(
    world: World,
    voxels: Voxels,
    aabbWorld: AabbPhysics.World,
    vcc: VCC,
    feetX: number,
    feetY: number,
    feetZ: number,
    dispX: number,
    dispY: number,
    dispZ: number,
    outContact: VccContact,
): boolean {
    _sweepCenter[0] = feetX;
    _sweepCenter[1] = feetY + vcc.halfExtents[1];
    _sweepCenter[2] = feetZ;
    _sweepDisp[0] = dispX;
    _sweepDisp[1] = dispY;
    _sweepDisp[2] = dispZ;

    // accumulates crossed passable cells into vcc.sweep across this move's segments.
    const voxelHit = sweepAabbVsVoxels(
        vcc.sweep,
        voxels,
        _sweepCenter[0],
        _sweepCenter[1],
        _sweepCenter[2],
        vcc.halfExtents[0],
        vcc.halfExtents[1],
        vcc.halfExtents[2],
        dispX,
        dispY,
        dispZ,
        true,
    );
    let bestFraction = voxelHit ? vcc.sweep.toi : Infinity;
    let voxelWon = voxelHit;

    _bodyCastCollector.reset();
    _bodyCastSettings.activeEdgeMovementDirection[0] = dispX;
    _bodyCastSettings.activeEdgeMovementDirection[1] = dispY;
    _bodyCastSettings.activeEdgeMovementDirection[2] = dispZ;

    _sweepFeet[0] = feetX;
    _sweepFeet[1] = feetY;
    _sweepFeet[2] = feetZ;
    castShape(
        world,
        _bodyCastCollector,
        _bodyCastSettings,
        vcc.innerBody.shape,
        _sweepFeet,
        _sweepIdentityQuat,
        _sweepScaleOne,
        _sweepDisp,
        vcc.bodyFilter,
    );

    let bodyHit = false;
    if (_bodyCastCollector.hit.status === CastShapeStatus.COLLIDING && _bodyCastCollector.hit.fraction < bestFraction) {
        bestFraction = _bodyCastCollector.hit.fraction;
        bodyHit = true;
        voxelWon = false;
    }

    // aabb bodies have no self entry, so self-body id is -1.
    const aabbHit = AabbPhysics.sweepBodies(
        aabbWorld,
        _sweepCenter[0],
        _sweepCenter[1],
        _sweepCenter[2],
        vcc.halfExtents[0],
        vcc.halfExtents[1],
        vcc.halfExtents[2],
        dispX,
        dispY,
        dispZ,
        vcc.collisionGroups,
        vcc.collisionMask,
        -1,
        _aabbSweepResult,
    );
    let aabbWon = false;
    if (aabbHit !== null && _aabbSweepResult.toi < bestFraction) {
        bestFraction = _aabbSweepResult.toi;
        aabbWon = true;
        voxelWon = false;
        bodyHit = false;
    }

    if (!voxelWon && !bodyHit && !aabbWon) {
        return false;
    }

    resetVccContact(outContact);

    // contact point is center - normal * halfExtents, landing on the box face along the normal.
    const hX = vcc.halfExtents[0];
    const hY = vcc.halfExtents[1];
    const hZ = vcc.halfExtents[2];

    if (voxelWon) {
        const cX = feetX + dispX * vcc.sweep.toi;
        const cY = feetY + dispY * vcc.sweep.toi + hY;
        const cZ = feetZ + dispZ * vcc.sweep.toi;
        outContact.positionX = cX - vcc.sweep.normalX * hX;
        outContact.positionY = cY - vcc.sweep.normalY * hY;
        outContact.positionZ = cZ - vcc.sweep.normalZ * hZ;
        outContact.contactNormalX = vcc.sweep.normalX;
        outContact.contactNormalY = vcc.sweep.normalY;
        outContact.contactNormalZ = vcc.sweep.normalZ;
        outContact.surfaceNormalX = vcc.sweep.normalX;
        outContact.surfaceNormalY = vcc.sweep.normalY;
        outContact.surfaceNormalZ = vcc.sweep.normalZ;
        outContact.distance = 0;
        outContact.fraction = vcc.sweep.toi;
        outContact.overlapDepth = vcc.sweep.overlapDepth;
        outContact.bodyId = INVALID_BODY_ID;
        outContact.voxelX = vcc.sweep.vx;
        outContact.voxelY = vcc.sweep.vy;
        outContact.voxelZ = vcc.sweep.vz;
        outContact.subAabbIndex = vcc.sweep.subAabbIndex;
        outContact.stateId = vcc.sweep.stateId;
        outContact.motionType = MotionType.STATIC;
        return true;
    }

    if (aabbWon && aabbHit !== null) {
        const r = _aabbSweepResult;
        const cX = feetX + dispX * r.toi;
        const cY = feetY + dispY * r.toi + hY;
        const cZ = feetZ + dispZ * r.toi;
        outContact.positionX = cX - r.nX * hX;
        outContact.positionY = cY - r.nY * hY;
        outContact.positionZ = cZ - r.nZ * hZ;
        outContact.contactNormalX = r.nX;
        outContact.contactNormalY = r.nY;
        outContact.contactNormalZ = r.nZ;
        outContact.surfaceNormalX = r.nX;
        outContact.surfaceNormalY = r.nY;
        outContact.surfaceNormalZ = r.nZ;
        outContact.distance = 0;
        outContact.fraction = r.toi;
        outContact.overlapDepth = r.overlapDepth;
        outContact.bodyId = INVALID_BODY_ID;
        outContact.aabbBodyId = aabbHit.id;
        outContact.motionType = aabbHit.motionType;
        outContact.bodyPositionX = aabbHit.position[0];
        outContact.bodyPositionY = aabbHit.position[1];
        outContact.bodyPositionZ = aabbHit.position[2];
        outContact.linearVelocityX = aabbHit.linearVelocity[0];
        outContact.linearVelocityY = aabbHit.linearVelocity[1];
        outContact.linearVelocityZ = aabbHit.linearVelocity[2];
        return true;
    }

    const hit = _bodyCastCollector.hit;
    const cX = feetX + dispX * hit.fraction;
    const cY = feetY + dispY * hit.fraction + hY;
    const cZ = feetZ + dispZ * hit.fraction;
    outContact.positionX = cX - hit.normal[0] * hX;
    outContact.positionY = cY - hit.normal[1] * hY;
    outContact.positionZ = cZ - hit.normal[2] * hZ;
    outContact.contactNormalX = hit.normal[0];
    outContact.contactNormalY = hit.normal[1];
    outContact.contactNormalZ = hit.normal[2];

    // hit.normal can be axis-aligned even for a sloped box; getSurfaceNormal gives the real face normal.
    const body = rigidBody.get(world, hit.bodyIdB);
    if (body) {
        rigidBody.getSurfaceNormal(_surfaceNormal, body, hit.pointB, hit.subShapeIdB);
        // flips if hitting the back face.
        if (_surfaceNormal[0] * hit.normal[0] + _surfaceNormal[1] * hit.normal[1] + _surfaceNormal[2] * hit.normal[2] < 0) {
            _surfaceNormal[0] = -_surfaceNormal[0];
            _surfaceNormal[1] = -_surfaceNormal[1];
            _surfaceNormal[2] = -_surfaceNormal[2];
        }
        // prefers whichever normal points more upward.
        if (hit.normal[1] > _surfaceNormal[1]) {
            outContact.surfaceNormalX = hit.normal[0];
            outContact.surfaceNormalY = hit.normal[1];
            outContact.surfaceNormalZ = hit.normal[2];
        } else {
            outContact.surfaceNormalX = _surfaceNormal[0];
            outContact.surfaceNormalY = _surfaceNormal[1];
            outContact.surfaceNormalZ = _surfaceNormal[2];
        }

        outContact.motionType = body.motionType;
        outContact.bodyPositionX = body.position[0];
        outContact.bodyPositionY = body.position[1];
        outContact.bodyPositionZ = body.position[2];
        if (body.motionProperties) {
            outContact.linearVelocityX = body.motionProperties.linearVelocity[0];
            outContact.linearVelocityY = body.motionProperties.linearVelocity[1];
            outContact.linearVelocityZ = body.motionProperties.linearVelocity[2];
            outContact.angularVelocityX = body.motionProperties.angularVelocity[0];
            outContact.angularVelocityY = body.motionProperties.angularVelocity[1];
            outContact.angularVelocityZ = body.motionProperties.angularVelocity[2];
        }
    } else {
        outContact.surfaceNormalX = hit.normal[0];
        outContact.surfaceNormalY = hit.normal[1];
        outContact.surfaceNormalZ = hit.normal[2];
        outContact.motionType = MotionType.STATIC;
    }

    outContact.distance = 0;
    outContact.fraction = hit.fraction;
    outContact.overlapDepth = 0;
    outContact.bodyId = hit.bodyIdB;
    outContact.subShapeId = hit.subShapeIdB;
    outContact.subAabbIndex = -1;
    outContact.stateId = 0;
    return true;
}

const _moveShape_velocity = vec3.create();
const _moveShape_displacement = vec3.create();
const _moveShape_sweepContact: VccContact = createVccContact();
const _moveShape_impactVel = vec3.create();
const _moveShape_bounceNormal = vec3.create();
const _moveShape_zeroVec = vec3.create();
const _moveShape_constraints: VccConstraint[] = [];
const _moveShape_ignoredContacts: VccContact[] = [];

function sameContactFeature(a: VccContact, b: VccContact): boolean {
    if (a.bodyId !== b.bodyId) return false;
    if (a.bodyId !== INVALID_BODY_ID) {
        return a.subAabbIndex === b.subAabbIndex;
    }
    return a.voxelX === b.voxelX && a.voxelY === b.voxelY && a.voxelZ === b.voxelZ && a.subAabbIndex === b.subAabbIndex;
}

function isIgnoredContact(contact: VccContact, ignored: VccContact[]): boolean {
    for (let i = 0; i < ignored.length; i++) {
        if (sameContactFeature(contact, ignored[i]!)) return true;
    }
    return false;
}

// gather-solve-sweep-verify slide loop for one tick's worth of movement.
function moveShape(
    world: World,
    voxels: Voxels,
    aabbWorld: AabbPhysics.World,
    vcc: VCC,
    velocity: Vec3,
    deltaTime: number,
    listener: VccListener | undefined,
): void {
    vec3.copy(_moveShape_velocity, velocity);
    let timeRemaining = deltaTime;
    _moveShape_ignoredContacts.length = 0;

    vcc.bestSweepHitNormalY = -Infinity;
    vcc.hasBestSweepHit = false;

    // nudges velocity down when grounded and idle so the sweep still finds the floor.
    if (vcc.groundState === GROUND_STATE_ON_GROUND && Math.abs(_moveShape_velocity[1]) < 1e-4) {
        _moveShape_velocity[1] = -(vcc.characterPadding + vcc.predictiveContactDistance);
    }

    for (let iter = 0; iter < vcc.maxCollisionIterations; iter++) {
        if (timeRemaining < vcc.minTimeRemaining) break;

        getContactsAtPosition(world, vcc, listener);
        vcc.contacts.sort(compareContactsStable);
        reduceNearDuplicateContacts(vcc.contacts);

        removeConflictingContacts(vcc.contacts, vcc.characterPadding);

        determineConstraints(vcc, vcc.contacts, deltaTime, _moveShape_constraints);

        let timeSimulated = solveConstraints(
            world,
            vcc,
            _moveShape_velocity,
            timeRemaining,
            _moveShape_constraints,
            _moveShape_displacement,
            listener,
        );

        for (let i = 0; i < vcc.contacts.length; i++) {
            const c = vcc.contacts[i]!;
            if (!c.wasDiscarded) continue;
            if (!isIgnoredContact(c, _moveShape_ignoredContacts)) {
                const kept = acquireVccContact(_moveShape_ignoredContacts, vcc.contactsPool);
                copyVccContact(kept, c);
            }
        }

        if (
            getFirstContactForSweep(
                world,
                voxels,
                aabbWorld,
                vcc,
                vcc.position[0],
                vcc.position[1],
                vcc.position[2],
                _moveShape_displacement[0],
                _moveShape_displacement[1],
                _moveShape_displacement[2],
                _moveShape_sweepContact,
            )
        ) {
            if (isIgnoredContact(_moveShape_sweepContact, _moveShape_ignoredContacts)) {
                vcc.position[0] += _moveShape_displacement[0];
                vcc.position[1] += _moveShape_displacement[1];
                vcc.position[2] += _moveShape_displacement[2];
                timeRemaining -= timeSimulated;
                continue;
            }

            const fraction = _moveShape_sweepContact.fraction;
            let applyNormalSlide = true;

            // captured before the slide below cancels the into-normal component; needed by the bounce listener.
            vec3.copy(_moveShape_impactVel, _moveShape_velocity);
            if (fraction < 0) {
                const nX = _moveShape_sweepContact.contactNormalX;
                const nY = _moveShape_sweepContact.contactNormalY;
                const nZ = _moveShape_sweepContact.contactNormalZ;

                // zeroes the other axes too, so a flush-wall iteration can't compound tangential motion across iterations.
                const depth = _moveShape_sweepContact.overlapDepth;
                const absX = nX < 0 ? -nX : nX;
                const absY = nY < 0 ? -nY : nY;
                const absZ = nZ < 0 ? -nZ : nZ;
                let hitAxis = 0;
                if (absX >= absY && absX >= absZ) {
                    hitAxis = 0;
                    _moveShape_displacement[0] = nX * depth;
                    _moveShape_displacement[1] = 0;
                    _moveShape_displacement[2] = 0;
                } else if (absY >= absZ) {
                    hitAxis = 1;
                    _moveShape_displacement[1] = nY * depth;
                    _moveShape_displacement[0] = 0;
                    _moveShape_displacement[2] = 0;
                } else {
                    hitAxis = 2;
                    _moveShape_displacement[2] = nZ * depth;
                    _moveShape_displacement[0] = 0;
                    _moveShape_displacement[1] = 0;
                }
                if (_moveShape_sweepContact.bodyId === INVALID_BODY_ID) {
                    _moveShape_velocity[hitAxis] = 0;
                    applyNormalSlide = false;
                }

                timeSimulated = 0;
            } else {
                _moveShape_displacement[0] *= fraction;
                _moveShape_displacement[1] *= fraction;
                _moveShape_displacement[2] *= fraction;
                timeSimulated *= fraction;
            }

            const nX = _moveShape_sweepContact.contactNormalX;
            const nY = _moveShape_sweepContact.contactNormalY;
            const nZ = _moveShape_sweepContact.contactNormalZ;
            if (applyNormalSlide) {
                const vDotN = _moveShape_velocity[0] * nX + _moveShape_velocity[1] * nY + _moveShape_velocity[2] * nZ;
                if (vDotN < 0) {
                    _moveShape_velocity[0] -= nX * vDotN;
                    _moveShape_velocity[1] -= nY * vDotN;
                    _moveShape_velocity[2] -= nZ * vDotN;
                }
            }

            // negates the sweep normal to the into-surface convention shared with the solver path listener call.
            if (listener?.onContactSolve && _moveShape_sweepContact.bodyId === INVALID_BODY_ID) {
                _moveShape_bounceNormal[0] = -_moveShape_sweepContact.contactNormalX;
                _moveShape_bounceNormal[1] = -_moveShape_sweepContact.contactNormalY;
                _moveShape_bounceNormal[2] = -_moveShape_sweepContact.contactNormalZ;
                listener.onContactSolve(
                    vcc,
                    null,
                    _moveShape_sweepContact.stateId,
                    _moveShape_zeroVec,
                    _moveShape_bounceNormal,
                    _moveShape_zeroVec,
                    _moveShape_impactVel,
                    _moveShape_velocity,
                );
            }

            // character has infinite mass; body.mass is the per-body push-strength knob.
            if (_moveShape_sweepContact.aabbBodyId !== -1) {
                const pushTarget = aabbWorld.bodies.get(_moveShape_sweepContact.aabbBodyId);
                if (pushTarget?.pushable && !pushTarget.sensor && pushTarget.motionType === AabbPhysics.MotionType.DYNAMIC) {
                    const vAn = _moveShape_velocity[0] * nX + _moveShape_velocity[1] * nY + _moveShape_velocity[2] * nZ;
                    const vBn =
                        pushTarget.linearVelocity[0] * nX + pushTarget.linearVelocity[1] * nY + pushTarget.linearVelocity[2] * nZ;
                    const vRelN = vAn - vBn;
                    if (vRelN < 0) {
                        // impulse magnitude -vRelN along -normal; wakes the body from sleep.
                        const J = -vRelN;
                        AabbPhysics.applyImpulse(aabbWorld, pushTarget, -nX * J, -nY * J, -nZ * J);
                    }
                }
            }

            // tracks the most-up-pointing hit; emitted into vcc.contacts after the loop so the next gather doesn't drop it.
            if (fraction >= 0 && nY > vcc.bestSweepHitNormalY) {
                vcc.bestSweepHitNormalY = nY;
                copyVccContact(vcc.bestSweepHit, _moveShape_sweepContact);
                vcc.hasBestSweepHit = true;
            }
        }

        vcc.position[0] += _moveShape_displacement[0];
        vcc.position[1] += _moveShape_displacement[1];
        vcc.position[2] += _moveShape_displacement[2];
        timeRemaining -= timeSimulated;

        // must not break on zero displacement; a flush-surface clamp produces one and the next iteration slides along it.
    }

    releaseConstraints(_moveShape_constraints, vcc.constraintsPool);
    releaseContacts(_moveShape_ignoredContacts, vcc.contactsPool);
    vec3.copy(velocity, _moveShape_velocity);

    // emitted post-loop since each iteration's gather clears vcc.contacts.
    if (vcc.hasBestSweepHit) {
        const out = acquireVccContact(vcc.contacts, vcc.contactsPool);
        copyVccContact(out, vcc.bestSweepHit);
        out.distance = 0;
    }
}

const _ground_avgNormal = vec3.create();
const _ground_avgVel = vec3.create();
const _ground_cornerDownVel = vec3.create();
const _ground_cornerDisp = vec3.create();
const _ground_cornerConstraints: VccConstraint[] = [];

function contactGroundVelocityAtCharacter(vcc: VCC, c: VccContact, out: Vec3): void {
    out[0] = c.linearVelocityX;
    out[1] = c.linearVelocityY;
    out[2] = c.linearVelocityZ;
    if (c.motionType !== MotionType.KINEMATIC) return;

    const rx = vcc.position[0] - c.bodyPositionX;
    const ry = vcc.position[1] - c.bodyPositionY;
    const rz = vcc.position[2] - c.bodyPositionZ;
    const wx = c.angularVelocityX;
    const wy = c.angularVelocityY;
    const wz = c.angularVelocityZ;

    out[0] += wy * rz - wz * ry;
    out[1] += wz * rx - wx * rz;
    out[2] += wx * ry - wy * rx;
}

const _ground_contactVel = vec3.create();

/** flag colliding contacts + compute supporting state from `vcc.contacts`. */
function updateGroundState(world: World, vcc: VCC): void {
    const contacts = vcc.contacts;

    // no relative-velocity gate here; too strict for rotated bodies whose point-velocity is only linear-estimated.
    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]!;
        if (c.wasDiscarded || c.hadCollision) continue;
        if (c.distance >= vcc.collisionTolerance) continue;
        c.hadCollision = true;
    }

    let numSupported = 0;
    let numSliding = 0;
    let numAvg = 0;
    vec3.zero(_ground_avgNormal);
    vec3.zero(_ground_avgVel);

    let supporting: VccContact | null = null;
    let maxCos = -Infinity;
    let deepest: VccContact | null = null;
    let smallestDistance = Infinity;

    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]!;
        if (!c.hadCollision || c.wasDiscarded) continue;

        const cosAngle = c.surfaceNormalX * UP_X + c.surfaceNormalY * UP_Y + c.surfaceNormalZ * UP_Z;
        if (c.distance < smallestDistance) {
            deepest = c;
            smallestDistance = c.distance;
        }

        if (cosAngle > maxCos) {
            supporting = c;
            maxCos = cosAngle;
        }

        if (cosAngle >= vcc.cosMaxSlopeAngle) {
            numSupported++;
        } else {
            numSliding++;
        }

        // contacts within about 85 degrees of up contribute to avg normal/vel.
        if (cosAngle >= 0.08) {
            _ground_avgNormal[0] += c.surfaceNormalX;
            _ground_avgNormal[1] += c.surfaceNormalY;
            _ground_avgNormal[2] += c.surfaceNormalZ;
            const isSupported = cosAngle >= vcc.cosMaxSlopeAngle;
            if (c.motionType === MotionType.KINEMATIC && isSupported) {
                contactGroundVelocityAtCharacter(vcc, c, _ground_contactVel);
                _ground_avgVel[0] += _ground_contactVel[0];
                _ground_avgVel[1] += _ground_contactVel[1];
                _ground_avgVel[2] += _ground_contactVel[2];
            } else {
                _ground_avgVel[0] += c.linearVelocityX;
                _ground_avgVel[1] += c.linearVelocityY;
                _ground_avgVel[2] += c.linearVelocityZ;
            }
            numAvg++;
        }
    }

    const best = supporting ?? deepest;

    if (numAvg >= 1) {
        vec3.normalize(vcc.groundNormal, _ground_avgNormal);
        vec3.scale(vcc.groundVelocity, _ground_avgVel, 1 / numAvg);
    } else if (best) {
        vcc.groundNormal[0] = best.surfaceNormalX;
        vcc.groundNormal[1] = best.surfaceNormalY;
        vcc.groundNormal[2] = best.surfaceNormalZ;
        const bestCos = best.surfaceNormalY;
        if (best.motionType === MotionType.KINEMATIC && bestCos >= vcc.cosMaxSlopeAngle) {
            contactGroundVelocityAtCharacter(vcc, best, vcc.groundVelocity);
        } else {
            vcc.groundVelocity[0] = best.linearVelocityX;
            vcc.groundVelocity[1] = best.linearVelocityY;
            vcc.groundVelocity[2] = best.linearVelocityZ;
        }
    } else {
        vec3.zero(vcc.groundNormal);
        vec3.zero(vcc.groundVelocity);
    }

    if (best) {
        vcc.groundBodyId = best.bodyId;
        vcc.groundPosition[0] = best.positionX;
        vcc.groundPosition[1] = best.positionY;
        vcc.groundPosition[2] = best.positionZ;
        vcc.groundVoxelX = best.voxelX;
        vcc.groundVoxelY = best.voxelY;
        vcc.groundVoxelZ = best.voxelZ;
        vcc.groundVoxelStateId = best.stateId;
    } else {
        vcc.groundBodyId = INVALID_BODY_ID;
        vec3.zero(vcc.groundPosition);
        vcc.groundVoxelX = 0;
        vcc.groundVoxelY = 0;
        vcc.groundVoxelZ = 0;
        vcc.groundVoxelStateId = 0;
    }

    if (numSupported > 0) {
        vcc.groundState = GROUND_STATE_ON_GROUND;
    } else if (numSliding > 0) {
        if (deepest) {
            const relVelDotUp =
                (vcc.linearVelocity[0] - deepest.linearVelocityX) * UP_X +
                (vcc.linearVelocity[1] - deepest.linearVelocityY) * UP_Y +
                (vcc.linearVelocity[2] - deepest.linearVelocityZ) * UP_Z;

            if (relVelDotUp > 1e-4) {
                vcc.groundState = GROUND_STATE_ON_STEEP_GROUND;
            } else {
                // runs a mini solve with -up velocity to check whether the character is wedged in a concave corner.
                determineConstraints(vcc, contacts, vcc.lastDeltaTime, _ground_cornerConstraints);
                _ground_cornerDownVel[0] = -UP_X;
                _ground_cornerDownVel[1] = -UP_Y;
                _ground_cornerDownVel[2] = -UP_Z;
                const timeSimulated = solveConstraints(
                    world,
                    vcc,
                    _ground_cornerDownVel,
                    1.0,
                    _ground_cornerConstraints,
                    _ground_cornerDisp,
                    undefined,
                );
                releaseConstraints(_ground_cornerConstraints, vcc.constraintsPool);

                const minRequiredDisplacementSq = 0.36 * vcc.lastDeltaTime * vcc.lastDeltaTime;
                const dispLenSq =
                    _ground_cornerDisp[0] * _ground_cornerDisp[0] +
                    _ground_cornerDisp[1] * _ground_cornerDisp[1] +
                    _ground_cornerDisp[2] * _ground_cornerDisp[2];

                if (timeSimulated < 0.001 || dispLenSq < minRequiredDisplacementSq) {
                    vcc.groundState = GROUND_STATE_ON_GROUND;
                } else {
                    vcc.groundState = GROUND_STATE_ON_STEEP_GROUND;
                }
            }
        } else {
            vcc.groundState = GROUND_STATE_ON_STEEP_GROUND;
        }
    } else if (best !== null) {
        vcc.groundState = GROUND_STATE_NOT_SUPPORTED;
    } else {
        vcc.groundState = GROUND_STATE_IN_AIR;
    }
}

function syncInnerBody(world: World, vcc: VCC): void {
    rigidBody.setPosition(world, vcc.innerBody, vcc.position, true);
}

function finalizeContactTracking(world: World, vcc: VCC, listener: VccListener | undefined): void {
    const lcp = vcc.listenerContacts;
    for (let i = 0; i < lcp.active.length; i++) lcp.active[i]!.count = 0;
    for (let i = 0; i < vcc.contacts.length; i++) {
        const c = vcc.contacts[i]!;
        if (c.bodyId === INVALID_BODY_ID || !c.hadCollision) continue;
        const packed = packListenerContactKey(c.bodyId, c.subShapeId);
        const tracked = findListenerContact(lcp, packed);
        if (tracked) tracked.count = 1;
    }
    if (listener?.onContactRemoved) {
        for (let i = 0; i < lcp.active.length; i++) {
            const v = lcp.active[i]!;
            if (v.count === 0) {
                const body = rigidBody.get(world, v.bodyId);
                if (body) listener.onContactRemoved(vcc, body, v.subShapeId);
            }
        }
    }
    releaseAllListenerContacts(lcp);
}

/** teleport: reset position without integrating motion. */
export function setPosition(world: World, vcc: VCC, x: number, y: number, z: number): void {
    vcc.position[0] = x;
    vcc.position[1] = y;
    vcc.position[2] = z;
    syncInnerBody(world, vcc);
}

/** advances the character by one tick; walkStairs / stickToFloor run as explicit post-passes after this. */
export function move(
    world: World,
    voxels: Voxels,
    aabbWorld: AabbPhysics.World,
    vcc: VCC,
    deltaTime: number,
    listener?: VccListener,
): void {
    if (deltaTime <= 0) return;
    vcc.lastDeltaTime = deltaTime;

    // clears last move's swept-cell accumulation before this move starts.
    vcc.sweep.crossed.count = 0;

    moveShape(world, voxels, aabbWorld, vcc, vcc.linearVelocity, deltaTime, listener);
    updateGroundState(world, vcc);
    syncInnerBody(world, vcc);
    finalizeContactTracking(world, vcc, listener);
}

const _stick_contact: VccContact = createVccContact();

/** sweeps down by stepDownY; on hit, snaps to the contact and forces ground state to ON_GROUND. */
export function stickToFloor(world: World, voxels: Voxels, aabbWorld: AabbPhysics.World, vcc: VCC, stepDownY: number): boolean {
    if (stepDownY === 0) return false;

    if (
        !getFirstContactForSweep(
            world,
            voxels,
            aabbWorld,
            vcc,
            vcc.position[0],
            vcc.position[1],
            vcc.position[2],
            0,
            stepDownY,
            0,
            _stick_contact,
        )
    ) {
        return false;
    }

    vcc.position[0] += 0;
    vcc.position[1] += stepDownY * _stick_contact.fraction;
    vcc.position[2] += 0;

    syncInnerBody(world, vcc);

    vcc.groundState = GROUND_STATE_ON_GROUND;
    vcc.groundNormal[0] = _stick_contact.surfaceNormalX;
    vcc.groundNormal[1] = _stick_contact.surfaceNormalY;
    vcc.groundNormal[2] = _stick_contact.surfaceNormalZ;
    vcc.groundVelocity[0] = _stick_contact.linearVelocityX;
    vcc.groundVelocity[1] = _stick_contact.linearVelocityY;
    vcc.groundVelocity[2] = _stick_contact.linearVelocityZ;
    vcc.groundBodyId = _stick_contact.bodyId;
    vcc.groundPosition[0] = _stick_contact.positionX;
    vcc.groundPosition[1] = _stick_contact.positionY;
    vcc.groundPosition[2] = _stick_contact.positionZ;
    vcc.groundVoxelX = _stick_contact.voxelX;
    vcc.groundVoxelY = _stick_contact.voxelY;
    vcc.groundVoxelZ = _stick_contact.voxelZ;
    vcc.groundVoxelStateId = _stick_contact.stateId;

    return true;
}

const _walk_savedPosition: Vec3 = [0, 0, 0];
const _walk_upContact: VccContact = createVccContact();
const _walk_horizContact: VccContact = createVccContact();
const _walk_downContact: VccContact = createVccContact();
const _walk_steepNormals: Array<{ x: number; y: number; z: number }> = [];

/** attempts to step up and over an obstacle; returns true on commit, false if any test failed (position unchanged). */
export function walkStairs(
    world: World,
    voxels: Voxels,
    aabbWorld: AabbPhysics.World,
    vcc: VCC,
    stepUpY: number,
    stepForwardX: number,
    stepForwardZ: number,
    stepForwardTestX: number,
    stepForwardTestZ: number,
    stepDownExtraY: number,
): boolean {
    if (stepUpY <= 0) return false;
    if (stepForwardX === 0 && stepForwardZ === 0) return false;

    _walk_savedPosition[0] = vcc.position[0];
    _walk_savedPosition[1] = vcc.position[1];
    _walk_savedPosition[2] = vcc.position[2];

    let upY = stepUpY;
    if (
        getFirstContactForSweep(
            world,
            voxels,
            aabbWorld,
            vcc,
            vcc.position[0],
            vcc.position[1],
            vcc.position[2],
            0,
            stepUpY,
            0,
            _walk_upContact,
        )
    ) {
        // small float buffer to avoid landing exactly on the ceiling.
        upY = Math.max(0, stepUpY * _walk_upContact.fraction - 1e-3);
        if (upY <= 0) return false;
    }
    vcc.position[1] += upY;

    _walk_steepNormals.length = 0;
    const moveLenSq = stepForwardX * stepForwardX + stepForwardZ * stepForwardZ;
    if (moveLenSq > 1e-12) {
        const inv = 1 / Math.sqrt(moveLenSq);
        const dirX = stepForwardX * inv;
        const dirZ = stepForwardZ * inv;
        for (let i = 0; i < vcc.contacts.length; i++) {
            const c = vcc.contacts[i]!;
            if (!c.hadCollision || c.wasDiscarded) continue;
            const surfDotUp = c.surfaceNormalX * UP_X + c.surfaceNormalY * UP_Y + c.surfaceNormalZ * UP_Z;
            if (surfDotUp >= vcc.cosMaxSlopeAngle) continue;
            const nDotMove = -(c.contactNormalX * dirX + c.contactNormalZ * dirZ);
            if (nDotMove <= 1e-4) continue;
            _walk_steepNormals.push({ x: c.contactNormalX, y: c.contactNormalY, z: c.contactNormalZ });
        }
    }

    if (
        getFirstContactForSweep(
            world,
            voxels,
            aabbWorld,
            vcc,
            vcc.position[0],
            vcc.position[1],
            vcc.position[2],
            stepForwardX,
            0,
            stepForwardZ,
            _walk_horizContact,
        )
    ) {
        const f = _walk_horizContact.fraction;
        vcc.position[0] += stepForwardX * f;
        vcc.position[2] += stepForwardZ * f;
    } else {
        vcc.position[0] += stepForwardX;
        vcc.position[2] += stepForwardZ;
    }

    // require at least 2% horizontal progress against steep walls we're pushing into.
    if (_walk_steepNormals.length > 0) {
        const dx = vcc.position[0] - _walk_savedPosition[0];
        const dz = vcc.position[2] - _walk_savedPosition[2];
        let progressed = false;
        for (let i = 0; i < _walk_steepNormals.length; i++) {
            const n = _walk_steepNormals[i]!;
            const into = -(dx * n.x + dz * n.z);
            if (into >= Math.sqrt(stepForwardX * stepForwardX + stepForwardZ * stepForwardZ) * 0.02) {
                progressed = true;
                break;
            }
        }
        if (!progressed) {
            vcc.position[0] = _walk_savedPosition[0];
            vcc.position[1] = _walk_savedPosition[1];
            vcc.position[2] = _walk_savedPosition[2];
            return false;
        }
    }

    const dropY = -(stepUpY + stepDownExtraY);
    if (
        !getFirstContactForSweep(
            world,
            voxels,
            aabbWorld,
            vcc,
            vcc.position[0],
            vcc.position[1],
            vcc.position[2],
            0,
            dropY,
            0,
            _walk_downContact,
        )
    ) {
        vcc.position[0] = _walk_savedPosition[0];
        vcc.position[1] = _walk_savedPosition[1];
        vcc.position[2] = _walk_savedPosition[2];
        return false;
    }
    const downFraction = _walk_downContact.fraction;
    const landingCosAngle =
        _walk_downContact.surfaceNormalX * UP_X +
        _walk_downContact.surfaceNormalY * UP_Y +
        _walk_downContact.surfaceNormalZ * UP_Z;

    if (landingCosAngle < vcc.cosMaxSlopeAngle) {
        if (stepForwardTestX === 0 && stepForwardTestZ === 0) {
            vcc.position[0] = _walk_savedPosition[0];
            vcc.position[1] = _walk_savedPosition[1];
            vcc.position[2] = _walk_savedPosition[2];
            return false;
        }
        const testY = vcc.position[1] + dropY * downFraction;
        if (
            getFirstContactForSweep(
                world,
                voxels,
                aabbWorld,
                vcc,
                vcc.position[0],
                testY,
                vcc.position[2],
                stepForwardTestX,
                0,
                stepForwardTestZ,
                _walk_downContact,
            )
        ) {
            vcc.position[0] = _walk_savedPosition[0];
            vcc.position[1] = _walk_savedPosition[1];
            vcc.position[2] = _walk_savedPosition[2];
            return false;
        }
    }

    vcc.position[1] += dropY * downFraction;

    syncInnerBody(world, vcc);
    vcc.groundState = GROUND_STATE_ON_GROUND;
    vcc.groundNormal[0] = _walk_downContact.surfaceNormalX;
    vcc.groundNormal[1] = _walk_downContact.surfaceNormalY;
    vcc.groundNormal[2] = _walk_downContact.surfaceNormalZ;
    vcc.groundVelocity[0] = _walk_downContact.linearVelocityX;
    vcc.groundVelocity[1] = _walk_downContact.linearVelocityY;
    vcc.groundVelocity[2] = _walk_downContact.linearVelocityZ;
    vcc.groundBodyId = _walk_downContact.bodyId;
    vcc.groundPosition[0] = _walk_downContact.positionX;
    vcc.groundPosition[1] = _walk_downContact.positionY;
    vcc.groundPosition[2] = _walk_downContact.positionZ;
    vcc.groundVoxelX = _walk_downContact.voxelX;
    vcc.groundVoxelY = _walk_downContact.voxelY;
    vcc.groundVoxelZ = _walk_downContact.voxelZ;
    vcc.groundVoxelStateId = _walk_downContact.stateId;

    return true;
}
