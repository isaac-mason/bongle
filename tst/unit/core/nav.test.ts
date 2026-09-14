import type { Vec3 } from 'math';
import { describe, expect, it } from 'vitest';
import * as nav from '../../../src/core/nav';

// floodFill only forwards `voxels` to `actions`, so the BFS can be exercised with a
// stub Actions over a synthetic grid, no Voxels world needed.
const noVoxels = null as unknown as Parameters<typeof nav.floodFill>[1];

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

/** the live cells of a Path, copied out — `cells` keeps pooled entries past `count`. */
const cellsOf = (p: nav.Path): Vec3[] => p.cells.slice(0, p.count).map((c) => [c[0]!, c[1]!, c[2]!]);

/** a Path holding exactly these cells, for feeding smoothPath. */
const pathOf = (cells: Vec3[]): nav.Path => ({ cells: cells.map((c) => [...c] as Vec3), count: cells.length });

/** the live cells of a fill, copied out — `flood.cells` keeps stale pool entries past `count`. */
const live = (f: nav.Flood): Vec3[] => f.cells.slice(0, f.count);

describe('nav.floodFill', () => {
    it('returns every reachable cell, with start first', () => {
        const cells = live(nav.floodFill(nav.createFlood(), noVoxels, [1, 1, 0], gridActions(3), 100));
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
        const cells = live(nav.floodFill(nav.createFlood(), noVoxels, [5, 5, 0], gridActions(10), 5));
        expect(cells.length).toBeGreaterThanOrEqual(5); // expanded cells + their frontier
        expect(cells.length).toBeLessThan(100); // did NOT flood the whole grid
        const uniq = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
        expect(uniq.size).toBe(cells.length); // still no revisits
    });

    it('never revisits a cell', () => {
        const cells = live(nav.floodFill(nav.createFlood(), noVoxels, [2, 2, 0], gridActions(5), 1000));
        const uniq = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
        expect(uniq.size).toBe(cells.length);
        expect(cells).toHaveLength(25); // full 5×5 grid, no duplicates
    });

    it('reuses its storage across fills without leaking the previous result', () => {
        const flood = nav.createFlood();
        nav.floodFill(flood, noVoxels, [2, 2, 0], gridActions(5), 1000);
        expect(flood.count).toBe(25);
        const grown = flood.cells.length;

        // a smaller fill must not read as the larger one: `count` shrinks, the pool does not
        nav.floodFill(flood, noVoxels, [0, 0, 0], gridActions(2), 1000);
        expect(flood.count).toBe(4); // full 2×2 grid
        expect(flood.cells.length).toBe(grown); // storage kept for reuse
        expect(live(flood)).toHaveLength(4); // and never read past `count`
    });
});

describe('nav.floodIndexOf / floodReached', () => {
    it('finds every cell the fill reached, and nothing it did not', () => {
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(3), 1000);
        expect(flood.count).toBe(9);

        for (let x = 0; x < 3; x++) {
            for (let y = 0; y < 3; y++) {
                const i = nav.floodIndexOf(flood, x, y, 0);
                expect(i).toBeGreaterThanOrEqual(0);
                expect(flood.cells[i]).toEqual([x, y, 0]); // the index really addresses that cell
            }
        }
        expect(nav.floodIndexOf(flood, 3, 0, 0)).toBe(-1); // off the grid
        expect(nav.floodReached(flood, 0, 0, 0)).toBe(true);
        expect(nav.floodReached(flood, -1, 0, 0)).toBe(false);
    });

    it('answers for negative coordinates', () => {
        // the spatial hash coerces through int32, so negatives must round-trip
        const shifted: nav.Actions = (_v, x, y, z, step) => {
            for (const [dx, dy] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ] as const) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= -3 && nx <= -1 && ny >= -3 && ny <= -1) step(nx, ny, z, 1);
            }
        };
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [-2, -2, 0], shifted, 1000);
        expect(nav.floodReached(flood, -1, -3, 0)).toBe(true);
        expect(nav.floodReached(flood, 0, 0, 0)).toBe(false);
    });

    it('two floods do not clobber each other, and A* does not disturb either', () => {
        // the whole reason a Flood owns its map: this was impossible on the shared A* table.
        const a = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(3), 1000);
        const b = nav.floodFill(nav.createFlood(), noVoxels, [7, 7, 0], gridActions(10), 1000);

        expect(nav.floodReached(a, 2, 2, 0)).toBe(true);
        expect(nav.floodReached(a, 7, 7, 0)).toBe(false); // b's world, not a's
        expect(nav.floodReached(b, 7, 7, 0)).toBe(true);

        nav.findPath(nav.createPath(), noVoxels, [0, 0, 0], [4, 4, 0], gridActions(5));
        expect(nav.floodReached(a, 2, 2, 0)).toBe(true); // still a's own answer
        expect(nav.floodReached(b, 9, 9, 0)).toBe(true);
    });

    it('survives a grow (re-insert must carry the cell indices)', () => {
        // 20×20 = 400 cells, well past the initial table capacity, so this rehashes repeatedly
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(20), 10000);
        expect(flood.count).toBe(400);
        for (let x = 0; x < 20; x += 7) {
            for (let y = 0; y < 20; y += 7) {
                const i = nav.floodIndexOf(flood, x, y, 0);
                expect(flood.cells[i]).toEqual([x, y, 0]);
            }
        }
    });
});

