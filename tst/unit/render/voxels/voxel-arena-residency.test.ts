// Drives the WebGPU producer's residency layer headlessly (gpucat buffers stay
// CPU-side until a renderer uploads them) through random upserts, removals,
// pressure evictions and room clears. After every op, each resident section's
// ChunkInfo (origin + arenaBase), face meta, cull record, and the quad bytes in
// the arena must all agree with the mesh that was upserted; no two live
// allocations may overlap; no two live sections may share a slot.

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENVIRONMENT_DEFAULT } from '../../../../src/api/environment';
import { type ChunkMeshResult, type PassMesh, QUAD_STRIDE_U32S } from '../../../../src/core/voxels/chunk-mesher';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { CHUNK_SIZE, type Chunk, chunkKey, createChunk } from '../../../../src/core/voxels/voxels';
import * as Environment from '../../../../src/render/environment/environment';
import * as Time from '../../../../src/render/time';
import { PASSES } from '../../../../src/render/voxels/voxel-arena';
import type { VoxelPass } from '../../../../src/render/voxels/voxel-material';
import * as VoxelResources from '../../../../src/render/voxels/voxel-resources-gpu';

beforeAll(() => {
    registerAllShapes();
});
beforeEach(() => {
    resetVoxelRegistry();
});

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/** a tagged synthetic pass mesh: every u32 encodes (chunk, pass, variant, index). */
function tagWord(cx: number, cy: number, cz: number, pass: number, variant: number, i: number): number {
    return (Math.imul(cx * 73856093 + cy * 19349663 + cz * 83492791, 2654435761) ^ (pass << 28) ^ (variant << 16) ^ i) >>> 0;
}

function makePassMesh(cx: number, cy: number, cz: number, pass: number, variant: number, quadCount: number): PassMesh | null {
    if (quadCount === 0) return null;
    const quads = new Uint32Array(quadCount * QUAD_STRIDE_U32S);
    for (let i = 0; i < quads.length; i++) quads[i] = tagWord(cx, cy, cz, pass, variant, i);
    return {
        quads,
        quadCount,
        faceOffsets: [0, quadCount, quadCount, quadCount, quadCount, quadCount, quadCount],
        faceCounts: [quadCount, 0, 0, 0, 0, 0, 0],
    };
}

function makeMesh(chunk: Chunk, variant: number, counts: [number, number, number]): ChunkMeshResult {
    return {
        opaque: makePassMesh(chunk.cx, chunk.cy, chunk.cz, 0, variant, counts[0]),
        transparent: makePassMesh(chunk.cx, chunk.cy, chunk.cz, 1, variant, counts[1]),
        translucent: makePassMesh(chunk.cx, chunk.cy, chunk.cz, 2, variant, counts[2]),
        aabb: { min: [chunk.wx, chunk.wy, chunk.wz], max: [chunk.wx + CHUNK_SIZE, chunk.wy + CHUNK_SIZE, chunk.wz + CHUNK_SIZE] },
    };
}

