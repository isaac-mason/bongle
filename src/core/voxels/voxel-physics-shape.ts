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
import { type Box3, box3, mat4, quat, type Vec3, vec3 } from 'mathcat';
import type { BlockRegistry } from './block-registry';
import { AIR, BLOCK_FLAG_COLLISION, MISSING, MODEL_NONE } from './block-registry';
import { createVoxelRaycastResult, raycastVoxels } from './voxel-raycast';
import { CHUNK_BITS, CHUNK_SIZE, chunkKey, type Voxels, voxelIndex } from './voxels';

// ── shape type ──────────────────────────────────────────────────────

export type VoxelPhysicsShape = {
    type: ShapeType.USER_1;
    voxels: Voxels;
    registry: BlockRegistry;
    aabb: Box3;
    centerOfMass: Vec3;
    volume: number;
};

export function createVoxelPhysicsShape(voxels: Voxels, registry: BlockRegistry, aabb: Box3): VoxelPhysicsShape {
    return {
        type: ShapeType.USER_1,
        voxels,
        registry,
        aabb: box3.clone(aabb),
        centerOfMass: vec3.create(),
        volume: 0,
    };
}

// ── shared unit box shape for cube collisions ───────────────────────

const _voxelBoxShape = box.create({ halfExtents: vec3.fromValues(0.5, 0.5, 0.5), convexRadius: 0.05 });
const _voxelBoxQuat = quat.fromValues(0, 0, 0, 1);
const _voxelBoxScale = vec3.fromValues(1, 1, 1);

// ── hit info buffer ─────────────────────────────────────────────────
//
// per-hit info lives in a growable, pool-backed array indexed by a
// monotonic counter. the index is encoded in the subShapeId (low bits)
// so getSurfaceNormal, getSupportingFace, and contact listeners can
// look up the correct voxel data for any hit, even when Jolt holds the
// subShapeId across multi-frame contact persistence.
//
// for cube voxel hits we only need (vx, vy, vz, stateId), geometry is
// recomputed on demand. for custom-collider hits we additionally capture
// the contact's surface normal and supporting face at emission time
// (via a wrapper collector, see below) so we don't need a stale
// "last-hit" global.
//
// lifecycle:
//   per-voxel-query: push entry → encode index in subShapeId
//   contact listeners / getSurfaceNormal / getSupportingFace decode the
//     subShapeId and index into the pool, entries stay valid for the
//     entire frame.
//   frame end: flushHitBuffer() resets the high-water mark to 0, freeing
//     all entries back to the pool. MUST be the absolute last call of
//     the frame on both server and client (after all hooks AND render).

// supporting faces from typical block colliders (boxes, hulls, compound
// children) have ≤ 16 vertices. realistic block colliders won't exceed
// this, captured faces are truncated if they do.
const FACE_MAX_VERTS = 16;
const FACE_VERT_FLOATS = FACE_MAX_VERTS * 3;

