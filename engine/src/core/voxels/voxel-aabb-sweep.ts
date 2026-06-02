// swept-AABB pass against the voxel grid.
//
// iterates every cell overlapping the moving box's swept envelope (one
// cell of slop on each axis to catch grazing cases). per occupied cell,
// dispatches on shapeKind:
//   - cube:  sweep against the unit cell box.
//   - aabbs: sweep against each sub-box translated to world space.
//
// returns the best (smallest TOI) hit, or false if none. the result
// carries the source coords + subAabbIndex so the controller can attribute
// ground / contacts back to a specific voxel for debug + ground velocity.

import {
    sweepAabbVsAabb,
    type SweepResult,
} from '../math/aabb-sweep';
import { BLOCK_FLAG_COLLISION, SHAPE_AABBS } from './block-registry';
import { AIR, MISSING } from './block-registry';
import {
    CHUNK_BITS,
    CHUNK_SIZE,
    chunkKey,
    voxelIndex,
    type Voxels,
} from './voxels';

/** result of a voxel sweep. mutated in place. */
export type VoxelSweepHit = {
    /** time of impact in [0, 1]. */
    toi: number;
    /** colliding axis (0=X, 1=Y, 2=Z) or -1 if no hit. dominant-axis hint. */
    axis: number;
    /** sign of normal on that axis (+1 or -1, in moving box's frame). */
    sign: number;
    /** contact normal (world space, unit length, axis-aligned). */
    normalX: number;
    normalY: number;
    normalZ: number;
    /** world voxel coords. */
    vx: number;
    vy: number;
    vz: number;
    /** global state id at that voxel. */
    stateId: number;
    /** sub-AABB index within the block's shapeAabbs[cid] list, or -1 for cube. */
    subAabbIndex: number;
    /** the world-space box that won (in case the caller needs the geometry). */
    boxMinX: number;
    boxMinY: number;
    boxMinZ: number;
    boxMaxX: number;
    boxMaxY: number;
    boxMaxZ: number;
    /** penetration depth along the contact normal; non-zero only when toi < 0. */
    overlapDepth: number;
};

export function createVoxelSweepHit(): VoxelSweepHit {
    return {
        toi: Infinity,
        axis: -1,
        sign: 0,
        normalX: 0,
        normalY: 0,
        normalZ: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        stateId: 0,
        subAabbIndex: -1,
        boxMinX: 0,
        boxMinY: 0,
        boxMinZ: 0,
        boxMaxX: 0,
        boxMaxY: 0,
        boxMaxZ: 0,
        overlapDepth: 0,
    };
}

const _scratch: SweepResult = { toi: Infinity, axis: -1, sign: 0, nX: 0, nY: 0, nZ: 0, overlapDepth: 0 };

/**
 * sweep an AABB through the voxel grid. used by VCC and any future
 * voxel-aware character controller.
 *
 * `out` is reset internally; on return, `out.axis === -1` iff no hit.
 */
