// ── rigid body physics subsystem ────────────────────────────────────
//
// self-contained world for crashcat-backed rigid bodies (full broadphase,
// manifolds, sleep). owns the crashcat world, the voxel terrain body, the
// node↔body bookkeeping, all trait-aware shape building / sync, and the
// contact listener that translates crashcat manifolds into the shared
// `PhysicsContacts` stream.
//
// shape mirrors `aabb-physics`: `World` + factories + `preStep` (trait→world
// sync) + `tick` (step + record contacts) + `postStep` (writeback). the
// top-level `Physics` holds a single `rigid` handle and orchestrates by
// calling these, it does not own crashcat state, listener building, or
// shape construction directly.

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
import { type Box3, box3, type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { MeshTrait } from '../../builtins/mesh';
import { type RigidBodyDef, RigidBodyTrait, type ShapeDef } from '../../builtins/rigid-body';
import {
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
    hasTransformedParent,
    markTransformDirty,
    TransformTrait,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../../builtins/transform';
import type { PlayerId } from '../client';
import type { MeshId } from '../models/handle';
import * as Resources from '../resources';
import type { Node, Nodes } from '../scene/nodes';
import { getTrait, query } from '../scene/nodes';
import { logScriptError } from '../scene/script-errors';
import type { PhysicsContactArgs } from '../scene/scripts';
import { traverse } from '../scene/traverse';
import type { BlockRegistry } from '../voxels/block-registry';
import { createVoxelPhysicsShape, unpackVoxelHitInfo, type VoxelPhysicsShape } from '../voxels/voxel-physics-shape';
import type { Voxels } from '../voxels/voxels';
import {
    type ContactPair,
    type ContactPairPool,
    type PhysicsContacts,
    pairKey,
    recordContactPair,
    rigidBodySideKey,
    voxelSideKey,
} from './contacts';
import {
    COLLISION_GROUP_NODES,
    COLLISION_GROUP_VOXELS,
    OBJECT_LAYER_NODE_MOVING,
    OBJECT_LAYER_NODE_NOT_MOVING,
    OBJECT_LAYER_VOXELS,
    settings,
} from './crashcat';

// ── infinite aabb ───────────────────────────────────────────────────

// the voxel shape does per-chunk lookups so bounds don't matter for
// correctness. we use an effectively infinite aabb so the broadphase
// always considers the voxels as a candidate.
const INF = 1e8;
const INFINITE_AABB: [number, number, number, number, number, number] = [-INF, -INF, -INF, INF, INF, INF];

// ── property snapshot (for change detection) ────────────────────────

export type PropertySnapshot = {
    motionType: MotionType;
    /** snapshot of rb.prediction, changing this requires body recreation. */
    prediction: boolean;
    /**
     * snapshot of node.owner, server demotes owned non-prediction dynamic
     * bodies to kinematic so the owner client is the sim authority, so an
     * ownership change must trigger a motion-type update.
     */
    owner: PlayerId | null;
    /**
     * the `rb.def` reference at last install. ref-compared each preStep,
     * mismatch means the user (editor / sync / script) replaced the def, so
     * the installer-owned body is destroyed and a new one is built.
     */
    lastDef: RigidBodyDef | null;
    /**
     * the `rb.body` reference at last install. ref-compared each preStep,
     * mismatch means a script reassigned the body, so we adopt the new one
     * (and destroy the previous one if we owned it).
     */
    installedBody: RigidBody | null;
    /**
     * true if the installer built the current body from `rb.def` (and so
     * owns its teardown on def-change). false if the body was script-adopted.
     */
    installerOwned: boolean;
};

// ── transform snapshot (for teleport detection) ─────────────────────

export type TransformSnapshot = {
    position: Vec3;
    quaternion: Quat;
};

// ── world ───────────────────────────────────────────────────────────

export type World = {
    /** scene graph back-ref. needed for trait sync, getNodeById, and script-hook fan-out. */
    nodes: Nodes;

    /** crashcat world, full broadphase + manifold pipeline. */
    world: CrashcatWorld;
    /** static body holding the voxel terrain shape. */
    terrainBody: RigidBody;
    /** the voxel physics shape on the terrain body. */
    terrainShape: VoxelPhysicsShape;

    /** maps node id → crashcat body id */
    nodeToBody: Map<number, BodyId>;
    /** maps crashcat body id → node id (for collision resolution) */
    bodyToNode: Map<BodyId, number>;
    /** property snapshot per node for change detection */
    propertySnapshots: Map<number, PropertySnapshot>;
    /** last physics-written transform per node for teleport detection */
    lastPhysicsTransform: Map<number, TransformSnapshot>;

    /** cached query for trait sync, built once at create. */
    _bodyQuery: ReturnType<typeof query<[typeof RigidBodyTrait, typeof TransformTrait]>>;

    /** body contacts gathered by character VCCs during `runOnTick` (which runs
     *  before the rigid solver). a VCC depenetrates its character off the bodies
     *  it touches and teleport-follows its kinematic inner body, so by the time
     *  the solver steps there's no overlap and no manifold, a fast projectile
     *  would pass straight through with no contact event. these are replayed into
     *  the contact stream each tick (see {@link ingestVccContacts}) so they reach
     *  both bodies' `ContactsTrait` like any solver contact. `vccContactCount` is
     *  the live length; the records are reused (no per-frame allocation). */
    vccContacts: VccBodyContact[];
    vccContactCount: number;
};

/** one body contact reported by a character VCC, pending replay into the
 *  contact stream. body ids (not refs) so a body removed mid-tick is skipped. */
type VccBodyContact = {
    innerBodyId: BodyId;
    otherBodyId: BodyId;
    point: Vec3;
    normal: Vec3;
    penetrationDepth: number;
};

export function create(nodes: Nodes, voxels: Voxels, registry: BlockRegistry): World {
    const world = createWorld(settings);
    const terrainShape = createVoxelPhysicsShape(voxels, registry, INFINITE_AABB);
    const terrainBody = rigidBody.create(world, {
        shape: terrainShape,
        objectLayer: OBJECT_LAYER_VOXELS,
        motionType: MotionType.STATIC,
        collisionGroups: COLLISION_GROUP_VOXELS,
    });
    return {
        nodes,
        world,
        terrainBody,
        terrainShape,
        nodeToBody: new Map(),
        bodyToNode: new Map(),
        propertySnapshots: new Map(),
        lastPhysicsTransform: new Map(),
        _bodyQuery: query(nodes, [RigidBodyTrait, TransformTrait]),
        vccContacts: [],
        vccContactCount: 0,
    };
}

/** record a body contact a character VCC saw this frame, to be replayed into
 *  the contact stream by {@link ingestVccContacts}. called from the character
 *  controller's VCC listener during `runOnTick`. `innerBodyId` is the VCC's
 *  kinematic inner body (maps back to the character node); `otherBodyId` is the
 *  body it touched (e.g. an arrow). `normal` is surface→character (VCC
 *  convention). */
export function pushVccContact(
    world: World,
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
    let rec = world.vccContacts[world.vccContactCount];
    if (!rec) {
        rec = { innerBodyId: -1, otherBodyId: -1, point: vec3.create(), normal: vec3.create(), penetrationDepth: 0 };
        world.vccContacts[world.vccContactCount] = rec;
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
    world.vccContactCount++;
}

/** replay this tick's VCC body contacts into the contact stream, then clear the
 *  buffer. MUST run inside the contacts frame (after the solver tick, before the
 *  frame ends) so the pairs diff and fan out like solver contacts. a pair the
 *  solver also recorded (a slow body the VCC didn't depenetrate clear of) shares
 *  the same key, so this just refreshes it, no double contact. */
export function ingestVccContacts(world: World, contacts: PhysicsContacts, pool: ContactPairPool): void {
    for (let i = 0; i < world.vccContactCount; i++) {
        const rec = world.vccContacts[i]!;
        const innerBody = rigidBody.get(world.world, rec.innerBodyId);
        const otherBody = rigidBody.get(world.world, rec.otherBodyId);
        if (!innerBody || !otherBody) continue;
        recordBodyContact(world, contacts, pool, innerBody, otherBody, rec.point, rec.normal, rec.penetrationDepth);
    }
    world.vccContactCount = 0;
}

/** tear down all node-tracked bodies before discarding the crashcat world. */
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

// ── helpers ─────────────────────────────────────────────────────────

export function objectLayerForMotionType(mt: MotionType): number {
    return mt === MotionType.STATIC ? OBJECT_LAYER_NODE_NOT_MOVING : OBJECT_LAYER_NODE_MOVING;
}

export function takeTransformSnapshot(pos: Vec3, rot: Quat): TransformSnapshot {
    return {
        position: vec3.clone(pos),
        quaternion: quat.clone(rot),
    };
}

// ── effective motion type ─────────────────────────────────────────────
//
// simulate=false (edit mode): everything clamped to static, bodies exist
//   for queries + debug viz only, no simulation.
// otherwise: the sim *authority* for a body uses its declared motionType.
// authority is the server when the node is ownerless, the owning client
// when it's owned. non-authorities (peer clients, or the server for an
// owned body) demote DYNAMIC+!prediction to KINEMATIC so they follow
// replicated pose instead of running their own sim.

function effectiveMotionType(rb: RigidBodyTrait, identity: PlayerId | null, simulate: boolean): MotionType {
    if (!simulate) return MotionType.STATIC;
    const owner = rb._node.owner;
    const isAuthority = identity === null ? owner === null : owner === identity;
    if (isAuthority) return rb.motionType;
    if (rb.motionType === MotionType.DYNAMIC && !rb.prediction) return MotionType.KINEMATIC;
    return rb.motionType;
}

// ── shape building ────────────────────────────────────────────────────
//
// driven by the `def` field on RigidBodyTrait. preStep calls `buildShape`
// with `rb.def.shape` when a (re)install is required. if the shape can be
// built right away we go ahead and install; if not (e.g. auto/hull payload
// still loading) the next preStep tries again.

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

// ── auto-shape: collect mesh contributions from descendant MeshTraits ──

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

// ── auto-shape: bounds modes (box/sphere/capsule, +Y axis) ─────────────

const _autoAabb = box3.create();
const _tmpAabb = box3.create();

function computeAutoBoundsAabb(out: Box3, contribs: MeshContribution[], resources: Resources.Resources): boolean {
    box3.empty(out);
    let any = false;
    for (const c of contribs) {
        const handle = Resources.modelHandle(resources, c.meshId.modelId);
        if (!handle) continue;
        const meshEntry = handle.meshes[c.meshId.meshName];
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
            // +Y axis (intended for characters/mobs).
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

// ── auto-shape: geometry modes (hull/mesh) ─────────────────────────────
//
// these are expensive, cache built shapes keyed by the contributions that
// produced them. cache hit means same set of (mesh ids, local matrices,
// mode), common when many bodies share an auto-shape recipe.
//
// no eviction: model unload-and-reload is rare in practice and the worst
// case is a small wasted Shape held by the cache. if/when this becomes a
// real memory pressure, add eviction back driven by Resources.releaseModel.

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
    // require all geometries loaded; kick off any missing loads.
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

/**
 * Build a crashcat Shape for the given `ShapeDef`. Returns null when the
 * shape can't be built yet, e.g. an `'auto'` hull/mesh whose model payload
 * is still loading, or no MeshTrait descendants exist. The caller retries
 * on the next preStep.
 */
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

/**
 * synthesize box-equivalent mass properties from a shape's local AABB.
 * triangle-mesh shapes have no natural mass, dynamic bodies that wrap one
 * need synthetic mass props or they fall through the world. mirrors what
 * jolt does for mesh-on-dynamic.
 */
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

// ── body installation (declarative `def` path) ────────────────────────
//
// builds a fresh body from `rb.def` and assigns `rb.body`. seeded with the
// node's world transform plus every optional field the def carries,
// crashcat fills missing fields from DEFAULT_RIGID_BODY_SETTINGS. seeds
// motionType / prediction on the trait too so subsequent edits start from
// the def's intent rather than the trait's default.

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

    // seed motionType / prediction from the def on the install pass. once
    // installed, the trait fields are the source of truth and can be edited
    // freely without touching the def.
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
            // node rigid bodies are always in the NODES group (a structural
            // fact, like terrain is always VOXELS); a game's own groups stack
            // on top so "filter toward nodes" stays reliable.
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

// ── body destruction ──────────────────────────────────────────────────
//
// `destroyBody` is the unconditional path used when a node loses its
// RigidBodyTrait (or the trait is told to dispose). it removes whichever
// body is currently mapped, installer-built or script-adopted alike.
// callers wanting the "shared body" escape hatch null `rb.body` first so
// the body isn't mapped when this fires.

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

// ── per-rb world sync ─────────────────────────────────────────────────
//
// runs once per tick per (rb, transform) pair. installer & adopt flows:
//   1. def ref-change → if we own the body, destroy it; the next step will
//      build a new one from the new def.
//   2. def set + no body → build from def and adopt.
//   3. body ref differs from snapshot → script reassigned `rb.body`. if
//      the previous body was installer-built, destroy it before adopting
//      the new one.
//   4. body null after adoption → script set body to null (escape hatch).
//      drop our mapping but don't destroy a body that isn't there.
// then: motion-type / owner / teleport / non-owner-kinematic velocity push.

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

    // 1. def ref-change → tear down our installer-built body so the new
    //    def can produce a fresh one. adopt-mode bodies (installerOwned=false)
    //    are left alone, the script owns them and def changes are advisory.
    if (snap && rb.def !== snap.lastDef && snap.installerOwned && rb.body !== null) {
        rigidBody.remove(world.world, rb.body);
        world.nodeToBody.delete(node.id);
        world.bodyToNode.delete(rb.body.id);
        rb.body = null;
        snap.installedBody = null;
        snap.installerOwned = false;
    }

    // 2. installer path: def set, no body → build. tracks `justBuilt` so the
    //    adopt-or-install branch below knows whether to flag installerOwned.
    let justBuilt = false;
    if (rb.def && !rb.body) {
        const built = buildBodyFromDef(world, node, rb, transform, rb.def, resources, identity, simulate);
        if (built) {
            rb.body = built;
            justBuilt = true;
        }
    }

    // 3. body changed (we just built it, or script reassigned `rb.body`).
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

            // flush buffered velocity from trait → body. covers network unpack
            // that wrote rb.linearVelocity before the body was online; for fresh
            // script-built bodies this is the user's initial velocity.
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
            // body went null (escape hatch). prev body was installer-built →
            // already destroyed above. prev was adopted → leave it alone.
            if (prevBody && !prevInstallerOwned) {
                world.bodyToNode.delete(prevBody.id);
            }
            world.nodeToBody.delete(node.id);
            world.propertySnapshots.delete(node.id);
            world.lastPhysicsTransform.delete(node.id);
            return;
        }
    } else if (snap && rb.def !== snap.lastDef) {
        // def ref-change while in adopt mode (or while a new build hasn't
        // produced a body yet), sync lastDef so we don't keep retrying.
        snap.lastDef = rb.def;
    }

    const body = rb.body;
    if (!body || !snap) return;

    // motion-type / owner sync.
    const mt = effectiveMotionType(rb, identity, simulate);
    if (rb.motionType !== snap.motionType || rb.prediction !== snap.prediction || node.owner !== snap.owner) {
        rigidBody.setMotionType(world.world, body, mt, true);
        rigidBody.setObjectLayer(world.world, body, objectLayerForMotionType(mt));
        snap.motionType = rb.motionType;
        snap.prediction = rb.prediction;
        snap.owner = node.owner;
    }

    // teleport: snap the body if the world transform was moved externally.
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

    // client-side replication smoothing: a KINEMATIC body we don't own would
    // otherwise sit still between sparse poseSync teleports. push synced
    // rb.linearVelocity / angularVelocity into it so we integrate motion
    // continuously, the next poseSync corrects drift via the teleport branch
    // above. covers both demoted-DYNAMIC (prediction off) and server-declared
    // KINEMATIC (moving platforms). gated on non-owner so we don't clobber
    // locally-simulated bodies or the server's own state.
    if (identity !== null && node.owner !== identity && body.motionType === MotionType.KINEMATIC) {
        vec3.copy(body.motionProperties.linearVelocity, rb.linearVelocity);
        vec3.copy(body.motionProperties.angularVelocity, rb.angularVelocity);
    }
}

// ── listener (built fresh each tick, closes over current contacts stream) ─
//
// phase 1 (listener): translate each manifold into a `ContactPair` in
// `contacts`. one canonical entry per (A, B) pair regardless of perspective,
// fan-out (in the coordinator) splits that into per-observer Contacts later.
//
// classification:
//   - body.id === terrainBody.id → voxel side.
//   - bodyToNode hit             → node side (e.g. crate, character body).
//   - neither                    → unresolvable (e.g. VCC inner body with
//                                  no node mapping). skipped.

/**
 * When one side of a rigid-body contact is the terrain, swap in the
 * per-block friction/restitution looked up from the registry and run the
 * standard crashcat combine, `combineMaterial(value, mode)` priority-
 * resolves the two sides' combine modes (MAX > MIN > GEOMETRIC_MEAN >
 * MULTIPLY > AVERAGE). The terrain body uses crashcat defaults
 * (frictionCombineMode=GEOMETRIC_MEAN, restitutionCombineMode=MAX) so a
 * body with restitution=1 bounces off any block (MAX wins over the block's
 * default restitution of 0), while friction blends geometrically.
 */
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
    const registry = world.terrainShape.registry;
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
    | { kind: 'voxel'; voxelX: number; voxelY: number; voxelZ: number; stateId: number; subAabbIndex: number }
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
            stateId: number;
            subAabbIndex: number;
        };
        const info = unpackVoxelHitInfo(subShapeId);
        v.voxelX = info.vx;
        v.voxelY = info.vy;
        v.voxelZ = info.vz;
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
        } else {
            p.bKind = 'voxel';
            p.bVoxelX = s.voxelX;
            p.bVoxelY = s.voxelY;
            p.bVoxelZ = s.voxelZ;
            p.bStateId = s.stateId;
            p.bSubAabbIndex = s.subAabbIndex;
        }
    }
}

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

    const key = pairKey(sideKey(_sideA), sideKey(_sideB));
    const pair = recordContactPair(contacts, pool, key);

    writePairSide(pair, 'a', _sideA);
    writePairSide(pair, 'b', _sideB);

    // manifold fields. point: first A-side contact point (consistent with the
    // old PhysicsCollision). normal: world-space A→B.
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

