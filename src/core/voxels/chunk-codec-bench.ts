// Standalone ser/des shape exploration for chunk_full payloads.
//   run: node_modules/.bin/tsx src/core/voxels/chunk-codec-bench.ts
//
// input to every codec is the live in-memory chunk form:
//   data:  Uint16Array(4096) of palette INDICES (small ints)
//   light: Uint16Array(4096) of packed (sky<<12)|rgb
// paletteKeys (string[]) ride the wire identically for every variant, so
// they're excluded from the size comparison.
//
// goal: does dropping deflate + splitting streams (like the light codec
// already does) kill the inflateSync decode spike without bloating size?

import { deflateSync, inflateSync } from 'fflate';

const CHUNK_SIZE = 16;
const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096
const vi = (x: number, y: number, z: number) => x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE;
const packLight = (sky: number, r: number, g: number, b: number) => (sky << 12) | (r << 8) | (g << 4) | b;

// ── RLE (uint16 value/count pairs), copied from chunk-codec.ts ──────
function rleEncode(input: Uint16Array): Uint16Array {
    if (input.length === 0) return new Uint16Array(0);
    const pairs = new Uint16Array(input.length * 2);
    let n = 0,
        rv = input[0]!,
        rl = 1;
    for (let i = 1; i < input.length; i++) {
        const v = input[i]!;
        if (v === rv && rl < 65535) rl++;
        else {
            pairs[n++] = rv;
            pairs[n++] = rl;
            rv = v;
            rl = 1;
        }
    }
    pairs[n++] = rv;
    pairs[n++] = rl;
    return pairs.subarray(0, n);
}
function rleDecode(pairs: Uint16Array, outLen: number): Uint16Array {
    const out = new Uint16Array(outLen);
    let w = 0;
    for (let i = 0; i < pairs.length; i += 2) {
        const v = pairs[i]!,
            c = pairs[i + 1]!;
        for (let j = 0; j < c; j++) out[w++] = v;
    }
    return out;
}
const u16Bytes = (a: Uint16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

// split packed light into sky(4b) + rgb(12b)
function splitLight(light: Uint16Array): { sky: Uint16Array; rgb: Uint16Array } {
    const sky = new Uint16Array(light.length),
        rgb = new Uint16Array(light.length);
    for (let i = 0; i < light.length; i++) {
        const v = light[i]!;
        sky[i] = (v >>> 12) & 0xf;
        rgb[i] = v & 0xfff;
    }
    return { sky, rgb };
}

// ── codec variants ──────────────────────────────────────────────────
// each returns { bytes, dec } where bytes is the wire byte count and
// dec() reconstructs {data, light} for correctness checking.

type Codec = {
    name: string;
    run: (
        data: Uint16Array,
        light: Uint16Array,
    ) => {
        bytes: number;
        decode: () => { data: Uint16Array; light: Uint16Array };
    };
};

// A. baseline, current production: interleave → RLE u16 → deflate
const A_baseline: Codec = {
    name: 'A baseline (interleave+RLE+deflate)',
    run(data, light) {
        const inter = new Uint16Array(CHUNK_VOLUME * 2);
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            inter[i * 2] = data[i]!;
            inter[i * 2 + 1] = light[i]!;
        }
        const rle = rleEncode(inter);
        const compressed = deflateSync(u16Bytes(rle));
        return {
            bytes: compressed.length,
            decode() {
                const bytes = inflateSync(compressed);
                const r = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
                const flat = rleDecode(r, CHUNK_VOLUME * 2);
                const d = new Uint16Array(CHUNK_VOLUME),
                    l = new Uint16Array(CHUNK_VOLUME);
                for (let i = 0; i < CHUNK_VOLUME; i++) {
                    d[i] = flat[i * 2]!;
                    l[i] = flat[i * 2 + 1]!;
                }
                return { data: d, light: l };
            },
        };
    },
};

// B. split, NO deflate, RLE(data) + RLE(sky) + RLE(rgb), three fast expands
const B_splitNoDeflate: Codec = {
    name: 'B split, no deflate (RLE data/sky/rgb)',
    run(data, light) {
        const { sky, rgb } = splitLight(light);
        const dR = u16Bytes(rleEncode(data)).slice();
        const sR = u16Bytes(rleEncode(sky)).slice();
        const rR = u16Bytes(rleEncode(rgb)).slice();
        return {
            bytes: dR.length + sR.length + rR.length + 6, // +2/stream length prefix
            decode() {
                const dd = rleDecode(new Uint16Array(dR.buffer), CHUNK_VOLUME);
                const ss = rleDecode(new Uint16Array(sR.buffer), CHUNK_VOLUME);
                const rr = rleDecode(new Uint16Array(rR.buffer), CHUNK_VOLUME);
                const l = new Uint16Array(CHUNK_VOLUME);
                for (let i = 0; i < CHUNK_VOLUME; i++) l[i] = (ss[i]! << 12) | rr[i]!;
                return { data: dd, light: l };
            },
        };
    },
};

