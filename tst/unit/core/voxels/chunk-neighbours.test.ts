// ── chunk neighbour linking tests ───────────────────────────────────
//
// locks in the 26-slot neighbour graph: faces stay at slots 0-5 (light.ts
// convention), the generated opposite table wires reverse links correctly, and
// knownNeighbourCount tracks the popcount both ways.

import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import {
    chunkKey,
    createVoxels,
    ensureChunk,
    NEIGHBOR_COUNT,
    neighbourSlot,
    unlinkChunkNeighbors,
} from '../../../../src/core/voxels/voxels';

beforeEach(() => {
    resetVoxelRegistry();
});

function makeVoxels() {
    return createVoxels(buildTestRegistry([{ id: 'stone', texId: 'stone' }]));
}

describe('chunk neighbour linking', () => {
    it('links the full 26-neighbourhood bidirectionally with correct opposites', () => {
        const voxels = makeVoxels();
        // insert the whole 3×3×3 around the origin.
        for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ensureChunk(voxels, dx, dy, dz);

        const center = voxels.chunks.get(chunkKey(0, 0, 0))!;
        expect(NEIGHBOR_COUNT).toBe(26);
        expect(center.knownNeighbourCount).toBe(26);

        // every slot is filled, and the neighbour's reverse link points back at
        // center — i.e. the opposite mapping is correct for all 26.
        for (let i = 0; i < NEIGHBOR_COUNT; i++) {
            const n = center.neighbors[i];
            expect(n).not.toBeNull();
            expect(n!.neighbors.includes(center)).toBe(true);
        }

        // faces stay at slots 0-5 in light.ts's convention (0=+X,1=+Y,2=+Z,3=-Z,4=-Y,5=-X).
        expect(center.neighbors[0]).toBe(voxels.chunks.get(chunkKey(1, 0, 0)));
        expect(center.neighbors[1]).toBe(voxels.chunks.get(chunkKey(0, 1, 0)));
        expect(center.neighbors[2]).toBe(voxels.chunks.get(chunkKey(0, 0, 1)));
        expect(center.neighbors[3]).toBe(voxels.chunks.get(chunkKey(0, 0, -1)));
        expect(center.neighbors[4]).toBe(voxels.chunks.get(chunkKey(0, -1, 0)));
        expect(center.neighbors[5]).toBe(voxels.chunks.get(chunkKey(-1, 0, 0)));

        // neighbourSlot(dx,dy,dz) resolves to the slot holding that offset — this
        // is the mapping buildSlabs relies on to pointer-follow the apron.
        for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    expect(center.neighbors[neighbourSlot(dx, dy, dz)]).toBe(voxels.chunks.get(chunkKey(dx, dy, dz)));
                }
    });

    it('knownNeighbourCount rises as neighbours arrive and falls on unlink', () => {
        const voxels = makeVoxels();
        const center = ensureChunk(voxels, 0, 0, 0);
        expect(center.knownNeighbourCount).toBe(0);

        const px = ensureChunk(voxels, 1, 0, 0); // +X face
        expect(center.knownNeighbourCount).toBe(1);
        expect(px.knownNeighbourCount).toBe(1); // bidirectional

        ensureChunk(voxels, 1, 1, 1); // a corner of both center and px
        expect(center.knownNeighbourCount).toBe(2);
        expect(px.knownNeighbourCount).toBe(2);

        // removing px decrements every surviving neighbour that referenced it.
        unlinkChunkNeighbors(px);
        voxels.chunks.delete(chunkKey(1, 0, 0));
        expect(center.knownNeighbourCount).toBe(1); // lost px, still has the corner
    });
});
