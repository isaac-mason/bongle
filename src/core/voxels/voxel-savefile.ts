// voxel-savefile, disk persistence for Voxels chunk data.
//
// scope: filesystem boundary only (autosave, scene save, blueprint
// export, room boot). NOT a generic wire codec, network transport of
// chunk state goes through discovery.ts's chunk_full/chunk_ops messages
// which read the live chunk by reference.
//
// distinction from a future "ser/des":
//   - save/load (this file), converts to/from a portable byte form.
//     `saveVoxels` compacts each chunk's palette in the OUTPUT bytes
//     only; the live chunk is never mutated. `loadVoxels` replaces the
//     target Voxels' chunks entirely.
//   - ser/des (does not exist today), would be for in-memory or
//     network transport. must never mutate the source. add only when a
//     concrete consumer needs it.
//
// chunk data is stored with string-keyed palettes (stable across
// registry rebuilds). the runtime numeric palette is rebuilt from
// `palette` on load using the registry.
//
// per-chunk binary buffers (`blocks`, `light`) are gzip-compressed then
// base64-encoded, palette indices repeat heavily so gzip typically buys
// a 5-10× reduction on disk and over HMR.

import { gunzipSync, gzipSync } from 'fflate';
import type { BlockRegistry } from './block-registry';
import { resolveKey } from './block-registry';
import { CullType } from './blocks';
import {
    CHUNK_SIZE,
    CHUNK_VOLUME,
    type Chunk,
    chunkKey,
    EMPTY_LIGHT_MASK,
    linkChunkNeighbors,
    rebuildColumns,
    repackChunkSnapshot,
    type Voxels,
} from './voxels';

// ── save file format ────────────────────────────────────────────────

export type SavedChunk = {
    /** string-keyed palette entries (stable across registry rebuilds) */
    palette: string[];
    /** base64(gzip(raw Uint16Array bytes)), per-voxel palette index */
    blocks: string;
    /** base64(gzip(raw Uint16Array bytes)), baked light (CHUNK_VOLUME entries).
     *  missing or empty on pre-bake-format scenes, those load dark until the
     *  editor rebake-light command is run. */
    light: string;
};

export type SavedVoxels = {
    chunks: Record<string, SavedChunk>;
};

// ── pack / unpack helpers (work in both node and browser) ──────────

function bytesToBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    if (typeof Buffer !== 'undefined') {
        const buf = Buffer.from(b64, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function packChunkBytes(arr: Uint16Array): string {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    // mtime: 0 → fixed gzip header timestamp, so identical inputs produce
    // byte-identical outputs (fflate defaults to Date.now() otherwise, which
    // makes every save look "changed" to HMR / git).
    return bytesToBase64(gzipSync(bytes, { mtime: 0 }));
}

function unpackChunkBytes(b64: string): Uint16Array {
    const compressed = base64ToBytes(b64);
    const bytes = gunzipSync(compressed);
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

// ── save ────────────────────────────────────────────────────────────

/**
 * produce a save-file payload from a Voxels instance.
 *
 * compacts each chunk's palette in the OUTPUT BYTES only, uses
 * `repackChunkSnapshot` so the live chunk's `paletteKeys`/`data` are
 * never mutated (see invariant on Chunk.paletteKeys).
 *
 * skips chunks whose nonAirCount is zero (all air), they're created
 * lazily by setBlock + ensureChunk but never pruned at runtime.
 */
export function saveVoxels(voxels: Voxels): SavedVoxels {
    const result: SavedVoxels = { chunks: {} };

    for (const [key, chunk] of voxels.chunks) {
        if (chunk.nonAirCount === 0) continue;
        const snap = repackChunkSnapshot(chunk);

        result.chunks[key] = {
            palette: snap.paletteKeys,
            blocks: packChunkBytes(snap.data),
            light: packChunkBytes(chunk.light),
        };
    }

    return result;
}

// ── incremental save ────────────────────────────────────────────────
//
// the gzip-per-chunk in `saveVoxels` dominates flush cost on a big world.
// `saveVoxelsIncremental` re-serializes only chunks whose persisted-data
// `version` moved since the last flush, reusing cached bytes for the rest,
// so an auto-flush after a small edit pays only for the chunks that changed.

/** per-chunk serialized-byte cache, keyed by chunkKey. holds the bytes last
 *  written for a chunk and the `chunk.version` they were produced at. */
export type VoxelSaveCache = Map<string, { version: number; saved: SavedChunk }>;

/** like `saveVoxels`, but reuses `cache` for chunks whose `version` is
 *  unchanged. mutates `cache` in place: refreshes re-serialized chunks and
 *  prunes entries for chunks that are gone or became air. */
export function saveVoxelsIncremental(voxels: Voxels, cache: VoxelSaveCache): SavedVoxels {
    const result: SavedVoxels = { chunks: {} };

    for (const [key, chunk] of voxels.chunks) {
        if (chunk.nonAirCount === 0) continue;
        const cached = cache.get(key);
        if (cached && cached.version === chunk.version) {
            result.chunks[key] = cached.saved; // unchanged, skip the re-gzip
            continue;
        }
        const snap = repackChunkSnapshot(chunk);
        const saved: SavedChunk = {
            palette: snap.paletteKeys,
            blocks: packChunkBytes(snap.data),
            light: packChunkBytes(chunk.light),
        };
        result.chunks[key] = saved;
        cache.set(key, { version: chunk.version, saved });
    }

    // prune chunks that no longer contribute (destroyed or emptied to air)
    for (const key of cache.keys()) {
        if (result.chunks[key] === undefined) cache.delete(key);
    }

    return result;
}

/** seed a save cache from a just-loaded scene so the first flush is already
 *  incremental, an unedited chunk reuses its on-disk bytes verbatim. call
 *  right after `loadVoxels` with the same payload. */
export function seedVoxelSaveCache(voxels: Voxels, saved: SavedVoxels): VoxelSaveCache {
    const cache: VoxelSaveCache = new Map();
    if (!saved.chunks) return cache;
    for (const [key, sc] of Object.entries(saved.chunks)) {
        const chunk = voxels.chunks.get(key);
        if (chunk) cache.set(key, { version: chunk.version, saved: sc });
    }
    return cache;
}

// ── load ────────────────────────────────────────────────────────────

/**
 * load a save-file payload into a Voxels instance. replaces any
 * existing chunks on the instance. the registry is used to resolve
 * string keys to runtime numeric ids.
 */
export function loadVoxels(voxels: Voxels, saved: SavedVoxels, registry: BlockRegistry): void {
    if (!saved.chunks) return;

    voxels.chunks.clear();
    voxels.columns.clear();
    voxels.dirty.blocks.clear();
    voxels.dirty.light.clear();

    for (const [key, sc] of Object.entries(saved.chunks)) {
        // parse chunk coords from key "cx,cy,cz"
        const parts = key.split(',');
        if (parts.length !== 3) continue;

        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        if (Number.isNaN(cx) || Number.isNaN(cy) || Number.isNaN(cz)) continue;

        // decode blocks from base64+gzip
        const data = unpackChunkBytes(sc.blocks);

        // sanity check
        if (data.length !== CHUNK_VOLUME) continue;

        // decode baked light. missing/empty `light` field => dark world; the
        // editor's rebake-light command repairs it.
        let light: Uint16Array;
        if (sc.light) {
            const decoded = unpackChunkBytes(sc.light);
            light = decoded.length === CHUNK_VOLUME ? decoded : new Uint16Array(CHUNK_VOLUME);
        } else {
            light = new Uint16Array(CHUNK_VOLUME);
        }

        // rebuild palette from string keys
        const paletteKeys = sc.palette.slice();
        const palette: number[] = new Array(paletteKeys.length);
        const paletteMap = new Map<string, number>();

        for (let i = 0; i < paletteKeys.length; i++) {
            const pkey = paletteKeys[i]!;
            palette[i] = resolveKey(registry, pkey);
            paletteMap.set(pkey, i);
        }

        // count non-air blocks + fully-occluding (CullType.SOLID) blocks
        let nonAirCount = 0;
        let solidCount = 0;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            const globalId = palette[data[i]!]!;
            if (globalId !== 0 && globalId !== 1) nonAirCount++; // not AIR, not MISSING
            if (registry.cull[globalId] === CullType.SOLID) solidCount++;
        }

        const chunk: Chunk = {
            cx,
            cy,
            cz,
            wx: cx * CHUNK_SIZE,
            wy: cy * CHUNK_SIZE,
            wz: cz * CHUNK_SIZE,
            nonAirCount,
            solidCount,
            paletteKeys,
            palette,
            paletteMap,
            data,
            light,
            dirty: true,
            meshGen: 1,
            version: 1,
            lightDirty: false,
            lightDirtyMask: EMPTY_LIGHT_MASK,
            lightDirtyCount: 0,
            compressedSnapshot: null,
            snapshotPalette: null,
            compressedLight: null,
            neighbors: [null, null, null, null, null, null],
        };

        voxels.chunks.set(chunkKey(cx, cy, cz), chunk);
        // chunk seeded dirty=true above, mirror into the renderer index.
        voxels.dirty.blocks.add(chunk);
        linkChunkNeighbors(voxels, chunk);
    }

    rebuildColumns(voxels);
}
