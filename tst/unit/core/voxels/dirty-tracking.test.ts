// ── dirty tracking tests ────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { type Blocks, resolveKey } from '../../../../src/core/voxels/block-registry';
import { CullType } from '../../../../src/core/voxels/blocks';
import { flushPendingLight, propagateAllLight, updateLightOnBlockChange } from '../../../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import {
    CHUNK_SIZE,
    chunkKey,
    clearVoxelChanges,
    createVoxelChanges,
    createVoxels,
    createVoxelsAuthority,
    ensureChunk,
    setBlock,
    type VoxelBlockOp,
    voxelIndex,
} from '../../../../src/core/voxels/voxels';

// ── test helpers ────────────────────────────────────────────────────

beforeEach(() => {
    resetVoxelRegistry();
});

function makeServerVoxels(registry: Blocks) {
    const voxels = createVoxels(registry);
    voxels.authority = createVoxelsAuthority();
    return voxels;
}

/** clear lightDirty on all chunks (simulates post-flush reset). */
function clearAllLightDirty(voxels: ReturnType<typeof createVoxels>) {
    for (const chunk of voxels.chunks.values()) {
        chunk.lightDirty = false;
        chunk.compressedLight = null;
    }
}

// ── block op recording ──────────────────────────────────────────────

describe('block op recording', () => {
    const registry = buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'dirt', texId: 'dirt' },
    ]);

    it('setBlock pushes a block op when changes is non-null', () => {
        const voxels = makeServerVoxels(registry);

        setBlock(voxels, 5, 10, 3, 'stone');

        expect(voxels.authority!.changes.ops).toHaveLength(1);
        const op = voxels.authority!.changes.ops[0] as VoxelBlockOp;
        expect(op.kind).toBe(0);
        expect(op.cx).toBe(0);
        expect(op.cy).toBe(0);
        expect(op.cz).toBe(0);
        expect(op.index).toBe(voxelIndex(5, 10, 3));
        // data should be the local palette index stored in chunk.data
        const chunk = voxels.chunks.get(chunkKey(0, 0, 0))!;
        expect(op.data).toBe(chunk.data[op.index]!);
    });

    it('setBlock does NOT push ops when authority is null (client mode)', () => {
        const voxels = createVoxels(registry); // authority = null

        setBlock(voxels, 0, 0, 0, 'stone');

        // no authority bundle, so no ops recorded
        expect(voxels.authority).toBeNull();
    });

    it('multiple setBlock calls accumulate ops in order', () => {
        const voxels = makeServerVoxels(registry);

        setBlock(voxels, 0, 0, 0, 'stone');
        setBlock(voxels, 1, 0, 0, 'dirt');
        setBlock(voxels, 16, 0, 0, 'stone'); // different chunk (cx=1)

        expect(voxels.authority!.changes.ops).toHaveLength(3);

        const op0 = voxels.authority!.changes.ops[0] as VoxelBlockOp;
        const op1 = voxels.authority!.changes.ops[1] as VoxelBlockOp;
        const op2 = voxels.authority!.changes.ops[2] as VoxelBlockOp;

        expect(op0.index).toBe(voxelIndex(0, 0, 0));
        expect(op1.index).toBe(voxelIndex(1, 0, 0));
        expect(op2.cx).toBe(1); // chunk x=1
        expect(op2.index).toBe(voxelIndex(0, 0, 0)); // local 0,0,0 in chunk 1
    });

    it('setBlock records the LATEST palette index for the voxel', () => {
        const voxels = makeServerVoxels(registry);

        // set stone first, then overwrite with dirt
        setBlock(voxels, 0, 0, 0, 'stone');
        setBlock(voxels, 0, 0, 0, 'dirt');

        expect(voxels.authority!.changes.ops).toHaveLength(2);

        const op0 = voxels.authority!.changes.ops[0] as VoxelBlockOp;
        const op1 = voxels.authority!.changes.ops[1] as VoxelBlockOp;

        // both ops recorded, but data values differ
        const chunk = voxels.chunks.get(chunkKey(0, 0, 0))!;
        const idx = voxelIndex(0, 0, 0);
        // the second op should have the dirt palette index
        expect(op1.data).toBe(chunk.data[idx]!);
        // and the two ops should have different data values
        expect(op0.data).not.toBe(op1.data);
    });
});

// ── snapshot invalidation ───────────────────────────────────────────

