// ── voxel light volume ──────────────────────────────────────────────
//
// Covers the drain, which is where the bake, the slot pool and the residency
// grid meet. See `llm/plan-voxel-light-volume.md`.

import { describe, expect, it } from 'vitest';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { flushPendingLight, propagateAllLight } from '../../../../src/core/voxels/light';

import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import {
    createVoxels,
    ensureChunk,
    markLightVolumeDirty,
    setBlock,
    setChunkBlock,
    type Voxels,
} from '../../../../src/core/voxels/voxels';
import {
    createLightVolume,
    drainLightVolume,
    evictChunkLight,
    lookupPayload,
    payloadSlot,
    readCell,
    withinLightGrid,
} from '../../../../src/render/voxels/voxel-light-volume';

function world(withGeometry: boolean): Voxels {
    resetVoxelRegistry();
    const registry = buildTestRegistry([{ id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE, texId: 'stone' }]);
    const voxels = createVoxels(registry);
    for (let cx = 0; cx <= 2; cx++) {
        for (let cy = 0; cy <= 1; cy++) {
            for (let cz = 0; cz <= 2; cz++) ensureChunk(voxels, cx, cy, cz);
        }
    }
    if (withGeometry) {
        const c = voxels.chunks.get('1,0,1')!;
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) setChunkBlock(voxels, c, x, 4, z, 'stone');
    }
    propagateAllLight(voxels);
    return voxels;
}

const ORIGIN: [number, number, number] = [24, 8, 24];

/** the drain's contract is "process what is in the set", so seed it explicitly
 *  rather than depending on whatever `propagateAllLight` happened to mark.
 *  Sets `lightWanted` too: admission is the AOI's call, and these tests are about
 *  the drain, not about admission policy. */
function markAllDirty(voxels: Voxels): void {
    for (const c of voxels.chunks.values()) {
        c.lightWanted = true;
        voxels.dirty.lightVolume.add(c);
    }
}

/** mark WITHOUT the AOI's blessing, the way propagation or an arrival does. */
function markUnwanted(voxels: Voxels): void {
    for (const c of voxels.chunks.values()) voxels.dirty.lightVolume.add(c);
}

describe('drainLightVolume', () => {
    it('spends a time budget, always baking at least one', () => {
        const voxels = world(true);
        const v = createLightVolume(4, 64);
        markAllDirty(voxels);
        expect(voxels.dirty.lightVolume.size).toBe(18);

        // every resident chunk gets a real tile: there is no uniform shortcut,
        // so the queue drains at exactly the budget and nothing faster.
        expect(drainLightVolume(v, voxels, ORIGIN, 0, 0)).toBe(1); // zero budget still bakes one
        expect(voxels.dirty.lightVolume.size).toBe(17);
        expect(v.head).toBe(1);

        expect(drainLightVolume(v, voxels, ORIGIN, 1000, 0)).toBe(17);
        expect(voxels.dirty.lightVolume.size).toBe(0);
        expect(v.head).toBe(18);
    });

    it('a full pool evicts its furthest chunk rather than refusing a nearer one', () => {
        const voxels = world(true);
        // two slots for 18 chunks: the pool is full almost immediately.
        const v = createLightVolume(4, 2);
        markAllDirty(voxels);
        expect(drainLightVolume(v, voxels, ORIGIN, 1000, 0)).toBe(18);
        expect(voxels.dirty.lightVolume.size).toBe(0);

        // whatever survived, it is NOT the case that early arrivals squatted the
        // pool and later chunks got nothing. Refusing was the old behaviour and
        // it starved the chunk under the camera indefinitely.
        let resident = 0;
        for (const c of voxels.chunks.values()) if (lookupPayload(v, c.cx, c.cy, c.cz) !== 0) resident++;
        expect(resident).toBe(2);
        expect(v.head).toBe(2);
    });
});

describe('residency grid', () => {
    it('verifies the chunk coord, so an aliased cell reads as a miss', () => {
        const v = createLightVolume(4, 16);
        // dim is the next power of two >= 9, i.e. 16; chunk 0 and chunk 16 alias
        const voxels = world(false);
        markAllDirty(voxels);
        drainLightVolume(v, voxels, ORIGIN, 1000, 0);

        expect(lookupPayload(v, 1, 0, 1)).not.toBe(0);
        // same grid cell, different chunk: must NOT report the neighbour's payload
        expect(lookupPayload(v, 1 + v.dim, 0, 1)).toBe(0);
    });

    it('eviction only clears a cell the chunk still owns', () => {
        const v = createLightVolume(4, 16);
        const voxels = world(false);
        markAllDirty(voxels);
        drainLightVolume(v, voxels, ORIGIN, 1000, 0);
        expect(lookupPayload(v, 1, 0, 1)).not.toBe(0);

        // an aliased chunk evicting must not clear the resident one
        evictChunkLight(v, 1 + v.dim, 0, 1);
        expect(lookupPayload(v, 1, 0, 1)).not.toBe(0);

        evictChunkLight(v, 1, 0, 1);
        expect(lookupPayload(v, 1, 0, 1)).toBe(0);
    });
});

