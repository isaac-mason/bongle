// The hanging family: a chain supports a lantern below it, a lantern hangs
// from a ceiling click and stands from any other, and re-homes when its
// support goes.

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tile } from '../../../../src/core/registry';
import * as blockPreset from '../../../../src/core/voxels/block-presets';
import { getLanternLit, setLanternLit } from '../../../../src/core/voxels/block-presets';
import { BLOCK_FLAG_COLLISION, BLOCK_FLAG_SUPPORTS_HANGING } from '../../../../src/core/voxels/block-registry';
import type { BlockPlaceCtx } from '../../../../src/core/voxels/blocks';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, getBlockState, setChunkBlock } from '../../../../src/core/voxels/voxels';

beforeAll(() => registerAllShapes());
beforeEach(() => resetVoxelRegistry());

const placeCtx = (normalY: number): BlockPlaceCtx => ({
    worldX: 4,
    worldY: 4,
    worldZ: 4,
    normalX: 0,
    normalY,
    normalZ: 0,
    hitX: 0.5,
    hitY: 0.5,
    hitZ: 0.5,
    yaw: 0,
    pitch: 0,
});

function world() {
    const lantern = blockPreset.lantern('t:lantern', {
        tiles: { lit: tile('t:lantern_lit', { src: 'l.png' }), unlit: tile('t:lantern_off', { src: 'o.png' }) },
    });
    const chain = blockPreset.chain('t:chain', { tiles: tile('t:chain_tex', { src: 'c.png' }) });
    const reg = buildTestRegistry([{ id: 't:stone', texId: 't:stone_tex' }]);
    const voxels = createVoxels(reg);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    const set = (x: number, y: number, z: number, key: string) => setChunkBlock(voxels, chunk, x, y, z, key);
    return { lantern, chain, reg, voxels, set };
}

describe('chain', () => {
    it('is an axis block that supports hanging blocks', () => {
        const { chain, reg } = world();
        expect(reg.flags[chain.stateId({ axis: 'y' })]! & BLOCK_FLAG_SUPPORTS_HANGING).not.toBe(0);
        const writes: string[] = [];
        chain.def.place?.(placeCtx(1), { get: () => 'air', set: (_x, _y, _z, key) => writes.push(key) });
        expect(writes).toEqual([chain.stateKey({ axis: 'y' })]);
    });
});

describe('lantern', () => {
    it('hangs from a ceiling click and stands from a floor click', () => {
        const { lantern } = world();
        const writes: string[] = [];
        const io = { get: () => 'air', set: (_x: number, _y: number, _z: number, key: string) => writes.push(key) };
        lantern.def.place?.(placeCtx(-1), io);
        lantern.def.place?.(placeCtx(1), io);
        expect(writes).toEqual([lantern.stateKey({ hanging: true, lit: true }), lantern.stateKey({ hanging: false, lit: true })]);
    });

    it('keeps hanging under a chain, and re-homes to the floor when the chain goes', () => {
        const { lantern, chain, voxels, set } = world();
        set(4, 5, 4, chain.stateKey({ axis: 'y' }));
        set(4, 3, 4, 't:stone');
        set(4, 4, 4, lantern.stateKey({ hanging: true, lit: true }));
        const ctx = () => ({ voxels, worldX: 4, worldY: 4, worldZ: 4, stateId: getBlockState(voxels, 4, 4, 4) });
        expect(lantern.def.onNeighbourUpdate?.(ctx())).toBe(lantern.stateId({ hanging: true, lit: true }));
        set(4, 5, 4, 'air');
        expect(lantern.def.onNeighbourUpdate?.(ctx())).toBe(lantern.stateId({ hanging: false, lit: true }));
    });

    it('stays put with no support on either side, like the torch', () => {
        const { lantern, voxels, set } = world();
        set(4, 4, 4, lantern.stateKey({ hanging: true, lit: true }));
        const result = lantern.def.onNeighbourUpdate?.({
            voxels,
            worldX: 4,
            worldY: 4,
            worldZ: 4,
            stateId: getBlockState(voxels, 4, 4, 4),
        });
        expect(result).toBe(lantern.stateId({ hanging: true, lit: true }));
    });

    it('lifts its geometry and shape by a texel when hanging', () => {
        const { lantern, reg } = world();
        const floor = reg.meshQuadVerts[reg.meshId[lantern.stateId({ hanging: false, lit: true })]!]!;
        const hung = reg.meshQuadVerts[reg.meshId[lantern.stateId({ hanging: true, lit: true })]!]!;
        const minY = (verts: Float32Array) => Math.min(...Array.from({ length: verts.length / 3 }, (_, i) => verts[i * 3 + 1]!));
        expect(minY(floor)).toBe(0);
        expect(minY(hung)).toBeCloseTo(1 / 16, 6);
        // the hanging handle reaches the ceiling
        const maxY = (verts: Float32Array) => Math.max(...Array.from({ length: verts.length / 3 }, (_, i) => verts[i * 3 + 1]!));
        expect(maxY(hung)).toBeCloseTo(1, 6);
        expect(maxY(floor)).toBeCloseTo(11 / 16, 6);
    });

    it('lights and puts out in place, keeping how it hangs', () => {
        const { lantern, chain, reg, voxels, set } = world();
        set(4, 5, 4, chain.stateKey({ axis: 'y' }));
        set(4, 4, 4, lantern.stateKey({ hanging: true, lit: true }));
        expect(getLanternLit(voxels, 4, 4, 4)).toBe(true);
        expect(reg.lightEmission[getBlockState(voxels, 4, 4, 4)]).not.toBe(0);

        setLanternLit(voxels, 4, 4, 4, false);
        expect(getLanternLit(voxels, 4, 4, 4)).toBe(false);
        expect(getBlockState(voxels, 4, 4, 4)).toBe(lantern.stateId({ hanging: true, lit: false }));
        expect(reg.lightEmission[getBlockState(voxels, 4, 4, 4)]).toBe(0);
        expect(reg.meshId[lantern.stateId({ hanging: true, lit: false })]).not.toBe(
            reg.meshId[lantern.stateId({ hanging: true, lit: true })],
        );

        // re-homing keeps the lantern out
        set(4, 5, 4, 'air');
        set(4, 3, 4, 't:stone');
        const ctx = { voxels, worldX: 4, worldY: 4, worldZ: 4, stateId: getBlockState(voxels, 4, 4, 4) };
        expect(lantern.def.onNeighbourUpdate?.(ctx)).toBe(lantern.stateId({ hanging: false, lit: false }));
    });

    it('ignores cells that are not lanterns', () => {
        const { voxels, set } = world();
        set(4, 4, 4, 't:stone');
        const before = getBlockState(voxels, 4, 4, 4);
        expect(getLanternLit(voxels, 4, 4, 4)).toBe(false);
        setLanternLit(voxels, 4, 4, 4, true);
        expect(getBlockState(voxels, 4, 4, 4)).toBe(before);
    });
});

describe('collision', () => {
    it('both collide on their thin shapes', () => {
        const { lantern, chain, reg } = world();
        expect(reg.flags[chain.stateId({ axis: 'y' })]! & BLOCK_FLAG_COLLISION).not.toBe(0);
        expect(reg.flags[lantern.stateId({ hanging: false, lit: true })]! & BLOCK_FLAG_COLLISION).not.toBe(0);
    });
});
