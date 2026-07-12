// ── relightChunks (scoped light recompute) tests ────────────────────
//
// relightChunks is the middle granularity between propagateAllLight (whole
// world) and updateLightBatch (per-node). two properties pin it down:
//   1. a fully-dirty set must equal a full propagateAllLight bake.
//   2. it must preserve the light of chunks outside the set (disk cache),
//      and re-illuminate the set from lit neighbours (boundary in-flow).

import { beforeEach, describe, expect, it } from 'vitest';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { propagateAllLight, relightChunks } from '../../../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import type { Chunk, Voxels } from '../../../../src/core/voxels/voxels';
import {
    CHUNK_SIZE,
    chunkKey,
    createChunk,
    createVoxels,
    linkChunkNeighbors,
    setChunkBlock,
} from '../../../../src/core/voxels/voxels';

beforeEach(() => {
    resetVoxelRegistry();
});

function makeRegistry() {
    return buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass', lightOpacity: 0 },
        { id: 'lamp', cull: CullType.NONE, texId: 'lamp', lightEmission: [15, 12, 8], lightOpacity: 0 },
    ]);
}

/** clone every chunk's light array so we can diff before/after. */
function snapshotLight(voxels: Voxels): Map<string, Uint16Array> {
    const out = new Map<string, Uint16Array>();
    for (const [key, c] of voxels.chunks) out.set(key, new Uint16Array(c.light));
    return out;
}

function expectLightEqual(voxels: Voxels, ref: Map<string, Uint16Array>): void {
    for (const [key, c] of voxels.chunks) {
        const want = ref.get(key)!;
        // compare as plain arrays for a readable diff on mismatch
        expect({ key, light: Array.from(c.light) }).toEqual({ key, light: Array.from(want) });
    }
}

/** a 3×2×3 chunk block of terrain: a stone floor at world y=0..3, air above,
 *  a lamp buried at the centre, a glass window. exercises sky columns,
 *  emitters, and cross-chunk spread. */
function buildWorld(registry: ReturnType<typeof makeRegistry>): Voxels {
    const voxels = createVoxels(registry);
    for (let cx = 0; cx < 3; cx++) {
        for (let cy = 0; cy < 2; cy++) {
            for (let cz = 0; cz < 3; cz++) {
                const c = createChunk(cx, cy, cz);
                voxels.chunks.set(chunkKey(cx, cy, cz), c);
            }
        }
    }
    for (const c of voxels.chunks.values()) linkChunkNeighbors(voxels, c);

    // stone floor across the bottom chunk layer (cy=0), y-local 0..3
    for (let cx = 0; cx < 3; cx++) {
        for (let cz = 0; cz < 3; cz++) {
            const c = voxels.chunks.get(chunkKey(cx, 0, cz))!;
            for (let ly = 0; ly <= 3; ly++)
                for (let lz = 0; lz < CHUNK_SIZE; lz++)
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) setChunkBlock(voxels, c, lx, ly, lz, 'stone');
        }
    }
    // a lamp sitting on the floor in the middle chunk, plus a glass roof over it
    const mid = voxels.chunks.get(chunkKey(1, 0, 1))!;
    setChunkBlock(voxels, mid, 8, 4, 8, 'lamp');
    setChunkBlock(voxels, mid, 8, 8, 8, 'glass');
    return voxels;
}

describe('relightChunks', () => {
    it('fully-dirty set equals a propagateAllLight bake', () => {
        const registry = makeRegistry();
        const voxels = buildWorld(registry);

        propagateAllLight(voxels);
        const reference = snapshotLight(voxels);

        // relight every chunk from scratch: must reproduce the full bake exactly.
        const all = new Set<Chunk>(voxels.chunks.values());
        relightChunks(voxels, all);

        expectLightEqual(voxels, reference);
    });

    it('preserves light outside the set and re-illuminates from neighbours', () => {
        const registry = makeRegistry();
        const voxels = buildWorld(registry);
        propagateAllLight(voxels);
        const reference = snapshotLight(voxels);

        // corrupt one interior chunk's light, then relight just that chunk.
        // its neighbours are lit and act as boundary conditions; the result
        // must match the full bake, and no other chunk may change.
        const target = voxels.chunks.get(chunkKey(1, 1, 1))!;
        target.light.fill(0);
        relightChunks(voxels, new Set([target]));

        expectLightEqual(voxels, reference);
    });

    it('is idempotent (relight twice == relight once)', () => {
        const registry = makeRegistry();
        const voxels = buildWorld(registry);
        const all = new Set<Chunk>(voxels.chunks.values());
        relightChunks(voxels, all);
        const once = snapshotLight(voxels);
        relightChunks(voxels, all);
        expectLightEqual(voxels, once);
    });
});
