import type { BodyId } from 'crashcat';
import { type Vec3, vec3 } from 'math';

type ContactBase = {
    /** contact point in world space. */
    point: Vec3;
    /** unit normal, pointing AWAY from the observer. */
    normal: Vec3;
    /** positive when penetrating; 0 otherwise. */
    penetrationDepth: number;
};

export type RigidBodyContact = ContactBase & {
    type: 'rigidBody';
    nodeId: number;
    bodyId: BodyId;
    /** sub-shape within the other body's compound, 0 for non-compound. */
    subShapeId: number;
    isSensor: boolean;
    /** other body's linear velocity at contact, in observer frame: bLin - selfLin. */
    relativeVelocity: Vec3;
};

/** observer-normalized contact with an AabbBody (from the AabbPhysics.World). */
export type AabbBodyContact = ContactBase & {
    type: 'aabbBody';
    aabbBodyId: number;
    /** the trait-bound node owning the other AabbBody, or null when the other side is an imperative body. */
    nodeId: number | null;
    isSensor: boolean;
    /** other body's linear velocity at contact, in observer frame: bLin - selfLin. */
    relativeVelocity: Vec3;
};

/** observer-normalized contact with the voxel terrain. */
export type VoxelContact = ContactBase & {
    type: 'voxel';
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    stateId: number;
    /** sub-aabb index for multi-aabb voxels; -1 for cube voxels. */
    subAabbIndex: number;
    /** true when colliding with a solid voxel; false for a passable/liquid overlap. */
    solid: boolean;
};

export type Contact = RigidBodyContact | AabbBodyContact | VoxelContact;

// flat field layout, not nested side objects, so pairs pool without re-allocating side sub-objects.

export type ContactPairSideKind = 'rigidBody' | 'aabbBody' | 'voxel';

export type ContactPair = {
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
    /** voxel-only: true = solid collision, false = passable/liquid overlap. */
    aVoxelSolid: boolean;
    aIsSensor: boolean;

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
    /** voxel-only: true = solid collision, false = passable/liquid overlap. */
    bVoxelSolid: boolean;
    bIsSensor: boolean;

    point: Vec3;
    /** unit normal pointing from A toward B. */
    normal: Vec3;
    penetrationDepth: number;
    /** bLin - aLin at contact, world space. */
    relativeVelocity: Vec3;

    /** canonical pair key, set by `recordContactPair`; cached to avoid rebuilding it during eviction. */
    _key: string;
};

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
        solid: true,
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
        aVoxelSolid: true,
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
        bVoxelSolid: true,
        bIsSensor: false,

        point: vec3.create(),
        normal: vec3.create(),
        penetrationDepth: 0,
        relativeVelocity: vec3.create(),
        _key: '',
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

// string keys: voxel coords can overflow 53-bit numeric packing once sub-shape and sub-aabb dims factor in.

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

/** combine two side keys into a canonical, order-independent pair key. */
export function pairKey(sideA: string, sideB: string): string {
    return sideA < sideB ? `${sideA}|${sideB}` : `${sideB}|${sideA}`;
}

/** physics-wide contact stream for one step; owns the diff state across steps via `_byKey`. */
export type PhysicsContacts = {
    /** all contacts active this step, `added` ++ `persisted`. */
    active: ContactPair[];
    added: ContactPair[];
    persisted: ContactPair[];
    /** present last step, gone this step. fields are last-known. */
    removed: ContactPair[];

    /** persistent index: every pair currently retained, keyed canonically. */
    _byKey: Map<string, ContactPair>;
    _seen: Set<string>;
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

/** start a new contact frame; evicts the previous step's `removed` entries and clears the per-step lists. */
export function beginPhysicsContactsFrame(pc: PhysicsContacts, pairPool: ContactPairPool): void {
    if (pc._frameOpen) {
        throw new Error('contacts: beginPhysicsContactsFrame called without prior end');
    }
    pc._frameOpen = true;

    for (const stale of pc.removed) {
        pc._byKey.delete(stale._key);
        releaseContactPair(pairPool, stale);
    }
    pc.removed.length = 0;

    pc.added.length = 0;
    pc.persisted.length = 0;
    pc.active.length = 0;
    pc._seen.clear();
}

/** acquire or find a `ContactPair` for the given canonical key; repeat calls this frame return the same instance. */
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
    fresh._key = key;
    pc._byKey.set(key, fresh);
    pc.added.push(fresh);
    pc.active.push(fresh);
    return fresh;
}

/** close a contact frame; classifies any retained pair not touched this step as `removed`, kept one more step. */
export function endPhysicsContactsFrame(pc: PhysicsContacts): void {
    if (!pc._frameOpen) {
        throw new Error('contacts: endPhysicsContactsFrame called without prior begin');
    }
    for (const [k, pair] of pc._byKey) {
        if (!pc._seen.has(k)) pc.removed.push(pair);
    }
    pc._frameOpen = false;
}
