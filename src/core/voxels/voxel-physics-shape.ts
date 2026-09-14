import type {
    CastRayCollector,
    CastRaySettings,
    CastShapeCollector,
    CastShapeHit,
    CastShapeSettings,
    CollidePointCollector,
    CollidePointSettings,
    CollideShapeCollector,
    CollideShapeHit,
    CollideShapeSettings,
    Face,
    Shape,
    SupportingFaceResult,
    SurfaceNormalResult,
} from 'crashcat';
import {
    box,
    CastRayStatus,
    castConvexVsConvexLocal,
    castShapeVsShape,
    collideConvexVsConvexLocal,
    collideShapeVsShape,
    createCastRayHit,
    createCollidePointHit,
    defineShape,
    reversedCastShapeVsShape,
    reversedCollideShapeVsShape,
    ShapeCategory,
    ShapeType,
    setCastShapeFn,
    setCollideShapeFn,
    shapeDefs,
    subShape,
    transformFaceWithMat4RotationTranslation,
} from 'crashcat';
import { mat4, quat, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import type { Blocks } from './block-registry';
import { AIR, BLOCK_FLAG_COLLISION, MISSING, MODEL_NONE } from './block-registry';
import { createVoxelRaycastResult, raycastVoxels } from './voxel-raycast';
import { CHUNK_BITS, CHUNK_SIZE, getChunk, getChunkAt, type Voxels, voxelIndex } from './voxels';

export type VoxelPhysicsShape = {
    type: ShapeType.USER_1;
    voxels: Voxels;
    aabb: Box3;
    centerOfMass: Vec3;
    volume: number;
};

/** the block registry isn't cached here since HMR block changes repoint voxels.registry; a cached copy would index new state ids into a stale array. */
export function createVoxelPhysicsShape(voxels: Voxels, aabb: Box3): VoxelPhysicsShape {
    return {
        type: ShapeType.USER_1,
        voxels,
        aabb: box3.clone(aabb),
        centerOfMass: vec3.create(),
        volume: 0,
    };
}

// shared unit box shape for cube collisions
const _voxelBoxShape = box.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.05 });
const _voxelBoxQuat = quat.fromValues(0, 0, 0, 1);
const _voxelBoxScale = vec3.fromValues(1, 1, 1);

// per-hit info lives in a growable pool array; the index is encoded in the low bits of subShapeId so
// getSurfaceNormal, getSupportingFace, and contact listeners can look up the correct voxel data for any hit.

// supporting faces from typical block colliders (boxes, hulls, compound children) have at most 16 vertices.
const FACE_MAX_VERTS = 16;
const FACE_VERT_FLOATS = FACE_MAX_VERTS * 3;

export type VoxelHitInfo = {
    // inclusive min corner; a single cube's cell, or a merged run's low corner.
    minX: number;
    minY: number;
    minZ: number;
    // exclusive max corner; used to rebuild the box face and enumerate covered cells.
    maxX: number;
    maxY: number;
    maxZ: number;
    stateId: number;
    cid: number; // 0 = cube, >0 = custom collider
    subAabbIndex: number; // -1 for cube; reserved for sub-aabb tagging on custom colliders
    // world-space normal captured at emission time (custom colliders only); assumes the voxel body is at identity transform.
    nx: number;
    ny: number;
    nz: number;
    faceNumVerts: number;
    faceVerts: Float32Array;
};

const _hitPool: VoxelHitInfo[] = [];
let _hitCount = 0;

function allocHitEntry(): VoxelHitInfo {
    if (_hitCount === _hitPool.length) {
        _hitPool.push({
            minX: 0,
            minY: 0,
            minZ: 0,
            maxX: 0,
            maxY: 0,
            maxZ: 0,
            stateId: 0,
            cid: 0,
            subAabbIndex: -1,
            nx: 0,
            ny: 0,
            nz: 0,
            faceNumVerts: 0,
            faceVerts: new Float32Array(FACE_VERT_FLOATS),
        });
    }
    return _hitPool[_hitCount++]!;
}

function pushCubeHit(vx: number, vy: number, vz: number, stateId: number): number {
    const idx = _hitCount;
    const entry = allocHitEntry();
    entry.minX = vx;
    entry.minY = vy;
    entry.minZ = vz;
    entry.maxX = vx + 1;
    entry.maxY = vy + 1;
    entry.maxZ = vz + 1;
    entry.stateId = stateId;
    entry.cid = 0;
    entry.subAabbIndex = -1;
    entry.faceNumVerts = 0;
    return idx;
}

// a merged run of same-stateId cube cells, treated as a single box; the contact listener enumerates the covered cells.
function pushMergedHit(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    stateId: number,
): number {
    const idx = _hitCount;
    const entry = allocHitEntry();
    entry.minX = minX;
    entry.minY = minY;
    entry.minZ = minZ;
    entry.maxX = maxX;
    entry.maxY = maxY;
    entry.maxZ = maxZ;
    entry.stateId = stateId;
    entry.cid = 0;
    entry.subAabbIndex = -1;
    entry.faceNumVerts = 0;
    return idx;
}

function pushCustomHit(
    vx: number,
    vy: number,
    vz: number,
    stateId: number,
    cid: number,
    nx: number,
    ny: number,
    nz: number,
    face: Face,
): number {
    const idx = _hitCount;
    const entry = allocHitEntry();
    entry.minX = vx;
    entry.minY = vy;
    entry.minZ = vz;
    // custom colliders occupy a single cell; a unit box range keeps contact-listener cell enumeration uniform.
    entry.maxX = vx + 1;
    entry.maxY = vy + 1;
    entry.maxZ = vz + 1;
    entry.stateId = stateId;
    entry.cid = cid;
    entry.subAabbIndex = -1;
    entry.nx = nx;
    entry.ny = ny;
    entry.nz = nz;
    const n = face.numVertices > FACE_MAX_VERTS ? FACE_MAX_VERTS : face.numVertices;
    entry.faceNumVerts = n;
    for (let i = 0; i < n * 3; i++) {
        entry.faceVerts[i] = face.vertices[i]!;
    }
    return idx;
}

// hit-buffer index encoded in the low bits of subShapeId; 20 bits = 1M entries per frame, leaving 12 bits of headroom.
const HIT_BUFFER_BITS = 20;

const _unpack_popResult = subShape.popResult();

/** reset the hit-info pool's high-water mark; must be the last call of the frame, after render and any post-render hooks. */
export function flushHitBuffer(): void {
    _hitCount = 0;
}

