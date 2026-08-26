import { bench, group } from '@pmndrs/labs';
import { createWorld } from '../bench/discovery-world';
import { decodeChunk, decodeLight, encodeChunk, encodeLight } from '../src/core/voxels/chunk-codec';
import type { Chunk } from '../src/core/voxels/voxels';
import { CHUNK_VOLUME } from '../src/core/voxels/voxels';
import { nodeZstd } from '../src/node/zstd';

// isolated ser/des cost for one chunk's data+light — the thing a discovery-time
// voxel_region_full bundle spends its compute on, separated from the rest of the
// discovery/scene/net pipeline (see profile-editor-flycam.ts / discovery-egress.ts
// for the whole-system view, and the 2026-08 spike investigation this bench
// answers: is a chunk's real ser/des cost uniform enough to trust as a pacing
// proxy, and what does the JIT-warmed steady-state actually cost per chunk).
//
// fixtures are REAL chunks pulled from the same generated-terrain generator the
// other benches use (not synthetic guesses), plus one synthetic worst case
// (checkerboard data — defeats RLE almost entirely) to bound the upper end.
//
// run: `pnpm --filter benches exec labs` (or `pnpm bench:labs` from lib/).

const world = createWorld({ clients: 0, props: 0, terrain: 'generated', spread: 32 });
const chunks = [...world.server.room.voxels.chunks.values()];

function findChunk(label: string, predicate: (c: Chunk) => boolean): Chunk {
    const found = chunks.find(predicate);
    if (!found) throw new Error(`chunk-codec.bench.ts: no fixture chunk found for "${label}" — adjust spread/predicate`);
    return found;
}

// fixtures are picked by distinct-local-slot count (not nonAirCount/block
// identity — RLE and zstd only ever see raw slot values, so run structure is
// what determines cost, not which real block a slot happens to resolve to).
const uniformChunk = findChunk('uniform', (c) => new Set(c.data).size === 1);
const sparseChunk = findChunk('sparse mix', (c) => new Set(c.data).size === 2);
const denseChunk = findChunk('dense mix', (c) => new Set(c.data).size >= 6);

// synthetic worst case: a short repeating cycle so every run is length 1 —
// RLE degrades to (value, 1) pairs for the whole chunk, and zstd's window has
// no long runs to lean on either. bounds the upper end no real terrain here
// produces, but a heavily hand-edited/noisy build might approach.
function checkerboard(period: number, scale: number): Uint16Array {
    const out = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++) out[i] = (i % period) * scale;
    return out;
}
const checkerboardData = checkerboard(7, 1);
const checkerboardLight = checkerboard(11, 37);

type Fixture = { label: string; data: Uint16Array; light: Uint16Array };
const fixtures: Fixture[] = [
    { label: 'uniform (real terrain, single run)', data: uniformChunk.data, light: uniformChunk.light },
    { label: 'sparse mix (real terrain, 2 distinct slots)', data: sparseChunk.data, light: sparseChunk.light },
    { label: 'dense mix (real terrain, 6+ distinct slots)', data: denseChunk.data, light: denseChunk.light },
    { label: 'checkerboard (synthetic worst case)', data: checkerboardData, light: checkerboardLight },
];

group('chunk-codec: encodeChunk (server: RLE + zstd) @codec', () => {
    for (const f of fixtures) {
        bench(`encodeChunk — ${f.label}`, () => encodeChunk(f.data, f.light, nodeZstd));
    }
});

group('chunk-codec: decodeChunk (client: zstd + RLE) @codec', () => {
    for (const f of fixtures) {
        const compressed = encodeChunk(f.data, f.light, nodeZstd);
        bench(`decodeChunk — ${f.label}`, () => decodeChunk(compressed));
    }
});

// the light-only path (voxel_chunk_light — post-discovery light updates for
// already-known chunks): no zstd, RLE only. separate group since its cost shape
// is different (cheaper, no compression step) from the discovery-time full path.
group('chunk-codec: light-only (voxel_chunk_light — RLE, no zstd) @codec', () => {
    for (const f of fixtures) {
        bench(`encodeLight — ${f.label}`, () => encodeLight(f.light));
        const encoded = encodeLight(f.light);
        bench(`decodeLight — ${f.label}`, () => decodeLight(encoded.sky, encoded.rgb));
    }
});
