// ── whole-map streaming: one-time cost estimate ──────────────────────
//
// answers a specific question: if we stop doing radius-based AOI for voxels and
// instead give every joining client the ENTIRE bounded map once (same dispatch
// machinery, just with stream radius set to cover the whole map and eviction
// never triggering), what does the one-time join cost look like, and how does it
// pace across N simultaneous joiners under the EXISTING per-tick budget?
//
// this does not simulate discovery's tick loop — it measures the two quantities
// that determine everything else: total compressed bytes for the whole map (the
// per-joiner payload), and the one-time server bake cost (propagateAllLight +
// encodeChunk over every chunk, which the real path pays lazily on first request
// via getCompressedSnapshot's cache-on-miss).
//
//   ./node_modules/.bin/tsx bench/whole-map-cost.ts [--spread N] [--joiners N]

// createWorld's own import chain resolves voxels.ts/light.ts's circular init
// safely; importing it first means the direct voxels/chunk-codec imports below
// just reuse those already-initialized modules instead of re-triggering the
// cycle from a different entry point (which throws a TDZ error on CHUNK_SIZE).
import { createWorld } from './discovery-world';
import { encodeChunk } from '../src/core/voxels/chunk-codec';
import { CHUNK_SIZE } from '../src/core/voxels/voxels';
import { nodeZstd } from '../src/node/zstd';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const SPREAD = Number(flag('spread', '256')); // blocks, half-extent (matches discovery-egress's default)
const JOINERS = Number(flag('joiners', '32'));

const t0 = performance.now();
const world = createWorld({ terrain: 'generated', spread: SPREAD, props: 0, clients: 0 });
const genMs = performance.now() - t0; // includes worldgen + propagateAllLight (createWorld does both)

const voxels = world.server.room.voxels;

// simulate the lazy bake every chunk pays on first client request (getCompressedSnapshot).
const t2 = performance.now();
let totalBytes = 0;
let totalChunks = 0;
const perChunkBytes: number[] = [];
for (const chunk of voxels.chunks.values()) {
    const compressed = encodeChunk(chunk.data, chunk.light, nodeZstd);
    chunk.compressedSnapshot = compressed;
    totalBytes += compressed.byteLength;
    perChunkBytes.push(compressed.byteLength);
    totalChunks++;
}
const bakeMs = performance.now() - t2;

perChunkBytes.sort((a, b) => a - b);
const avg = totalBytes / totalChunks;
const p50 = perChunkBytes[Math.floor(perChunkBytes.length * 0.5)];
const p95 = perChunkBytes[Math.floor(perChunkBytes.length * 0.95)];

// stream-radius sizing: a spherical AOI radius must cover the map's CORNER-to-
// opposite-corner distance for a player standing at any edge, not just the
// half-extent — a player at one corner needs to see the far corner.
const mapDiagonalBlocks = Math.sqrt((2 * SPREAD) ** 2 + (2 * SPREAD) ** 2);
const requiredRadiusChunks = Math.ceil(mapDiagonalBlocks / CHUNK_SIZE);

// existing per-tick budget (discovery.ts constants).
const FULL_CHUNKS_PER_CLIENT_PER_TICK = 6;
const ROOM_MAX_USERS = 8;
const globalCapAt = (players: number) => Math.floor(((players + ROOM_MAX_USERS) * FULL_CHUNKS_PER_CLIENT_PER_TICK) / 4) + 1;

console.log(`\nwhole-map streaming cost — generated terrain, +/-${SPREAD} blocks (${2 * SPREAD}x${2 * SPREAD})\n`);
console.log(`worldgen + light bake  ${genMs.toFixed(0)}ms`);
console.log(`compress all chunks    ${bakeMs.toFixed(0)}ms  (one-time; lazy on first client request today)`);
console.log(`\ntotal occupied chunks  ${totalChunks}`);
console.log(`total compressed size  ${(totalBytes / 1024 / 1024).toFixed(2)} MB  (one joiner's full-map payload)`);
console.log(`avg / p50 / p95 chunk  ${avg.toFixed(0)} / ${p50} / ${p95} bytes`);
console.log(`\nrequired spherical AOI radius to cover this map from any corner: ${requiredRadiusChunks} chunks`);
console.log(
    `  (current MAX_STREAM_RADIUS = 24 chunks; ${requiredRadiusChunks <= 24 ? 'already covers it' : `needs raising to >= ${requiredRadiusChunks}`})`,
);

console.log(`\npaced over the EXISTING per-tick per-client budget (${FULL_CHUNKS_PER_CLIENT_PER_TICK}/tick, 60Hz):`);
for (const n of [1, 8, JOINERS]) {
    const cap = globalCapAt(n);
    const perClientShare = Math.min(FULL_CHUNKS_PER_CLIENT_PER_TICK, cap / n);
    const ticksToJoin = Math.ceil(totalChunks / perClientShare);
    console.log(
        `  ${String(n).padStart(3)} simultaneous joiners: globalCap=${cap}/tick, ~${perClientShare.toFixed(1)} chunks/tick/client, ` +
            `~${ticksToJoin} ticks (${(ticksToJoin / 60).toFixed(1)}s) to fully join`,
    );
}
console.log();
