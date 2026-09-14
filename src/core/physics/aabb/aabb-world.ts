import * as crashcat from 'crashcat';
import { type Vec3, vec3 } from 'math';
import type { AabbBodyTrait as AabbBodyTraitInstance } from '../../../builtins/aabb-body';
import { TransformTrait } from '../../../builtins/transform';
import type { SceneTree } from '../../scene/scene-tree';
import { query } from '../../scene/scene-tree';
import type { TraitHandle } from '../../scene/traits';
import type { Voxels } from '../../voxels/voxels';
import {
    clearSpatialHash,
    createSpatialHash,
    hashKey,
    querySpatialHash,
    removeBodyFromBucket,
    type SpatialHash,
} from './aabb-broadphase';
import { type SweepResult, sweepAabbVsAabb } from './aabb-sweep';

export enum MotionType {
    STATIC = 0,
    KINEMATIC = 1,
    DYNAMIC = 2,
}

export type BodyId = number;

export type Body = {
    id: BodyId;

    position: Vec3;
    halfExtents: Vec3;
    linearVelocity: Vec3;

    motionType: MotionType;

    /** mass in kg; values <= 0 are treated as 1. */
    mass: number;

    gravityFactor: number;

    /** uint32 bitfield: which groups this body is a member of. */
    collisionGroups: number;

    /** uint32 bitfield: which groups this body collides with. */
    collisionMask: number;

    /** block-flag bitmask gating voxel collision. usually BLOCK_FLAG_COLLISION. */
    voxelFlagsMask: number;

    friction: number;
    restitution: number;
    sensor: boolean;
    /** allows other bodies and the character controller to push this body via `applyImpulse`. */
    pushable: boolean;

    /** when set, a kinematic crashcat body shadows this body on `world.impostorObjectLayer`. */
    rigidBodyImpostor: boolean;
    _impostor: crashcat.RigidBody | null;

    /** back-ref for trait-bound bodies; null for imperative bodies. */
    _nodeId: number | null;

    /** continuous force accumulator (N), cleared each tick; apply via `applyForce`. */
    _forces: Vec3;
    /** one-shot impulse accumulator (kg m/s), cleared each tick; apply via `applyImpulse`. */
    _impulses: Vec3;

    /** per-axis contact state: -1 / 0 / +1. */
    resting: [number, number, number];
    /** snapshot of `resting` from the previous tick. */
    _prevResting: [number, number, number];

    /** per-axis stateId of the block being rested against; 0 (AIR sentinel) for AABB-vs-AABB hits. */
    _restingStateId: [number, number, number];
    /** snapshot of `_restingStateId` from the previous tick. */
    _prevRestingStateId: [number, number, number];

    /** decrements while velocity squared is under `sleepVelocityEpsSq`; sleeps at 0, reset via `markBodyActive`. */
    _sleepFrameCount: number;
    /** true skips integration + slide-resolve; the body stays in the broadphase as an obstacle. */
    _asleep: boolean;

    /** cached cell-range from the last broadphase insertion; min > max means not inserted. */
    _broadphaseCellMinX: number;
    _broadphaseCellMinY: number;
    _broadphaseCellMinZ: number;
    _broadphaseCellMaxX: number;
    _broadphaseCellMaxY: number;
    _broadphaseCellMaxZ: number;

    /** index into `world.awakeBodies`; -1 means not in the awake set. */
    _awakeIndex: number;
};

export type BodyOpts = {
    position: Vec3;
    halfExtents: Vec3;
    motionType?: MotionType;
    mass?: number;
    linearVelocity?: Vec3;
    gravityFactor?: number;
    collisionGroups?: number;
    collisionMask?: number;
    voxelFlagsMask?: number;
    friction?: number;
    restitution?: number;
    sensor?: boolean;
    pushable?: boolean;
    rigidBodyImpostor?: boolean;
    /** trait installer sets this; imperative callers leave it null. */
    nodeId?: number | null;
};

/** writer surface for recording resolved contact pairs. */
export type PairSink = {
    record(pair: PairInfo): void;
};

