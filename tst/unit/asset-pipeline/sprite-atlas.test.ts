// The sprite atlas builder, over frame REFERENCES.
//
// A sprite no longer carries its own sources — it holds `frames: DepKey[]` pointing at
// textures, and the builder resolves each through the texture store: a file texture is
// loaded here, a computed one was baked upstream by `bakeTextures` and is looked up by id.
//
// Neither atlas builder had a test before this. That was survivable while a sprite carried
// its sources inline, but the resolution step is new and load-bearing, so it gets one. The
// sidecar is pure output (uv rects + padding + mipmap, no sources), which makes it the
// right thing to assert against.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Filesystem } from '../../../os/interface';
import type { Raster, RasterCanvas } from '../../../src/asset-pipeline/bake/raster';
import { buildSpriteAtlas } from '../../../src/asset-pipeline/bake/sprite-atlas';
import { registry, sprite, texture, textureStore } from '../../../src/core/registry';
import type { ResourceLoader } from '../../../src/core/resource-loader';

function fakeRaster(): Raster {
    return {
        decodeBitmap: async () => ({ width: 8, height: 8 }) as never,
        makeCanvas: (w, h) => ({
            canvas: { width: w, height: h } as unknown as RasterCanvas,
            ctx: { fillStyle: '', fillRect: () => {}, drawImage: () => {}, clearRect: () => {} } as never,
        }),
        scaleTo: () => ({}) as RasterCanvas,
        canvasPixels: () => new Uint8ClampedArray([1, 2, 3, 4]),
        encodePng: async () => new Uint8Array([137, 80, 78, 71]),
        putPixels: (_rgba, w, h) => ({ width: w, height: h }) as unknown as RasterCanvas,
    };
}

function fakeFs(): Filesystem & { written: Map<string, string> } {
    const written = new Map<string, string>();
    return {
        written,
        write: async (path: string, data: string | Uint8Array) => {
            written.set(path, typeof data === 'string' ? data : `<${data.length} bytes>`);
        },
        read: async () => null,
        exists: async () => false,
    } as unknown as Filesystem & { written: Map<string, string> };
}

const fakeLoader: ResourceLoader = { loadBytes: async () => new Uint8Array([1, 2, 3]) } as ResourceLoader;

function sidecar(fs: ReturnType<typeof fakeFs>) {
    return JSON.parse(fs.written.get('resources/client/sprites-atlas.json') ?? '{}');
}

beforeEach(() => {
    registry._reset();
});

describe('buildSpriteAtlas', () => {
    it('resolves a file-texture frame through the texture store', async () => {
        sprite('sword', { src: 'items/sword.png', padding: 2, mipmap: false });

        const fs = fakeFs();
        await buildSpriteAtlas(registry.sprites, {
            bakedTextures: new Map(),
            textures: textureStore,
            cache: false,
            loader: fakeLoader,
            fs,
            raster: fakeRaster(),
        });

        const meta = sidecar(fs);
        expect(Object.keys(meta.sprites)).toEqual(['sword']);
        expect(meta.sprites.sword).toMatchObject({ padding: 2, mipmap: false });
        expect(meta.sprites.sword.frames).toHaveLength(1);
    });

    it('takes a region frame from the baked map like a computed one', async () => {
        const sheet = texture('sheet', { src: 'sheet.png' });
        const cut = texture('sheet:a', { of: sheet, region: [0, 0, 5, 7] });
        sprite('glyph-a', { frames: [cut], mipmap: false });

        const fs = fakeFs();
        await buildSpriteAtlas(registry.sprites, {
            bakedTextures: new Map([['sheet:a', { width: 5, height: 7 } as unknown as RasterCanvas]]),
            textures: textureStore,
            cache: false,
            loader: fakeLoader,
            fs,
            raster: fakeRaster(),
        });

        const frame = sidecar(fs).sprites['glyph-a'].frames[0];
        expect(frame).toMatchObject({ w: 5, h: 7 });
    });

    it('takes a computed frame from the baked map, keyed by texture id', async () => {
        const tex = texture('spark', { size: [4, 4], fn: () => {} });
        sprite('spark', { frames: [tex] });

        const fs = fakeFs();
        await buildSpriteAtlas(registry.sprites, {
            bakedTextures: new Map([['spark', { width: 4, height: 4 } as unknown as RasterCanvas]]),
            textures: textureStore,
            cache: false,
            loader: fakeLoader,
            fs,
            raster: fakeRaster(),
        });

        const frame = sidecar(fs).sprites.spark.frames[0];
        // the baked canvas's dims reach the sidecar, which is what proves the lookup by id
        // resolved rather than falling through to the magenta placeholder (16×16).
        expect(frame.w).toBe(4);
        expect(frame.h).toBe(4);
    });

    it('emits one rect per frame, in declaration order', async () => {
        sprite('flip', { src: ['a.png', 'b.png', 'c.png'] });

        const fs = fakeFs();
        await buildSpriteAtlas(registry.sprites, {
            bakedTextures: new Map(),
            textures: textureStore,
            cache: false,
            loader: fakeLoader,
            fs,
            raster: fakeRaster(),
        });

        expect(sidecar(fs).sprites.flip.frames).toHaveLength(3);
        // the `src` sugar declared one texture per frame.
        expect(textureStore.byId.has('flip:0')).toBe(true);
        expect(textureStore.byId.has('flip:2')).toBe(true);
    });
});
