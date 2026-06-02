// pure swept-AABB primitives. no engine deps.
//
// shared by the voxel pass, the body-AABB pass, and stair-step retry.
// the analytical TOI mirrors Minetest's `axisAlignedCollision` — Minkowski
// difference, per-axis closed-form, return the *colliding axis* so the
// caller can zero that velocity component and slide.

/** axis index of a hit. -1 = no hit. */
export const AXIS_NONE = -1;
export const AXIS_X = 0;
export const AXIS_Y = 1;
export const AXIS_Z = 2;

/** result of `sweepAabbVsAabb`. */
export type SweepResult = {
    /** time of impact in [0, 1] over the sweep. INFINITY if no contact. */
    toi: number;
    /** axis the moving box hit on. AXIS_NONE if no contact. */
    axis: number;
    /** sign of the normal on that axis (+1 or -1, in moving box's frame). 0 if no hit. */
    sign: number;
    /**
     * contact normal in world space, pointing from the surface toward the
     * moving box. for axis-aligned shapes this collapses to ±1 on one axis.
     */
    nX: number;
    nY: number;
    nZ: number;
    /**
     * physical penetration depth along the contact normal, in world units.
     * non-zero only for already-overlapping hits (toi < 0). callers use
     * this for depenetration: displacement[axis] = normal[axis] * overlapDepth.
     * required when motion on the hit axis is zero — scale-by-toi alone can't
     * eject the box in that case.
     */
    overlapDepth: number;
};

const _result: SweepResult = { toi: Infinity, axis: AXIS_NONE, sign: 0, nX: 0, nY: 0, nZ: 0, overlapDepth: 0 };

function _miss(r: SweepResult): SweepResult {
    r.toi = Infinity;
    r.axis = AXIS_NONE;
    r.sign = 0;
    r.nX = 0;
    r.nY = 0;
    r.nZ = 0;
    r.overlapDepth = 0;
    return r;
}

/**
 * minkowski-difference per-axis swept AABB.
 *
 * computes the time of impact when a moving AABB at center `mc`
 * with half-extents `mh` translates by `dx,dy,dz` and intersects a
 * static AABB given by [aMinX..aMaxZ].
 *
 * "minkowski difference" = expand the static box by `mh` on each side,
 * shrink the moving box to a point at `mc`. then we just sweep a point
 * against an inflated box.
 *
 * returns the colliding axis and TOI; the caller uses these to advance
 * P by `displacement * toi`, zero the velocity on that axis, and continue
 * the slide.
 *
 * `epsilon` is added to the inflated box so that boxes that are just
 * touching (coplanar) report contact. callers pass a small positive
 * value to avoid sticking, or 0 for strict separation tests.
 *
 * @param mcX moving box center X
 * @param mcY moving box center Y
 * @param mcZ moving box center Z
 * @param mhX moving box half-extent X
 * @param mhY moving box half-extent Y
 * @param mhZ moving box half-extent Z
 * @param dx  displacement X
 * @param dy  displacement Y
 * @param dz  displacement Z
 * @param aMinX  static box min X
 * @param aMinY  static box min Y
 * @param aMinZ  static box min Z
 * @param aMaxX  static box max X
 * @param aMaxY  static box max Y
 * @param aMaxZ  static box max Z
 * @param out   reused result; pass `null` to use the module-private one (not safe for nested calls)
 */
