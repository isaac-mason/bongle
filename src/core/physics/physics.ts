import { type BodyId, rigidBody } from 'crashcat';
import { type Vec3, vec3 } from 'math';
import { AabbBodyTrait } from '../../builtins/aabb-body';
import { ContactsTrait } from '../../builtins/contacts';
import { setInterpolation } from '../../builtins/transform';
import type { PlayerId } from '../client';
import type * as Resources from '../resources';
import type { Node, SceneTree } from '../scene/scene-tree';
import { addTrait, getNodeById, getTrait, query, runOnPostPhysicsStep, runOnPrePhysicsStep } from '../scene/scene-tree';
import { flushHitBuffer } from '../voxels/voxel-physics-shape';
import type { Voxels } from '../voxels/voxels';
import * as AabbPhysics from './aabb';
import {
    type AabbBodyContactPool,
    aabbBodySideKey,
    acquireAabbBodyContact,
    acquireRigidBodyContact,
    acquireVoxelContact,
    beginPhysicsContactsFrame,
    type Contact,
    type ContactPair,
    type ContactPairPool,
    createAabbBodyContactPool,
    createContactPairPool,
    createPhysicsContacts,
    createRigidBodyContactPool,
    createVoxelContactPool,
    endPhysicsContactsFrame,
    type PhysicsContacts,
    pairKey,
    type RigidBodyContactPool,
    recordContactPair,
    releaseContact,
    type VoxelContactPool,
    voxelSideKey,
} from './contacts';
import * as RigidPhysics from './rigid/rigid-world';

// re-exported so existing import sites (`from './physics'`) keep working.
export {
    BROADPHASE_LAYER_EDITOR_NODES,
    BROADPHASE_LAYER_MOVING,
    BROADPHASE_LAYER_NOT_MOVING,
    COLLISION_GROUP_CHARACTERS,
    COLLISION_GROUP_NODES,
    COLLISION_GROUP_VOXELS,
    OBJECT_LAYER_AABB_IMPOSTOR,
    OBJECT_LAYER_EDITOR_NODES,
    OBJECT_LAYER_NODE_MOVING,
    OBJECT_LAYER_NODE_NOT_MOVING,
    OBJECT_LAYER_VOXELS,
    settings,
} from './rigid/rigid-world-settings';

// thin coordinator over the rigid and aabb physics sub-worlds, sharing one contact stream.

export type Physics = {
    /** rigid-body sub-world: full broadphase, manifolds, sleep. */
    rigid: RigidPhysics.World;
    /** AABB physics sub-world, items / particles / throwables. analytical sweep. */
    aabb: AabbPhysics.World;

    /** global contact stream, pairs un-normalized (A to B), with added/persisted/removed lifecycle. */
    contacts: PhysicsContacts;
    rigidBodyContactPool: RigidBodyContactPool;
    aabbBodyContactPool: AabbBodyContactPool;
    voxelContactPool: VoxelContactPool;
    /** pool of ContactPair instances backing `contacts.*` lists. */
    contactPairPool: ContactPairPool;
    /** cached query for fan-out, built once at init so we don't pay hash+lookup each tick. */
    contactsQuery: ReturnType<typeof query<[typeof ContactsTrait]>>;

    /** sink passed into `AabbPhysics.tick`. drains pairs into `contacts`. */
    aabbPairSink: AabbPhysics.PairSink;

    /** VCC body contacts staged for replay into `contacts` each tick (see `ingestVccRigidContacts`). */
    vccRigidContacts: VccRigidContact[];
    vccRigidContactCount: number;

    /** VCC voxel contacts staged for replay into `contacts` each tick (see `ingestVccVoxelContacts`). */
    vccVoxelContacts: VccVoxelContact[];
    vccVoxelContactCount: number;

    /** nodes currently enrolled in interpolation because a subsystem has a body for them. */
    _companionNodes: Set<number>;
};

/** one rigid-body contact from a character VCC, pending replay; body ids (not refs) so a removed body is skipped. */
export type VccRigidContact = {
    innerBodyId: BodyId;
    otherBodyId: BodyId;
    point: Vec3;
    normal: Vec3;
    penetrationDepth: number;
};

/** one voxel (terrain) contact reported by a character VCC, pending replay. */
export type VccVoxelContact = {
    innerBodyId: BodyId;
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    stateId: number;
    subAabbIndex: number;
    point: Vec3;
    normal: Vec3;
    penetrationDepth: number;
    /** true = solid block swept against; false = passable/liquid cell reported by overlap. */
    solid: boolean;
};

