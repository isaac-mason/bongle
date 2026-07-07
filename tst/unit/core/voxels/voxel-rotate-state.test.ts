// ── voxel-rotate state-rotation tests ──────────────────────────────
//
// regression coverage for the silent bug where rotateVoxelsByQuat used
// to remap voxel positions but leave per-block state untouched (a column
// oriented along X would still report axis=x after a 90° Y rotation, a
// stair facing=north would still report facing=north after rotation,
// etc.).
//
// the state-rotation pass goes through each block's `rotate` hook
// (block-presets.ts). convention: `cw=true` matches the position rotation
// (+X → -Z under axis='y'). a facing vector `north` (-Z) therefore rotates
// to `west` (-X) under one CW Y turn, cycling N → W → S → E → N.

import { registerAllShapes } from 'crashcat';
import type { Quat } from 'mathcat';
import { quat } from 'mathcat';
import { beforeAll, describe, expect, it } from 'vitest';
import { column, fence, stairs } from '../../../../src/core/voxels/block-presets';
import { buildBlockRegistry, parseKey } from '../../../../src/core/voxels/block-registry';
import type { BlockDef, BlockHandle, BlockTextureDef } from '../../../../src/core/voxels/blocks';
import { rotateVoxelsByQuat } from '../../../../src/core/voxels/voxel-rotate';
import { createVoxels, setBlock } from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

const oakTex: BlockTextureDef = {
    id: 'oak',
    dependency: { registry: 'blockTextures', id: 'oak' },
    frames: ['oak.png'],
    fps: 1,
    interpolate: false,
};
const oakEndTex: BlockTextureDef = {
    id: 'oak-end',
    dependency: { registry: 'blockTextures', id: 'oak-end' },
    frames: ['oak-end.png'],
    fps: 1,
    interpolate: false,
};
const stoneTex: BlockTextureDef = {
    id: 'stone',
    dependency: { registry: 'blockTextures', id: 'stone' },
    frames: ['stone.png'],
    fps: 1,
    interpolate: false,
};

const stairHandle = stairs('test:stairs', { all: { texture: stoneTex } }) as BlockHandle;
const columnHandle = column('test:column', { end: oakEndTex, side: oakTex }) as BlockHandle;
const fenceHandle = fence('test:fence', { all: { texture: oakTex } }) as BlockHandle;

const defs = new Map<string, BlockDef>([
    [stairHandle.id, stairHandle._def],
    [columnHandle.id, columnHandle._def],
    [fenceHandle.id, fenceHandle._def],
]);
const handles = new Map<string, BlockHandle>([
    [stairHandle.id, stairHandle as BlockHandle],
    [columnHandle.id, columnHandle as BlockHandle],
    [fenceHandle.id, fenceHandle as BlockHandle],
]);
const textures = new Map<string, BlockTextureDef>([
    [oakTex.id, oakTex],
    [oakEndTex.id, oakEndTex],
    [stoneTex.id, stoneTex],
]);

function makeVoxels() {
    const registry = buildBlockRegistry(defs, handles, textures);
    return createVoxels(registry);
}

function quatY(deg: number): Quat {
    const q: Quat = [0, 0, 0, 1];
    quat.setAxisAngle(q, [0, 1, 0], (deg * Math.PI) / 180);
    return q;
}

/** find the one and only non-air cell in a rotated voxels and return its key. */
function singleBlock(v: ReturnType<typeof makeVoxels>): { wx: number; wy: number; wz: number; key: string } {
    for (const chunk of v.chunks.values()) {
        if (chunk.aggregate === 0) continue;
        for (let ly = 0; ly < 16; ly++) {
            for (let lz = 0; lz < 16; lz++) {
                for (let lx = 0; lx < 16; lx++) {
                    const idx = (ly << 8) | (lz << 4) | lx;
                    const palette = chunk.data[idx]!;
                    const key = chunk.paletteKeys[palette];
                    if (!key || key === 'air') continue;
                    return { wx: chunk.wx + lx, wy: chunk.wy + ly, wz: chunk.wz + lz, key };
                }
            }
        }
    }
    throw new Error('no non-air block found');
}

