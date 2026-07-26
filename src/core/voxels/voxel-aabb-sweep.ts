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

import { type SweepResult, sweepAabbVsAabb } from '../physics/aabb/aabb-sweep';
import { AIR, type Blocks, BLOCK_FLAG_COLLISION, MISSING, SHAPE_AABBS } from './block-registry';
import { CHUNK_BITS, CHUNK_SIZE, chunkKey, type Voxels, voxelIndex } from './voxels';

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
    /** the passable (non-colliding) cells the box swept through this call, when
     *  the sweep was asked to `collect` them; empty otherwise. pooled: the caller
     *  resets `crossed.count` before a fresh sweep (or sequence of segment
     *  sweeps), the sweep only appends. see {@link CrossedVoxels}. */
    crossed: CrossedVoxels;
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
        crossed: createCrossedVoxels(),
    };
}

const _scratch: SweepResult = { toi: Infinity, axis: -1, sign: 0, nX: 0, nY: 0, nZ: 0, overlapDepth: 0 };

/**
 * sweep an AABB through the voxel grid. used by VCC and any future
 * voxel-aware character controller.
 *
 * the nearest-solid-hit fields of `out` are reset internally; on return,
 * `out.axis === -1` iff no hit.
 *
 * when `collect` is true, the passable (non-colliding) cells the box sweeps
 * through are appended to `out.crossed` (liquid / trigger detection). the hit
 * fields reset each call but `out.crossed` does NOT, so a caller doing a
 * sequence of segment sweeps unions them, and resets `out.crossed.count` itself
 * before the sequence. when `collect` is false, `out.crossed` is left untouched.
 */
