// ── anchored corner light ───────────────────────────────────────────
//
// The shared-corner lattice these replaced could not represent a corner where a
// lit cell and a dark cell meet without being face-connected: one number cannot
// be both. Anchoring reads only the face's own side, so the far side is never in
// the input set.

import { describe, expect, it } from 'vitest';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { propagateAllLight } from '../../../../src/core/voxels/light';
import { blendAnchoredCorner } from '../../../../src/core/voxels/light-lattice';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createVoxels, ensureChunk, setChunkBlock, type Voxels, voxelIndex } from '../../../../src/core/voxels/voxels';

const sky = (p: number) => (p >>> 12) & 0xf;

function solidWorld(): { voxels: Voxels; chunk: ReturnType<typeof ensureChunk> } {
    resetVoxelRegistry();
    const registry = buildTestRegistry([{ id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE, texId: 'stone' }]);
    const voxels = createVoxels(registry);
    for (let cx = 0; cx <= 2; cx++)
        for (let cy = 0; cy <= 2; cy++) for (let cz = 0; cz <= 2; cz++) ensureChunk(voxels, cx, cy, cz);
    const chunk = voxels.chunks.get('1,1,1')!;
    for (let x = 0; x < 16; x++)
        for (let y = 0; y < 8; y++) for (let z = 0; z < 16; z++) setChunkBlock(voxels, chunk, x, y, z, 'stone');
    return { voxels, chunk };
}

describe('anchored corner blend', () => {
    it('does not light a sealed 2x2 pocket through the corner gaps', () => {
        const { voxels, chunk } = solidWorld();
        // single-layer 2x2 pocket at y=4, capped above and below
        for (const [x, z] of [
            [7, 7],
            [8, 7],
            [7, 8],
            [8, 8],
        ] as [number, number][])
            setChunkBlock(voxels, chunk, x, 4, z, 'air');
        // the four footprint CORNERS are shafts open to the sky; the eight edge
        // cells between them stay solid, so the pocket is walled on every face
        // and reaches light only diagonally.
        for (const [x, z] of [
            [6, 6],
            [9, 6],
            [6, 9],
            [9, 9],
        ] as [number, number][]) {
            for (let y = 4; y < 8; y++) setChunkBlock(voxels, chunk, x, y, z, 'air');
        }
        propagateAllLight(voxels);
        expect(sky(chunk.light[voxelIndex(7, 4, 7)]!)).toBe(0); // pocket sealed
        expect(sky(chunk.light[voxelIndex(6, 4, 6)]!)).toBe(15); // shaft lit

        // the wall at (6,4,7), +X face: the cell beyond it is the pocket. Every
        // corner of that face must be dark. The shared-corner lattice published 7
        // here, because the shaft at (6,4,6) is a corner-diagonal neighbour.
        for (const [ou, ov] of [
            [-1, -1],
            [-1, 1],
            [1, -1],
            [1, 1],
        ] as [number, number][]) {
            expect(sky(blendAnchoredCorner(voxels, 16 + 6, 16 + 4, 16 + 7, 1, 0, 0, ou, ov))).toBe(0);
        }
    });

    it('still lights the shaft side of the same corner', () => {
        const { voxels, chunk } = solidWorld();
        for (const [x, z] of [
            [7, 7],
            [8, 7],
            [7, 8],
            [8, 8],
        ] as [number, number][])
            setChunkBlock(voxels, chunk, x, 4, z, 'air');
        for (const [x, z] of [
            [6, 6],
            [9, 6],
            [6, 9],
            [9, 9],
        ] as [number, number][]) {
            for (let y = 4; y < 8; y++) setChunkBlock(voxels, chunk, x, y, z, 'air');
        }
        propagateAllLight(voxels);

        // the wall at (7,4,6), -X face: the cell beyond it is the lit shaft.
        // A symmetric connectivity rule would black this out; anchoring keeps it.
        expect(sky(blendAnchoredCorner(voxels, 16 + 7, 16 + 4, 16 + 6, -1, 0, 0, 1, 1))).toBe(15);
    });
});
