// ── kcc walking e2e test ─────────────────────────────────────────────
//
// boots the full engine, lays a flat floor of blocks, connects a client,
// attaches a character controller, walks forward, and asserts the
// character stays on the ground without jittering.

import { describe, expect, it, afterEach } from 'vitest';
import { addTrait, block, CharacterControllerTrait, getTrait, onJoin, script, setBlock, trait, TransformTrait } from 'bongle';
import { createTestHarness, type TestHarness } from './harness';

describe('kcc walking', () => {
    let harness: TestHarness<unknown> | null = null;

    afterEach(() => {
        harness?.dispose();
        harness = null;
    });

    it('should walk across a flat floor without y jitter', async () => {
        harness = await createTestHarness((root) => {
            block('stone', {
                model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }),
            });

            const Gameplay = trait('test-gameplay', {}, { persist: false });
            script(Gameplay, 'session', (ctx) => {
                onJoin(ctx, ({ playerNode }) => {
                    const transform = getTrait(playerNode, TransformTrait)!;
                    // spawn above the floor so the KCC falls and lands
                    transform.position = [5, 3, 5];
                    addTrait(playerNode, CharacterControllerTrait);
                });
            });

            addTrait(root, Gameplay);
        });

        // 30x30 floor of stone at y=0 — wide enough for 3s of forward walking
        // from x=5 without walking off the edge.
        const room = harness.room;
        for (let x = 0; x < 30; x++) {
            for (let z = 0; z < 30; z++) {
                setBlock(room.voxels, x, 0, z, 'stone');
            }
        }

        const client = await harness.connect();

        // first tick: server sends join_room, client processes it
        harness.tick();

        // let the character fall and settle on the floor (~2 seconds)
        harness.tickN(120);

        expect(client.room).not.toBeNull();
        expect(client.characterController).not.toBeNull();
        expect(client.transform).not.toBeNull();

        const cc = client.characterController!;
        const transform = client.transform!;

        expect(cc.state.grounded).toBe(true);

        const settledY = transform.position[1];
        expect(settledY).toBeGreaterThan(0.5);
        expect(settledY).toBeLessThan(2.0);

        // walk forward (positive X) for 3 seconds
        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2;

        const yPositions: number[] = [];
        for (let i = 0; i < 180; i++) {
            harness.tick();
            yPositions.push(transform.position[1]);
        }

        cc.input.move[1] = 0;

        expect(cc.state.grounded).toBe(true);

        const meanY = yPositions.reduce((a, b) => a + b, 0) / yPositions.length;
        const maxDeviation = Math.max(...yPositions.map((y) => Math.abs(y - meanY)));
        expect(maxDeviation).toBeLessThan(0.01);

        expect(transform.position[0]).toBeGreaterThan(settledY + 1);
    });
});