/** flat-struct copy of one resolved contact, emitted when at least one body has `_nodeId !== null`. */
export type PairInfo = {
    aBodyId: BodyId;
    aNodeId: number | null;
    aIsSensor: boolean;

    bKind: 'aabbBody' | 'voxel';
    bBodyId: BodyId;
    bNodeId: number | null;
    bIsSensor: boolean;
    bVoxelX: number;
    bVoxelY: number;
    bVoxelZ: number;
    bStateId: number;
    bSubAabbIndex: number;

    // normal points A to B.
    pointX: number;
    pointY: number;
    pointZ: number;
    normalX: number;
    normalY: number;
    normalZ: number;
    penetrationDepth: number;
    /** bLin - aLin. for voxels bLin = 0. */
    relVelX: number;
    relVelY: number;
    relVelZ: number;
};

/** wakes any sleeping non-STATIC body sharing a cell with `body`'s broadphase footprint. */
export function wakeSleepingNeighbors(world: World, body: Body): void {
    if (body._broadphaseCellMinX > body._broadphaseCellMaxX) return;
    const h = world.broadphase;
    for (let iz = body._broadphaseCellMinZ; iz <= body._broadphaseCellMaxZ; iz++) {
        for (let iy = body._broadphaseCellMinY; iy <= body._broadphaseCellMaxY; iy++) {
            for (let ix = body._broadphaseCellMinX; ix <= body._broadphaseCellMaxX; ix++) {
                const bucket = h.cells.get(hashKey(ix, iy, iz));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const otherId = bucket[i]!;
                    if (otherId === body.id) continue;
                    const other = world.bodies.get(otherId);
                    if (!other?._asleep) continue;
                    if (other.motionType === MotionType.STATIC) continue;
                    markBodyActive(world, other);
                }
            }
        }
    }
}

/** inserts or moves a body in the broadphase, skipping the rehash if its cell range is unchanged. */
export function moveInBroadphase(world: World, body: Body): void {
    const h = world.broadphase;
    const inv = h.invCellSize;
    const px = body.position[0];
    const py = body.position[1];
    const pz = body.position[2];
    const hx = body.halfExtents[0];
    const hy = body.halfExtents[1];
    const hz = body.halfExtents[2];
    const ix0 = Math.floor((px - hx) * inv);
    const iy0 = Math.floor((py - hy) * inv);
    const iz0 = Math.floor((pz - hz) * inv);
    const ix1 = Math.floor((px + hx) * inv);
    const iy1 = Math.floor((py + hy) * inv);
    const iz1 = Math.floor((pz + hz) * inv);

    if (
        ix0 === body._broadphaseCellMinX &&
        iy0 === body._broadphaseCellMinY &&
        iz0 === body._broadphaseCellMinZ &&
        ix1 === body._broadphaseCellMaxX &&
        iy1 === body._broadphaseCellMaxY &&
        iz1 === body._broadphaseCellMaxZ
    ) {
        return;
    }

    // wake sleepers in our current cells before we leave them.
    wakeSleepingNeighbors(world, body);

    if (body._broadphaseCellMinX <= body._broadphaseCellMaxX) {
        for (let iz = body._broadphaseCellMinZ; iz <= body._broadphaseCellMaxZ; iz++) {
            for (let iy = body._broadphaseCellMinY; iy <= body._broadphaseCellMaxY; iy++) {
                for (let ix = body._broadphaseCellMinX; ix <= body._broadphaseCellMaxX; ix++) {
                    removeBodyFromBucket(h, hashKey(ix, iy, iz), body.id);
                }
            }
        }
    }

    for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const k = hashKey(ix, iy, iz);
                let bucket = h.cells.get(k);
                if (!bucket) {
                    bucket = [];
                    h.cells.set(k, bucket);
                }
                bucket.push(body.id);
            }
        }
    }

    body._broadphaseCellMinX = ix0;
    body._broadphaseCellMinY = iy0;
    body._broadphaseCellMinZ = iz0;
    body._broadphaseCellMaxX = ix1;
    body._broadphaseCellMaxY = iy1;
    body._broadphaseCellMaxZ = iz1;
}