export type VoxelHitInfo = {
    // min cell corner (inclusive). for a single cube this is the voxel; for a merged run
    // it is the run's low corner.
    minX: number;
    minY: number;
    minZ: number;
    // max cell corner (exclusive). unit cube: (minX+1, minY+1, minZ+1). merged run: the run
    // bounds. used by getSupportingFace / getSurfaceNormal to build the box face, and by the
    // contact listener to enumerate the covered cells under the contact footprint. unused for custom.
    maxX: number;
    maxY: number;
    maxZ: number;
    stateId: number;
    cid: number; // 0 = cube, >0 = custom collider
    subAabbIndex: number; // -1 for cube; reserved for sub-aabb tagging on custom colliders
    // captured for custom-collider hits at emission time. world space,
    // assumes the voxel shape's body is at identity transform (terrain).
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

// a merged run of same-stateId cube cells, spanning [minX,maxX) × [minY,maxY) × [minZ,maxZ).
// treated as a single box for collision; the contact listener enumerates the covered
// cells under the contact footprint so per-cell contact fidelity is preserved.
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
    // custom colliders occupy a single cell; a unit box range keeps the contact-listener
    // cell enumeration uniform (one cell) even though the box face isn't used for custom.
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

// hit-buffer index encoded in the low bits of subShapeId. 20 bits = 1M
// entries per frame, well beyond realistic narrowphase counts; leaves
// 12 bits of headroom for any outer subShapeId path bits the caller
// passes in.
const HIT_BUFFER_BITS = 20;

const _unpack_popResult = subShape.popResult();

/**
 * Reset the hit-info pool's high-water mark. MUST be the absolute last
 * call of each frame on both server and client (after render and any
 * post-render hooks), so contact-listener consumers can resolve
 * subShapeIds for the entire frame. Misplacement is the main correctness
 * risk, call it AFTER everything else.
 */
export function flushHitBuffer(): void {
    _hitCount = 0;
}

/**
 * Decode a `subShapeId` produced by this shape back into the original
 * `VoxelHitInfo`. Single source of truth for subShapeId → block lookup
 * used by rigid-body and vcc contact listeners.
 *
 * The returned object is owned by the pool, copy fields you need
 * before another physics query runs.
 */
export function unpackVoxelHitInfo(subShapeId: number): VoxelHitInfo {
    subShape.pop(_unpack_popResult, subShapeId, HIT_BUFFER_BITS);
    return _hitPool[_unpack_popResult.value]!;
}

// ── wrapper collector for custom-collider emissions ────────────────
//
// inner colliders (compound, convex hull, etc.) push their own bits onto
// subShapeIdA. our getSurfaceNormal / getSupportingFace need the hit
// buffer index in the *low* bits of subShapeId (so subShape.pop reads it
// first). we wrap the outer collector, capture each emission's normal
// and supporting face into the hit buffer, then OVERWRITE subShapeIdA
// with `outerSubShapeIdA :: hitIdx` before forwarding. inner shape's
// internal sub-id is discarded, we don't need it because everything we
// need at flush time is already in the buffer entry.
//
// the wrapper assumes the voxel shape body is at identity transform
// (which is true for the world terrain body). penetrationAxis / faceA
// are stored as-is in world space, which equals voxel-shape-local space.

type WrapState = {
    outerCollideCollector: CollideShapeCollector | null;
    outerCastCollector: CastShapeCollector | null;
    // which side (A or B) the voxel shape is on for this call. determines
    // whether we re-encode hit.subShapeIdA or hit.subShapeIdB.
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
        // penetrationAxis points from A's surface outward (direction to
        // push B out of A). normalize to get A's surface normal, same
        // direction whether voxel shape is A or B (faceA is on A).
        const voxelSide = _wrap.voxelSide;
        const face = voxelSide === 'A' ? h.faceA : h.faceB;
        let px = h.penetrationAxis[0];
        let py = h.penetrationAxis[1];
        let pz = h.penetrationAxis[2];
        if (voxelSide === 'B') {
            // when voxel is B, A's outward normal is -penetrationAxis;
            // we want B's outward normal, which IS -A's outward = penetrationAxis.
            // wait: penetrationAxis is direction to push B OUT OF A → away from A's
            // surface (A's outward normal). B's outward normal points the opposite way.
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
        // CastShapeHit.normal points from B to A. A's outward surface normal
        // is -normal; B's outward surface normal is +normal.
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

// ── merged cube box + neighbour-reject wrapper ──────────────────────
//
// contiguous same-stateId cube cells are collided as one box (see the merge in
// collideVoxelsVsConvex), so the moving body sees a continuous surface instead of
// a grid of unit cubes — no interior seams to snag on. this shared box shape is
// resized per merged run in place (no per-run allocation).
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

// wraps the outer collector for the merged-box collision. a contact whose contacted
// face is buried behind a solid neighbour cube is a tessellation artifact (a "ghost
// collision"): the moving body could not physically reach that internal face without
// first hitting the neighbour. we drop it; only exposed-face contacts (neighbour is
// air or a non-cube) are forwarded. because a merged box spans many cells, the buried
// test samples the cell just across the contacted face at the CONTACT POINT rather
// than a fixed neighbour.
//
// the contacted face is the one the penetrationAxis points out of (voxel is A;
// penetrationAxis is the direction to push B out of A, i.e. A's outward normal).
// pushing the hit + encoding its subShapeId happens lazily here, only for kept
// contacts; the covered run [min,max) rides along so the contact listener can
// enumerate the touched cells under the contact footprint.

type MergedRejectState = {
    outer: CollideShapeCollector | null;
    voxels: Voxels | null;
    registry: BlockRegistry | null;
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
        // sample the cell just across the contacted face at the contact point (world space
        // equals voxel-local for the identity terrain body). nudge half a cell along the
        // contact axis into the neighbour; floor the other two axes at the contact point.
        let nx = Math.floor(h.pointA[0]);
        let ny = Math.floor(h.pointA[1]);
        let nz = Math.floor(h.pointA[2]);
        if (ax >= ay && ax >= az) nx = Math.floor(h.pointA[0] + (px >= 0 ? 0.5 : -0.5));
        else if (ay >= az) ny = Math.floor(h.pointA[1] + (py >= 0 ? 0.5 : -0.5));
        else nz = Math.floor(h.pointA[2] + (pz >= 0 ? 0.5 : -0.5));

        // buried behind a solid cube → internal face → drop the ghost contact.
        if (isBackingCube(_mergedReject.voxels!, _mergedReject.registry!, nx, ny, nz)) return;

        // kept: register the merged run and encode its hit index into subShapeIdA, then forward.
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

// ── face helpers ────────────────────────────────────────────────────
//
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

// build a 4-vertex quad for an axis-aligned box face into an output array.
// box spans [x0,x1] × [y0,y1] × [z0,z1]. a unit cube passes x1=x0+1 etc; a merged run
// passes the run bounds. CCW when viewed from outside.
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

// ── voxel lookup ────────────────────────────────────────────────────

function getStateId(voxels: Voxels, wx: number, wy: number, wz: number): number {
    const cx = wx >> CHUNK_BITS;
    const cy = wy >> CHUNK_BITS;
    const cz = wz >> CHUNK_BITS;
    const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
    if (!chunk || chunk.nonAirCount === 0) return AIR;
    const lx = wx & (CHUNK_SIZE - 1);
    const ly = wy & (CHUNK_SIZE - 1);
    const lz = wz & (CHUNK_SIZE - 1);
    const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
    return chunk.palette[paletteIdx]!;
}

// whether the cell at (wx,wy,wz) is a solid collidable CUBE (colliderId 0), i.e. a full
// unit box that "backs" a shared face. used by the neighbour-reject below: only a backing
// cube behind a face makes that face internal. non-cube solids (slabs, hulls) fill their
// cell partially, so they never back a neighbour's face — a cube face against them is a
// real geometric transition (matches voxel-active-edges' cube-vs-custom rule).
function isBackingCube(voxels: Voxels, registry: BlockRegistry, wx: number, wy: number, wz: number): boolean {
    const stateId = getStateId(voxels, wx, wy, wz);
    if (stateId === AIR || stateId === MISSING) return false;
    if (!(registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) return false;
    return registry.colliderId[stateId] === 0;
}

// ── castRay ─────────────────────────────────────────────────────────
//
// thin wrapper around raycastVoxels(). transforms ray to local space,
// calls the existing DDA+BVH raycast, converts result to crashcat
// collector format. encodes hit info in subShapeId via hit buffer.

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
    // transform ray to shape local space
    _castRay_localOrigin[0] = originX - posX;
    _castRay_localOrigin[1] = originY - posY;
    _castRay_localOrigin[2] = originZ - posZ;

    quat.set(_castRay_invQuat, quatX, quatY, quatZ, quatW);
    quat.conjugate(_castRay_invQuat, _castRay_invQuat);
    vec3.transformQuat(_castRay_localOrigin, _castRay_localOrigin, _castRay_invQuat);

    vec3.set(_castRay_localDir, directionX, directionY, directionZ);
    vec3.transformQuat(_castRay_localDir, _castRay_localDir, _castRay_invQuat);

    // apply inverse scale
    _castRay_localOrigin[0] /= Math.abs(scaleX);
    _castRay_localOrigin[1] /= Math.abs(scaleY);
    _castRay_localOrigin[2] /= Math.abs(scaleZ);

    _castRay_localDir[0] /= Math.abs(scaleX);
    _castRay_localDir[1] /= Math.abs(scaleY);
    _castRay_localDir[2] /= Math.abs(scaleZ);

    // normalize direction after scaling
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

    // call existing raycast with collision flag filter
    raycastVoxels(
        _castRay_result,
        shape.voxels,
        shape.registry,
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

    // push hit info into buffer
    const stateId = _castRay_result.stateId;
    const cid = shape.registry.colliderId[stateId]!;
    let hitIdx: number;
    if (cid === 0) {
        hitIdx = pushCubeHit(_castRay_result.voxelX, _castRay_result.voxelY, _castRay_result.voxelZ, stateId);
    } else {
        // custom collider, raycast gives us a single normal + hit point.
        // store the normal directly; face is a degenerate triangle around
        // the hit point (raycasts don't carry a supporting face).
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

    // emit hit
    _castRay_subShapeIdBuilder.value = subShapeId;
    _castRay_subShapeIdBuilder.currentBit = subShapeIdBits;
    subShape.push(_castRay_subShapeIdBuilder, _castRay_subShapeIdBuilder, hitIdx, HIT_BUFFER_BITS);

    _castRay_hit.status = CastRayStatus.COLLIDING;
    _castRay_hit.fraction = fraction;
    _castRay_hit.subShapeId = _castRay_subShapeIdBuilder.value;
    _castRay_hit.bodyIdB = collector.bodyIdB;
    collector.addHit(_castRay_hit);
}

// ── collidePoint ────────────────────────────────────────────────────
//
// transform point to local space, floor to voxel coords, check state.
// for cube: always inside. for custom: AABB check (approximation).

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
    // transform to local space
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
    if (!(shapeB.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) return;

    const mt = shapeB.registry.modelType[stateId]!;
    if (mt === MODEL_NONE && shapeB.registry.colliderId[stateId] === 0) return;

    // for custom shapes, approximate with unit cube containment check.
    // collidePoint is a rough test, exact shape containment would require
    // crashcat's collidePointVsShape but the approximation is sufficient here.

    _collidePoint_subShapeIdBuilder.value = subShapeIdB;
    _collidePoint_subShapeIdBuilder.currentBit = subShapeIdBitsB;
    subShape.pushIndex(_collidePoint_subShapeIdBuilder, _collidePoint_subShapeIdBuilder, 0, 1);

    _collidePoint_hit.subShapeIdB = _collidePoint_subShapeIdBuilder.value;
    _collidePoint_hit.bodyIdB = collector.bodyIdB;
    collector.addHit(_collidePoint_hit);
}

// ── collideVoxelsVsConvex ───────────────────────────────────────────
//
// the big one. two codepaths:
//   cube blocks (colliderId=0): greedy-merged into boxes, collideConvexVsConvexLocal
//   custom shapes (colliderId≠0): crashcat collideShapeVsShape
//
// cube cells in the scan window are stamped into `_collideVox_mergeGrid` by stateId,
// then a greedy 3D merge (extend x, then z, then y — same as voxel-model-collider)
// collapses contiguous same-stateId runs into one box each. the moving body sees a
// continuous surface instead of a grid of unit cubes, so there are no interior seams
// to snag on, and far fewer narrowphase calls on flat/dense terrain.

// scratch for cube fast path
const _collideVox_quatAInv = quat.create();
const _collideVox_posBRelative = vec3.create();
const _collideVox_posBInA = vec3.create();
const _collideVox_quatBInA = quat.create();
const _collideVox_scaleAInv = vec3.create();
const _collideVox_scaleB = vec3.create();
const _collideVox_aabbMatrix = mat4.create();
const _collideVox_convexAABB = box3.create();
// per-query cube-cell grid over the scan window, stateId per cell (0 = empty/consumed).
// grows monotonically; cleared to the used size each query.
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
    const { voxels, registry } = voxelShape;

    vec3.set(_collideVox_scaleB, scaleBX, scaleBY, scaleBZ);

    // ── compute convex B in voxel A's local space (for AABB scan) ───

    // inverse quat A
    quat.set(_collideVox_quatAInv, quatAX, quatAY, quatAZ, quatAW);
    quat.conjugate(_collideVox_quatAInv, _collideVox_quatAInv);

    // B position relative to A, rotated into A's local space
    vec3.set(_collideVox_posBRelative, posBX - posAX, posBY - posAY, posBZ - posAZ);
    vec3.transformQuat(_collideVox_posBInA, _collideVox_posBRelative, _collideVox_quatAInv);

    // B rotation in A's local space
    quat.set(_collideVox_quatBInA, quatBX, quatBY, quatBZ, quatBW);
    quat.multiply(_collideVox_quatBInA, _collideVox_quatAInv, _collideVox_quatBInA);

    // apply inverse scale of A
    vec3.set(_collideVox_scaleAInv, 1.0 / Math.abs(scaleAX), 1.0 / Math.abs(scaleAY), 1.0 / Math.abs(scaleAZ));
    vec3.mul(_collideVox_posBInA, _collideVox_posBInA, _collideVox_scaleAInv);

    // convex B's AABB in voxel space
    mat4.fromRotationTranslationScale(_collideVox_aabbMatrix, _collideVox_quatBInA, _collideVox_posBInA, _collideVox_scaleB);
    box3.transformMat4(_collideVox_convexAABB, shapeB.aabb, _collideVox_aabbMatrix);
    box3.expandByMargin(_collideVox_convexAABB, _collideVox_convexAABB, settings.maxSeparationDistance);

    const minVX = Math.floor(_collideVox_convexAABB[0]);
    const minVY = Math.floor(_collideVox_convexAABB[1]);
    const minVZ = Math.floor(_collideVox_convexAABB[2]);
    const maxVX = Math.ceil(_collideVox_convexAABB[3]);
    const maxVY = Math.ceil(_collideVox_convexAABB[4]);
    const maxVZ = Math.ceil(_collideVox_convexAABB[5]);

    // cube-cell grid over the scan window (local indices, x contiguous inner).
    const gridDimX = maxVX - minVX + 1;
    const gridDimY = maxVY - minVY + 1;
    const gridDimZ = maxVZ - minVZ + 1;
    const gridSize = gridDimX * gridDimY * gridDimZ;
    if (_collideVox_mergeGrid.length < gridSize) _collideVox_mergeGrid = new Int32Array(gridSize);
    _collideVox_mergeGrid.fill(0, 0, gridSize);
    const grid = _collideVox_mergeGrid;

    // ── pass 1: stamp cube cells into the grid; collide custom colliders inline ──

    for (let vz = minVZ; vz <= maxVZ; vz++) {
        for (let vy = minVY; vy <= maxVY; vy++) {
            for (let vx = minVX; vx <= maxVX; vx++) {
                // chunk-skip
                const cx = vx >> CHUNK_BITS;
                const cy = vy >> CHUNK_BITS;
                const cz = vz >> CHUNK_BITS;
                const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
                if (!chunk || chunk.nonAirCount === 0) continue;

                const lx = vx - (cx << CHUNK_BITS);
                const ly = vy - (cy << CHUNK_BITS);
                const lz = vz - (cz << CHUNK_BITS);
                const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                const stateId = chunk.palette[paletteIdx]!;
                if (stateId === AIR || stateId === MISSING) continue;
                if (!(voxelShape.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) continue;

                const cid = registry.colliderId[stateId]!;
                const mt = registry.modelType[stateId]!;
                if (mt === MODEL_NONE && cid === 0) continue;

                if (cid === 0) {
                    // cube cell → stamp its stateId into the grid; the merge pass below
                    // collapses contiguous same-stateId cells into boxes and collides them.
                    grid[cellIndex(vx - minVX, vy - minVY, vz - minVZ, gridDimX, gridDimZ)] = stateId;
                } else {
                    // ── custom collider shape: delegate to crashcat ──

                    const colliderShape = registry.colliderShapes[cid]!;

                    // wrap the outer collector so we capture each emission's
                    // surface normal + supporting face into the hit buffer
                    // and re-encode subShapeIdA with our hit index.
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

                    // collider shape is in block-local [0,1] space,
                    // positioned at the voxel origin (vx, vy, vz) in voxel-A's local space,
                    // then scaled by voxel shape scale (scaleA)
                    collideShapeVsShape(
                        _wrapCollideCollector,
                        settings,
                        colliderShape,
                        subShapeIdA,
                        _subShapeIdBitsA,
                        // collider shape position in world = voxel pos in A-local, transformed to world
                        // but collideShapeVsShape expects world-space positions. the voxel shape (A)
                        // is at (posAX, posAY, posAZ) with (quatA, scaleA). the collider is at
                        // (vx, vy, vz) in A's local space. we need world-space position.
                        // world_pos = posA + quatA * (scaleA * local_pos)
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

    // ── pass 2: greedy-merge cube runs and collide each box ─────────
    // extend along x, then z, then y (matching voxel-model-collider). each maximal
    // same-stateId run collides once, through the reject wrapper that drops boundary
    // internal-face ghosts; the run rides along on the hit so the contact listener can
    // enumerate the covered cells.
    for (let lgy = 0; lgy < gridDimY; lgy++) {
        for (let lgz = 0; lgz < gridDimZ; lgz++) {
            for (let lgx = 0; lgx < gridDimX; lgx++) {
                const s = grid[cellIndex(lgx, lgy, lgz, gridDimX, gridDimZ)]!;
                if (s === 0) continue;

                // extend along x
                let extX = 1;
                while (lgx + extX < gridDimX && grid[cellIndex(lgx + extX, lgy, lgz, gridDimX, gridDimZ)] === s) extX++;

                // extend along z: the whole x-row at z+extZ must match
                let extZ = 1;
                zExtend: while (lgz + extZ < gridDimZ) {
                    for (let xx = 0; xx < extX; xx++) {
                        if (grid[cellIndex(lgx + xx, lgy, lgz + extZ, gridDimX, gridDimZ)] !== s) break zExtend;
                    }
                    extZ++;
                }

                // extend along y: the whole xz-slab at y+extY must match
                let extY = 1;
                yExtend: while (lgy + extY < gridDimY) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            if (grid[cellIndex(lgx + xx, lgy + extY, lgz + zz, gridDimX, gridDimZ)] !== s) break yExtend;
                        }
                    }
                    extY++;
                }

                // consume the run
                for (let yy = 0; yy < extY; yy++) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            grid[cellIndex(lgx + xx, lgy + yy, lgz + zz, gridDimX, gridDimZ)] = 0;
                        }
                    }
                }

                // merged box: world cell range [wx0,wx0+extX) × [wy0,..) × [wz0,..)
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

// ── castConvexVsVoxels ──────────────────────────────────────────────
//
// swept shape test. cube blocks: castConvexVsConvexLocal.
// custom shapes: crashcat castShapeVsShape.

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
    const { voxels, registry } = voxelShape;

    vec3.set(_castVox_posA, posAX, posAY, posAZ);
    quat.set(_castVox_quatA, quatAX, quatAY, quatAZ, quatAW);
    vec3.set(_castVox_scaleA, scaleAX, scaleAY, scaleAZ);
    vec3.set(_castVox_displacementA, displacementAX, displacementAY, displacementAZ);
    vec3.set(_castVox_posB, posBX, posBY, posBZ);
    quat.set(_castVox_quatB, quatBX, quatBY, quatBZ, quatBW);
    vec3.set(_castVox_scaleB, scaleBX, scaleBY, scaleBZ);

    // A-to-world
    const transformA = mat4.fromRotationTranslationScale(_castVox_AtoWorld, _castVox_quatA, _castVox_posA, _castVox_scaleA);

    // B-to-world (rotation + translation only, voxel shape)
    const targetTransform = mat4.fromRotationTranslation(_castVox_BtoWorld, _castVox_quatB, _castVox_posB);

    // castTransform = B^-1 * A (A's transform in B's local space)
    mat4.invert(_castVox_invBtoWorld, targetTransform);
    const castTransform = mat4.multiply(_castVox_AtoB, _castVox_invBtoWorld, transformA);

    // displacement in B's space
    mat4.multiply3x3Vec(_castVox_displacementInB, _castVox_invBtoWorld, _castVox_displacementA);

    // swept AABB of A at t=0 in B's space
    box3.transformMat4(_castVox_sweptAABB, shapeA.aabb, castTransform);

    // expand swept AABB to cover full sweep
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
                // chunk-skip
                const cx = vx >> CHUNK_BITS;
                const cy = vy >> CHUNK_BITS;
                const cz = vz >> CHUNK_BITS;
                const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
                if (!chunk || chunk.nonAirCount === 0) continue;

                const lx = vx - (cx << CHUNK_BITS);
                const ly = vy - (cy << CHUNK_BITS);
                const lz = vz - (cz << CHUNK_BITS);
                const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                const stateId = chunk.palette[paletteIdx]!;
                if (stateId === AIR || stateId === MISSING) continue;
                if (!(voxelShape.registry.flags[stateId]! & BLOCK_FLAG_COLLISION)) continue;

                const cid = registry.colliderId[stateId]!;
                const mt = registry.modelType[stateId]!;
                if (mt === MODEL_NONE && cid === 0) continue;

                if (cid === 0) {
                    // ── cube cast: castConvexVsConvexLocal ──────────

                    const hitIdx = pushCubeHit(vx, vy, vz, stateId);

                    vec3.set(_castVox_boxPos, vx + 0.5, vy + 0.5, vz + 0.5);

                    // castTransform for this specific voxel box:
                    // box is at _castVox_boxPos in voxel space (B), identity rotation
                    // we need A's transform relative to this box
                    // castTransformCube = boxInv * A_in_B
                    // since box has identity rotation, boxInv just translates by -boxPos
                    // so castTransformCube = translate(-boxPos) * castTransform
                    // i.e. same as castTransform but with translation offset
                    mat4.copy(_castVox_castTransformCube, castTransform);
                    _castVox_castTransformCube[12] -= _castVox_boxPos[0];
                    _castVox_castTransformCube[13] -= _castVox_boxPos[1];
                    _castVox_castTransformCube[14] -= _castVox_boxPos[2];

                    // displacement is the same (just a translation offset)
                    vec3.copy(_castVox_displacementInBox, _castVox_displacementInB);

                    // build the target transform (box → world)
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
                    // ── custom collider shape: delegate to crashcat ──

                    const colliderShape = registry.colliderShapes[cid]!;

                    // wrap the outer collector so emissions get their normal
                    // + supporting face captured into the hit buffer with
                    // subShapeIdB re-encoded as our hit index.
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

                    // collider shape is in block-local [0,1] space,
                    // positioned at voxel origin in world space
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

// ── getSurfaceNormal ────────────────────────────────────────────────
//
// decodes hit buffer index from subShapeId to get exact voxel coords,
// then computes the surface normal geometrically from query position.
// for cube voxels: closest face of the unit cube. for custom colliders:
// returns the surface normal captured into the hit buffer at emission
// time (penetrationAxis / -CastShapeHit.normal, normalized).

const _getSurfaceNormal_popResult = subShape.popResult();

function getSurfaceNormal(ioResult: SurfaceNormalResult, _shape: VoxelPhysicsShape, _subShapeId: number): void {
    // decode hit buffer index from subShapeId
    subShape.pop(_getSurfaceNormal_popResult, _subShapeId, HIT_BUFFER_BITS);
    const info = _hitPool[_getSurfaceNormal_popResult.value]!;

    if (info.cid === 0) {
        // cube or merged run: closest face of the box [v, m] using exact bounds from buffer
        const px = ioResult.position[0];
        const py = ioResult.position[1];
        const pz = ioResult.position[2];

        // distance to each face of the box
        const dEast = info.maxX - px;
        const dWest = px - info.minX;
        const dUp = info.maxY - py;
        const dDown = py - info.minY;
        const dSouth = info.maxZ - pz;
        const dNorth = pz - info.minZ;

        // find the closest face
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
        // custom collider, read the per-hit normal captured at the time
        // the inner shape's collide/cast emitted this contact.
        vec3.set(ioResult.normal, info.nx, info.ny, info.nz);
    }
}

// ── getSupportingFace ───────────────────────────────────────────────
//
// decodes hit buffer index from subShapeId to get exact voxel coords,
// then builds the supporting face. for cube voxels: picks the face
// most aligned with the query direction and builds a 4-vertex quad.
// for custom colliders: returns the supporting face captured into the
// hit buffer at emission time.

const _getSupportingFace_popResult = subShape.popResult();

function getSupportingFace(
    ioResult: SupportingFaceResult,
    direction: Vec3,
    _shape: VoxelPhysicsShape,
    _subShapeId: number,
): void {
    const face = ioResult.face;

    // decode hit buffer index from subShapeId
    subShape.pop(_getSupportingFace_popResult, _subShapeId, HIT_BUFFER_BITS);
    const info = _hitPool[_getSupportingFace_popResult.value]!;

    if (info.cid === 0) {
        // cube or merged run: pick face most aligned with direction, build the box quad
        // direction is in shape-local space (voxel coords), pointing INTO the surface
        const faceIdx = getFaceFromNormal(-direction[0], -direction[1], -direction[2]);
        buildBoxQuad(face, faceIdx, info.minX, info.minY, info.minZ, info.maxX, info.maxY, info.maxZ);
    } else {
        // custom collider, copy the per-hit face captured at emission time.
        const n = info.faceNumVerts;
        face.numVertices = n;
        for (let i = 0; i < n * 3; i++) {
            face.vertices[i] = info.faceVerts[i]!;
        }
    }

    transformFaceWithMat4RotationTranslation(face, ioResult.transform);
}

// ── defineShape + register ──────────────────────────────────────────

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
