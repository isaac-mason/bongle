// ── door preset tests ───────────────────────────────────────────────
//
// covers two-cell placement (never a half-door), double-door hinge, chiral
// rotate/flip, and get/setDoorOpen across both halves.

import { registerAllShapes } from 'crashcat';
import { beforeAll, describe, expect, it } from 'vitest';
import * as blockModel from '../../../../src/core/voxels/block-model';
import { cube, door, getDoorOpen, setDoorOpen } from '../../../../src/core/voxels/block-presets';
import { buildBlockRegistry, parseKey } from '../../../../src/core/voxels/block-registry';
import { flipBlockKey, rotateBlockKey } from '../../../../src/core/voxels/block-transform';
import type { BlockDef, BlockHandle, BlockPlaceCtx, BlockQuad, BlockTextureDef, PlaceIO } from '../../../../src/core/voxels/blocks';
import { createVoxels, setBlock } from '../../../../src/core/voxels/voxels';

const topTex: BlockTextureDef = {
    id: 'door-top',
    dependency: { registry: 'blockTextures', id: 'door-top' },
    frames: ['door-top.png'],
    fps: 1,
    interpolate: false,
};
const botTex: BlockTextureDef = {
    id: 'door-bot',
    dependency: { registry: 'blockTextures', id: 'door-bot' },
    frames: ['door-bot.png'],
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

const doorHandle = door('test:door', { top: topTex, bottom: botTex }) as BlockHandle;
const stoneHandle = cube('test:stone', { all: { texture: stoneTex } }) as BlockHandle;

const defs = new Map<string, BlockDef>([
    [doorHandle.id, doorHandle._def],
    [stoneHandle.id, stoneHandle._def],
]);
const handles = new Map<string, BlockHandle>([
    [doorHandle.id, doorHandle as BlockHandle],
    [stoneHandle.id, stoneHandle as BlockHandle],
]);
const textures = new Map<string, BlockTextureDef>([
    [topTex.id, topTex],
    [botTex.id, botTex],
    [stoneTex.id, stoneTex],
]);

let registry: ReturnType<typeof buildBlockRegistry>;
beforeAll(() => {
    registerAllShapes();
    registry = buildBlockRegistry(defs, handles, textures);
});

// floor-click ctx at (x,y,z); camera yaw controls the resolved facing.
function floorCtx(x: number, y: number, z: number, yaw = Math.PI): BlockPlaceCtx {
    return {
        worldX: x,
        worldY: y,
        worldZ: z,
        normalX: 0,
        normalY: 1,
        normalZ: 0,
        hitX: 0.5,
        hitY: 0,
        hitZ: 0.5,
        yaw,
        pitch: 0,
    };
}

// run the door place hook against a capturing io seeded with `world`.
function runPlace(ctx: BlockPlaceCtx, world: Record<string, string> = {}): Map<string, string> {
    const writes = new Map<string, string>();
    const io: PlaceIO = {
        get: (x, y, z) => writes.get(`${x},${y},${z}`) ?? world[`${x},${y},${z}`] ?? 'air',
        set: (x, y, z, key) => writes.set(`${x},${y},${z}`, key),
    };
    doorHandle._def.place!(ctx, io);
    return writes;
}

describe('door placement', () => {
    it('writes both halves, facing toward placer, hinge=left', () => {
        const w = runPlace(floorCtx(5, 0, 5, Math.PI)); // yaw=π → facing north
        expect(w.size).toBe(2);
        expect(parseKey(w.get('5,0,5')!)!.props).toMatchObject({ half: 'lower', facing: 'north', hinge: 'left', open: 'false' });
        expect(parseKey(w.get('5,1,5')!)!.props).toMatchObject({ half: 'upper', facing: 'north', hinge: 'left', open: 'false' });
    });

    it('refuses placement with no headroom (upper cell occupied) → no writes', () => {
        const w = runPlace(floorCtx(5, 0, 5), { '5,1,5': 'test:stone' });
        expect(w.size).toBe(0);
    });

    it('double door: a same-facing door to the right → hinge=right', () => {
        // facing north → right-of is east (+X); seed a north door at x+1.
        const w = runPlace(floorCtx(5, 0, 5, Math.PI), {
            '6,0,5': 'test:door[facing=north,half=lower,hinge=left,open=false]',
        });
        expect(parseKey(w.get('5,0,5')!)!.props.hinge).toBe('right');
    });
});

describe('door rotate / flip', () => {
    it('rotate Y ×4 = identity', () => {
        let k = 'test:door[facing=north,half=lower,hinge=left,open=false]';
        for (let i = 0; i < 4; i++) k = rotateBlockKey(k, 'y', true, registry);
        expect(k).toBe('test:door[facing=north,half=lower,hinge=left,open=false]');
    });

    it('flip x: facing mirrors, hinge swaps left↔right (chiral)', () => {
        const p = parseKey(flipBlockKey('test:door[facing=east,half=lower,hinge=left,open=false]', 'x', registry))!.props;
        expect(p.facing).toBe('west');
        expect(p.hinge).toBe('right');
    });

    it('flip y: half swaps lower↔upper, hinge unchanged', () => {
        const p = parseKey(flipBlockKey('test:door[facing=north,half=lower,hinge=left,open=false]', 'y', registry))!.props;
        expect(p.half).toBe('upper');
        expect(p.hinge).toBe('left');
    });
});

describe('get/setDoorOpen', () => {
    it('setDoorOpen writes both halves; getDoorOpen round-trips from either', () => {
        const v = createVoxels(registry);
        setBlock(v, 5, 0, 5, 'test:door[facing=north,half=lower,hinge=left,open=false]');
        setBlock(v, 5, 1, 5, 'test:door[facing=north,half=upper,hinge=left,open=false]');
        expect(getDoorOpen(v, 5, 0, 5)).toBe(false);

        setDoorOpen(v, 5, 0, 5, true);
        expect(getDoorOpen(v, 5, 0, 5)).toBe(true);
        expect(getDoorOpen(v, 5, 1, 5)).toBe(true); // both halves moved

        setDoorOpen(v, 5, 1, 5, false); // operate via the upper half
        expect(getDoorOpen(v, 5, 0, 5)).toBe(false);
    });

    it('getDoorOpen is false for a non-door cell', () => {
        const v = createVoxels(registry);
        expect(getDoorOpen(v, 0, 0, 0)).toBe(false);
    });
});

describe('door model — hinge mirror', () => {
    it('mirrorX is involutive (mirror twice = identity)', () => {
        const q = blockModel.box([0, 0, 0], [1, 1, 3 / 16], { all: { texture: botTex } }, { uvs: 'local', cull: false });
        expect(blockModel.mirrorX(blockModel.mirrorX(q))).toEqual(q);
    });

    it('right-hinge closed door is the horizontal mirror of left', () => {
        const left = doorHandle._def.model!({ facing: 'north', half: 'lower', hinge: 'left', open: false }) as {
            quads: BlockQuad[];
        };
        const right = doorHandle._def.model!({ facing: 'north', half: 'lower', hinge: 'right', open: false }) as {
            quads: BlockQuad[];
        };
        expect(right.quads).not.toEqual(left.quads); // texture/uvs mirrored → quads differ
        expect(blockModel.mirrorX(right.quads)).toEqual(left.quads); // and it IS the mirror of left
    });
});