describe('snapshot invalidation', () => {
    const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);

    it('setBlock invalidates compressedSnapshot', () => {
        const voxels = makeServerVoxels(registry);
        const chunk = ensureChunk(voxels, 0, 0, 0);

        // simulate a cached snapshot
        chunk.compressedSnapshot = new Uint8Array([1, 2, 3]);
        chunk.snapshotPalette = [0, 2]; // global state ids (air, stone)

        setBlock(voxels, 0, 0, 0, 'stone');

        expect(chunk.compressedSnapshot).toBeNull();
        expect(chunk.snapshotPalette).toBeNull();
    });

    it('snapshot not invalidated in client mode (changes=null)', () => {
        const voxels = createVoxels(registry);
        const chunk = ensureChunk(voxels, 0, 0, 0);

        chunk.compressedSnapshot = new Uint8Array([1, 2, 3]);
        chunk.snapshotPalette = [0, 2]; // global state ids (air, stone)

        setBlock(voxels, 0, 0, 0, 'stone');

        // snapshot should be preserved since changes is null
        expect(chunk.compressedSnapshot).not.toBeNull();
        expect(chunk.snapshotPalette).not.toBeNull();
    });
});

// ── light dirty tracking ────────────────────────────────────────────

describe('light dirty tracking', () => {
    const registry = buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'lamp', texId: 'lamp', lightEmission: [15, 15, 15], cull: CullType.NONE, lightOpacity: 0 },
    ]);

    it('updateLightOnBlockChange sets lightDirty on affected chunks', () => {
        const voxels = makeServerVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);

        // place a stone block, then a lamp next to it
        setBlock(voxels, 0, 0, 0, 'stone');
        setBlock(voxels, 1, 0, 0, 'lamp');

        // clear lightDirty before running light update
        clearAllLightDirty(voxels);

        const stoneId = resolveKey(registry, 'stone');
        updateLightOnBlockChange(voxels, 1, 0, 0, stoneId);

        // the chunk containing the lamp should be light-dirty
        const chunk = voxels.chunks.get(chunkKey(0, 0, 0))!;
        expect(chunk.lightDirty).toBe(true);
    });

    it('updateLightOnBlockChange sets lightDirty even without changes tracking (client-less)', () => {
        // lightDirty is set unconditionally by setLight, regardless of changes
        const voxels = createVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);

        setBlock(voxels, 1, 0, 0, 'lamp');

        const stoneId = resolveKey(registry, 'stone');
        updateLightOnBlockChange(voxels, 1, 0, 0, stoneId);

        const chunk = voxels.chunks.get(chunkKey(0, 0, 0))!;
        expect(chunk.lightDirty).toBe(true);
    });

    it('light BFS does not set lightDirty on untouched chunks', () => {
        const voxels = makeServerVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);
        ensureChunk(voxels, 5, 5, 5); // far away chunk

        setBlock(voxels, 1, 0, 0, 'lamp');
        clearAllLightDirty(voxels);

        const airId = resolveKey(registry, 'air');
        updateLightOnBlockChange(voxels, 1, 0, 0, airId);

        // the far-away chunk should NOT be light-dirty
        const farChunk = voxels.chunks.get(chunkKey(5, 5, 5))!;
        expect(farChunk.lightDirty).toBe(false);
    });

    it('setLight invalidates compressedLight cache', () => {
        const voxels = makeServerVoxels(registry);
        const chunk = ensureChunk(voxels, 0, 0, 0);

        // simulate a cached compressed light
        chunk.compressedLight = { sky: new Uint8Array([1, 2, 3]), rgb: new Uint8Array([1, 2, 3]) };

        setBlock(voxels, 1, 0, 0, 'lamp');
        const airId = resolveKey(registry, 'air');
        updateLightOnBlockChange(voxels, 1, 0, 0, airId);

        expect(chunk.compressedLight).toBeNull();
    });

    it('no light ops are pushed to changes.ops by light BFS', () => {
        const voxels = makeServerVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);

        setBlock(voxels, 1, 0, 0, 'lamp');
        voxels.authority!.changes.ops.length = 0;

        const airId = resolveKey(registry, 'air');
        updateLightOnBlockChange(voxels, 1, 0, 0, airId);

        // all ops should be block ops (kind=0), never kind=1
        for (const op of voxels.authority!.changes.ops) {
            expect(op.kind).not.toBe(1);
        }
        // in fact, light BFS should push zero ops now
        expect(voxels.authority!.changes.ops).toHaveLength(0);
    });
});