describe('nav.floodPath', () => {
    it('reconstructs a route the flood already found', () => {
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(5), 1000);
        const goal = flood.cells.findIndex((c, i) => i < flood.count && c[0] === 4 && c[1] === 4);
        expect(goal).toBeGreaterThan(0);

        const path = cellsOf(nav.floodPath(nav.createPath(), flood, goal));
        expect(path[0]).toEqual([0, 0, 0]); // start-first, like findPath
        expect(path[path.length - 1]).toEqual([4, 4, 0]);
        expect(path).toHaveLength(9); // BFS on a 4-connected grid is shortest: 8 steps

        // every step is a single grid move — a real walk, not a straight-line guess
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1]!;
            const b = path[i]!;
            expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])).toBe(1);
        }
    });

    it('is just the start for cells[0], and empty off the end', () => {
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [1, 1, 0], gridActions(3), 100);
        const out = nav.createPath();
        expect(cellsOf(nav.floodPath(out, flood, 0))).toEqual([[1, 1, 0]]);
        expect(nav.floodPath(out, flood, flood.count).count).toBe(0); // past `count`
        expect(nav.floodPath(out, flood, -1).count).toBe(0);
    });

    it('survives a later fill, and pools its cells across calls', () => {
        const a = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(4), 1000);
        const out = nav.createPath();
        expect(nav.floodPath(out, a, a.count - 1)).toBe(out); // filled in place
        const copy = cellsOf(out);

        // reconstruction walks `parent` only, never the shared visited table — so flooding
        // something else cannot invalidate a path already handed out.
        nav.floodFill(nav.createFlood(), noVoxels, [9, 9, 0], gridActions(20), 1000);
        expect(cellsOf(out)).toEqual(copy);
    });

    it('rewrites cells in place rather than allocating fresh ones', () => {
        // the whole reason `out` is a Path and not a Vec3[]: a second, shorter path must reuse
        // the same cell objects, and must not truncate the pool that makes that possible.
        const flood = nav.floodFill(nav.createFlood(), noVoxels, [0, 0, 0], gridActions(5), 1000);
        const out = nav.createPath();
        const far = nav.floodIndexOf(flood, 4, 4, 0);
        nav.floodPath(out, flood, far);
        const grown = out.cells.length;
        const pooled = new Set(out.cells); // the exact cell objects allocated so far

        nav.floodPath(out, flood, nav.floodIndexOf(flood, 1, 0, 0)); // much shorter
        expect(out.count).toBe(2);
        expect(out.cells.length).toBe(grown); // pool kept, not truncated
        // reversal swaps references, so a cell MOVES between calls — what must hold is that no
        // new one was minted: every live cell is an object the first call already allocated.
        for (let i = 0; i < out.count; i++) expect(pooled.has(out.cells[i]!)).toBe(true);
        expect(cellsOf(out)).toEqual([
            [0, 0, 0],
            [1, 0, 0],
        ]);
    });
});

describe('nav.findPath', () => {
    it('finds a shortest path over a successor function', () => {
        const out = nav.createPath();
        expect(nav.findPath(out, noVoxels, [0, 0, 0], [4, 4, 0], gridActions(5))).toBe(true);
        const path = cellsOf(out);
        expect(path[0]).toEqual([0, 0, 0]);
        expect(path[path.length - 1]).toEqual([4, 4, 0]);
        expect(path).toHaveLength(9); // 8 steps on a 4-connected grid → 9 cells
    });

    it('reports false and empties `out` when the goal is unreachable', () => {
        // goal off the grid: the successor never yields it, the open set drains.
        const out = nav.createPath();
        nav.findPath(out, noVoxels, [0, 0, 0], [4, 4, 0], gridActions(5)); // leave it non-empty
        expect(nav.findPath(out, noVoxels, [0, 0, 0], [9, 9, 0], gridActions(5), { maxIterations: 100 })).toBe(false);
        expect(out.count).toBe(0); // a stale route must not read as this one's answer
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
        const out = nav.smoothPath(nav.createPath(), noVoxels, pathOf(flat), () => true);
        expect(cellsOf(out)).toEqual([
            [0, 0, 0],
            [3, 0, 0],
        ]);
    });

    it('keeps every waypoint when nothing is line-of-sight', () => {
        const out = nav.smoothPath(nav.createPath(), noVoxels, pathOf(flat), () => false);
        expect(cellsOf(out)).toEqual(flat);
    });

    it('copies paths shorter than 3 through unchanged', () => {
        const two: Vec3[] = [
            [0, 0, 0],
            [1, 0, 0],
        ];
        const out = nav.smoothPath(nav.createPath(), noVoxels, pathOf(two), () => true);
        expect(cellsOf(out)).toEqual(two);
    });

    it('refuses to smooth a path into itself', () => {
        // reading and writing one Path at once would corrupt it mid-walk
        const p = pathOf(flat);
        expect(() => nav.smoothPath(p, noVoxels, p, () => true)).toThrow();
    });
});