/** remove a body from the broadphase. no-op if the body was never inserted. */
export function removeFromBroadphase(world: World, body: Body): void {
    if (body._broadphaseCellMinX > body._broadphaseCellMaxX) return;
    const h = world.broadphase;
    for (let iz = body._broadphaseCellMinZ; iz <= body._broadphaseCellMaxZ; iz++) {
        for (let iy = body._broadphaseCellMinY; iy <= body._broadphaseCellMaxY; iy++) {
            for (let ix = body._broadphaseCellMinX; ix <= body._broadphaseCellMaxX; ix++) {
                removeBodyFromBucket(h, hashKey(ix, iy, iz), body.id);
            }
        }
    }
    // sentinel: min=1, max=0 means not inserted.
    body._broadphaseCellMinX = 1;
    body._broadphaseCellMaxX = 0;
}

/** live body counts for the debug panel. */
export type WorldStats = {
    total: number;
    active: number;
    static: number;
    kinematic: number;
    dynamic: number;
};

/** tallies bodies by motion type; `active` is the awake set. */
export function stats(world: World): WorldStats {
    let staticCount = 0;
    let kinematic = 0;
    let dynamic = 0;
    for (const body of world.bodies.values()) {
        if (body.motionType === MotionType.STATIC) staticCount++;
        else if (body.motionType === MotionType.KINEMATIC) kinematic++;
        else dynamic++;
    }
    return {
        total: world.bodies.size,
        active: world.awakeBodies.length,
        static: staticCount,
        kinematic,
        dynamic,
    };
}

export type World = {
    /** terrain reference (voxel sweep target). */
    voxels: Voxels;

    /** gravity acceleration applied each tick. */
    gravity: Vec3;

    /** below this speed, restitution is treated as 0 to kill micro-bounces near terminal velocity, in m/s. */
    minBounceVelocity: number;

    /** squared linear-velocity threshold for sleep candidacy. */
    sleepVelocityEpsSq: number;

    /** primary registry. iteration order = creation order; stable across ticks. */
    bodies: Map<BodyId, Body>;

    /** trait-bound bodies only; keyed by nodeId. */
    nodeToBody: Map<number, BodyId>;

    /** for bodies with rigidBodyImpostor on: keyed by impostor BodyId. */
    impostorToBody: Map<crashcat.BodyId, BodyId>;

    /** broadphase; asleep bodies stay in the hash. */
    broadphase: SpatialHash;

    /** ids of DYNAMIC/KINEMATIC awake bodies; `tick` walks this array, not `bodies.values()`. */
    awakeBodies: BodyId[];

    _nextId: number;

    // set by `bindNodeSync`; tests and headless callers leave this null. AabbBodyTrait isn't imported as a
    // value here to avoid a cycle with aabb-body.ts, so the coordinator passes the handle in.
    _bodyQuery: ReturnType<typeof query<[TraitHandle<AabbBodyTraitInstance>, typeof TransformTrait]>> | null;
};

export type CreateWorldOpts = {
    /** cell size for the uniform spatial hash broadphase. default 2.0 world units. */
    cellSize?: number;
    /** gravity vector. default mirrors crashcat-engine default [0, -9.81, 0]. */
    gravity?: Vec3;
    /** see `World.minBounceVelocity`. default 1.0 m/s. */
    minBounceVelocity?: number;
    /** see `World.sleepVelocityEpsSq`. default 1e-4. */
    sleepVelocityEpsSq?: number;
};

/** sleep-frame budget. when nothing wakes a body for this many ticks, it sleeps. */
export const SLEEP_RESET_FRAMES = 10;