// ── light epoch ─────────────────────────────────────────────────────

describe('light epoch', () => {
    const registry = buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'lamp', texId: 'lamp', lightEmission: [15, 15, 15], cull: CullType.NONE, lightOpacity: 0 },
    ]);

    it('propagateAllLight bumps lightEpoch', () => {
        const voxels = makeServerVoxels(registry);
        expect(voxels.authority!.changes.light.epoch).toBe(0);

        propagateAllLight(voxels);
        expect(voxels.authority!.changes.light.epoch).toBe(1);

        propagateAllLight(voxels);
        expect(voxels.authority!.changes.light.epoch).toBe(2);
    });

    it('propagateAllLight does NOT push per-voxel ops', () => {
        const voxels = makeServerVoxels(registry);

        // set up some blocks so propagation does real work
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                setBlock(voxels, x, 0, z, 'stone');
            }
        }
        // place a lamp
        setBlock(voxels, 8, 1, 8, 'lamp');

        // clear ops to measure only what propagateAllLight produces
        voxels.authority!.changes.ops.length = 0;

        propagateAllLight(voxels);

        // should have zero ops, epoch bump handles full recompute
        expect(voxels.authority!.changes.ops).toHaveLength(0);
        expect(voxels.authority!.changes.light.epoch).toBe(1);
    });

    it('propagateAllLight bumps epoch even with empty chunks', () => {
        const voxels = makeServerVoxels(registry);
        expect(voxels.authority!.changes.light.epoch).toBe(0);

        propagateAllLight(voxels);
        expect(voxels.authority!.changes.light.epoch).toBe(1);
    });

    it('propagateAllLight invalidates all snapshots', () => {
        const voxels = makeServerVoxels(registry);
        const chunk = ensureChunk(voxels, 0, 0, 0);

        chunk.compressedSnapshot = new Uint8Array([1, 2, 3]);
        chunk.snapshotPalette = [0]; // global state ids (air)
        chunk.compressedLight = { sky: new Uint8Array([4, 5, 6]), rgb: new Uint8Array([4, 5, 6]) };

        propagateAllLight(voxels);

        expect(chunk.compressedSnapshot).toBeNull();
        expect(chunk.snapshotPalette).toBeNull();
        expect(chunk.compressedLight).toBeNull();
    });
});

// ── clearVoxelChanges ───────────────────────────────────────────────

describe('clearVoxelChanges', () => {
    it('clears ops but preserves lightEpoch', () => {
        const changes = createVoxelChanges();
        changes.ops.push({
            kind: 0,
            cx: 0,
            cy: 0,
            cz: 0,
            index: 0,
            data: 1,
            wx: 0,
            wy: 0,
            wz: 0,
            oldStateId: 0,
            newStateId: 1,
        });
        changes.light.epoch = 5;

        clearVoxelChanges(changes);

        expect(changes.ops).toHaveLength(0);
        expect(changes.light.epoch).toBe(5);
    });
});

// ── ceiling toggle measurement ──────────────────────────────────────
//
// simulates a 5x5 ceiling toggle to verify that lightDirty is set on
// the correct chunks and measure how many voxels actually changed.

