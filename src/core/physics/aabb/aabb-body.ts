/**
 * Per-body operations for AABB bodies — create/destroy, the imperative verbs
 * (setVelocity/setPosition/…, applyForce/applyImpulse), impostor management,
 * and the AabbBodyTrait → world sync. Mirrors crashcat's `body/rigid-body.ts`
 * relative to `aabb-world.ts`: this file drives the world/broadphase/awake-set
 * internals exported from there, so the dependency runs one way (body → world).
 *
 * The curated public `aabbBody.*` script namespace (see `api/physics.ts`) is
 * built from `create`/`destroy` + the verbs below.
 */
import * as crashcat from 'crashcat';
import { type Vec3, vec3 } from 'mathcat';
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

// ── body lifecycle ──────────────────────────────────────────────────

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
    // wake anything resting against us BEFORE we vanish from the broadphase.
    // without this, the stack above a destroyed body keeps sleeping where it
    // was and floats in midair, the awake-set loop never visits it, and no
    // other pass re-checks support for sleeping bodies.
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

/** apply an instantaneous impulse (kg·m/s). consumed and cleared each tick. */
export function applyImpulse(world: World, body: Body, ix: number, iy: number, iz: number): void {
    body._impulses[0] += ix;
    body._impulses[1] += iy;
    body._impulses[2] += iz;
    markBodyActive(world, body);
}

/** teleport: write position directly and wake. zeroes velocity to avoid spurious slide-in.
 *  reslots the body in the broadphase since its AABB just jumped. */
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

/** change motion type. STATIC bodies are removed from the awake set; non-STATIC
 *  bodies are (re)added. transitions away from STATIC also wake the body so it
 *  picks up gravity / forces immediately. */
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

/** trait-sync helper: copy new halfExtents in, reslot the body in the broadphase
 *  (since its AABB extent just changed), and wake it. callers that have already
 *  copied halfExtents must still call this so the broadphase cache + sleep state
 *  stay coherent. */
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

// ── tick / slide-resolve ────────────────────────────────────────────

// ── public namespace wrappers ───────────────────────────────────────
//
// script-facing `create` / `destroy` that take the aabb world + the rigid
// sub-world (whose crashcat world holds impostor bodies), rather than the raw
// crashcat world. the trait owns declarative construction; these are for
// standalone bodies with no node.

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
    // first install, create the body. companion-trait (Interpolate, Contacts)
    // attachment lives in the top-level Physics coordinator.
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

    // mirror scalar props (cheap writes; no diffing). motionType goes through
    // the helper so awake-set membership stays consistent across STATIC flips.
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

    // halfExtents change → copy + reslot broadphase + rebuild impostor (if any).
    if (
        body.halfExtents[0] !== t.halfExtents[0] ||
        body.halfExtents[1] !== t.halfExtents[1] ||
        body.halfExtents[2] !== t.halfExtents[2]
    ) {
        setHalfExtents(world, body, t.halfExtents[0], t.halfExtents[1], t.halfExtents[2]);
        if (body._impostor) reinstallBodyImpostor(world, crashcatWorld, body);
    }

    // rigidBodyImpostor flip → install / remove impostor.
    if (body.rigidBodyImpostor !== t.rigidBodyImpostor) {
        setBodyImpostor(world, crashcatWorld, body, t.rigidBodyImpostor);
    }

    // teleport: the body's position IS the last engine-written value, so if
    // the world transform now differs, something external moved the node.
    // snap, zero velocity, and wake (setter handles all three).
    //
    // if the script ALSO set t.linearVelocity in the same tick (the common
    // "respawn with new velocity" pattern), pick it up after the zero, this
    // is the only sanctioned way to inject velocity into a DYNAMIC body from
    // script. otherwise teleports preserve "fresh start, no momentum" semantics.
    const wp = getWorldPosition(transform);
    if (!vec3.equals(wp, body.position)) {
        setPosition(world, body, wp[0], wp[1], wp[2]);
        if (t.linearVelocity[0] !== 0 || t.linearVelocity[1] !== 0 || t.linearVelocity[2] !== 0) {
            setVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
        }
    }

    // client-side replication smoothing for non-owner KINEMATIC bodies,
    // sync'd linearVelocity drives integration between sparse pose updates.
    if (identity !== null && t._node.owner !== identity && body.motionType === MotionType.KINEMATIC) {
        setVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
    }
}

/** trait → world sync. install/update bodies for nodes with the bound aabb body
 *  trait; destroy bodies for nodes that lost the trait. no-op unless
 *  `bindNodeSync` has been called. */
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

/** world → trait writeback for moving bodies. companion-trait management
 *  (Interpolate/Contacts) lives in the coordinator. */
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

// ── per-body step (integration + analytical slide-resolve) ──────────
//
// the solver drives bodies in `world.awakeBodies`; it consumes the `_forces`/
// `_impulses` accumulators the verbs above fill. lives here (not aabb-world.ts)
// so it can call the verbs directly rather than reaching back across modules.

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