/** what the shader would read for one corner of one chunk. */
describe('chunk tiles', () => {
    it('publishes each chunk its own cells, whatever the arrival order', () => {
        resetVoxelRegistry();
        const registry = buildTestRegistry([
            { id: 'stone', cull: CullType.SOLID, material: MaterialType.OPAQUE, texId: 'stone' },
        ]);
        const voxels = createVoxels(registry);
        const v = createLightVolume(6, 256);

        let frame = 0;
        for (let cx = 0; cx <= 3; cx++) {
            for (let cy = 0; cy <= 2; cy++) {
                for (let cz = 0; cz <= 3; cz++) {
                    const c = ensureChunk(voxels, cx, cy, cz);
                    if (cy === 0)
                        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) setChunkBlock(voxels, c, x, 6, z, 'stone');
                    propagateAllLight(voxels);
                    c.lightWanted = true;
                    markLightVolumeDirty(voxels, c);
                    drainLightVolume(v, voxels, ORIGIN, 1000, frame++);
                }
            }
        }
        drainLightVolume(v, voxels, ORIGIN, 1000, frame + 100);

        // no borrowed shell means no shared plane to go stale: each tile must
        // simply equal its chunk's own light. Staleness used to show as a seam.
        const bad: string[] = [];
        for (const c of voxels.chunks.values()) {
            const p = lookupPayload(v, c.cx, c.cy, c.cz);
            if (p === 0) continue;
            for (let i = 0; i < 4096; i += 137) {
                const got = readCell(v, payloadSlot(p), i);
                if (got !== c.light[i]!)
                    bad.push(`${c.cx},${c.cy},${c.cz}[${i}] got 0x${got.toString(16)} want 0x${c.light[i]!.toString(16)}`);
            }
        }
        expect(bad.slice(0, 5)).toEqual([]);
    });
});

describe('locally predicted edits', () => {
    it('publishes correct light without waiting for the server', () => {
        const voxels = world(true);
        const v = createLightVolume(4, 256);
        markAllDirty(voxels);
        drainLightVolume(v, voxels, ORIGIN, 1000, 0);
        expect(voxels.dirty.lightVolume.size).toBe(0);

        // a client predicts a break locally: no network message is involved, so
        // the incremental light path is the only thing that can queue the rebake.
        setBlock(voxels, 24, 4, 24, 'air');
        flushPendingLight(voxels);
        drainLightVolume(v, voxels, ORIGIN, 1000, 0);

        // what the volume publishes must equal the chunk's own light. Stale here
        // meant the hole stayed dark until the server's light delta landed, a
        // dark flash exactly one round-trip long.
        const edited = voxels.chunks.get('1,0,1')!;
        const p = lookupPayload(v, 1, 0, 1);
        const mismatched: string[] = [];
        for (let i = 0; i < 4096; i++) {
            const got = readCell(v, payloadSlot(p), i);
            if (got !== edited.light[i]!)
                mismatched.push(`${i}: got 0x${got.toString(16)} want 0x${edited.light[i]!.toString(16)}`);
        }
        expect(mismatched.slice(0, 5)).toEqual([]);
    });
});

describe('residency follows the AOI', () => {
    it('refuses a tile to a chunk the AOI never asked for', () => {
        const voxels = world(true);
        const v = createLightVolume(4, 256);
        // marking from anywhere else (propagation, arrival, apron) must not be
        // able to create a tile: admission is the AOI's decision alone, or the
        // pool becomes a second residency system and thrashes against the mesh.
        markUnwanted(voxels);
        expect(drainLightVolume(v, voxels, ORIGIN, 1000, 0)).toBe(0);
        expect(v.head).toBe(0);
        expect(voxels.dirty.lightVolume.size).toBe(0); // dropped, not retried forever

        // the AOI asking is what admits it
        const wanted = voxels.chunks.get('1,0,1')!;
        wanted.lightWanted = true;
        voxels.dirty.lightVolume.add(wanted);
        expect(drainLightVolume(v, voxels, ORIGIN, 1000, 0)).toBe(1);
        expect(lookupPayload(v, 1, 0, 1)).not.toBe(0);
    });

    it('refreshes a tile that already exists without an AOI request', () => {
        const voxels = world(true);
        const v = createLightVolume(4, 256);
        const c = voxels.chunks.get('1,0,1')!;
        c.lightWanted = true;
        voxels.dirty.lightVolume.add(c);
        drainLightVolume(v, voxels, ORIGIN, 1000, 0);
        expect(v.head).toBe(1);

        // a later light change refreshes in place: refusal applies to ADMISSION,
        // not to keeping an existing tile current. `lightUrgent` is what a real
        // light write sets, and it also bypasses the neighbourhood deferral.
        c.lightWanted = false;
        c.lightUrgent = true;
        voxels.dirty.lightVolume.add(c);
        expect(drainLightVolume(v, voxels, ORIGIN, 1000, 0)).toBe(1);
        expect(v.head).toBe(1); // reused the same slot
    });
});

describe('grid radius bounds admission', () => {
    it('refuses a chunk the wrapping grid cannot represent', () => {
        const v = createLightVolume(2, 256); // dim = nextPow2(5) = 8
        expect(v.radius).toBe(2);

        // inside the radius: representable
        expect(withinLightGrid(v, 1, 0, 1, [1, 0, 1])).toBe(true);
        // outside: its wrapping index collides with a nearer chunk's cell, so
        // admitting it would have the two clobber each other's entry forever.
        expect(withinLightGrid(v, 1 + v.dim, 0, 1, [1, 0, 1])).toBe(false);
        expect(withinLightGrid(v, 5, 0, 1, [1, 0, 1])).toBe(false);
    });
});