export function init(sceneTree: SceneTree, voxels: Voxels): Physics {
    const rigid = RigidPhysics.create(sceneTree, voxels);
    const aabb = AabbPhysics.createWorld(voxels);
    AabbPhysics.bindNodeSync(aabb, sceneTree, AabbBodyTrait);

    const contacts = createPhysicsContacts();
    const contactPairPool = createContactPairPool();
    const aabbPairSink = makeAabbPairSink(contacts, contactPairPool);

    return {
        rigid,
        aabb,
        contacts,
        rigidBodyContactPool: createRigidBodyContactPool(),
        aabbBodyContactPool: createAabbBodyContactPool(),
        voxelContactPool: createVoxelContactPool(),
        contactPairPool,
        contactsQuery: query(sceneTree, [ContactsTrait]),
        aabbPairSink,
        vccRigidContacts: [],
        vccRigidContactCount: 0,
        vccVoxelContacts: [],
        vccVoxelContactCount: 0,
        _companionNodes: new Set(),
    };
}

/** record a body contact a character VCC saw this frame, replayed by `ingestVccRigidContacts`. */
export function pushVccRigidContact(
    physics: Physics,
    innerBodyId: BodyId,
    otherBodyId: BodyId,
    pointX: number,
    pointY: number,
    pointZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    penetrationDepth: number,
): void {
    let rec = physics.vccRigidContacts[physics.vccRigidContactCount];
    if (!rec) {
        rec = { innerBodyId: -1, otherBodyId: -1, point: vec3.create(), normal: vec3.create(), penetrationDepth: 0 };
        physics.vccRigidContacts[physics.vccRigidContactCount] = rec;
    }
    rec.innerBodyId = innerBodyId;
    rec.otherBodyId = otherBodyId;
    rec.point[0] = pointX;
    rec.point[1] = pointY;
    rec.point[2] = pointZ;
    rec.normal[0] = normalX;
    rec.normal[1] = normalY;
    rec.normal[2] = normalZ;
    rec.penetrationDepth = penetrationDepth;
    physics.vccRigidContactCount++;
}

/** record a voxel (terrain) contact a character VCC saw this frame, replayed by `ingestVccVoxelContacts`. */
export function pushVccVoxelContact(
    physics: Physics,
    innerBodyId: BodyId,
    voxelX: number,
    voxelY: number,
    voxelZ: number,
    stateId: number,
    subAabbIndex: number,
    pointX: number,
    pointY: number,
    pointZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    penetrationDepth: number,
    solid: boolean,
): void {
    let rec = physics.vccVoxelContacts[physics.vccVoxelContactCount];
    if (!rec) {
        rec = {
            innerBodyId: -1,
            voxelX: 0,
            voxelY: 0,
            voxelZ: 0,
            stateId: 0,
            subAabbIndex: -1,
            point: vec3.create(),
            normal: vec3.create(),
            penetrationDepth: 0,
            solid: true,
        };
        physics.vccVoxelContacts[physics.vccVoxelContactCount] = rec;
    }
    rec.solid = solid;
    rec.innerBodyId = innerBodyId;
    rec.voxelX = voxelX;
    rec.voxelY = voxelY;
    rec.voxelZ = voxelZ;
    rec.stateId = stateId;
    rec.subAabbIndex = subAabbIndex;
    rec.point[0] = pointX;
    rec.point[1] = pointY;
    rec.point[2] = pointZ;
    rec.normal[0] = normalX;
    rec.normal[1] = normalY;
    rec.normal[2] = normalZ;
    rec.penetrationDepth = penetrationDepth;
    physics.vccVoxelContactCount++;
}

/** replay this tick's VCC body contacts into the contact stream; must run inside the contacts frame. */
function ingestVccRigidContacts(physics: Physics): void {
    const rigid = physics.rigid;
    for (let i = 0; i < physics.vccRigidContactCount; i++) {
        const rec = physics.vccRigidContacts[i]!;
        const innerBody = rigidBody.get(rigid.world, rec.innerBodyId);
        const otherBody = rigidBody.get(rigid.world, rec.otherBodyId);
        if (!innerBody || !otherBody) continue;
        RigidPhysics.recordBodyContact(
            rigid,
            physics.contacts,
            physics.contactPairPool,
            innerBody,
            otherBody,
            rec.point,
            rec.normal,
            rec.penetrationDepth,
        );
    }
    physics.vccRigidContactCount = 0;
}