/** record a body↔body contact from an explicit point/normal (no manifold),
 *  used to replay VCC contacts. side A is the character's inner body, side B the
 *  body it touched; the pair fans out to both nodes' `ContactsTrait`. */
function recordBodyContact(
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
    // VCC `normal` is surface→character; A is the character (inner body), so A→B
    // (pair convention) is the opposite direction.
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

function fireContactHooks(
    nodes: Nodes,
    event: 'added' | 'persisted',
    bodyA: RigidBody,
    bodyB: RigidBody,
    manifold: ContactManifold,
    contactSettings: ContactSettings,
): void {
    const args: PhysicsContactArgs = { bodyA, bodyB, manifold, settings: contactSettings };
    if (!nodes.runtime) return;
    for (const nodeInstances of nodes.runtime.instances.values()) {
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

function fireValidateHooks(nodes: Nodes, bodyA: RigidBody, bodyB: RigidBody): boolean {
    if (!nodes.runtime) return true;
    for (const nodeInstances of nodes.runtime.instances.values()) {
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
    const nodes = world.nodes;
    return {
        onBodyPairValidate(bodyA: RigidBody, bodyB: RigidBody): boolean {
            return fireValidateHooks(nodes, bodyA, bodyB);
        },
        onContactAdded(bodyA: RigidBody, bodyB: RigidBody, manifold: ContactManifold, contactSettings: ContactSettings): void {
            applyVoxelMaterialOverride(world, bodyA, bodyB, manifold, contactSettings);
            recordContactFromManifold(world, contacts, pool, bodyA, bodyB, manifold);
            fireContactHooks(nodes, 'added', bodyA, bodyB, manifold, contactSettings);
        },
        onContactPersisted(
            bodyA: RigidBody,
            bodyB: RigidBody,
            manifold: ContactManifold,
            contactSettings: ContactSettings,
        ): void {
            applyVoxelMaterialOverride(world, bodyA, bodyB, manifold, contactSettings);
            recordContactFromManifold(world, contacts, pool, bodyA, bodyB, manifold);
            fireContactHooks(nodes, 'persisted', bodyA, bodyB, manifold, contactSettings);
        },
    };
}

// ── tick / preStep / postStep ─────────────────────────────────────────

/** step the crashcat world. contact events drain into `contacts` via the listener. */
export function tick(world: World, contacts: PhysicsContacts, pool: ContactPairPool, dt: number): void {
    const listener = buildListener(world, contacts, pool);
    updateWorld(world.world, listener, dt);
}

/** trait → world sync. install/update bodies for nodes with RigidBodyTrait, destroy
 *  bodies for nodes that lost the trait. */
export function preStep(world: World, resources: Resources.Resources, identity: PlayerId | null, simulate: boolean): void {
    const active = new Set<number>();
    for (const [rb, transform] of world._bodyQuery) {
        const node = rb._node;
        active.add(node.id);
        syncRigidBodyToWorld(world, node, rb, transform, resources, identity, simulate);
    }

    // destroy bodies for nodes that lost the trait
    for (const nodeId of [...world.nodeToBody.keys()]) {
        if (active.has(nodeId)) continue;
        destroyBody(world, nodeId, null);
    }
}

/** world → trait writeback for moving bodies. companion-trait management
 *  (Interpolate/Contacts) lives in the coordinator. */
export function postStep(world: World, identity: PlayerId | null): void {
    for (const [rb, transform] of world._bodyQuery) {
        const node = rb._node;
        const bodyId = world.nodeToBody.get(node.id);
        if (bodyId === undefined) continue;

        const body = rigidBody.get(world.world, bodyId);
        if (!body) continue;

        if (body.motionType === MotionType.STATIC) continue;

        // server holding a non-authority kinematic body (owner is a client):
        // the body was snapped in preStep from the owner-replicated transform
        // and the sim didn't move it. writing back would re-dirty the
        // transform and the outgoing TransformTrait sync would echo the
        // owner's own pose back at them. genuine server-initiated pose
        // changes still go through (they mutate transform directly, not via
        // the body). same reasoning for velocity write-back, we don't want
        // to clobber the replicated rb.linearVelocity with body's zero.
        if (identity === null && node.owner !== null && body.motionType === MotionType.KINEMATIC) {
            continue;
        }

        // body.position/quaternion are world-space from the physics engine.
        // convert to local-space for storage if the node has a transformed parent.
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
