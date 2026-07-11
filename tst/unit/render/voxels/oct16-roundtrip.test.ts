// oct16 normal encode/decode round-trip. The encoder is chunk-mesher's JS
// `encodeOct16`; the decoder here is an exact JS mirror of the WGSL
// `decodeOct16` in voxel-material.ts — keep them in sync.
//
// Regression context: the WGSL decode originally had two bugs that this test
// exists to catch: (1) `sign(0) == 0` collapsed fold-boundary normals, and
// (2) the fold's ny term read the ALREADY-FOLDED nx (DSL expression inlined
// after the assign), so the −Z face normal decoded as (0, .707, −.707). That
// flipped the translucent sort's facing bit with camera elevation — water
// drawn over glass at full-height coincident interfaces, view-dependently.

import { describe, expect, it } from 'vitest';
import { encodeOct16 } from '../../../../src/core/voxels/chunk-mesher';

/** exact JS mirror of the (fixed) WGSL decodeOct16. */
function decodeOct16(packed: number): [number, number, number] {
    const u = ((packed & 0xff) / 255) * 2 - 1;
    const v = (((packed >> 8) & 0xff) / 255) * 2 - 1;
    let nx = u;
    let ny = v;
    const nz = 1 - Math.abs(u) - Math.abs(v);
    if (nz < 0) {
        const snzU = u >= 0 ? 1 : -1;
        const snzV = v >= 0 ? 1 : -1;
        // both folds read the PRE-fold values.
        const tx = (1 - Math.abs(ny)) * snzU;
        const ty = (1 - Math.abs(nx)) * snzV;
        nx = tx;
        ny = ty;
    }
    const lenInv = 1 / Math.max(1e-6, Math.sqrt(nx * nx + ny * ny + nz * nz));
    return [nx * lenInv, ny * lenInv, nz * lenInv];
}

function expectRoundTrip(nx: number, ny: number, nz: number, tolerance: number): void {
    const [dx, dy, dz] = decodeOct16(encodeOct16(nx, ny, nz));
    const dotp = dx * nx + dy * ny + dz * nz;
    // dot ≈ 1 ⇒ same direction within quantisation error.
    expect(
        dotp,
        `normal (${nx}, ${ny}, ${nz}) decoded as (${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)})`,
    ).toBeGreaterThan(1 - tolerance);
}

describe('oct16 normal round-trip (mesher encode ↔ shader decode)', () => {
    it('round-trips all 6 cardinal face normals exactly', () => {
        // the facing tie-break depends on these having the right SIGN; −Z is
        // the fold-boundary case that was broken.
        for (const n of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
        ] as const) {
            expectRoundTrip(n[0], n[1], n[2], 1e-4);
        }
    });

    it('round-trips fuzzed unit normals within quantisation error', () => {
        let s = 123456789 >>> 0;
        const rng = () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff;
        };
        for (let i = 0; i < 2000; i++) {
            const x = rng() * 2 - 1;
            const y = rng() * 2 - 1;
            const z = rng() * 2 - 1;
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len < 1e-3) continue;
            // 8-bit oct quantisation worst-case angular error is well under 1°;
            // allow dot > 1 − 5e-4 (~1.8°) for safety at fold seams.
            expectRoundTrip(x / len, y / len, z / len, 5e-4);
        }
    });

    it('round-trips z<0 hemisphere diagonals (the fold path)', () => {
        for (const n of [
            [0.5, 0.5, -Math.SQRT1_2],
            [-0.5, 0.5, -Math.SQRT1_2],
            [0.5, -0.5, -Math.SQRT1_2],
            [-0.5, -0.5, -Math.SQRT1_2],
            [0.9, 0.1, -0.42],
            [0.1, 0.9, -0.42],
        ] as const) {
            const len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
            expectRoundTrip(n[0] / len, n[1] / len, n[2] / len, 5e-4);
        }
    });
});
