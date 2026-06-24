import { describe, expect, it } from 'vitest';
import * as voxelNav from './voxel-nav';

// floodFill only forwards `voxels` to `actions`, so the BFS can be exercised with a
// stub Actions over a synthetic grid — no Voxels world needed.
const noVoxels = null as unknown as Parameters<typeof voxelNav.floodFill>[0];

// 4-connected open grid in the z-plane, bounded to [0, n)².
const gridActions = (n: number): voxelNav.Actions => (_voxels, x, y, z) => {
    const steps: voxelNav.Step[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < n && ny >= 0 && ny < n) steps.push({ x: nx, y: ny, z, cost: 1 });
    }
    return steps;
};

const has = (cells: readonly number[][], c: number[]): boolean =>
    cells.some((x) => x[0] === c[0] && x[1] === c[1] && x[2] === c[2]);

describe('voxelNav.floodFill', () => {
    it('returns every reachable cell, with start first', () => {
        const cells = voxelNav.floodFill(noVoxels, [1, 1, 0], gridActions(3), 100);
        expect(cells).toHaveLength(9); // full 3×3 grid
        expect(cells[0]).toEqual([1, 1, 0]); // start included, nearest-first
        for (const corner of [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]]) {
            expect(has(cells, corner)).toBe(true);
        }
    });

    it('caps expansion at maxCells', () => {
        // interior start expands to its 4 neighbours, then the cap stops it: 1 + 4 = 5.
        const cells = voxelNav.floodFill(noVoxels, [5, 5, 0], gridActions(10), 5);
        expect(cells).toHaveLength(5);
        expect(cells.length).toBeLessThan(100); // did NOT flood the whole 10×10 grid
    });

    it('never revisits a cell', () => {
        const cells = voxelNav.floodFill(noVoxels, [2, 2, 0], gridActions(5), 1000);
        const uniq = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
        expect(uniq.size).toBe(cells.length);
        expect(cells).toHaveLength(25); // full 5×5 grid, no duplicates
    });
});