/** decode a subShapeId produced by this shape back into its VoxelHitInfo; the result is pool-owned, copy fields before the next query. */
export function unpackVoxelHitInfo(subShapeId: number): VoxelHitInfo {
    subShape.pop(_unpack_popResult, subShapeId, HIT_BUFFER_BITS);
    return _hitPool[_unpack_popResult.value]!;
}

// wraps the outer collector to capture each emission's normal + supporting face into the hit buffer,
// re-encoding subShapeIdA/B with the hit index before forwarding.

type WrapState = {
    outerCollideCollector: CollideShapeCollector | null;
    outerCastCollector: CastShapeCollector | null;
    // which side (A or B) the voxel shape is on; determines whether subShapeIdA or subShapeIdB gets re-encoded.
    voxelSide: 'A' | 'B';
    voxelOuterSubShapeId: number;
    voxelOuterSubShapeIdBits: number;
    vx: number;
    vy: number;
    vz: number;
    stateId: number;
    cid: number;
};

const _wrap: WrapState = {
    outerCollideCollector: null,
    outerCastCollector: null,
    voxelSide: 'A',
    voxelOuterSubShapeId: 0,
    voxelOuterSubShapeIdBits: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    stateId: 0,
    cid: 0,
};

const _wrapBuilder = subShape.builder();

function reEncodeVoxelSubShapeId(hitIdx: number): number {
    _wrapBuilder.value = _wrap.voxelOuterSubShapeId;
    _wrapBuilder.currentBit = _wrap.voxelOuterSubShapeIdBits;
    subShape.push(_wrapBuilder, _wrapBuilder, hitIdx, HIT_BUFFER_BITS);
    return _wrapBuilder.value;
}

const _wrapCollideCollector: CollideShapeCollector = {
    bodyIdB: 0,
    earlyOutFraction: 0,
    addHit(h: CollideShapeHit) {
        // penetrationAxis points from A's surface outward; normalizing it gives A's surface normal on either side.
        const voxelSide = _wrap.voxelSide;
        const face = voxelSide === 'A' ? h.faceA : h.faceB;
        let px = h.penetrationAxis[0];
        let py = h.penetrationAxis[1];
        let pz = h.penetrationAxis[2];
        if (voxelSide === 'B') {
            // B's outward normal is the opposite direction of A's penetrationAxis.
            px = -px;
            py = -py;
            pz = -pz;
        }
        const len = Math.sqrt(px * px + py * py + pz * pz);
        const inv = len > 1e-10 ? 1 / len : 0;
        const hitIdx = pushCustomHit(_wrap.vx, _wrap.vy, _wrap.vz, _wrap.stateId, _wrap.cid, px * inv, py * inv, pz * inv, face);
        const newId = reEncodeVoxelSubShapeId(hitIdx);
        if (voxelSide === 'A') h.subShapeIdA = newId;
        else h.subShapeIdB = newId;
        const outer = _wrap.outerCollideCollector!;
        outer.addHit(h);
        _wrapCollideCollector.earlyOutFraction = outer.earlyOutFraction;
    },
    addMiss() {
        _wrap.outerCollideCollector!.addMiss();
    },
    shouldEarlyOut() {
        return _wrap.outerCollideCollector!.shouldEarlyOut();
    },
    onBody(bodyId: number) {
        _wrap.outerCollideCollector!.onBody?.(bodyId);
    },
    onBodyEnd() {
        _wrap.outerCollideCollector!.onBodyEnd?.();
    },
    reset() {
        _wrap.outerCollideCollector!.reset?.();
    },
};

const _wrapCastCollector: CastShapeCollector = {
    bodyIdB: 0,
    earlyOutFraction: 0,
    addHit(h: CastShapeHit) {
        // CastShapeHit.normal points from B to A; A's outward normal is -normal, B's is +normal.
        const voxelSide = _wrap.voxelSide;
        const face = voxelSide === 'A' ? h.faceA : h.faceB;
        const sx = voxelSide === 'A' ? -h.normal[0] : h.normal[0];
        const sy = voxelSide === 'A' ? -h.normal[1] : h.normal[1];
        const sz = voxelSide === 'A' ? -h.normal[2] : h.normal[2];
        const hitIdx = pushCustomHit(_wrap.vx, _wrap.vy, _wrap.vz, _wrap.stateId, _wrap.cid, sx, sy, sz, face);
        const newId = reEncodeVoxelSubShapeId(hitIdx);
        if (voxelSide === 'A') h.subShapeIdA = newId;
        else h.subShapeIdB = newId;
        const outer = _wrap.outerCastCollector!;
        outer.addHit(h);
        _wrapCastCollector.earlyOutFraction = outer.earlyOutFraction;
    },
    addMiss() {
        _wrap.outerCastCollector!.addMiss();
    },
    shouldEarlyOut() {
        return _wrap.outerCastCollector!.shouldEarlyOut();
    },
};

// contiguous same-stateId cube cells collide as one box (see the merge below) with no interior seams; resized per run in place.
const _mergedBoxShape = box.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.05 });

function setMergedBoxHalfExtents(hx: number, hy: number, hz: number): void {
    _mergedBoxShape.halfExtents[0] = hx;
    _mergedBoxShape.halfExtents[1] = hy;
    _mergedBoxShape.halfExtents[2] = hz;
    _mergedBoxShape.aabb[0] = -hx;
    _mergedBoxShape.aabb[1] = -hy;
    _mergedBoxShape.aabb[2] = -hz;
    _mergedBoxShape.aabb[3] = hx;
    _mergedBoxShape.aabb[4] = hy;
    _mergedBoxShape.aabb[5] = hz;
}

// drops contacts on faces buried behind a solid neighbour cube (a tessellation "ghost collision" the mover couldn't reach); only exposed-face contacts forward.

type MergedRejectState = {
    outer: CollideShapeCollector | null;
    voxels: Voxels | null;
    registry: Blocks | null;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    stateId: number;
    outerSubShapeId: number;
    outerSubShapeIdBits: number;
};

const _mergedReject: MergedRejectState = {
    outer: null,
    voxels: null,
    registry: null,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
    stateId: 0,
    outerSubShapeId: 0,
    outerSubShapeIdBits: 0,
};

const _mergedRejectBuilder = subShape.builder();

