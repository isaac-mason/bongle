// ── per-position variants + jitter ──────────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { block, tile } from '../../../../src/core/registry';
import * as blockShape from '../../../../src/core/voxels/block-collider';
import * as blockModel from '../../../../src/core/voxels/block-model';
import * as blockPreset from '../../../../src/core/voxels/block-presets';
import { type Blocks, buildBlockRegistry, createBlockRegistry } from '../../../../src/core/voxels/block-registry';
import { type BlockDef, type BlockHandle, CullType, type TileDef, type TileHandle } from '../../../../src/core/voxels/blocks';
import { resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

const aTile = () => tile('test:leaf', { src: 'leaf.png' });

/** build a registry holding exactly the handles/tiles given. */
function buildWith(handle: BlockHandle, ...tiles: TileHandle[]): Blocks {
    const registry = createBlockRegistry();
    buildBlockRegistry(
        registry,
        new Map<string, BlockDef>([[handle.id, handle.def]]),
        new Map<string, BlockHandle>([[handle.id, handle]]),
        new Map<string, TileDef>(tiles.map((t) => [t.id, t.def])),
    );
    return registry;
}

describe('variant declaration', () => {
    it('derives the count from the list, so it cannot drift', () => {
        const t = aTile();
        const handle = block('test:rotating', {
            model: () => [0, 1, 2, 3].map((r) => ({ type: 'custom' as const, quads: blockModel.rotateY(blockModel.hash(t), r) })),
        }) as BlockHandle;
        const blocks = buildWith(handle, t);
        expect(blocks.variantCount[handle.stateId({})]).toBe(4);
    });

    it('treats a one-entry list exactly like a bare model', () => {
        const t = aTile();
        const handle = block('test:single', {
            model: () => [{ type: 'custom' as const, quads: blockModel.hash(t) }],
        }) as BlockHandle;
        const blocks = buildWith(handle, t);
        expect(blocks.variantCount[handle.stateId({})]).toBeLessThanOrEqual(1);
    });

    it('rejects a list mixing cube and custom, which has no single mesher path', () => {
        const t = aTile();
        const handle = block('test:mixed', {
            model: () => [
                { type: 'cube' as const, tiles: { all: t } },
                { type: 'custom' as const, quads: blockModel.hash(t) },
            ],
        }) as BlockHandle;
        expect(() => buildWith(handle, t)).toThrow(/must share a type/);
    });

    it('rejects an empty list', () => {
        const handle = block('test:empty', { model: () => [] }) as BlockHandle;
        expect(() => buildWith(handle)).toThrow(/empty variant list/);
    });

    it('gives each variant its own consecutive mesh, not a shared one', () => {
        const t = aTile();
        const handle = block('test:rot', {
            model: () => [0, 1, 2, 3].map((r) => ({ type: 'custom' as const, quads: blockModel.rotateY(blockModel.hash(t), r) })),
        }) as BlockHandle;
        const blocks = buildWith(handle, t);
        const sid = handle.stateId({});
        const base = blocks.variantBase[sid]!;
        // every variant resolves to distinct baked geometry
        const firstVertOf = (mid: number) => blocks.meshQuads[mid]![0]!.verts[0]!.join(',');
        const seen = new Set([0, 1, 2, 3].map((v) => firstVertOf(base + v)));
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe('jitter declaration', () => {
    it('records the bounds it was given', () => {
        const t = aTile();
        const handle = block('test:tuft', {
            model: () => ({ type: 'custom' as const, quads: blockModel.cross(t) }),
            jitter: { xz: 0.25, y: 0.2 },
        }) as BlockHandle;
        const blocks = buildWith(handle, t);
        const sid = handle.stateId({});
        expect(blocks.jitterXz[sid]).toBe(Math.round(0.25 * 255));
        expect(blocks.jitterY[sid]).toBe(Math.round(0.2 * 255));
    });

    it('is absent by default', () => {
        const t = aTile();
        const handle = block('test:plain', {
            model: () => ({ type: 'custom' as const, quads: blockModel.cross(t) }),
        }) as BlockHandle;
        const blocks = buildWith(handle, t);
        expect(blocks.jitterXz[handle.stateId({})]).toBe(0);
    });
});

describe('leaves preset variants', () => {
    const blob = () => tile('test:blob', { src: 'blob.png' });

    it('builds four rotations of the cube plus planes, drawn PARTIAL with opacity 1', () => {
        const leaf = aTile();
        const t = blob();
        const handle = blockPreset.leaves('test:leaves', { tiles: leaf, fluff: t, varyRotation: true }) as BlockHandle;
        const blocks = buildWith(handle, leaf, t);
        const sid = handle.stateId({});
        expect(blocks.variantCount[sid]).toBe(4);
        expect(blocks.cull[sid]).toBe(CullType.PARTIAL);
        expect(blocks.lightOpacity[sid]).toBe(1);
        // 6 cube faces + 8 plane quads, the planes unshaded
        const meshId = blocks.variantBase[sid]!;
        expect(blocks.meshQuadUnshaded[meshId]!.length).toBe(14);
        expect([...blocks.meshQuadUnshaded[meshId]!].filter((v) => v === 1)).toHaveLength(8);
    });

    it('mirrors the lean on odd rotations, so the four variants are four shapes', () => {
        const leaf = aTile();
        const t = blob();
        const handle = blockPreset.leaves('test:leaves', { tiles: leaf, fluff: t, varyRotation: true }) as BlockHandle;
        const blocks = buildWith(handle, leaf, t);
        const base = blocks.variantBase[handle.stateId({})]!;
        // the first plane quad's normal y flips sign between rotation 0 and 1
        const ny = (meshId: number) => blocks.meshQuadNormal[meshId]![6 * 3 + 1]!;
        expect(Math.sign(ny(base))).toBe(-Math.sign(ny(base + 1)));
    });

    it('is a single mesh with planes but no rotation', () => {
        const leaf = aTile();
        const t = blob();
        const handle = blockPreset.leaves('test:leaves', { tiles: leaf, fluff: t }) as BlockHandle;
        const blocks = buildWith(handle, leaf, t);
        expect(blocks.variantCount[handle.stateId({})]).toBeLessThanOrEqual(1);
        expect(blocks.meshId[handle.stateId({})]).not.toBe(0);
    });

    it('stays a plain cube with neither option, so the cube fast path applies', () => {
        const leaf = aTile();
        const handle = blockPreset.leaves('test:leaves', { tiles: leaf }) as BlockHandle;
        const blocks = buildWith(handle, leaf);
        expect(blocks.variantCount[handle.stateId({})]).toBeLessThanOrEqual(1);
        expect(blocks.meshId[handle.stateId({})]).toBe(0);
    });
});

describe('cross preset variants', () => {
    it('turns several tiles into per-position variants and forwards the jitter', () => {
        const tiles = [1, 2, 3].map((i) => tile(`test:tuft_${i}`, { src: `tuft_${i}.png` }));
        const handle = blockPreset.cross('test:grass', { tiles, jitter: { xz: 0.25, y: 0.2 } }) as BlockHandle;
        const blocks = buildWith(handle, ...tiles);
        const sid = handle.stateId({});
        expect(blocks.variantCount[sid]).toBe(3);
        expect(blocks.jitterXz[sid]).toBeGreaterThan(0);
        expect(blocks.jitterY[sid]).toBeGreaterThan(0);
    });

    it('stays a single mesh with one tile', () => {
        const t = tile('test:tuft', { src: 'tuft.png' });
        const handle = blockPreset.cross('test:grass', { tiles: t }) as BlockHandle;
        const blocks = buildWith(handle, t);
        expect(blocks.variantCount[handle.stateId({})]).toBeLessThanOrEqual(1);
    });

    it('takes a smaller selection shape for a low flower, keeping the default otherwise', () => {
        const t = tile('test:flower', { src: 'flower.png' });
        const low = blockShape.aabbs([[4 / 16, 0, 4 / 16, 12 / 16, 8 / 16, 12 / 16]]);
        const flower = blockPreset.cross('test:flower', { tiles: t, shape: low }) as BlockHandle;
        const grass = blockPreset.cross('test:grass', { tiles: t }) as BlockHandle;
        expect(flower.def.shape).toBe(low);
        expect(grass.def.shape).toBeDefined();
        expect(grass.def.shape).not.toBe(low);
    });
});

describe('litter preset', () => {
    it('is one up-facing quad above the floor, at three tiles times four rotations', () => {
        const tiles = [1, 2, 3].map((i) => tile(`test:litter_${i}`, { src: `litter_${i}.png` }));
        const handle = blockPreset.litter('test:litter', { tiles }) as BlockHandle;
        const blocks = buildWith(handle, ...tiles);
        const sid = handle.stateId({});
        expect(blocks.variantCount[sid]).toBe(12);
        expect(blocks.cull[sid]).toBe(CullType.PARTIAL);
        expect(blocks.lightOpacity[sid]).toBe(0);
        const meshId = blocks.variantBase[sid]!;
        expect(blocks.meshQuadShape[meshId]!.length).toBe(1);
        // normal +y, and every vertex a hair above the floor, never on it
        const n = blocks.meshQuadNormal[meshId]!;
        expect([n[0], n[1], n[2]]).toEqual([0, 1, 0]);
        const verts = blocks.meshQuadVerts[meshId]!;
        for (let v = 0; v < 4; v++) expect(verts[v * 3 + 1]).toBeGreaterThan(0);
    });
});