export function sweepAabbVsVoxels(
    voxels: Voxels,
    mcX: number,
    mcY: number,
    mcZ: number,
    mhX: number,
    mhY: number,
    mhZ: number,
    dx: number,
    dy: number,
    dz: number,
    out: VoxelSweepHit,
): boolean {
    const reg = voxels.registry;

    // start with no hit. we'll only overwrite if we find something better.
    out.toi = Infinity;
    out.axis = -1;
    out.sign = 0;

    // swept envelope in world coords (entire path of the moving box).
    const minX = (dx >= 0 ? mcX - mhX : mcX - mhX + dx);
    const maxX = (dx >= 0 ? mcX + mhX + dx : mcX + mhX);
    const minY = (dy >= 0 ? mcY - mhY : mcY - mhY + dy);
    const maxY = (dy >= 0 ? mcY + mhY + dy : mcY + mhY);
    const minZ = (dz >= 0 ? mcZ - mhZ : mcZ - mhZ + dz);
    const maxZ = (dz >= 0 ? mcZ + mhZ + dz : mcZ + mhZ);

    // expand by one cell — catches blocks whose face is exactly at the
    // envelope boundary (grazing) without false negatives from float error.
    const ix0 = Math.floor(minX) - 1;
    const iy0 = Math.floor(minY) - 1;
    const iz0 = Math.floor(minZ) - 1;
    const ix1 = Math.floor(maxX) + 1;
    const iy1 = Math.floor(maxY) + 1;
    const iz1 = Math.floor(maxZ) + 1;

    // outer loop: chunks. inner: cells. skips empty chunks fast.
    const cx0 = ix0 >> CHUNK_BITS;
    const cy0 = iy0 >> CHUNK_BITS;
    const cz0 = iz0 >> CHUNK_BITS;
    const cx1 = ix1 >> CHUNK_BITS;
    const cy1 = iy1 >> CHUNK_BITS;
    const cz1 = iz1 >> CHUNK_BITS;

    let bestTOI = Infinity;

    for (let cz = cz0; cz <= cz1; cz++) {
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const chunk = voxels.chunks.get(chunkKey(cx, cy, cz));
                const cwx = cx << CHUNK_BITS;
                const cwy = cy << CHUNK_BITS;
                const cwz = cz << CHUNK_BITS;

                if (!chunk) {
                    // unknown territory: treat the whole chunk as one solid
                    // 16³ cell so bodies can't tunnel into unloaded space
                    // (Minetest's CONTENT_IGNORE rule). once the chunk
                    // streams in (full or empty), this branch is skipped.
                    sweepAabbVsAabb(
                        mcX, mcY, mcZ,
                        mhX, mhY, mhZ,
                        dx, dy, dz,
                        cwx, cwy, cwz,
                        cwx + CHUNK_SIZE, cwy + CHUNK_SIZE, cwz + CHUNK_SIZE,
                        _scratch,
                    );
                    if (_scratch.axis !== -1 && _scratch.toi < bestTOI) {
                        bestTOI = _scratch.toi;
                        out.toi = _scratch.toi;
                        out.axis = _scratch.axis;
                        out.sign = _scratch.sign;
                        out.normalX = _scratch.nX;
                        out.normalY = _scratch.nY;
                        out.normalZ = _scratch.nZ;
                        out.vx = cwx;
                        out.vy = cwy;
                        out.vz = cwz;
                        // AIR sentinel ⇒ neutral material defaults
                        // (friction=1, restitution=0) — same convention used
                        // for AABB-vs-AABB hits where no source block exists.
                        out.stateId = AIR;
                        out.subAabbIndex = -1;
                        out.boxMinX = cwx;
                        out.boxMinY = cwy;
                        out.boxMinZ = cwz;
                        out.boxMaxX = cwx + CHUNK_SIZE;
                        out.boxMaxY = cwy + CHUNK_SIZE;
                        out.boxMaxZ = cwz + CHUNK_SIZE;
                        out.overlapDepth = _scratch.overlapDepth;
                    }
                    continue;
                }
                if (chunk.aggregate === 0) continue; // known empty (all air)

                // cell range within this chunk.
                const lx0 = Math.max(ix0 - cwx, 0);
                const ly0 = Math.max(iy0 - cwy, 0);
                const lz0 = Math.max(iz0 - cwz, 0);
                const lx1 = Math.min(ix1 - cwx, CHUNK_SIZE - 1);
                const ly1 = Math.min(iy1 - cwy, CHUNK_SIZE - 1);
                const lz1 = Math.min(iz1 - cwz, CHUNK_SIZE - 1);

                for (let ly = ly0; ly <= ly1; ly++) {
                    for (let lz = lz0; lz <= lz1; lz++) {
                        for (let lx = lx0; lx <= lx1; lx++) {
                            const paletteIdx = chunk.data[voxelIndex(lx, ly, lz)]!;
                            const stateId = chunk.palette[paletteIdx]!;
                            if (stateId === AIR || stateId === MISSING) continue;

                            // skip non-colliding blocks (e.g. grass tufts, water)
                            if ((reg.flags[stateId]! & BLOCK_FLAG_COLLISION) === 0) continue;

                            const cid = reg.colliderId[stateId]!;
                            const wx = cwx + lx;
                            const wy = cwy + ly;
                            const wz = cwz + lz;

                            if (cid === 0) {
                                // cube fast path: unit cell box.
                                sweepAabbVsAabb(
                                    mcX, mcY, mcZ,
                                    mhX, mhY, mhZ,
                                    dx, dy, dz,
                                    wx, wy, wz,
                                    wx + 1, wy + 1, wz + 1,
                                    _scratch,
                                );
                                if (
                                    _scratch.axis !== -1 &&
                                    _scratch.toi < bestTOI
                                ) {
                                    bestTOI = _scratch.toi;
                                    out.toi = _scratch.toi;
                                    out.axis = _scratch.axis;
                                    out.sign = _scratch.sign;
                                    out.normalX = _scratch.nX;
                                    out.normalY = _scratch.nY;
                                    out.normalZ = _scratch.nZ;
                                    out.vx = wx;
                                    out.vy = wy;
                                    out.vz = wz;
                                    out.stateId = stateId;
                                    out.subAabbIndex = -1;
                                    out.boxMinX = wx;
                                    out.boxMinY = wy;
                                    out.boxMinZ = wz;
                                    out.boxMaxX = wx + 1;
                                    out.boxMaxY = wy + 1;
                                    out.boxMaxZ = wz + 1;
                                    out.overlapDepth = _scratch.overlapDepth;
                                }
                                continue;
                            }

                            const kind = reg.shapeKind[cid]!;

                            if (kind === SHAPE_AABBS) {
                                const boxes = reg.shapeAabbs[cid]!;
                                for (let bi = 0; bi < boxes.length; bi++) {
                                    const b = boxes[bi]!;
                                    const bMinX = wx + b[0];
                                    const bMinY = wy + b[1];
                                    const bMinZ = wz + b[2];
                                    const bMaxX = wx + b[3];
                                    const bMaxY = wy + b[4];
                                    const bMaxZ = wz + b[5];
                                    sweepAabbVsAabb(
                                        mcX, mcY, mcZ,
                                        mhX, mhY, mhZ,
                                        dx, dy, dz,
                                        bMinX, bMinY, bMinZ,
                                        bMaxX, bMaxY, bMaxZ,
                                        _scratch,
                                    );
                                    if (
                                        _scratch.axis !== -1 &&
                                        _scratch.toi < bestTOI
                                    ) {
                                        bestTOI = _scratch.toi;
                                        out.toi = _scratch.toi;
                                        out.axis = _scratch.axis;
                                        out.sign = _scratch.sign;
                                        out.normalX = _scratch.nX;
                                        out.normalY = _scratch.nY;
                                        out.normalZ = _scratch.nZ;
                                        out.vx = wx;
                                        out.vy = wy;
                                        out.vz = wz;
                                        out.stateId = stateId;
                                        out.subAabbIndex = bi;
                                        out.boxMinX = bMinX;
                                        out.boxMinY = bMinY;
                                        out.boxMinZ = bMinZ;
                                        out.boxMaxX = bMaxX;
                                        out.boxMaxY = bMaxY;
                                        out.boxMaxZ = bMaxZ;
                                        out.overlapDepth = _scratch.overlapDepth;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return out.axis !== -1;
}
