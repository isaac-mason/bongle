// sweepAabbVsVoxels(..., collect=true) records the passable cells the box
// actually PENETRATED (by more than PASSABLE_MARGIN) into out.crossed, measured
// against each block's real shape. used for liquid / trigger detection. key
// properties:
//   - measures against the block's shape (unit cell for a full cube, the
//     [0..surfaceHeight] band for a shallow liquid), so travelling through the
//     empty part of a cell reports nothing,
//   - a grazing touch of a face (below the margin) reports nothing,
//   - swept: a fast fall THROUGH a cell still reports (no tunneling),
//   - collect=false leaves out.crossed untouched (the hot collision path).

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestRegistry, defineTestBlock, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createVoxelSweepHit, sweepAabbVsVoxels, type VoxelSweepHit } from '../../../../src/core/voxels/voxel-aabb-sweep';
import { createVoxels, setBlock, type Voxels } from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});
beforeEach(() => {
    resetVoxelRegistry();
});

// character-ish box: 0.6 wide, 1.8 tall, feet-anchored (center = feet + 0.9).
const HX = 0.3;
const HY = 0.9;
const HZ = 0.3;

function crossed(out: VoxelSweepHit, x: number, y: number, z: number): boolean {
    for (let i = 0; i < out.crossed.count; i++) {
        const c = out.crossed.cells[i]!;
        if (c.x === x && c.y === y && c.z === z) return true;
    }
    return false;
}

/** voxels with one passable lava cell + one solid stone cell at the given spots. */
function world(lava: [number, number, number], stone?: [number, number, number], lavaHeight = 1): Voxels {
    const lavaBlock = defineTestBlock({
        id: 'lava',
        texId: 'white',
        collision: false,
        liquid: { viscosity: 1 },
        surfaceHeight: lavaHeight,
    });
    const stoneBlock = defineTestBlock({ id: 'stone', texId: 'white' });
    const blocks = buildTestRegistry([]); // reindex + return the registry
    const voxels = createVoxels(blocks);
    setBlock(voxels, lava[0], lava[1], lava[2], lavaBlock.defaultKey());
    if (stone) setBlock(voxels, stone[0], stone[1], stone[2], stoneBlock.defaultKey());
    return voxels;
}

/** sweep a feet-anchored box from `feet` by `disp`, collecting crossed cells. */
function sweep(voxels: Voxels, feet: [number, number, number], disp: [number, number, number]): VoxelSweepHit {
    const out = createVoxelSweepHit();
    out.crossed.count = 0;
    sweepAabbVsVoxels(out, voxels, feet[0], feet[1] + HY, feet[2], HX, HY, HZ, disp[0], disp[1], disp[2], true);
    return out;
}

describe('sweepAabbVsVoxels — crossed-cell collection', () => {
    it('standing deep in a full-cube lava reports it', () => {
        const voxels = world([0, 0, 0]);
        const out = sweep(voxels, [0.5, 0.2, 0.5], [0, 0, 0]); // feet 0.2 into cell y=0
        expect(crossed(out, 0, 0, 0)).toBe(true);
    });

    it('grazing the top face (within the margin) does NOT report', () => {
        const voxels = world([0, 0, 0]);
        // feet at 0.97: box bottom is only 0.03 below the cell top — under PASSABLE_MARGIN.
        expect(crossed(sweep(voxels, [0.5, 0.97, 0.5], [0, 0, 0]), 0, 0, 0)).toBe(false);
        // hovering fully above the block: also nothing.
        expect(crossed(sweep(voxels, [0.5, 1.2, 0.5], [0, 0, 0]), 0, 0, 0)).toBe(false);
    });

    it('a shallow liquid only reports below its surface, not in the empty band above', () => {
        const voxels = world([0, 0, 0], undefined, 0.5); // lava fills only [0, 0.5] of the cell
        // feet 0.6: box bottom is above the 0.5 surface → in the empty band → nothing.
        expect(crossed(sweep(voxels, [0.5, 0.6, 0.5], [0, 0, 0]), 0, 0, 0)).toBe(false);
        // feet 0.1: sunk below the surface → reported.
        expect(crossed(sweep(voxels, [0.5, 0.1, 0.5], [0, 0, 0]), 0, 0, 0)).toBe(true);
    });

    it('catches a cell the box passes THROUGH without resting in it (no tunneling)', () => {
        const voxels = world([0, 5, 0]);
        // start feet y=7 (box Y [7.0, 8.8]) -> end feet y=3 (box Y [3.0, 4.8]).
        // neither end overlaps lava cell y=5 ([5,6]); the swept path plunges through it.
        expect(crossed(sweep(voxels, [0.5, 7, 0.5], [0, -4, 0]), 0, 5, 0)).toBe(true);
    });

    it('does not report cells outside the swept path', () => {
        const voxels = world([0, 5, 3]); // off to the side in Z
        expect(crossed(sweep(voxels, [0.5, 7, 0.5], [0, -4, 0]), 0, 5, 3)).toBe(false);
    });

    it('collect=false leaves out.crossed untouched (hot collision path)', () => {
        const voxels = world([0, 0, 0]);
        const out = createVoxelSweepHit();
        out.crossed.count = 0;
        sweepAabbVsVoxels(out, voxels, 0.5, 0.2 + HY, 0.5, HX, HY, HZ, 0, 0, 0, false);
        expect(out.crossed.count).toBe(0);
    });

    it('only collects passable cells; solids never appear in crossed', () => {
        const voxels = world([0, 0, 0], [1, 0, 0]);
        const out = sweep(voxels, [0.5, 0.2, 0.5], [1, 0, 0]); // +x into the solid cell x=1
        expect(crossed(out, 0, 0, 0)).toBe(true); // passable lava
        expect(crossed(out, 1, 0, 0)).toBe(false); // solid stone is NOT in crossed
    });

    it('reports a real penetration depth', () => {
        const voxels = world([0, 0, 0]);
        const out = sweep(voxels, [0.5, 0.2, 0.5], [0, 0, 0]);
        expect(crossed(out, 0, 0, 0)).toBe(true);
        const cell = out.crossed.cells.find((c) => c.x === 0 && c.y === 0 && c.z === 0)!;
        // box is 0.6 wide inside a 1-wide cell → min-axis overlap 0.6.
        expect(cell.depth).toBeGreaterThan(0.5);
    });
});
