import * as crashcat from 'crashcat';
import { type Vec3, vec3 } from 'math';
import type { AabbBodyTrait as AabbBodyTraitInstance } from '../../../builtins/aabb-body';
import type { TransformTrait } from '../../../builtins/transform';
import { getWorldPosition, hasTransformedParent, markTransformDirty, worldToLocalPosition } from '../../../builtins/transform';
import type { PlayerId } from '../../client';
import { BLOCK_FLAG_COLLISION } from '../../voxels/block-registry';
import { createVoxelSweepHit, sweepAabbVsVoxels, type VoxelSweepHit } from '../../voxels/voxel-aabb-sweep';
import type { World as RigidWorld } from '../rigid/rigid-world';
import { OBJECT_LAYER_AABB_IMPOSTOR } from '../rigid/rigid-world-settings';
import { querySpatialHash } from './aabb-broadphase';
import { type SweepResult, sweepAabbVsAabb } from './aabb-sweep';
import {
    addToAwakeSet,
    type Body,
    type BodyId,
    type BodyOpts,
    MotionType,
    markBodyActive,
    moveInBroadphase,
    type PairInfo,
    type PairSink,
    removeFromAwakeSet,
    removeFromBroadphase,
    SLEEP_RESET_FRAMES,
    sleepBody,
    type World,
    wakeSleepingNeighbors,
} from './aabb-world';

export function createBody(world: World, crashcatWorld: crashcat.World, opts: BodyOpts): Body {
    const id = world._nextId++;
    const body: Body = {
        id,
        position: vec3.fromValues(opts.position[0], opts.position[1], opts.position[2]) as Vec3,
        halfExtents: vec3.fromValues(opts.halfExtents[0], opts.halfExtents[1], opts.halfExtents[2]) as Vec3,
        linearVelocity: opts.linearVelocity
            ? (vec3.fromValues(opts.linearVelocity[0], opts.linearVelocity[1], opts.linearVelocity[2]) as Vec3)
            : (vec3.create() as Vec3),
        motionType: opts.motionType ?? MotionType.DYNAMIC,
        mass: opts.mass !== undefined && opts.mass > 0 ? opts.mass : 1,
        gravityFactor: opts.gravityFactor ?? 1,
        collisionGroups: opts.collisionGroups ?? 0xffffffff,
        collisionMask: opts.collisionMask ?? 0xffffffff,
        voxelFlagsMask: opts.voxelFlagsMask ?? BLOCK_FLAG_COLLISION,
        friction: opts.friction ?? 0.5,
        restitution: opts.restitution ?? 0,
        sensor: opts.sensor ?? false,
        pushable: opts.pushable ?? false,
        rigidBodyImpostor: opts.rigidBodyImpostor ?? false,
        _impostor: null,
        _nodeId: opts.nodeId ?? null,
        _forces: vec3.create() as Vec3,
        _impulses: vec3.create() as Vec3,
        resting: [0, 0, 0],
        _prevResting: [0, 0, 0],
        _restingStateId: [0, 0, 0],
        _prevRestingStateId: [0, 0, 0],
        _sleepFrameCount: SLEEP_RESET_FRAMES,
        _asleep: false,
        // "not inserted" sentinel, moveInBroadphase below flips this.
        _broadphaseCellMinX: 1,
        _broadphaseCellMinY: 0,
        _broadphaseCellMinZ: 0,
        _broadphaseCellMaxX: 0,
        _broadphaseCellMaxY: 0,
        _broadphaseCellMaxZ: 0,
        _awakeIndex: -1,
    };
    world.bodies.set(id, body);
    if (body._nodeId !== null) world.nodeToBody.set(body._nodeId, id);
    moveInBroadphase(world, body);
    addToAwakeSet(world, body);
    if (body.rigidBodyImpostor) installImpostor(world, crashcatWorld, body);
    return body;
}

export function destroyBody(world: World, crashcatWorld: crashcat.World, body: Body): void {
    if (body._impostor) {
        world.impostorToBody.delete(body._impostor.id);
        crashcat.rigidBody.remove(crashcatWorld, body._impostor);
        body._impostor = null;
    }
    // wake anything resting against us before we vanish from the broadphase, or it stays frozen in midair.
    wakeSleepingNeighbors(world, body);
    removeFromAwakeSet(world, body);
    removeFromBroadphase(world, body);
    if (body._nodeId !== null) world.nodeToBody.delete(body._nodeId);
    world.bodies.delete(body.id);
}

