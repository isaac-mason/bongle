// ── preset rotate / flip / place transform tests ───────────────────
//
// covers the rotateBlockKey / flipBlockKey path against real presets:
//   - 4× rotate round-trip = identity per directional preset
//   - 2× flip round-trip = identity per directional preset
//   - placement helpers produce the expected key from hit context
//
// chirality (stair inner_left ↔ inner_right under x/z flip) flips on every
// horizontal mirror regardless of facing — left and right always swap when
// you reflect the world horizontally. facing only flips when it has a
// component along the mirror axis (e.g. facing=east under flip-x).

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllShapes } from 'crashcat';
import { buildBlockRegistry, parseKey } from './block-registry';
import { type BlockDef, type BlockHandle, type BlockPlaceCtx, type BlockTextureDef } from './blocks';
import { column, fence, ladder, slab, stairs, trapdoor } from './block-presets';
import { rotateBlockKey, flipBlockKey } from './block-transform';
import type { RotAxis } from './block-orient';


const oakTex: BlockTextureDef = { id: 'oak', frames: ['oak.png'], fps: 1, interpolate: false };
const oakEndTex: BlockTextureDef = { id: 'oak-end', frames: ['oak-end.png'], fps: 1, interpolate: false };
const stoneTex: BlockTextureDef = { id: 'stone', frames: ['stone.png'], fps: 1, interpolate: false };

const stairHandle = stairs('test:stairs', { all: { texture: stoneTex } });
const slabHandle = slab('test:slab', { all: { texture: stoneTex } });
const ladderHandle = ladder('test:ladder', oakTex);
const trapdoorHandle = trapdoor('test:trapdoor', { all: { texture: oakTex } });
const columnHandle = column('test:column', { end: oakEndTex, side: oakTex });
const fenceHandle = fence('test:fence', { all: { texture: oakTex } });

const defs = new Map<string, BlockDef>([
    [stairHandle.id, stairHandle._def],
    [slabHandle.id, slabHandle._def],
    [ladderHandle.id, ladderHandle._def],
    [trapdoorHandle.id, trapdoorHandle._def],
    [columnHandle.id, columnHandle._def],
    [fenceHandle.id, fenceHandle._def],
]);
const handles = new Map<string, BlockHandle>([
    [stairHandle.id, stairHandle as BlockHandle],
    [slabHandle.id, slabHandle as BlockHandle],
    [ladderHandle.id, ladderHandle as BlockHandle],
    [trapdoorHandle.id, trapdoorHandle as BlockHandle],
    [columnHandle.id, columnHandle as BlockHandle],
    [fenceHandle.id, fenceHandle as BlockHandle],
]);
const textures = new Map<string, BlockTextureDef>([
    [oakTex.id, oakTex],
    [oakEndTex.id, oakEndTex],
    [stoneTex.id, stoneTex],
]);

let registry: ReturnType<typeof buildBlockRegistry>;
beforeAll(() => {
    registerAllShapes();
    registry = buildBlockRegistry(defs, handles, textures);
});

function rotate4(key: string, axis: RotAxis): string {
    let out = key;
    for (let i = 0; i < 4; i++) out = rotateBlockKey(out, axis, true, registry);
    return out;
}

describe('rotate × 4 = identity (Y axis)', () => {
    const keys = [
        'test:stairs[facing=north,half=bottom,shape=straight]',
        'test:stairs[facing=east,half=top,shape=straight]',
        'test:slab[half=bottom]',
        'test:slab[half=top]',
        'test:ladder[facing=north]',
        'test:trapdoor[facing=east,half=bottom,open=false]',
        'test:column[axis=x]',
        'test:column[axis=y]',
        'test:column[axis=z]',
        'test:fence[north=true,east=false,south=false,west=true]',
    ];
    for (const key of keys) {
        it(`Y×4: ${key} → identity`, () => {
            expect(rotate4(key, 'y')).toBe(key);
        });
    }
});

describe('rotate × 4 = identity (X axis)', () => {
    // x-axis 90° turns can map facing→up/down for blocks that don't have
    // up/down in their enum — those fall back to the original key (no
    // change), so 4× still composes to identity.
    const keys = [
        'test:stairs[facing=north,half=bottom,shape=straight]',
        'test:slab[half=bottom]',
        'test:ladder[facing=south]',
        'test:column[axis=y]',
    ];
    for (const key of keys) {
        it(`X×4: ${key} → identity`, () => {
            expect(rotate4(key, 'x')).toBe(key);
        });
    }
});

describe('flip × 2 = identity', () => {
    const cases: { key: string; axis: RotAxis }[] = [
        { key: 'test:stairs[facing=north,half=bottom,shape=straight]', axis: 'x' },
        { key: 'test:stairs[facing=north,half=bottom,shape=straight]', axis: 'z' },
        { key: 'test:ladder[facing=east]', axis: 'x' },
        { key: 'test:trapdoor[facing=east,half=bottom,open=false]', axis: 'x' },
        { key: 'test:column[axis=x]', axis: 'x' },
        { key: 'test:column[axis=y]', axis: 'y' },
    ];
    for (const { key, axis } of cases) {
        it(`flip-${axis}×2: ${key} → identity`, () => {
            const once = flipBlockKey(key, axis, registry);
            const twice = flipBlockKey(once, axis, registry);
            expect(twice).toBe(key);
        });
    }
});