export function sweepAabbVsVoxels(
    out: VoxelSweepHit,
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
    collect: boolean,
): boolean {
    const reg = voxels.registry;

    // start with no hit. we'll only overwrite if we find something better.
    out.toi = Infinity;
    out.axis = -1;
    out.sign = 0;

    // swept envelope in world coords (entire path of the moving box).
    const minX = dx >= 0 ? mcX - mhX : mcX - mhX + dx;
    const maxX = dx >= 0 ? mcX + mhX + dx : mcX + mhX;
    const minY = dy >= 0 ? mcY - mhY : mcY - mhY + dy;
    const maxY = dy >= 0 ? mcY + mhY + dy : mcY + mhY;
    const minZ = dz >= 0 ? mcZ - mhZ : mcZ - mhZ + dz;
    const maxZ = dz >= 0 ? mcZ + mhZ + dz : mcZ + mhZ;

    // expand by one cell, catches blocks whose face is exactly at the
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
                        mcX,
                        mcY,
                        mcZ,
                        mhX,
                        mhY,
                        mhZ,
                        dx,
                        dy,
                        dz,
                        cwx,
                        cwy,
                        cwz,
                        cwx + CHUNK_SIZE,
                        cwy + CHUNK_SIZE,
                        cwz + CHUNK_SIZE,
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
                        // (friction=1, restitution=0), same convention used
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
                if (chunk.nonAirCount === 0) continue; // known empty (all air)

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

                            const wx = cwx + lx;
                            const wy = cwy + ly;
                            const wz = cwz + lz;

                            // non-colliding blocks (grass tufts, water, lava) don't
                            // constrain the sweep. when collecting, record the ones the
                            // box actually penetrated (by more than PASSABLE_MARGIN),
                            // measured against the block's real shape.
                            if ((reg.flags[stateId]! & BLOCK_FLAG_COLLISION) === 0) {
                                if (collect) {
                                    const depth = sweptPassablePenetration(reg, stateId, mcX, mcY, mcZ, mhX, mhY, mhZ, dx, dy, dz, wx, wy, wz);
                                    if (depth > PASSABLE_MARGIN) pushCrossedVoxel(out.crossed, wx, wy, wz, stateId, depth);
                                }
                                continue;
                            }

                            const cid = reg.colliderId[stateId]!;

                            if (cid === 0) {
                                // cube fast path: unit cell box.
                                sweepAabbVsAabb(
                                    mcX,
                                    mcY,
                                    mcZ,
                                    mhX,
                                    mhY,
                                    mhZ,
                                    dx,
                                    dy,
                                    dz,
                                    wx,
                                    wy,
                                    wz,
                                    wx + 1,
                                    wy + 1,
                                    wz + 1,
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
                                        mcX,
                                        mcY,
                                        mcZ,
                                        mhX,
                                        mhY,
                                        mhZ,
                                        dx,
                                        dy,
                                        dz,
                                        bMinX,
                                        bMinY,
                                        bMinZ,
                                        bMaxX,
                                        bMaxY,
                                        bMaxZ,
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

// ── crossed-cell collection ──────────────────────────────────────────
//
// "which passable voxels did the box pass through", collected alongside the
// nearest solid hit in a single sweep when `collect` is set (see
// sweepAabbVsVoxels). a zero displacement enumerates the box's currently-
// occupied cells, so this covers standing-inside and passing-through alike
// (liquid / trigger detection: a resting character in lava and one falling
// through it both need the cell reported).
//
// the per-cell test deliberately does NOT reuse sweepAabbVsAabb: that is a
// face-contact TOI with grazing / inner-margin / no-motion-axis gates that
// reject a box resting in or buried inside a cell. this is a pure swept
// interval-overlap test at cell granularity: a cell counts if the moving box
// intersects its unit volume for any t in [0, 1].

/** one passable voxel the box actually penetrated. */
export type CrossedVoxel = {
    x: number;
    y: number;
    z: number;
    /** global state id at that voxel. */
    stateId: number;
    /** how far the box got INTO the block's shape (min-axis overlap, max over the
     *  swept path). always > {@link PASSABLE_MARGIN}: a grazing touch of a face,
     *  or passing through the empty part of a cell (above a liquid surface), does
     *  not produce a crossed voxel at all. */
    depth: number;
};

/** reusable collector held in {@link VoxelSweepHit.crossed}. `cells` grows only
 *  when a sweep crosses more cells than any prior call; iterate `cells[0..count)`. */
export type CrossedVoxels = {
    count: number;
    cells: CrossedVoxel[];
};

export function createCrossedVoxels(): CrossedVoxels {
    return { count: 0, cells: [] };
}

/** a box must get at least this far into a block's shape to count as crossed;
 *  filters zero-thickness face grazes and settle jitter. */
export const PASSABLE_MARGIN = 0.05;

function pushCrossedVoxel(out: CrossedVoxels, x: number, y: number, z: number, stateId: number, depth: number): void {
    let cell = out.cells[out.count];
    if (!cell) {
        cell = { x: 0, y: 0, z: 0, stateId: 0, depth: 0 };
        out.cells[out.count] = cell;
    }
    cell.x = x;
    cell.y = y;
    cell.z = z;
    cell.stateId = stateId;
    cell.depth = depth;
    out.count++;
}

/** min-axis overlap (MTV depth) of the box at sweep time `t` with the world-space
 *  shape box [s0..s1]; <= 0 when not overlapping on some axis. */
function penetrationAt(
    mcX: number, mcY: number, mcZ: number,
    mhX: number, mhY: number, mhZ: number,
    dx: number, dy: number, dz: number,
    s0x: number, s0y: number, s0z: number,
    s1x: number, s1y: number, s1z: number,
    t: number,
): number {
    const cx = mcX + dx * t;
    const cy = mcY + dy * t;
    const cz = mcZ + dz * t;
    const ovx = Math.min(cx + mhX, s1x) - Math.max(cx - mhX, s0x);
    const ovy = Math.min(cy + mhY, s1y) - Math.max(cy - mhY, s0y);
    const ovz = Math.min(cz + mhZ, s1z) - Math.max(cz - mhZ, s0z);
    return Math.min(ovx, ovy, ovz);
}

/** deepest the swept box gets INTO the world-space shape box [s0..s1] over the
 *  sweep, or 0 if it never overlaps within [0, 1]. finds the mutual-overlap window
 *  (minkowski slab test) then samples penetration at the window's midpoint
 *  (deepest for a pass-through) and its end (deepest for coming to rest inside). */
function sweptBoxPenetration(
    mcX: number, mcY: number, mcZ: number,
    mhX: number, mhY: number, mhZ: number,
    dx: number, dy: number, dz: number,
    s0x: number, s0y: number, s0z: number,
    s1x: number, s1y: number, s1z: number,
): number {
    let tEnter = -Infinity;
    let tExit = Infinity;

    const minX = s0x - mhX;
    const maxX = s1x + mhX;
    if (dx > 0) {
        const e = (minX - mcX) / dx;
        const x = (maxX - mcX) / dx;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (dx < 0) {
        const e = (maxX - mcX) / dx;
        const x = (minX - mcX) / dx;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (mcX <= minX || mcX >= maxX) {
        return 0;
    }

    const minY = s0y - mhY;
    const maxY = s1y + mhY;
    if (dy > 0) {
        const e = (minY - mcY) / dy;
        const x = (maxY - mcY) / dy;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (dy < 0) {
        const e = (maxY - mcY) / dy;
        const x = (minY - mcY) / dy;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (mcY <= minY || mcY >= maxY) {
        return 0;
    }

    const minZ = s0z - mhZ;
    const maxZ = s1z + mhZ;
    if (dz > 0) {
        const e = (minZ - mcZ) / dz;
        const x = (maxZ - mcZ) / dz;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (dz < 0) {
        const e = (maxZ - mcZ) / dz;
        const x = (minZ - mcZ) / dz;
        if (e > tEnter) tEnter = e;
        if (x < tExit) tExit = x;
    } else if (mcZ <= minZ || mcZ >= maxZ) {
        return 0;
    }

    if (tEnter > tExit || tEnter > 1 || tExit < 0) return 0;
    const t0 = tEnter < 0 ? 0 : tEnter;
    const t1 = tExit > 1 ? 1 : tExit;
    const mid = penetrationAt(mcX, mcY, mcZ, mhX, mhY, mhZ, dx, dy, dz, s0x, s0y, s0z, s1x, s1y, s1z, (t0 + t1) * 0.5);
    const end = penetrationAt(mcX, mcY, mcZ, mhX, mhY, mhZ, dx, dy, dz, s0x, s0y, s0z, s1x, s1y, s1z, t1);
    const depth = mid > end ? mid : end;
    return depth > 0 ? depth : 0;
}

/** deepest the swept box gets into the passable block at (wx,wy,wz), measured
 *  against its actual shape (unit cell for the cube fast path, else its
 *  `shapeAabbs`, e.g. a liquid's `[0..surfaceHeight]` band). 0 if it never
 *  meaningfully enters. */
function sweptPassablePenetration(
    reg: Blocks,
    stateId: number,
    mcX: number, mcY: number, mcZ: number,
    mhX: number, mhY: number, mhZ: number,
    dx: number, dy: number, dz: number,
    wx: number, wy: number, wz: number,
): number {
    const cid = reg.colliderId[stateId]!;
    if (cid === 0) {
        return sweptBoxPenetration(mcX, mcY, mcZ, mhX, mhY, mhZ, dx, dy, dz, wx, wy, wz, wx + 1, wy + 1, wz + 1);
    }
    const boxes = reg.shapeAabbs[cid]!;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        const d = sweptBoxPenetration(
            mcX, mcY, mcZ, mhX, mhY, mhZ, dx, dy, dz,
            wx + b[0], wy + b[1], wz + b[2], wx + b[3], wy + b[4], wz + b[5],
        );
        if (d > best) best = d;
    }
    return best;
}