// D. split + ONE deflate over concatenated RLE streams (one inflate on decode)
const D_splitDeflateOnce: Codec = {
    name: 'D split + single deflate (concat)',
    run(data, light) {
        const { sky, rgb } = splitLight(light);
        const dR = u16Bytes(rleEncode(data)),
            sR = u16Bytes(rleEncode(sky)),
            rR = u16Bytes(rleEncode(rgb));
        const concat = new Uint8Array(12 + dR.length + sR.length + rR.length);
        const dv = new DataView(concat.buffer);
        dv.setUint32(0, dR.length);
        dv.setUint32(4, sR.length);
        dv.setUint32(8, rR.length);
        concat.set(dR, 12);
        concat.set(sR, 12 + dR.length);
        concat.set(rR, 12 + dR.length + sR.length);
        const compressed = deflateSync(concat);
        return {
            bytes: compressed.length,
            decode() {
                const raw = inflateSync(compressed);
                const dv2 = new DataView(raw.buffer, raw.byteOffset);
                const dl = dv2.getUint32(0),
                    sl = dv2.getUint32(4),
                    rl = dv2.getUint32(8);
                let off = 12;
                const dR2 = raw.slice(off, off + dl);
                off += dl;
                const sR2 = raw.slice(off, off + sl);
                off += sl;
                const rR2 = raw.slice(off, off + rl);
                const dd = rleDecode(new Uint16Array(dR2.buffer), CHUNK_VOLUME);
                const ss = rleDecode(new Uint16Array(sR2.buffer), CHUNK_VOLUME);
                const rr = rleDecode(new Uint16Array(rR2.buffer), CHUNK_VOLUME);
                const l = new Uint16Array(CHUNK_VOLUME);
                for (let i = 0; i < CHUNK_VOLUME; i++) l[i] = (ss[i]! << 12) | rr[i]!;
                return { data: dd, light: l };
            },
        };
    },
};

// E. bitpack indices (ceil(log2(palette)) bits, no RLE) + split-RLE light, no deflate
const E_bitpackIdx: Codec = {
    name: 'E bitpack idx + split-RLE light',
    run(data, light) {
        let maxIdx = 0;
        for (let i = 0; i < CHUNK_VOLUME; i++) if (data[i]! > maxIdx) maxIdx = data[i]!;
        const bits = Math.max(1, Math.ceil(Math.log2(maxIdx + 1)));
        const packed = new Uint8Array(Math.ceil((CHUNK_VOLUME * bits) / 8));
        let bitPos = 0;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            let v = data[i]!;
            for (let b = 0; b < bits; b++) {
                if (v & 1) packed[bitPos >> 3]! |= 1 << (bitPos & 7);
                v >>= 1;
                bitPos++;
            }
        }
        const { sky, rgb } = splitLight(light);
        const sR = u16Bytes(rleEncode(sky)).slice(),
            rR = u16Bytes(rleEncode(rgb)).slice();
        return {
            bytes: packed.length + sR.length + rR.length + 7, // +bits byte +2/stream
            decode() {
                const dd = new Uint16Array(CHUNK_VOLUME);
                let bp = 0;
                for (let i = 0; i < CHUNK_VOLUME; i++) {
                    let v = 0;
                    for (let b = 0; b < bits; b++) {
                        v |= ((packed[bp >> 3]! >> (bp & 7)) & 1) << b;
                        bp++;
                    }
                    dd[i] = v;
                }
                const ss = rleDecode(new Uint16Array(sR.buffer), CHUNK_VOLUME);
                const rr = rleDecode(new Uint16Array(rR.buffer), CHUNK_VOLUME);
                const l = new Uint16Array(CHUNK_VOLUME);
                for (let i = 0; i < CHUNK_VOLUME; i++) l[i] = (ss[i]! << 12) | rr[i]!;
                return { data: dd, light: l };
            },
        };
    },
};

