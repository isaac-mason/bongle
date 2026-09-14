// The WebGL producer resolves a quad's section through `quadSlot[instanceIndex]`,
// stamped lazily per visible section. Every quad a frame draws must resolve to
// the section that owns its arena range; a stale stamp puts the quad at another
// chunk's origin.

import { registerAllShapes } from 'crashcat';
import { PerspectiveCamera } from 'gpucat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENVIRONMENT_DEFAULT } from '../../../../src/api/environment';
import { type ChunkMeshResult, type PassMesh, QUAD_STRIDE_U32S } from '../../../../src/core/voxels/chunk-mesher';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { CHUNK_SIZE, type Chunk, chunkKey, createChunk } from '../../../../src/core/voxels/voxels';
import * as Environment from '../../../../src/render/environment/environment';
import * as Time from '../../../../src/render/time';
import { PASSES } from '../../../../src/render/voxels/voxel-arena';
import * as VoxelResources from '../../../../src/render/voxels/voxel-resources-cpu';
import type { VoxelVisuals } from '../../../../src/render/voxels/voxel-visuals';

beforeAll(() => {
    registerAllShapes();
});
beforeEach(() => {
    resetVoxelRegistry();
});

function opaqueMesh(chunk: Chunk, quadCount: number): ChunkMeshResult {
    const quads = new Uint32Array(quadCount * QUAD_STRIDE_U32S);
    const opaque: PassMesh = {
        quads,
        quadCount,
        // facing 6 (unassigned) is never back-face culled, so every section draws.
        faceOffsets: [0, 0, 0, 0, 0, 0, 0],
        faceCounts: [0, 0, 0, 0, 0, 0, quadCount],
    };
    return {
        opaque,
        transparent: null,
        translucent: null,
        aabb: { min: [chunk.wx, chunk.wy, chunk.wz], max: [chunk.wx + CHUNK_SIZE, chunk.wy + CHUNK_SIZE, chunk.wz + CHUNK_SIZE] },
    };
}

function makeChunk(cx: number, cy: number, cz: number): Chunk {
    const chunk = createChunk(cx, cy, cz);
    chunk.nonAirCount = 1;
    return chunk;
}

function upsert(res: VoxelResources.VoxelResources, chunk: Chunk, quadCount: number): void {
    VoxelResources.upsertChunk(res, chunkKey(chunk.cx, chunk.cy, chunk.cz), chunk, opaqueMesh(chunk, quadCount));
}

function remove(res: VoxelResources.VoxelResources, chunk: Chunk): void {
    VoxelResources.removeChunk(res, chunkKey(chunk.cx, chunk.cy, chunk.cz));
}

/** every quad drawn this frame resolves, through `quadSlot`, to the section that owns it. */
function expectDrawsResolveToOwners(res: VoxelResources.VoxelResources): void {
    for (const pass of PASSES) {
        const draws = res.draws[pass];
        if (draws.length === 0) continue;
        const owner = new Int32Array(res.quadSlot.data.length).fill(-1);
        for (const alloc of res.arenas.allocs.values()) {
            const a = alloc[pass];
            if (a) owner.fill(a.sectionSlot, a.dataStart, a.dataStart + a.dataCount);
        }
        for (const draw of draws) {
            for (let i = draw.firstInstance; i < draw.firstInstance + draw.instanceCount; i++) {
                if (owner[i] < 0) throw new Error(`${pass}: drawn quad ${i} has no owning section`);
                if (res.quadSlot.data[i] !== owner[i]) {
                    throw new Error(`${pass}: quad ${i} stamped with slot ${res.quadSlot.data[i]}, owned by slot ${owner[i]}`);
                }
            }
        }
    }
}

describe('WebGL quadSlot stamping', () => {
    it('a section that returns on a freed slot with its old range is re-stamped after others wrote over it', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const env = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
        const res = VoxelResources.init(
            registry,
            env,
            {
                quadArenaBytes: 4096 * QUAD_STRIDE_U32S * 4,
                maxSections: 24,
                maxAllocs: 256,
                maxLightTiles: 24,
                lightGridChunkRadius: 8,
            },
            Time.init(),
        );
        const visuals = {
            meshes: { opaque: { draws: [] }, transparent: { draws: [] }, translucent: { draws: [] } },
        } as unknown as VoxelVisuals;
        // camera at z = -50 looking down +z: chunks at cz >= 0 are in view, cz = -6 is behind it.
        const camera = new PerspectiveCamera(Math.PI / 2, 1, 0.1, 2000);
        camera.position = [8, 8, -50];
        camera.lookAt([8, 8, 0]);
        camera.updateWorldMatrix();
        camera.updateViewMatrix();
        const frame = (): void => {
            VoxelResources.cullEmit(res, visuals, camera, 64);
        };

        const inFront = makeChunk(0, 0, 0);
        const behind = makeChunk(0, 0, -6);
        const inFrontToo = makeChunk(1, 0, 0);

        // room 1: one visible section fills arena [0, 40) on the first slot.
        upsert(res, inFront, 40);
        frame();
        expect(res.draws.opaque.length).toBe(1);

        VoxelResources.unmountRoom(res, null);

        // room 2: an out-of-view section reuses that slot and range without ever
        // being stamped; a visible one lands inside the old range on another slot.
        upsert(res, behind, 10);
        upsert(res, inFrontToo, 20);
        frame();
        expect(res.draws.opaque.length).toBe(1);
        remove(res, inFrontToo);
        remove(res, behind);

        // room 3: the same chunk comes back on the same slot with the same range.
        upsert(res, inFront, 40);
        frame();
        expect(res.draws.opaque.length).toBe(1);
        const slot = res.arenas.allocs.get(chunkKey(0, 0, 0))!.opaque!.sectionSlot;
        for (let i = 0; i < 40; i++) expect(res.quadSlot.data[i]).toBe(slot);
    });

    it('random upserts, removals and room clears never leave a drawn quad stamped with another section', {
        timeout: 60000,
    }, () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const env = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
        // tight budget so pressure eviction fires too
        const res = VoxelResources.init(
            registry,
            env,
            {
                quadArenaBytes: 500 * QUAD_STRIDE_U32S * 4,
                maxSections: 12,
                maxAllocs: 256,
                maxLightTiles: 12,
                lightGridChunkRadius: 8,
            },
            Time.init(),
        );
        res.arenas.camera = [8, 8, -50];
        const visuals = {
            meshes: { opaque: { draws: [] }, transparent: { draws: [] }, translucent: { draws: [] } },
        } as unknown as VoxelVisuals;
        const camera = new PerspectiveCamera(Math.PI / 2, 1, 0.1, 2000);
        camera.position = [8, 8, -50];
        camera.lookAt([8, 8, 0]);
        camera.updateWorldMatrix();
        camera.updateViewMatrix();

        const chunks: Chunk[] = [];
        for (let cx = -1; cx <= 1; cx++)
            for (let cy = 0; cy <= 1; cy++) for (let cz = -6; cz <= 3; cz += 3) chunks.push(makeChunk(cx, cy, cz));
        let seed = 7;
        const rand = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        for (let op = 0; op < 2000; op++) {
            const r = rand();
            const chunk = chunks[Math.floor(rand() * chunks.length)]!;
            if (r < 0.65) upsert(res, chunk, 1 + Math.floor(rand() * 60));
            else if (r < 0.97) remove(res, chunk);
            else VoxelResources.unmountRoom(res, null);
            res.arenas.evicted.clear();
            VoxelResources.cullEmit(res, visuals, camera, 64);
            expectDrawsResolveToOwners(res);
        }
    });
});
