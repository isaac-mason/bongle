import { getBlockState, type Voxels } from './voxels';

/**
 * read the screen tint at the camera position. writes the RGBA tint into
 * `out` and returns true if the camera sits inside a tinting block, false
 * otherwise (in which case `out` is left untouched, callers should fade
 * to clear when this returns false).
 *
 * for liquids (surfaceHeight < 1), the tint applies while the camera Y
 * sits within the cell's [y, y+h] band. eye above the band normally
 * returns false, but if the cell directly above is the same fluid
 * group, the gap is between two stacked liquid cells (the meniscus
 * inside a deep pool, where maxHeight < 1) and the tint stays on. this
 * is what keeps the tint stable as you sink through a column of liquid:
 * the tiny 1−maxHeight gap at the top of each cell no longer flickers
 * the tint off mid-traversal.
 */
export function getCameraTint(
    out: [number, number, number, number],
    voxels: Voxels,
    camX: number,
    camY: number,
    camZ: number,
): boolean {
    const x = Math.floor(camX);
    const y = Math.floor(camY);
    const z = Math.floor(camZ);
    const stateId = getBlockState(voxels, x, y, z);
    const registry = voxels.registry;
    const off = stateId * 4;
    const a = registry.screenTint[off + 3]!;
    if (a === 0) return false;
    const h = registry.surfaceHeight[stateId]!;
    if (h < 1 && camY - y > h) {
        // eye is in the air gap above this cell's liquid surface.
        // tint only persists if the cell above is the same fluid group
        // with non-zero fill, i.e. we're mid-column, not at the real
        // surface where air actually starts.
        const group = registry.fluidGroup[stateId]!;
        if (group === 0) return false;
        const aboveId = getBlockState(voxels, x, y + 1, z);
        if (registry.fluidGroup[aboveId]! !== group) return false;
        if (registry.surfaceHeight[aboveId]! <= 0) return false;
    }
    out[0] = registry.screenTint[off]!;
    out[1] = registry.screenTint[off + 1]!;
    out[2] = registry.screenTint[off + 2]!;
    out[3] = a;
    return true;
}
