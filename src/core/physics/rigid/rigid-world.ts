import {
    type BodyId,
    box,
    type ContactManifold,
    type ContactSettings,
    type World as CrashcatWorld,
    capsule,
    combineMaterial,
    compound,
    convexHull,
    createWorld,
    type Listener,
    type MassProperties,
    MotionType,
    massProperties,
    type RigidBody,
    rigidBody,
    type Shape,
    sphere,
    transformed,
    triangleMesh,
    updateWorld,
} from 'crashcat';
import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { MeshTrait } from '../../../builtins/mesh';
import { type RigidBodyDef, RigidBodyTrait, type ShapeDef } from '../../../builtins/rigid-body';
import {
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
    hasTransformedParent,
    markTransformDirty,
    TransformTrait,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../../../builtins/transform';
import type { PlayerId } from '../../client';
import type { MeshId } from '../../models/handle';
import * as Resources from '../../resources';
import type { Node, SceneTree } from '../../scene/scene-tree';
import { getTrait, query } from '../../scene/scene-tree';
import { logScriptError } from '../../scene/script-errors';
import type { PhysicsContactArgs } from '../../scene/scripts';
import { traverse } from '../../scene/traverse';
import { createVoxelPhysicsShape, unpackVoxelHitInfo, type VoxelPhysicsShape } from '../../voxels/voxel-physics-shape';
import type { Voxels } from '../../voxels/voxels';
import {
    type ContactPair,
    type ContactPairPool,
    type PhysicsContacts,
    pairKey,
    recordContactPair,
    rigidBodySideKey,
    voxelSideKey,
} from '../contacts';
import {
    COLLISION_GROUP_NODES,
    COLLISION_GROUP_VOXELS,
    OBJECT_LAYER_NODE_MOVING,
    OBJECT_LAYER_NODE_NOT_MOVING,
    OBJECT_LAYER_VOXELS,
    settings,
} from './rigid-world-settings';

// the voxel shape does per-chunk lookups, so an effectively infinite aabb keeps it always a broadphase candidate.
const INF = 1e8;
const INFINITE_AABB: [number, number, number, number, number, number] = [-INF, -INF, -INF, INF, INF, INF];

export type PropertySnapshot = {
    motionType: MotionType;
    /** snapshot of rb.prediction, changing this requires body recreation. */
    prediction: boolean;
    /** snapshot of node.owner; an ownership change must trigger a motion-type update. */
    owner: PlayerId | null;
    /** the `rb.def` reference at last install; a mismatch means the def was replaced and the body rebuilt. */
    lastDef: RigidBodyDef | null;
    /** the `rb.body` reference at last install; a mismatch means a script reassigned the body. */
    installedBody: RigidBody | null;
    /** true if the installer built the current body (and owns its teardown); false if script-adopted. */
    installerOwned: boolean;
};

export type TransformSnapshot = {
    position: Vec3;
    quaternion: Quat;
};

export type World = {
    /** scene tree back-ref. needed for trait sync, getNodeById, and script-hook fan-out. */
    sceneTree: SceneTree;

    /** underlying rigid-body world: full broadphase + manifold pipeline. */
    world: CrashcatWorld;
    /** static body holding the voxel terrain shape. */
    terrainBody: RigidBody;
    terrainShape: VoxelPhysicsShape;

    /** maps node id to body id. */
    nodeToBody: Map<number, BodyId>;
    /** maps body id to node id, for collision resolution. */
    bodyToNode: Map<BodyId, number>;
    /** property snapshot per node for change detection */
    propertySnapshots: Map<number, PropertySnapshot>;
    /** last physics-written transform per node for teleport detection */
    lastPhysicsTransform: Map<number, TransformSnapshot>;

    /** cached query for trait sync, built once at create. */
    _bodyQuery: ReturnType<typeof query<[typeof RigidBodyTrait, typeof TransformTrait]>>;
};

/** live body counts for the debug panel. */
export type WorldStats = {
    total: number;
    active: number;
    static: number;
    kinematic: number;
    dynamic: number;
};

/** tally bodies by motion type; `active` is the world's own awake count. */
export function stats(world: World): WorldStats {
    const bodies = world.world.bodies;
    let total = 0;
    let staticCount = 0;
    let kinematic = 0;
    let dynamic = 0;
    for (const body of bodies.pool) {
        if (body._pooled) continue;
        total++;
        if (body.motionType === MotionType.STATIC) staticCount++;
        else if (body.motionType === MotionType.KINEMATIC) kinematic++;
        else dynamic++;
    }
    return { total, active: bodies.activeBodyCount, static: staticCount, kinematic, dynamic };
}

export function create(sceneTree: SceneTree, voxels: Voxels): World {
    const world = createWorld(settings);
    const terrainShape = createVoxelPhysicsShape(voxels, INFINITE_AABB);
    const terrainBody = rigidBody.create(world, {
        shape: terrainShape,
        objectLayer: OBJECT_LAYER_VOXELS,
        motionType: MotionType.STATIC,
        collisionGroups: COLLISION_GROUP_VOXELS,
    });
    return {
        sceneTree,
        world,
        terrainBody,
        terrainShape,
        nodeToBody: new Map(),
        bodyToNode: new Map(),
        propertySnapshots: new Map(),
        lastPhysicsTransform: new Map(),
        _bodyQuery: query(sceneTree, [RigidBodyTrait, TransformTrait]),
    };
}

/** tear down all node-tracked bodies before discarding the world. */
export function dispose(world: World): void {
    for (const [nodeId, bodyId] of world.nodeToBody) {
        const body = rigidBody.get(world.world, bodyId);
        if (body) rigidBody.remove(world.world, body);
        world.propertySnapshots.delete(nodeId);
        world.lastPhysicsTransform.delete(nodeId);
    }
    world.nodeToBody.clear();
    world.bodyToNode.clear();
}

export function objectLayerForMotionType(mt: MotionType): number {
    return mt === MotionType.STATIC ? OBJECT_LAYER_NODE_NOT_MOVING : OBJECT_LAYER_NODE_MOVING;
}

export function takeTransformSnapshot(pos: Vec3, rot: Quat): TransformSnapshot {
    return {
        position: vec3.clone(pos),
        quaternion: quat.clone(rot),
    };
}

// simulate=false clamps everything to static; otherwise non-authorities demote dynamic+non-predicted bodies to kinematic to follow replication.

function effectiveMotionType(rb: RigidBodyTrait, identity: PlayerId | null, simulate: boolean): MotionType {
    if (!simulate) return MotionType.STATIC;
    const owner = rb._node.owner;
    const isAuthority = identity === null ? owner === null : owner === identity;
    if (isAuthority) return rb.motionType;
    if (rb.motionType === MotionType.DYNAMIC && !rb.prediction) return MotionType.KINEMATIC;
    return rb.motionType;
}

// driven by `rb.def.shape`; if it can't be built yet, the next preStep tries again.

function resolveLiteralShape(shapeDef: ShapeDef): Shape | null {
    switch (shapeDef.type) {
        case 'box':
            return box.create({ halfExtents: shapeDef.halfExtents });
        case 'sphere':
            return sphere.create({ radius: shapeDef.radius });
        case 'transformed': {
            const inner = resolveLiteralShape(shapeDef.shape);
            return inner
                ? transformed.create({ shape: inner, position: shapeDef.position, quaternion: shapeDef.quaternion })
                : null;
        }
        case 'compound': {
            const children: { shape: Shape; position: Vec3; quaternion: Quat }[] = [];
            for (const part of shapeDef.shapes) {
                const s = resolveLiteralShape(part.shape);
                if (s) children.push({ shape: s, position: part.position, quaternion: part.quaternion });
            }
            return children.length > 0 ? compound.create({ children }) : null;
        }
        case 'auto':
            // dispatched in buildShape, never reached here
            return null;
        default:
            console.warn('[physics] unknown shape type');
            return null;
    }
}

type MeshContribution = {
    meshId: MeshId;
    /** transform from mesh-node-local space to body-local space */
    localMat: Mat4;
};

const _bodyWorldInv = mat4.create();

function collectMeshContributions(rbNode: Node, rbTransform: TransformTrait): MeshContribution[] {
    const bodyWorld = getWorldMatrix(rbTransform);
    mat4.invert(_bodyWorldInv, bodyWorld);

    const out: MeshContribution[] = [];
    traverse(rbNode, (descendant) => {
        const mt = getTrait(descendant, MeshTrait);
        if (!mt?.meshId) return;
        const tt = getTrait(descendant, TransformTrait);
        if (!tt) return;
        const localMat = mat4.create();
        mat4.multiply(localMat, _bodyWorldInv, getWorldMatrix(tt));
        out.push({ meshId: mt.meshId, localMat });
    });
    return out;
}

const _autoAabb = box3.create();
const _tmpAabb = box3.create();

function computeAutoBoundsAabb(out: Box3, contribs: MeshContribution[], resources: Resources.Resources): boolean {
    box3.empty(out);
    let any = false;
    for (const c of contribs) {
        const def = Resources.modelDef(resources, c.meshId.modelId);
        if (!def) continue;
        const meshEntry = def.meshes[c.meshId.meshName];
        if (!meshEntry) continue;
        box3.transformMat4(_tmpAabb, meshEntry.aabb, c.localMat);
        box3.union(out, out, _tmpAabb);
        any = true;
    }
    return any;
}

function buildAutoBoundsShape(
    mode: 'box' | 'sphere' | 'capsule',
    contribs: MeshContribution[],
    resources: Resources.Resources,
): Shape | null {
    if (!computeAutoBoundsAabb(_autoAabb, contribs, resources)) return null;

    const cx = 0.5 * (_autoAabb[0] + _autoAabb[3]);
    const cy = 0.5 * (_autoAabb[1] + _autoAabb[4]);
    const cz = 0.5 * (_autoAabb[2] + _autoAabb[5]);
    const hx = 0.5 * (_autoAabb[3] - _autoAabb[0]);
    const hy = 0.5 * (_autoAabb[4] - _autoAabb[1]);
    const hz = 0.5 * (_autoAabb[5] - _autoAabb[2]);

    let core: Shape;
    switch (mode) {
        case 'box':
            core = box.create({ halfExtents: [hx, hy, hz] });
            break;
        case 'sphere':
            core = sphere.create({ radius: Math.max(hx, hy, hz) });
            break;
        case 'capsule': {
            // +Y axis, for characters/mobs
            const radius = Math.max(hx, hz, 1e-3);
            const halfHeight = Math.max(hy - radius, 1e-3);
            core = capsule.create({ radius, halfHeightOfCylinder: halfHeight });
            break;
        }
    }

    // wrap in transformed if the bounds aren't centered on the body origin
    const TOL = 1e-6;
    if (Math.abs(cx) > TOL || Math.abs(cy) > TOL || Math.abs(cz) > TOL) {
        return transformed.create({ shape: core, position: [cx, cy, cz], quaternion: [0, 0, 0, 1] });
    }
    return core;
}

// hull/mesh building is expensive; cache by contribution key, no eviction (unload/reload is rare).

const autoGeometryCache = new Map<string, Shape>();

function autoGeometryCacheKey(mode: 'hull' | 'mesh', contribs: MeshContribution[]): string {
    let key = mode;
    for (const c of contribs) {
        key += `|${c.meshId.modelId}/${c.meshId.meshName}/`;
        for (let i = 0; i < 16; i++) key += `${c.localMat[i].toFixed(6)},`;
    }
    return key;
}

const _tmpPoint = vec3.create();

function buildAutoGeometryShape(
    mode: 'hull' | 'mesh',
    contribs: MeshContribution[],
    resources: Resources.Resources,
): Shape | null {
    for (const c of contribs) {
        if (!Resources.modelGeometry(resources, c.meshId)) {
            Resources.ensureModel(resources, c.meshId.modelId);
            return null;
        }
    }

    const cacheKey = autoGeometryCacheKey(mode, contribs);
    const cached = autoGeometryCache.get(cacheKey);
    if (cached) return cached;

    const positions: number[] = [];
    const indices: number[] = [];

    for (const c of contribs) {
        const geom = Resources.modelGeometry(resources, c.meshId);
        if (!geom) return null;
        const baseVertex = positions.length / 3;
        for (let i = 0; i < geom.positions.length; i += 3) {
            _tmpPoint[0] = geom.positions[i];
            _tmpPoint[1] = geom.positions[i + 1];
            _tmpPoint[2] = geom.positions[i + 2];
            vec3.transformMat4(_tmpPoint, _tmpPoint, c.localMat);
            positions.push(_tmpPoint[0], _tmpPoint[1], _tmpPoint[2]);
        }
        if (mode === 'mesh') {
            for (let i = 0; i < geom.indices.length; i++) indices.push(geom.indices[i] + baseVertex);
        }
    }

    if (positions.length === 0) return null;

    const shape = mode === 'hull' ? convexHull.create({ positions }) : triangleMesh.create({ positions, indices });
    autoGeometryCache.set(cacheKey, shape);
    return shape;
}

/** builds a Shape for the given `ShapeDef`; returns null when it can't be built yet (caller retries next preStep). */
function buildShape(shapeDef: ShapeDef, rbNode: Node, transform: TransformTrait, resources: Resources.Resources): Shape | null {
    if (shapeDef.type !== 'auto') {
        return resolveLiteralShape(shapeDef);
    }

    const contribs = collectMeshContributions(rbNode, transform);
    if (contribs.length === 0) return null;

    switch (shapeDef.shape) {
        case 'box':
        case 'sphere':
        case 'capsule':
            return buildAutoBoundsShape(shapeDef.shape, contribs, resources);
        case 'hull':
        case 'mesh':
            return buildAutoGeometryShape(shapeDef.shape, contribs, resources);
        default:
            return null;
    }
}

/** synthesizes box-equivalent mass properties from a shape's AABB; triangle-mesh shapes have no natural mass and need this or fall through the world. */
function synthesizeBoxMassProps(shape: Shape, density = 1000): MassProperties {
    const aabb = (shape as { aabb?: Box3 }).aabb;
    const mp = massProperties.create();
    if (!aabb) return mp;
    const sx = Math.max(aabb[3] - aabb[0], 1e-3);
    const sy = Math.max(aabb[4] - aabb[1], 1e-3);
    const sz = Math.max(aabb[5] - aabb[2], 1e-3);
    massProperties.setMassAndInertiaOfSolidBox(mp, [sx, sy, sz], density);
    return mp;
}

// builds a fresh body from rb.def and assigns rb.body, seeding motionType/prediction on the trait.

function buildBodyFromDef(
    world: World,
    node: Node,
    rb: RigidBodyTrait,
    transform: TransformTrait,
    def: RigidBodyDef,
    resources: Resources.Resources,
    identity: PlayerId | null,
    simulate: boolean,
): RigidBody | null {
    const shape = buildShape(def.shape, node, transform, resources);
    if (!shape) return null;

    // seeded once from the def; after install the trait fields are the source of truth.
    if (def.motionType !== undefined) rb.motionType = def.motionType;

    const mt = effectiveMotionType(rb, identity, simulate);
    const needsMassOverride = def.shape.type === 'auto' && def.shape.shape === 'mesh' && mt === MotionType.DYNAMIC;

    try {
        return rigidBody.create(world.world, {
            shape,
            objectLayer: objectLayerForMotionType(mt),
            motionType: mt,
            position: getWorldPosition(transform),
            quaternion: getWorldQuaternion(transform),
            userData: node.id,
            friction: def.friction,
            restitution: def.restitution,
            sensor: def.sensor,
            allowedDegreesOfFreedom: def.allowedDegreesOfFreedom,
            gravityFactor: def.gravityFactor,
            // node rigid bodies are always in the NODES group; a game's own groups stack on top.
            collisionGroups: (def.collisionGroups ?? 0) | COLLISION_GROUP_NODES,
            collisionMask: def.collisionMask,
            linearDamping: def.linearDamping,
            angularDamping: def.angularDamping,
            maxLinearVelocity: def.maxLinearVelocity,
            maxAngularVelocity: def.maxAngularVelocity,
            mass: def.mass,
            motionQuality: def.motionQuality,
            allowSleeping: def.allowSleeping,
            enhancedInternalEdgeRemoval: def.enhancedInternalEdgeRemoval,
            frictionCombineMode: def.frictionCombineMode,
            restitutionCombineMode: def.restitutionCombineMode,
            collideKinematicVsNonDynamic: def.collideKinematicVsNonDynamic,
            massPropertiesOverride: needsMassOverride ? synthesizeBoxMassProps(shape) : undefined,
        });
    } catch (e) {
        console.error(`[physics] failed to create body for node ${node.id}:`, e);
        return null;
    }
}

// removes whichever body is mapped for a node that lost its RigidBodyTrait, installer-built or adopted.

function destroyBody(world: World, nodeId: number, rb: RigidBodyTrait | null): void {
    const bodyId = world.nodeToBody.get(nodeId);
    if (bodyId !== undefined) {
        const body = rigidBody.get(world.world, bodyId);
        if (body) rigidBody.remove(world.world, body);
        world.nodeToBody.delete(nodeId);
        world.bodyToNode.delete(bodyId);
    }

    if (rb) rb.body = null;

    world.propertySnapshots.delete(nodeId);
    world.lastPhysicsTransform.delete(nodeId);
}

// runs once per tick per (rb, transform) pair: install-or-adopt, then motion-type/owner/teleport sync.

function syncRigidBodyToWorld(
    world: World,
    node: Node,
    rb: RigidBodyTrait,
    transform: TransformTrait,
    resources: Resources.Resources,
    identity: PlayerId | null,
    simulate: boolean,
): void {
    let snap = world.propertySnapshots.get(node.id);

    // def ref-change: tear down our installer-built body so the new def can produce a fresh one.
    if (snap && rb.def !== snap.lastDef && snap.installerOwned && rb.body !== null) {
        rigidBody.remove(world.world, rb.body);
        world.nodeToBody.delete(node.id);
        world.bodyToNode.delete(rb.body.id);
        rb.body = null;
        snap.installedBody = null;
        snap.installerOwned = false;
    }

    // installer path: def set, no body, build. `justBuilt` flags installerOwned below.
    let justBuilt = false;
    if (rb.def && !rb.body) {
        const built = buildBodyFromDef(world, node, rb, transform, rb.def, resources, identity, simulate);
        if (built) {
            rb.body = built;
            justBuilt = true;
        }
    }

    // body changed: we just built it, or a script reassigned `rb.body`.
    const prevBody = snap?.installedBody ?? null;
    if (rb.body !== prevBody) {
        const prevInstallerOwned = snap?.installerOwned ?? false;
        if (prevBody && prevInstallerOwned) {
            rigidBody.remove(world.world, prevBody);
            world.bodyToNode.delete(prevBody.id);
        }

        if (rb.body) {
            world.nodeToBody.set(node.id, rb.body.id);
            world.bodyToNode.set(rb.body.id, node.id);

            // flush buffered velocity from trait to body (covers a network unpack before the body was online).
            vec3.copy(rb.body.motionProperties.linearVelocity, rb.linearVelocity);
            vec3.copy(rb.body.motionProperties.angularVelocity, rb.angularVelocity);

            world.lastPhysicsTransform.set(node.id, takeTransformSnapshot(rb.body.position, rb.body.quaternion));

            snap = {
                motionType: rb.motionType,
                prediction: rb.prediction,
                owner: node.owner,
                lastDef: rb.def,
                installedBody: rb.body,
                installerOwned: justBuilt,
            };
            world.propertySnapshots.set(node.id, snap);
        } else {
            // body went null (escape hatch); installer-built prev already destroyed above, adopted prev left alone.
            if (prevBody && !prevInstallerOwned) {
                world.bodyToNode.delete(prevBody.id);
            }
            world.nodeToBody.delete(node.id);
            world.propertySnapshots.delete(node.id);
            world.lastPhysicsTransform.delete(node.id);
            return;
        }
    } else if (snap && rb.def !== snap.lastDef) {
        // def ref-change in adopt mode: sync lastDef so we don't keep retrying.
        snap.lastDef = rb.def;
    }

    const body = rb.body;
    if (!body || !snap) return;

    const mt = effectiveMotionType(rb, identity, simulate);
    if (rb.motionType !== snap.motionType || rb.prediction !== snap.prediction || node.owner !== snap.owner) {
        rigidBody.setMotionType(world.world, body, mt, true);
        rigidBody.setObjectLayer(world.world, body, objectLayerForMotionType(mt));
        snap.motionType = rb.motionType;
        snap.prediction = rb.prediction;
        snap.owner = node.owner;
    }

    // snap the body if the world transform was moved externally (teleport).
    const lastSnap = world.lastPhysicsTransform.get(node.id);
    if (lastSnap) {
        const wp = getWorldPosition(transform);
        const wq = getWorldQuaternion(transform);
        if (!vec3.equals(wp, lastSnap.position) || !quat.equals(wq, lastSnap.quaternion)) {
            rigidBody.setTransform(world.world, body, wp, wq, true);
            if (body.motionType !== MotionType.STATIC) {
                vec3.zero(body.motionProperties.linearVelocity);
                vec3.zero(body.motionProperties.angularVelocity);
            }
        }
    }

    // client-side replication smoothing: push synced velocity into a non-owned kinematic body between sparse teleports.
    if (identity !== null && node.owner !== identity && body.motionType === MotionType.KINEMATIC) {
        vec3.copy(body.motionProperties.linearVelocity, rb.linearVelocity);
        vec3.copy(body.motionProperties.angularVelocity, rb.angularVelocity);
    }
}

// the listener translates each manifold into one canonical ContactPair; the coordinator fans it out into per-observer Contacts.

/** swaps in the per-block friction/restitution from the registry when one side of a contact is the terrain; restitution=1 always bounces regardless of the other body. */
function applyVoxelMaterialOverride(
    world: World,
    bodyA: RigidBody,
    bodyB: RigidBody,
    manifold: ContactManifold,
    contactSettings: ContactSettings,
): void {
    const terrainId = world.terrainBody.id;
    const aIsTerrain = bodyA.id === terrainId;
    const bIsTerrain = bodyB.id === terrainId;
    if (!aIsTerrain && !bIsTerrain) return;
    if (aIsTerrain && bIsTerrain) return;

    const otherBody = aIsTerrain ? bodyB : bodyA;
    const terrainSubShapeId = aIsTerrain
        ? ((manifold as { subShapeIdA?: number }).subShapeIdA ?? 0)
        : ((manifold as { subShapeIdB?: number }).subShapeIdB ?? 0);

    const info = unpackVoxelHitInfo(terrainSubShapeId);
    const registry = world.terrainShape.voxels.registry;
    const blockFriction = registry.friction[info.stateId] ?? 1;
    const blockRestitution = registry.restitution[info.stateId] ?? 0;

    const terrain = world.terrainBody;
    contactSettings.combinedFriction = combineMaterial(
        otherBody.friction,
        blockFriction,
        otherBody.frictionCombineMode,
        terrain.frictionCombineMode,
    );
    contactSettings.combinedRestitution = combineMaterial(
        otherBody.restitution,
        blockRestitution,
        otherBody.restitutionCombineMode,
        terrain.restitutionCombineMode,
    );
}

type SideKind = 'rigidBody' | 'voxel' | 'unresolved';
type SideInfo =
    | { kind: 'rigidBody'; nodeId: number; bodyId: BodyId; subShapeId: number; isSensor: boolean }
    | {
          kind: 'voxel';
          // min cell corner of the hit; overwritten per covered cell while enumerating a merged run's footprint.
          voxelX: number;
          voxelY: number;
          voxelZ: number;
          // max cell corner (exclusive) of the hit's box run; used only to bound enumeration.
          maxX: number;
          maxY: number;
          maxZ: number;
          stateId: number;
          subAabbIndex: number;
      }
    | { kind: 'unresolved' };

const _sideA: SideInfo = { kind: 'unresolved' };
const _sideB: SideInfo = { kind: 'unresolved' };

function resolveSide(out: SideInfo, world: World, body: RigidBody, subShapeId: number): SideKind {
    if (body.id === world.terrainBody.id) {
        (out as { kind: SideKind }).kind = 'voxel';
        const v = out as {
            kind: 'voxel';
            voxelX: number;
            voxelY: number;
            voxelZ: number;
            maxX: number;
            maxY: number;
            maxZ: number;
            stateId: number;
            subAabbIndex: number;
        };
        const info = unpackVoxelHitInfo(subShapeId);
        v.voxelX = info.minX;
        v.voxelY = info.minY;
        v.voxelZ = info.minZ;
        v.maxX = info.maxX;
        v.maxY = info.maxY;
        v.maxZ = info.maxZ;
        v.stateId = info.stateId;
        v.subAabbIndex = info.subAabbIndex;
        return 'voxel';
    }
    const nodeId = world.bodyToNode.get(body.id);
    if (nodeId !== undefined) {
        (out as { kind: SideKind }).kind = 'rigidBody';
        const n = out as { kind: 'rigidBody'; nodeId: number; bodyId: BodyId; subShapeId: number; isSensor: boolean };
        n.nodeId = nodeId;
        n.bodyId = body.id;
        n.subShapeId = subShapeId;
        n.isSensor = body.sensor;
        return 'rigidBody';
    }
    (out as { kind: SideKind }).kind = 'unresolved';
    return 'unresolved';
}

function sideKey(s: SideInfo): string {
    if (s.kind === 'rigidBody') return rigidBodySideKey(s.nodeId, s.subShapeId);
    if (s.kind === 'voxel') return voxelSideKey(s.voxelX, s.voxelY, s.voxelZ, s.subAabbIndex);
    return '';
}

function writePairSide(p: ContactPair, side: 'a' | 'b', s: SideInfo): void {
    if (s.kind === 'rigidBody') {
        if (side === 'a') {
            p.aKind = 'rigidBody';
            p.aNodeId = s.nodeId;
            p.aBodyId = s.bodyId;
            p.aSubShapeId = s.subShapeId;
            p.aIsSensor = s.isSensor;
        } else {
            p.bKind = 'rigidBody';
            p.bNodeId = s.nodeId;
            p.bBodyId = s.bodyId;
            p.bSubShapeId = s.subShapeId;
            p.bIsSensor = s.isSensor;
        }
    } else if (s.kind === 'voxel') {
        if (side === 'a') {
            p.aKind = 'voxel';
            p.aVoxelX = s.voxelX;
            p.aVoxelY = s.voxelY;
            p.aVoxelZ = s.voxelZ;
            p.aStateId = s.stateId;
            p.aSubAabbIndex = s.subAabbIndex;
            p.aVoxelSolid = true; // solver contacts are always solid blocks
        } else {
            p.bKind = 'voxel';
            p.bVoxelX = s.voxelX;
            p.bVoxelY = s.voxelY;
            p.bVoxelZ = s.voxelZ;
            p.bStateId = s.stateId;
            p.bSubAabbIndex = s.subAabbIndex;
            p.bVoxelSolid = true; // solver contacts are always solid blocks
        }
    }
}

// emit one ContactPair for the resolved sides + shared manifold fields.
function emitContactPair(
    contacts: PhysicsContacts,
    pool: ContactPairPool,
    sideA: SideInfo,
    sideB: SideInfo,
    manifold: ContactManifold,
    bodyA: RigidBody,
    bodyB: RigidBody,
): void {
    const key = pairKey(sideKey(sideA), sideKey(sideB));
    const pair = recordContactPair(contacts, pool, key);

    writePairSide(pair, 'a', sideA);
    writePairSide(pair, 'b', sideB);

    // point is the first A-side contact point; normal is world-space A to B.
    pair.point[0] = manifold.baseOffset[0] + manifold.relativeContactPointsOnA[0];
    pair.point[1] = manifold.baseOffset[1] + manifold.relativeContactPointsOnA[1];
    pair.point[2] = manifold.baseOffset[2] + manifold.relativeContactPointsOnA[2];
    pair.normal[0] = manifold.worldSpaceNormal[0];
    pair.normal[1] = manifold.worldSpaceNormal[1];
    pair.normal[2] = manifold.worldSpaceNormal[2];
    pair.penetrationDepth = manifold.penetrationDepth;

    const aLin = bodyA.motionProperties?.linearVelocity;
    const bLin = bodyB.motionProperties?.linearVelocity;
    pair.relativeVelocity[0] = (bLin?.[0] ?? 0) - (aLin?.[0] ?? 0);
    pair.relativeVelocity[1] = (bLin?.[1] ?? 0) - (aLin?.[1] ?? 0);
    pair.relativeVelocity[2] = (bLin?.[2] ?? 0) - (aLin?.[2] ?? 0);
}

const clampCell = (v: number, lo: number, hiExclusive: number): number => (v < lo ? lo : v >= hiExclusive ? hiExclusive - 1 : v);

function recordContactFromManifold(
    world: World,
    contacts: PhysicsContacts,
    pool: ContactPairPool,
    bodyA: RigidBody,
    bodyB: RigidBody,
    manifold: ContactManifold,
): void {
    const subA = (manifold as { subShapeIdA?: number }).subShapeIdA ?? 0;
    const subB = (manifold as { subShapeIdB?: number }).subShapeIdB ?? 0;

    const kindA = resolveSide(_sideA, world, bodyA, subA);
    const kindB = resolveSide(_sideB, world, bodyB, subB);
    if (kindA === 'unresolved' || kindB === 'unresolved') return;

    // a merged run of voxel cells emits one ContactPair per cell under the contact footprint, not the whole run.
    const voxelSide = kindA === 'voxel' ? _sideA : kindB === 'voxel' ? _sideB : null;
    const numPoints = manifold.numContactPoints;
    if (voxelSide === null || voxelSide.kind !== 'voxel' || numPoints === 0) {
        emitContactPair(contacts, pool, _sideA, _sideB, manifold, bodyA, bodyB);
        return;
    }

    // run bounds: min corner is in voxelX/Y/Z, max is exclusive.
    const minX = voxelSide.voxelX;
    const minY = voxelSide.voxelY;
    const minZ = voxelSide.voxelZ;
    const { maxX, maxY, maxZ } = voxelSide;

    // single-cell hit (cube or custom collider): nothing to enumerate.
    if (maxX - minX <= 1 && maxY - minY <= 1 && maxZ - minZ <= 1) {
        emitContactPair(contacts, pool, _sideA, _sideB, manifold, bodyA, bodyB);
        return;
    }

    // footprint = bbox of the manifold contact points on the voxel side, intersected with the run box.
    const rel = kindA === 'voxel' ? manifold.relativeContactPointsOnA : manifold.relativeContactPointsOnB;
    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMinZ = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;
    let pMaxZ = -Infinity;
    for (let i = 0; i < numPoints; i++) {
        const x = manifold.baseOffset[0] + rel[i * 3]!;
        const y = manifold.baseOffset[1] + rel[i * 3 + 1]!;
        const z = manifold.baseOffset[2] + rel[i * 3 + 2]!;
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y;
        if (y > pMaxY) pMaxY = y;
        if (z < pMinZ) pMinZ = z;
        if (z > pMaxZ) pMaxZ = z;
    }

    const cx0 = clampCell(Math.floor(pMinX), minX, maxX);
    const cx1 = clampCell(Math.floor(pMaxX), minX, maxX);
    const cy0 = clampCell(Math.floor(pMinY), minY, maxY);
    const cy1 = clampCell(Math.floor(pMaxY), minY, maxY);
    const cz0 = clampCell(Math.floor(pMinZ), minZ, maxZ);
    const cz1 = clampCell(Math.floor(pMaxZ), minZ, maxZ);

    for (let cz = cz0; cz <= cz1; cz++) {
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                voxelSide.voxelX = cx;
                voxelSide.voxelY = cy;
                voxelSide.voxelZ = cz;
                emitContactPair(contacts, pool, _sideA, _sideB, manifold, bodyA, bodyB);
            }
        }
    }
}

