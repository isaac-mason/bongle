import { castRayVsShape, createClosestCastRayCollector, createDefaultCastRaySettings } from 'crashcat';
import type { Blocks } from './block-registry';
import { AIR, MISSING } from './block-registry';
import { CHUNK_BITS, CHUNK_SIZE, chunkKey, type Voxels, voxelIndex } from './voxels';

export type VoxelRaycastResult = {
    hit: boolean;
    /** world-space hit point */
    px: number;
    py: number;
    pz: number;
    /** hit surface normal */
    nx: number;
    ny: number;
    nz: number;
    /** distance from ray origin */
    distance: number;
    /** integer world coords of the hit block */
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    /** global state id of the hit block */
    stateId: number;
    /**
     * for cubes: face index (0=east+x, 1=west-x, 2=up+y, 3=down-y, 4=south+z, 5=north-z).
     * for custom models: triangle index in the model's tris array.
     * -1 if no hit.
     */
    hitIndex: number;
};

export function createVoxelRaycastResult(): VoxelRaycastResult {
    return {
        hit: false,
        px: 0,
        py: 0,
        pz: 0,
        nx: 0,
        ny: 0,
        nz: 0,
        distance: 0,
        voxelX: 0,
        voxelY: 0,
        voxelZ: 0,
        stateId: 0,
        hitIndex: -1,
    };
}

// ── face index from DDA step ────────────────────────────────────────
//
// convention: 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y), 4=south(+z), 5=north(-z)
//
// when we step +x, we entered through the west (-x) face of the new voxel → face 1
// when we step -x, we entered through the east (+x) face → face 0
// etc.

function faceIndexFromStep(axis: number, step: number): number {
    // axis: 0=x, 1=y, 2=z
    // step: +1 or -1
    // face pairs: x→(0,1), y→(2,3), z→(4,5)
    // positive step enters through the negative face (odd index)
    // negative step enters through the positive face (even index)
    return axis * 2 + (step > 0 ? 1 : 0);
}

// face normals indexed by face index
const FACE_NX = [1, -1, 0, 0, 0, 0];
const FACE_NY = [0, 0, 1, -1, 0, 0];
const FACE_NZ = [0, 0, 0, 0, 1, -1];

// scratch for crashcat ray-vs-shape on custom collider shapes
const _rayCollector = createClosestCastRayCollector();
const _raySettings = createDefaultCastRaySettings();

/**
 * cast a ray through the voxel world using DDA.
 *
 * skips empty/missing chunks via nonAirCount. for cube blocks
 * (colliderId=0), the DDA step itself is the intersection test. for
 * custom collider shapes, tests against the prebuilt crashcat shape.
 *
 * @param out - result object (reused across calls, no allocation)
 * @param voxels - the voxel world
 * @param registry - block registry
 * @param ox, oy, oz - ray origin in world space
 * @param dx, dy, dz - normalized ray direction
 * @param maxDistance - maximum trace distance
 * @param requiredFlags - bitmask of block flags required for a hit. blocks missing any of these flags are skipped. 0 = no filtering.
 */
