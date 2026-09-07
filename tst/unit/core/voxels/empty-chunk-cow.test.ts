// ── empty-chunk copy-on-write ───────────────────────────────────────────
//
// Every chunk the server confirms empty ships as a stub aliasing the module-level
// EMPTY_DATA / EMPTY_LIGHT singletons (voxels.ts). A writer that mutates through
// the alias does not change one chunk, it changes EVERY empty chunk in the world.
// `setLight` did exactly that: a client-predicted place on a surface runs the sky
// removal into a neighbouring air stub, zeroing the shared buffer, and the whole
// sky went black until real light arrived for each chunk. Client-only, because
// only a networked mirror has stubs.

import { describe, expect, it } from 'vitest';
import {
    CHUNK_VOLUME,
    chunkData,
    chunkLight,
    createEmptyChunk,
    EMPTY_DATA,
    EMPTY_LIGHT,
    setLight,
    voxelIndex,
} from '../../../../src/core/voxels/voxels';

const IDX = voxelIndex(1, 1, 1);
const SKY_FULL = 0xf000;

describe('empty chunk stubs', () => {
    it('start out aliasing the shared singletons', () => {
        const chunk = createEmptyChunk(0, 0, 0);
        expect(chunk.light).toBe(EMPTY_LIGHT);
        expect(chunk.data).toBe(EMPTY_DATA);
        // full sky, so entities sampling light inside a networked-empty chunk
        // aren't rendered pitch black.
        expect(EMPTY_LIGHT[IDX]).toBe(SKY_FULL);
    });

    it('setLight does not darken every other empty chunk', () => {
        const edited = createEmptyChunk(0, 0, 0);
        const untouched = createEmptyChunk(9, 9, 9);

        setLight(edited, IDX, 0); // sky removal reaching into an air stub

        expect(edited.light[IDX]).toBe(0);
        expect(untouched.light[IDX]).toBe(SKY_FULL);
        expect(EMPTY_LIGHT[IDX]).toBe(SKY_FULL);
    });

    it('chunkLight/chunkData clone off the singleton, preserving contents', () => {
        const chunk = createEmptyChunk(0, 0, 0);

        const light = chunkLight(chunk);
        expect(light).not.toBe(EMPTY_LIGHT);
        expect(light).toBe(chunk.light); // and it stuck, so the next write is cheap
        expect(light[IDX]).toBe(SKY_FULL);
        expect(light).toHaveLength(CHUNK_VOLUME);

        const data = chunkData(chunk);
        expect(data).not.toBe(EMPTY_DATA);
        expect(data).toBe(chunk.data);
    });

    it('a whole-chunk light fill leaves the singleton alone', () => {
        const filled = createEmptyChunk(0, 0, 0);
        const untouched = createEmptyChunk(5, 5, 5);

        chunkLight(filled).fill(0);

        expect(untouched.light[IDX]).toBe(SKY_FULL);
        expect(EMPTY_LIGHT[IDX]).toBe(SKY_FULL);
    });
});