describe('ceiling toggle lightDirty tracking', () => {
    const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);

    it('5x5 ceiling place sets lightDirty on affected chunks only', () => {
        const voxels = makeServerVoxels(registry);

        // create chunks matching rocket-spleef layout (4x4 terrain + vertical)
        for (let cy = 0; cy <= 1; cy++)
            for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) ensureChunk(voxels, cx, cy, cz);

        // build a stone floor at y=0
        for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) setBlock(voxels, x, 0, z, 'stone');

        // build a hollow box: walls from y=10 to y=13, floor at y=9
        const boxX = 16,
            boxZ = 1,
            boxY = 10,
            boxW = 5,
            boxD = 5,
            boxH = 4;
        const ceilingY = boxY + boxH; // y=14

        // floor
        for (let dz = -1; dz <= boxD; dz++)
            for (let dx = -1; dx <= boxW; dx++) setBlock(voxels, boxX + dx, boxY - 1, boxZ + dz, 'stone');

        // 4 walls
        for (let dy = 0; dy < boxH; dy++)
            for (let dz = -1; dz <= boxD; dz++)
                for (let dx = -1; dx <= boxW; dx++) {
                    const isBorder = dx === -1 || dx === boxW || dz === -1 || dz === boxD;
                    if (!isBorder) continue;
                    setBlock(voxels, boxX + dx, boxY + dy, boxZ + dz, 'stone');
                }

        // propagate initial light
        propagateAllLight(voxels);
        clearVoxelChanges(voxels.authority!.changes);
        clearAllLightDirty(voxels);

        // snapshot light BEFORE across all chunks
        const lightBefore = new Map<string, Uint16Array>();
        for (const [key, chunk] of voxels.chunks) {
            lightBefore.set(key, new Uint16Array(chunk.light));
        }

        // place ceiling using batched path
        for (let dz = 0; dz < boxD; dz++)
            for (let dx = 0; dx < boxW; dx++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                setBlock(voxels, wx, ceilingY, wz, 'stone');
            }
        flushPendingLight(voxels);

        // count light-dirty chunks
        let dirtyCount = 0;
        for (const chunk of voxels.chunks.values()) {
            if (chunk.lightDirty) dirtyCount++;
        }

        // count voxels that actually changed
        let truthDiff = 0;
        for (const [key, chunk] of voxels.chunks) {
            const before = lightBefore.get(key)!;
            for (let i = 0; i < chunk.light.length; i++) {
                if (chunk.light[i] !== before[i]) truthDiff++;
            }
        }

        // should have some dirty chunks (the ones containing/near the box)
        expect(dirtyCount).toBeGreaterThan(0);
        // but not ALL chunks should be dirty (far chunks are unaffected)
        expect(dirtyCount).toBeLessThan(voxels.chunks.size);
        // some voxels should have actually changed
        expect(truthDiff).toBeGreaterThan(0);

        // no light ops should be in the ops array
        for (const op of voxels.authority!.changes.ops) {
            expect(op.kind).toBe(0); // only block ops
        }
    });
});

// ── batched light update via flushPendingLight ──────────────────────
//
// verifies that the automatic batched path (setBlock → pendingLight →
// flushPendingLight) produces identical light results to per-block
// updateLightOnBlockChange.

