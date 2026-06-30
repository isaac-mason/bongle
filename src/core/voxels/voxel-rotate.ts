// voxel-rotate.ts, rotate a Voxels instance by an arbitrary quaternion,
// snapping to the nearest 90-degree orientation.
//
// pipeline (runtime, per call):
//   1. project the three basis vectors through q → integer 3×3 matrix R
//      (R describes the snapped cube rotation: identity, or one of 23 others)
//   2. look up R in CUBE_ROTATIONS → a sequence of single-axis 90° turns
//      (e.g. ['y', 'x']) that composes to R
//   3. walk all non-air voxels: remap position via R, rotate each block's
//      state by replaying the sequence through rotateBlockKey
//   4. shift so min-corner = (0,0,0), return a fresh Voxels
//
// the table is built once at module load, see CUBE_ROTATIONS below.
//
// no client imports, safe to use in core/ and server/ contexts.

import type { Quat, Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import type { RotAxis } from './block-orient';
import type { BlockRegistry } from './block-registry';
import { rotateBlockKey } from './block-transform';
import type { Voxels } from './voxels';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, createVoxels, setBlock } from './voxels';

// scratch vec3 for basis projection, avoids allocations in the hot path
const _scratch: Vec3 = [0, 0, 0];

// ── public api ────────────────────────────────────────────────────

/**
 * rotate voxels by the given quaternion, snapping to the nearest 90-degree
 * orientation. returns a fresh Voxels instance; the original is not mutated.
 * the returned voxels are shifted so the min-corner of the AABB sits at (0,0,0).
 *
 * per-block state (stair facing, fence connections, etc.) rotates by replaying
 * the snapped rotation as a sequence of 90° single-axis turns through each
 * block's `rotate` hook (or the prop-name convention fallback).
 */
export function rotateVoxelsByQuat(voxels: Voxels, q: Quat, registry: BlockRegistry): Voxels {
    // basis projection → integer rotation matrix columns
    _scratch[0] = 1;
    _scratch[1] = 0;
    _scratch[2] = 0;
    vec3.transformQuat(_scratch, _scratch, q);
    const rx0 = Math.round(_scratch[0]),
        rx1 = Math.round(_scratch[1]),
        rx2 = Math.round(_scratch[2]);

    _scratch[0] = 0;
    _scratch[1] = 1;
    _scratch[2] = 0;
    vec3.transformQuat(_scratch, _scratch, q);
    const ry0 = Math.round(_scratch[0]),
        ry1 = Math.round(_scratch[1]),
        ry2 = Math.round(_scratch[2]);

    _scratch[0] = 0;
    _scratch[1] = 0;
    _scratch[2] = 1;
    vec3.transformQuat(_scratch, _scratch, q);
    const rz0 = Math.round(_scratch[0]),
        rz1 = Math.round(_scratch[1]),
        rz2 = Math.round(_scratch[2]);

    // identity fast-path
    if (rx0 === 1 && rx1 === 0 && rx2 === 0 && ry0 === 0 && ry1 === 1 && ry2 === 0 && rz0 === 0 && rz1 === 0 && rz2 === 1) {
        return voxels;
    }

    const sequence = CUBE_ROTATIONS.get(matKey(rx0, rx1, rx2, ry0, ry1, ry2, rz0, rz1, rz2)) ?? [];

    // first pass: collect non-air voxels, remap positions, find AABB
    type Entry = { nx: number; ny: number; nz: number; key: string };
    const entries: Entry[] = [];
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;

    for (const chunk of voxels.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                    const key = chunk.paletteKeys[paletteIdx];
                    if (!key || key === BLOCK_AIR) continue;

                    const wx = chunk.wx + lx;
                    const wy = chunk.wy + ly;
                    const wz = chunk.wz + lz;

                    const nx = rx0 * wx + ry0 * wy + rz0 * wz;
                    const ny = rx1 * wx + ry1 * wy + rz1 * wz;
                    const nz = rx2 * wx + ry2 * wy + rz2 * wz;

                    if (nx < minX) minX = nx;
                    if (ny < minY) minY = ny;
                    if (nz < minZ) minZ = nz;

                    let rotatedKey = key;
                    for (const axis of sequence) {
                        rotatedKey = rotateBlockKey(rotatedKey, axis, true, registry);
                    }

                    entries.push({ nx, ny, nz, key: rotatedKey });
                }
            }
        }
    }

    if (entries.length === 0) return createVoxels(registry);

    // second pass: write into new Voxels, shifted so min-corner = (0,0,0)
    const out = createVoxels(registry);
    for (const { nx, ny, nz, key } of entries) {
        setBlock(out, nx - minX, ny - minY, nz - minZ, key);
    }
    return out;
}

// ── cube-rotation lookup table ────────────────────────────────────
//
// CUBE_ROTATIONS maps each of the 24 proper cube rotations to a sequence
// of 90°-CW single-axis turns that produces it. built once at module load.
//
// runtime cost is one Map.get per rotateVoxelsByQuat call.
//
// the table is generated, not hand-written: at module load we enumerate
// 4×4×4 combinations of (Y-turns, X-turns, Y-turns) and store the first
// one that yields each unique matrix. YXY covers all 24 cube rotations
// (a known property of the cube's rotation group). first match wins;
// later combinations producing the same matrix are skipped.

function matKey(
    a00: number,
    a10: number,
    a20: number,
    a01: number,
    a11: number,
    a21: number,
    a02: number,
    a12: number,
    a22: number,
): string {
    return `${a00},${a10},${a20},${a01},${a11},${a21},${a02},${a12},${a22}`;
}

// 90°-CW (looking down +axis) rotation matrices, columns = rotated basis vectors.
// derived to match the existing block-collider / blueprint convention:
//   R_Y_CW:  +X → -Z, +Y → +Y, +Z → +X
//   R_X_CW:  +X → +X, +Y → -Z, +Z → +Y
const R_Y_CW = [
    [0, 0, 1],
    [0, 1, 0],
    [-1, 0, 0],
];
const R_X_CW = [
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
];

function matmul(a: number[][], b: number[][]): number[][] {
    const out = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i]![j] += a[i]![k]! * b[k]![j]!;
    return out;
}

function powMat(r: number[][], n: number): number[][] {
    let out = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    for (let i = 0; i < n; i++) out = matmul(r, out);
    return out;
}

const CUBE_ROTATIONS: Map<string, readonly RotAxis[]> = (() => {
    const out = new Map<string, readonly RotAxis[]>();
    for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++)
            for (let c = 0; c < 4; c++) {
                const m = matmul(powMat(R_Y_CW, c), matmul(powMat(R_X_CW, b), powMat(R_Y_CW, a)));
                const key = matKey(
                    m[0]![0]!,
                    m[1]![0]!,
                    m[2]![0]!,
                    m[0]![1]!,
                    m[1]![1]!,
                    m[2]![1]!,
                    m[0]![2]!,
                    m[1]![2]!,
                    m[2]![2]!,
                );
                if (out.has(key)) continue;
                const seq: RotAxis[] = [];
                for (let i = 0; i < a; i++) seq.push('y');
                for (let i = 0; i < b; i++) seq.push('x');
                for (let i = 0; i < c; i++) seq.push('y');
                out.set(key, seq);
            }
    return out;
})();
