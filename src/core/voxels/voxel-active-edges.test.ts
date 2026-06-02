import { beforeEach, describe, expect, it } from 'vitest';
import { type EdgeAxis, isCubeEdgeActive } from './voxel-active-edges';
import { buildTestRegistry, resetVoxelRegistry } from './test-helpers';
import { createChunk, createVoxels, setChunkBlock, type Voxels } from './voxels';

beforeEach(() => {
    resetVoxelRegistry();
});

// ── 4-cell pattern helper ───────────────────────────────────────────
//
// place cubes according to a 4-bit mask in the perpendicular plane of
// the edge anchored at (0, 0, 0). bits map to the same c00/c01/c10/c11
// names as the implementation:
//
//   axis=0 (edge along X): c{dy}{dz} → cube at (0, gy + dy, gz + dz)
//   axis=1 (edge along Y): c{dx}{dz} → cube at (gx + dx, 0, gz + dz)
//   axis=2 (edge along Z): c{dx}{dy} → cube at (gx + dx, gy + dy, 0)
//
// each dy/dz/dx index in {-1, 0} is encoded as 0 or 1 in the cell name.
// the bitmask (c00<<0) | (c01<<1) | (c10<<2) | (c11<<3) is used directly
// as the table lookup so we cover all 16 patterns.

function placeCubes(axis: EdgeAxis, mask: number): { voxels: Voxels; registry: ReturnType<typeof buildTestRegistry> } {
    const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);

    const edge = { gx: 4, gy: 4, gz: 4 };
    // map cell index 0..3 → (a, b) ∈ ({-1,0}, {-1,0})
    const cells: [number, number][] = [
        [-1, -1],
        [-1, 0],
        [0, -1],
        [0, 0],
    ];

    for (let i = 0; i < 4; i++) {
        if ((mask & (1 << i)) === 0) continue;
        const [a, b] = cells[i]!;
        let x: number;
        let y: number;
        let z: number;
        if (axis === 0) {
            x = edge.gx;
            y = edge.gy + a;
            z = edge.gz + b;
        } else if (axis === 1) {
            x = edge.gx + a;
            y = edge.gy;
            z = edge.gz + b;
        } else {
            x = edge.gx + a;
            y = edge.gy + b;
            z = edge.gz;
        }
        setChunkBlock(chunk, x, y, z, 'stone', registry);
    }

    return { voxels, registry };
}

// ── 16-pattern truth table ──────────────────────────────────────────
//
// expected[mask] for mask ∈ 0..15. mask bit i set ⇔ cell i is solid.
//   bit 0 = c00 (dy/dx=-1, dz=-1)
//   bit 1 = c01 (dy/dx=-1, dz=0)
//   bit 2 = c10 (dy/dx=0,  dz=-1)
//   bit 3 = c11 (dy/dx=0,  dz=0)
//
// rules:
//   0 cells  → false
//   1 cell   → true  (convex)
//   2 cells, face-shared (left/right col, top/bottom row) → false (coplanar)
//   2 cells, diagonal (c00+c11 or c01+c10)                → true  (saddle)
//   3 cells  → true  (concave)
//   4 cells  → false

const EXPECTED: boolean[] = [
    false, // 0000  count 0
    true, //  0001  count 1 (c00)
    true, //  0010  count 1 (c01)
    false, // 0011  count 2 face-shared (c00+c01) — left col when axis=0; same dy/dx so coplanar
    true, //  0100  count 1 (c10)
    false, // 0101  count 2 face-shared (c00+c10) — same dz/dz, opposite dy/dx → coplanar
    true, //  0110  count 2 diagonal (c01+c10)
    true, //  0111  count 3 (missing c11)
    true, //  1000  count 1 (c11)
    true, //  1001  count 2 diagonal (c00+c11)
    false, // 1010  count 2 face-shared (c01+c11)
    true, //  1011  count 3 (missing c10)
    false, // 1100  count 2 face-shared (c10+c11)
    true, //  1101  count 3 (missing c01)
    true, //  1110  count 3 (missing c00)
    false, // 1111  count 4
];

const AXES: EdgeAxis[] = [0, 1, 2];

describe('isCubeEdgeActive — 16-pattern truth table', () => {
    for (const axis of AXES) {
        for (let mask = 0; mask < 16; mask++) {
            const expected = EXPECTED[mask]!;
            it(`axis=${axis} mask=${mask.toString(2).padStart(4, '0')} → ${expected}`, () => {
                const { voxels, registry } = placeCubes(axis, mask);
                expect(isCubeEdgeActive(voxels, registry, axis, 4, 4, 4)).toBe(expected);
            });
        }
    }
});

// ── non-cube voxels treated as empty ────────────────────────────────

describe('isCubeEdgeActive — non-cube neighbours', () => {
    it('a half-slab (custom collider) in one of the 4 cells does not count as solid', () => {
        // a single cube at c11; the other three cells contain a custom-collider
        // block (an aabbs half-slab). classifier should treat the half-slab as
        // non-cube → count=1 (convex) → true.
        const slabShape: BlockShape = {
            type: 'aabbs',
            boxes: [[0, 0, 0, 1, 0.5, 1]],
        };
        const registry = buildTestRegistry([
            { id: 'stone', texId: 'stone' },
            { id: 'slab', texId: 'slab', shape: slabShape },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        // axis=2 (edge along Z) at corner (4, 4, 4); cells in XY plane.
        // c11 = (4, 4, 4) → cube. c00, c01, c10 → slabs.
        setChunkBlock(chunk, 4, 4, 4, 'stone', registry);
        setChunkBlock(chunk, 3, 3, 4, 'slab', registry);
        setChunkBlock(chunk, 3, 4, 4, 'slab', registry);
        setChunkBlock(chunk, 4, 3, 4, 'slab', registry);

        expect(isCubeEdgeActive(voxels, registry, 2, 4, 4, 4)).toBe(true);
    });

    it('a non-collision block in one of the 4 cells does not count as solid', () => {
        const registry = buildTestRegistry([
            { id: 'stone', texId: 'stone' },
            { id: 'glass', texId: 'glass', collision: false },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);

        // two solid cubes face-shared (would be inactive); replace one with glass.
        // count drops to 1 → active.
        setChunkBlock(chunk, 4, 4, 4, 'stone', registry); // c11
        setChunkBlock(chunk, 3, 4, 4, 'glass', registry); // c01 (axis=2)

        expect(isCubeEdgeActive(voxels, registry, 2, 4, 4, 4)).toBe(true);
    });
});
