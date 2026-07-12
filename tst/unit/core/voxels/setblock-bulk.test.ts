// ── BULK-flag light routing integration ─────────────────────────────
//
// setBlock(..., BULK) / setChunkBlock(..., BULK) and tier-1 invalidateChunk
// route light to authority.changes.light.chunks, which flushPendingLight
// drains via a scoped relightChunks. The end state must match the per-block
// incremental (DEFAULT) path baked with propagateAllLight.

import { beforeEach, describe, expect, it } from 'vitest';
import { SetBlockFlags } from '../../../../src/core/voxels/block-flags';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { flushPendingLight, getBlue, getGreen, getRed, getSky, propagateAllLight } from '../../../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import type { Voxels } from '../../../../src/core/voxels/voxels';
import {
    chunkData,
    createVoxels,
    createVoxelsAuthority,
    ensureChunk,
    ensureChunkPaletteSlot,
    invalidateChunk,
    setBlock,
    voxelIndex,
} from '../../../../src/core/voxels/voxels';

beforeEach(() => {
    resetVoxelRegistry();
});

function makeRegistry() {
    return buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'dirt', texId: 'dirt' },
        { id: 'grass', texId: 'grass' },
        { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass', lightOpacity: 0 },
        { id: 'lamp', cull: CullType.NONE, texId: 'lamp', lightEmission: [15, 10, 4], lightOpacity: 0 },
    ]);
}

function makeVoxels(reg: ReturnType<typeof makeRegistry>): Voxels {
    const v = createVoxels(reg);
    v.authority = createVoxelsAuthority();
    return v;
}

/** author a little world at world coords via the given writer. deterministic. */
function build(place: (wx: number, wy: number, wz: number, key: string) => void): void {
    // a 40×40 stone floor spanning 3 chunks, dirt/grass cap, a lamp + glass roof.
    for (let x = 0; x < 40; x++) {
        for (let z = 0; z < 40; z++) {
            place(x, 0, z, 'stone');
            place(x, 1, z, 'stone');
            place(x, 2, z, 'dirt');
            place(x, 3, z, 'grass');
        }
    }
    place(20, 4, 20, 'lamp');
    place(20, 7, 20, 'glass');
    // a little wall that casts a shadow
    for (let y = 4; y < 8; y++) for (let x = 10; x < 30; x++) place(x, y, 10, 'stone');
}

function snapshot(v: Voxels): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [k, c] of v.chunks) out.set(k, Array.from(c.light));
    return out;
}

function expectEqual(v: Voxels, ref: Map<string, number[]>): void {
    expect(new Set(v.chunks.keys())).toEqual(new Set(ref.keys()));
    for (const [k, c] of v.chunks) expect({ k, light: Array.from(c.light) }).toEqual({ k, light: ref.get(k)! });
}

describe('BULK light routing', () => {
    it('setBlock(BULK) + flushPendingLight == DEFAULT + propagateAllLight', () => {
        const reg = makeRegistry();

        // reference: per-block DEFAULT writes, then a full bake.
        const ref = makeVoxels(reg);
        build((x, y, z, key) => setBlock(ref, x, y, z, key, SetBlockFlags.DEFAULT));
        propagateAllLight(ref);
        const reference = snapshot(ref);

        // subject: BULK writes, light settled only by flushPendingLight.
        const v = makeVoxels(reg);
        build((x, y, z, key) => setBlock(v, x, y, z, key, SetBlockFlags.BULK));
        expect(v.authority!.changes.light.chunks.size).toBeGreaterThan(0);
        flushPendingLight(v);
        expect(v.authority!.changes.light.chunks.size).toBe(0); // drained

        expectEqual(v, reference);
    });

    it('tier-1 raw fill + invalidateChunk + flush == DEFAULT bake', () => {
        const reg = makeRegistry();
        const ref = makeVoxels(reg);
        build((x, y, z, key) => setBlock(ref, x, y, z, key, SetBlockFlags.DEFAULT));
        propagateAllLight(ref);
        const reference = snapshot(ref);

        // subject: raw typed-array writes per chunk, reconciled by invalidateChunk.
        const v = makeVoxels(reg);
        const touched = new Map<string, ReturnType<typeof ensureChunk>>();
        build((x, y, z, key) => {
            const chunk = ensureChunk(v, x >> 4, y >> 4, z >> 4);
            const slot = ensureChunkPaletteSlot(chunk, key, v.registry);
            chunkData(chunk)[voxelIndex(x & 15, y & 15, z & 15)] = slot;
            touched.set(`${chunk.cx},${chunk.cy},${chunk.cz}`, chunk);
        });
        for (const chunk of touched.values()) invalidateChunk(v, chunk);
        flushPendingLight(v);

        expectEqual(v, reference);
    });
});

// with flood-fill disabled (flat / fullbright mode), no propagation runs —
// flushPendingLight drops the relight queues. BULK writes and tier-1
// invalidateChunk must therefore inline-seed (sky + emission), NOT queue a
// relight that gets dropped (which would leave emitters dark).
describe('BULK / tier-1 light with flood-fill disabled', () => {
    it('BULK write inline-seeds sky + emission instead of queueing a dropped relight', () => {
        const reg = makeRegistry();
        const v = makeVoxels(reg);
        v.authority!.floodFillLighting.enabled = false; // flat mode, minLevel 15

        setBlock(v, 5, 5, 5, 'lamp', SetBlockFlags.BULK);
        expect(v.authority!.changes.light.chunks.size).toBe(0); // NOT queued
        flushPendingLight(v);

        const packed = v.chunks.get('0,0,0')!.light[voxelIndex(5, 5, 5)]!;
        expect(getSky(packed)).toBe(15); // flat sky
        expect([getRed(packed), getGreen(packed), getBlue(packed)]).toEqual([15, 10, 4]); // lamp emission
    });

    it('tier-1 invalidateChunk flat-seeds the chunk (sky + emitter emission)', () => {
        const reg = makeRegistry();
        const v = makeVoxels(reg);
        v.authority!.floodFillLighting.enabled = false;

        const chunk = ensureChunk(v, 0, 0, 0);
        const lamp = ensureChunkPaletteSlot(chunk, 'lamp', v.registry);
        const stone = ensureChunkPaletteSlot(chunk, 'stone', v.registry);
        chunkData(chunk)[voxelIndex(3, 3, 3)] = lamp;
        chunkData(chunk)[voxelIndex(1, 1, 1)] = stone;
        invalidateChunk(v, chunk);

        expect(v.authority!.changes.light.chunks.size).toBe(0); // not queued
        const lampCell = chunk.light[voxelIndex(3, 3, 3)]!;
        expect([getSky(lampCell), getRed(lampCell)]).toEqual([15, 15]); // sky + emission
        const stoneCell = chunk.light[voxelIndex(1, 1, 1)]!;
        expect([getSky(stoneCell), getRed(stoneCell)]).toEqual([15, 0]); // flat sky, no emission
    });
});