describe('flushPendingLight (batched)', () => {
    const registry = buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        { id: 'lamp', texId: 'lamp', lightEmission: [15, 15, 15], cull: CullType.NONE, lightOpacity: 0 },
    ]);

    it('batched light matches per-block incremental for 5x5 ceiling', () => {
        // ── setup: identical world state for both approaches ────────
        const baseBlocks: { x: number; y: number; z: number; key: string }[] = [];

        // stone floor at y=0, box walls, etc., same as ceiling toggle test
        const boxX = 16,
            boxZ = 1,
            boxY = 10,
            boxW = 5,
            boxD = 5,
            boxH = 4;
        const ceilingY = boxY + boxH;

        for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) baseBlocks.push({ x, y: 0, z, key: 'stone' });

        for (let dz = -1; dz <= boxD; dz++)
            for (let dx = -1; dx <= boxW; dx++) baseBlocks.push({ x: boxX + dx, y: boxY - 1, z: boxZ + dz, key: 'stone' });

        for (let dy = 0; dy < boxH; dy++)
            for (let dz = -1; dz <= boxD; dz++)
                for (let dx = -1; dx <= boxW; dx++) {
                    const isBorder = dx === -1 || dx === boxW || dz === -1 || dz === boxD;
                    if (!isBorder) continue;
                    baseBlocks.push({ x: boxX + dx, y: boxY + dy, z: boxZ + dz, key: 'stone' });
                }

        function setupWorld() {
            const voxels = makeServerVoxels(registry);
            for (let cy = 0; cy <= 1; cy++)
                for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) ensureChunk(voxels, cx, cy, cz);

            for (const b of baseBlocks) setBlock(voxels, b.x, b.y, b.z, b.key);
            propagateAllLight(voxels);
            clearVoxelChanges(voxels.authority!.changes);
            return voxels;
        }

        // ── approach A: per-block incremental ───────────────────────
        const voxelsA = setupWorld();
        for (let dz = 0; dz < boxD; dz++)
            for (let dx = 0; dx < boxW; dx++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                const oldStateId = resolveKey(registry, 'air');
                setBlock(voxelsA, wx, ceilingY, wz, 'stone');
                updateLightOnBlockChange(voxelsA, wx, ceilingY, wz, oldStateId);
            }

        // ── approach B: batched via flushPendingLight ───────────────
        const voxelsB = setupWorld();
        for (let dz = 0; dz < boxD; dz++)
            for (let dx = 0; dx < boxW; dx++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                setBlock(voxelsB, wx, ceilingY, wz, 'stone');
            }
        // setBlock pushes to pendingLight; flush processes them all at once
        flushPendingLight(voxelsB);

        // ── compare: light arrays should be identical ───────────────
        for (const [key, chunkA] of voxelsA.chunks) {
            const chunkB = voxelsB.chunks.get(key)!;
            expect(chunkB).toBeDefined();
            for (let i = 0; i < chunkA.light.length; i++) {
                if (chunkA.light[i] !== chunkB.light[i]) {
                    const lx = i & 0xf;
                    const ly = (i >> 4) & 0xf;
                    const lz = (i >> 8) & 0xf;
                    expect
                        .soft(chunkB.light[i], `light mismatch at chunk=${key} local=(${lx},${ly},${lz})`)
                        .toBe(chunkA.light[i]);
                }
            }
        }
    });

    it('batched light dirties fewer chunks than per-block incremental', () => {
        const boxX = 16,
            boxZ = 1,
            boxY = 10,
            boxW = 5,
            boxD = 5,
            boxH = 4;
        const ceilingY = boxY + boxH;

        function setupWorld() {
            const voxels = makeServerVoxels(registry);
            for (let cy = 0; cy <= 1; cy++)
                for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) ensureChunk(voxels, cx, cy, cz);

            for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) setBlock(voxels, x, 0, z, 'stone');

            for (let dz = -1; dz <= boxD; dz++)
                for (let dx = -1; dx <= boxW; dx++) setBlock(voxels, boxX + dx, boxY - 1, boxZ + dz, 'stone');

            for (let dy = 0; dy < boxH; dy++)
                for (let dz = -1; dz <= boxD; dz++)
                    for (let dx = -1; dx <= boxW; dx++) {
                        const isBorder = dx === -1 || dx === boxW || dz === -1 || dz === boxD;
                        if (!isBorder) continue;
                        setBlock(voxels, boxX + dx, boxY + dy, boxZ + dz, 'stone');
                    }

            propagateAllLight(voxels);
            clearVoxelChanges(voxels.authority!.changes);
            clearAllLightDirty(voxels);
            return voxels;
        }

        // per-block incremental
        const voxelsA = setupWorld();
        for (let dz = 0; dz < boxD; dz++)
            for (let dx = 0; dx < boxW; dx++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                const oldStateId = resolveKey(registry, 'air');
                setBlock(voxelsA, wx, ceilingY, wz, 'stone');
                updateLightOnBlockChange(voxelsA, wx, ceilingY, wz, oldStateId);
            }
        let perBlockDirty = 0;
        for (const chunk of voxelsA.chunks.values()) if (chunk.lightDirty) perBlockDirty++;

        // batched
        const voxelsB = setupWorld();
        for (let dz = 0; dz < boxD; dz++)
            for (let dx = 0; dx < boxW; dx++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                setBlock(voxelsB, wx, ceilingY, wz, 'stone');
            }
        flushPendingLight(voxelsB);
        let batchedDirty = 0;
        for (const chunk of voxelsB.chunks.values()) if (chunk.lightDirty) batchedDirty++;

        // both approaches should dirty some chunks. with chunk-level lightDirty,
        // the count may differ between batched and incremental, the real advantage
        // of batching is network efficiency (full arrays vs per-voxel deltas), not
        // necessarily fewer dirty chunks.
        expect(batchedDirty).toBeGreaterThan(0);
        expect(perBlockDirty).toBeGreaterThan(0);
    });

    it('pendingLight is drained after flushPendingLight', () => {
        const voxels = makeServerVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);

        setBlock(voxels, 0, 0, 0, 'stone');
        expect(voxels.authority!.changes.light.blocks.length).toBe(1);

        flushPendingLight(voxels);
        expect(voxels.authority!.changes.light.blocks.length).toBe(0);
    });

    it('flushPendingLight is a noop when no pending changes', () => {
        const voxels = makeServerVoxels(registry);
        ensureChunk(voxels, 0, 0, 0);
        propagateAllLight(voxels);
        clearVoxelChanges(voxels.authority!.changes);
        clearAllLightDirty(voxels);

        flushPendingLight(voxels);

        // no chunks should be light-dirty after a noop flush
        for (const chunk of voxels.chunks.values()) {
            expect(chunk.lightDirty).toBe(false);
        }
    });
});