/** record a body-to-body contact from an explicit point/normal (no manifold); replays VCC contacts. */
export function recordBodyContact(
    world: World,
    contacts: PhysicsContacts,
    pool: ContactPairPool,
    bodyA: RigidBody,
    bodyB: RigidBody,
    point: Vec3,
    normal: Vec3,
    penetrationDepth: number,
): void {
    const kindA = resolveSide(_sideA, world, bodyA, 0);
    const kindB = resolveSide(_sideB, world, bodyB, 0);
    if (kindA === 'unresolved' || kindB === 'unresolved') return;

    const key = pairKey(sideKey(_sideA), sideKey(_sideB));
    const pair = recordContactPair(contacts, pool, key);

    writePairSide(pair, 'a', _sideA);
    writePairSide(pair, 'b', _sideB);

    pair.point[0] = point[0];
    pair.point[1] = point[1];
    pair.point[2] = point[2];
    // VCC normal is surface-to-character; pair convention is A-to-B, the opposite direction.
    pair.normal[0] = -normal[0];
    pair.normal[1] = -normal[1];
    pair.normal[2] = -normal[2];
    pair.penetrationDepth = penetrationDepth;

    const aLin = bodyA.motionProperties?.linearVelocity;
    const bLin = bodyB.motionProperties?.linearVelocity;
    pair.relativeVelocity[0] = (bLin?.[0] ?? 0) - (aLin?.[0] ?? 0);
    pair.relativeVelocity[1] = (bLin?.[1] ?? 0) - (aLin?.[1] ?? 0);
    pair.relativeVelocity[2] = (bLin?.[2] ?? 0) - (aLin?.[2] ?? 0);
}

