// ── client light origin gating ──────────────────────────────────────
//
// A networked mirror propagates light for blocks it writes itself
// (script-predicted edits) and for nothing else. Server-driven changes
// arrive already lit and must cost the client zero propagation.
//
// This is structural rather than flagged: the receive path (applyChunkFull /
// applyChunkOps) writes chunk data and light directly and never routes
// through setChunkBlock / ensureChunk / invalidateChunk, which are the only
// three sites that enqueue light work. These tests pin that invariant against
// the REAL receive functions, since nothing in the type system enforces it —
// swapping applyChunkFull to ensureChunk must fail here.

import { beforeEach, describe, expect, it } from 'vitest';
import * as VoxelNet from '../../src/client/voxel-net';
import type { VoxelChunkFull, VoxelChunkOps } from '../../src/core/protocol';
import { resolveKey } from '../../src/core/voxels/block-registry';
import { CullType } from '../../src/core/voxels/blocks';
import { encodeChunk } from '../../src/core/voxels/chunk-codec';
import { flushPendingLight, getRed } from '../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../src/core/voxels/test-helpers';
import type { Voxels } from '../../src/core/voxels/voxels';
import { chunkKey, createVoxels, createVoxelsAuthority, setBlock, voxelIndex } from '../../src/core/voxels/voxels';
// the codec takes an injected zstd impl; the server supplies Node native zstd
import { nodeZstd } from '../../src/node/zstd';

beforeEach(() => {
    resetVoxelRegistry();
});

function makeRegistry() {
    return buildTestRegistry([
        { id: 'stone', texId: 'stone' },
        // identical light properties to stone (opaque, no emission), different
        // block: swapping stone <-> granite is light-neutral.
        { id: 'granite', texId: 'granite' },
        { id: 'lamp', cull: CullType.NONE, texId: 'lamp', lightEmission: [15, 0, 0], lightOpacity: 0 },
    ]);
}

/** a mirror: no authority bundle, exactly as a networked ClientRoom builds it. */
function makeMirror(reg: ReturnType<typeof makeRegistry>): Voxels {
    return createVoxels(reg);
}

function makeAuthority(reg: ReturnType<typeof makeRegistry>): Voxels {
    const v = createVoxels(reg);
    v.authority = createVoxelsAuthority();
    return v;
}

/**
 * ship an authority's chunk to a mirror through the real encoder and the real
 * applyChunkFull. this is the initial-load path: light rides along baked.
 */
function deliverChunk(mirror: Voxels, authority: Voxels, cx: number, cy: number, cz: number): void {
    const src = authority.chunks.get(chunkKey(cx, cy, cz))!;
    const message: VoxelChunkFull = {
        type: 'voxel_chunk_full',
        playerId: 1,
        cx,
        cy,
        cz,
        palette: [...src.palette],
        compressed: encodeChunk(src.data, src.light, nodeZstd),
    };
    VoxelNet.applyChunkFull(VoxelNet.init(), mirror, message);
}

function opsMessage(voxels: Voxels, cx: number, cy: number, cz: number, index: number, key: string): VoxelChunkOps {
    return {
        type: 'voxel_chunk_ops',
        playerId: 1,
        chunks: [{ cx, cy, cz, changes: [{ index, stateId: resolveKey(voxels.registry, key) }] }],
    };
}

function queueSizes(voxels: Voxels) {
    return {
        blocks: voxels.lighting.blocks.length,
        chunks: voxels.lighting.chunks.size,
        newChunks: voxels.lighting.newChunks.length,
    };
}

/** an authority with a lit world in chunk (0,0,0). */
function litAuthority(reg: ReturnType<typeof makeRegistry>): Voxels {
    const authority = makeAuthority(reg);
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) setBlock(authority, x, 0, z, 'stone');
    }
    setBlock(authority, 4, 4, 4, 'lamp');
    flushPendingLight(authority);
    return authority;
}

describe('initial world load costs the client no light work', () => {
    it('applyChunkFull enqueues nothing and preserves wire-baked light exactly', () => {
        const reg = makeRegistry();
        const authority = litAuthority(reg);
        const mirror = makeMirror(reg);

        deliverChunk(mirror, authority, 0, 0, 0);

        // the real applyChunkFull builds chunks with createChunk, not
        // ensureChunk, so nothing lands in the sky-seed queue. if that ever
        // changes, flushing would reseed over the light that came off the wire.
        expect(queueSizes(mirror)).toEqual({ blocks: 0, chunks: 0, newChunks: 0 });

        const authChunk = authority.chunks.get(chunkKey(0, 0, 0))!;
        const mirrorChunk = mirror.chunks.get(chunkKey(0, 0, 0))!;
        expect(mirrorChunk.light).toEqual(authChunk.light);

        // and the client recomputes nothing on top of it
        flushPendingLight(mirror);
        expect(mirrorChunk.light).toEqual(authChunk.light);
    });
});

