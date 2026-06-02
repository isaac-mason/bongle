// ── aabb physics subsystem ──────────────────────────────────────────
//
// self-contained world for lightweight axis-aligned bodies. fills the gap
// between full crashcat rigid bodies (heavy: broadphase, manifolds, sleep)
// and the character controller (bespoke). targets items, falling props,
// throwables, sensors, and particle-scale simulation.
//
// shape mirrors crashcat: `World` + body factories + per-tick
// step + queries, all behind one cohesive API. the top-level `Physics`
// holds a single `aabbWorld` handle and calls `tick` from
// its tick — it does not own Body state, broadphase, or impostors.
//
// collision is analytical (`sweepAabbVsAabb`, `sweepAabbVsVoxels`). pair
// recording is gated on `_nodeId !== null` — imperative bodies created
// without a trait emit no pairs and pay no observer overhead. consumers
// that need reactive contact events attach an `BodyTrait`; the trait
// owns the contact API via `ContactsTrait` fan-out.

import * as crashcat from 'crashcat';
import { type Vec3, vec3 } from 'mathcat';
import type { AabbBodyTrait as AabbBodyTraitInstance } from '../../builtins/aabb-body';
import { TransformTrait } from '../../builtins/transform';
import type { PlayerId } from '../client';
import { type SweepResult, sweepAabbVsAabb } from '../math/aabb-sweep';
import type { Nodes } from '../scene/nodes';
import { query } from '../scene/nodes';
import type { TraitHandle } from '../scene/traits';
import {
    getWorldPosition,
    hasTransformedParent,
    markTransformDirty,
    worldToLocalPosition,
} from '../../builtins/transform';
import { BLOCK_FLAG_COLLISION } from '../voxels/block-registry';
import { createVoxelSweepHit, sweepAabbVsVoxels, type VoxelSweepHit } from '../voxels/voxel-aabb-sweep';
import type { Voxels } from '../voxels/voxels';
import { OBJECT_LAYER_AABB_IMPOSTOR } from './crashcat';

export enum MotionType {
    STATIC = 0,
    KINEMATIC = 1,
    DYNAMIC = 2,
}

// ── types ───────────────────────────────────────────────────────────

export type BodyId = number;