export function createWorld(voxels: Voxels, opts?: CreateWorldOpts): World {
    const cellSize = opts?.cellSize ?? 2.0;
    const gravity: Vec3 = vec3.create();
    if (opts?.gravity) {
        gravity[0] = opts.gravity[0];
        gravity[1] = opts.gravity[1];
        gravity[2] = opts.gravity[2];
    } else {
        gravity[1] = -9.81;
    }
    return {
        voxels,
        gravity,
        minBounceVelocity: opts?.minBounceVelocity ?? 1.0,
        sleepVelocityEpsSq: opts?.sleepVelocityEpsSq ?? 1e-4,
        bodies: new Map(),
        nodeToBody: new Map(),
        impostorToBody: new Map(),
        broadphase: createSpatialHash(cellSize),
        awakeBodies: [],
        _nextId: 1,
        _bodyQuery: null,
    };
}

/** wires a `World` for trait/world sync so `preStep`/`postStep` mirror the bound query; idempotent. */
export function bindNodeSync(world: World, sceneTree: SceneTree, bodyTrait: TraitHandle<AabbBodyTraitInstance>): void {
    world._bodyQuery = query(sceneTree, [bodyTrait, TransformTrait]);
}

/** tear down all bodies (including impostors) before disposing the world. */
export function dispose(world: World, crashcatWorld: crashcat.World): void {
    for (const body of world.bodies.values()) {
        if (body._impostor) {
            crashcat.rigidBody.remove(crashcatWorld, body._impostor);
            body._impostor = null;
        }
    }
    world.bodies.clear();
    world.nodeToBody.clear();
    world.impostorToBody.clear();
    world.awakeBodies.length = 0;
    clearSpatialHash(world.broadphase);
}

// O(1) add / remove via swap-remove; `body._awakeIndex` mirrors the array slot. STATIC bodies never enter the set.
export function addToAwakeSet(world: World, body: Body): void {
    if (body._awakeIndex !== -1) return;
    if (body.motionType === MotionType.STATIC) return;
    body._awakeIndex = world.awakeBodies.length;
    world.awakeBodies.push(body.id);
}

export function removeFromAwakeSet(world: World, body: Body): void {
    const i = body._awakeIndex;
    if (i === -1) return;
    const arr = world.awakeBodies;
    const last = arr.length - 1;
    if (i !== last) {
        const lastId = arr[last]!;
        arr[i] = lastId;
        const lastBody = world.bodies.get(lastId);
        if (lastBody) lastBody._awakeIndex = i;
    }
    arr.pop();
    body._awakeIndex = -1;
}

/** transitions a body to asleep: zeroes velocity and drops it from the awake set. */
export function sleepBody(world: World, body: Body): void {
    body._asleep = true;
    body._sleepFrameCount = 0;
    body.linearVelocity[0] = 0;
    body.linearVelocity[1] = 0;
    body.linearVelocity[2] = 0;
    removeFromAwakeSet(world, body);
}

// every API that nudges a body must wake it via these helpers, or it stays asleep and skipped by tick.

/** wakes a body and (re-)inserts it into the awake set. */
export function markBodyActive(world: World, body: Body): void {
    body._sleepFrameCount = SLEEP_RESET_FRAMES;
    body._asleep = false;
    addToAwakeSet(world, body);
}

const _sweepResult: SweepResult = {
    toi: Infinity,
    axis: -1,
    sign: 0,
    nX: 0,
    nY: 0,
    nZ: 0,
    overlapDepth: 0,
};