/**
 * step the AABB world by `dt`. drives only bodies in `awakeBodies`.
 *
 *   - iterates `world.awakeBodies` (not the full registry). asleep + STATIC
 *     bodies are not visited; they cost nothing per tick.
 *   - `tickBody` calls `moveInBroadphase` after writing the new position, so
 *     the hash stays current without a global rebuild.
 *   - bodies that sleep this tick are swap-removed from `awakeBodies` inside
 *     `tickBody` → `sleepBody`. the index-walk loop accounts for that.
 *   - if `awakeBodies` is empty we short-circuit and skip the per-tick work
 *     entirely, important for piles that have fully settled.
 */
export function tick(world: World, crashcatWorld: crashcat.World, dt: number, recordedPairs: PairSink): void {
    const awake = world.awakeBodies;
    if (awake.length === 0) return;

    // index-walk, not for-of: tickBody can swap-remove the current entry
    // (via sleepBody). when it does, `awake[i]` is now a different id we
    // still need to visit on this tick, so we don't advance `i`.
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

    // snapshot prev resting BEFORE we clear and re-derive it.
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

    // 1. integrate forces + impulses + gravity (semi-implicit Euler).
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

    // 2. lateral friction (noa-style): if last tick we were resting against a
    //    surface on axis K, the velocity components on the *other* axes get
    //    damped by μ × |pseudo-normal-force|, where the pseudo-force is the
    //    impulse needed last tick to zero v on axis K. cheap proxy: use the
    //    pre-friction acceleration along K to derive a friction budget.
    if (body._prevResting[0] !== 0 || body._prevResting[1] !== 0 || body._prevResting[2] !== 0) {
        applyAxisFriction(world, body, dt, aX, aY, aZ);
    }

    // snapshot the POST-INTEGRATION velocity. this is the velocity that would
    // have driven the body through the surface, it IS the impact velocity.
    // slideResolve will zero the normal component when it lands a contact;
    // the bounce step then reads this snapshot to apply -rest × impactVel.
    const vImpactX = body.linearVelocity[0];
    const vImpactY = body.linearVelocity[1];
    const vImpactZ = body.linearVelocity[2];

    // 3. slide-resolve against voxels + other AabbBodies.
    slideResolve(world, body, dt, sink);

    // 4. post-impact bounce. slideResolve has already zeroed the normal
    //    component on any resting axis, so the bounce only needs to ADD
    //    -rest × impactVel along that axis (not (1+rest) ×, that would
    //    inject 50% extra energy every hit). gated by `minBounceVelocity`
    //    to kill perpetual micro-bounces near terminal velocity.
    if (body.restitution > 0) {
        applyPostImpactBounce(world, body, vImpactX, vImpactY, vImpactZ);
    }

    // 5. broadphase reslot (cell-range cache makes this O(1) when AABB hasn't
    //    crossed a cell boundary, the common micro-movement case).
    moveInBroadphase(world, body);

    // 6. impostor mirror (kinematic), only on awake bodies; asleep bodies'
    //    impostors were already at the right transform when they slept.
    if (body._impostor) {
        crashcat.rigidBody.setTransform(crashcatWorld, body._impostor, body.position, IDENTITY_QUAT, true);
    }

    // 7. sleep check. may swap-remove this body from `awakeBodies`.
    updateSleepState(world, body);
}

/** apply lateral friction along the axes orthogonal to each resting axis.
 *  budget per orthogonal axis = μ × |pseudo-normal-force| × dt, where the
 *  pseudo-force on a resting axis is the pre-friction acceleration along it.
 *  per-axis μ = body.friction × block.friction (from the surface this axis
 *  was resting on last tick). block.friction defaults to 1, so non-voxel
 *  hits combine to body.friction unchanged. */
function applyAxisFriction(world: World, body: Body, dt: number, aX: number, aY: number, aZ: number): void {
    const μBody = body.friction;
    if (μBody <= 0) return;
    const blockFriction = world.voxels.registry.friction;

    for (let k = 0; k < 3; k++) {
        if (body._prevResting[k] === 0) continue;
        const aK = k === 0 ? aX : k === 1 ? aY : aZ;
        if (aK === 0) continue;
        // friction only applies when velocity along K is into the surface
        // (i.e. the rest direction agrees with the sign of -aK). otherwise
        // the body is separating and the contact won't sustain friction.
        // resting[k] = -sign(normal_at_axis); approaching means a points in
        // the same direction as resting.
        if (body._prevResting[k] * aK <= 0) continue;
        const μ = μBody * (blockFriction[body._prevRestingStateId[k]] ?? 1);
        if (μ <= 0) continue;
        const budget = μ * Math.abs(aK) * dt;
        for (let t = 0; t < 3; t++) {
            if (t === k) continue;
            const v = body.linearVelocity[t];
            if (v > 0) body.linearVelocity[t] = v > budget ? v - budget : 0;
            else if (v < 0) body.linearVelocity[t] = -v > budget ? v + budget : 0;
        }
    }
}