export type Body = {
    id: BodyId;

    position: Vec3;
    halfExtents: Vec3;
    linearVelocity: Vec3;

    /* default DYNAMIC. KINEMATIC bodies are externally driven (e.g. CC); STATIC bodies are fixed. */
    motionType: MotionType;

    /** mass in kg. used by the impulse-based normal resolver and by external pushers
     *  (e.g. character controller). values ≤ 0 are treated as 1. for "immovable" set
     *  motionType = STATIC or pushable = false. */
    mass: number;

    /* gravity multiplier (default 1). when zero, the body is unaffected by gravity. */
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
    /** when set, other bodies and the character controller can push this body
     *  via `applyImpulse`. */
    pushable: boolean;

    /** when set, a kinematic crashcat body shadows this body on `world.impostorObjectLayer`. */
    rigidBodyImpostor: boolean;
    /** impostor body when `rigidBodyImpostor` is on; null otherwise. */
    _impostor: crashcat.RigidBody | null;

    /** back-ref for trait-bound bodies. null ⇒ imperative; no pair recording, no fan-out. */
    _nodeId: number | null;

    /** continuous force accumulator (N). cleared each tick. apply via `applyForce`. */
    _forces: Vec3;
    /** one-shot impulse accumulator (kg·m/s). cleared each tick. apply via `applyImpulse`. */
    _impulses: Vec3;

    /** per-axis contact state: -1 / 0 / +1. set during slide-resolve when a sweep
     *  hits a static obstacle (voxel, non-pushable body) on that axis. drives
     *  per-axis friction next frame, "grounded" queries, and sleep. */
    resting: [number, number, number];
    /** snapshot of `resting` from the previous tick. drives noa-style per-axis
     *  friction: friction applies only when this tick's `dv` pushes into a
     *  surface we were already touching. */
    _prevResting: [number, number, number];

    /** per-axis stateId of the block the body is currently resting against.
     *  0 (AIR sentinel) for AABB-vs-AABB hits — registry tables return the
     *  neutral defaults (friction=1, restitution=0) for it. drives the
     *  per-block restitution combine in `applyPostImpactBounce`. */
    _restingStateId: [number, number, number];
    /** snapshot of `_restingStateId` from the previous tick. drives the
     *  per-block friction combine in `applyAxisFriction`. */
    _prevRestingStateId: [number, number, number];

    /** decrements each tick while velocity² < `sleepVelocityEpsSq`; at 0 the
     *  body sleeps. any external API touch resets to `SLEEP_RESET_FRAMES` via
     *  `_markActive`. */
    _sleepFrameCount: number;
    /** true ⇒ skip integration + slide-resolve entirely. body stays in the
     *  broadphase as an obstacle for awake neighbours. */
    _asleep: boolean;

    /** cached cell-range from the last broadphase insertion.
     *  `_broadphaseCellMinX > _broadphaseCellMaxX` is the "not inserted" sentinel.
     *  `moveInBroadphase` uses these to skip rehashing when the body's AABB
     *  still occupies the same cells (the common stationary / micro-movement case). */
    _broadphaseCellMinX: number;
    _broadphaseCellMinY: number;
    _broadphaseCellMinZ: number;
    _broadphaseCellMaxX: number;
    _broadphaseCellMaxY: number;
    _broadphaseCellMaxZ: number;

    /** index into `world.awakeBodies`. `-1` ⇒ not in the awake set (asleep or
     *  STATIC). maintained alongside swap-remove so addressing is O(1). */
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

/** writer surface — the top-level Physics passes one of these in so this
 *  module stays decoupled from the contact-pair pool / stream. */
export type PairSink = {
    record(pair: PairInfo): void;
};

/** flat-struct copy of one resolved contact between two AabbBodies, or an
 *  Body and the voxel terrain. the sink translates this into the global
 *  `ContactPair` stream. emitted only when at least one body has `_nodeId !== null`. */
export type PairInfo = {
    // side A — always an Body.
    aBodyId: BodyId;
    aNodeId: number | null;
    aIsSensor: boolean;

    // side B — either Body or voxel.
    bKind: 'aabbBody' | 'voxel';
    // when bKind === 'aabbBody':
    bBodyId: BodyId;
    bNodeId: number | null;
    bIsSensor: boolean;
    // when bKind === 'voxel':
    bVoxelX: number;
    bVoxelY: number;
    bVoxelZ: number;
    bStateId: number;
    bSubAabbIndex: number;

    // manifold. normal points A → B.
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

// ── broadphase: mutable uniform spatial hash ────────────────────────
//
// **mutable**: bodies are inserted on create, removed on destroy, and the
// cell-range is updated incrementally each tick via `moveInBroadphase` — no
// teardown-and-rebuild on every step. each body caches its last cell range
// (`_bpI*`), so "didn't move out of its cells" is an O(1) comparison and a
// no-op. asleep bodies stay in the hash as obstacles; they pay nothing per
// tick because the awake-set loop never visits them.
//
// one cellSize for the whole world. fine for the expected workload (items /
// particles, halfExtents typically ≤ 1m). for wildly mixed sizes (e.g. 16m
// sensors next to 0.1m particles), revisit with a two-level hash or DBVT —
// don't pre-build that.

// pack 3 signed 17-bit cell coords into a plain Number (51 bits used; JS safe-int is 53).
// ±65536 cells × cellSize=2 = ±131k world units — way beyond any realistic voxel world.
// BigInt was ~10× slower here and allocated per call; this is alloc-free.
const CELL_BITS = 17;
const CELL_MASK = (1 << CELL_BITS) - 1; // 0x1ffff
const CELL_MULT_Y = 1 << CELL_BITS; // 2^17
const CELL_MULT_X = CELL_MULT_Y * CELL_MULT_Y; // 2^34 (must use mul, JS << is 32-bit)

function hashKey(ix: number, iy: number, iz: number): number {
    return (ix & CELL_MASK) * CELL_MULT_X + (iy & CELL_MASK) * CELL_MULT_Y + (iz & CELL_MASK);
}

type SpatialHash = {
    cellSize: number;
    invCellSize: number;
    cells: Map<number, BodyId[]>;
    /** scratch buffer reused per query. */
    _queryHits: BodyId[];
    /** dedup within one query (a body can fall into multiple cells). */
    _seen: Set<BodyId>;
};

function createSpatialHash(cellSize: number): SpatialHash {
    return {
        cellSize,
        invCellSize: 1 / cellSize,
        cells: new Map(),
        _queryHits: [],
        _seen: new Set(),
    };
}

function clearSpatialHash(h: SpatialHash): void {
    h.cells.clear();
}

function removeBodyFromBucket(h: SpatialHash, key: number, id: BodyId): void {
    const bucket = h.cells.get(key);
    if (!bucket) return;
    // swap-remove. buckets are small (typically 1-3 ids per cell), so a linear
    // indexOf is faster than maintaining per-bucket maps.
    const idx = bucket.indexOf(id);
    if (idx === -1) return;
    const last = bucket.length - 1;
    if (idx !== last) bucket[idx] = bucket[last]!;
    bucket.pop();
    if (bucket.length === 0) h.cells.delete(key);
}

/** wake any sleeping (non-STATIC) body sharing a cell with `body`'s current
 *  broadphase footprint. used when `body` is about to move, teleport, or be
 *  destroyed — anything resting on it would otherwise stay frozen in midair
 *  because the awake-set loop never visits it and nothing else re-checks
 *  support. no-op if `body` was never inserted (sentinel cell range). */
function wakeSleepingNeighbors(world: World, body: Body): void {
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
                    if (!other || !other._asleep) continue;
                    if (other.motionType === MotionType.STATIC) continue;
                    markBodyActive(world, other);
                }
            }
        }
    }
}

