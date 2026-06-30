import { AabbBodyTrait } from '../../builtins/aabb-body';
import { ContactsTrait } from '../../builtins/contacts';
import { setInterpolation } from '../../builtins/transform';
import type { PlayerId } from '../client';
import type * as Resources from '../resources';
import type { Nodes } from '../scene/nodes';
import {
    addTrait,
    getNodeById,
    getTrait,
    hasTrait,
    query,
    removeTrait,
    runOnPostPhysicsStep,
    runOnPrePhysicsStep,
} from '../scene/nodes';
import type { BlockRegistry } from '../voxels/block-registry';
import { flushHitBuffer } from '../voxels/voxel-physics-shape';
import type { Voxels } from '../voxels/voxels';
import * as AabbPhysics from './aabb-physics';
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
import * as RigidPhysics from './rigid-physics';

// shared world settings + layer constants live in ./crashcat. re-exported
// here so existing import sites (`from './physics'`) keep working.
export {
    BROADPHASE_LAYER_EDITOR_NODES,
    BROADPHASE_LAYER_MOVING,
    BROADPHASE_LAYER_NOT_MOVING,
    COLLISION_GROUP_NODES,
    COLLISION_GROUP_VOXELS,
    OBJECT_LAYER_AABB_IMPOSTOR,
    OBJECT_LAYER_EDITOR_NODES,
    OBJECT_LAYER_NODE_MOVING,
    OBJECT_LAYER_NODE_NOT_MOVING,
    OBJECT_LAYER_VOXELS,
    settings,
} from './crashcat';

// ── physics struct ───────────────────────────────────────────────────
//
// `Physics` is a thin coordinator over self-contained sub-worlds:
//   - `rigid` — crashcat-backed rigid bodies + voxel terrain body. trait
//     sync (RigidBodyTrait → World), listener, shape building, script hooks
//     all live in `rigid-physics.ts`.
//   - `aabb` — analytical aabb sweep + items / particles. trait sync
//     (AabbBodyTrait → World) lives in `aabb-physics.ts` behind
//     `bindNodeSync` (kept off the cycle path: trait passed in by the
//     coordinator rather than imported as a value by the subsystem).
//
// the coordinator owns: the shared contact stream both subsystems write
// into, the aabb→ContactPair translation sink, the fan-out from pairs into
// per-node `ContactsTrait` observers, and the companion-trait policy
// (Interpolate, Contacts) that unifies across subsystems.

export type Physics = {
    /** crashcat rigid body sub-world — full broadphase + manifolds + sleep. */
    rigid: RigidPhysics.World;
    /** AABB physics sub-world — items / particles / throwables. analytical sweep. */
    aabb: AabbPhysics.World;

    // ── contact output ───────────────────────────────────────────────

    /** global contact stream — pairs un-normalized (A→B), with added/persisted/removed lifecycle. */
    contacts: PhysicsContacts;
    /** pool of rigid-body-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    rigidBodyContactPool: RigidBodyContactPool;
    /** pool of aabb-body-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    aabbBodyContactPool: AabbBodyContactPool;
    /** pool of voxel-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    voxelContactPool: VoxelContactPool;
    /** pool of ContactPair instances backing `contacts.*` lists. */
    contactPairPool: ContactPairPool;
    /** cached query for fan-out — built once at init so we don't pay hash+lookup each tick. */
    contactsQuery: ReturnType<typeof query<[typeof ContactsTrait]>>;

    /** sink passed into `AabbPhysics.tick`. drains pairs into `contacts`. */
    aabbPairSink: AabbPhysics.PairSink;

    /** set of nodes that currently hold companion traits (Interpolate, Contacts)
     *  because at least one subsystem has a body for them. diffed each preStep
     *  against the union of `rigid.nodeToBody ∪ aabb.nodeToBody`. */
    _companionNodes: Set<number>;
};

export function init(nodes: Nodes, voxels: Voxels, registry: BlockRegistry): Physics {
    const rigid = RigidPhysics.create(nodes, voxels, registry);
    const aabb = AabbPhysics.create(voxels);
    AabbPhysics.bindNodeSync(aabb, nodes, AabbBodyTrait);

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
        contactsQuery: query(nodes, [ContactsTrait]),
        aabbPairSink,
        _companionNodes: new Set(),
    };
}

/** step the physics world. fires pre/post hooks and runs the world update. */
export function tick(physics: Physics, nodes: Nodes, dt: number): void {
    runOnPrePhysicsStep(nodes, { delta: dt });

    beginPhysicsContactsFrame(physics.contacts, physics.contactPairPool);

    // tick rigid body physics. rigid-physics owns its listener and writes
    // ContactPairs directly into the shared `contacts` stream via the pool.
    RigidPhysics.tick(physics.rigid, physics.contacts, physics.contactPairPool, dt);

    // tick aabb physics after crashcat. aabb contact pairs flow into the
    // same `contacts` stream via `aabbPairSink`, so fan-out treats them
    // uniformly.
    AabbPhysics.tick(physics.aabb, physics.rigid.world, dt, physics.aabbPairSink);

    // replay this tick's character-VCC body contacts (gathered in runOnTick,
    // before the solver) into the same stream. without this a VCC depenetrates
    // its character off a fast body and the solver never forms the manifold, so
    // the contact is silently lost (e.g. an arrow passing through a player).
    RigidPhysics.ingestVccContacts(physics.rigid, physics.contacts, physics.contactPairPool);

    endPhysicsContactsFrame(physics.contacts);

    // fan out pairs - writes to per-node ContactsTrait traits
    fanOutContacts(physics, nodes);

    runOnPostPhysicsStep(nodes, { delta: dt });
}