/** replay this tick's character-VCC voxel contacts into the contact stream. */
function ingestVccVoxelContacts(physics: Physics): void {
    const rigid = physics.rigid;
    for (let i = 0; i < physics.vccVoxelContactCount; i++) {
        const rec = physics.vccVoxelContacts[i]!;
        const innerBody = rigidBody.get(rigid.world, rec.innerBodyId);
        if (!innerBody) continue;
        RigidPhysics.recordBodyVoxelContact(
            rigid,
            physics.contacts,
            physics.contactPairPool,
            innerBody,
            rec.voxelX,
            rec.voxelY,
            rec.voxelZ,
            rec.stateId,
            rec.subAabbIndex,
            rec.point,
            rec.normal,
            rec.penetrationDepth,
            rec.solid,
        );
    }
    physics.vccVoxelContactCount = 0;
}

/** aggregate physics counts for the debug panel, summed across the rigid and AABB sub-worlds. */
export type PhysicsStats = {
    bodies: number;
    active: number;
    static: number;
    kinematic: number;
    dynamic: number;
    contacts: number;
    vccContacts: number;
};

export function stats(physics: Physics): PhysicsStats {
    const rigid = RigidPhysics.stats(physics.rigid);
    const aabb = AabbPhysics.stats(physics.aabb);
    return {
        bodies: rigid.total + aabb.total,
        active: rigid.active + aabb.active,
        static: rigid.static + aabb.static,
        kinematic: rigid.kinematic + aabb.kinematic,
        dynamic: rigid.dynamic + aabb.dynamic,
        contacts: physics.contacts.added.length + physics.contacts.persisted.length,
        vccContacts: physics.vccRigidContactCount + physics.vccVoxelContactCount,
    };
}

export function tick(physics: Physics, sceneTree: SceneTree, dt: number): void {
    runOnPrePhysicsStep(sceneTree, { delta: dt });

    beginPhysicsContactsFrame(physics.contacts, physics.contactPairPool);

    RigidPhysics.tick(physics.rigid, physics.contacts, physics.contactPairPool, dt);
    AabbPhysics.tick(physics.aabb, physics.rigid.world, dt, physics.aabbPairSink);

    // gathered before the solver runs, so a VCC-depenetrated fast body still gets a contact event.
    ingestVccRigidContacts(physics);
    ingestVccVoxelContacts(physics);

    endPhysicsContactsFrame(physics.contacts);

    fanOutContacts(physics, sceneTree);

    runOnPostPhysicsStep(sceneTree, { delta: dt });
}

export function dispose(physics: Physics): void {
    RigidPhysics.dispose(physics.rigid);
    AabbPhysics.dispose(physics.aabb, physics.rigid.world);
}

export function preStep(
    physics: Physics,
    sceneTree: SceneTree,
    resources: Resources.Resources,
    identity: PlayerId | null,
    simulate: boolean,
): void {
    RigidPhysics.preStep(physics.rigid, resources, identity, simulate);
    AabbPhysics.preStep(physics.aabb, physics.rigid.world, identity, simulate);
    syncCompanionTraits(physics, sceneTree);
}

export function postStep(physics: Physics, _sceneTree: SceneTree, identity: PlayerId | null): void {
    RigidPhysics.postStep(physics.rigid, identity);
    AabbPhysics.postStep(physics.aabb);
}

/** release per-frame physics scratch state; must run after all subShapeId consumers for the frame. */
export function flush(_physics: Physics): void {
    flushHitBuffer();
}

// enrolls/unenrolls nodes in interpolation based on whether either subsystem holds a body for them.

function syncCompanionTraits(physics: Physics, sceneTree: SceneTree): void {
    const want = new Set<number>();
    for (const nid of physics.rigid.nodeToBody.keys()) want.add(nid);
    for (const nid of physics.aabb.nodeToBody.keys()) want.add(nid);

    for (const nid of want) {
        if (physics._companionNodes.has(nid)) continue;
        const node = getNodeById(sceneTree, nid);
        if (!node) continue;
        setInterpolation(node, true);
    }
    for (const nid of physics._companionNodes) {
        if (want.has(nid)) continue;
        const node = getNodeById(sceneTree, nid);
        if (!node) continue;
        setInterpolation(node, false);
    }

    physics._companionNodes = want;
}

// drains AabbPhysics.PairInfo records into the global contacts stream.