/** accumulate a continuous force (N). integrated via a = F/m over dt and cleared each tick. */
export function applyForce(world: World, body: Body, fx: number, fy: number, fz: number): void {
    body._forces[0] += fx;
    body._forces[1] += fy;
    body._forces[2] += fz;
    markBodyActive(world, body);
}

/** apply an instantaneous impulse (kg m/s). consumed and cleared each tick. */
export function applyImpulse(world: World, body: Body, ix: number, iy: number, iz: number): void {
    body._impulses[0] += ix;
    body._impulses[1] += iy;
    body._impulses[2] += iz;
    markBodyActive(world, body);
}

/** teleports: writes position directly, zeroes velocity, reslots the broadphase, and wakes the body. */
export function setPosition(world: World, body: Body, x: number, y: number, z: number): void {
    body.position[0] = x;
    body.position[1] = y;
    body.position[2] = z;
    body.linearVelocity[0] = 0;
    body.linearVelocity[1] = 0;
    body.linearVelocity[2] = 0;
    body.resting[0] = 0;
    body.resting[1] = 0;
    body.resting[2] = 0;
    body._restingStateId[0] = 0;
    body._restingStateId[1] = 0;
    body._restingStateId[2] = 0;
    moveInBroadphase(world, body);
    markBodyActive(world, body);
}

/** changes motion type; STATIC leaves the awake set, other types wake the body. */
export function setMotionType(world: World, body: Body, mt: MotionType): void {
    if (body.motionType === mt) return;
    body.motionType = mt;
    if (mt === MotionType.STATIC) {
        removeFromAwakeSet(world, body);
    } else {
        markBodyActive(world, body);
    }
}

/** overwrite velocity (kinematic drive / explicit set). wakes the body. */
export function setVelocity(world: World, body: Body, vx: number, vy: number, vz: number): void {
    body.linearVelocity[0] = vx;
    body.linearVelocity[1] = vy;
    body.linearVelocity[2] = vz;
    markBodyActive(world, body);
}

/** trait-sync helper: copies halfExtents in, reslots the broadphase, and wakes the body. */
export function setHalfExtents(world: World, body: Body, hx: number, hy: number, hz: number): void {
    body.halfExtents[0] = hx;
    body.halfExtents[1] = hy;
    body.halfExtents[2] = hz;
    moveInBroadphase(world, body);
    markBodyActive(world, body);
}

/** toggle the impostor on an existing body. called by the trait sync when the flag changes. */
export function setBodyImpostor(world: World, crashcatWorld: crashcat.World, body: Body, on: boolean): void {
    if (on === body.rigidBodyImpostor && (on === false || body._impostor !== null)) return;
    body.rigidBodyImpostor = on;
    if (on) {
        installImpostor(world, crashcatWorld, body);
    } else if (body._impostor) {
        world.impostorToBody.delete(body._impostor.id);
        crashcat.rigidBody.remove(crashcatWorld, body._impostor);
        body._impostor = null;
    }
}

/** rebuild the impostor's shape, used when halfExtents change. */
export function reinstallBodyImpostor(world: World, crashcatWorld: crashcat.World, body: Body): void {
    if (!body._impostor) return;
    world.impostorToBody.delete(body._impostor.id);
    crashcat.rigidBody.remove(crashcatWorld, body._impostor);
    body._impostor = null;
    installImpostor(world, crashcatWorld, body);
}

function installImpostor(world: World, crashcatWorld: crashcat.World, body: Body): void {
    const shape = crashcat.box.create({ halfExtents: [body.halfExtents[0], body.halfExtents[1], body.halfExtents[2]] });
    const rb = crashcat.rigidBody.create(crashcatWorld, {
        shape,
        objectLayer: OBJECT_LAYER_AABB_IMPOSTOR,
        motionType: crashcat.MotionType.KINEMATIC,
        position: [body.position[0], body.position[1], body.position[2]],
        sensor: body.sensor,
        friction: body.friction,
        restitution: body.restitution,
        collisionGroups: body.collisionGroups,
        collisionMask: body.collisionMask,
    });
    body._impostor = rb;
    world.impostorToBody.set(rb.id, body.id);
}

