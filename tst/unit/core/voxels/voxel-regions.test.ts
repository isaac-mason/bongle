// ── region occupancy index tests ─────────────────────────────────────
//
// voxels.regions is the AOI/streaming occupancy index: which chunks exist
// within each REGION_CHUNKS_PER_AXIS³ cube. locks in: membership survives
// create/remove, an emptied region's Map entry is pruned (not left as a
// dangling empty Set), region coordinates group multiple chunks correctly,
// and rebuildSpatialIndexes reconstructs it from voxels.chunks alone.

import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import {
    chunkColumnKey,
    chunkToRegionCoord,
    createVoxels,
    ensureChunk,
    REGION_CHUNKS_PER_AXIS,
    rebuildSpatialIndexes,
    regionKey,
    removeChunk,
} from '../../../../src/core/voxels/voxels';

beforeEach(() => {
    resetVoxelRegistry();
});

function makeVoxels() {
    return createVoxels(buildTestRegistry([{ id: 'stone', texId: 'stone' }]));
}

describe('voxels.regions', () => {
    it('adds a chunk to its region on ensureChunk', () => {
        const voxels = makeVoxels();
        const chunk = ensureChunk(voxels, 0, 0, 0);

        const key = regionKey(0, 0, 0);
        const region = voxels.regions.get(key);
        expect(region).toBeDefined();
        expect(region!.has(chunk)).toBe(true);
        expect(region!.size).toBe(1);
    });

    it('groups every chunk in a REGION_CHUNKS_PER_AXIS³ cube into the same region', () => {
        const voxels = makeVoxels();
        const chunks = [];
        for (let z = 0; z < REGION_CHUNKS_PER_AXIS; z++)
            for (let y = 0; y < REGION_CHUNKS_PER_AXIS; y++)
                for (let x = 0; x < REGION_CHUNKS_PER_AXIS; x++) chunks.push(ensureChunk(voxels, x, y, z));

        const region = voxels.regions.get(regionKey(0, 0, 0));
        expect(region).toBeDefined();
        expect(region!.size).toBe(REGION_CHUNKS_PER_AXIS ** 3);
        for (const c of chunks) expect(region!.has(c)).toBe(true);
    });

    it('a chunk just past the region boundary lands in the neighbouring region', () => {
        const voxels = makeVoxels();
        ensureChunk(voxels, REGION_CHUNKS_PER_AXIS - 1, 0, 0); // last chunk of region (0,0,0)
        ensureChunk(voxels, REGION_CHUNKS_PER_AXIS, 0, 0); // first chunk of region (1,0,0)

        expect(chunkToRegionCoord(REGION_CHUNKS_PER_AXIS - 1)).toBe(0);
        expect(chunkToRegionCoord(REGION_CHUNKS_PER_AXIS)).toBe(1);
        expect(voxels.regions.get(regionKey(0, 0, 0))!.size).toBe(1);
        expect(voxels.regions.get(regionKey(1, 0, 0))!.size).toBe(1);
    });

    it('negative chunk coordinates floor toward the correct region, not toward zero', () => {
        const voxels = makeVoxels();
        // -1 must land in region -1, not region 0 (a naive truncating divide would
        // put it in 0, the exact bug floor-division/bit-shift avoids).
        ensureChunk(voxels, -1, 0, 0);
        expect(chunkToRegionCoord(-1)).toBe(-1);
        expect(voxels.regions.get(regionKey(-1, 0, 0))!.size).toBe(1);
        expect(voxels.regions.has(regionKey(0, 0, 0))).toBe(false);
    });

    it('removeChunk removes membership and prunes an emptied region entry', () => {
        const voxels = makeVoxels();
        ensureChunk(voxels, 0, 0, 0);
        ensureChunk(voxels, 1, 0, 0); // same region (both < REGION_CHUNKS_PER_AXIS)

        removeChunk(voxels, 0, 0, 0);
        const region = voxels.regions.get(regionKey(0, 0, 0));
        expect(region).toBeDefined(); // still has the other chunk
        expect(region!.size).toBe(1);

        removeChunk(voxels, 1, 0, 0);
        // the region is now empty — the Map entry itself should be gone, not a
        // dangling empty Set, so occupancy checks are a plain .has() away from
        // correctly reporting "nothing here" without inspecting size.
        expect(voxels.regions.has(regionKey(0, 0, 0))).toBe(false);
    });

    it('removeChunk on an already-removed chunk is a safe no-op', () => {
        const voxels = makeVoxels();
        ensureChunk(voxels, 0, 0, 0);
        removeChunk(voxels, 0, 0, 0);
        expect(() => removeChunk(voxels, 0, 0, 0)).not.toThrow();
        expect(voxels.regions.has(regionKey(0, 0, 0))).toBe(false);
    });

    it('rebuildSpatialIndexes reconstructs regions (and columns) from voxels.chunks alone', () => {
        const voxels = makeVoxels();
        ensureChunk(voxels, 0, 0, 0);
        ensureChunk(voxels, 1, 0, 0);
        ensureChunk(voxels, REGION_CHUNKS_PER_AXIS, 0, 0); // a second region

        // simulate a caller that populated voxels.chunks directly, bypassing
        // ensureChunk (e.g. deserialize), leaving regions/columns stale.
        voxels.regions.clear();
        voxels.columns.clear();

        rebuildSpatialIndexes(voxels);

        expect(voxels.regions.get(regionKey(0, 0, 0))!.size).toBe(2);
        expect(voxels.regions.get(regionKey(1, 0, 0))!.size).toBe(1);
        // columns is the sibling index rebuildSpatialIndexes also restores —
        // confirm it didn't get left behind while adding regions. (0,0,0) and
        // (1,0,0) differ in cx, so they're two distinct columns, one chunk each.
        expect(voxels.columns.get(chunkColumnKey(0, 0))?.length).toBe(1);
        expect(voxels.columns.get(chunkColumnKey(1, 0))?.length).toBe(1);
        expect(voxels.columns.get(chunkColumnKey(REGION_CHUNKS_PER_AXIS, 0))?.length).toBe(1);
    });
});