/** record a body-vs-voxel contact into the shared stream, so a character VCC's terrain contacts reach the fan-out. */
export function recordBodyVoxelContact(
    world: World,
    contacts: PhysicsContacts,
    pool: ContactPairPool,
    body: RigidBody,
    voxelX: number,
    voxelY: number,
    voxelZ: number,
    stateId: number,
    subAabbIndex: number,
    point: Vec3,
    normal: Vec3,
    penetrationDepth: number,
    solid: boolean,
): void {
    const kindA = resolveSide(_sideA, world, body, 0);
    if (kindA !== 'rigidBody') return;

    const key = pairKey(sideKey(_sideA), voxelSideKey(voxelX, voxelY, voxelZ, subAabbIndex));
    const pair = recordContactPair(contacts, pool, key);

    writePairSide(pair, 'a', _sideA);
    pair.bKind = 'voxel';
    pair.bVoxelSolid = solid;
    pair.bVoxelX = voxelX;
    pair.bVoxelY = voxelY;
    pair.bVoxelZ = voxelZ;
    pair.bStateId = stateId;
    pair.bSubAabbIndex = subAabbIndex;

    pair.point[0] = point[0];
    pair.point[1] = point[1];
    pair.point[2] = point[2];
    // A is the body; pair convention normal is A->B, opposite the VCC's surface->body.
    pair.normal[0] = -normal[0];
    pair.normal[1] = -normal[1];
    pair.normal[2] = -normal[2];
    pair.penetrationDepth = penetrationDepth;

    // voxel terrain is static, so relative velocity is just -body velocity.
    const aLin = body.motionProperties?.linearVelocity;
    pair.relativeVelocity[0] = -(aLin?.[0] ?? 0);
    pair.relativeVelocity[1] = -(aLin?.[1] ?? 0);
    pair.relativeVelocity[2] = -(aLin?.[2] ?? 0);
}

