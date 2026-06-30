import type { Vec3 } from 'mathcat';
import { describe, expect, it } from 'vitest';
import * as nav from './nav';

// floodFill only forwards `voxels` to `actions`, so the BFS can be exercised with a
// stub Actions over a synthetic grid — no Voxels world needed.
const noVoxels = null as unknown as Parameters<typeof nav.floodFill>[0];

// 4-connected open grid in the z-plane, bounded to [0, n)².
const gridActions =
    (n: number): nav.Actions =>
    (_voxels, x, y, z, step) => {
        for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < n && ny >= 0 && ny < n) step(nx, ny, z, 1);
        }
    };

const has = (cells: readonly number[][], c: number[]): boolean =>
    cells.some((x) => x[0] === c[0] && x[1] === c[1] && x[2] === c[2]);

describe('nav.floodFill', () => {
    it('returns every reachable cell, with start first', () => {
        const cells = nav.floodFill(noVoxels, [1, 1, 0], gridActions(3), 100);
        expect(cells).toHaveLength(9); // full 3×3 grid
        expect(cells[0]).toEqual([1, 1, 0]); // start included, nearest-first
        for (const corner of [
            [0, 0, 0],
            [2, 0, 0],
            [0, 2, 0],
            [2, 2, 0],
        ]) {
            expect(has(cells, corner)).toBe(true);
        }
    });

    it('caps work at maxIterations', () => {
        // 5 expansions on a 10×10 grid: bounded, nowhere near flooding all 100 cells.
        const cells = nav.floodFill(noVoxels, [5, 5, 0], gridActions(10), 5);
        expect(cells.length).toBeGreaterThanOrEqual(5); // expanded cells + their frontier
        expect(cells.length).toBeLessThan(100); // did NOT flood the whole grid
        const uniq = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
        expect(uniq.size).toBe(cells.length); // still no revisits
    });

    it('never revisits a cell', () => {
        const cells = nav.floodFill(noVoxels, [2, 2, 0], gridActions(5), 1000);
        const uniq = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
        expect(uniq.size).toBe(cells.length);
        expect(cells).toHaveLength(25); // full 5×5 grid, no duplicates
    });
});

describe('nav.findPath', () => {
    it('finds a shortest path over a successor function', () => {
        const path = nav.findPath(noVoxels, [0, 0, 0], [4, 4, 0], gridActions(5));
        expect(path).not.toBeNull();
        expect(path![0]).toEqual([0, 0, 0]);
        expect(path![path!.length - 1]).toEqual([4, 4, 0]);
        expect(path).toHaveLength(9); // 8 steps on a 4-connected grid → 9 cells
    });

    it('returns null when the goal is unreachable', () => {
        // goal off the grid: the successor never yields it, the open set drains → null.
        const path = nav.findPath(noVoxels, [0, 0, 0], [9, 9, 0], gridActions(5), { maxIterations: 100 });
        expect(path).toBeNull();
    });
});

describe('nav.smoothPath', () => {
    // a flat path (no y-hops); shortcut stubbed (it ignores voxels here).
    const flat: Vec3[] = [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
    ];

    it('collapses to endpoints when every segment is line-of-sight', () => {
        const out = nav.smoothPath(noVoxels, flat, () => true);
        expect(out).toEqual([
            [0, 0, 0],
            [3, 0, 0],
        ]);
    });

    it('keeps every waypoint when nothing is line-of-sight', () => {
        const out = nav.smoothPath(noVoxels, flat, () => false);
        expect(out).toEqual(flat);
    });

    it('returns paths shorter than 3 untouched', () => {
        const two: Vec3[] = [
            [0, 0, 0],
            [1, 0, 0],
        ];
        expect(nav.smoothPath(noVoxels, two, () => true)).toBe(two);
    });
});