// takes the rigid sub-world (not the raw crashcat world) since its impostor bodies live there.

/** spawn a standalone body in `world` (no trait / node). tear down with `destroy`. */
export function create(world: World, rigid: RigidWorld, opts: BodyOpts): Body {
    return createBody(world, rigid.world, opts);
}

/** remove a body created with `create` (or trait-owned; the trait teardown calls this). */
export function destroy(world: World, rigid: RigidWorld, body: Body): void {
    destroyBody(world, rigid.world, body);
}

function effectiveAabbMotionType(t: AabbBodyTraitInstance, identity: PlayerId | null, simulate: boolean): MotionType {
    if (!simulate) return MotionType.STATIC;
    if (identity === null) return t.motionType;
    if (t._node.owner === identity) return t.motionType;
    if (t.motionType === MotionType.DYNAMIC && !t.prediction) return MotionType.KINEMATIC;
    return t.motionType;
}

function syncAabbBodyTraitToWorld(
    world: World,
    crashcatWorld: crashcat.World,
    nodeId: number,
    t: AabbBodyTraitInstance,
    transform: TransformTrait,
    identity: PlayerId | null,
    simulate: boolean,
): void {
    // first install: create the body; companion-trait attachment lives in the coordinator.
    if (!t.body) {
        const wp = getWorldPosition(transform);
        t.body = createBody(world, crashcatWorld, {
            position: wp,
            halfExtents: t.halfExtents,
            motionType: effectiveAabbMotionType(t, identity, simulate),
            mass: t.mass,
            linearVelocity: t.linearVelocity,
            gravityFactor: t.gravityFactor,
            collisionGroups: t.collisionGroups,
            collisionMask: t.collisionMask,
            voxelFlagsMask: t.voxelFlagsMask,
            friction: t.friction,
            restitution: t.restitution,
            sensor: t.sensor,
            pushable: t.pushable,
            rigidBodyImpostor: t.rigidBodyImpostor,
            nodeId,
        });
        return;
    }

    const body = t.body;

    // motionType goes through the helper so awake-set membership stays consistent across STATIC flips.
    setMotionType(world, body, effectiveAabbMotionType(t, identity, simulate));
    body.mass = t.mass > 0 ? t.mass : 1;
    body.gravityFactor = t.gravityFactor;
    body.collisionGroups = t.collisionGroups;
    body.collisionMask = t.collisionMask;
    body.voxelFlagsMask = t.voxelFlagsMask;
    body.friction = t.friction;
    body.restitution = t.restitution;
    body.sensor = t.sensor;
    body.pushable = t.pushable;

    if (
        body.halfExtents[0] !== t.halfExtents[0] ||
        body.halfExtents[1] !== t.halfExtents[1] ||
        body.halfExtents[2] !== t.halfExtents[2]
    ) {
        setHalfExtents(world, body, t.halfExtents[0], t.halfExtents[1], t.halfExtents[2]);
        if (body._impostor) reinstallBodyImpostor(world, crashcatWorld, body);
    }

    if (body.rigidBodyImpostor !== t.rigidBodyImpostor) {
        setBodyImpostor(world, crashcatWorld, body, t.rigidBodyImpostor);
    }

    // a mismatch means something external moved the node; snap, zero velocity, then re-apply t.linearVelocity if the script set it this tick.
    const wp = getWorldPosition(transform);
    if (!vec3.equals(wp, body.position)) {
        setPosition(world, body, wp[0], wp[1], wp[2]);
        if (t.linearVelocity[0] !== 0 || t.linearVelocity[1] !== 0 || t.linearVelocity[2] !== 0) {
            setVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
        }
    }

    // client-side replication smoothing: sync'd linearVelocity drives integration between sparse pose updates.
    if (identity !== null && t._node.owner !== identity && body.motionType === MotionType.KINEMATIC) {
        setVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
    }
}