const _mergedRejectCollector: CollideShapeCollector = {
    bodyIdB: 0,
    earlyOutFraction: 0,
    addHit(h: CollideShapeHit) {
        // dominant axis + sign of the outward penetration axis = the contacted face.
        const px = h.penetrationAxis[0];
        const py = h.penetrationAxis[1];
        const pz = h.penetrationAxis[2];
        const ax = Math.abs(px);
        const ay = Math.abs(py);
        const az = Math.abs(pz);
        // sample the cell just across the contacted face at the contact point (world space equals voxel-local here).
        let nx = Math.floor(h.pointA[0]);
        let ny = Math.floor(h.pointA[1]);
        let nz = Math.floor(h.pointA[2]);
        if (ax >= ay && ax >= az) nx = Math.floor(h.pointA[0] + (px >= 0 ? 0.5 : -0.5));
        else if (ay >= az) ny = Math.floor(h.pointA[1] + (py >= 0 ? 0.5 : -0.5));
        else nz = Math.floor(h.pointA[2] + (pz >= 0 ? 0.5 : -0.5));

        if (isBackingCube(_mergedReject.voxels!, _mergedReject.registry!, nx, ny, nz)) return;

        const hitIdx = pushMergedHit(
            _mergedReject.minX,
            _mergedReject.minY,
            _mergedReject.minZ,
            _mergedReject.maxX,
            _mergedReject.maxY,
            _mergedReject.maxZ,
            _mergedReject.stateId,
        );
        _mergedRejectBuilder.value = _mergedReject.outerSubShapeId;
        _mergedRejectBuilder.currentBit = _mergedReject.outerSubShapeIdBits;
        subShape.push(_mergedRejectBuilder, _mergedRejectBuilder, hitIdx, HIT_BUFFER_BITS);
        h.subShapeIdA = _mergedRejectBuilder.value;

        const outer = _mergedReject.outer!;
        outer.addHit(h);
        _mergedRejectCollector.earlyOutFraction = outer.earlyOutFraction;
    },
    addMiss() {
        _mergedReject.outer!.addMiss();
    },
    shouldEarlyOut() {
        return _mergedReject.outer!.shouldEarlyOut();
    },
    onBody(bodyId: number) {
        _mergedReject.outer!.onBody?.(bodyId);
    },
    onBodyEnd() {
        _mergedReject.outer!.onBodyEnd?.();
    },
    reset() {
        _mergedReject.outer!.reset?.();
    },
};

// face index convention: 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y), 4=south(+z), 5=north(-z)
function getFaceFromNormal(nx: number, ny: number, nz: number): number {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ax > ay && ax > az) {
        return nx > 0 ? 0 : 1; // east / west
    } else if (ay > az) {
        return ny > 0 ? 2 : 3; // up / down
    } else {
        return nz > 0 ? 4 : 5; // south / north
    }
}

// builds a CCW (viewed from outside) 4-vertex quad for box [x0,x1] x [y0,y1] x [z0,z1] into out.
function buildBoxQuad(out: Face, faceIdx: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    out.numVertices = 4;
    switch (faceIdx) {
        case 0: {
            // east (+x)
            out.vertices[0] = x1;
            out.vertices[1] = y0;
            out.vertices[2] = z0;
            out.vertices[3] = x1;
            out.vertices[4] = y0;
            out.vertices[5] = z1;
            out.vertices[6] = x1;
            out.vertices[7] = y1;
            out.vertices[8] = z1;
            out.vertices[9] = x1;
            out.vertices[10] = y1;
            out.vertices[11] = z0;
            break;
        }
        case 1: {
            // west (-x)
            out.vertices[0] = x0;
            out.vertices[1] = y0;
            out.vertices[2] = z0;
            out.vertices[3] = x0;
            out.vertices[4] = y1;
            out.vertices[5] = z0;
            out.vertices[6] = x0;
            out.vertices[7] = y1;
            out.vertices[8] = z1;
            out.vertices[9] = x0;
            out.vertices[10] = y0;
            out.vertices[11] = z1;
            break;
        }
        case 2: {
            // up (+y)
            out.vertices[0] = x0;
            out.vertices[1] = y1;
            out.vertices[2] = z0;
            out.vertices[3] = x1;
            out.vertices[4] = y1;
            out.vertices[5] = z0;
            out.vertices[6] = x1;
            out.vertices[7] = y1;
            out.vertices[8] = z1;
            out.vertices[9] = x0;
            out.vertices[10] = y1;
            out.vertices[11] = z1;
            break;
        }
        case 3: {
            // down (-y)
            out.vertices[0] = x0;
            out.vertices[1] = y0;
            out.vertices[2] = z0;
            out.vertices[3] = x0;
            out.vertices[4] = y0;
            out.vertices[5] = z1;
            out.vertices[6] = x1;
            out.vertices[7] = y0;
            out.vertices[8] = z1;
            out.vertices[9] = x1;
            out.vertices[10] = y0;
            out.vertices[11] = z0;
            break;
        }
        case 4: {
            // south (+z)
            out.vertices[0] = x0;
            out.vertices[1] = y0;
            out.vertices[2] = z1;
            out.vertices[3] = x1;
            out.vertices[4] = y0;
            out.vertices[5] = z1;
            out.vertices[6] = x1;
            out.vertices[7] = y1;
            out.vertices[8] = z1;
            out.vertices[9] = x0;
            out.vertices[10] = y1;
            out.vertices[11] = z1;
            break;
        }
        case 5: {
            // north (-z)
            out.vertices[0] = x0;
            out.vertices[1] = y0;
            out.vertices[2] = z0;
            out.vertices[3] = x0;
            out.vertices[4] = y1;
            out.vertices[5] = z0;
            out.vertices[6] = x1;
            out.vertices[7] = y1;
            out.vertices[8] = z0;
            out.vertices[9] = x1;
            out.vertices[10] = y0;
            out.vertices[11] = z0;
            break;
        }
    }
}

function getStateId(voxels: Voxels, wx: number, wy: number, wz: number): number {
    const chunk = getChunkAt(voxels, wx, wy, wz);
    if (!chunk || chunk.nonAirCount === 0) return AIR;
    const lx = wx & (CHUNK_SIZE - 1);
    const ly = wy & (CHUNK_SIZE - 1);
    const lz = wz & (CHUNK_SIZE - 1);
    const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
    return chunk.palette[paletteIdx]!;
}

