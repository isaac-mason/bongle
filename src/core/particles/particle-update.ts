// curated motion vocabulary for particle update fns.
//
// Two layers, all sharing the `(pool, i, dt, voxels)` per-particle
// signature so they compose freely:
//
//   primitives  — gravity / drag / integrate / collideSlide / collideLand
//                 / collideBounce / collideDestroy. building blocks.
//   complete    — dust / smoke / spark / snow / rain. drop straight into
//                 `update:`, but also serve as readable examples for
//                 hand-rolling custom motion.
//
// engine handles natural death (`expiresAt <= now`) at compact time, so
// there's no `expireOnAge` primitive — motion fns just do motion and
// collision response. to kill from inside a fn (any non-age reason),
// write `pool.expiresAt[i] = 0`.
//
// the `collide*` primitives all do an Amanatides-Woo voxel-grid sweep
// from `prev*` to `pos*` (i.e. they're meant to run *after* `integrate`
// has stamped both fields), reading `voxels.registry.flags` for the
// `BLOCK_FLAG_COLLISION` check. cube blocks (colliderId 0) snap at the
// DDA face crossing; non-cube blocks (slabs/stairs/fences) delegate to
// a slab-method segment-vs-AABB pass against `shapeAabbs[colliderId]`,
// so a particle landing on a slab snaps to y=0.5, not the enclosing
// cell's y=1.0. cheaper than `castShape`, never enters the physics-body
// layer (rigid-body queries skip particles for free). motion fns that
// don't want collision simply omit the primitive.

import type { AABB } from '../voxels/block-collider';
import { BLOCK_FLAG_COLLISION } from '../voxels/block-registry';
import type { Voxels } from '../voxels/voxels';
import { getBlockState } from '../voxels/voxels';
import type { ParticlePool, UpdateFn } from './particles';

/* ── primitives ── */

/** apply gravity along Y. positive `g` = rises (e.g. smoke), negative
 *  `g` = falls (e.g. rain). units: world-units / s². */
function gravity(pool: ParticlePool, i: number, dt: number, g: number): void {
    pool.velY[i]! += g * dt;
}

/** velocity damping. `k` in `[0, 1]`. `k=1` → no drag, `k=0` → instant
 *  stop. applied per-axis to mimic air resistance. note: this is a
 *  per-frame multiplier (not a per-second coefficient), so framerate-
 *  dependent — fine for visual fx where exact decay rate is unimportant. */
function drag(pool: ParticlePool, i: number, dt: number, k: number): void {
    void dt;
    pool.velX[i]! *= k;
    pool.velY[i]! *= k;
    pool.velZ[i]! *= k;
}

/** advance position by velocity. writes `prev*` from current `pos*`
 *  first, then `pos* += vel* * dt`. the `collide*` primitives read the
 *  resulting `(prev, pos)` segment for their sweep. */
function integrate(pool: ParticlePool, i: number, dt: number): void {
    pool.prevX[i] = pool.posX[i]!;
    pool.prevY[i] = pool.posY[i]!;
    pool.prevZ[i] = pool.posZ[i]!;
    pool.posX[i]! += pool.velX[i]! * dt;
    pool.posY[i]! += pool.velY[i]! * dt;
    pool.posZ[i]! += pool.velZ[i]! * dt;
}

/** result of a voxel sweep — populated in-place to avoid per-call
 *  allocations in the tick loop. `axis` identifies which face the
 *  particle crossed (0=X, 1=Y, 2=Z); `t` is the segment parameter in
 *  `[0, 1]` of the contact. */
type Hit = { t: number; axis: 0 | 1 | 2 };
const HIT: Hit = { t: 0, axis: 0 };

/**
 * test segment vs every sub-AABB of a non-cube cell (block-local boxes
 * offset by the cell origin). writes the earliest in-range hit into
 * `HIT` and returns it, or `null` if every box misses.
 *
 * `tMin` is the inclusive lower bound on hit-t — for the start cell it's
 * `0` with the strict-`>` rule so a particle already overlapping an AABB
 * "escapes" rather than re-snapping at t=0 (mirrors the cube start-cell
 * skip). for DDA-stepped cells it's the cell-entry t with the inclusive
 * `>=` rule so the slab top is reachable when entered exactly on a face.
 *
 * slab-method intersection, inlined per axis. no per-call allocations;
 * the early-out structure tracks which axis governed `tNear` (= the face
 * the segment crossed first) so the caller's collide* primitive can
 * zero / reflect the right velocity component.
 */