/** trait/world sync: installs/updates bodies for nodes with the bound trait, destroys bodies that lost it. */
export function preStep(world: World, crashcatWorld: crashcat.World, identity: PlayerId | null, simulate: boolean): void {
    if (!world._bodyQuery) return;

    const active = new Set<number>();
    for (const [t, transform] of world._bodyQuery) {
        const node = t._node;
        active.add(node.id);
        syncAabbBodyTraitToWorld(world, crashcatWorld, node.id, t, transform, identity, simulate);
    }

    for (const nodeId of [...world.nodeToBody.keys()]) {
        if (active.has(nodeId)) continue;
        const bodyId = world.nodeToBody.get(nodeId);
        if (bodyId === undefined) continue;
        const body = world.bodies.get(bodyId);
        if (body) destroyBody(world, crashcatWorld, body);
    }
}

/** world/trait writeback for moving bodies; companion-trait management lives in the coordinator. */
export function postStep(world: World): void {
    if (!world._bodyQuery) return;

    for (const [t, transform] of world._bodyQuery) {
        const body = t.body;
        if (!body) continue;
        if (body.motionType === MotionType.STATIC) continue;

        if (hasTransformedParent(transform)) {
            worldToLocalPosition(transform, body.position, transform.position);
        } else {
            vec3.copy(transform.position, body.position);
        }
        markTransformDirty(transform);
        vec3.copy(t.linearVelocity, body.linearVelocity);
    }
}

// lives here (not aabb-world.ts) so the solver can call the verbs above directly.
const MAX_SLIDE_ITERS = 4;
const SLOP_EPS = 1e-4;
const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

const _sweepResult: SweepResult = {
    toi: Infinity,
    axis: -1,
    sign: 0,
    nX: 0,
    nY: 0,
    nZ: 0,
    overlapDepth: 0,
};
const _voxelHit: VoxelSweepHit = createVoxelSweepHit();
const _pairOut: PairInfo = makeEmptyPair();

function makeEmptyPair(): PairInfo {
    return {
        aBodyId: 0,
        aNodeId: null,
        aIsSensor: false,
        bKind: 'aabbBody',
        bBodyId: 0,
        bNodeId: null,
        bIsSensor: false,
        bVoxelX: 0,
        bVoxelY: 0,
        bVoxelZ: 0,
        bStateId: 0,
        bSubAabbIndex: -1,
        pointX: 0,
        pointY: 0,
        pointZ: 0,
        normalX: 0,
        normalY: 0,
        normalZ: 0,
        penetrationDepth: 0,
        relVelX: 0,
        relVelY: 0,
        relVelZ: 0,
    };
}

/** steps the AABB world by `dt`, driving only bodies in `awakeBodies`. */
export function tick(world: World, crashcatWorld: crashcat.World, dt: number, recordedPairs: PairSink): void {
    const awake = world.awakeBodies;
    if (awake.length === 0) return;

    // index-walk, not for-of: sleepBody can swap-remove the current entry, so we don't always advance `i`.
    let i = 0;
    while (i < awake.length) {
        const lenBefore = awake.length;
        const body = world.bodies.get(awake[i]!);
        if (!body) {
            // stale id, heal by swap-removing in place and re-checking i.
            const last = awake.length - 1;
            if (i !== last) awake[i] = awake[last]!;
            awake.pop();
            continue;
        }
        tickBody(world, crashcatWorld, body, dt, recordedPairs);
        // if tickBody slept the body, it was swap-removed; do NOT advance.
        if (awake.length === lenBefore) i++;
    }
}

