// ── incremental voxel save tests ────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { loadVoxels, saveVoxels, saveVoxelsIncremental, seedVoxelSaveCache, type VoxelSaveCache } from '../../../../src/core/voxels/voxel-savefile';
import { BLOCK_AIR, CHUNK_SIZE, createVoxels, setBlock } from '../../../../src/core/voxels/voxels';

beforeEach(() => resetVoxelRegistry());

function setup() {
    const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
    return { registry, voxels: createVoxels(registry) };
}

describe('saveVoxelsIncremental', () => {
    it('produces the same payload as saveVoxels', () => {
        const { voxels } = setup();
        setBlock(voxels, 1, 1, 1, 'stone');
        setBlock(voxels, CHUNK_SIZE + 1, 1, 1, 'stone'); // a second chunk
        const full = saveVoxels(voxels);
        const incr = saveVoxelsIncremental(voxels, new Map());
        expect(incr).toEqual(full);
    });

    it('reuses cached bytes when a chunk is unchanged (no re-serialize)', () => {
        const { voxels } = setup();
        setBlock(voxels, 1, 1, 1, 'stone');
        const cache: VoxelSaveCache = new Map();
        const a = saveVoxelsIncremental(voxels, cache);
        const b = saveVoxelsIncremental(voxels, cache);
        const key = Object.keys(a.chunks)[0]!;
        // identical object reference ⇒ the cached SavedChunk was reused, not re-gzipped
        expect(b.chunks[key]).toBe(a.chunks[key]);
    });

    it('re-serializes a chunk whose data version moved', () => {
        const { voxels } = setup();
        setBlock(voxels, 1, 1, 1, 'stone');
        const cache: VoxelSaveCache = new Map();
        const a = saveVoxelsIncremental(voxels, cache);
        const key = Object.keys(a.chunks)[0]!;
        setBlock(voxels, 2, 1, 1, 'stone'); // same chunk, version bumps
        const b = saveVoxelsIncremental(voxels, cache);
        expect(b.chunks[key]).not.toBe(a.chunks[key]); // fresh bytes
    });

    it('prunes a chunk emptied to air', () => {
        const { voxels } = setup();
        setBlock(voxels, 1, 1, 1, 'stone');
        const cache: VoxelSaveCache = new Map();
        const key = Object.keys(saveVoxelsIncremental(voxels, cache).chunks)[0]!;
        expect(cache.has(key)).toBe(true);
        setBlock(voxels, 1, 1, 1, BLOCK_AIR); // remove the only block → aggregate 0
        const out = saveVoxelsIncremental(voxels, cache);
        expect(out.chunks[key]).toBeUndefined();
        expect(cache.has(key)).toBe(false); // pruned from the cache too
    });

    it('seedVoxelSaveCache lets the first save reuse the on-disk bytes', () => {
        const { voxels, registry } = setup();
        setBlock(voxels, 1, 1, 1, 'stone');
        const saved = saveVoxels(voxels);

        const loaded = createVoxels(registry);
        loadVoxels(loaded, saved, registry);
        const cache = seedVoxelSaveCache(loaded, saved);
        const out = saveVoxelsIncremental(loaded, cache);
        const key = Object.keys(saved.chunks)[0]!;
        // reused the exact seeded SavedChunk ⇒ an unedited scene re-flushes for free
        expect(out.chunks[key]).toBe(saved.chunks[key]);
    });
});