function checkInvariants(res: VoxelResources.VoxelResources, model: Map<string, { chunk: Chunk; mesh: ChunkMeshResult }>): void {
    const packer = res.arenas;
    const quads = packer.quadArena.buffers.quads.array as Uint32Array;
    const ranges: Array<{ start: number; end: number; key: string }> = [];
    const slotsInUse: Record<VoxelPass, Set<number>> = { opaque: new Set(), transparent: new Set(), translucent: new Set() };
    expect(packer.chunks.length).toBe(packer.allocs.size);
    for (const [key, alloc] of packer.allocs) {
        const entry = model.get(key);
        expect(entry, `resident ${key} is not in the model`).toBeDefined();
        const { chunk, mesh } = entry!;
        expect(packer.chunks[alloc.chunkIndex]).toBe(alloc);
        const recBase = alloc.chunkIndex * 6;
        const rec = packer.cullRecordsU32;
        expect(rec[recBase + 0] | 0).toBe(chunk.cx);
        expect(rec[recBase + 1] | 0).toBe(chunk.cy);
        expect(rec[recBase + 2] | 0).toBe(chunk.cz);
        for (let p = 0; p < 3; p++) {
            const pass = PASSES[p]!;
            const pa = alloc[pass];
            const pm = mesh[pass];
            expect(rec[recBase + 3 + p] | 0).toBe(pa ? pa.sectionSlot : -1);
            if (!pa) {
                expect(pm, `${key}/${pass}: mesh present but pass not resident`).toBeNull();
                continue;
            }
            expect(pm, `${key}/${pass}: pass resident but mesh empty`).not.toBeNull();
            expect(pa.dataCount).toBe(pm!.quadCount);
            expect(slotsInUse[pass].has(pa.sectionSlot), `${key}/${pass}: slot ${pa.sectionSlot} shared`).toBe(false);
            slotsInUse[pass].add(pa.sectionSlot);
            ranges.push({ start: pa.dataStart, end: pa.dataStart + pa.dataCount, key: `${key}/${pass}` });
            // ChunkInfo: origin + arenaBase
            const table = packer.tables[pass];
            const info32 = table.buffer.array as Float32Array;
            const base = pa.sectionSlot * table.entryU32s;
            expect(info32[base + 0]).toBe(chunk.wx);
            expect(info32[base + 1]).toBe(chunk.wy);
            expect(info32[base + 2]).toBe(chunk.wz);
            expect(table.dataU32[base + 3]).toBe(pa.dataStart);
            // face meta
            const metaBase = pa.sectionSlot * 14;
            let total = 0;
            for (let f = 0; f < 7; f++) {
                if (table.metaU32[metaBase + f] !== pm!.faceOffsets[f] || table.metaU32[metaBase + 7 + f] !== pm!.faceCounts[f]) {
                    throw new Error(`${key}/${pass}: meta facing ${f} differs`);
                }
                total += table.metaU32[metaBase + 7 + f]!;
            }
            expect(total).toBe(pm!.quadCount);
            // arena bytes
            const off = pa.dataStart * QUAD_STRIDE_U32S;
            for (let i = 0; i < pm!.quads.length; i++) {
                if (quads[off + i] !== pm!.quads[i]) {
                    throw new Error(
                        `${key}/${pass}: arena word ${i} differs (slot ${pa.sectionSlot}, dataStart ${pa.dataStart})`,
                    );
                }
            }
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
        const p = ranges[i - 1]!;
        const c = ranges[i]!;
        if (c.start < p.end) throw new Error(`overlap: ${p.key} [${p.start},${p.end}) vs ${c.key} [${c.start},${c.end})`);
    }
    // freed slots must be zeroed so the cull can never emit them
    for (const pass of PASSES) {
        const table = packer.tables[pass];
        for (const slot of table.freeStack) {
            const metaBase = slot * 14;
            for (let f = 0; f < 14; f++)
                if (table.metaU32[metaBase + f] !== 0) throw new Error(`${pass}: freed slot ${slot} meta not zeroed`);
        }
    }
}

describe('WebGPU voxel arena residency', () => {
    it('sections, meta, cull records and arena bytes stay consistent across upserts, evictions and room clears', {
        timeout: 120000,
    }, () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const env = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
        // tight budget: ~600 quads and 24 sections per pass, so pressure eviction fires
        const budget = { quadArenaBytes: 600 * QUAD_STRIDE_U32S * 4, maxSections: 24, maxAllocs: 512 };
        const res = VoxelResources.init(registry, env, budget, Time.init());
        res.arenas.camera = [0, 0, 0];

        const chunks: Chunk[] = [];
        for (let i = 0; i < 40; i++) {
            const c = createChunk((i % 5) - 2, Math.floor(i / 5) % 4, Math.floor(i / 20) - 1);
            c.nonAirCount = 1;
            chunks.push(c);
        }
        const model = new Map<string, { chunk: Chunk; mesh: ChunkMeshResult }>();

        for (let seed = 1; seed <= 3; seed++) {
            const rand = rng(seed);
            let variant = 1;
            for (let op = 0; op < 900; op++) {
                const r = rand();
                const chunk = chunks[Math.floor(rand() * chunks.length)]!;
                const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
                if (r < 0.7) {
                    const counts: [number, number, number] = [
                        rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 40),
                        rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 10),
                        rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 20),
                    ];
                    const mesh = makeMesh(chunk, variant++, counts);
                    VoxelResources.upsertChunk(res, key, chunk, mesh);
                    model.set(key, { chunk, mesh });
                } else if (r < 0.95) {
                    VoxelResources.removeChunk(res, key);
                    model.delete(key);
                } else {
                    VoxelResources.unmountRoom(res, null);
                    model.clear();
                }
                // pressure-evicted chunks leave the arena (and get re-dirtied in the
                // real loop); drop them from the model so residency is compared 1:1.
                for (const evicted of res.arenas.evicted) model.delete(evicted);
                res.arenas.evicted.clear();
                for (const key of [...model.keys()]) if (!res.arenas.allocs.has(key)) model.delete(key);
                if (op % 7 === 0 || r >= 0.95) checkInvariants(res, model);
            }
        }
    });
});
