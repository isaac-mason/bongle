import { describe, expect, it } from 'vitest';
import { decodeChunk, decodeLight, encodeChunk, encodeLight, rleDecode, rleEncode } from './chunk-codec';
import { CHUNK_VOLUME } from './voxels';

describe('rleEncode / rleDecode', () => {
    it('empty input', () => {
        const encoded = rleEncode(new Uint16Array(0));
        expect(encoded.length).toBe(0);
    });

    it('single value', () => {
        const input = new Uint16Array([42]);
        const encoded = rleEncode(input);
        expect(encoded.length).toBe(2);
        expect(encoded[0]).toBe(42);
        expect(encoded[1]).toBe(1);

        const decoded = rleDecode(encoded, 1);
        expect(decoded).toEqual(input);
    });

    it('all same values', () => {
        const input = new Uint16Array(4096).fill(7);
        const encoded = rleEncode(input);
        // single run: [7, 4096]
        expect(encoded.length).toBe(2);
        expect(encoded[0]).toBe(7);
        expect(encoded[1]).toBe(4096);

        const decoded = rleDecode(encoded, 4096);
        expect(decoded).toEqual(input);
    });

    it('alternating values', () => {
        const input = new Uint16Array(6);
        input[0] = 1;
        input[1] = 2;
        input[2] = 1;
        input[3] = 2;
        input[4] = 1;
        input[5] = 2;

        const encoded = rleEncode(input);
        // 6 runs of length 1: [1,1, 2,1, 1,1, 2,1, 1,1, 2,1]
        expect(encoded.length).toBe(12);

        const decoded = rleDecode(encoded, 6);
        expect(decoded).toEqual(input);
    });

    it('roundtrip with mixed runs', () => {
        const input = new Uint16Array(20);
        input.fill(0, 0, 10); // 10 zeros
        input.fill(5, 10, 15); // 5 fives
        input.fill(0, 15, 20); // 5 zeros

        const encoded = rleEncode(input);
        // 3 runs: [0,10, 5,5, 0,5]
        expect(encoded.length).toBe(6);

        const decoded = rleDecode(encoded, 20);
        expect(decoded).toEqual(input);
    });

    it('handles max run length (65535)', () => {
        // 65535 + 1 = 65536 of the same value → should split into two runs
        const input = new Uint16Array(65536).fill(3);
        const encoded = rleEncode(input);
        // [3, 65535, 3, 1]
        expect(encoded.length).toBe(4);
        expect(encoded[0]).toBe(3);
        expect(encoded[1]).toBe(65535);
        expect(encoded[2]).toBe(3);
        expect(encoded[3]).toBe(1);

        const decoded = rleDecode(encoded, 65536);
        expect(decoded).toEqual(input);
    });

    it('every value different', () => {
        const input = new Uint16Array(100);
        for (let i = 0; i < 100; i++) input[i] = i;

        const encoded = rleEncode(input);
        // 100 runs of length 1: 200 elements
        expect(encoded.length).toBe(200);

        const decoded = rleDecode(encoded, 100);
        expect(decoded).toEqual(input);
    });
});