function makeAabbPairSink(contacts: PhysicsContacts, pool: ContactPairPool): AabbPhysics.PairSink {
    return {
        record(info: AabbPhysics.PairInfo): void {
            const aSide = aabbBodySideKey(info.aBodyId);
            const bSide =
                info.bKind === 'aabbBody'
                    ? aabbBodySideKey(info.bBodyId)
                    : voxelSideKey(info.bVoxelX, info.bVoxelY, info.bVoxelZ, info.bSubAabbIndex);
            const key = pairKey(aSide, bSide);
            const pair = recordContactPair(contacts, pool, key);

            pair.aKind = 'aabbBody';
            pair.aAabbBodyId = info.aBodyId;
            pair.aAabbNodeId = info.aNodeId ?? -1;
            pair.aIsSensor = info.aIsSensor;

            if (info.bKind === 'aabbBody') {
                pair.bKind = 'aabbBody';
                pair.bAabbBodyId = info.bBodyId;
                pair.bAabbNodeId = info.bNodeId ?? -1;
                pair.bIsSensor = info.bIsSensor;
            } else {
                pair.bKind = 'voxel';
                pair.bVoxelSolid = true; // aabb-vs-voxel is always a solid collision
                pair.bVoxelX = info.bVoxelX;
                pair.bVoxelY = info.bVoxelY;
                pair.bVoxelZ = info.bVoxelZ;
                pair.bStateId = info.bStateId;
                pair.bSubAabbIndex = info.bSubAabbIndex;
            }

            pair.point[0] = info.pointX;
            pair.point[1] = info.pointY;
            pair.point[2] = info.pointZ;
            pair.normal[0] = info.normalX;
            pair.normal[1] = info.normalY;
            pair.normal[2] = info.normalZ;
            pair.penetrationDepth = info.penetrationDepth;
            pair.relativeVelocity[0] = info.relVelX;
            pair.relativeVelocity[1] = info.relVelY;
            pair.relativeVelocity[2] = info.relVelZ;
        },
    };
}

// pushes observer-normalized Contacts into the ContactsTrait of each node-side of a pair.

function fanOutContacts(physics: Physics, sceneTree: SceneTree): void {
    // release the previous step's per-trait Contacts back to pools, clear lists.
    for (const [ct] of physics.contactsQuery) {
        for (const c of ct.active)
            releaseContact(physics.rigidBodyContactPool, physics.aabbBodyContactPool, physics.voxelContactPool, c);
        for (const c of ct.removed)
            releaseContact(physics.rigidBodyContactPool, physics.aabbBodyContactPool, physics.voxelContactPool, c);
        ct.active.length = 0;
        ct.added.length = 0;
        ct.persisted.length = 0;
        ct.removed.length = 0;
    }

    fanOutBucket(physics, sceneTree, physics.contacts.added, 'added');
    fanOutBucket(physics, sceneTree, physics.contacts.persisted, 'persisted');
    fanOutBucket(physics, sceneTree, physics.contacts.removed, 'removed');
}

// a node earns its ContactsTrait on first contact; it's never removed, only cleared each step.
function ensureContactsTrait(node: Node): ContactsTrait {
    return getTrait(node, ContactsTrait) ?? addTrait(node, ContactsTrait);
}

function fanOutBucket(
    physics: Physics,
    sceneTree: SceneTree,
    bucket: ContactPair[],
    phase: 'added' | 'persisted' | 'removed',
): void {
    for (let i = 0; i < bucket.length; i++) {
        const pair = bucket[i]!;
        const aObserverNodeId = observerNodeIdForSide(pair, 'a');
        if (aObserverNodeId !== -1) {
            const node = getNodeById(sceneTree, aObserverNodeId);
            if (node) emitForObserver(physics, ensureContactsTrait(node), pair, 'a', phase);
        }
        const bObserverNodeId = observerNodeIdForSide(pair, 'b');
        if (bObserverNodeId !== -1) {
            const node = getNodeById(sceneTree, bObserverNodeId);
            if (node) emitForObserver(physics, ensureContactsTrait(node), pair, 'b', phase);
        }
    }
}

/** -1 if this side has no trait-bound observer; otherwise the owning node id. */
function observerNodeIdForSide(pair: ContactPair, side: 'a' | 'b'): number {
    const kind = side === 'a' ? pair.aKind : pair.bKind;
    if (kind === 'rigidBody') return side === 'a' ? pair.aNodeId : pair.bNodeId;
    if (kind === 'aabbBody') {
        const nid = side === 'a' ? pair.aAabbNodeId : pair.bAabbNodeId;
        return nid === -1 ? -1 : nid;
    }
    return -1;
}

