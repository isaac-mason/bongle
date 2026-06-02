// ── voxel active-edge classifier ────────────────────────────────────
//
// purpose: decide whether a grid-aligned edge between cube voxels is a
// real geometric feature or just a tessellation artifact of the voxel
// grid. coplanar cube faces sharing a grid seam should NOT produce
// active edge contacts; the kcc would otherwise see phantom snags as
// it walks across flat ground.
//
// scope: cube voxels only (collider id 0). non-cube solids — slopes,
// custom hulls — count as empty for this classifier. only cube-vs-cube
// continuity smooths an edge; any cube-vs-custom seam is a real
// geometric transition and stays active by construction.
//
// the classifier looks at the four voxel cells perpendicular to the
// edge. with axis = X the four cells are at (gx, gy + dy, gz + dz)
// for dy, dz ∈ {-1, 0}; the edge runs from (gx, gy, gz) to
// (gx + 1, gy, gz). axes Y and Z follow the same pattern.
//
// pattern truth table (count = solid-cube count of the four cells):
//   0  no exposed faces meet here              → false
//   1  convex outer corner                     → true
//   2  face-shared (two cells share a face,    → false
//      i.e. they form a flat coplanar pair)
//   2  diagonal (saddle / sharp ridge)         → true
//   3  concave 90° interior corner             → true
//   4  edge entirely interior                  → false

import { AIR, BLOCK_FLAG_COLLISION, type BlockRegistry, MISSING } from './block-registry';
import { getBlock, type Voxels } from './voxels';

function isSolidCube(voxels: Voxels, blocks: BlockRegistry, x: number, y: number, z: number): boolean {
    const stateId = getBlock(voxels, x, y, z);
    if (stateId === AIR || stateId === MISSING) return false;
    if (!(blocks.flags[stateId]! & BLOCK_FLAG_COLLISION)) return false;
    return blocks.colliderId[stateId] === 0;
}

export type EdgeAxis = 0 | 1 | 2;

export function isCubeEdgeActive(
    voxels: Voxels,
    blocks: BlockRegistry,
    axis: EdgeAxis,
    gx: number,
    gy: number,
    gz: number,
): boolean {
    let c00: boolean;
    let c01: boolean;
    let c10: boolean;
    let c11: boolean;

    if (axis === 0) {
        // edge runs along X. perpendicular plane is YZ.
        // c{dy}{dz}: dy = first index, dz = second index, both ∈ {-1, 0}.
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