describe('rotateVoxelsByQuat — per-block state', () => {
    it('column axis=x rotates to axis=z under 90° Y CW', () => {
        const v = makeVoxels();
        setBlock(v, 0, 0, 0, 'test:column[axis=x]');
        const rotated = rotateVoxelsByQuat(v, quatY(90), v.registry);
        const block = singleBlock(rotated);
        expect(block.key).toBe('test:column[axis=z]');
    });

    it('column axis=z rotates to axis=x under 90° Y CW', () => {
        const v = makeVoxels();
        setBlock(v, 0, 0, 0, 'test:column[axis=z]');
        const rotated = rotateVoxelsByQuat(v, quatY(90), v.registry);
        const block = singleBlock(rotated);
        expect(block.key).toBe('test:column[axis=x]');
    });

    it('column axis=y is invariant under Y rotation', () => {
        const v = makeVoxels();
        setBlock(v, 0, 0, 0, 'test:column[axis=y]');
        const rotated = rotateVoxelsByQuat(v, quatY(90), v.registry);
        const block = singleBlock(rotated);
        expect(block.key).toBe('test:column[axis=y]');
    });

    it('stair facing=north cycles to facing=west under 90° Y CW', () => {
        const v = makeVoxels();
        setBlock(v, 0, 0, 0, 'test:stairs[facing=north,half=bottom,shape=straight]');
        const rotated = rotateVoxelsByQuat(v, quatY(90), v.registry);
        const block = singleBlock(rotated);
        const parsed = parseKey(block.key)!;
        expect(parsed.blockId).toBe('test:stairs');
        expect(parsed.props.facing).toBe('west');
    });

    it('stair facing cycles N→W→S→E under repeated 90° Y CW', () => {
        const cycle = ['north', 'west', 'south', 'east', 'north'];
        let v = makeVoxels();
        setBlock(v, 0, 0, 0, `test:stairs[facing=${cycle[0]},half=bottom,shape=straight]`);
        for (let i = 0; i < 4; i++) {
            v = rotateVoxelsByQuat(v, quatY(90), v.registry);
            const parsed = parseKey(singleBlock(v).key)!;
            expect(parsed.props.facing).toBe(cycle[i + 1]);
        }
    });

    it('positions remap correctly under 90° Y CW (line of stairs)', () => {
        // four stairs in a row along +X at y=0
        const v = makeVoxels();
        for (let x = 0; x < 4; x++) {
            setBlock(v, x, 0, 0, 'test:stairs[facing=north,half=bottom,shape=straight]');
        }

        const rotated = rotateVoxelsByQuat(v, quatY(90), v.registry);

        // CW Y rotation maps +X → -Z; min-corner shift then lays the row
        // along +Z starting at 0 (reversed in original-block order).
        const found: { wx: number; wy: number; wz: number; key: string }[] = [];
        for (const chunk of rotated.chunks.values()) {
            if (chunk.aggregate === 0) continue;
            for (let ly = 0; ly < 16; ly++) {
                for (let lz = 0; lz < 16; lz++) {
                    for (let lx = 0; lx < 16; lx++) {
                        const idx = (ly << 8) | (lz << 4) | lx;
                        const palette = chunk.data[idx]!;
                        const key = chunk.paletteKeys[palette];
                        if (!key || key === 'air') continue;
                        found.push({ wx: chunk.wx + lx, wy: chunk.wy + ly, wz: chunk.wz + lz, key });
                    }
                }
            }
        }
        expect(found.length).toBe(4);
        // sort by Z so we can assert on a stable order
        found.sort((a, b) => a.wz - b.wz);
        for (let i = 0; i < 4; i++) {
            expect(found[i]!.wz).toBe(i);
            const parsed = parseKey(found[i]!.key)!;
            expect(parsed.props.facing).toBe('west');
        }
    });

    it('full 360° Y rotation returns each block to its original key', () => {
        let v = makeVoxels();
        setBlock(v, 0, 0, 0, 'test:column[axis=x]');
        setBlock(v, 1, 0, 0, 'test:stairs[facing=north,half=bottom,shape=straight]');
        for (let i = 0; i < 4; i++) {
            v = rotateVoxelsByQuat(v, quatY(90), v.registry);
        }
        // after 4×90° = 360° the keys should match the originals
        const originals = new Set(['test:column[axis=x]', 'test:stairs[facing=north,half=bottom,shape=straight]']);
        const got = new Set<string>();
        for (const chunk of v.chunks.values()) {
            if (chunk.aggregate === 0) continue;
            for (let ly = 0; ly < 16; ly++) {
                for (let lz = 0; lz < 16; lz++) {
                    for (let lx = 0; lx < 16; lx++) {
                        const idx = (ly << 8) | (lz << 4) | lx;
                        const palette = chunk.data[idx]!;
                        const key = chunk.paletteKeys[palette];
                        if (!key || key === 'air') continue;
                        got.add(key);
                    }
                }
            }
        }
        expect(got).toEqual(originals);
    });

    it('fence connections cycle N→W→S→E under repeated 90° Y CW', () => {
        // a neighbour that was at direction D is now at rotFacing4(D, cw)
        // after rotation. so `north=true` becomes `west=true` after one CW
        // turn; cycles N→W→S→E→N over four turns.
        let v = makeVoxels();
        setBlock(
            v,
            0,
            0,
            0,
            fenceHandle.stateKey({
                north: true,
                east: false,
                south: false,
                west: false,
            }),
        );
        const expected: Array<{ north: string; east: string; south: string; west: string }> = [
            { north: 'false', east: 'false', south: 'false', west: 'true' },
            { north: 'false', east: 'false', south: 'true', west: 'false' },
            { north: 'false', east: 'true', south: 'false', west: 'false' },
            { north: 'true', east: 'false', south: 'false', west: 'false' },
        ];
        for (let i = 0; i < 4; i++) {
            v = rotateVoxelsByQuat(v, quatY(90), v.registry);
            const parsed = parseKey(singleBlock(v).key)!;
            for (const [k, want] of Object.entries(expected[i]!)) {
                expect(parsed.props[k]).toBe(want);
            }
        }
    });
});
