// contact bookkeeping, types, pools, and the per-step global stream.
//
// two layers:
//   1. `ContactPair`, un-normalized record of a touching pair (A→B). lives
//      in `physics.contacts`, populated during the physics listener step
//      (rigid bodies, voxels) and the AABB physics step (aabb bodies, voxels).
//      one entry per canonical pair regardless of perspective.
//   2. `RigidBodyContact` / `AabbBodyContact` / `VoxelContact`, observer-
//      normalized contact (normal points away from self). lives in per-node
//      `ContactsTrait` lists, populated by the post-step fan-out from
//      `physics.contacts`.
//
// the diff lifecycle (added/persisted/removed, one-step grace for removed)
// is owned at the pair level. per-trait lists are throwaway each step,
// fan-out clears and refills.
//
// pools: separate per concrete type. `RigidBodyContactPool`, `AabbBodyContactPool`
// and `VoxelContactPool` for per-trait Contacts; `ContactPairPool` for the
// global stream. all live on `Physics`.

import type { BodyId } from 'crashcat';
import { type Vec3, vec3 } from 'mathcat';

// ── per-observer contact (what scripts read via ContactsTrait) ────────

/** common fields across all observer-normalized contacts. */
type ContactBase = {
    /** contact point in world space. */
    point: Vec3;
    /** unit normal, pointing AWAY from the observer. */
    normal: Vec3;
    /** positive when penetrating; 0 otherwise. */
    penetrationDepth: number;
};

/** observer-normalized contact with another node-backed rigid body. */
export type RigidBodyContact = ContactBase & {
    type: 'rigidBody';
    /** the other node. */
    nodeId: number;
    /** the other body's crashcat id (mainly useful for editor/debug). */
    bodyId: BodyId;
    /** sub-shape within the other body's compound, 0 for non-compound. */
    subShapeId: number;
    /** the other body is a sensor, this contact is informational. */
    isSensor: boolean;
    /** other body's linear velocity at contact, in observer frame: bLin - selfLin. */
    relativeVelocity: Vec3;
};

/** observer-normalized contact with an AabbBody (from the AabbPhysics.World). */
export type AabbBodyContact = ContactBase & {
    type: 'aabbBody';
    /** id of the other AabbBody. */
    aabbBodyId: number;
    /** the trait-bound node owning the other AabbBody, or null when the other side is an imperative body. */
    nodeId: number | null;
    /** the other body is a sensor, this contact is informational. */
    isSensor: boolean;
    /** other body's linear velocity at contact, in observer frame: bLin - selfLin. */
    relativeVelocity: Vec3;
};

/** observer-normalized contact with the voxel terrain. */
export type VoxelContact = ContactBase & {
    type: 'voxel';
    /** cell coordinates of the touched voxel. */
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    /** voxel state id (block kind). */
    stateId: number;
    /** sub-aabb index for multi-aabb voxels; -1 for cube voxels. */
    subAabbIndex: number;
};

export type Contact = RigidBodyContact | AabbBodyContact | VoxelContact;

// ── pair (global, un-normalized) ─────────────────────────────────────
//
// flat field layout (rather than nested side objects) so pair instances
// can be pooled cleanly across runs of different side-kind combinations
// (rigidBody-rigidBody, rigidBody-voxel, aabbBody-aabbBody, ...) without
// re-allocating side sub-objects.

export type ContactPairSideKind = 'rigidBody' | 'aabbBody' | 'voxel';

export type ContactPair = {
    // ── side A ──
    aKind: ContactPairSideKind;
    // rigidBody-only fields (valid when aKind === 'rigidBody')
    aNodeId: number;
    aBodyId: BodyId;
    aSubShapeId: number;
    // aabbBody-only fields (valid when aKind === 'aabbBody')
    aAabbBodyId: number;
    /** -1 when the aabb body is imperative (no trait). */
    aAabbNodeId: number;
    // voxel-only fields (valid when aKind === 'voxel')
    aVoxelX: number;
    aVoxelY: number;
    aVoxelZ: number;
    aStateId: number;
    aSubAabbIndex: number;
    // shared on body sides (rigidBody, aabbBody)
    aIsSensor: boolean;

    // ── side B ──
    bKind: ContactPairSideKind;
    bNodeId: number;
    bBodyId: BodyId;
    bSubShapeId: number;
    bAabbBodyId: number;
    bAabbNodeId: number;
    bVoxelX: number;
    bVoxelY: number;
    bVoxelZ: number;
    bStateId: number;
    bSubAabbIndex: number;
    bIsSensor: boolean;

    // ── manifold ──
    /** contact point in world space. */
    point: Vec3;
    /** unit normal pointing from A toward B. */
    normal: Vec3;
    /** positive when penetrating. */
    penetrationDepth: number;
    /** bLin - aLin at contact, world space. */
    relativeVelocity: Vec3;
};

// ── pools ────────────────────────────────────────────────────────────