function emitForObserver(
    physics: Physics,
    ct: ContactsTrait,
    pair: ContactPair,
    observer: 'a' | 'b',
    phase: 'added' | 'persisted' | 'removed',
): void {
    const otherKind = observer === 'a' ? pair.bKind : pair.aKind;
    const flip = observer === 'b';

    let contact: Contact;
    if (otherKind === 'rigidBody') {
        const c = acquireRigidBodyContact(physics.rigidBodyContactPool);
        c.point[0] = pair.point[0];
        c.point[1] = pair.point[1];
        c.point[2] = pair.point[2];
        c.normal[0] = flip ? -pair.normal[0] : pair.normal[0];
        c.normal[1] = flip ? -pair.normal[1] : pair.normal[1];
        c.normal[2] = flip ? -pair.normal[2] : pair.normal[2];
        c.penetrationDepth = pair.penetrationDepth;
        if (observer === 'a') {
            c.nodeId = pair.bNodeId;
            c.bodyId = pair.bBodyId;
            c.subShapeId = pair.bSubShapeId;
            c.isSensor = pair.bIsSensor;
        } else {
            c.nodeId = pair.aNodeId;
            c.bodyId = pair.aBodyId;
            c.subShapeId = pair.aSubShapeId;
            c.isSensor = pair.aIsSensor;
        }
        c.relativeVelocity[0] = flip ? -pair.relativeVelocity[0] : pair.relativeVelocity[0];
        c.relativeVelocity[1] = flip ? -pair.relativeVelocity[1] : pair.relativeVelocity[1];
        c.relativeVelocity[2] = flip ? -pair.relativeVelocity[2] : pair.relativeVelocity[2];
        contact = c;
    } else if (otherKind === 'aabbBody') {
        const c = acquireAabbBodyContact(physics.aabbBodyContactPool);
        c.point[0] = pair.point[0];
        c.point[1] = pair.point[1];
        c.point[2] = pair.point[2];
        c.normal[0] = flip ? -pair.normal[0] : pair.normal[0];
        c.normal[1] = flip ? -pair.normal[1] : pair.normal[1];
        c.normal[2] = flip ? -pair.normal[2] : pair.normal[2];
        c.penetrationDepth = pair.penetrationDepth;
        if (observer === 'a') {
            c.aabbBodyId = pair.bAabbBodyId;
            c.nodeId = pair.bAabbNodeId === -1 ? null : pair.bAabbNodeId;
            c.isSensor = pair.bIsSensor;
        } else {
            c.aabbBodyId = pair.aAabbBodyId;
            c.nodeId = pair.aAabbNodeId === -1 ? null : pair.aAabbNodeId;
            c.isSensor = pair.aIsSensor;
        }
        c.relativeVelocity[0] = flip ? -pair.relativeVelocity[0] : pair.relativeVelocity[0];
        c.relativeVelocity[1] = flip ? -pair.relativeVelocity[1] : pair.relativeVelocity[1];
        c.relativeVelocity[2] = flip ? -pair.relativeVelocity[2] : pair.relativeVelocity[2];
        contact = c;
    } else {
        const c = acquireVoxelContact(physics.voxelContactPool);
        c.point[0] = pair.point[0];
        c.point[1] = pair.point[1];
        c.point[2] = pair.point[2];
        c.normal[0] = flip ? -pair.normal[0] : pair.normal[0];
        c.normal[1] = flip ? -pair.normal[1] : pair.normal[1];
        c.normal[2] = flip ? -pair.normal[2] : pair.normal[2];
        c.penetrationDepth = pair.penetrationDepth;
        if (observer === 'a') {
            c.voxelX = pair.bVoxelX;
            c.voxelY = pair.bVoxelY;
            c.voxelZ = pair.bVoxelZ;
            c.stateId = pair.bStateId;
            c.subAabbIndex = pair.bSubAabbIndex;
            c.solid = pair.bVoxelSolid;
        } else {
            c.voxelX = pair.aVoxelX;
            c.voxelY = pair.aVoxelY;
            c.voxelZ = pair.aVoxelZ;
            c.stateId = pair.aStateId;
            c.subAabbIndex = pair.aSubAabbIndex;
            c.solid = pair.aVoxelSolid;
        }
        contact = c;
    }

    if (phase === 'added') {
        ct.added.push(contact);
        ct.active.push(contact);
    } else if (phase === 'persisted') {
        ct.persisted.push(contact);
        ct.active.push(contact);
    } else {
        ct.removed.push(contact);
    }
}