function tickBody(world: World, crashcatWorld: crashcat.World, body: Body, dt: number, sink: PairSink): void {
    const mass = body.mass;
    const invMass = 1 / mass;

    body._prevResting[0] = body.resting[0];
    body._prevResting[1] = body.resting[1];
    body._prevResting[2] = body.resting[2];
    body._prevRestingStateId[0] = body._restingStateId[0];
    body._prevRestingStateId[1] = body._restingStateId[1];
    body._prevRestingStateId[2] = body._restingStateId[2];
    body.resting[0] = 0;
    body.resting[1] = 0;
    body.resting[2] = 0;
    body._restingStateId[0] = 0;
    body._restingStateId[1] = 0;
    body._restingStateId[2] = 0;

    // integrate forces + impulses + gravity (semi-implicit Euler).
    let aX = body._forces[0] * invMass;
    let aY = body._forces[1] * invMass;
    let aZ = body._forces[2] * invMass;
    if (body.motionType === MotionType.DYNAMIC && body.gravityFactor !== 0) {
        aX += world.gravity[0] * body.gravityFactor;
        aY += world.gravity[1] * body.gravityFactor;
        aZ += world.gravity[2] * body.gravityFactor;
    }
    body.linearVelocity[0] += aX * dt + body._impulses[0] * invMass;
    body.linearVelocity[1] += aY * dt + body._impulses[1] * invMass;
    body.linearVelocity[2] += aZ * dt + body._impulses[2] * invMass;
    body._forces[0] = body._forces[1] = body._forces[2] = 0;
    body._impulses[0] = body._impulses[1] = body._impulses[2] = 0;

    // lateral friction (noa-style): damped on axes orthogonal to any axis rested against last tick.
    if (body._prevResting[0] !== 0 || body._prevResting[1] !== 0 || body._prevResting[2] !== 0) {
        applyAxisFriction(world, body, dt, aX, aY, aZ);
    }

    // snapshot the pre-resolve (impact) velocity; the bounce step below applies -restitution * this.
    const vImpactX = body.linearVelocity[0];
    const vImpactY = body.linearVelocity[1];
    const vImpactZ = body.linearVelocity[2];

    slideResolve(world, body, dt, sink);

    // slideResolve already zeroed the normal component on resting axes, so this adds -restitution * impactVel, not (1+restitution) *.
    if (body.restitution > 0) {
        applyPostImpactBounce(world, body, vImpactX, vImpactY, vImpactZ);
    }

    moveInBroadphase(world, body);

    if (body._impostor) {
        crashcat.rigidBody.setTransform(crashcatWorld, body._impostor, body.position, IDENTITY_QUAT, true);
    }

    updateSleepState(world, body);
}

/** applies lateral friction on axes orthogonal to each resting axis; per-axis coeff = body.friction * block.friction. */
function applyAxisFriction(world: World, body: Body, dt: number, aX: number, aY: number, aZ: number): void {
    const bodyFriction = body.friction;
    if (bodyFriction <= 0) return;
    const blockFriction = world.voxels.registry.friction;

    for (let k = 0; k < 3; k++) {
        if (body._prevResting[k] === 0) continue;
        const aK = k === 0 ? aX : k === 1 ? aY : aZ;
        if (aK === 0) continue;
        // friction only applies while still pressing into the surface (sign of aK matches resting[k]).
        if (body._prevResting[k] * aK <= 0) continue;
        const frictionCoeff = bodyFriction * (blockFriction[body._prevRestingStateId[k]] ?? 1);
        if (frictionCoeff <= 0) continue;
        const budget = frictionCoeff * Math.abs(aK) * dt;
        for (let t = 0; t < 3; t++) {
            if (t === k) continue;
            const v = body.linearVelocity[t];
            if (v > 0) body.linearVelocity[t] = v > budget ? v - budget : 0;
            else if (v < 0) body.linearVelocity[t] = -v > budget ? v + budget : 0;
        }
    }
}

/** noa-style post-impact bounce: -restitution * impactVel per resolved axis, gated by minBounceVelocity. */
function applyPostImpactBounce(world: World, body: Body, vIx: number, vIy: number, vIz: number): void {
    const thresh = world.minBounceVelocity;
    const eBody = body.restitution;
    const blockRest = world.voxels.registry.restitution;
    if (body.resting[0] !== 0 && Math.abs(vIx) > thresh) {
        const e = eBody * (blockRest[body._restingStateId[0]] ?? 0);
        if (e !== 0) body.linearVelocity[0] -= e * vIx;
    }
    if (body.resting[1] !== 0 && Math.abs(vIy) > thresh) {
        const e = eBody * (blockRest[body._restingStateId[1]] ?? 0);
        if (e !== 0) body.linearVelocity[1] -= e * vIy;
    }
    if (body.resting[2] !== 0 && Math.abs(vIz) > thresh) {
        const e = eBody * (blockRest[body._restingStateId[2]] ?? 0);
        if (e !== 0) body.linearVelocity[2] -= e * vIz;
    }
}