/** sweeps a moving AABB against all AabbBodies in the broadphase; exact, group/mask filtered, with optional self-exclusion. */
export function sweepBodies(
    world: World,
    mcX: number,
    mcY: number,
    mcZ: number,
    mhX: number,
    mhY: number,
    mhZ: number,
    dx: number,
    dy: number,
    dz: number,
    selfGroups: number,
    selfMask: number,
    ignoreId: BodyId,
    out: SweepResult,
): Body | null {
    out.toi = Infinity;
    out.axis = -1;
    out.sign = 0;

    const envMinX = dx >= 0 ? mcX - mhX : mcX - mhX + dx;
    const envMaxX = dx >= 0 ? mcX + mhX + dx : mcX + mhX;
    const envMinY = dy >= 0 ? mcY - mhY : mcY - mhY + dy;
    const envMaxY = dy >= 0 ? mcY + mhY + dy : mcY + mhY;
    const envMinZ = dz >= 0 ? mcZ - mhZ : mcZ - mhZ + dz;
    const envMaxZ = dz >= 0 ? mcZ + mhZ + dz : mcZ + mhZ;

    const candidates = querySpatialHash(world.broadphase, envMinX, envMinY, envMinZ, envMaxX, envMaxY, envMaxZ);

    let bestTOI = Infinity;
    let bestBody: Body | null = null;
    for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i]!;
        if (id === ignoreId) continue;
        const other = world.bodies.get(id);
        if (!other) continue;
        if ((selfGroups & other.collisionMask) === 0) continue;
        if ((other.collisionGroups & selfMask) === 0) continue;

        sweepAabbVsAabb(
            mcX,
            mcY,
            mcZ,
            mhX,
            mhY,
            mhZ,
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
            bestBody = other;
            out.toi = _sweepResult.toi;
            out.axis = _sweepResult.axis;
            out.sign = _sweepResult.sign;
            out.nX = _sweepResult.nX;
            out.nY = _sweepResult.nY;
            out.nZ = _sweepResult.nZ;
            out.overlapDepth = _sweepResult.overlapDepth;
        }
    }
    return bestBody;
}

export function getBodyByNodeId(world: World, nodeId: number): Body | undefined {
    const id = world.nodeToBody.get(nodeId);
    return id === undefined ? undefined : world.bodies.get(id);
}

export enum CastRayStatus {
    NOT_COLLIDING = 0,
    COLLIDING = 1,
}

export type CastRayHit = {
    status: CastRayStatus;
    /** fraction along the ray where the hit occurred, 0 at origin, 1 at origin + dir*length. */
    fraction: number;
    /** id of the body that was hit; -1 means no hit. */
    bodyId: BodyId;
    /** outward-facing surface normal at the hit point (unit axis vector). */
    normalX: number;
    normalY: number;
    normalZ: number;
};

export function createCastRayHit(): CastRayHit {
    return {
        status: CastRayStatus.NOT_COLLIDING,
        fraction: 1.0,
        bodyId: -1,
        normalX: 0,
        normalY: 0,
        normalZ: 0,
    };
}

export function copyCastRayHit(out: CastRayHit, src: CastRayHit): void {
    out.status = src.status;
    out.fraction = src.fraction;
    out.bodyId = src.bodyId;
    out.normalX = src.normalX;
    out.normalY = src.normalY;
    out.normalZ = src.normalZ;
}

export type CastRaySettings = {
    /** uint32 bitfield: which groups the ray is a member of. */
    collisionGroups: number;
    /** uint32 bitfield: which groups the ray collides with. */
    collisionMask: number;
    /** if set, the ray ignores this body id; -1 means no exclusion. */
    ignoreBodyId: BodyId;
    /** if true, sensor bodies are skipped. */
    ignoreSensors: boolean;
};

export function createDefaultCastRaySettings(): CastRaySettings {
    return {
        collisionGroups: 0xffffffff,
        collisionMask: 0xffffffff,
        ignoreBodyId: -1,
        ignoreSensors: false,
    };
}

export type CastRayCollector = {
    /** scratch slot: castRay publishes the candidate bodyId here before calling addHit. */
    bodyId: BodyId;
    /** rays past this fraction are pruned. collectors lower it as hits land. */
    earlyOutFraction: number;
    addHit(hit: CastRayHit): void;
    addMiss(): void;
    shouldEarlyOut(): boolean;
};

const INITIAL_EARLY_OUT_FRACTION = 1.0 + 1e-4;
const SHOULD_EARLY_OUT_FRACTION = 0.0;

