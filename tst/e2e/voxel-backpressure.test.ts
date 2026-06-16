// ── voxel backpressure round-trip (e2e) ──────────────────────────────
//
// boots a real server + headless client, streams a chunk, and asserts the
// client decodes + acks it and the server frees its in-flight slot. exercises
// the full Part C loop: dispatchFull → voxel_chunk_full → client decode →
// voxel_ack → handleVoxelAck. (server-side caps/gates are unit-tested in
// discovery.test.ts; this covers the client ack seam those can't reach.)

import { afterEach, describe, expect, it } from 'vitest';
import { block, setBlock } from 'bongle';
import { createTestHarness, type TestHarness } from './harness';

describe('voxel backpressure (e2e)', () => {
    let harness: TestHarness<unknown> | null = null;

    afterEach(() => {
        harness?.dispose();
        harness = null;
    });

    it('client acks delivered chunks, freeing the server in-flight window', async () => {
        harness = await createTestHarness(() => {
            block('stone', { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });
        });
        const client = await harness.connect();
        harness.tickN(3); // join + initial scene sync

        // a solid chunk at the origin, then enough ticks for:
        // stream → decode → ack → server processes the ack.
        setBlock(harness.room.voxels, 0, 0, 0, 'stone');
        harness.tickN(20);

        const playerId = [...client.state.rooms.rooms.keys()][0]!;
        const clientRoom = client.state.rooms.rooms.get(playerId)!;

        // chunk delivered + decoded on the client.
        expect(clientRoom.voxels.chunks.has('0,0,0')).toBe(true);

        // server in-flight window drained → the ack round-tripped (otherwise the
        // chunk would still be outstanding).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const knowledge = (harness.server.discovery as any).clients.get(client.id)?.voxelKnowledge.get(playerId);
        expect(knowledge).toBeDefined();
        expect(knowledge.knownChunks.has('0,0,0')).toBe(true);
        expect(knowledge.inFlightFull.size).toBe(0);
    });
});