/** decrements the sleep budget while slow; sleeps immediately on two consecutive grounded+slow ticks, or when the budget hits 0. */
function updateSleepState(world: World, body: Body): void {
    const vx = body.linearVelocity[0];
    const vy = body.linearVelocity[1];
    const vz = body.linearVelocity[2];
    const v2 = vx * vx + vy * vy + vz * vz;

    // resting axes are -1 / 0 / +1; bitwise OR stays nonzero while any axis is touched.
    const groundedThisTick = (body.resting[0] | body.resting[1] | body.resting[2]) !== 0;
    const groundedLastTick = (body._prevResting[0] | body._prevResting[1] | body._prevResting[2]) !== 0;

    if (v2 < world.sleepVelocityEpsSq) {
        if (groundedThisTick && groundedLastTick) {
            sleepBody(world, body);
            return;
        }
        body._sleepFrameCount--;
        if (body._sleepFrameCount <= 0) {
            // slow path: gravity-probe sweep decides grounded when resting axes weren't recorded.
            const probedX = world.gravity[0] * 0.001;
            const probedY = world.gravity[1] * 0.001;
            const probedZ = world.gravity[2] * 0.001;
            _voxelHit.toi = Infinity;
            _voxelHit.axis = -1;
            const hitVoxel =
                body.voxelFlagsMask !== 0 &&
                sweepAabbVsVoxels(
                    _voxelHit,
                    world.voxels,
                    body.position[0],
                    body.position[1],
                    body.position[2],
                    body.halfExtents[0],
                    body.halfExtents[1],
                    body.halfExtents[2],
                    probedX,
                    probedY,
                    probedZ,
                    false,
                );
            if (hitVoxel || groundedThisTick) {
                sleepBody(world, body);
            } else {
                // in free space, clamp budget to 1 so we re-check next tick.
                body._sleepFrameCount = 1;
            }
        }
    } else {
        body._sleepFrameCount = SLEEP_RESET_FRAMES;
    }
}

/** group/mask bidirectional gate. mirrors crashcat semantics. */
function groupsAllow(a: Body, b: Body): boolean {
    return (a.collisionGroups & b.collisionMask) !== 0 && (b.collisionGroups & a.collisionMask) !== 0;
}

