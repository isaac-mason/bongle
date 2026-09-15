// The tile atlas bake: a packed atlas of 16-aligned cells, its mip chain as one
// PNG per level, rects per texture index in the sidecar, and a cache gate that
// refuses to skip a bake whose level files are missing.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Filesystem } from '../../../os/interface';
import type { Raster, RasterCanvas } from '../../../src/asset-pipeline/bake/raster';
import { buildTileAtlas } from '../../../src/asset-pipeline/bake/tile-atlas';
import { registry, texture, tile } from '../../../src/core/registry';
import type { ResourceLoader } from '../../../src/core/resource-loader';
import { createBlockRegistry } from '../../../src/core/voxels/block-registry';
import { BPP } from '../../../src/core/voxels/mip-levels';
import type { ModuleVersion } from '../../../src/internal';

/** a raster whose decoded bitmaps take their size from the loader's bytes
 *  (`[w, h]`), whose composed atlas reads back as solid opaque red, and which
 *  records every level surface `putPixels` makes. */
function fakeRaster(): Raster & { put: Array<[number, number]>; drawn: Array<[number, number]> } {
    const put: Array<[number, number]> = [];
    const drawn: Array<[number, number]> = [];
    return {
        put,
        drawn,
        decodeBitmap: async (bytes) => ({ width: bytes[0]!, height: bytes[1]! }) as never,
        makeCanvas: (w, h) => ({
            canvas: { width: w, height: h } as unknown as RasterCanvas,
            ctx: {
                fillStyle: '',
                fillRect: () => {},
                drawImage: (_img: unknown, x: number, y: number) => {
                    drawn.push([x, y]);
                },
            } as never,
        }),
        scaleTo: () => ({}) as RasterCanvas,
        canvasPixels: (c) => {
            const pixels = new Uint8ClampedArray(c.width * c.height * BPP);
            for (let i = 0; i < pixels.length; i += BPP) {
                pixels[i] = 200;
                pixels[i + 3] = 255;
            }
            return pixels;
        },
        putPixels: (_rgba, w, h) => {
            put.push([w, h]);
            return { width: w, height: h } as unknown as RasterCanvas;
        },
        encodePng: async (c) => new Uint8Array([c.width & 0xff, c.width >> 8, c.height & 0xff, c.height >> 8]),
    };
}

function fakeFs(existing: Map<string, string | Uint8Array> = new Map()) {
    const written = new Map<string, string | Uint8Array>(existing);
    return {
        written,
        fs: {
            write: async (path: string, data: string | Uint8Array) => {
                written.set(path, data);
            },
            readText: async (path: string) => {
                const v = written.get(path);
                if (v === undefined) throw new Error('missing');
                return typeof v === 'string' ? v : new TextDecoder().decode(v);
            },
            exists: async (path: string) => written.has(path),
            remove: async (path: string) => {
                written.delete(path);
            },
        } as unknown as Filesystem,
    };
}

/** bytes encode the image size the fake raster will report. */
function loaderWithSizes(sizes: Record<string, [number, number]>): ResourceLoader {
    return {
        loadBytes: async (path: string) => {
            const size = sizes[path] ?? [16, 16];
            return new Uint8Array([size[0], size[1]]);
        },
    } as ResourceLoader;
}

function moduleWith(textureNames: string[], cutout: number[]): ModuleVersion {
    const blocks = createBlockRegistry();
    blocks.textures = textureNames;
    blocks.textureCutout = new Uint8Array(cutout);
    return { blocks, tiles: registry.tiles.byId, models: new Map(), scenes: new Map() };
}

const sidecar = (written: Map<string, string | Uint8Array>) =>
    JSON.parse(written.get('resources/client/voxels-atlas.json') as string);

const baseOpts = (fs: Filesystem, raster: Raster, loader: ResourceLoader, cache = false) => ({
    bakedTextures: new Map(),
    cache,
    loader,
    fs,
    raster,
});

beforeEach(() => {
    registry._reset();
});

