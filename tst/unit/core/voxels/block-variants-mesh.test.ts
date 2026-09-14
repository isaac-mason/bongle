// ── per-position variants + jitter, at the mesher ────────────────────
//
// The registry-side tests cover declaration. These cover the properties that
// only exist once `meshChunk` runs, and that fail in ways tests are the only
// practical guard against: a variant keyed on anything but world position
// shimmers as chunks remesh, which is obvious in motion and invisible in a
// screenshot.

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tile } from '../../../../src/core/registry';
import * as blockModel from '../../../../src/core/voxels/block-model';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../../../src/core/voxels/chunk-mesher';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, setChunkBlock } from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

/** four visibly distinct rotations of one cross, as a variant list. */
const rotatingBlock = (id: string) => {
    const t = tile(`${id}:tex`, { src: 'v.png' });
    return {
        id,
        model: () =>
            [0, 1, 2, 3].map((r) => ({
                type: 'custom' as const,
                quads: blockModel.rotateY(blockModel.hash(t), r),
            })),
        cull: CullType.PARTIAL,
        collision: false,
        material: MaterialType.TRANSPARENT,
    };
};

const jitteringBlock = (id: string, jitter: { xz?: number; y?: number }) => {
    const t = tile(`${id}:tex`, { src: 'j.png' });
    return {
        id,
        model: () => ({ type: 'custom' as const, quads: blockModel.cross(t) }),
        cull: CullType.PARTIAL,
        collision: false,
        material: MaterialType.TRANSPARENT,
        jitter,
    };
};

/** mesh one chunk holding `id` at every listed chunk-local cell. */
function meshWith(reg: ReturnType<typeof buildTestRegistry>, cx: number, cy: number, cz: number, id: string, cells: [number, number, number][]) {
    const voxels = createVoxels(reg);
    const chunk = createChunk(cx, cy, cz);
    voxels.chunks.set(`${cx},${cy},${cz}`, chunk);
    for (const [x, y, z] of cells) setChunkBlock(voxels, chunk, x, y, z, id);
    return meshChunk(createMeshOutput(), buildMeshInput(voxels, cx, cy, cz), reg);
}

/** first vertex of the first transparent quad, decoded.
 *  12 u16 across 6 u32, low half first: word0 = x0 | y0<<16, word1 = z0 | x1<<16. */
function firstVert(result: ReturnType<typeof meshChunk>): { x: number; y: number; z: number } {
    const pass = result?.transparent;
    expect(pass, 'expected transparent geometry').toBeTruthy();
    const q = pass!.quads;
    return { x: q[0]! & 0xffff, y: q[0]! >>> 16, z: q[1]! & 0xffff };
}

/** the whole first vertex as a comparable key. */
const vertKey = (result: ReturnType<typeof meshChunk>): string => {
    const v = firstVert(result);
    return `${v.x},${v.y},${v.z}`;
};

describe('variant selection', () => {
    it('is stable across remeshes, so chunks do not shimmer', () => {
        const reg = buildTestRegistry([rotatingBlock('test:rot')]);
        const cells: [number, number, number][] = [[5, 5, 5]];
        const a = vertKey(meshWith(reg, 0, 0, 0, 'test:rot', cells));
        const b = vertKey(meshWith(reg, 0, 0, 0, 'test:rot', cells));
        expect(a).toBe(b);
    });

    it('is keyed on WORLD position, so the pattern does not repeat per chunk', () => {
        // identical chunk-local cell in two different chunks. keyed on local
        // coords these would be identical, which tiles visibly every 16 blocks.
        const reg = buildTestRegistry([rotatingBlock('test:rot')]);
        const cells: [number, number, number][] = [[5, 5, 5]];
        const seen = new Set<string>();
        for (const cx of [0, 1, 2, 3, 4, 5, 6, 7]) {
            seen.add(vertKey(meshWith(reg, cx, 0, 0, 'test:rot', cells)));
        }
        expect(seen.size).toBeGreaterThan(1);
    });

    it('actually varies within one chunk', () => {
        const reg = buildTestRegistry([rotatingBlock('test:rot')]);
        const seen = new Set<string>();
        for (let x = 0; x < 8; x++) {
            seen.add(vertKey(meshWith(reg, 0, 0, 0, 'test:rot', [[x, 5, 5]])));
        }
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe('jitter', () => {
    it('offsets geometry away from the cell origin', () => {
        const plain = buildTestRegistry([jitteringBlock('test:plain', {})]);
        const plainVert = vertKey(meshWith(plain, 0, 0, 0, 'test:plain', [[5, 5, 5]]));
        resetVoxelRegistry();
        const jit = buildTestRegistry([jitteringBlock('test:jit', { xz: 0.25 })]);
        const jitVert = vertKey(meshWith(jit, 0, 0, 0, 'test:jit', [[5, 5, 5]]));
        expect(jitVert).not.toBe(plainVert);
    });

    it('gives a vertical column ONE offset, so a stacked plant cannot tear', () => {
        // the jitter hash deliberately drops world Y. two cells in the same
        // column must land on the same horizontal offset.
        const reg = buildTestRegistry([jitteringBlock('test:col', { xz: 0.25 })]);
        const lower = firstVert(meshWith(reg, 0, 0, 0, 'test:col', [[5, 5, 5]]));
        const upper = firstVert(meshWith(reg, 0, 0, 0, 'test:col', [[5, 6, 5]]));
        // same column: identical horizontal offset, and exactly one block of y
        // between them. a y-sensitive jitter hash breaks the first two.
        expect(upper.x, 'x must not change up a column').toBe(lower.x);
        expect(upper.z, 'z must not change up a column').toBe(lower.z);
        expect(upper.y - lower.y, 'exactly one block apart').toBe(2048);
    });

    it('is absent when not asked for', () => {
        const reg = buildTestRegistry([jitteringBlock('test:none', {})]);
        const r = meshWith(reg, 0, 0, 0, 'test:none', [[5, 5, 5]]);
        expect(r?.transparent).toBeTruthy();
    });
});