function fireContactHooks(
    sceneTree: SceneTree,
    event: 'added' | 'persisted',
    bodyA: RigidBody,
    bodyB: RigidBody,
    manifold: ContactManifold,
    contactSettings: ContactSettings,
): void {
    const args: PhysicsContactArgs = { bodyA, bodyB, manifold, settings: contactSettings };
    if (!sceneTree.context) return;
    for (const nodeInstances of sceneTree.context.instances.values()) {
        for (const instance of nodeInstances.values()) {
            const set = event === 'added' ? instance.onPhysicsContactAdded : instance.onPhysicsContactPersisted;
            const hookName = event === 'added' ? 'onPhysicsContactAdded' : 'onPhysicsContactPersisted';
            for (const fn of set) {
                try {
                    fn(args);
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.${hookName} @${instance.node.id}`, err);
                }
            }
        }
    }
}

function fireValidateHooks(sceneTree: SceneTree, bodyA: RigidBody, bodyB: RigidBody): boolean {
    if (!sceneTree.context) return true;
    for (const nodeInstances of sceneTree.context.instances.values()) {
        for (const instance of nodeInstances.values()) {
            for (const fn of instance.onPhysicsBodyPairValidate) {
                try {
                    if (!fn(bodyA, bodyB)) return false;
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.onPhysicsBodyPairValidate @${instance.node.id}`, err);
                    return false;
                }
            }
        }
    }
    return true;
}

