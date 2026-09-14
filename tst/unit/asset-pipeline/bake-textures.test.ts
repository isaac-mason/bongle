// Baking computed textures off the TEXTURE STORE.
//
// The point of textures having identity is visible here: the set of things to bake is a
// store rather than descriptors scraped out of two consumer registries, results are keyed
// by texture id, a texture several others draw from bakes once, and a cycle names the
// texture that closed the loop instead of reporting an anonymous descriptor.
//
// The raster is faked — this asserts the walk, the memoisation and the input resolution,
// not pixel output, which belongs to the atlas builders.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bakeTextures } from '../../../src/asset-pipeline/bake/bake-textures';
import type { Raster, RasterCanvas } from '../../../src/asset-pipeline/bake/raster';
import { registry, texture, textureStore } from '../../../src/core/registry';
import type { ResourceLoader } from '../../../src/core/resource-loader';

/** a raster that records the surfaces it hands out, so a bake can be identified. */
function fakeRaster(): Raster & { made: Array<[number, number]> } {
    const made: Array<[number, number]> = [];
    return {
        made,
        decodeBitmap: async () => ({ width: 16, height: 16 }) as never,
        makeCanvas: (w, h) => {
            made.push([w, h]);
            const ctx = { fillStyle: '', fillRect: () => {}, drawImage: () => {} };
            return { canvas: { width: w, height: h } as unknown as RasterCanvas, ctx: ctx as never };
        },
        scaleTo: () => ({}) as RasterCanvas,
        canvasPixels: () => new Uint8ClampedArray(),
        encodePng: async () => new Uint8Array(),
        putPixels: (_rgba, w, h) => ({ width: w, height: h }) as unknown as RasterCanvas,
    };
}

function fakeLoader(files: Record<string, boolean> = {}): ResourceLoader {
    return {
        loadBytes: async (url: string) => {
            if (files[url] === false) throw new Error('missing');
            return new Uint8Array([1, 2, 3]);
        },
    } as ResourceLoader;
}

beforeEach(() => {
    registry._reset();
});

describe('bakeTextures', () => {
    it('bakes computed textures and keys the results by id', async () => {
        const src = texture('stone', { src: 'stone.png' });
        texture('stone:dust', { size: [8, 8], inputs: { tex: src }, fn: () => {} });

        const baked = await bakeTextures(textureStore, { loader: fakeLoader(), raster: fakeRaster() });

        expect([...baked.keys()]).toEqual(['stone:dust']);
        expect(baked.get('stone:dust')).toMatchObject({ width: 8, height: 8 });
    });

    it('does not bake file textures — the atlas builders load those', async () => {
        texture('stone', { src: 'stone.png' });

        const baked = await bakeTextures(textureStore, { loader: fakeLoader(), raster: fakeRaster() });

        expect(baked.size).toBe(0);
    });

    it('bakes a shared source once even when several textures draw from it', async () => {
        const base = texture('base', { size: [4, 4], fn: () => {} });
        texture('a', { size: [8, 8], inputs: { tex: base }, fn: () => {} });
        texture('b', { size: [8, 8], inputs: { tex: base }, fn: () => {} });

        const raster = fakeRaster();
        const baked = await bakeTextures(textureStore, { loader: fakeLoader(), raster });

        expect(baked.size).toBe(3);
        // one surface per texture: `base` is memoised by id rather than baked per consumer,
        // which the old descriptor-identity memo could only manage by object reuse.
        expect(raster.made).toHaveLength(3);
    });

    it('names the texture that closed a cycle', async () => {
        // built by hand: `texture()` takes handles, so a cycle can't be authored through
        // the public API — but a def can still reference itself after a re-declaration.
        texture('loop', { size: [4, 4], fn: () => {} });
        const def = textureStore.byId.get('loop');
        if (def && def.from === 'computed') def.inputs = { self: { registry: 'textures', id: 'loop' } };

        await expect(bakeTextures(textureStore, { loader: fakeLoader(), raster: fakeRaster() })).rejects.toThrow(
            /texture cycle detected — 'loop'/,
        );
    });

    it('bakes a region as a smoothing-off copy of its source at the negated offset', async () => {
        const raster = fakeRaster();
        const draws: unknown[][] = [];
        raster.makeCanvas = (w, h) => {
            raster.made.push([w, h]);
            const ctx = {
                imageSmoothingEnabled: true,
                fillStyle: '',
                fillRect: () => {},
                drawImage: (...args: unknown[]) => draws.push([ctx.imageSmoothingEnabled, ...args]),
            };
            return { canvas: { width: w, height: h } as unknown as RasterCanvas, ctx: ctx as never };
        };
        const sheet = texture('sheet', { src: 'sheet.png' });
        texture('sheet:cut', { of: sheet, region: [8, 16, 5, 7] });

        const baked = await bakeTextures(textureStore, { loader: fakeLoader(), raster });

        expect(baked.get('sheet:cut')).toMatchObject({ width: 5, height: 7 });
        expect(draws).toEqual([[false, { width: 16, height: 16 }, -8, -16]]);
    });

    it('bakes a region of a computed texture after the texture it cuts from', async () => {
        const base = texture('base', { size: [4, 4], fn: () => {} });
        texture('base:cut', { of: base, region: [1, 1, 2, 2] });

        const raster = fakeRaster();
        const baked = await bakeTextures(textureStore, { loader: fakeLoader(), raster });

        expect([...baked.keys()].sort()).toEqual(['base', 'base:cut']);
        expect(raster.made).toEqual([
            [4, 4],
            [2, 2],
        ]);
    });

    it('substitutes a placeholder when a source file is missing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const missing = texture('gone', { src: 'gone.png' });
        texture('uses-missing', { size: [8, 8], inputs: { tex: missing }, fn: () => {} });

        const baked = await bakeTextures(textureStore, {
            loader: fakeLoader({ 'gone.png': false }),
            raster: fakeRaster(),
        });

        expect(baked.has('uses-missing')).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("texture 'gone' source not found"));
        warn.mockRestore();
    });
});