/** collects every hit along the ray; `reset()` returns pooled hits without re-allocating. */
export class AllCastRayCollector implements CastRayCollector {
    bodyId: BodyId = -1;
    earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    hits: CastRayHit[] = [];
    /** `_pool[0.._poolCursor]` are in-use, rest are free. */
    private _pool: CastRayHit[] = [];
    private _poolCursor = 0;

    addHit(hit: CastRayHit): void {
        let slot = this._pool[this._poolCursor];
        if (!slot) {
            slot = createCastRayHit();
            this._pool.push(slot);
        }
        this._poolCursor++;
        copyCastRayHit(slot, hit);
        this.hits.push(slot);
    }
    addMiss(): void {}
    shouldEarlyOut(): boolean {
        return false;
    }
    reset(): void {
        this.bodyId = -1;
        this._poolCursor = 0;
        this.hits.length = 0;
        this.earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    }
}

export function createAllCastRayCollector(): AllCastRayCollector {
    return new AllCastRayCollector();
}

/** stops at the first hit. `hit` is reused; check `hit.status` for success. */
export class AnyCastRayCollector implements CastRayCollector {
    bodyId: BodyId = -1;
    earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    hit: CastRayHit = createCastRayHit();

    addHit(h: CastRayHit): void {
        copyCastRayHit(this.hit, h);
        this.earlyOutFraction = SHOULD_EARLY_OUT_FRACTION;
    }
    addMiss(): void {}
    shouldEarlyOut(): boolean {
        return this.hit.status === CastRayStatus.COLLIDING;
    }
    reset(): void {
        this.bodyId = -1;
        this.hit.status = CastRayStatus.NOT_COLLIDING;
        this.hit.fraction = 1.0;
        this.hit.bodyId = -1;
        this.hit.normalX = 0;
        this.hit.normalY = 0;
        this.hit.normalZ = 0;
        this.earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    }
}

export function createAnyCastRayCollector(): AnyCastRayCollector {
    return new AnyCastRayCollector();
}

/** keeps the closest hit, lowering `earlyOutFraction` after each accepted hit. */
export class ClosestCastRayCollector implements CastRayCollector {
    bodyId: BodyId = -1;
    earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    hit: CastRayHit = createCastRayHit();

    addHit(h: CastRayHit): void {
        if (this.hit.status === CastRayStatus.NOT_COLLIDING || h.fraction < this.hit.fraction) {
            this.earlyOutFraction = h.fraction;
            copyCastRayHit(this.hit, h);
        }
    }
    addMiss(): void {}
    shouldEarlyOut(): boolean {
        return false;
    }
    reset(): void {
        this.bodyId = -1;
        this.hit.status = CastRayStatus.NOT_COLLIDING;
        this.hit.fraction = 1.0;
        this.hit.bodyId = -1;
        this.hit.normalX = 0;
        this.hit.normalY = 0;
        this.hit.normalZ = 0;
        this.earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    }
}

export function createClosestCastRayCollector(): ClosestCastRayCollector {
    return new ClosestCastRayCollector();
}

/** scratch hit handed to `collector.addHit`; the collector copies values out, so reuse is safe. */
const _castRayHit: CastRayHit = createCastRayHit();