function sweepAabbs(
    sx: number,
    sy: number,
    sz: number,
    dx: number,
    dy: number,
    dz: number,
    vx: number,
    vy: number,
    vz: number,
    boxes: AABB[],
    tMin: number,
    exclusive: boolean,
): Hit | null {
    let bestT = Number.POSITIVE_INFINITY;
    let bestAxis: 0 | 1 | 2 = 0;

    for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi]!;
        const minX = vx + b[0],
            minY = vy + b[1],
            minZ = vz + b[2];
        const maxX = vx + b[3],
            maxY = vy + b[4],
            maxZ = vz + b[5];

        let tNear = Number.NEGATIVE_INFINITY;
        let tFar = Number.POSITIVE_INFINITY;
        let axis: 0 | 1 | 2 = 0;

        // X slab
        if (dx === 0) {
            if (sx < minX || sx > maxX) continue;
        } else {
            const inv = 1 / dx;
            let t1 = (minX - sx) * inv;
            let t2 = (maxX - sx) * inv;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
                axis = 0;
            }
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) continue;
        }
        // Y slab
        if (dy === 0) {
            if (sy < minY || sy > maxY) continue;
        } else {
            const inv = 1 / dy;
            let t1 = (minY - sy) * inv;
            let t2 = (maxY - sy) * inv;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
                axis = 1;
            }
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) continue;
        }
        // Z slab
        if (dz === 0) {
            if (sz < minZ || sz > maxZ) continue;
        } else {
            const inv = 1 / dz;
            let t1 = (minZ - sz) * inv;
            let t2 = (maxZ - sz) * inv;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
                axis = 2;
            }
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) continue;
        }

        // tNear in segment range, respecting the start-cell escape rule
        if (exclusive ? tNear <= tMin : tNear < tMin) continue;
        if (tNear > 1) continue;
        if (tNear < bestT) {
            bestT = tNear;
            bestAxis = axis;
        }
    }

    if (bestT === Number.POSITIVE_INFINITY) return null;
    HIT.t = bestT;
    HIT.axis = bestAxis;
    return HIT;
}

/**
 * Amanatides-Woo voxel-grid sweep from `(sx, sy, sz)` to `(ex, ey, ez)`.
 * returns `HIT` (mutated) when the segment first enters a solid surface,
 * or `null` if it stays clear all the way to the end.
 *
 * cube blocks (colliderId === 0) take the fast path — hit at the DDA
 * face crossing. non-cube blocks (slabs/stairs/fences/etc.) read the
 * per-shape AABB list from `voxels.registry.shapeAabbs[colliderId]` and
 * delegate to `sweepAabbs` for a real slab-method intersection inside
 * the cell. matches the predicate the rigid-body / character-controller
 * narrow-phase uses, so a particle landing on a slab snaps to the slab
 * top (y=0.5) rather than the enclosing cell's top face (y=1.0).
 *
 * the starting cell is treated as free for cubes (escape rule for
 * particles spawned inside terrain) but still tested for sub-AABBs with
 * `t > 0` so a particle in an air pocket of a stair cell still sees the
 * stair's vertical face. inside-an-AABB at t=0 returns tNear ≤ 0 and is
 * excluded by the same rule — escape behavior preserved.
 *
 * single shared `HIT` is fine here: collide* primitives consume the
 * result before yielding control, no caller holds a ref across calls.
 */