function slideResolve(world: World, body: Body, dt: number, sink: PairSink): void {
    let dx = body.linearVelocity[0] * dt;
    let dy = body.linearVelocity[1] * dt;
    let dz = body.linearVelocity[2] * dt;

    // track the most recently pushed body so we don't re-collide with it (its velocity change is deferred to next tick).
    let recentPushedId: BodyId = -1;

    for (let iter = 0; iter < MAX_SLIDE_ITERS; iter++) {
        const dispLen2 = dx * dx + dy * dy + dz * dz;
        if (dispLen2 < SLOP_EPS * SLOP_EPS) break;

        // best-of pass: voxel sweep + spatial-hash Body sweep.
        let bestTOI = Infinity;
        let bestNX = 0,
            bestNY = 0,
            bestNZ = 0;
        let bestOther: Body | null = null;
        let bestVoxel = false;
        let bestVoxelX = 0,
            bestVoxelY = 0,
            bestVoxelZ = 0;
        let bestStateId = 0,
            bestSubAabbIndex = -1;

        // gated by voxelFlagsMask; the sweep primitive itself only filters by BLOCK_FLAG_COLLISION.
        if (body.voxelFlagsMask !== 0) {
            _voxelHit.toi = Infinity;
            _voxelHit.axis = -1;
            const hit = sweepAabbVsVoxels(
                _voxelHit,
                world.voxels,
                body.position[0],
                body.position[1],
                body.position[2],
                body.halfExtents[0],
                body.halfExtents[1],
                body.halfExtents[2],
                dx,
                dy,
                dz,
                false,
            );
            if (hit && _voxelHit.toi < bestTOI) {
                bestTOI = _voxelHit.toi;
                bestNX = _voxelHit.normalX;
                bestNY = _voxelHit.normalY;
                bestNZ = _voxelHit.normalZ;
                bestVoxel = true;
                bestVoxelX = _voxelHit.vx;
                bestVoxelY = _voxelHit.vy;
                bestVoxelZ = _voxelHit.vz;
                bestStateId = _voxelHit.stateId;
                bestSubAabbIndex = _voxelHit.subAabbIndex;
                bestOther = null;
            }
        }

        const envMinX = dx >= 0 ? body.position[0] - body.halfExtents[0] : body.position[0] - body.halfExtents[0] + dx;
        const envMaxX = dx >= 0 ? body.position[0] + body.halfExtents[0] + dx : body.position[0] + body.halfExtents[0];
        const envMinY = dy >= 0 ? body.position[1] - body.halfExtents[1] : body.position[1] - body.halfExtents[1] + dy;
        const envMaxY = dy >= 0 ? body.position[1] + body.halfExtents[1] + dy : body.position[1] + body.halfExtents[1];
        const envMinZ = dz >= 0 ? body.position[2] - body.halfExtents[2] : body.position[2] - body.halfExtents[2] + dz;
        const envMaxZ = dz >= 0 ? body.position[2] + body.halfExtents[2] + dz : body.position[2] + body.halfExtents[2];

        const candidates = querySpatialHash(world.broadphase, envMinX, envMinY, envMinZ, envMaxX, envMaxY, envMaxZ);
        for (let i = 0; i < candidates.length; i++) {
            const otherId = candidates[i]!;
            if (otherId === body.id) continue;
            if (otherId === recentPushedId) continue;
            const other = world.bodies.get(otherId);
            if (!other) continue;
            if (!groupsAllow(body, other)) continue;

            sweepAabbVsAabb(
                body.position[0],
                body.position[1],
                body.position[2],
                body.halfExtents[0],
                body.halfExtents[1],
                body.halfExtents[2],
                dx,
                dy,
                dz,
                other.position[0] - other.halfExtents[0],
                other.position[1] - other.halfExtents[1],
                other.position[2] - other.halfExtents[2],
                other.position[0] + other.halfExtents[0],
                other.position[1] + other.halfExtents[1],
                other.position[2] + other.halfExtents[2],
                _sweepResult,
            );
            if (_sweepResult.axis !== -1 && _sweepResult.toi < bestTOI) {
                bestTOI = _sweepResult.toi;
                bestNX = _sweepResult.nX;
                bestNY = _sweepResult.nY;
                bestNZ = _sweepResult.nZ;
                bestOther = other;
                bestVoxel = false;
            }
        }

        if (bestTOI === Infinity) {
            body.position[0] += dx;
            body.position[1] += dy;
            body.position[2] += dz;
            return;
        }

        // sensor or non-resolving best: advance through but record contact.
        const sensorHit = bestOther !== null && (body.sensor || bestOther.sensor);

        // clamped to >= 0; analytical can return small negative values for already-overlapping pairs.
        const t = bestTOI < 0 ? 0 : bestTOI;
        body.position[0] += dx * t;
        body.position[1] += dy * t;
        body.position[2] += dz * t;

        // record pair if we have a trait-bound observer on at least one side.
        const shouldRecord = body._nodeId !== null || (bestOther !== null && bestOther._nodeId !== null);
        if (shouldRecord) {
            emitPair(
                sink,
                body,
                bestOther,
                bestVoxel,
                bestVoxelX,
                bestVoxelY,
                bestVoxelZ,
                bestStateId,
                bestSubAabbIndex,
                bestNX,
                bestNY,
                bestNZ,
                bestTOI < 0 ? -bestTOI : 0,
                dt,
            );
        }

        if (sensorHit) {
            // sensors don't resolve, finish the unblocked motion this frame.
            const tRem = 1 - t;
            body.position[0] += dx * tRem;
            body.position[1] += dy * tRem;
            body.position[2] += dz * tRem;
            return;
        }

        // static/non-pushable contacts zero the normal velocity (minetest-style); pushable dynamic bodies get a mass-aware impulse split instead.
        const otherPushable = bestOther?.pushable && !bestOther.sensor && bestOther.motionType === MotionType.DYNAMIC;

        const vAn = body.linearVelocity[0] * bestNX + body.linearVelocity[1] * bestNY + body.linearVelocity[2] * bestNZ;
        const vBn = bestOther
            ? bestOther.linearVelocity[0] * bestNX + bestOther.linearVelocity[1] * bestNY + bestOther.linearVelocity[2] * bestNZ
            : 0;
        const vRelN = vAn - vBn;

        if (vRelN < 0) {
            if (otherPushable && bestOther) {
                // mass-aware split, restitution=0 here (bounce is post-impact).
                const mA = body.mass;
                const mB = bestOther.mass;
                const invSum = 1 / mA + 1 / mB;
                const J = -vRelN / invSum;
                body.linearVelocity[0] += (-J * bestNX) / mA;
                body.linearVelocity[1] += (-J * bestNY) / mA;
                body.linearVelocity[2] += (-J * bestNZ) / mA;
                applyImpulse(world, bestOther, J * bestNX, J * bestNY, J * bestNZ);
                recentPushedId = bestOther.id;
            } else {
                body.linearVelocity[0] -= bestNX * vAn;
                body.linearVelocity[1] -= bestNY * vAn;
                body.linearVelocity[2] -= bestNZ * vAn;
                // resting[axis] = -sign(normal on that axis); AABB-vs-AABB hits write stateId 0 (AIR sentinel).
                const restStateId = bestVoxel ? bestStateId : 0;
                if (bestNX !== 0) {
                    body.resting[0] = bestNX > 0 ? -1 : 1;
                    body._restingStateId[0] = restStateId;
                }
                if (bestNY !== 0) {
                    body.resting[1] = bestNY > 0 ? -1 : 1;
                    body._restingStateId[1] = restStateId;
                }
                if (bestNZ !== 0) {
                    body.resting[2] = bestNZ > 0 ? -1 : 1;
                    body._restingStateId[2] = restStateId;
                }
            }
        }
        // else: already separating along normal, leave velocity untouched.

        const tRem = 1 - t;
        dx = body.linearVelocity[0] * dt * tRem;
        dy = body.linearVelocity[1] * dt * tRem;
        dz = body.linearVelocity[2] * dt * tRem;
    }
}