export function sweepAabbVsAabb(
    mcX: number,
    mcY: number,
    mcZ: number,
    mhX: number,
    mhY: number,
    mhZ: number,
    dx: number,
    dy: number,
    dz: number,
    aMinX: number,
    aMinY: number,
    aMinZ: number,
    aMaxX: number,
    aMaxY: number,
    aMaxZ: number,
    out: SweepResult | null = null,
): SweepResult {
    const r = out ?? _result;

    // inflated static box (minkowski sum). moving box collapses to a point at its center.
    const minX = aMinX - mhX;
    const minY = aMinY - mhY;
    const minZ = aMinZ - mhZ;
    const maxX = aMaxX + mhX;
    const maxY = aMaxY + mhY;
    const maxZ = aMaxZ + mhZ;

    // per-axis slab test. tEnter < 0 ⇒ that axis was entered in the past
    // (currently overlapping on this axis with motion still pushing in).
    // tEnter === -Infinity ⇒ axis has no motion AND char is currently inside
    // the slab — axis contributes no constraint (analogue of Minetest's
    // `if (speed.X) { ... }` skip). axes with no motion AND char outside
    // their slab cause an early no-hit return — char never enters that
    // slab so the box is unreachable.
    let tEnterX: number;
    let tExitX: number;
    let signX: number;
    if (dx > 0) {
        tEnterX = (minX - mcX) / dx;
        tExitX = (maxX - mcX) / dx;
        signX = -1;
    } else if (dx < 0) {
        tEnterX = (maxX - mcX) / dx;
        tExitX = (minX - mcX) / dx;
        signX = 1;
    } else {
        if (mcX <= minX || mcX >= maxX) {
            return _miss(r);
        }
        tEnterX = -Infinity;
        tExitX = Infinity;
        signX = 0;
    }

    let tEnterY: number;
    let tExitY: number;
    let signY: number;
    if (dy > 0) {
        tEnterY = (minY - mcY) / dy;
        tExitY = (maxY - mcY) / dy;
        signY = -1;
    } else if (dy < 0) {
        tEnterY = (maxY - mcY) / dy;
        tExitY = (minY - mcY) / dy;
        signY = 1;
    } else {
        if (mcY <= minY || mcY >= maxY) {
            return _miss(r);
        }
        tEnterY = -Infinity;
        tExitY = Infinity;
        signY = 0;
    }

    let tEnterZ: number;
    let tExitZ: number;
    let signZ: number;
    if (dz > 0) {
        tEnterZ = (minZ - mcZ) / dz;
        tExitZ = (maxZ - mcZ) / dz;
        signZ = -1;
    } else if (dz < 0) {
        tEnterZ = (maxZ - mcZ) / dz;
        tExitZ = (minZ - mcZ) / dz;
        signZ = 1;
    } else {
        if (mcZ <= minZ || mcZ >= maxZ) {
            return _miss(r);
        }
        tEnterZ = -Infinity;
        tExitZ = Infinity;
        signZ = 0;
    }

    // pick the axis with the latest tEnter — that's the limiting axis. only
    // consider axes with motion (sign !== 0); zero-motion axes contribute no
    // constraint and skipping them is the analogue of Minetest's per-axis
    // `if (speed.X) { ... }` guard. without this skip, a char flush against
    // a wall on Y after a head-bonk (vy=0) would have its Y axis claim a
    // collision against a sideways wall block and report a +Y normal.
    let tEnter = -Infinity;
    let axis = AXIS_NONE;
    let sign = 0;
    let axisSpeedAbs = 0;
    const TIE_EPS = 1e-9;

    const isHorizontalAxis = (a: number): boolean => a === AXIS_X || a === AXIS_Z;
    const shouldPreferOnTie = (candidateAxis: number, candidateSpeedAbs: number): boolean => {
        if (axis === AXIS_NONE) return true;

        const currentHorizontal = isHorizontalAxis(axis);
        const candidateHorizontal = isHorizontalAxis(candidateAxis);

        // intent-biased tie policy: on near-equal TOI, prefer horizontal
        // constraints over vertical so edge-cases don't get reclassified as
        // floor support while sliding along walls.
        if (candidateHorizontal !== currentHorizontal) {
            return candidateHorizontal;
        }

        // same family fallback: prefer stronger-motion axis.
        return candidateSpeedAbs > axisSpeedAbs;
    };

    if (signX !== 0) {
        tEnter = tEnterX;
        axis = AXIS_X;
        sign = signX;
        axisSpeedAbs = Math.abs(dx);
    }
    if (signY !== 0) {
        const dt = tEnterY - tEnter;
        if (
            axis === AXIS_NONE ||
            dt > TIE_EPS ||
            (Math.abs(dt) <= TIE_EPS && shouldPreferOnTie(AXIS_Y, Math.abs(dy)))
        ) {
            tEnter = tEnterY;
            axis = AXIS_Y;
            sign = signY;
            axisSpeedAbs = Math.abs(dy);
        }
    }
    if (signZ !== 0) {
        const dt = tEnterZ - tEnter;
        if (
            axis === AXIS_NONE ||
            dt > TIE_EPS ||
            (Math.abs(dt) <= TIE_EPS && shouldPreferOnTie(AXIS_Z, Math.abs(dz)))
        ) {
            tEnter = tEnterZ;
            axis = AXIS_Z;
            sign = signZ;
            axisSpeedAbs = Math.abs(dz);
        }
    }

    if (axis === AXIS_NONE) {
        // no axis with motion qualifies — char either fully separated on a
        // motion-free axis (caught above) or has no motion at all.
        return _miss(r);
    }

    // earliest exit across all axes (motion or otherwise).
    let tExit = tExitX;
    if (tExitY < tExit) tExit = tExitY;
    if (tExitZ < tExit) tExit = tExitZ;

    // separation: tEnter > tExit ⇒ slabs never overlap simultaneously.
    // tEnter > 1 ⇒ won't reach within this displacement.
    // tExit <= 0 ⇒ already exited (tunneled past) — don't pull char back in.
    if (tEnter > tExit || tEnter > 1 || tExit <= 0) {
        return _miss(r);
    }

    // already-overlapping (tEnter < 0): inner-margin direction gate (mirrors
    // Minetest's `inner_margin = max(-0.5 * static_size, -2)` cutoff).
    // penetration past the static's mid-line on the chosen axis means we
    // can't tell which side we entered from — depenetrating along this axis
    // would push us through to the wrong side. drop the contact instead;
    // some other axis (or some other box) will handle it.
    //
    // also record the penetration depth here so callers can depenetrate by
    // pushing along the contact normal directly, regardless of motion sign
    // (the scale-by-tEnter trick fails when motion on the hit axis is zero).
    let penetration = 0;
    if (tEnter < 0) {
        let staticSize: number;
        let speedAbs: number;
        if (axis === AXIS_X) {
            staticSize = aMaxX - aMinX;
            speedAbs = dx < 0 ? -dx : dx;
        } else if (axis === AXIS_Y) {
            staticSize = aMaxY - aMinY;
            speedAbs = dy < 0 ? -dy : dy;
        } else {
            staticSize = aMaxZ - aMinZ;
            speedAbs = dz < 0 ? -dz : dz;
        }
        penetration = -tEnter * speedAbs;
        const innerMarginSize = staticSize * 0.5 < 2.0 ? staticSize * 0.5 : 2.0;
        if (penetration > innerMarginSize) {
            return _miss(r);
        }
    }

    // perpendicular-overlap gate (mirrors Minetest's projected-overlap check
    // inside `axisAlignedCollision`). a legitimate face contact requires the
    // moving box, at time tEnter, to STRICTLY overlap the static on the two
    // non-hit axes. when overlap on a non-hit axis is exactly zero, we're
    // grazing an edge or corner of the static box, not its face — and the
    // chosen axis would incorrectly block tangential motion (the classic
    // "char walking along a floor seam catches on the next cell's vertical
    // edge" snag).
    //
    // use a tiny tolerance so coplanar-but-not-grazing contacts still emit.
    const PERP_EPS = 1e-6;
    const tHit = tEnter < 0 ? 0 : tEnter;
    if (axis !== AXIS_X) {
        const mAtX = mcX + dx * tHit;
        const overlapX = (mAtX + mhX < aMaxX ? mAtX + mhX : aMaxX) - (mAtX - mhX > aMinX ? mAtX - mhX : aMinX);
        if (overlapX <= PERP_EPS) return _miss(r);
    }
    if (axis !== AXIS_Y) {
        const mAtY = mcY + dy * tHit;
        const overlapY = (mAtY + mhY < aMaxY ? mAtY + mhY : aMaxY) - (mAtY - mhY > aMinY ? mAtY - mhY : aMinY);
        if (overlapY <= PERP_EPS) return _miss(r);
    }
    if (axis !== AXIS_Z) {
        const mAtZ = mcZ + dz * tHit;
        const overlapZ = (mAtZ + mhZ < aMaxZ ? mAtZ + mhZ : aMaxZ) - (mAtZ - mhZ > aMinZ ? mAtZ - mhZ : aMinZ);
        if (overlapZ <= PERP_EPS) return _miss(r);
    }

    // emit. tEnter ∈ (-innerMarginSize/speedAbs, 1] now: negative means
    // depenetration (caller moves char by `disp * tEnter` — backward); 0+
    // means forward TOI as usual.
    //
    // for overlap hits (tEnter < 0), derive the normal sign from relative
    // position to the static box center instead of velocity direction. the
    // slab-enter sign tracks which face we'd cross when moving forward, which
    // is correct for t>=0 TOI but can flip on overlaps and produce a wrong
    // up/down normal near wall+ceiling corners.
    if (tEnter < 0) {
        const cX = (aMinX + aMaxX) * 0.5;
        const cY = (aMinY + aMaxY) * 0.5;
        const cZ = (aMinZ + aMaxZ) * 0.5;
        if (axis === AXIS_X) {
            sign = mcX < cX ? -1 : 1;
        } else if (axis === AXIS_Y) {
            sign = mcY < cY ? -1 : 1;
        } else {
            sign = mcZ < cZ ? -1 : 1;
        }
    }

    r.toi = tEnter;
    r.axis = axis;
    r.sign = sign;
    r.nX = axis === AXIS_X ? sign : 0;
    r.nY = axis === AXIS_Y ? sign : 0;
    r.nZ = axis === AXIS_Z ? sign : 0;
    r.overlapDepth = penetration;
    return r;
}

/**
 * compute the swept envelope: the AABB enclosing the moving box at t=0
 * and t=1. used to pick the iteration / broadphase region.
 */
export function sweptBounds(
    mcX: number,
    mcY: number,
    mcZ: number,
    mhX: number,
    mhY: number,
    mhZ: number,
    dx: number,
    dy: number,
    dz: number,
    out: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): void {
    if (dx >= 0) {
        out.minX = mcX - mhX;
        out.maxX = mcX + mhX + dx;
    } else {
        out.minX = mcX - mhX + dx;
        out.maxX = mcX + mhX;
    }
    if (dy >= 0) {
        out.minY = mcY - mhY;
        out.maxY = mcY + mhY + dy;
    } else {
        out.minY = mcY - mhY + dy;
        out.maxY = mcY + mhY;
    }
    if (dz >= 0) {
        out.minZ = mcZ - mhZ;
        out.maxZ = mcZ + mhZ + dz;
    } else {
        out.minZ = mcZ - mhZ + dz;
        out.maxZ = mcZ + mhZ;
    }
}
