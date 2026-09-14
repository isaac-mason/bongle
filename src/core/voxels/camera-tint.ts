import { getBlockState, type Voxels } from './voxels';

/**
 * Writes the RGBA tint at the camera position into `out` and returns true when the camera sits inside a tinting block; `out` is left untouched on false, and callers should fade to clear.
 * For liquids (surfaceHeight < 1), an eye above the cell's [y, y+h] band still sees the tint when the cell above is the same fluid group with fill, so the tint doesn't flicker off crossing the meniscus between stacked liquid cells.
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
        // eye is in the air gap above this cell's liquid surface; tint only persists if the cell above is the
        // same fluid group with non-zero fill (mid-column, not the real surface where air actually starts).
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