// true only for a full unit-box collidable cube; non-cube solids (slabs, hulls) never fully back a neighbour's face.
function isBackingCube(voxels: Voxels, registry: Blocks, wx: number, wy: number, wz: number): boolean {
    const stateId = getStateId(voxels, wx, wy, wz);
    if (stateId === AIR || stateId === MISSING) return false;
    if (!(registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) return false;
    return registry.colliderId[stateId] === 0;
}

// wraps raycastVoxels(): transforms the ray to local space and encodes the hit in subShapeId via the hit buffer.
const _castRay_invQuat = quat.create();
const _castRay_localOrigin = vec3.create();
const _castRay_localDir = vec3.create();
const _castRay_hit = createCastRayHit();
const _castRay_subShapeIdBuilder = subShape.builder();
const _castRay_result = createVoxelRaycastResult();
const _castRay_degenerateFace: Face = { vertices: new Array(9).fill(0), numVertices: 0 };

function castRayVsVoxels(
    collector: CastRayCollector,
    _settings: CastRaySettings,
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    length: number,
    shape: VoxelPhysicsShape,
    subShapeId: number,
    subShapeIdBits: number,
    posX: number,
    posY: number,
    posZ: number,
    quatX: number,
    quatY: number,
    quatZ: number,
    quatW: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
): void {
    _castRay_localOrigin[0] = originX - posX;
    _castRay_localOrigin[1] = originY - posY;
    _castRay_localOrigin[2] = originZ - posZ;

    quat.set(_castRay_invQuat, quatX, quatY, quatZ, quatW);
    quat.conjugate(_castRay_invQuat, _castRay_invQuat);
    vec3.transformQuat(_castRay_localOrigin, _castRay_localOrigin, _castRay_invQuat);

    vec3.set(_castRay_localDir, directionX, directionY, directionZ);
    vec3.transformQuat(_castRay_localDir, _castRay_localDir, _castRay_invQuat);

    _castRay_localOrigin[0] /= Math.abs(scaleX);
    _castRay_localOrigin[1] /= Math.abs(scaleY);
    _castRay_localOrigin[2] /= Math.abs(scaleZ);

    _castRay_localDir[0] /= Math.abs(scaleX);
    _castRay_localDir[1] /= Math.abs(scaleY);
    _castRay_localDir[2] /= Math.abs(scaleZ);

    const dirLen = Math.sqrt(
        _castRay_localDir[0] * _castRay_localDir[0] +
            _castRay_localDir[1] * _castRay_localDir[1] +
            _castRay_localDir[2] * _castRay_localDir[2],
    );
    if (dirLen < 1e-10) return;

    const invDirLen = 1.0 / dirLen;
    _castRay_localDir[0] *= invDirLen;
    _castRay_localDir[1] *= invDirLen;
    _castRay_localDir[2] *= invDirLen;

    const maxDistance = length * dirLen;

    raycastVoxels(
        _castRay_result,
        shape.voxels,
        shape.voxels.registry,
        _castRay_localOrigin[0],
        _castRay_localOrigin[1],
        _castRay_localOrigin[2],
        _castRay_localDir[0],
        _castRay_localDir[1],
        _castRay_localDir[2],
        maxDistance,
        BLOCK_FLAG_COLLISION,
    );

    if (!_castRay_result.hit) return;

    const fraction = _castRay_result.distance / maxDistance;
    if (fraction > collector.earlyOutFraction) return;

    const stateId = _castRay_result.stateId;
    const cid = shape.voxels.registry.colliderId[stateId]!;
    let hitIdx: number;
    if (cid === 0) {
        hitIdx = pushCubeHit(_castRay_result.voxelX, _castRay_result.voxelY, _castRay_result.voxelZ, stateId);
    } else {
        // custom collider: raycasts give only a point + normal, so approximate with a degenerate triangle face.
        _castRay_degenerateFace.numVertices = 3;
        _castRay_degenerateFace.vertices[0] = _castRay_result.px;
        _castRay_degenerateFace.vertices[1] = _castRay_result.py;
        _castRay_degenerateFace.vertices[2] = _castRay_result.pz;
        _castRay_degenerateFace.vertices[3] = _castRay_result.px;
        _castRay_degenerateFace.vertices[4] = _castRay_result.py;
        _castRay_degenerateFace.vertices[5] = _castRay_result.pz;
        _castRay_degenerateFace.vertices[6] = _castRay_result.px;
        _castRay_degenerateFace.vertices[7] = _castRay_result.py;
        _castRay_degenerateFace.vertices[8] = _castRay_result.pz;
        hitIdx = pushCustomHit(
            _castRay_result.voxelX,
            _castRay_result.voxelY,
            _castRay_result.voxelZ,
            stateId,
            cid,
            _castRay_result.nx,
            _castRay_result.ny,
            _castRay_result.nz,
            _castRay_degenerateFace,
        );
    }

    _castRay_subShapeIdBuilder.value = subShapeId;
    _castRay_subShapeIdBuilder.currentBit = subShapeIdBits;
    subShape.push(_castRay_subShapeIdBuilder, _castRay_subShapeIdBuilder, hitIdx, HIT_BUFFER_BITS);

    _castRay_hit.status = CastRayStatus.COLLIDING;
    _castRay_hit.fraction = fraction;
    _castRay_hit.subShapeId = _castRay_subShapeIdBuilder.value;
    _castRay_hit.bodyIdB = collector.bodyIdB;
    collector.addHit(_castRay_hit);
}

// transforms the point to local space, floors to voxel coords, then checks state (cube = always inside, custom = AABB approximation).
const _collidePoint_invQuat = quat.create();
const _collidePoint_localPos = vec3.create();
const _collidePoint_hit = createCollidePointHit();
const _collidePoint_subShapeIdBuilder = subShape.builder();

function collidePointVsVoxels(
    collector: CollidePointCollector,
    _settings: CollidePointSettings,
    pointX: number,
    pointY: number,
    pointZ: number,
    shapeB: VoxelPhysicsShape,
    subShapeIdB: number,
    subShapeIdBitsB: number,
    posBX: number,
    posBY: number,
    posBZ: number,
    quatBX: number,
    quatBY: number,
    quatBZ: number,
    quatBW: number,
    scaleBX: number,
    scaleBY: number,
    scaleBZ: number,
): void {
    _collidePoint_localPos[0] = pointX - posBX;
    _collidePoint_localPos[1] = pointY - posBY;
    _collidePoint_localPos[2] = pointZ - posBZ;

    quat.set(_collidePoint_invQuat, quatBX, quatBY, quatBZ, quatBW);
    quat.conjugate(_collidePoint_invQuat, _collidePoint_invQuat);
    vec3.transformQuat(_collidePoint_localPos, _collidePoint_localPos, _collidePoint_invQuat);

    const lx = _collidePoint_localPos[0] / Math.abs(scaleBX);
    const ly = _collidePoint_localPos[1] / Math.abs(scaleBY);
    const lz = _collidePoint_localPos[2] / Math.abs(scaleBZ);

    const vx = Math.floor(lx);
    const vy = Math.floor(ly);
    const vz = Math.floor(lz);

    const stateId = getStateId(shapeB.voxels, vx, vy, vz);
    if (stateId === AIR || stateId === MISSING) return;
    if (!(shapeB.voxels.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) return;

    const mt = shapeB.voxels.registry.modelType[stateId]!;
    if (mt === MODEL_NONE && shapeB.voxels.registry.colliderId[stateId] === 0) return;

    // custom shapes approximate with unit-cube containment rather than exact collidePointVsShape.
    _collidePoint_subShapeIdBuilder.value = subShapeIdB;
    _collidePoint_subShapeIdBuilder.currentBit = subShapeIdBitsB;
    subShape.pushIndex(_collidePoint_subShapeIdBuilder, _collidePoint_subShapeIdBuilder, 0, 1);

    _collidePoint_hit.subShapeIdB = _collidePoint_subShapeIdBuilder.value;
    _collidePoint_hit.bodyIdB = collector.bodyIdB;
    collector.addHit(_collidePoint_hit);
}

// cube cells (colliderId=0) greedy-merge into boxes via collideConvexVsConvexLocal; custom shapes go through collideShapeVsShape.

// scratch for cube fast path
const _collideVox_quatAInv = quat.create();
const _collideVox_posBRelative = vec3.create();
const _collideVox_posBInA = vec3.create();
const _collideVox_quatBInA = quat.create();
const _collideVox_scaleAInv = vec3.create();
const _collideVox_scaleB = vec3.create();
const _collideVox_aabbMatrix = mat4.create();
const _collideVox_convexAABB = box3.create();
// per-query cube-cell grid over the scan window, stateId per cell (0 = empty/consumed); grows monotonically.
let _collideVox_mergeGrid = new Int32Array(0);

// flat index into the scan-window grid; x contiguous inner (matches voxel-model-collider).
function cellIndex(x: number, y: number, z: number, dimX: number, dimZ: number): number {
    return (y * dimZ + z) * dimX + x;
}

const _collideVox_posBRelToBox = vec3.create();
const _collideVox_transformAInWorld = mat4.create();
const _collideVox_transformBInA = mat4.create();
const _collideVox_boxPos = vec3.create();
const _collideVox_worldBoxPos = vec3.create();
function collideVoxelsVsConvex(
    collector: CollideShapeCollector,
    settings: CollideShapeSettings,
    shapeA: Shape,
    subShapeIdA: number,
    _subShapeIdBitsA: number,
    posAX: number,
    posAY: number,
    posAZ: number,
    quatAX: number,
    quatAY: number,
    quatAZ: number,
    quatAW: number,
    scaleAX: number,
    scaleAY: number,
    scaleAZ: number,
    shapeB: Shape,
    subShapeIdB: number,
    _subShapeIdBitsB: number,
    posBX: number,
    posBY: number,
    posBZ: number,
    quatBX: number,
    quatBY: number,
    quatBZ: number,
    quatBW: number,
    scaleBX: number,
    scaleBY: number,
    scaleBZ: number,
): void {
    const voxelShape = shapeA as unknown as VoxelPhysicsShape;
    const { voxels } = voxelShape;
    const registry = voxels.registry;

    vec3.set(_collideVox_scaleB, scaleBX, scaleBY, scaleBZ);

    // compute convex B in voxel A's local space, for the AABB scan below
    quat.set(_collideVox_quatAInv, quatAX, quatAY, quatAZ, quatAW);
    quat.conjugate(_collideVox_quatAInv, _collideVox_quatAInv);

    vec3.set(_collideVox_posBRelative, posBX - posAX, posBY - posAY, posBZ - posAZ);
    vec3.transformQuat(_collideVox_posBInA, _collideVox_posBRelative, _collideVox_quatAInv);

    quat.set(_collideVox_quatBInA, quatBX, quatBY, quatBZ, quatBW);
    quat.multiply(_collideVox_quatBInA, _collideVox_quatAInv, _collideVox_quatBInA);

    vec3.set(_collideVox_scaleAInv, 1.0 / Math.abs(scaleAX), 1.0 / Math.abs(scaleAY), 1.0 / Math.abs(scaleAZ));
    vec3.mul(_collideVox_posBInA, _collideVox_posBInA, _collideVox_scaleAInv);

    mat4.fromRotationTranslationScale(_collideVox_aabbMatrix, _collideVox_quatBInA, _collideVox_posBInA, _collideVox_scaleB);
    box3.transformMat4(_collideVox_convexAABB, shapeB.aabb, _collideVox_aabbMatrix);
    box3.expandByMargin(_collideVox_convexAABB, _collideVox_convexAABB, settings.maxSeparationDistance);

    const minVX = Math.floor(_collideVox_convexAABB[0]);
    const minVY = Math.floor(_collideVox_convexAABB[1]);
    const minVZ = Math.floor(_collideVox_convexAABB[2]);
    const maxVX = Math.ceil(_collideVox_convexAABB[3]);
    const maxVY = Math.ceil(_collideVox_convexAABB[4]);
    const maxVZ = Math.ceil(_collideVox_convexAABB[5]);

    const gridDimX = maxVX - minVX + 1;
    const gridDimY = maxVY - minVY + 1;
    const gridDimZ = maxVZ - minVZ + 1;
    const gridSize = gridDimX * gridDimY * gridDimZ;
    if (_collideVox_mergeGrid.length < gridSize) _collideVox_mergeGrid = new Int32Array(gridSize);
    _collideVox_mergeGrid.fill(0, 0, gridSize);
    const grid = _collideVox_mergeGrid;

    // stamp cube cells into the grid (merged below); collide custom colliders inline.
    for (let vz = minVZ; vz <= maxVZ; vz++) {
        for (let vy = minVY; vy <= maxVY; vy++) {
            for (let vx = minVX; vx <= maxVX; vx++) {
                const cx = vx >> CHUNK_BITS;
                const cy = vy >> CHUNK_BITS;
                const cz = vz >> CHUNK_BITS;
                const chunk = getChunk(voxels, cx, cy, cz);
                if (!chunk || chunk.nonAirCount === 0) continue;

                const lx = vx - (cx << CHUNK_BITS);
                const ly = vy - (cy << CHUNK_BITS);
                const lz = vz - (cz << CHUNK_BITS);
                const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                const stateId = chunk.palette[paletteIdx]!;
                if (stateId === AIR || stateId === MISSING) continue;
                if (!(voxelShape.voxels.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) continue;

                const cid = registry.colliderId[stateId]!;
                const mt = registry.modelType[stateId]!;
                if (mt === MODEL_NONE && cid === 0) continue;

                if (cid === 0) {
                    grid[cellIndex(vx - minVX, vy - minVY, vz - minVZ, gridDimX, gridDimZ)] = stateId;
                } else {
                    const colliderShape = registry.colliderShapes[cid]!;

                    // wrap the outer collector to capture this emission's normal + face into the hit buffer.
                    _wrap.outerCollideCollector = collector;
                    _wrap.voxelSide = 'A';
                    _wrap.voxelOuterSubShapeId = subShapeIdA;
                    _wrap.voxelOuterSubShapeIdBits = _subShapeIdBitsA;
                    _wrap.vx = vx;
                    _wrap.vy = vy;
                    _wrap.vz = vz;
                    _wrap.stateId = stateId;
                    _wrap.cid = cid;
                    _wrapCollideCollector.bodyIdB = collector.bodyIdB;
                    _wrapCollideCollector.earlyOutFraction = collector.earlyOutFraction;

                    // collider shape is in block-local [0,1] space at (vx,vy,vz) in A's local space; world_pos = posA + quatA * (scaleA * local_pos).
                    collideShapeVsShape(
                        _wrapCollideCollector,
                        settings,
                        colliderShape,
                        subShapeIdA,
                        _subShapeIdBitsA,
                        posAX + vx * scaleAX,
                        posAY + vy * scaleAY,
                        posAZ + vz * scaleAZ,
                        quatAX,
                        quatAY,
                        quatAZ,
                        quatAW,
                        scaleAX,
                        scaleAY,
                        scaleAZ,
                        shapeB,
                        subShapeIdB,
                        _subShapeIdBitsB,
                        posBX,
                        posBY,
                        posBZ,
                        quatBX,
                        quatBY,
                        quatBZ,
                        quatBW,
                        scaleBX,
                        scaleBY,
                        scaleBZ,
                    );

                    if (collector.shouldEarlyOut()) return;
                }
            }
        }
    }

    // greedy-merge: extend each maximal same-stateId run along x, then z, then y (matching voxel-model-collider).
    for (let lgy = 0; lgy < gridDimY; lgy++) {
        for (let lgz = 0; lgz < gridDimZ; lgz++) {
            for (let lgx = 0; lgx < gridDimX; lgx++) {
                const s = grid[cellIndex(lgx, lgy, lgz, gridDimX, gridDimZ)]!;
                if (s === 0) continue;

                let extX = 1;
                while (lgx + extX < gridDimX && grid[cellIndex(lgx + extX, lgy, lgz, gridDimX, gridDimZ)] === s) extX++;

                let extZ = 1;
                zExtend: while (lgz + extZ < gridDimZ) {
                    for (let xx = 0; xx < extX; xx++) {
                        if (grid[cellIndex(lgx + xx, lgy, lgz + extZ, gridDimX, gridDimZ)] !== s) break zExtend;
                    }
                    extZ++;
                }

                let extY = 1;
                yExtend: while (lgy + extY < gridDimY) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            if (grid[cellIndex(lgx + xx, lgy + extY, lgz + zz, gridDimX, gridDimZ)] !== s) break yExtend;
                        }
                    }
                    extY++;
                }

                for (let yy = 0; yy < extY; yy++) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            grid[cellIndex(lgx + xx, lgy + yy, lgz + zz, gridDimX, gridDimZ)] = 0;
                        }
                    }
                }

                const wx0 = minVX + lgx;
                const wy0 = minVY + lgy;
                const wz0 = minVZ + lgz;

                vec3.set(_collideVox_boxPos, wx0 + extX * 0.5, wy0 + extY * 0.5, wz0 + extZ * 0.5);
                setMergedBoxHalfExtents(extX * 0.5, extY * 0.5, extZ * 0.5);
                vec3.sub(_collideVox_posBRelToBox, _collideVox_posBInA, _collideVox_boxPos);

                _mergedReject.outer = collector;
                _mergedReject.voxels = voxels;
                _mergedReject.registry = registry;
                _mergedReject.minX = wx0;
                _mergedReject.minY = wy0;
                _mergedReject.minZ = wz0;
                _mergedReject.maxX = wx0 + extX;
                _mergedReject.maxY = wy0 + extY;
                _mergedReject.maxZ = wz0 + extZ;
                _mergedReject.stateId = s;
                _mergedReject.outerSubShapeId = subShapeIdA;
                _mergedReject.outerSubShapeIdBits = _subShapeIdBitsA;
                _mergedRejectCollector.bodyIdB = collector.bodyIdB;
                _mergedRejectCollector.earlyOutFraction = collector.earlyOutFraction;

                // transformAInWorld must be in world space; _collideVox_boxPos is voxel-local.
                vec3.set(
                    _collideVox_worldBoxPos,
                    posAX + _collideVox_boxPos[0] * scaleAX,
                    posAY + _collideVox_boxPos[1] * scaleAY,
                    posAZ + _collideVox_boxPos[2] * scaleAZ,
                );
                mat4.fromRotationTranslation(_collideVox_transformAInWorld, _voxelBoxQuat, _collideVox_worldBoxPos);
                mat4.fromRotationTranslation(_collideVox_transformBInA, _collideVox_quatBInA, _collideVox_posBRelToBox);

                collideConvexVsConvexLocal(
                    _mergedRejectCollector,
                    settings,
                    _mergedBoxShape,
                    subShapeIdA,
                    shapeB,
                    subShapeIdB,
                    _collideVox_transformBInA,
                    _collideVox_transformAInWorld,
                    _voxelBoxScale,
                    _collideVox_scaleB,
                );

                if (collector.shouldEarlyOut()) return;
            }
        }
    }
}