/** noa-style post-impact bounce. for each axis we just hit, add -restitution ×
 *  impactVel along that axis (slideResolve already zeroed the normal-axis
 *  velocity, so this is the bounce delta, not a full reflection). gated by
 *  `minBounceVelocity` to suppress perpetual micro-bounces near terminal v.
 *  per-axis e = body.restitution × block.restitution. block.restitution
 *  defaults to 0, so non-restitutive surfaces (everything except opted-in
 *  bouncy blocks) kill bounce regardless of body restitution. */
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

/** decrement sleep budget when slow; sleep when grounded + budget hits 0.
 *  fast path: if the body is grounded on the same surface for two consecutive
 *  ticks AND moving below the velocity epsilon, sleep immediately. this is the
 *  difference between a 300-sphere pile settling in 10 frames vs ~10×SLEEP_RESET_FRAMES. */
function updateSleepState(world: World, body: Body): void {
    const vx = body.linearVelocity[0];
    const vy = body.linearVelocity[1];
    const vz = body.linearVelocity[2];
    const v2 = vx * vx + vy * vy + vz * vz;

    // resting axes are -1 / 0 / +1. bitwise OR with three signed ints stays
    // nonzero as long as any axis is touched (since -1 has all 32 bits set).
    const groundedThisTick = (body.resting[0] | body.resting[1] | body.resting[2]) !== 0;
    const groundedLastTick = (body._prevResting[0] | body._prevResting[1] | body._prevResting[2]) !== 0;

    if (v2 < world.sleepVelocityEpsSq) {
        // FAST PATH, two consecutive grounded + slow ticks ⇒ confidently settled.
        if (groundedThisTick && groundedLastTick) {
            sleepBody(world, body);
            return;
        }
        body._sleepFrameCount--;
        if (body._sleepFrameCount <= 0) {
            // SLOW PATH (e.g. body is balanced atop a flat top without "resting"
            // axes recording, or is in a cycle of micro-collisions). gravity probe:
            // would a gravity-only step intersect anything? if yes → grounded, sleep.
            const probedX = world.gravity[0] * 0.001;
            const probedY = world.gravity[1] * 0.001;
            const probedZ = world.gravity[2] * 0.001;
            _voxelHit.toi = Infinity;
            _voxelHit.axis = -1;
            const hitVoxel =
                body.voxelFlagsMask !== 0 &&
                sweepAabbVsVoxels(
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
                    _voxelHit,
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

    // when we push another body, its velocity changes via _impulses (deferred
    // until next tick). within this slide loop we'd otherwise re-collide with
    // it every iteration. track the most recently pushed body and skip it.
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

        // voxel sweep, gated by voxelFlagsMask. (the underlying primitive
        // only filters by BLOCK_FLAG_COLLISION today; we still honor the
        // body's flag here by skipping the pass when it's cleared.)
        if (body.voxelFlagsMask !== 0) {
            _voxelHit.toi = Infinity;
            _voxelHit.axis = -1;
            const hit = sweepAabbVsVoxels(
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
                _voxelHit,
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

        // body-vs-body sweep against broadphase candidates.
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
            // no hit, advance freely and stop.
            body.position[0] += dx;
            body.position[1] += dy;
            body.position[2] += dz;
            return;
        }

        // sensor or non-resolving best: advance through but record contact.
        const sensorHit = bestOther !== null && (body.sensor || bestOther.sensor);

        // advance by TOI (clamped to >= 0; analytical can return small
        // negative values for already-overlapping pairs, depenetrate).
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

        // resolve. normal points obstacle → mover. for static-or-infinite-mass
        // contacts we zero the normal component (minetest-style); restitution
        // is applied later by `applyPostImpactBounce` against the pre-tick v,
        // gated by `minBounceVelocity`. for pushable dynamic AabbBodies we
        // split a mass-aware normal impulse so the obstacle wakes and picks
        // up momentum next tick.
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
                // apply -J to self along normal (slow / reverse), +J to other.
                body.linearVelocity[0] += (-J * bestNX) / mA;
                body.linearVelocity[1] += (-J * bestNY) / mA;
                body.linearVelocity[2] += (-J * bestNZ) / mA;
                applyImpulse(world, bestOther, J * bestNX, J * bestNY, J * bestNZ);
                recentPushedId = bestOther.id;
            } else {
                // static / voxel / non-pushable: zero the normal-velocity
                // component. record the resting axis for friction + sleep.
                body.linearVelocity[0] -= bestNX * vAn;
                body.linearVelocity[1] -= bestNY * vAn;
                body.linearVelocity[2] -= bestNZ * vAn;
                // resting[axis] = -sign(normal_axis). floor (n=+Y) ⇒ resting[1] = -1.
                // _restingStateId[axis] tracks the block we're resting against for
                // per-block friction + restitution combine. AABB-vs-AABB hits write
                // 0 (AIR sentinel), registry tables return neutral defaults for it.
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

        // remaining displacement is the unused portion of this step.
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
    // contact point: project A's center along -normal by its halfExtent on
    // the contact axis. cheap approximation; consumers rarely need exactness.
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