// D2. data + COMBINED light (no sky/rgb split), RLE each, single deflate.
//     does the channel split earn its keep once deflate runs?
const D2_combinedLightDeflate: Codec = {
    name: 'D2 data+combined-light RLE, 1 deflate',
    run(data, light) {
        const dR = u16Bytes(rleEncode(data)),
            lR = u16Bytes(rleEncode(light));
        const concat = new Uint8Array(8 + dR.length + lR.length);
        const dv = new DataView(concat.buffer);
        dv.setUint32(0, dR.length);
        dv.setUint32(4, lR.length);
        concat.set(dR, 8);
        concat.set(lR, 8 + dR.length);
        const compressed = deflateSync(concat);
        return {
            bytes: compressed.length,
            decode() {
                const raw = inflateSync(compressed);
                const dv2 = new DataView(raw.buffer, raw.byteOffset);
                const dl = dv2.getUint32(0),
                    ll = dv2.getUint32(4);
                const dd = rleDecode(new Uint16Array(raw.slice(8, 8 + dl).buffer), CHUNK_VOLUME);
                const l = rleDecode(new Uint16Array(raw.slice(8 + dl, 8 + dl + ll).buffer), CHUNK_VOLUME);
                return { data: dd, light: l };
            },
        };
    },
};

// D3. split sky/rgb but NO RLE (raw u16 bytes) + single deflate.
//     does RLE earn its keep once deflate runs?
const D3_splitNoRleDeflate: Codec = {
    name: 'D3 split raw (no RLE), 1 deflate',
    run(data, light) {
        const { sky, rgb } = splitLight(light);
        const concat = new Uint8Array(u16Bytes(data).length + u16Bytes(sky).length + u16Bytes(rgb).length);
        concat.set(u16Bytes(data), 0);
        concat.set(u16Bytes(sky), u16Bytes(data).length);
        concat.set(u16Bytes(rgb), u16Bytes(data).length + u16Bytes(sky).length);
        const compressed = deflateSync(concat);
        return {
            bytes: compressed.length,
            decode() {
                const raw = inflateSync(compressed);
                const n2 = CHUNK_VOLUME * 2;
                const dd = new Uint16Array(raw.slice(0, n2).buffer);
                const ss = new Uint16Array(raw.slice(n2, n2 * 2).buffer);
                const rr = new Uint16Array(raw.slice(n2 * 2, n2 * 3).buffer);
                const l = new Uint16Array(CHUNK_VOLUME);
                for (let i = 0; i < CHUNK_VOLUME; i++) l[i] = (ss[i]! << 12) | rr[i]!;
                return { data: dd.slice(), light: l };
            },
        };
    },
};

// D4. dead simple: raw data + raw light bytes, single deflate. no RLE, no split.
const D4_rawDeflate: Codec = {
    name: 'D4 raw data+light, 1 deflate',
    run(data, light) {
        const concat = new Uint8Array(u16Bytes(data).length + u16Bytes(light).length);
        concat.set(u16Bytes(data), 0);
        concat.set(u16Bytes(light), u16Bytes(data).length);
        const compressed = deflateSync(concat);
        return {
            bytes: compressed.length,
            decode() {
                const raw = inflateSync(compressed);
                const n2 = CHUNK_VOLUME * 2;
                const dd = new Uint16Array(raw.slice(0, n2).buffer);
                const l = new Uint16Array(raw.slice(n2, n2 * 2).buffer);
                return { data: dd.slice(), light: l.slice() };
            },
        };
    },
};

const CODECS = [
    A_baseline,
    B_splitNoDeflate,
    D_splitDeflateOnce,
    D2_combinedLightDeflate,
    D3_splitNoRleDeflate,
    D4_rawDeflate,
    E_bitpackIdx,
];

// ── scenarios ───────────────────────────────────────────────────────
type Scene = { name: string; data: Uint16Array; light: Uint16Array };

