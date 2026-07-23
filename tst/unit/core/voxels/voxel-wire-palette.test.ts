// ── voxel wire palette decoupling ───────────────────────────────────
//
// the chunk storage palette (per-chunk local slots) is decoupled from the
// wire, which speaks the registry-shared global state id. these tests pin
// that contract: a client whose local palette lineage diverges from the
// server's (e.g. an optimistic hook-free paste vs the server's hook-run
// echo) must reconcile an incremental ops message by re-interning each id
// into its OWN slot space — never by adopting the server's slot indices.
// regression guard for the [voxel-drift][ops-palette] hard crash.

import { describe, expect, it } from 'vitest';
import { packServerMessage, unpackServerMessage } from '../../../../src/core/protocol';
import { resolveKey } from '../../../../src/core/voxels/block-registry';
import { buildTestRegistry } from '../../../../src/core/voxels/test-helpers';
import { createVoxels, ensureChunk, ensureChunkPaletteSlot, voxelIndex } from '../../../../src/core/voxels/voxels';

describe('voxel wire palette decoupling', () => {
    const registry = buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'dirt', texId: 'dirt' },
        { id: 'glass', texId: 'glass' },
    ]);
    const stoneId = resolveKey(registry, 'stone');
    const dirtId = resolveKey(registry, 'dirt');
    const glassId = resolveKey(registry, 'glass');

    it('voxel_chunk_ops carries global state ids and survives pack round-trip', () => {
        const msg = packServerMessage({
            type: 'voxel_chunk_ops',
            playerId: 0,
            chunks: [
                {
                    cx: 0,
                    cy: 1,
                    cz: 0,
                    changes: [
                        { index: 0, stateId: stoneId },
                        { index: 5, stateId: glassId },
                    ],
                },
            ],
        });
        const back = unpackServerMessage(msg);
        expect(back?.type).toBe('voxel_chunk_ops');
        if (back?.type !== 'voxel_chunk_ops') throw new Error('unreachable');
        expect(back.chunks[0]!.changes).toEqual([
            { index: 0, stateId: stoneId },
            { index: 5, stateId: glassId },
        ]);
    });

    it('a diverged client palette reconciles an ops message by re-interning ids', () => {
        // client mode (authority=null): a local optimistic apply that appended
        // blocks in a DIFFERENT order than the server would. here the client's
        // slot 1 = glass, slot 2 = dirt.
        const voxels = createVoxels(registry);
        const chunk = ensureChunk(voxels, 0, 1, 0);
        ensureChunkPaletteSlot(chunk, 'glass', registry); // client slot 1
        ensureChunkPaletteSlot(chunk, 'dirt', registry); // client slot 2

        // the server, meanwhile, interned stone first (its slot 1) — a fully
        // different lineage. the wire only ships the global id, so translation
        // is by id, not slot. simulate the ingest translate loop:
        const serverChanges = [
            { index: voxelIndex(0, 0, 0), stateId: stoneId }, // server slot 1, absent on client
            { index: voxelIndex(1, 0, 0), stateId: dirtId }, // client already has dirt at slot 2
        ];
        for (const change of serverChanges) {
            const key = registry.stateToKey[change.stateId]!;
            const slot = ensureChunkPaletteSlot(chunk, key, registry);
            chunk.data[change.index] = slot;
        }

        // stone was unknown to the client → interned as a fresh slot (3), NOT
        // slot 1 (which is glass). dirt reused the client's existing slot 2.
        expect(chunk.palette[chunk.data[voxelIndex(0, 0, 0)]!]).toBe(stoneId);
        expect(chunk.palette[chunk.data[voxelIndex(1, 0, 0)]!]).toBe(dirtId);
        expect(chunk.paletteMap.get('glass')).toBe(1); // untouched, no re-aliasing
        expect(chunk.paletteMap.get('dirt')).toBe(2);
        expect(chunk.paletteMap.get('stone')).toBe(3);
        // and the untouched glass slot still resolves correctly
        expect(chunk.palette[1]).toBe(glassId);
    });
});