describe('server-driven block changes do no client light work', () => {
    it('applyChunkOps enqueues nothing and flushing recomputes nothing', () => {
        const reg = makeRegistry();
        const authority = litAuthority(reg);
        const mirror = makeMirror(reg);
        deliverChunk(mirror, authority, 0, 0, 0);

        const mirrorChunk = mirror.chunks.get(chunkKey(0, 0, 0))!;
        const before = mirrorChunk.light.slice();

        // a remote player places an emissive block. on an authority this queues
        // an incremental relight; on a mirror it must not.
        const index = voxelIndex(8, 8, 8);
        VoxelNet.applyChunkOps(mirror, opsMessage(mirror, 0, 0, 0, index, 'lamp'));

        expect(queueSizes(mirror)).toEqual({ blocks: 0, chunks: 0, newChunks: 0 });
        // the block really landed, so this is not a no-op message
        expect(mirrorChunk.data[index]).not.toBe(0);

        flushPendingLight(mirror);

        // byte-identical: the client derived nothing from the new block
        expect(mirrorChunk.light).toEqual(before);

        // and prove that is a real difference, not a vacuous one: the same
        // placement on an authority brightens the cell. the mirror is
        // demonstrably not running the BFS the authority runs.
        setBlock(authority, 8, 8, 8, 'lamp');
        expect(authority.lighting.blocks).toHaveLength(1);
        flushPendingLight(authority);

        const authChunk = authority.chunks.get(chunkKey(0, 0, 0))!;
        expect(getRed(authChunk.light[index]!)).toBeGreaterThan(getRed(mirrorChunk.light[index]!));
    });
});

describe('client-written blocks do propagate locally', () => {
    it('a predicted setBlock enqueues and lights in the same flush', () => {
        const reg = makeRegistry();
        const mirror = makeMirror(reg);

        setBlock(mirror, 8, 8, 8, 'lamp');
        expect(mirror.lighting.blocks).toHaveLength(1);

        flushPendingLight(mirror);

        const chunk = mirror.chunks.get(chunkKey(0, 0, 0))!;
        // emissive cell is lit, and light spread to the neighbour
        expect(getRed(chunk.light[voxelIndex(8, 8, 8)]!)).toBeGreaterThan(0);
        expect(getRed(chunk.light[voxelIndex(9, 8, 8)]!)).toBeGreaterThan(0);
    });

    it('produces byte-identical light to an authority', () => {
        const reg = makeRegistry();
        const mirror = makeMirror(reg);
        const authority = makeAuthority(reg);

        for (const v of [mirror, authority]) {
            setBlock(v, 8, 8, 8, 'lamp');
            setBlock(v, 10, 8, 8, 'stone');
            flushPendingLight(v);
        }

        const a = mirror.chunks.get(chunkKey(0, 0, 0))!;
        const b = authority.chunks.get(chunkKey(0, 0, 0))!;
        expect(a.light).toEqual(b.light);
    });
});

describe('light-neutral swaps skip the queue', () => {
    it('a swap with identical emission and opacity never enqueues', () => {
        const reg = makeRegistry();
        const voxels = makeAuthority(reg);

        setBlock(voxels, 8, 8, 8, 'stone');
        flushPendingLight(voxels);

        // granite matches stone's light properties exactly, so there is
        // nothing for the BFS to do
        setBlock(voxels, 8, 8, 8, 'granite');
        expect(voxels.lighting.blocks).toHaveLength(0);

        // a swap that does change emission still enqueues
        setBlock(voxels, 8, 8, 8, 'lamp');
        expect(voxels.lighting.blocks).toHaveLength(1);
    });
});

describe('light-only changes re-queue their chunk for remesh', () => {
    /** drain the remesh queue the way the renderer does (voxel-aoi). */
    function drainRemesh(voxels: Voxels): void {
        for (const c of voxels.dirty.blocks) c.dirty = false;
        voxels.dirty.blocks.clear();
    }

    it('a neighbour chunk lit across a boundary is re-queued every time its light changes', () => {
        const reg = makeRegistry();
        const mirror = makeMirror(reg);

        // two adjacent chunks: (0,0,0) spans x 0..15, (1,0,0) spans x 16..31
        setBlock(mirror, 20, 8, 8, 'stone');
        flushPendingLight(mirror);
        drainRemesh(mirror);

        const neighbour = mirror.chunks.get(chunkKey(1, 0, 0))!;
        const acrossBoundary = voxelIndex(0, 8, 8);

        // lamp well inside chunk 0 (x=10 is not a boundary coord, so
        // markBoundaryNeighborsDirty cannot mark chunk 1). only the light
        // BFS reaches across, which is exactly the path under test.
        setBlock(mirror, 10, 8, 8, 'lamp');
        flushPendingLight(mirror);
        expect(getRed(neighbour.light[acrossBoundary]!)).toBeGreaterThan(0);
        expect(mirror.dirty.blocks.has(neighbour)).toBe(true);

        drainRemesh(mirror);

        // remove it: the neighbour must darken AND be re-queued, or the stale
        // lit mesh stays on screen until something else dirties that chunk.
        setBlock(mirror, 10, 8, 8, 'air');
        flushPendingLight(mirror);

        expect(getRed(neighbour.light[acrossBoundary]!)).toBe(0);
        expect(mirror.dirty.blocks.has(neighbour)).toBe(true);
    });
});