export function raycastVoxels(
    out: VoxelRaycastResult,
    voxels: Voxels,
    registry: Blocks,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    requiredFlags: number,
): VoxelRaycastResult {
    out.hit = false;

    // current voxel position (integer)
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    // step direction per axis
    const stepX = dx >= 0 ? 1 : -1;
    const stepY = dy >= 0 ? 1 : -1;
    const stepZ = dz >= 0 ? 1 : -1;

    // tDelta: distance along ray to cross one voxel on each axis
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : 1e30;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : 1e30;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : 1e30;

    // tMax: parametric distance to the next voxel boundary on each axis
    let tMaxX: number;
    let tMaxY: number;
    let tMaxZ: number;

    if (dx >= 0) {
        tMaxX = (Math.floor(ox) + 1 - ox) / dx;
    } else {
        tMaxX = (ox - Math.floor(ox)) / -dx;
    }
    if (dy >= 0) {
        tMaxY = (Math.floor(oy) + 1 - oy) / dy;
    } else {
        tMaxY = (oy - Math.floor(oy)) / -dy;
    }
    if (dz >= 0) {
        tMaxZ = (Math.floor(oz) + 1 - oz) / dz;
    } else {
        tMaxZ = (oz - Math.floor(oz)) / -dz;
    }

    // handle dx/dy/dz = 0: tMax should be +Infinity (never step on that axis)
    if (dx === 0) tMaxX = 1e30;
    if (dy === 0) tMaxY = 1e30;
    if (dz === 0) tMaxZ = 1e30;

    let distance = 0;
    let lastStepAxis = 0; // 0=x, 1=y, 2=z
    let lastStepDir = 1; // +1 or -1

    const { colliderId: colliderIdTable, colliderShapes } = registry;

    while (distance < maxDistance) {
        // chunk lookup
        const cx = x >> CHUNK_BITS;
        const cy = y >> CHUNK_BITS;
        const cz = z >> CHUNK_BITS;
        const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));

        // skip empty/missing chunks, advance to chunk exit boundary
        if (!chunk || chunk.nonAirCount === 0) {
            const chunkMinX = cx << CHUNK_BITS;
            const chunkMinY = cy << CHUNK_BITS;
            const chunkMinZ = cz << CHUNK_BITS;
            const chunkMaxX = chunkMinX + CHUNK_SIZE;
            const chunkMaxY = chunkMinY + CHUNK_SIZE;
            const chunkMaxZ = chunkMinZ + CHUNK_SIZE;

            let tExitX = 1e30;
            let tExitY = 1e30;
            let tExitZ = 1e30;

            if (dx > 0) {
                const t = (chunkMaxX - ox) / dx;
                if (t > distance) tExitX = t;
            } else if (dx < 0) {
                const t = (chunkMinX - ox) / dx;
                if (t > distance) tExitX = t;
            }

            if (dy > 0) {
                const t = (chunkMaxY - oy) / dy;
                if (t > distance) tExitY = t;
            } else if (dy < 0) {
                const t = (chunkMinY - oy) / dy;
                if (t > distance) tExitY = t;
            }

            if (dz > 0) {
                const t = (chunkMaxZ - oz) / dz;
                if (t > distance) tExitZ = t;
            } else if (dz < 0) {
                const t = (chunkMinZ - oz) / dz;
                if (t > distance) tExitZ = t;
            }

            const tExit = Math.min(tExitX, tExitY, tExitZ);

            if (tExit >= maxDistance || tExit >= 1e29) {
                return out;
            }

            // record the axis we crossed leaving the chunk so the next voxel's
            // face index is correct. without this, a ray that skips an empty
            // chunk and lands on a solid voxel reports a stale face from before
            // the skip (or the default 0/+1 if no prior step).
            if (tExitX <= tExitY && tExitX <= tExitZ) {
                lastStepAxis = 0;
                lastStepDir = stepX;
            } else if (tExitY <= tExitZ) {
                lastStepAxis = 1;
                lastStepDir = stepY;
            } else {
                lastStepAxis = 2;
                lastStepDir = stepZ;
            }

            // jump to chunk boundary
            const epsilon = 0.0001;
            const exitX = ox + dx * (tExit + epsilon);
            const exitY = oy + dy * (tExit + epsilon);
            const exitZ = oz + dz * (tExit + epsilon);

            x = Math.floor(exitX);
            y = Math.floor(exitY);
            z = Math.floor(exitZ);

            // recalculate tMax for new position
            if (dx !== 0) {
                tMaxX = dx >= 0 ? (x + 1 - ox) / dx : (ox - x) / -dx;
            }
            if (dy !== 0) {
                tMaxY = dy >= 0 ? (y + 1 - oy) / dy : (oy - y) / -dy;
            }
            if (dz !== 0) {
                tMaxZ = dz >= 0 ? (z + 1 - oz) / dz : (oz - z) / -dz;
            }

            distance = tExit;
            continue;
        }

        // read block state from chunk
        const lx = x - (cx << CHUNK_BITS);
        const ly = y - (cy << CHUNK_BITS);
        const lz = z - (cz << CHUNK_BITS);
        const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
        const stateId = chunk.palette[paletteIdx]!;

        if (stateId !== AIR && stateId !== MISSING && (registry.flags[stateId]! & requiredFlags) === requiredFlags) {
            const cid = colliderIdTable[stateId]!;

            if (cid === 0) {
                // cube fast path, DDA already gives us the hit
                const faceIdx = distance === 0 ? faceFromRayDirection(dx, dy, dz) : faceIndexFromStep(lastStepAxis, lastStepDir);

                out.hit = true;
                out.px = ox + dx * distance;
                out.py = oy + dy * distance;
                out.pz = oz + dz * distance;
                out.nx = FACE_NX[faceIdx]!;
                out.ny = FACE_NY[faceIdx]!;
                out.nz = FACE_NZ[faceIdx]!;
                out.distance = distance;
                out.voxelX = x;
                out.voxelY = y;
                out.voxelZ = z;
                out.stateId = stateId;
                out.hitIndex = faceIdx;
                return out;
            } else {
                // custom collider shape, use crashcat castRayVsShape
                const shape = colliderShapes[cid];

                // a stale state id, e.g. a chunk briefly resolved against a different
                // registry mid-HMR (block add), can index past the rebuilt shape table.
                // skip the cell rather than hand crashcat an undefined shape (it would
                // deref `.type` on undefined and crash the caller, e.g. the editor cursor).
                if (!shape) continue;

                // compute tMin/tMax for the ray segment within this voxel cell
                const tVoxelExit = Math.min(tMaxX, tMaxY, tMaxZ);
                const segStart = Math.max(0, distance);
                const segEnd = Math.min(tVoxelExit, maxDistance);
                const segLen = segEnd - segStart;
                if (segLen <= 0) continue;

                // ray origin offset to start of segment, in voxel-local space
                const localOx = ox + dx * segStart - x;
                const localOy = oy + dy * segStart - y;
                const localOz = oz + dz * segStart - z;

                _rayCollector.earlyOutFraction = 1.0;
                _rayCollector.hit.status = 0;
                _rayCollector.hit.fraction = 1.0;

                castRayVsShape(
                    _rayCollector,
                    _raySettings,
                    localOx,
                    localOy,
                    localOz,
                    dx,
                    dy,
                    dz,
                    segLen,
                    shape,
                    0,
                    0, // subShapeId, subShapeIdBits
                    0,
                    0,
                    0, // pos (shape at origin = voxel-local)
                    0,
                    0,
                    0,
                    1, // quat (identity)
                    1,
                    1,
                    1, // scale
                );

                if (_rayCollector.hit.status !== 0) {
                    const hitT = segStart + _rayCollector.hit.fraction * segLen;

                    out.hit = true;
                    out.px = ox + dx * hitT;
                    out.py = oy + dy * hitT;
                    out.pz = oz + dz * hitT;
                    // crashcat castRayVsShape doesn't give us the normal directly,
                    // so we approximate from the DDA step (same as cube path)
                    const faceIdx = hitT === 0 ? faceFromRayDirection(dx, dy, dz) : faceIndexFromStep(lastStepAxis, lastStepDir);
                    out.nx = FACE_NX[faceIdx]!;
                    out.ny = FACE_NY[faceIdx]!;
                    out.nz = FACE_NZ[faceIdx]!;
                    out.distance = hitT;
                    out.voxelX = x;
                    out.voxelY = y;
                    out.voxelZ = z;
                    out.stateId = stateId;
                    out.hitIndex = -1; // no meaningful tri index from crashcat
                    return out;
                }
                // ray passed through gaps in the shape, continue DDA
            }
        }

        // step to next voxel boundary
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
            x += stepX;
            distance = tMaxX;
            tMaxX += tDeltaX;
            lastStepAxis = 0;
            lastStepDir = stepX;
        } else if (tMaxY < tMaxZ) {
            y += stepY;
            distance = tMaxY;
            tMaxY += tDeltaY;
            lastStepAxis = 1;
            lastStepDir = stepY;
        } else {
            z += stepZ;
            distance = tMaxZ;
            tMaxZ += tDeltaZ;
            lastStepAxis = 2;
            lastStepDir = stepZ;
        }
    }

    return out;
}

/** derive face index when ray origin is inside the block (distance=0) */
function faceFromRayDirection(dx: number, dy: number, dz: number): number {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);

    if (ax >= ay && ax >= az) {
        // dominant x axis: ray going +x means we'd exit through east face,
        // so the "entry" face is west (1) for +x, east (0) for -x.
        // but for inside-block hits, we report the face the ray is pointing at:
        // +x → east (0), -x → west (1)
        return dx > 0 ? 0 : 1;
    }
    if (ay >= az) {
        return dy > 0 ? 2 : 3;
    }
    return dz > 0 ? 4 : 5;
}