/** insert OR move a body in the broadphase. compares the body's current AABB
 *  cell-range to the cached `_bpI*` range; if identical, returns immediately.
 *  otherwise removes from old cells, inserts into new, updates the cache. */
function moveInBroadphase(world: World, body: Body): void {
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

    // fast path: same cells as last time → nothing to do.
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

    // cells about to change — anything sleeping in the cells we currently
    // occupy might have been resting against us. wake them so they can
    // re-evaluate support next tick. cascades the wake up a stack as each
    // layer moves out from under the next.
    wakeSleepingNeighbors(world, body);

    // remove from old cells (sentinel min > max means "never inserted").
    if (body._broadphaseCellMinX <= body._broadphaseCellMaxX) {
        for (let iz = body._broadphaseCellMinZ; iz <= body._broadphaseCellMaxZ; iz++) {
            for (let iy = body._broadphaseCellMinY; iy <= body._broadphaseCellMaxY; iy++) {
                for (let ix = body._broadphaseCellMinX; ix <= body._broadphaseCellMaxX; ix++) {
                    removeBodyFromBucket(h, hashKey(ix, iy, iz), body.id);
                }
            }
        }
    }

    // insert into new cells.
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
function removeFromBroadphase(world: World, body: Body): void {
    if (body._broadphaseCellMinX > body._broadphaseCellMaxX) return;
    const h = world.broadphase;
    for (let iz = body._broadphaseCellMinZ; iz <= body._broadphaseCellMaxZ; iz++) {
        for (let iy = body._broadphaseCellMinY; iy <= body._broadphaseCellMaxY; iy++) {
            for (let ix = body._broadphaseCellMinX; ix <= body._broadphaseCellMaxX; ix++) {
                removeBodyFromBucket(h, hashKey(ix, iy, iz), body.id);
            }
        }
    }
    // reset to "not inserted" sentinel (min=1, max=0 ⇒ min > max).
    body._broadphaseCellMinX = 1;
    body._broadphaseCellMaxX = 0;
}

/** collect ids in any cell overlapping [min..max]. dedup via `_seen`. result is `h._queryHits`. */
function querySpatialHash(
    h: SpatialHash,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
): BodyId[] {
    const inv = h.invCellSize;
    const ix0 = Math.floor(minX * inv);
    const iy0 = Math.floor(minY * inv);
    const iz0 = Math.floor(minZ * inv);
    const ix1 = Math.floor(maxX * inv);
    const iy1 = Math.floor(maxY * inv);
    const iz1 = Math.floor(maxZ * inv);

    h._queryHits.length = 0;
    h._seen.clear();

    for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const bucket = h.cells.get(hashKey(ix, iy, iz));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const id = bucket[i]!;
                    if (h._seen.has(id)) continue;
                    h._seen.add(id);
                    h._queryHits.push(id);
                }
            }
        }
    }
    return h._queryHits;
}

