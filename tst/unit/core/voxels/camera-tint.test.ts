// ── getCameraTint tests ─────────────────────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCameraTint } from '../../../../src/core/voxels/camera-tint';
import { buildTestRegistry, resetVoxelRegistry, type TestBlockSpec } from '../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, setChunkBlock } from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

function buildRegistry(blocks: { id: string; def: Omit<TestBlockSpec, 'id' | 'texId'> }[]) {
    return buildTestRegistry(blocks.map((b) => ({ id: b.id, texId: b.id, ...b.def })));
}

describe('getCameraTint', () => {
    it('returns false in empty air (no tint registered)', () => {
        const registry = buildRegistry([{ id: 'stone', def: {} }]);
        const voxels = createVoxels(registry);
        const out: [number, number, number, number] = [9, 9, 9, 9];
        expect(getCameraTint(out, voxels, 0, 0, 0)).toBe(false);
    });

    it('returns false inside a block without a screenTint', () => {
        const registry = buildRegistry([{ id: 'stone', def: {} }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'stone');

        const out: [number, number, number, number] = [0, 0, 0, 0];
        expect(getCameraTint(out, voxels, 5.5, 5.5, 5.5)).toBe(false);
    });

    it('writes tint and returns true inside a full-cube tinted block', () => {
        const registry = buildRegistry([
            {
                id: 'fog',
                def: {
                    screenTint: { color: [0.5, 0.6, 0.7], opacity: 0.4 },
                    collision: false,
                },
            },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'fog');

        const out: [number, number, number, number] = [0, 0, 0, 0];
        expect(getCameraTint(out, voxels, 5.5, 5.5, 5.5)).toBe(true);
        expect(out[0]).toBeCloseTo(0.5);
        expect(out[1]).toBeCloseTo(0.6);
        expect(out[2]).toBeCloseTo(0.7);
        expect(out[3]).toBeCloseTo(0.4);
    });

    it('stacked liquid column: tint stays on while sinking through the meniscus gap between cells', () => {
        // simulates deep water with maxHeight < 1: every cell has the
        // same fluidGroup and a small air gap at its top. eye in the
        // gap should remain tinted because the cell above is the same
        // fluid, i.e. we're mid-column, not at the actual surface.
        const registry = buildRegistry([
            {
                id: 'water',
                def: {
                    surfaceHeight: 15 / 16,
                    fluidGroup: 'water',
                    collision: false,
                    liquid: { viscosity: 1 },
                    screenTint: { color: [0.04, 0.1, 0.2], opacity: 0.3 },
                },
            },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        // two stacked water cells at y=5 and y=6
        setChunkBlock(voxels, chunk, 5, 5, 5, 'water');
        setChunkBlock(voxels, chunk, 5, 6, 5, 'water');

        const out: [number, number, number, number] = [0, 0, 0, 0];
        // eye in the 1/16 air gap at the top of the lower cell, the
        // cell above is still water, so we keep tinting.
        expect(getCameraTint(out, voxels, 5.5, 5.97, 5.5)).toBe(true);
        expect(out[3]).toBeCloseTo(0.3);
    });

    it('partial-height liquid: tint applies only when eye Y is inside the filled band', () => {
        const registry = buildRegistry([
            {
                id: 'water',
                def: {
                    surfaceHeight: 0.5,
                    collision: false,
                    liquid: { viscosity: 1 },
                    screenTint: { color: [0.04, 0.1, 0.2], opacity: 0.3 },
                },
            },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set('0,0,0', chunk);
        setChunkBlock(voxels, chunk, 5, 5, 5, 'water');

        const out: [number, number, number, number] = [0, 0, 0, 0];
        // eye inside the bottom half of the cell → tint applies
        expect(getCameraTint(out, voxels, 5.5, 5.25, 5.5)).toBe(true);
        expect(out[3]).toBeCloseTo(0.3);

        // eye above the surface (still inside the cell volume) → no tint
        out[3] = 999;
        expect(getCameraTint(out, voxels, 5.5, 5.75, 5.5)).toBe(false);
        expect(out[3]).toBe(999); // untouched on false
    });
});