function emitPair(
    sink: PairSink,
    a: Body,
    b: Body | null,
    isVoxel: boolean,
    vx: number,
    vy: number,
    vz: number,
    stateId: number,
    subAabbIndex: number,
    nX: number,
    nY: number,
    nZ: number,
    penetration: number,
    dt: number,
): void {
    _pairOut.aBodyId = a.id;
    _pairOut.aNodeId = a._nodeId;
    _pairOut.aIsSensor = a.sensor;
    // contact point: A's center projected along -normal by its halfExtent on the contact axis.
    _pairOut.pointX = a.position[0] - nX * (nX !== 0 ? a.halfExtents[0] : 0);
    _pairOut.pointY = a.position[1] - nY * (nY !== 0 ? a.halfExtents[1] : 0);
    _pairOut.pointZ = a.position[2] - nZ * (nZ !== 0 ? a.halfExtents[2] : 0);
    _pairOut.normalX = nX;
    _pairOut.normalY = nY;
    _pairOut.normalZ = nZ;
    _pairOut.penetrationDepth = penetration;
    if (isVoxel) {
        _pairOut.bKind = 'voxel';
        _pairOut.bBodyId = 0;
        _pairOut.bNodeId = null;
        _pairOut.bIsSensor = false;
        _pairOut.bVoxelX = vx;
        _pairOut.bVoxelY = vy;
        _pairOut.bVoxelZ = vz;
        _pairOut.bStateId = stateId;
        _pairOut.bSubAabbIndex = subAabbIndex;
        // voxels are static, relVel is just -aLin.
        _pairOut.relVelX = -a.linearVelocity[0];
        _pairOut.relVelY = -a.linearVelocity[1];
        _pairOut.relVelZ = -a.linearVelocity[2];
    } else if (b !== null) {
        _pairOut.bKind = 'aabbBody';
        _pairOut.bBodyId = b.id;
        _pairOut.bNodeId = b._nodeId;
        _pairOut.bIsSensor = b.sensor;
        _pairOut.relVelX = b.linearVelocity[0] - a.linearVelocity[0];
        _pairOut.relVelY = b.linearVelocity[1] - a.linearVelocity[1];
        _pairOut.relVelZ = b.linearVelocity[2] - a.linearVelocity[2];
    } else {
        return;
    }
    // dt unused for now; reserved for time-aware extensions (e.g. impulse magnitude).
    void dt;
    sink.record(_pairOut);
}