// ── world ───────────────────────────────────────────────────────────

export type World = {
    /** terrain reference (voxel sweep target). */
    voxels: Voxels;

    /** gravity acceleration applied each tick (read once at create). */
    gravity: Vec3;

    /** velocity threshold below which restitution is silently set to 0 to kill
     *  perpetual micro-bounces from terminal-velocity ground hits.
     *  in m/s; mirrors noa-engine's `minBounceImpulse` purpose. */
    minBounceVelocity: number;

    /** squared linear-velocity threshold for sleep candidacy. when a body's
     *  |v|² < this and the gravity-probe finds it grounded, it sleeps. */
    sleepVelocityEpsSq: number;

    /** primary registry. iteration order = creation order; stable across ticks. */
    bodies: Map<BodyId, Body>;

    /** trait-bound bodies only; nodeId → BodyId. */
    nodeToBody: Map<number, BodyId>;

    /** for bodies with rigidBodyImpostor on: impostor BodyId → BodyId. */
    impostorToBody: Map<crashcat.BodyId, BodyId>;

    /** broadphase. mutable — incrementally maintained on create / destroy /
     *  per-tick `moveInBroadphase`. asleep bodies stay in the hash. */
    broadphase: SpatialHash;

    /** ids of bodies that should integrate this tick (DYNAMIC or KINEMATIC,
     *  and not `_asleep`). STATIC bodies are never in this list. iteration
     *  in `tick` walks this array, not `bodies.values()`. */
    awakeBodies: BodyId[];

    _nextId: number;

    // ── trait-sync binding (set by `bindNodeSync`, used by `preStep` / `postStep`) ──
    //
    // tests and headless callers leave this null; the top-level `Physics`
    // coordinator wires it up so the same World carries trait→world sync.
    // we don't import `AabbBodyTrait` as a value (would form a cycle with
    // `aabb-body.ts`'s `AabbPhysics.MotionType` reference) — the coordinator
    // passes the handle in so the query can be built here.
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
const SLEEP_RESET_FRAMES = 10;

export function create(voxels: Voxels, opts?: CreateWorldOpts): World {
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

/**
 * Wire a `World` up for trait → world sync. After this, `preStep` and
 * `postStep` will iterate the cached `[bodyTrait, TransformTrait]` query and
 * mirror trait state into bodies (and back). Idempotent: calling twice
 * replaces the binding.
 *
 * Called by the top-level `Physics` coordinator only — tests and headless
 * callers leave this unbound and skip `preStep`/`postStep`.
 */
export function bindNodeSync(
    world: World,
    nodes: Nodes,
    bodyTrait: TraitHandle<AabbBodyTraitInstance>,
): void {
    world._bodyQuery = query(nodes, [bodyTrait, TransformTrait]);
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

// ── awake-set bookkeeping ───────────────────────────────────────────
//
// O(1) add / remove via swap-remove. `body._awakeIndex` mirrors the array
// slot — every move keeps it in sync. STATIC bodies never enter the set.

function addToAwakeSet(world: World, body: Body): void {
    if (body._awakeIndex !== -1) return;
    if (body.motionType === MotionType.STATIC) return;
    body._awakeIndex = world.awakeBodies.length;
    world.awakeBodies.push(body.id);
}

function removeFromAwakeSet(world: World, body: Body): void {
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

/** transition a body to asleep: zero velocity, drop from the awake set.
 *  body stays in the broadphase as an obstacle for awake neighbours. */
function sleepBody(world: World, body: Body): void {
    body._asleep = true;
    body._sleepFrameCount = 0;
    body.linearVelocity[0] = 0;
    body.linearVelocity[1] = 0;
    body.linearVelocity[2] = 0;
    removeFromAwakeSet(world, body);
}

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
        // "not inserted" sentinel — moveInBroadphase below flips this.
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
    // was and floats in midair — the awake-set loop never visits it, and no
    // other pass re-checks support for sleeping bodies.
    wakeSleepingNeighbors(world, body);
    removeFromAwakeSet(world, body);
    removeFromBroadphase(world, body);
    if (body._nodeId !== null) world.nodeToBody.delete(body._nodeId);
    world.bodies.delete(body.id);
}

// ── external state mutations ────────────────────────────────────────
//
// every API that nudges a body wakes it AND ensures it's in `awakeBodies`
// so the next tick visits it. callers (trait sync, scripts, VCC pushes)
// MUST go through these helpers rather than poking fields directly — that
// would leave the body asleep + skipped by the tick loop.

/** wake a body and (re-)insert it into the awake set. cheap; no-op when already awake. */
export function markBodyActive(world: World, body: Body): void {
    body._sleepFrameCount = SLEEP_RESET_FRAMES;
    body._asleep = false;
    addToAwakeSet(world, body);
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
export function setBodyPosition(world: World, body: Body, x: number, y: number, z: number): void {
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
export function setBodyMotionType(world: World, body: Body, mt: MotionType): void {
    if (body.motionType === mt) return;
    body.motionType = mt;
    if (mt === MotionType.STATIC) {
        removeFromAwakeSet(world, body);
    } else {
        markBodyActive(world, body);
    }
}

/** overwrite velocity (kinematic drive / explicit set). wakes the body. */
export function setBodyVelocity(world: World, body: Body, vx: number, vy: number, vz: number): void {
    body.linearVelocity[0] = vx;
    body.linearVelocity[1] = vy;
    body.linearVelocity[2] = vz;
    markBodyActive(world, body);
}

/** trait-sync helper: copy new halfExtents in, reslot the body in the broadphase
 *  (since its AABB extent just changed), and wake it. callers that have already
 *  copied halfExtents must still call this so the broadphase cache + sleep state
 *  stay coherent. */
export function setBodyHalfExtents(world: World, body: Body, hx: number, hy: number, hz: number): void {
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

/** rebuild the impostor's shape — used when halfExtents change. */
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
 *     entirely — important for piles that have fully settled.
 */
export function tick(
    world: World,
    crashcatWorld: crashcat.World,
    dt: number,
    recordedPairs: PairSink,
): void {
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
            // stale id — heal by swap-removing in place and re-checking i.
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
    // have driven the body through the surface — it IS the impact velocity.
    // slideResolve will zero the normal component when it lands a contact;
    // the bounce step then reads this snapshot to apply -rest × impactVel.
    const vImpactX = body.linearVelocity[0];
    const vImpactY = body.linearVelocity[1];
    const vImpactZ = body.linearVelocity[2];

    // 3. slide-resolve against voxels + other AabbBodies.
    slideResolve(world, body, dt, sink);

    // 4. post-impact bounce. slideResolve has already zeroed the normal
    //    component on any resting axis, so the bounce only needs to ADD
    //    -rest × impactVel along that axis (not (1+rest) × — that would
    //    inject 50% extra energy every hit). gated by `minBounceVelocity`
    //    to kill perpetual micro-bounces near terminal velocity.
    if (body.restitution > 0) {
        applyPostImpactBounce(world, body, vImpactX, vImpactY, vImpactZ);
    }

    // 5. broadphase reslot (cell-range cache makes this O(1) when AABB hasn't
    //    crossed a cell boundary — the common micro-movement case).
    moveInBroadphase(world, body);

    // 6. impostor mirror (kinematic) — only on awake bodies; asleep bodies'
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
        // FAST PATH — two consecutive grounded + slow ticks ⇒ confidently settled.
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
                // in free space — clamp budget to 1 so we re-check next tick.
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
            // no hit — advance freely and stop.
            body.position[0] += dx;
            body.position[1] += dy;
            body.position[2] += dz;
            return;
        }

        // sensor or non-resolving best: advance through but record contact.
        const sensorHit = bestOther !== null && (body.sensor || bestOther.sensor);

        // advance by TOI (clamped to >= 0; analytical can return small
        // negative values for already-overlapping pairs — depenetrate).
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
            // sensors don't resolve — finish the unblocked motion this frame.
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
        const otherPushable =
            bestOther !== null && bestOther.pushable && !bestOther.sensor && bestOther.motionType === MotionType.DYNAMIC;

        const vAn = body.linearVelocity[0] * bestNX + body.linearVelocity[1] * bestNY + body.linearVelocity[2] * bestNZ;
        const vBn = bestOther
            ? bestOther.linearVelocity[0] * bestNX +
              bestOther.linearVelocity[1] * bestNY +
              bestOther.linearVelocity[2] * bestNZ
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
                // 0 (AIR sentinel) — registry tables return neutral defaults for it.
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
        // else: already separating along normal — leave velocity untouched.

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
        // voxels are static — relVel is just -aLin.
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

// ── queries ─────────────────────────────────────────────────────────

/**
 * sweep a moving AABB against all AabbBodies via the broadphase. used by
 * VCC and any other AABB-native client that wants to see AabbBodies as
 * obstacles. exact (analytical), respects groups/mask filters, optional
 * id-ignore for self-exclusion.
 *
 * `out` is mutated in place. returns `null` if no hit. on hit, `out` carries
 * the winning sweep, and the returned `Body` is the obstacle.
 */
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

/** lookup helper. */
export function getBodyByNodeId(world: World, nodeId: number): Body | undefined {
    const id = world.nodeToBody.get(nodeId);
    return id === undefined ? undefined : world.bodies.get(id);
}

// ── castRay ─────────────────────────────────────────────────────────
//
// shape mirrors crashcat's CastRay api so consumer code reads the same way:
// status enum, hit struct (pool-friendly), settings, and a collector
// interface with three canonical implementations (All / Any / Closest). pools
// are hand-rolled inline — no external pool dep, no external alloc per ray.
//
// the underlying primitive is slab-test ray-vs-AABB. broadphase candidates
// come from an envelope-AABB query of the ray segment. asleep bodies stay in
// the hash and are reported, since castRays are observational and shouldn't
// care about simulation state.

export enum CastRayStatus {
    NOT_COLLIDING = 0,
    COLLIDING = 1,
}

export type CastRayHit = {
    status: CastRayStatus;
    /** fraction along the ray where the hit occurred — 0 at origin, 1 at origin + dir*length. */
    fraction: number;
    /** id of the body that was hit. -1 ⇒ no hit. */
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
    /** if set, the ray ignores this body id. -1 ⇒ no exclusion. */
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
    /** scratch slot used by `castRay` to publish the bodyId of the candidate
     *  being tested to the collector before calling `addHit`. mirrors crashcat. */
    bodyId: BodyId;
    /** rays past this fraction are pruned. collectors lower it as hits land. */
    earlyOutFraction: number;
    addHit(hit: CastRayHit): void;
    addMiss(): void;
    shouldEarlyOut(): boolean;
};

const INITIAL_EARLY_OUT_FRACTION = 1.0 + 1e-4;
const SHOULD_EARLY_OUT_FRACTION = 0.0;

/** collects every hit along the ray. hits are pooled — calling `reset()`
 *  returns the buffer to the pool without re-allocating. */
export class AllCastRayCollector implements CastRayCollector {
    bodyId: BodyId = -1;
    earlyOutFraction = INITIAL_EARLY_OUT_FRACTION;
    hits: CastRayHit[] = [];
    /** simple growing pool: `_pool[0.._poolCursor]` are in-use, rest are free. */
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
    addMiss(): void {
        // no-op
    }
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
    addMiss(): void {
        // no-op
    }
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

/** keeps the closest hit. lowers `earlyOutFraction` after each accepted hit
 *  so the driver can prune candidates past the current best. */
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
    addMiss(): void {
        // no-op
    }
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

/** scratch hit handed to `collector.addHit` per candidate — the collector
 *  copies values out, so reusing this is safe. */
const _castRayHit: CastRayHit = createCastRayHit();

/** ray-vs-AABB slab test. on hit, returns the entry fraction and writes the
 *  outward face normal into `outN*`. caller has already filtered the box by
 *  envelope; we return Infinity for misses. */
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
    // axis of the latest entry. updated whenever a slab's entry pushes tNear
    // forward; that axis is the entry face. sign of the normal is -sign(dir)
    // on that axis (face outward normal opposes the ray on that slab).
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

    // write normal into the scratch hit (caller will copy).
    _castRayHit.normalX = 0;
    _castRayHit.normalY = 0;
    _castRayHit.normalZ = 0;
    if (nAxis === 0) _castRayHit.normalX = dx > 0 ? -1 : 1;
    else if (nAxis === 1) _castRayHit.normalY = dy > 0 ? -1 : 1;
    else if (nAxis === 2) _castRayHit.normalZ = dz > 0 ? -1 : 1;
    // nAxis === -1 only when the ray origin is already inside every slab —
    // treat that as fraction 0 with an undefined normal (consumer can detect
    // by zero normal). matches crashcat's "treatConvexAsSolid" default for
    // rays starting inside a shape.

    return tNear;
}

/**
 * cast a ray against all AabbBodies in the world. results are fed to
 * `collector` via its `addHit`/`addMiss`/`shouldEarlyOut` hooks; the caller
 * owns the collector (and may reuse it across casts with `reset()`).
 *
 * `dx,dy,dz` is the (unnormalized) ray direction; `length` is the multiplier
 * applied to it. `fraction` in hits is the [0..length] parameter divided by
 * `length` — same as crashcat. ray = origin + (dir * length) * fraction.
 */
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

    // envelope of the ray: a bounding box around the segment. broadphase
    // candidates are anything in cells overlapping this envelope. for very
    // long rays this becomes coarse — revisit with DDA cell-walk if it
    // shows up in profiles.
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
        // normal was written into _castRayHit by rayVsAabbWithNormal above.
        collector.bodyId = other.id;
        collector.addHit(_castRayHit);
        any = true;

        if (collector.shouldEarlyOut()) break;
    }

    if (!any) collector.addMiss();
}

// ── trait → world sync ────────────────────────────────────────────────
//
// the AabbBody struct IS our snapshot — every field is a plain JS write on
// memory we own, so we mirror trait → body unconditionally each preStep.
// only halfExtents and rigidBodyImpostor require special handling (the
// impostor's crashcat body has to be rebuilt when either changes).
//
// preStep / postStep are no-ops unless `bindNodeSync` has been called.

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
    // first install — create the body. companion-trait (Interpolate, Contacts)
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
    setBodyMotionType(world, body, effectiveAabbMotionType(t, identity, simulate));
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
        setBodyHalfExtents(world, body, t.halfExtents[0], t.halfExtents[1], t.halfExtents[2]);
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
    // "respawn with new velocity" pattern), pick it up after the zero — this
    // is the only sanctioned way to inject velocity into a DYNAMIC body from
    // script. otherwise teleports preserve "fresh start, no momentum" semantics.
    const wp = getWorldPosition(transform);
    if (!vec3.equals(wp, body.position)) {
        setBodyPosition(world, body, wp[0], wp[1], wp[2]);
        if (t.linearVelocity[0] !== 0 || t.linearVelocity[1] !== 0 || t.linearVelocity[2] !== 0) {
            setBodyVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
        }
    }

    // client-side replication smoothing for non-owner KINEMATIC bodies —
    // sync'd linearVelocity drives integration between sparse pose updates.
    if (identity !== null && t._node.owner !== identity && body.motionType === MotionType.KINEMATIC) {
        setBodyVelocity(world, body, t.linearVelocity[0], t.linearVelocity[1], t.linearVelocity[2]);
    }
}

/** trait → world sync. install/update bodies for nodes with the bound aabb body
 *  trait; destroy bodies for nodes that lost the trait. no-op unless
 *  `bindNodeSync` has been called. */
export function preStep(
    world: World,
    crashcatWorld: crashcat.World,
    identity: PlayerId | null,
    simulate: boolean,
): void {
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