function sweepSolid(voxels: Voxels, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): Hit | null {
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    if (dx === 0 && dy === 0 && dz === 0) return null;

    const registry = voxels.registry;
    let vx = Math.floor(sx);
    let vy = Math.floor(sy);
    let vz = Math.floor(sz);

    // start cell: sub-AABB-only (cube start cells are skipped — escape rule).
    {
        const stateId = getBlockState(voxels, vx, vy, vz);
        if ((registry.flags[stateId]! & BLOCK_FLAG_COLLISION) !== 0) {
            const cid = registry.colliderId[stateId]!;
            if (cid !== 0) {
                const hit = sweepAabbs(sx, sy, sz, dx, dy, dz, vx, vy, vz, registry.shapeAabbs[cid]!, 0, true);
                if (hit) return hit;
            }
        }
    }

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

    let tMaxX = stepX > 0 ? (vx + 1 - sx) / dx : stepX < 0 ? (vx - sx) / dx : Infinity;
    let tMaxY = stepY > 0 ? (vy + 1 - sy) / dy : stepY < 0 ? (vy - sy) / dy : Infinity;
    let tMaxZ = stepZ > 0 ? (vz + 1 - sz) / dz : stepZ < 0 ? (vz - sz) / dz : Infinity;

    let t = 0;
    let axis: 0 | 1 | 2 = 0;

    while (t <= 1) {
        if (tMaxX < tMaxY) {
            if (tMaxX < tMaxZ) {
                t = tMaxX;
                vx += stepX;
                axis = 0;
                tMaxX += tDeltaX;
            } else {
                t = tMaxZ;
                vz += stepZ;
                axis = 2;
                tMaxZ += tDeltaZ;
            }
        } else {
            if (tMaxY < tMaxZ) {
                t = tMaxY;
                vy += stepY;
                axis = 1;
                tMaxY += tDeltaY;
            } else {
                t = tMaxZ;
                vz += stepZ;
                axis = 2;
                tMaxZ += tDeltaZ;
            }
        }
        if (t > 1) return null;
        const stateId = getBlockState(voxels, vx, vy, vz);
        if ((registry.flags[stateId]! & BLOCK_FLAG_COLLISION) === 0) continue;
        const cid = registry.colliderId[stateId]!;
        if (cid === 0) {
            // cube fast path — snap at the DDA face crossing.
            HIT.t = t;
            HIT.axis = axis;
            return HIT;
        }
        // sub-AABB cell — segment-vs-AABB inside this cell. miss → keep stepping.
        const hit = sweepAabbs(sx, sy, sz, dx, dy, dz, vx, vy, vz, registry.shapeAabbs[cid]!, t, false);
        if (hit) return hit;
    }
    return null;
}

/** snap `pos*` back to the contact point along the swept segment.
 *  shared helper for the collide* primitives. */
function snapToHit(pool: ParticlePool, i: number, t: number): void {
    const px = pool.prevX[i]!;
    const py = pool.prevY[i]!;
    const pz = pool.prevZ[i]!;
    pool.posX[i] = px + (pool.posX[i]! - px) * t;
    pool.posY[i] = py + (pool.posY[i]! - py) * t;
    pool.posZ[i] = pz + (pool.posZ[i]! - pz) * t;
}

/** sweep prev→pos; on hit, snap to contact and zero the hit-axis
 *  velocity (other axes keep moving). good for "particles that slide
 *  along walls" — smoke, dust drifting against geometry. */
function collideSlide(pool: ParticlePool, i: number, _dt: number, voxels: Voxels): void {
    const hit = sweepSolid(voxels, pool.prevX[i]!, pool.prevY[i]!, pool.prevZ[i]!, pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!);
    if (!hit) return;
    snapToHit(pool, i, hit.t);
    if (hit.axis === 0) pool.velX[i] = 0;
    else if (hit.axis === 1) pool.velY[i] = 0;
    else pool.velZ[i] = 0;
}

/** sweep prev→pos; on hit, snap to contact and zero all velocity.
 *  good for "particles that settle in place" — snow landing, dust
 *  pooling on the ground. */
function collideLand(pool: ParticlePool, i: number, _dt: number, voxels: Voxels): void {
    const hit = sweepSolid(voxels, pool.prevX[i]!, pool.prevY[i]!, pool.prevZ[i]!, pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!);
    if (!hit) return;
    snapToHit(pool, i, hit.t);
    pool.velX[i] = 0;
    pool.velY[i] = 0;
    pool.velZ[i] = 0;
}

/** sweep prev→pos; on hit, snap to contact and reflect hit-axis velocity
 *  with damping `b` in `[0, 1]` (1 = perfectly elastic, 0 = stop on
 *  hit-axis). good for "particles that bounce" — sparks, debris. */
function collideBounce(pool: ParticlePool, i: number, _dt: number, voxels: Voxels, b: number): void {
    const hit = sweepSolid(voxels, pool.prevX[i]!, pool.prevY[i]!, pool.prevZ[i]!, pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!);
    if (!hit) return;
    snapToHit(pool, i, hit.t);
    if (hit.axis === 0) pool.velX[i] = -pool.velX[i]! * b;
    else if (hit.axis === 1) pool.velY[i] = -pool.velY[i]! * b;
    else pool.velZ[i] = -pool.velZ[i]! * b;
}

