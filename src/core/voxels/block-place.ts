// world-axis convention (matches blueprint.ts / block-presets.ts): north = -Z, south = +Z, east = +X, west = -X, up = +Y, down = -Y.
import type { BlockPlaceCtx } from './blocks';

export type Facing4 = 'north' | 'east' | 'south' | 'west';
export type Facing6 = Facing4 | 'up' | 'down';
export type Axis = 'x' | 'y' | 'z';

/** clockwise step index per cardinal (north=0, east=1, south=2, west=3). */
export const FACING4_STEPS: Record<Facing4, number> = { north: 0, east: 1, south: 2, west: 3 };
export const FACING4_ORDER: readonly Facing4[] = ['north', 'east', 'south', 'west'];

/** dominant axis of the hit normal (logs, pillars). */
export function axisFromPlaceCtx(ctx: BlockPlaceCtx): Axis {
    const ax = Math.abs(ctx.normalX);
    const ay = Math.abs(ctx.normalY);
    const az = Math.abs(ctx.normalZ);
    if (ay >= ax && ay >= az) return 'y';
    if (ax >= az) return 'x';
    return 'z';
}

/** 6-dir facing from the hit normal, block points away from the clicked
 *  surface (pistons, observers). */
export function facing6FromPlaceCtx(ctx: BlockPlaceCtx): Facing6 {
    const ax = Math.abs(ctx.normalX);
    const ay = Math.abs(ctx.normalY);
    const az = Math.abs(ctx.normalZ);
    if (ay >= ax && ay >= az) return ctx.normalY >= 0 ? 'up' : 'down';
    if (ax >= az) return ctx.normalX >= 0 ? 'east' : 'west';
    return ctx.normalZ >= 0 ? 'south' : 'north';
}

/** 4-dir facing toward the placer: wall click resolves to the opposite of the clicked face (hit-normal direction); floor/ceiling click uses camera yaw. Ladders, stairs, doors, signs. */
export function facing4FromPlaceCtx(ctx: BlockPlaceCtx): Facing4 {
    const ax = Math.abs(ctx.normalX);
    const ay = Math.abs(ctx.normalY);
    const az = Math.abs(ctx.normalZ);
    if (ax >= ay || az >= ay) {
        if (ax >= az) return ctx.normalX >= 0 ? 'east' : 'west';
        return ctx.normalZ >= 0 ? 'south' : 'north';
    }
    const fx = Math.sin(ctx.yaw);
    const fz = Math.cos(ctx.yaw);
    if (Math.abs(fx) >= Math.abs(fz)) return fx >= 0 ? 'east' : 'west';
    return fz >= 0 ? 'south' : 'north';
}

/** top/bottom half for slab/stair/trapdoor/door: a top-face click resolves to the bottom of the cell above, a bottom-face click to top, and a wall click to whichever half was clicked. */
export function halfFromPlaceCtx(ctx: BlockPlaceCtx): 'bottom' | 'top' {
    if (ctx.normalY > 0.5) return 'bottom';
    if (ctx.normalY < -0.5) return 'top';
    return ctx.hitY < 0.5 ? 'bottom' : 'top';
}

// cw=true matches the position rotation used by rotateVoxelsByQuat / Blueprint.rotateAxis: under axis='y',
// +X -> -Z, i.e. east(+X) -> north(-Z) -> west(-X) -> south(+Z).
const FACING4_ROT_Y_CW: Record<Facing4, Facing4> = {
    east: 'north',
    north: 'west',
    west: 'south',
    south: 'east',
};
const FACING4_ROT_Y_CCW: Record<Facing4, Facing4> = {
    north: 'east',
    east: 'south',
    south: 'west',
    west: 'north',
};
// raw tables exported for presets whose flip hooks branch on axis directly;
// new code should prefer flipFacing4().
export const FACING4_FLIP_X: Record<Facing4, Facing4> = {
    east: 'west',
    west: 'east',
    north: 'north',
    south: 'south',
};
export const FACING4_FLIP_Z: Record<Facing4, Facing4> = {
    north: 'south',
    south: 'north',
    east: 'east',
    west: 'west',
};

/** rotate a cardinal 90 degrees around Y. cw = looking down +Y. */
export function rotateFacing4(f: Facing4, cw: boolean): Facing4 {
    return (cw ? FACING4_ROT_Y_CW : FACING4_ROT_Y_CCW)[f];
}

/** mirror a cardinal across the plane perpendicular to `axis`. a Y flip is
 *  identity for a horizontal facing. */
export function flipFacing4(f: Facing4, axis: Axis): Facing4 {
    if (axis === 'x') return FACING4_FLIP_X[f];
    if (axis === 'z') return FACING4_FLIP_Z[f];
    return f;
}