describe('buildTileAtlas', () => {
    it('packs tiles into padded 16-aligned cells, one per texture index, and ships three levels', async () => {
        tile('stone', { frames: [texture('stone', { src: 'stone.png' })] });
        tile('leaf', { frames: [texture('leaf', { src: 'leaf.png' })] });
        tile('sand', { frames: [texture('sand', { src: 'sand.png' })] });
        const { fs, written } = fakeFs();
        const raster = fakeRaster();
        const loader = loaderWithSizes({ 'leaf.png': [32, 32] });

        const built = await buildTileAtlas(moduleWith(['stone', 'leaf', 'sand'], [0, 1, 0]), baseOpts(fs, raster, loader));

        expect(built).toBe(true);
        const meta = sidecar(written);
        expect(meta).toMatchObject({ version: 4, mipLevels: 3, atlasWidth: 256, atlasHeight: 256 });
        expect(meta.textures).toEqual(['stone', 'leaf', 'sand']);
        expect(meta.rects).toHaveLength(3);
        expect(meta.rects[1]).toMatchObject({ w: 32, h: 32 });
        // cells are 16-aligned and each rect is the interior, inset by the 8-texel border.
        for (const r of meta.rects) {
            expect(r.x % 16).toBe(8);
            expect(r.y % 16).toBe(8);
        }
        // level L is the atlas at 256 >> L, plus the extruded level 0 put back as pixels.
        expect(raster.put).toEqual([
            [256, 256],
            [128, 128],
            [64, 64],
            [32, 32],
        ]);
        for (let level = 1; level <= 3; level++) expect(written.has(`resources/client/voxels-atlas.${level}.png`)).toBe(true);
        expect(written.has('resources/client/voxels-atlas.4.png')).toBe(false);
    });

    it('gives an animated tile one consecutive rect per frame', async () => {
        const a = texture('lava0', { src: 'lava0.png' });
        const b = texture('lava1', { src: 'lava1.png' });
        tile('lava', { frames: [a, b], fps: 4 });
        const { fs, written } = fakeFs();
        const raster = fakeRaster();

        await buildTileAtlas(moduleWith(['lava:0', 'lava:1'], [0, 0]), baseOpts(fs, raster, loaderWithSizes({})));

        const meta = sidecar(written);
        expect(meta.textures).toEqual(['lava:0', 'lava:1']);
        expect(meta.rects).toHaveLength(2);
        expect(raster.drawn).toEqual([
            [meta.rects[0].x, meta.rects[0].y],
            [meta.rects[1].x, meta.rects[1].y],
        ]);
    });

    it('rejects a file tile that is not a multiple of 16 per side', async () => {
        tile('odd', { frames: [texture('odd', { src: 'odd.png' })] });
        const { fs } = fakeFs();
        await expect(
            buildTileAtlas(moduleWith(['odd'], [0]), baseOpts(fs, fakeRaster(), loaderWithSizes({ 'odd.png': [24, 24] }))),
        ).rejects.toThrow(/multiples of 16x16/);
    });

    it('skips a bake whose hash and every level file are already present', async () => {
        tile('stone', { frames: [texture('stone', { src: 'stone.png' })] });
        const module = moduleWith(['stone'], [0]);
        const first = fakeFs();
        await buildTileAtlas(module, baseOpts(first.fs, fakeRaster(), loaderWithSizes({})));

        const second = fakeFs(first.written);
        const built = await buildTileAtlas(module, baseOpts(second.fs, fakeRaster(), loaderWithSizes({}), true));
        expect(built).toBe(false);
    });

    it('rebuilds when the hash matches but a level file is missing', async () => {
        tile('stone', { frames: [texture('stone', { src: 'stone.png' })] });
        const module = moduleWith(['stone'], [0]);
        const first = fakeFs();
        await buildTileAtlas(module, baseOpts(first.fs, fakeRaster(), loaderWithSizes({})));
        first.written.delete('resources/client/voxels-atlas.3.png');

        const second = fakeFs(first.written);
        const built = await buildTileAtlas(module, baseOpts(second.fs, fakeRaster(), loaderWithSizes({}), true));
        expect(built).toBe(true);
        expect(second.written.has('resources/client/voxels-atlas.3.png')).toBe(true);
    });

    it('emits an empty manifest with no image files when there are no textures', async () => {
        const { fs, written } = fakeFs();
        const built = await buildTileAtlas(moduleWith([], []), baseOpts(fs, fakeRaster(), loaderWithSizes({})));
        expect(built).toBe(false);
        expect(sidecar(written)).toMatchObject({ version: 4, mipLevels: 0, textures: [], rects: [] });
        expect([...written.keys()]).toEqual(['resources/client/voxels-atlas.json']);
    });
});