export type RigidBodyContactPool = { free: RigidBodyContact[] };
export type AabbBodyContactPool = { free: AabbBodyContact[] };
export type VoxelContactPool = { free: VoxelContact[] };
export type ContactPairPool = { free: ContactPair[] };

export function createRigidBodyContactPool(): RigidBodyContactPool {
    return { free: [] };
}

export function createAabbBodyContactPool(): AabbBodyContactPool {
    return { free: [] };
}

export function createVoxelContactPool(): VoxelContactPool {
    return { free: [] };
}

export function createContactPairPool(): ContactPairPool {
    return { free: [] };
}

function createRigidBodyContact(): RigidBodyContact {
    return {
        type: 'rigidBody',
        nodeId: 0,
        bodyId: -1 as BodyId,
        subShapeId: 0,
        isSensor: false,
        point: vec3.create(),
        normal: vec3.create(),
        penetrationDepth: 0,
        relativeVelocity: vec3.create(),
    };
}

function createAabbBodyContact(): AabbBodyContact {
    return {
        type: 'aabbBody',
        aabbBodyId: 0,
        nodeId: null,
        isSensor: false,
        point: vec3.create(),
        normal: vec3.create(),
        penetrationDepth: 0,
        relativeVelocity: vec3.create(),
    };
}

function createVoxelContact(): VoxelContact {
    return {
        type: 'voxel',
        voxelX: 0,
        voxelY: 0,
        voxelZ: 0,
        stateId: 0,
        subAabbIndex: -1,
        point: vec3.create(),
        normal: vec3.create(),
        penetrationDepth: 0,
    };
}

function createContactPair(): ContactPair {
    return {
        aKind: 'rigidBody',
        aNodeId: 0,
        aBodyId: -1 as BodyId,
        aSubShapeId: 0,
        aAabbBodyId: 0,
        aAabbNodeId: -1,
        aVoxelX: 0,
        aVoxelY: 0,
        aVoxelZ: 0,
        aStateId: 0,
        aSubAabbIndex: -1,
        aIsSensor: false,

        bKind: 'rigidBody',
        bNodeId: 0,
        bBodyId: -1 as BodyId,
        bSubShapeId: 0,
        bAabbBodyId: 0,
        bAabbNodeId: -1,
        bVoxelX: 0,
        bVoxelY: 0,
        bVoxelZ: 0,
        bStateId: 0,
        bSubAabbIndex: -1,
        bIsSensor: false,

        point: vec3.create(),
        normal: vec3.create(),
        penetrationDepth: 0,
        relativeVelocity: vec3.create(),
    };
}

export function acquireRigidBodyContact(pool: RigidBodyContactPool): RigidBodyContact {
    return pool.free.pop() ?? createRigidBodyContact();
}

export function acquireAabbBodyContact(pool: AabbBodyContactPool): AabbBodyContact {
    return pool.free.pop() ?? createAabbBodyContact();
}

export function acquireVoxelContact(pool: VoxelContactPool): VoxelContact {
    return pool.free.pop() ?? createVoxelContact();
}

export function acquireContactPair(pool: ContactPairPool): ContactPair {
    return pool.free.pop() ?? createContactPair();
}

/** release a Contact back to the appropriate per-type pool. */
export function releaseContact(
    rigidBodyPool: RigidBodyContactPool,
    aabbBodyPool: AabbBodyContactPool,
    voxelPool: VoxelContactPool,
    c: Contact,
): void {
    if (c.type === 'rigidBody') rigidBodyPool.free.push(c);
    else if (c.type === 'aabbBody') aabbBodyPool.free.push(c);
    else voxelPool.free.push(c);
}

export function releaseContactPair(pool: ContactPairPool, p: ContactPair): void {
    pool.free.push(p);
}

// ── keying ───────────────────────────────────────────────────────────
//
// strings, simplest correct option. voxel coords can be arbitrarily large
// (any reasonable world overflows 53-bit packing once you factor in
// sub-shape + sub-aabb dimensions), so don't pretend a numeric scheme works.
// Map<string, ContactPair> is well-optimized in modern engines; revisit
// only if profiling shows it hot.

/** canonical key fragment for a rigid-body side. */
export function rigidBodySideKey(nodeId: number, subShapeId: number): string {
    return `r${nodeId}.${subShapeId}`;
}

/** canonical key fragment for an AabbBody side. */
export function aabbBodySideKey(aabbBodyId: number): string {
    return `a${aabbBodyId}`;
}

/** canonical key fragment for a voxel side. */
export function voxelSideKey(voxelX: number, voxelY: number, voxelZ: number, subAabbIndex: number): string {
    return `v${voxelX},${voxelY},${voxelZ}.${subAabbIndex}`;
}

/**
 * combine two side keys into a canonical pair key. order-independent:
 * `pairKey(a, b) === pairKey(b, a)`.
 */
export function pairKey(sideA: string, sideB: string): string {
    return sideA < sideB ? `${sideA}|${sideB}` : `${sideB}|${sideA}`;
}

// ── global per-step stream ───────────────────────────────────────────