describe('stair chirality under flip', () => {
    it('inner_left + flip-x with facing=east: facing→west, shape→inner_right', () => {
        const flipped = flipBlockKey('test:stairs[facing=east,half=bottom,shape=inner_left]', 'x', registry);
        const parsed = parseKey(flipped)!;
        expect(parsed.props['facing']).toBe('west');
        expect(parsed.props['shape']).toBe('inner_right');
    });

    it('inner_right + flip-z with facing=north: facing→south, shape→inner_left', () => {
        const flipped = flipBlockKey('test:stairs[facing=north,half=bottom,shape=inner_right]', 'z', registry);
        const parsed = parseKey(flipped)!;
        expect(parsed.props['facing']).toBe('south');
        expect(parsed.props['shape']).toBe('inner_left');
    });

    it('outer_left + flip-x with facing=north: facing stays north, shape→outer_right', () => {
        // facing N has no component along X, so it doesn't flip; but the
        // mirror still swaps left ↔ right.
        const flipped = flipBlockKey('test:stairs[facing=north,half=bottom,shape=outer_left]', 'x', registry);
        const parsed = parseKey(flipped)!;
        expect(parsed.props['facing']).toBe('north');
        expect(parsed.props['shape']).toBe('outer_right');
    });
});

describe('place hooks (stairs / slab / trapdoor)', () => {
    function placeCtx(overrides: Partial<BlockPlaceCtx>): BlockPlaceCtx {
        return {
            worldX: 0, worldY: 0, worldZ: 0,
            normalX: 0, normalY: 1, normalZ: 0,
            hitX: 0.5, hitY: 0, hitZ: 0.5,
            yaw: 0, pitch: 0,
            ...overrides,
        };
    }

    // run a block's imperative place hook with a capturing io; returns the key
    // written at the target cell (these single-cell presets only set target).
    function placedKey(def: BlockDef, ctx: BlockPlaceCtx): string {
        let key = '';
        def.place!(ctx, { get: () => 'air', set: (_x, _y, _z, k) => { key = k; } });
        return key;
    }

    it('slab top-face click → bottom half', () => {
        const key = placedKey(slabHandle._def, placeCtx({ normalX: 0, normalY: 1, normalZ: 0 }));
        expect(key).toBe('test:slab[half=bottom]');
    });

    it('slab bottom-face click → top half', () => {
        const key = placedKey(slabHandle._def, placeCtx({ normalX: 0, normalY: -1, normalZ: 0, hitY: 1 }));
        expect(key).toBe('test:slab[half=top]');
    });

    it('slab wall click with hitY=0.2 → bottom half', () => {
        const key = placedKey(slabHandle._def, placeCtx({ normalX: 1, normalY: 0, normalZ: 0, hitY: 0.2 }));
        expect(key).toBe('test:slab[half=bottom]');
    });

    it('slab wall click with hitY=0.8 → top half', () => {
        const key = placedKey(slabHandle._def, placeCtx({ normalX: 1, normalY: 0, normalZ: 0, hitY: 0.8 }));
        expect(key).toBe('test:slab[half=top]');
    });

    it('stairs top-face click with camera facing north (yaw=π) → facing=north, half=bottom', () => {
        // yaw=π → forward = (sin π, cos π) = (0, -1), so snapCardinal picks
        // -Z → 'north'. with the floor-click branch we pick from yaw.
        const key = placedKey(stairHandle._def, placeCtx({
            normalX: 0, normalY: 1, normalZ: 0, hitY: 0, yaw: Math.PI,
        }));
        const parsed = parseKey(key)!;
        expect(parsed.props['facing']).toBe('north');
        expect(parsed.props['half']).toBe('bottom');
        expect(parsed.props['shape']).toBe('straight');
    });

    it('stairs wall click (east normal) → facing=east, half from hitY', () => {
        const key = placedKey(stairHandle._def, placeCtx({
            normalX: 1, normalY: 0, normalZ: 0, hitY: 0.8,
        }));
        const parsed = parseKey(key)!;
        expect(parsed.props['facing']).toBe('east');
        expect(parsed.props['half']).toBe('top');
    });

    it('trapdoor wall click → facing=normal, half from hitY, open=false', () => {
        const key = placedKey(trapdoorHandle._def, placeCtx({
            normalX: 0, normalY: 0, normalZ: -1, hitY: 0.2,
        }));
        const parsed = parseKey(key)!;
        expect(parsed.props['facing']).toBe('north');
        expect(parsed.props['half']).toBe('bottom');
        expect(parsed.props['open']).toBe('false');
    });
});