/** sweep prev→pos; on hit, kill the particle (`expiresAt[i] = 0`).
 *  good for "particles that die on contact" — rain splashing, projectile
 *  hit fx. */
function collideDestroy(pool: ParticlePool, i: number, _dt: number, voxels: Voxels): void {
    const hit = sweepSolid(voxels, pool.prevX[i]!, pool.prevY[i]!, pool.prevZ[i]!, pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!);
    if (!hit) return;
    snapToHit(pool, i, hit.t);
    pool.expiresAt[i] = 0;
}

/* ── tint primitives ── */

// the `(pool, i, dt, voxels)` signature carries no `now`, so these decay
// toward the target at a per-second `rate` (dt-correct, unlike `drag`'s
// per-frame multiplier) rather than keying off lifetime fraction. to
// reach the target exactly at death, pass `rate = 1 / lifetime`. for
// anything fancier (pulsing, color ramps) mutate `pool.tintR/G/B/A[i]`
// directly from a custom update fn.

/** linearly fade the RGB tint toward black at `rate` units/s, clamped at
 *  0. alpha untouched. pairs with a `lifetime` spawn opt: `rate =
 *  1 / lifetime` reaches black at death. */
function fadeRgb(pool: ParticlePool, i: number, dt: number, rate: number): void {
    const d = rate * dt;
    pool.tintR[i] = Math.max(0, pool.tintR[i]! - d);
    pool.tintG[i] = Math.max(0, pool.tintG[i]! - d);
    pool.tintB[i] = Math.max(0, pool.tintB[i]! - d);
}

/** linearly fade the alpha tint toward transparent at `rate` units/s,
 *  clamped at 0. RGB untouched. `rate = 1 / lifetime` reaches fully
 *  transparent at death. */
function fadeAlpha(pool: ParticlePool, i: number, dt: number, rate: number): void {
    pool.tintA[i] = Math.max(0, pool.tintA[i]! - rate * dt);
}

/* ── curated complete update fns ── */

/** drift + drag, falls under gravity, slides along geometry. */
const dust: UpdateFn = (pool, i, dt, voxels) => {
    gravity(pool, i, dt, -20);
    drag(pool, i, dt, 0.92);
    integrate(pool, i, dt);
    collideSlide(pool, i, dt, voxels);
};

/** rises with light buoyancy, drags hard, slides along geometry. */
const smoke: UpdateFn = (pool, i, dt, voxels) => {
    gravity(pool, i, dt, 0.4);
    drag(pool, i, dt, 0.96);
    integrate(pool, i, dt);
    collideSlide(pool, i, dt, voxels);
};

/** heavy fall + light drag, bounces off geometry with 40% retention. */
const spark: UpdateFn = (pool, i, dt, voxels) => {
    gravity(pool, i, dt, -8);
    drag(pool, i, dt, 0.98);
    integrate(pool, i, dt);
    collideBounce(pool, i, dt, voxels, 0.4);
};

/** gentle fall + strong drag, lands on geometry (zero velocity on hit). */
const snow: UpdateFn = (pool, i, dt, voxels) => {
    gravity(pool, i, dt, -0.5);
    drag(pool, i, dt, 0.98);
    integrate(pool, i, dt);
    collideLand(pool, i, dt, voxels);
};

/** fast fall, no drag, dies on impact. */
const rain: UpdateFn = (pool, i, dt, voxels) => {
    gravity(pool, i, dt, -12);
    integrate(pool, i, dt);
    collideDestroy(pool, i, dt, voxels);
};

/** the curated motion vocabulary. drop a `particleUpdate.X` straight
 *  into `particle({ ..., update: particleUpdate.X })`, or compose the
 *  primitives into a custom fn. all share the `(pool, i, dt, voxels)`
 *  per-particle signature. */
export const particleUpdate = {
    gravity,
    drag,
    integrate,
    collideSlide,
    collideLand,
    collideBounce,
    collideDestroy,
    fadeRgb,
    fadeAlpha,

    dust,
    smoke,
    spark,
    snow,
    rain,
};