describe('encodeChunk / decodeChunk', () => {
    it('roundtrip empty chunk (all air, no light)', () => {
        const data = new Uint16Array(CHUNK_VOLUME); // all zeros
        const light = new Uint16Array(CHUNK_VOLUME); // all zeros

        const compressed = encodeChunk(data, light);
        expect(compressed.byteLength).toBeLessThan(100); // should compress very small

        const result = decodeChunk(compressed);
        expect(result.data).toEqual(data);
        expect(result.light).toEqual(light);
    });

    it('roundtrip solid chunk with uniform light', () => {
        const data = new Uint16Array(CHUNK_VOLUME).fill(1); // all block id 1
        const light = new Uint16Array(CHUNK_VOLUME).fill(0xf000); // full sky light

        const compressed = encodeChunk(data, light);
        // each channel is uniform → one RLE run apiece → tiny
        expect(compressed.byteLength).toBeLessThan(100);

        const result = decodeChunk(compressed);
        expect(result.data).toEqual(data);
        expect(result.light).toEqual(light);
    });

    it('roundtrip chunk with varied content', () => {
        const data = new Uint16Array(CHUNK_VOLUME);
        const light = new Uint16Array(CHUNK_VOLUME);

        // half stone, half air, with different light values
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            data[i] = i < CHUNK_VOLUME / 2 ? 1 : 0;
            light[i] = i < CHUNK_VOLUME / 2 ? 0 : 0xf000;
        }

        const compressed = encodeChunk(data, light);
        const result = decodeChunk(compressed);
        expect(result.data).toEqual(data);
        expect(result.light).toEqual(light);
    });

    it('roundtrip fully random data', () => {
        const data = new Uint16Array(CHUNK_VOLUME);
        const light = new Uint16Array(CHUNK_VOLUME);

        // pseudo-random but deterministic
        let seed = 12345;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            data[i] = seed & 0xffff;
            light[i] = (seed >> 8) & 0xffff;
        }

        const compressed = encodeChunk(data, light);
        const result = decodeChunk(compressed);
        expect(result.data).toEqual(data);
        expect(result.light).toEqual(light);
    });

    it('compressed size is reasonable for typical chunks', () => {
        // typical chunk: mostly air (palette 0) with sky light, some ground
        const data = new Uint16Array(CHUNK_VOLUME);
        const light = new Uint16Array(CHUNK_VOLUME);

        // bottom half is stone (palette 1), top half is air (palette 0)
        // light: stone has 0, air has full sky (0xF000)
        for (let y = 0; y < 16; y++) {
            for (let z = 0; z < 16; z++) {
                for (let x = 0; x < 16; x++) {
                    const idx = (y << 8) | (z << 4) | x;
                    if (y < 8) {
                        data[idx] = 1; // stone
                        light[idx] = 0;
                    } else {
                        data[idx] = 0; // air
                        light[idx] = 0xf000; // sky light
                    }
                }
            }
        }

        const compressed = encodeChunk(data, light);
        // raw data would be 4096 * 2 * 2 = 16384 bytes
        // with RLE + deflate this should be much smaller
        expect(compressed.byteLength).toBeLessThan(200);

        const result = decodeChunk(compressed);
        expect(result.data).toEqual(data);
        expect(result.light).toEqual(light);
    });
});

describe('encodeLight / decodeLight', () => {
    it('roundtrip uniform full sky', () => {
        const light = new Uint16Array(CHUNK_VOLUME).fill(0xf000);
        const { sky, rgb } = encodeLight(light);
        const decoded = decodeLight(sky, rgb);
        expect(decoded).toEqual(light);
    });

    it('roundtrip all dark', () => {
        const light = new Uint16Array(CHUNK_VOLUME); // all zeros
        const { sky, rgb } = encodeLight(light);
        const decoded = decodeLight(sky, rgb);
        expect(decoded).toEqual(light);
    });

    it('roundtrip surface band — sky gradient + rgb=0', () => {
        // bottom half buried (sky=0), top half open (sky=15)
        const light = new Uint16Array(CHUNK_VOLUME);
        for (let y = 0; y < 16; y++) {
            for (let z = 0; z < 16; z++) {
                for (let x = 0; x < 16; x++) {
                    const idx = (y << 8) | (z << 4) | x;
                    light[idx] = y < 8 ? 0 : 0xf000;
                }
            }
        }
        const { sky, rgb } = encodeLight(light);
        const decoded = decodeLight(sky, rgb);
        expect(decoded).toEqual(light);
    });

    it('roundtrip cave with torch — sky=0 + rgb gradient', () => {
        // sky=0 everywhere, rgb falls off from a single emitter
        const light = new Uint16Array(CHUNK_VOLUME);
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            // arbitrary rgb pattern — gradient that creates a few distinct runs
            const r = i & 0xf;
            const g = (i >> 4) & 0xf;
            const b = (i >> 8) & 0xf;
            light[i] = (r << 8) | (g << 4) | b;
        }
        const { sky, rgb } = encodeLight(light);
        const decoded = decodeLight(sky, rgb);
        expect(decoded).toEqual(light);
    });

    it('roundtrip mixed sky and rgb', () => {
        const light = new Uint16Array(CHUNK_VOLUME);
        let seed = 98765;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const skyN = (seed >> 4) & 0xf;
            const r = (seed >> 8) & 0xf;
            const g = (seed >> 12) & 0xf;
            const b = (seed >> 16) & 0xf;
            light[i] = (skyN << 12) | (r << 8) | (g << 4) | b;
        }
        const { sky, rgb } = encodeLight(light);
        const decoded = decodeLight(sky, rgb);
        expect(decoded).toEqual(light);
    });

    it('compressed size is tiny for uniform sky', () => {
        const light = new Uint16Array(CHUNK_VOLUME).fill(0xf000);
        const { sky, rgb } = encodeLight(light);
        // both channels are uniform → each RLE collapses to one run
        expect(sky.byteLength + rgb.byteLength).toBeLessThan(100);
    });
});