function sceneUniformAir(): Scene {
    const data = new Uint16Array(CHUNK_VOLUME); // all 0 (air)
    const light = new Uint16Array(CHUNK_VOLUME).fill(packLight(15, 0, 0, 0));
    return { name: 'uniform-air (sky)', data, light };
}
function sceneSolidStone(): Scene {
    const data = new Uint16Array(CHUNK_VOLUME).fill(1);
    const light = new Uint16Array(CHUNK_VOLUME); // all dark
    return { name: 'solid-stone (dark)', data, light };
}
function sceneSurface(): Scene {
    // bottom 8 rows stone, top air; sky ramps 0->15 across a 3-row band at y=8..10
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    for (let y = 0; y < CHUNK_SIZE; y++) {
        const sky = y < 8 ? 0 : y >= 11 ? 15 : Math.round(((y - 8) / 3) * 15);
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                data[vi(x, y, z)] = y < 8 ? 1 : 0;
                light[vi(x, y, z)] = packLight(sky, 0, 0, 0);
            }
    }
    return { name: 'surface (terrain+sky band)', data, light };
}
function sceneLayered(): Scene {
    // stone/dirt/grass/air bands + sky gradient near top, palette of 4
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    for (let y = 0; y < CHUNK_SIZE; y++) {
        const idx = y < 4 ? 1 : y < 7 ? 2 : y < 8 ? 3 : 0;
        const sky = y < 8 ? 0 : y >= 11 ? 15 : Math.round(((y - 8) / 3) * 15);
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                data[vi(x, y, z)] = idx;
                light[vi(x, y, z)] = packLight(sky, 0, 0, 0);
            }
    }
    return { name: 'layered (4-palette+sky)', data, light };
}
function sceneCaveEmitter(): Scene {
    // enclosed air (sky=0), one emitter at centre with radial rgb falloff
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    const c = CHUNK_SIZE / 2;
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const d = Math.abs(x - c) + Math.abs(y - c) + Math.abs(z - c);
                const lvl = Math.max(0, 14 - d);
                light[vi(x, y, z)] = packLight(0, lvl, lvl, lvl);
            }
    return { name: 'cave-emitter (rgb radial)', data, light };
}
function sceneMixedBuild(): Scene {
    // realistic-ish: open sky above y=10, a structure below with ~6 block types
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    let seed = 99;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
    };
    for (let y = 0; y < CHUNK_SIZE; y++) {
        const open = y >= 10;
        const sky = open ? 15 : y >= 8 ? Math.round(((y - 8) / 2) * 15) : 0;
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                // structure: walls + scattered blocks below y=10
                let idx = 0;
                if (!open) {
                    const wall = x === 0 || x === 15 || z === 0 || z === 15 || y === 0;
                    idx = wall ? 1 + (rnd() % 3) : rnd() % 8 === 0 ? 4 + (rnd() % 2) : 0;
                }
                data[vi(x, y, z)] = idx;
                light[vi(x, y, z)] = packLight(idx === 0 ? sky : 0, 0, 0, 0);
            }
    }
    return { name: 'mixed-build (6-palette)', data, light };
}
function sceneNoisy(): Scene {
    // pathological worst case for RLE: random palette-8 + noisy light
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    let seed = 7;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
    };
    for (let i = 0; i < CHUNK_VOLUME; i++) {
        data[i] = rnd() % 8;
        light[i] = packLight(rnd() % 16, rnd() % 4, rnd() % 4, rnd() % 4);
    }
    return { name: 'noisy (worst case)', data, light };
}

const SCENES = [
    sceneUniformAir(),
    sceneSolidStone(),
    sceneSurface(),
    sceneLayered(),
    sceneCaveEmitter(),
    sceneMixedBuild(),
    sceneNoisy(),
];

// ── correctness ─────────────────────────────────────────────────────
function eq(a: Uint16Array, b: Uint16Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ── timing ──────────────────────────────────────────────────────────
function timeUs(fn: () => void, iters: number): number {
    for (let i = 0; i < Math.min(50, iters); i++) fn(); // warmup
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    return ((performance.now() - t0) / iters) * 1000; // µs/op
}

// ── run ─────────────────────────────────────────────────────────────
const ENC_ITERS = 2000,
    DEC_ITERS = 5000;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

for (const scene of SCENES) {
    console.log(`\n=== ${scene.name} ===`);
    console.log(pad('codec', 38) + padL('bytes', 8) + padL('enc µs', 10) + padL('dec µs', 10) + padL('ok', 5));
    const baseBytes = A_baseline.run(scene.data, scene.light).bytes;
    for (const codec of CODECS) {
        const built = codec.run(scene.data, scene.light);
        const out = built.decode();
        const ok = eq(out.data, scene.data) && eq(out.light, scene.light);
        const encUs = timeUs(() => {
            codec.run(scene.data, scene.light);
        }, ENC_ITERS);
        const decUs = timeUs(() => {
            built.decode();
        }, DEC_ITERS);
        const rel = baseBytes ? ` (${((built.bytes / baseBytes) * 100).toFixed(0)}%)` : '';
        console.log(
            pad(codec.name, 38) +
                padL(String(built.bytes), 8) +
                padL(encUs.toFixed(1), 10) +
                padL(decUs.toFixed(2), 10) +
                padL(ok ? 'y' : 'FAIL', 5) +
                rel,
        );
    }
}
console.log('\n(bytes excludes paletteKeys string[] — identical across variants)');
