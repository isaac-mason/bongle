// voxel model, pure voxel data container.
//
// holds a Voxels grid plus derived bounds, dimensions, voxel count, and
// a default origin (center of the occupied bounding box). renderer-agnostic,
// VoxelMeshTrait references one for rendering, and the same data can drive
// crashcat shape factories, collision, etc.
//
// the underlying Voxels should not be mutated after construction,
// consumers (VoxelMeshVisuals) cache derived geometry keyed by VoxelModel
// identity and assume the data is immutable.

import type { Vec3 } from 'mathcat';
import { AIR, MISSING } from './block-registry';
import { CHUNK_SIZE, type Chunk, type Voxels, voxelIndex } from './voxels';

export class VoxelModel {
    // the source voxel data. treated as immutable after construction,
    // modifying it after creating the VoxelModel is undefined behavior.
    voxels: Voxels;

    // integer bounding box of occupied voxels (inclusive min, exclusive max).
    // e.g. a 3x3x3 cube at origin: boundsMin=[0,0,0], boundsMax=[3,3,3].
    boundsMin: Vec3;
    boundsMax: Vec3;

    // dimensions in voxels: boundsMax - boundsMin per axis.
    dimensions: Vec3;

    // total number of non-air voxels.
    voxelCount: number;

    // origin point (model-space pivot). when meshed for rendering, vertex
    // positions are offset by -origin so the model rotates/scales around
    // this point. defaults to the center of the bounding box.
    origin: Vec3;

    constructor(voxels: Voxels) {
        this.voxels = voxels;

        const { boundsMin, boundsMax, voxelCount } = scanBounds(voxels);
        this.boundsMin = boundsMin;
        this.boundsMax = boundsMax;
        this.voxelCount = voxelCount;
        this.dimensions = [boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2]];

        // default origin: center of bounding box
        this.origin = [(boundsMin[0] + boundsMax[0]) / 2, (boundsMin[1] + boundsMax[1]) / 2, (boundsMin[2] + boundsMax[2]) / 2];
    }
}

// ── internal: scan voxel bounds ─────────────────────────────────────

function scanBounds(voxels: Voxels): { boundsMin: Vec3; boundsMax: Vec3; voxelCount: number } {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let count = 0;

    for (const chunk of voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        scanChunkBounds(chunk, (wx, wy, wz) => {
            if (wx < minX) minX = wx;
            if (wy < minY) minY = wy;
            if (wz < minZ) minZ = wz;
            if (wx + 1 > maxX) maxX = wx + 1;
            if (wy + 1 > maxY) maxY = wy + 1;
            if (wz + 1 > maxZ) maxZ = wz + 1;
            count++;
        });
    }

    if (count === 0) {
        return { boundsMin: [0, 0, 0], boundsMax: [0, 0, 0], voxelCount: 0 };
    }

    return { boundsMin: [minX, minY, minZ], boundsMax: [maxX, maxY, maxZ], voxelCount: count };
}

function scanChunkBounds(chunk: Chunk, visit: (wx: number, wy: number, wz: number) => void): void {
    const { wx, wy, wz, data, palette } = chunk;
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const stateId = palette[data[voxelIndex(x, y, z)]!]!;
                if (stateId === AIR || stateId === MISSING) continue;
                visit(wx + x, wy + y, wz + z);
            }
        }
    }
}