/** release all tracked bodies. call before discarding the physics world. */
export function dispose(physics: Physics): void {
    RigidPhysics.dispose(physics.rigid);
    AabbPhysics.dispose(physics.aabb, physics.rigid.world);
}

export function preStep(
    physics: Physics,
    nodes: Nodes,
    resources: Resources.Resources,
    identity: PlayerId | null,
    simulate: boolean,
): void {
    RigidPhysics.preStep(physics.rigid, resources, identity, simulate);
    AabbPhysics.preStep(physics.aabb, physics.rigid.world, identity, simulate);
    syncCompanionTraits(physics, nodes);
}

export function postStep(physics: Physics, _nodes: Nodes, identity: PlayerId | null): void {
    RigidPhysics.postStep(physics.rigid, identity);
    AabbPhysics.postStep(physics.aabb);
}

/**
 * Release per-frame physics scratch state — currently the voxel hit-info
 * pool. MUST be called after all subShapeId consumers for the frame have
 * run (contact listeners, getSurfaceNormal, getSupportingFace). Today
 * that means at the end of the engine tick on the server, and at the end
 * of the per-frame update on the client.
 */
export function flush(_physics: Physics): void {
    flushHitBuffer();
}

// ── companion traits (cross-subsystem) ────────────────────────────────
//
// any node that holds a body in *either* subsystem gets enrolled in
// interpolation (via setInterpolation, which lives on TransformTrait) and
// gets a ContactsTrait. unified here (not per-subsystem) so the policy and
// the diff live in one place — subsystems stay independent of these
// import paths.

function syncCompanionTraits(physics: Physics, nodes: Nodes): void {
    const want = new Set<number>();
    for (const nid of physics.rigid.nodeToBody.keys()) want.add(nid);
    for (const nid of physics.aabb.nodeToBody.keys()) want.add(nid);

    // add to new entries
    for (const nid of want) {
        if (physics._companionNodes.has(nid)) continue;
        const node = getNodeById(nodes, nid);
        if (!node) continue;
        setInterpolation(node, true);
        if (!hasTrait(node, ContactsTrait)) addTrait(node, ContactsTrait);
    }
    // remove from gone entries
    for (const nid of physics._companionNodes) {
        if (want.has(nid)) continue;
        const node = getNodeById(nodes, nid);
        if (!node) continue;
        setInterpolation(node, false);
        if (hasTrait(node, ContactsTrait)) removeTrait(node, ContactsTrait);
    }

    physics._companionNodes = want;
}

// ── aabb pair sink ───────────────────────────────────────────────────
//
// drains AabbPhysics.PairInfo records from `AabbPhysics.tick` into the
// global `physics.contacts` stream. lives here (not in aabb-physics.ts)
// so that module stays decoupled from the contact-pair pool and keying.

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

// ── fan-out ──────────────────────────────────────────────────────────
//
// for each ContactPair, push observer-normalized Contacts into the
// ContactsTrait of any side that is a node. one pair → up to 2 Contacts
// (one per node-side observer). normal pre-flipped so it always points
// away from `self`. per-trait Contact instances are throwaway each step:
// fan-out clears every list, releases instances back to per-type pools,
// then re-acquires fresh ones for active+removed.

function fanOutContacts(physics: Physics, nodes: Nodes): void {
    // 1. release the previous step's per-trait Contacts back to pools, clear lists.
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

    // 2. for each pair in this step's added/persisted/removed, project to up
    //    to two per-observer Contacts.
    fanOutBucket(physics, nodes, physics.contacts.added, 'added');
    fanOutBucket(physics, nodes, physics.contacts.persisted, 'persisted');
    fanOutBucket(physics, nodes, physics.contacts.removed, 'removed');
}

function fanOutBucket(physics: Physics, nodes: Nodes, bucket: ContactPair[], phase: 'added' | 'persisted' | 'removed'): void {
    for (let i = 0; i < bucket.length; i++) {
        const pair = bucket[i]!;
        const aObserverNodeId = observerNodeIdForSide(pair, 'a');
        if (aObserverNodeId !== -1) {
            const node = getNodeById(nodes, aObserverNodeId);
            const ct = node ? getTrait(node, ContactsTrait) : undefined;
            if (ct) emitForObserver(physics, ct, pair, 'a', phase);
        }
        const bObserverNodeId = observerNodeIdForSide(pair, 'b');
        if (bObserverNodeId !== -1) {
            const node = getNodeById(nodes, bObserverNodeId);
            const ct = node ? getTrait(node, ContactsTrait) : undefined;
            if (ct) emitForObserver(physics, ct, pair, 'b', phase);
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
        // otherKind === 'voxel'
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
        } else {
            c.voxelX = pair.aVoxelX;
            c.voxelY = pair.aVoxelY;
            c.voxelZ = pair.aVoxelZ;
            c.stateId = pair.aStateId;
            c.subAabbIndex = pair.aSubAabbIndex;
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