// swept shape test: cube blocks via castConvexVsConvexLocal, custom shapes via castShapeVsShape.
const _castVox_displacementInB = vec3.create();
const _castVox_sweptAABB = box3.create();
const _castVox_posA = vec3.create();
const _castVox_quatA = quat.create();
const _castVox_scaleA = vec3.create();
const _castVox_displacementA = vec3.create();
const _castVox_posB = vec3.create();
const _castVox_quatB = quat.create();
const _castVox_scaleB = vec3.create();
const _castVox_BtoWorld = mat4.create();
const _castVox_AtoB = mat4.create();
const _castVox_AtoWorld = mat4.create();
const _castVox_invBtoWorld = mat4.create();
const _castVox_subShapeIdBuilder = subShape.builder();

// scratch for cube cast path
const _castVox_boxPos = vec3.create();
const _castVox_castTransformCube = mat4.create();
const _castVox_displacementInBox = vec3.create();
const _castVox_worldPointA = vec3.create();

function castConvexVsVoxels(
    collector: CastShapeCollector,
    settings: CastShapeSettings,
    shapeA: Shape,
    subShapeIdA: number,
    _subShapeIdBitsA: number,
    posAX: number,
    posAY: number,
    posAZ: number,
    quatAX: number,
    quatAY: number,
    quatAZ: number,
    quatAW: number,
    scaleAX: number,
    scaleAY: number,
    scaleAZ: number,
    displacementAX: number,
    displacementAY: number,
    displacementAZ: number,
    shapeB: Shape,
    subShapeIdB: number,
    subShapeIdBitsB: number,
    posBX: number,
    posBY: number,
    posBZ: number,
    quatBX: number,
    quatBY: number,
    quatBZ: number,
    quatBW: number,
    scaleBX: number,
    scaleBY: number,
    scaleBZ: number,
): void {
    const voxelShape = shapeB as unknown as VoxelPhysicsShape;
    const { voxels } = voxelShape;
    const registry = voxels.registry;

    vec3.set(_castVox_posA, posAX, posAY, posAZ);
    quat.set(_castVox_quatA, quatAX, quatAY, quatAZ, quatAW);
    vec3.set(_castVox_scaleA, scaleAX, scaleAY, scaleAZ);
    vec3.set(_castVox_displacementA, displacementAX, displacementAY, displacementAZ);
    vec3.set(_castVox_posB, posBX, posBY, posBZ);
    quat.set(_castVox_quatB, quatBX, quatBY, quatBZ, quatBW);
    vec3.set(_castVox_scaleB, scaleBX, scaleBY, scaleBZ);

    const transformA = mat4.fromRotationTranslationScale(_castVox_AtoWorld, _castVox_quatA, _castVox_posA, _castVox_scaleA);
    const targetTransform = mat4.fromRotationTranslation(_castVox_BtoWorld, _castVox_quatB, _castVox_posB);

    // castTransform = B^-1 * A (A's transform in B's local space)
    mat4.invert(_castVox_invBtoWorld, targetTransform);
    const castTransform = mat4.multiply(_castVox_AtoB, _castVox_invBtoWorld, transformA);

    mat4.multiply3x3Vec(_castVox_displacementInB, _castVox_invBtoWorld, _castVox_displacementA);
    box3.transformMat4(_castVox_sweptAABB, shapeA.aabb, castTransform);

    const expandedMinX = Math.min(_castVox_sweptAABB[0], _castVox_sweptAABB[0] + _castVox_displacementInB[0]);
    const expandedMinY = Math.min(_castVox_sweptAABB[1], _castVox_sweptAABB[1] + _castVox_displacementInB[1]);
    const expandedMinZ = Math.min(_castVox_sweptAABB[2], _castVox_sweptAABB[2] + _castVox_displacementInB[2]);
    const expandedMaxX = Math.max(_castVox_sweptAABB[3], _castVox_sweptAABB[3] + _castVox_displacementInB[0]);
    const expandedMaxY = Math.max(_castVox_sweptAABB[4], _castVox_sweptAABB[4] + _castVox_displacementInB[1]);
    const expandedMaxZ = Math.max(_castVox_sweptAABB[5], _castVox_sweptAABB[5] + _castVox_displacementInB[2]);

    const minVX = Math.floor(expandedMinX);
    const minVY = Math.floor(expandedMinY);
    const minVZ = Math.floor(expandedMinZ);
    const maxVX = Math.ceil(expandedMaxX);
    const maxVY = Math.ceil(expandedMaxY);
    const maxVZ = Math.ceil(expandedMaxZ);

    const mat4_BtoWorld = targetTransform;

    for (let vz = minVZ; vz < maxVZ; vz++) {
        for (let vy = minVY; vy < maxVY; vy++) {
            for (let vx = minVX; vx < maxVX; vx++) {
                const cx = vx >> CHUNK_BITS;
                const cy = vy >> CHUNK_BITS;
                const cz = vz >> CHUNK_BITS;
                const chunk = getChunk(voxels, cx, cy, cz);
                if (!chunk || chunk.nonAirCount === 0) continue;

                const lx = vx - (cx << CHUNK_BITS);
                const ly = vy - (cy << CHUNK_BITS);
                const lz = vz - (cz << CHUNK_BITS);
                const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                const stateId = chunk.palette[paletteIdx]!;
                if (stateId === AIR || stateId === MISSING) continue;
                if (!(voxelShape.voxels.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) continue;

                const cid = registry.colliderId[stateId]!;
                const mt = registry.modelType[stateId]!;
                if (mt === MODEL_NONE && cid === 0) continue;

                if (cid === 0) {
                    const hitIdx = pushCubeHit(vx, vy, vz, stateId);

                    vec3.set(_castVox_boxPos, vx + 0.5, vy + 0.5, vz + 0.5);

                    // box has identity rotation, so castTransformCube = translate(-boxPos) * castTransform.
                    mat4.copy(_castVox_castTransformCube, castTransform);
                    _castVox_castTransformCube[12] -= _castVox_boxPos[0];
                    _castVox_castTransformCube[13] -= _castVox_boxPos[1];
                    _castVox_castTransformCube[14] -= _castVox_boxPos[2];

                    vec3.copy(_castVox_displacementInBox, _castVox_displacementInB);

                    const _boxWorldMat = _collideVox_transformAInWorld; // reuse scratch
                    mat4.fromRotationTranslation(
                        _boxWorldMat,
                        _castVox_quatB,
                        vec3.transformMat4(_castVox_worldPointA, _castVox_boxPos, mat4_BtoWorld),
                    );

                    _castVox_subShapeIdBuilder.value = subShapeIdB;
                    _castVox_subShapeIdBuilder.currentBit = subShapeIdBitsB;
                    subShape.push(_castVox_subShapeIdBuilder, _castVox_subShapeIdBuilder, hitIdx, HIT_BUFFER_BITS);

                    castConvexVsConvexLocal(
                        collector,
                        settings,
                        shapeA,
                        subShapeIdA,
                        _voxelBoxShape,
                        _castVox_subShapeIdBuilder.value,
                        _castVox_castTransformCube,
                        _castVox_scaleA,
                        _castVox_displacementInBox,
                        _voxelBoxScale,
                        _boxWorldMat,
                    );
                } else {
                    const colliderShape = registry.colliderShapes[cid]!;

                    // wrap the outer collector to capture this emission's normal + face, re-encoding subShapeIdB.
                    _wrap.outerCastCollector = collector;
                    _wrap.voxelSide = 'B';
                    _wrap.voxelOuterSubShapeId = subShapeIdB;
                    _wrap.voxelOuterSubShapeIdBits = subShapeIdBitsB;
                    _wrap.vx = vx;
                    _wrap.vy = vy;
                    _wrap.vz = vz;
                    _wrap.stateId = stateId;
                    _wrap.cid = cid;
                    _wrapCastCollector.bodyIdB = collector.bodyIdB;
                    _wrapCastCollector.earlyOutFraction = collector.earlyOutFraction;

                    // collider shape is in block-local [0,1] space, positioned at voxel origin in world space.
                    castShapeVsShape(
                        _wrapCastCollector,
                        settings,
                        shapeA,
                        subShapeIdA,
                        _subShapeIdBitsA,
                        posAX,
                        posAY,
                        posAZ,
                        quatAX,
                        quatAY,
                        quatAZ,
                        quatAW,
                        scaleAX,
                        scaleAY,
                        scaleAZ,
                        displacementAX,
                        displacementAY,
                        displacementAZ,
                        colliderShape,
                        subShapeIdB,
                        subShapeIdBitsB,
                        // collider world position = voxel pos in B's local, transformed to world
                        posBX + vx * scaleBX,
                        posBY + vy * scaleBY,
                        posBZ + vz * scaleBZ,
                        quatBX,
                        quatBY,
                        quatBZ,
                        quatBW,
                        scaleBX,
                        scaleBY,
                        scaleBZ,
                    );
                }
            }
        }
    }
}

// decodes the hit buffer index from subShapeId, then computes the surface normal: closest cube face, or the captured normal for custom colliders.
const _getSurfaceNormal_popResult = subShape.popResult();

function getSurfaceNormal(ioResult: SurfaceNormalResult, _shape: VoxelPhysicsShape, _subShapeId: number): void {
    subShape.pop(_getSurfaceNormal_popResult, _subShapeId, HIT_BUFFER_BITS);
    const info = _hitPool[_getSurfaceNormal_popResult.value]!;

    if (info.cid === 0) {
        // cube or merged run: closest face of the box using exact bounds from the buffer.
        const px = ioResult.position[0];
        const py = ioResult.position[1];
        const pz = ioResult.position[2];

        const dEast = info.maxX - px;
        const dWest = px - info.minX;
        const dUp = info.maxY - py;
        const dDown = py - info.minY;
        const dSouth = info.maxZ - pz;
        const dNorth = pz - info.minZ;

        let minDist = dEast;
        let nx = 1,
            ny = 0,
            nz = 0;

        if (dWest < minDist) {
            minDist = dWest;
            nx = -1;
            ny = 0;
            nz = 0;
        }
        if (dUp < minDist) {
            minDist = dUp;
            nx = 0;
            ny = 1;
            nz = 0;
        }
        if (dDown < minDist) {
            minDist = dDown;
            nx = 0;
            ny = -1;
            nz = 0;
        }
        if (dSouth < minDist) {
            minDist = dSouth;
            nx = 0;
            ny = 0;
            nz = 1;
        }
        if (dNorth < minDist) {
            nx = 0;
            ny = 0;
            nz = -1;
        }

        vec3.set(ioResult.normal, nx, ny, nz);
    } else {
        // custom collider: use the normal captured when the inner shape emitted this contact.
        vec3.set(ioResult.normal, info.nx, info.ny, info.nz);
    }
}

// decodes the hit buffer index from subShapeId, then builds the supporting face: box quad for cubes, captured face for custom colliders.
const _getSupportingFace_popResult = subShape.popResult();

function getSupportingFace(
    ioResult: SupportingFaceResult,
    direction: Vec3,
    _shape: VoxelPhysicsShape,
    _subShapeId: number,
): void {
    const face = ioResult.face;

    subShape.pop(_getSupportingFace_popResult, _subShapeId, HIT_BUFFER_BITS);
    const info = _hitPool[_getSupportingFace_popResult.value]!;

    if (info.cid === 0) {
        // direction is in shape-local space (voxel coords), pointing into the surface.
        const faceIdx = getFaceFromNormal(-direction[0], -direction[1], -direction[2]);
        buildBoxQuad(face, faceIdx, info.minX, info.minY, info.minZ, info.maxX, info.maxY, info.maxZ);
    } else {
        const n = info.faceNumVerts;
        face.numVertices = n;
        for (let i = 0; i < n * 3; i++) {
            face.vertices[i] = info.faceVerts[i]!;
        }
    }

    transformFaceWithMat4RotationTranslation(face, ioResult.transform);
}

declare module 'crashcat' {
    interface ShapeTypeRegistry {
        [ShapeType.USER_1]: VoxelPhysicsShape;
    }
}

export const voxelPhysicsShapeDef = defineShape<VoxelPhysicsShape>({
    type: ShapeType.USER_1,
    category: ShapeCategory.MESH,
    computeMassProperties(out) {
        // static terrain, no mass
        out.mass = 0;
    },
    castRay: castRayVsVoxels,
    collidePoint: collidePointVsVoxels,
    getSurfaceNormal,
    getSupportingFace,
    register() {
        for (const def of Object.values(shapeDefs)) {
            if (def.category === ShapeCategory.CONVEX) {
                // voxels (A) vs convex (B), our primary direction
                setCollideShapeFn(ShapeType.USER_1, def.type, collideVoxelsVsConvex);
                // convex (A) vs voxels (B), reversed
                setCollideShapeFn(def.type, ShapeType.USER_1, reversedCollideShapeVsShape(collideVoxelsVsConvex));
                // cast: convex (A) vs voxels (B)
                setCastShapeFn(def.type, ShapeType.USER_1, castConvexVsVoxels);
                // cast: voxels (A) vs convex (B), reversed
                setCastShapeFn(ShapeType.USER_1, def.type, reversedCastShapeVsShape(castConvexVsVoxels));
            }
        }
    },
});