/** ray-vs-AABB slab test; returns the entry fraction, or Infinity for a miss. */
function rayVsAabbWithNormal(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
): number {
    let tNear = 0;
    let tFar = length;
    // nAxis is the entry face's axis; normal sign is -sign(dir) on that axis.
    let nAxis = -1;

    if (Math.abs(dx) < 1e-10) {
        if (ox < minX || ox > maxX) return Infinity;
    } else {
        const inv = 1 / dx;
        let tEnter = (minX - ox) * inv;
        let tExit = (maxX - ox) * inv;
        if (inv < 0) {
            const tmp = tEnter;
            tEnter = tExit;
            tExit = tmp;
        }
        if (tEnter > tNear) {
            tNear = tEnter;
            nAxis = 0;
        }
        if (tExit < tFar) tFar = tExit;
        if (tFar < tNear) return Infinity;
    }

    if (Math.abs(dy) < 1e-10) {
        if (oy < minY || oy > maxY) return Infinity;
    } else {
        const inv = 1 / dy;
        let tEnter = (minY - oy) * inv;
        let tExit = (maxY - oy) * inv;
        if (inv < 0) {
            const tmp = tEnter;
            tEnter = tExit;
            tExit = tmp;
        }
        if (tEnter > tNear) {
            tNear = tEnter;
            nAxis = 1;
        }
        if (tExit < tFar) tFar = tExit;
        if (tFar < tNear) return Infinity;
    }

    if (Math.abs(dz) < 1e-10) {
        if (oz < minZ || oz > maxZ) return Infinity;
    } else {
        const inv = 1 / dz;
        let tEnter = (minZ - oz) * inv;
        let tExit = (maxZ - oz) * inv;
        if (inv < 0) {
            const tmp = tEnter;
            tEnter = tExit;
            tExit = tmp;
        }
        if (tEnter > tNear) {
            tNear = tEnter;
            nAxis = 2;
        }
        if (tExit < tFar) tFar = tExit;
        if (tFar < tNear) return Infinity;
    }

    if (tNear > length) return Infinity;

    _castRayHit.normalX = 0;
    _castRayHit.normalY = 0;
    _castRayHit.normalZ = 0;
    if (nAxis === 0) _castRayHit.normalX = dx > 0 ? -1 : 1;
    else if (nAxis === 1) _castRayHit.normalY = dy > 0 ? -1 : 1;
    else if (nAxis === 2) _castRayHit.normalZ = dz > 0 ? -1 : 1;
    // nAxis === -1 means the ray began inside every slab; normal is left zero.

    return tNear;
}

/** casts a ray against all AabbBodies in the world, feeding results to `collector`. */
export function castRay(
    world: World,
    collector: CastRayCollector,
    settings: CastRaySettings,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
): void {
    if (length <= 0) {
        collector.addMiss();
        return;
    }

    // envelope AABB around the ray segment; broadphase candidates come from cells overlapping it.
    const ex = dx * length;
    const ey = dy * length;
    const ez = dz * length;
    const envMinX = ex >= 0 ? ox : ox + ex;
    const envMaxX = ex >= 0 ? ox + ex : ox;
    const envMinY = ey >= 0 ? oy : oy + ey;
    const envMaxY = ey >= 0 ? oy + ey : oy;
    const envMinZ = ez >= 0 ? oz : oz + ez;
    const envMaxZ = ez >= 0 ? oz + ez : oz;

    const candidates = querySpatialHash(world.broadphase, envMinX, envMinY, envMinZ, envMaxX, envMaxY, envMaxZ);

    const selfGroups = settings.collisionGroups;
    const selfMask = settings.collisionMask;
    const ignoreId = settings.ignoreBodyId;
    const ignoreSensors = settings.ignoreSensors;

    let any = false;
    for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i]!;
        if (id === ignoreId) continue;
        const other = world.bodies.get(id);
        if (!other) continue;
        if (ignoreSensors && other.sensor) continue;
        if ((selfGroups & other.collisionMask) === 0) continue;
        if ((other.collisionGroups & selfMask) === 0) continue;

        const t = rayVsAabbWithNormal(
            ox,
            oy,
            oz,
            dx,
            dy,
            dz,
            length,
            other.position[0] - other.halfExtents[0],
            other.position[1] - other.halfExtents[1],
            other.position[2] - other.halfExtents[2],
            other.position[0] + other.halfExtents[0],
            other.position[1] + other.halfExtents[1],
            other.position[2] + other.halfExtents[2],
        );
        if (t === Infinity) continue;

        const fraction = t / length;
        if (fraction > collector.earlyOutFraction) continue;

        _castRayHit.status = CastRayStatus.COLLIDING;
        _castRayHit.fraction = fraction;
        _castRayHit.bodyId = other.id;
        collector.bodyId = other.id;
        collector.addHit(_castRayHit);
        any = true;

        if (collector.shouldEarlyOut()) break;
    }

    if (!any) collector.addMiss();
}
