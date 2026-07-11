// ── block-registry-serde tests ──────────────────────────────────────
//
// Two invariants matter at the worker boundary:
//   1. Byte-equality round-trip, every typed array the mesher reads
//      survives `serialize → ArrayBuffer → deserialize` unchanged.
//   2. Functional equivalence, running `meshChunk` against the decoded
//      partial registry produces byte-identical quad buffers + face
//      counts vs. running against the source registry.

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stairs } from '../../../../src/core/voxels/block-presets';
import type { BlockRegistry } from '../../../../src/core/voxels/block-registry';
import {
    type DeserializedBlockRegistry,
    deserializeBlockRegistryForWorker,
    serializeBlockRegistryForWorker,
} from '../../../../src/core/voxels/block-registry-serde';
import { blockTexture, CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { buildMeshInput, type ChunkMeshResult, createMeshOutput, meshChunk, type PassMesh } from '../../../../src/core/voxels/chunk-mesher';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { createChunk, createVoxels, setChunkBlock } from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

// Build a registry that exercises both the cube path and the mesh
// path (stairs). The serde must round-trip per-state and per-mesh
// tables, so we want at least one of each kind.
function buildMixedRegistry(): BlockRegistry {
    blockTexture('stone', { src: 'textures/stone.png' });
    stairs('stair', { all: { texture: 'stone' } });
    return buildTestRegistry([
        { id: 'block', texId: 'block' },
        { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass' },
        { id: 'lamp', texId: 'lamp', lightEmission: [15, 8, 4], emissive: true },
    ]);
}

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    return true;
}

describe('block-registry-serde', () => {
    describe('round-trip', () => {
        it('produces a buffer with the magic header', () => {
            const reg = buildMixedRegistry();
            const buf = serializeBlockRegistryForWorker(reg, 7);
            const u32 = new Uint32Array(buf);
            expect(u32[0]).toBe(0xb7e61571);
            expect(u32[1]).toBe(7);
        });

        it('rejects buffers with bad magic', () => {
            const buf = new ArrayBuffer(64);
            new Uint32Array(buf)[0] = 0xdeadbeef | 0;
            expect(() => deserializeBlockRegistryForWorker(buf)).toThrow(/bad magic/);
        });

        it('round-trips per-state tables byte-equal', () => {
            const reg = buildMixedRegistry();
            const buf = serializeBlockRegistryForWorker(reg, 1);
            const out = deserializeBlockRegistryForWorker(buf);

            expect(out.totalStates).toBe(reg.totalStates);
            expect(bytesEqual(out.cull!, reg.cull)).toBe(true);
            expect(bytesEqual(out.blockTypeId!, reg.blockTypeId)).toBe(true);
            expect(bytesEqual(out.material!, reg.material)).toBe(true);
            expect(bytesEqual(out.modelType!, reg.modelType)).toBe(true);
            expect(bytesEqual(out.cubeTexIndices!, reg.cubeTexIndices)).toBe(true);
            expect(bytesEqual(out.cubeFaceUVs!, reg.cubeFaceUVs)).toBe(true);
            expect(bytesEqual(out.meshId!, reg.meshId)).toBe(true);
            expect(bytesEqual(out.vertexAnimation!, reg.vertexAnimation)).toBe(true);
            expect(bytesEqual(out.surfaceHeight!, reg.surfaceHeight)).toBe(true);
            expect(bytesEqual(out.fluidGroup!, reg.fluidGroup)).toBe(true);
            expect(bytesEqual(out.emissive!, reg.emissive)).toBe(true);
        });

        it('round-trips per-mesh slot arrays byte-equal', () => {
            const reg = buildMixedRegistry();
            const buf = serializeBlockRegistryForWorker(reg, 1);
            const out = deserializeBlockRegistryForWorker(buf);

            const meshCount = reg.meshQuads.length - 1;
            expect(out.meshTexIndices!.length).toBe(meshCount + 1);

            for (let m = 1; m <= meshCount; m++) {
                expect(bytesEqual(out.meshTexIndices![m]!, reg.meshTexIndices[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadMaterials![m]!, reg.meshQuadMaterials[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadShape![m]!, reg.meshQuadShape[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadFaceDir![m]!, reg.meshQuadFaceDir[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadCullFaceDir![m]!, reg.meshQuadCullFaceDir[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadDepth![m]!, reg.meshQuadDepth[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadVertDepth![m]!, reg.meshQuadVertDepth[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadVertNormal![m]!, reg.meshQuadVertNormal[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadCornerUV![m]!, reg.meshQuadCornerUV[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadCornerPos![m]!, reg.meshQuadCornerPos[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadCornerNormSq![m]!, reg.meshQuadCornerNormSq[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadNormal![m]!, reg.meshQuadNormal[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadUVs![m]!, reg.meshQuadUVs[m]!)).toBe(true);
                expect(bytesEqual(out.meshQuadVerts![m]!, reg.meshQuadVerts[m]!)).toBe(true);
            }
        });

        it('slot 0 sentinels are present and zero-length', () => {
            const reg = buildMixedRegistry();
            const buf = serializeBlockRegistryForWorker(reg, 1);
            const out = deserializeBlockRegistryForWorker(buf);

            expect(out.meshTexIndices![0]!.length).toBe(0);
            expect(out.meshQuadMaterials![0]!.length).toBe(0);
            expect(out.meshQuadShape![0]!.length).toBe(0);
            expect(out.meshQuadFaceDir![0]!.length).toBe(0);
            expect(out.meshQuadCullFaceDir![0]!.length).toBe(0);
            expect(out.meshQuadDepth![0]!.length).toBe(0);
            expect(out.meshQuadVertDepth![0]!.length).toBe(0);
            expect(out.meshQuadVertNormal![0]!.length).toBe(0);
            expect(out.meshQuadCornerUV![0]!.length).toBe(0);
            expect(out.meshQuadCornerPos![0]!.length).toBe(0);
            expect(out.meshQuadCornerNormSq![0]!.length).toBe(0);
            expect(out.meshQuadNormal![0]!.length).toBe(0);
            expect(out.meshQuadUVs![0]!.length).toBe(0);
            expect(out.meshQuadVerts![0]!.length).toBe(0);
        });
    });

    describe('meshChunk equivalence', () => {
        // Cast decoded → BlockRegistry, the partial only populates the
        // mesher-read subset, but `meshChunk` types its registry param
        // as the full BlockRegistry. The mesher destructures only the
        // populated tables, so this cast is safe for the test.
        function asReg(decoded: DeserializedBlockRegistry): BlockRegistry {
            return decoded as unknown as BlockRegistry;
        }

        function passEqual(a: PassMesh | null, b: PassMesh | null, label: string): void {
            if (a === null && b === null) return;
            expect(a, `${label} null/non-null mismatch`).not.toBeNull();
            expect(b, `${label} null/non-null mismatch`).not.toBeNull();
            expect(a!.quadCount, `${label} quadCount`).toBe(b!.quadCount);
            expect(a!.faceOffsets, `${label} faceOffsets`).toEqual(b!.faceOffsets);
            expect(a!.faceCounts, `${label} faceCounts`).toEqual(b!.faceCounts);
            expect(bytesEqual(a!.quads, b!.quads), `${label} quads bytes`).toBe(true);
        }

        function resultEqual(a: ChunkMeshResult | null, b: ChunkMeshResult | null): void {
            if (a === null && b === null) return;
            expect(a).not.toBeNull();
            expect(b).not.toBeNull();
            passEqual(a!.opaque, b!.opaque, 'opaque');
            passEqual(a!.transparent, b!.transparent, 'transparent');
            passEqual(a!.translucent, b!.translucent, 'translucent');
            expect(a!.aabb).toEqual(b!.aabb);
        }

        it('mesher output matches between source and decoded registry — cube blocks', () => {
            const reg = buildMixedRegistry();
            const decoded = asReg(deserializeBlockRegistryForWorker(serializeBlockRegistryForWorker(reg, 1)));

            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 4, 5, 5, 'block', reg);
            setChunkBlock(chunk, 5, 5, 5, 'block', reg);
            setChunkBlock(chunk, 6, 5, 5, 'glass', reg);
            setChunkBlock(chunk, 5, 6, 5, 'lamp', reg);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), reg);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), decoded);
            resultEqual(a, b);
        });

        it('mesher output matches between source and decoded registry — mesh blocks (stair)', () => {
            const reg = buildMixedRegistry();
            const decoded = asReg(deserializeBlockRegistryForWorker(serializeBlockRegistryForWorker(reg, 1)));

            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stair', reg);
            setChunkBlock(chunk, 4, 5, 5, 'block', reg);
            setChunkBlock(chunk, 4, 4, 5, 'block', reg);
            setChunkBlock(chunk, 5, 4, 5, 'block', reg);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), reg);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), decoded);
            resultEqual(a, b);
        });

        it('empty chunk yields identical null result', () => {
            const reg = buildMixedRegistry();
            const decoded = asReg(deserializeBlockRegistryForWorker(serializeBlockRegistryForWorker(reg, 1)));

            const voxels = createVoxels(reg);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set('0,0,0', chunk);

            const a = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), reg);
            const b = meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), decoded);
            expect(a).toBeNull();
            expect(b).toBeNull();
        });
    });
});
