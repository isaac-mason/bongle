// voxel-model-collider — convert a VoxelModel into a crashcat shape.
//
// produces a static compound shape of axis-aligned boxes covering the
// non-air voxels. a greedy 3D merge (extend along x, then z, then y)
// collapses dense regions into one box instead of one-per-voxel — for
// a solid 16³ block that's 1 box instead of 4096.
//
// box positions are in the same model-local space as VoxelMeshTrait
// vertices (boundsMin..boundsMax shifted by -model.origin), so attaching
// the shape to a body sharing the trait's transform produces matching
// collision and visuals.

import * as crashcat from 'crashcat';
import type { Vec3 } from 'mathcat';
import { AIR, MISSING } from './block-registry';
import { CHUNK_SIZE, type Voxels, voxelIndex } from './voxels';
import type { VoxelModel } from './voxel-model';

/**
 * build a static compound shape for `model` — one axis-aligned box per
 * greedy-merged run of non-air voxels. positions are offset by -model.origin
 * so the resulting shape pivots around the model's origin.
 *
 * returns null when the model has no non-air voxels.
 */
export function createVoxelModelShape(model: VoxelModel): crashcat.Shape | null {
    if (model.voxelCount === 0) return null;

    const { voxels, boundsMin, dimensions, origin } = model;
    const dx = dimensions[0];
    const dy = dimensions[1];
    const dz = dimensions[2];

    // dense presence grid over the model's bounding box. 1 = non-air,
    // 0 = empty or already consumed by an emitted box.
    const grid = new Uint8Array(dx * dy * dz);
    fillPresence(voxels, boundsMin, dx, dy, dz, grid);

    type Child = crashcat.StaticCompoundShapeSettings['children'][number];
    const children: Child[] = [];

    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];
    const bx0 = boundsMin[0];
    const by0 = boundsMin[1];
    const bz0 = boundsMin[2];

    for (let y = 0; y < dy; y++) {
        for (let z = 0; z < dz; z++) {
            for (let x = 0; x < dx; x++) {
                if (grid[localIndex(x, y, z, dx, dz)] !== 1) continue;

                // extend along x
                let extX = 1;
                while (x + extX < dx && grid[localIndex(x + extX, y, z, dx, dz)] === 1) extX++;

                // extend along z — entire x-row at z+extZ must match
                let extZ = 1;
                zLoop: while (z + extZ < dz) {
                    for (let xx = 0; xx < extX; xx++) {
                        if (grid[localIndex(x + xx, y, z + extZ, dx, dz)] !== 1) break zLoop;
                    }
                    extZ++;
                }

                // extend along y — entire xz-slab at y+extY must match
                let extY = 1;
                yLoop: while (y + extY < dy) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            if (grid[localIndex(x + xx, y + extY, z + zz, dx, dz)] !== 1) break yLoop;
                        }
                    }
                    extY++;
                }

                // mark consumed
                for (let yy = 0; yy < extY; yy++) {
                    for (let zz = 0; zz < extZ; zz++) {
                        for (let xx = 0; xx < extX; xx++) {
                            grid[localIndex(x + xx, y + yy, z + zz, dx, dz)] = 0;
                        }
                    }
                }

                const hx = extX * 0.5;
                const hy = extY * 0.5;
                const hz = extZ * 0.5;
                const cx = bx0 + x + hx - ox;
                const cy = by0 + y + hy - oy;
                const cz = bz0 + z + hz - oz;
                children.push({
                    shape: crashcat.box.create({ halfExtents: [hx, hy, hz] }),
                    position: [cx, cy, cz],
                    quaternion: [0, 0, 0, 1],
                });
            }
        }
    }

    // single-box optimization: avoid the compound wrapper when one box
    // covered everything. matches block-collider's behavior for unit-box shapes.
    if (children.length === 1) {
        const c = children[0]!;
        if (c.position[0] === 0 && c.position[1] === 0 && c.position[2] === 0) return c.shape;
        return crashcat.transformed.create({
            shape: c.shape,
            position: c.position,
            quaternion: c.quaternion,
        });
    }
    return crashcat.staticCompound.create({ children });
}

// flat index inside the model's bounding box. YZX order matches voxelIndex
// so the inner x loop walks contiguous memory.
function localIndex(x: number, y: number, z: number, dx: number, dz: number): number {
    return (y * dz + z) * dx + x;
}

function fillPresence(voxels: Voxels, boundsMin: Vec3, dx: number, _dy: number, dz: number, out: Uint8Array): void {
    const bx0 = boundsMin[0];
    const by0 = boundsMin[1];
    const bz0 = boundsMin[2];
    for (const chunk of voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        const { wx, wy, wz, data, palette } = chunk;
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const stateId = palette[data[voxelIndex(x, y, z)]!]!;
                    if (stateId === AIR || stateId === MISSING) continue;
                    const lx = wx + x - bx0;
                    const ly = wy + y - by0;
                    const lz = wz + z - bz0;
                    out[(ly * dz + lz) * dx + lx] = 1;
                }
            }
        }
    }
}
