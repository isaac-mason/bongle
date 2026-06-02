// ── block hook observers e2e ─────────────────────────────────────────
//
// drives onBlockBuild / onBlockBreak / onBlockStateChange through the
// real script-scope APIs — registers observers from inside a script,
// mutates voxels via setBlock, ticks the server, asserts the
// callbacks fired with the right classification.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    addTrait,
    block,
    blockState,
    onBlockBreak,
    onBlockBuild,
    onBlockStateChange,
    onJoin,
    script,
    setBlock,
    trait,
} from 'bongle';
import { createTestHarness, type TestHarness } from './harness';

describe('block hook observers (e2e)', () => {
    let harness: TestHarness<unknown> | null = null;

    afterEach(() => {
        harness?.dispose();
        harness = null;
    });

    it('onBlockBuild fires when air becomes a block', async () => {
        const onBuild = vi.fn();
        harness = await createTestHarness((root) => {
            const Stone = block('stone', { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });
            const Gameplay = trait('gameplay', {}, { persist: false });
            script(Gameplay, 'session', (ctx) => {
                onBlockBuild(ctx, Stone, onBuild);
                onJoin(ctx, () => {});
            });
            addTrait(root, Gameplay);
        });
        await harness.connect();
        harness.tick();

        setBlock(harness.room.voxels, 1, 1, 1, 'stone');
        harness.tick();

        expect(onBuild).toHaveBeenCalledTimes(1);
        const ev = onBuild.mock.calls[0]![0];
        expect(ev.worldX).toBe(1);
        expect(ev.worldY).toBe(1);
        expect(ev.worldZ).toBe(1);
    });

    it('onBlockBreak fires when a block becomes air', async () => {
        const onBreak = vi.fn();
        harness = await createTestHarness((root) => {
            const Stone = block('stone', { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });
            const Gameplay = trait('gameplay', {}, { persist: false });
            script(Gameplay, 'session', (ctx) => {
                onBlockBreak(ctx, Stone, onBreak);
                onJoin(ctx, () => {});
            });
            addTrait(root, Gameplay);
        });
        await harness.connect();
        harness.tick();

        setBlock(harness.room.voxels, 2, 2, 2, 'stone');
        harness.tick();
        setBlock(harness.room.voxels, 2, 2, 2, 'air');
        harness.tick();

        expect(onBreak).toHaveBeenCalledTimes(1);
    });

    it('block→block change fires onBlockBreak(old) + onBlockBuild(new)', async () => {
        const stoneBuild = vi.fn();
        const stoneBreak = vi.fn();
        const dirtBuild = vi.fn();
        const dirtBreak = vi.fn();
        harness = await createTestHarness((root) => {
            const Stone = block('stone', { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });
            const Dirt = block('dirt', { model: () => ({ type: 'cube', textures: { all: { texture: 'dirt' } } }) });
            const Gameplay = trait('gameplay', {}, { persist: false });
            script(Gameplay, 'session', (ctx) => {
                onBlockBuild(ctx, Stone, stoneBuild);
                onBlockBreak(ctx, Stone, stoneBreak);
                onBlockBuild(ctx, Dirt, dirtBuild);
                onBlockBreak(ctx, Dirt, dirtBreak);
                onJoin(ctx, () => {});
            });
            addTrait(root, Gameplay);
        });
        await harness.connect();
        harness.tick();

        setBlock(harness.room.voxels, 3, 3, 3, 'stone');
        harness.tick();
        setBlock(harness.room.voxels, 3, 3, 3, 'dirt');
        harness.tick();

        expect(stoneBuild).toHaveBeenCalledTimes(1);
        expect(stoneBreak).toHaveBeenCalledTimes(1);
        expect(dirtBuild).toHaveBeenCalledTimes(1);
        expect(dirtBreak).not.toHaveBeenCalled();
    });

    it('onBlockStateChange fires on same-block stateId change', async () => {
        const onState = vi.fn();
        const result = await createTestHarness((root) => {
            const LampState = blockState.create({ lit: blockState.bool() });
            const Lamp = block('lamp', {
                states: LampState,
                model: () => ({ type: 'cube', textures: { all: { texture: 'lamp' } } }),
            });
            const Gameplay = trait('gameplay', {}, { persist: false });
            script(Gameplay, 'session', (ctx) => {
                onBlockStateChange(ctx, Lamp, onState);
                onJoin(ctx, () => {});
            });
            addTrait(root, Gameplay);
            return { Lamp };
        });
        harness = result;
        await harness.connect();
        harness.tick();

        const Lamp = result.data.Lamp;
        setBlock(harness.room.voxels, 4, 4, 4, Lamp.stateKey({ lit: false }));
        harness.tick();
        setBlock(harness.room.voxels, 4, 4, 4, Lamp.stateKey({ lit: true }));
        harness.tick();

        expect(onState).toHaveBeenCalledTimes(1);
        const ev = onState.mock.calls[0]![0];
        expect(ev.worldX).toBe(4);
        expect(ev.oldStateId).not.toBe(ev.stateId);
    });
});