function buildListener(world: World, contacts: PhysicsContacts, pool: ContactPairPool): Listener {
    const sceneTree = world.sceneTree;
    return {
        onBodyPairValidate(bodyA: RigidBody, bodyB: RigidBody): boolean {
            return fireValidateHooks(sceneTree, bodyA, bodyB);
        },
        onContactAdded(bodyA: RigidBody, bodyB: RigidBody, manifold: ContactManifold, contactSettings: ContactSettings): void {
            applyVoxelMaterialOverride(world, bodyA, bodyB, manifold, contactSettings);
            recordContactFromManifold(world, contacts, pool, bodyA, bodyB, manifold);
            fireContactHooks(sceneTree, 'added', bodyA, bodyB, manifold, contactSettings);
        },
        onContactPersisted(
            bodyA: RigidBody,
            bodyB: RigidBody,
            manifold: ContactManifold,
            contactSettings: ContactSettings,
        ): void {
            applyVoxelMaterialOverride(world, bodyA, bodyB, manifold, contactSettings);
            recordContactFromManifold(world, contacts, pool, bodyA, bodyB, manifold);
            fireContactHooks(sceneTree, 'persisted', bodyA, bodyB, manifold, contactSettings);
        },
    };
}

/** step the physics world; contact events drain into `contacts` via the listener. */
export function tick(world: World, contacts: PhysicsContacts, pool: ContactPairPool, dt: number): void {
    const listener = buildListener(world, contacts, pool);
    updateWorld(world.world, listener, dt);
}

