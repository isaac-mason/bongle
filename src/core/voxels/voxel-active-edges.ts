import { AIR, BLOCK_FLAG_COLLISION, type Blocks, MISSING } from './block-registry';
import { getBlockState, type Voxels } from './voxels';

function isSolidCube(voxels: Voxels, blocks: Blocks, x: number, y: number, z: number): boolean {
    const stateId = getBlockState(voxels, x, y, z);
    if (stateId === AIR || stateId === MISSING) return false;
    if (!(blocks.flags[stateId]! & BLOCK_FLAG_COLLISION)) return false;
    return blocks.colliderId[stateId] === 0;
}

export type EdgeAxis = 0 | 1 | 2;

/**
 * Whether a grid-aligned edge between cube voxels (colliderId 0) is a real geometric feature or a coplanar
 * tessellation seam; seams must read inactive or the kcc sees phantom snags on flat ground. Any cube-vs-custom-shape edge stays active by construction.
 * By solid count of the four cells perpendicular to the edge: 0 or 4 -> false, 1 or 3 -> true, 2 -> true only when the solid pair is diagonal, not face-shared.
 */
export function isCubeEdgeActive(voxels: Voxels, blocks: Blocks, axis: EdgeAxis, gx: number, gy: number, gz: number): boolean {
    let c00: boolean;
    let c01: boolean;
    let c10: boolean;
    let c11: boolean;

    if (axis === 0) {
        // edge runs along X, perpendicular plane is YZ; c{dy}{dz} with dy, dz in {-1, 0}.
        c00 = isSolidCube(voxels, blocks, gx, gy - 1, gz - 1);
        c01 = isSolidCube(voxels, blocks, gx, gy - 1, gz);
        c10 = isSolidCube(voxels, blocks, gx, gy, gz - 1);
        c11 = isSolidCube(voxels, blocks, gx, gy, gz);
    } else if (axis === 1) {
        // edge runs along Y. perpendicular plane is XZ.
        c00 = isSolidCube(voxels, blocks, gx - 1, gy, gz - 1);
        c01 = isSolidCube(voxels, blocks, gx - 1, gy, gz);
        c10 = isSolidCube(voxels, blocks, gx, gy, gz - 1);
        c11 = isSolidCube(voxels, blocks, gx, gy, gz);
    } else {
        // edge runs along Z. perpendicular plane is XY.
        c00 = isSolidCube(voxels, blocks, gx - 1, gy - 1, gz);
        c01 = isSolidCube(voxels, blocks, gx - 1, gy, gz);
        c10 = isSolidCube(voxels, blocks, gx, gy - 1, gz);
        c11 = isSolidCube(voxels, blocks, gx, gy, gz);
    }

    const count = (c00 ? 1 : 0) + (c01 ? 1 : 0) + (c10 ? 1 : 0) + (c11 ? 1 : 0);

    if (count === 0 || count === 4) return false;
    if (count === 1 || count === 3) return true;
    // count === 2: diagonal pairs are saddles (active);
    // face-shared pairs are flat coplanar seams (inactive).
    return (c00 && c11) || (c01 && c10);
}