/**
 * physics-wide contact stream for one step. owns the diff state across
 * steps via `_byKey`. lifecycle:
 *
 *   step N end:    _byKey ⊇ (active this step) ∪ (removed this step)
 *   step N+1 begin:
 *     - last step's `removed` evicted from _byKey, returned to pool.
 *     - _byKey now = last step's `active`. that's what we diff against.
 *   ...recordContactPair calls fill added/persisted, populate _seen...
 *   step N+1 end:  _byKey entries not in _seen → moved to `removed`,
 *                  retained in _byKey one more step so consumers see
 *                  last-known fields.
 */
export type PhysicsContacts = {
    /** all contacts active this step, `added` ++ `persisted`. */
    active: ContactPair[];
    /** first seen this step. */
    added: ContactPair[];
    /** present last step AND this step. */
    persisted: ContactPair[];
    /** present last step, gone this step. fields are last-known. */
    removed: ContactPair[];

    /** persistent index: every pair currently retained, keyed canonically. */
    _byKey: Map<string, ContactPair>;
    /** keys recorded so far this step. */
    _seen: Set<string>;
    /** true between begin and end of a frame. */
    _frameOpen: boolean;
};

export function createPhysicsContacts(): PhysicsContacts {
    return {
        active: [],
        added: [],
        persisted: [],
        removed: [],
        _byKey: new Map(),
        _seen: new Set(),
        _frameOpen: false,
    };
}

/**
 * start a new contact frame. evicts the previous step's `removed` entries
 * (their one-step grace period for last-known reads is now over) and
 * clears the per-step lists. `_byKey` carries forward as the prev-step
 * active set, used to classify pairs into added vs persisted.
 */
export function beginPhysicsContactsFrame(pc: PhysicsContacts, pairPool: ContactPairPool): void {
    if (pc._frameOpen) {
        throw new Error('contacts: beginPhysicsContactsFrame called without prior end');
    }
    pc._frameOpen = true;

    for (const stale of pc.removed) {
        pc._byKey.delete(pairKeyFromPair(stale));
        releaseContactPair(pairPool, stale);
    }
    pc.removed.length = 0;

    pc.added.length = 0;
    pc.persisted.length = 0;
    pc.active.length = 0;
    pc._seen.clear();
}

/**
 * acquire-or-find a `ContactPair` for the given canonical key. caller is
 * responsible for filling all side + manifold fields after this returns.
 *
 * called twice with the same key in one frame: returns the same instance
 * (the second caller can short-circuit if it doesn't need to overwrite).
 * caller can detect duplicates via the boolean `wasNew` channel if it
 * cares, we don't expose one for now, since the common case is "fill
 * unconditionally, it's cheap."
 */
export function recordContactPair(pc: PhysicsContacts, pairPool: ContactPairPool, key: string): ContactPair {
    if (pc._seen.has(key)) {
        return pc._byKey.get(key)!;
    }
    pc._seen.add(key);

    const prev = pc._byKey.get(key);
    if (prev) {
        pc.persisted.push(prev);
        pc.active.push(prev);
        return prev;
    }

    const fresh = acquireContactPair(pairPool);
    pc._byKey.set(key, fresh);
    pc.added.push(fresh);
    pc.active.push(fresh);
    return fresh;
}

/**
 * close a contact frame. classifies any retained pair whose key wasn't
 * touched this step as `removed`, keeping it in `_byKey` (and out of the
 * pool) for one more step so consumers see last-known fields.
 */
export function endPhysicsContactsFrame(pc: PhysicsContacts): void {
    if (!pc._frameOpen) {
        throw new Error('contacts: endPhysicsContactsFrame called without prior begin');
    }
    for (const [k, pair] of pc._byKey) {
        if (!pc._seen.has(k)) pc.removed.push(pair);
    }
    pc._frameOpen = false;
}

// ── internal: rebuild a pair's canonical key from its fields ─────────
//
// only used in `begin` to evict the previous step's `removed` entries.
// hot path callers should compute keys up front and reuse them.

function sideKeyFromPair(
    kind: ContactPairSideKind,
    nodeId: number,
    subShapeId: number,
    aabbBodyId: number,
    voxelX: number,
    voxelY: number,
    voxelZ: number,
    subAabbIndex: number,
): string {
    if (kind === 'rigidBody') return rigidBodySideKey(nodeId, subShapeId);
    if (kind === 'aabbBody') return aabbBodySideKey(aabbBodyId);
    return voxelSideKey(voxelX, voxelY, voxelZ, subAabbIndex);
}

function pairKeyFromPair(p: ContactPair): string {
    const a = sideKeyFromPair(p.aKind, p.aNodeId, p.aSubShapeId, p.aAabbBodyId, p.aVoxelX, p.aVoxelY, p.aVoxelZ, p.aSubAabbIndex);
    const b = sideKeyFromPair(p.bKind, p.bNodeId, p.bSubShapeId, p.bAabbBodyId, p.bVoxelX, p.bVoxelY, p.bVoxelZ, p.bSubAabbIndex);
    return pairKey(a, b);
}