/** trait-to-world sync: install/update bodies for nodes with RigidBodyTrait, destroy bodies for nodes that lost it. */
export function preStep(world: World, resources: Resources.Resources, identity: PlayerId | null, simulate: boolean): void {
    const active = new Set<number>();
    for (const [rb, transform] of world._bodyQuery) {
        const node = rb._node;
        active.add(node.id);
        syncRigidBodyToWorld(world, node, rb, transform, resources, identity, simulate);
    }

    for (const nodeId of [...world.nodeToBody.keys()]) {
        if (active.has(nodeId)) continue;
        destroyBody(world, nodeId, null);
    }
}

/** world-to-trait writeback for moving bodies; companion-trait management lives in the coordinator. */
export function postStep(world: World, identity: PlayerId | null): void {
    for (const [rb, transform] of world._bodyQuery) {
        const node = rb._node;
        const bodyId = world.nodeToBody.get(node.id);
        if (bodyId === undefined) continue;

        const body = rigidBody.get(world.world, bodyId);
        if (!body) continue;

        if (body.motionType === MotionType.STATIC) continue;

        // server holding a non-authority kinematic body: writing back would echo the owner's own pose to them.
        if (identity === null && node.owner !== null && body.motionType === MotionType.KINEMATIC) {
            continue;
        }

        // body.position/quaternion are world-space; convert to local-space if the node has a transformed parent.
        if (hasTransformedParent(transform)) {
            worldToLocalPosition(transform, body.position, transform.position);
            worldToLocalQuaternion(transform, body.quaternion, transform.quaternion);
        } else {
            vec3.copy(transform.position, body.position);
            quat.copy(transform.quaternion, body.quaternion);
        }
        markTransformDirty(transform);
        vec3.copy(rb.linearVelocity, body.motionProperties.linearVelocity);
        vec3.copy(rb.angularVelocity, body.motionProperties.angularVelocity);

        world.lastPhysicsTransform.set(node.id, takeTransformSnapshot(body.position, body.quaternion));
    }
}
