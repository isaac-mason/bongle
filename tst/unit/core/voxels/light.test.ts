// ── light propagation tests ─────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockRegistry } from '../../../../src/core/voxels/block-registry';
import { type buildBlockRegistry, resolveKey } from '../../../../src/core/voxels/block-registry';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import {
    buildMeshInput,
    type ChunkMeshResult,
    createMeshOutput,
    meshChunk,
    QUAD_LIGHT_OFFSET,
    QUAD_STRIDE_U32S,
} from '../../../../src/core/voxels/chunk-mesher';
import {
    flushPendingLight,
    getBlue,
    getGreen,
    getRed,
    getSky,
    packEmission,
    packLight,
    propagateAllLight,
    setBlue,
    setGreen,
    setRed,
    setSky,
    updateLightBatch,
    updateLightOnBlockChange,
} from '../../../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';
import { loadVoxels, saveVoxels } from '../../../../src/core/voxels/voxel-savefile';
import type { Chunk, Voxels } from '../../../../src/core/voxels/voxels';
import {
    CHUNK_SIZE,
    chunkKey,
    createChunk,
    createVoxels,
    createVoxelsAuthority,
    ensureChunk,
    linkChunkNeighbors,
    setBlock,
    setChunkBlock,
    voxelIndex,
} from '../../../../src/core/voxels/voxels';

// ── test helpers ────────────────────────────────────────────────────

beforeEach(() => {
    resetVoxelRegistry();
});

/** read light at a local position in a chunk */
function readLight(chunk: ReturnType<typeof createChunk>, x: number, y: number, z: number) {
    const packed = chunk.light[voxelIndex(x, y, z)]!;
    return { sky: getSky(packed), r: getRed(packed), g: getGreen(packed), b: getBlue(packed) };
}

/** mesh + light a chunk in one call. post Stage 2b: meshChunk emits
 *  geometry+AO+light in one pass, this wrapper now just delegates. */
function meshAndLight(voxels: Voxels, chunk: Chunk, reg: BlockRegistry): ChunkMeshResult | null {
    return meshChunk(createMeshOutput(), buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), reg);
}

// ── pass mesh decoder ───────────────────────────────────────────────
//
// these tests were written against the old per-corner positions/normals
// arrays. the unified mesh stores per-corner u8 positions in 1/16-voxel
// units (12 B across u32[0..2]) and a facing slice in the flags. this
// helper rehydrates that into the legacy {positions, normals, light,
// vertexCount} shape so the existing assertions keep working unchanged.

/** facing (0..5 cardinal) → outward normal. matches FACE_TO_FACING in chunk-mesher.ts. */
const FACING_NORMAL = new Float32Array([
    1,
    0,
    0, // FACING_POS_X (east)
    -1,
    0,
    0, // FACING_NEG_X (west)
    0,
    1,
    0, // FACING_POS_Y (up)
    0,
    -1,
    0, // FACING_NEG_Y (down)
    0,
    0,
    1, // FACING_POS_Z (south)
    0,
    0,
    -1, // FACING_NEG_Z (north)
    0,
    0,
    0, // FACING_UNASSIGNED
]);

type LegacyCubeMesh = {
    vertexCount: number;
    positions: Float32Array; // 3 per corner, chunk-local
    normals: Float32Array; // 3 per corner (broadcast from facing)
    light: Uint32Array;
};

type PassMeshLike = { quads: Uint32Array; quadCount: number };

/** decode a unified PassMesh back into one flat legacy-shaped mesh.
 *  per-corner positions are u8×3 across u32[0..2] (1/16-voxel units);
 *  normals are derived from `facing` (flags bits 20..22). */
function decodeCubeBucket(pass: PassMeshLike | null): LegacyCubeMesh {
    if (!pass || pass.quadCount === 0) {
        return {
            vertexCount: 0,
            positions: new Float32Array(0),
            normals: new Float32Array(0),
            light: new Uint32Array(0),
        };
    }
    const vertexCount = pass.quadCount * 4;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const light = new Uint32Array(vertexCount);

    // encoder is pos16: byte = round(v * 255/16). cube faces always sit on
    // integer voxel boundaries [0..16], so snap to the nearest integer voxel
    // when rehydrating so legacy `py === N` assertions work.
    const decodePos = (b: number): number => Math.round(b * (16 / 255));
    const bytes = new Uint8Array(pass.quads.buffer, pass.quads.byteOffset, pass.quads.byteLength);
    for (let q = 0; q < pass.quadCount; q++) {
        const u32Base = q * QUAD_STRIDE_U32S;
        const byteBase = q * QUAD_STRIDE_U32S * 4;
        const flags = pass.quads[u32Base + 8]!;
        const facing = (flags >>> 20) & 0x7;
        const nb = facing * 3;
        const nx = FACING_NORMAL[nb]!;
        const ny = FACING_NORMAL[nb + 1]!;
        const nz = FACING_NORMAL[nb + 2]!;
        for (let c = 0; c < 4; c++) {
            const dstVert = q * 4 + c;
            const vi = dstVert * 3;
            positions[vi] = decodePos(bytes[byteBase + c * 3]!);
            positions[vi + 1] = decodePos(bytes[byteBase + c * 3 + 1]!);
            positions[vi + 2] = decodePos(bytes[byteBase + c * 3 + 2]!);
            normals[vi] = nx;
            normals[vi + 1] = ny;
            normals[vi + 2] = nz;
            light[dstVert] = pass.quads[u32Base + QUAD_LIGHT_OFFSET + c]!;
        }
    }

    return { vertexCount, positions, normals, light };
}

// ── packing / unpacking tests ───────────────────────────────────────

describe('light packing', () => {
    it('packLight round-trips all channels', () => {
        const packed = packLight(12, 8, 4, 1);
        expect(getSky(packed)).toBe(12);
        expect(getRed(packed)).toBe(8);
        expect(getGreen(packed)).toBe(4);
        expect(getBlue(packed)).toBe(1);
    });

    it('setSky preserves other channels', () => {
        const base = packLight(0, 5, 10, 15);
        const updated = setSky(base, 7);
        expect(getSky(updated)).toBe(7);
        expect(getRed(updated)).toBe(5);
        expect(getGreen(updated)).toBe(10);
        expect(getBlue(updated)).toBe(15);
    });

    it('setRed preserves other channels', () => {
        const base = packLight(15, 0, 10, 5);
        const updated = setRed(base, 3);
        expect(getSky(updated)).toBe(15);
        expect(getRed(updated)).toBe(3);
        expect(getGreen(updated)).toBe(10);
        expect(getBlue(updated)).toBe(5);
    });

    it('setGreen preserves other channels', () => {
        const base = packLight(15, 10, 0, 5);
        const updated = setGreen(base, 9);
        expect(getSky(updated)).toBe(15);
        expect(getRed(updated)).toBe(10);
        expect(getGreen(updated)).toBe(9);
        expect(getBlue(updated)).toBe(5);
    });

    it('setBlue preserves other channels', () => {
        const base = packLight(15, 10, 5, 0);
        const updated = setBlue(base, 14);
        expect(getSky(updated)).toBe(15);
        expect(getRed(updated)).toBe(10);
        expect(getGreen(updated)).toBe(5);
        expect(getBlue(updated)).toBe(14);
    });

    it('packEmission stores RGB without sky', () => {
        const em = packEmission(15, 8, 3);
        expect(getRed(em)).toBe(15);
        expect(getGreen(em)).toBe(8);
        expect(getBlue(em)).toBe(3);
        expect(getSky(em)).toBe(0); // no sky in emission
    });

    it('max values round-trip correctly', () => {
        const packed = packLight(15, 15, 15, 15);
        expect(getSky(packed)).toBe(15);
        expect(getRed(packed)).toBe(15);
        expect(getGreen(packed)).toBe(15);
        expect(getBlue(packed)).toBe(15);
    });

    it('zero round-trips correctly', () => {
        const packed = packLight(0, 0, 0, 0);
        expect(packed).toBe(0);
        expect(getSky(packed)).toBe(0);
        expect(getRed(packed)).toBe(0);
        expect(getGreen(packed)).toBe(0);
        expect(getBlue(packed)).toBe(0);
    });
});

// ── propagation tests ───────────────────────────────────────────────

describe('propagateAllLight', () => {
    describe('sky light', () => {
        it('fills an empty chunk column with sky=15', () => {
            // single chunk, all air. sky light should fill every voxel.
            const registry = buildTestRegistry([]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            propagateAllLight(voxels);

            // every voxel should have sky=15 (all air, nothing to block)
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const light = readLight(chunk, 8, y, 8);
                expect(light.sky).toBe(15);
            }
        });

        it('sky light blocked by opaque block', () => {
            // place a solid block at y=8. sky should be 15 above, 0 below.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // solid block at (8, 8, 8)
            setChunkBlock(chunk, 8, 8, 8, 'stone', registry);

            propagateAllLight(voxels);

            // above the stone: sky=15
            expect(readLight(chunk, 8, 15, 8).sky).toBe(15);
            expect(readLight(chunk, 8, 9, 8).sky).toBe(15);

            // the stone itself should have sky=0 (it's opaque)
            expect(readLight(chunk, 8, 8, 8).sky).toBe(0);

            // directly below the stone: sky column was broken, so no
            // direct sky light. might get horizontal spread from neighbors
            // but it would be attenuated. certainly not 15.
            const below = readLight(chunk, 8, 7, 8);
            expect(below.sky).toBeLessThan(15);
        });

        it('sky light spreads horizontally with -1 decay', () => {
            // place a row of solid blocks at y=15 except at x=8.
            // the column at x=8 gets sky=15. neighbors should get 14, 13, etc.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // fill y=15 with stone, leave x=8,z=8 as air (a skylight shaft)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    if (x === 8 && z === 8) continue;
                    setChunkBlock(chunk, x, 15, z, 'stone', registry);
                }
            }

            propagateAllLight(voxels);

            // the shaft at (8, 14, 8) should have sky=15 (straight down)
            expect(readLight(chunk, 8, 14, 8).sky).toBe(15);

            // one step away horizontally at same y: sky=14
            expect(readLight(chunk, 9, 14, 8).sky).toBe(14);
            expect(readLight(chunk, 7, 14, 8).sky).toBe(14);
            expect(readLight(chunk, 8, 14, 9).sky).toBe(14);
            expect(readLight(chunk, 8, 14, 7).sky).toBe(14);

            // two steps away: sky=13
            expect(readLight(chunk, 10, 14, 8).sky).toBe(13);
        });

        it('sky light propagates downward at 15 through transparent blocks', () => {
            // glass is translucent (opacity=0). sky light should pass through.
            const registry = buildTestRegistry([
                { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass', lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // glass at y=10
            setChunkBlock(chunk, 8, 10, 8, 'glass', registry);

            propagateAllLight(voxels);

            // above glass: sky=15
            expect(readLight(chunk, 8, 11, 8).sky).toBe(15);
            // at glass: sky=15 (opacity=0, transparent)
            expect(readLight(chunk, 8, 10, 8).sky).toBe(15);
            // below glass: sky=15 (passed through)
            expect(readLight(chunk, 8, 9, 8).sky).toBe(15);
        });
    });

    describe('block light (RGB)', () => {
        it('single red emitter attenuates by 1 per step', () => {
            const registry = buildTestRegistry([{ id: 'redlight', texId: 'red', lightEmission: [15, 0, 0] }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // place emitter at center
            setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);

            propagateAllLight(voxels);

            // at the emitter: r=15
            expect(readLight(chunk, 8, 8, 8).r).toBe(15);

            // 1 step away: r=14 (but neighbor is air with opacity=0, decay=max(1,0)=1)
            expect(readLight(chunk, 9, 8, 8).r).toBe(14);
            expect(readLight(chunk, 7, 8, 8).r).toBe(14);

            // 2 steps: r=13
            expect(readLight(chunk, 10, 8, 8).r).toBe(13);

            // 5 steps: r=10
            expect(readLight(chunk, 13, 8, 8).r).toBe(10);

            // green and blue should be 0
            expect(readLight(chunk, 9, 8, 8).g).toBe(0);
            expect(readLight(chunk, 9, 8, 8).b).toBe(0);
        });

        it('colored emitter (green) attenuates correctly', () => {
            const registry = buildTestRegistry([{ id: 'greenlight', texId: 'green', lightEmission: [0, 10, 0] }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 8, 8, 8, 'greenlight', registry);
            propagateAllLight(voxels);

            expect(readLight(chunk, 8, 8, 8).g).toBe(10);
            expect(readLight(chunk, 9, 8, 8).g).toBe(9);
            expect(readLight(chunk, 10, 8, 8).g).toBe(8);

            // at distance 10, should reach 0
            expect(readLight(chunk, 8, 8, 8).r).toBe(0);
        });

        it('emitter light blocked by opaque wall', () => {
            const registry = buildTestRegistry([
                { id: 'redlight', texId: 'red', lightEmission: [15, 0, 0] },
                { id: 'stone', texId: 'stone' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // emitter at (8,8,8), solid wall at x=10 (full YZ plane)
            setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunk, 10, y, z, 'stone', registry);
                }
            }

            propagateAllLight(voxels);

            // before the wall: should have light
            expect(readLight(chunk, 9, 8, 8).r).toBe(14);

            // the stone: opacity=15, light can't enter.
            // incoming from (9,8,8) is r=14, decay=max(1,15)=15 → 14-15=-1 → 0
            expect(readLight(chunk, 10, 8, 8).r).toBe(0);

            // beyond the wall: no light can pass through or around
            expect(readLight(chunk, 11, 8, 8).r).toBe(0);
        });

        it('two emitters of different colors mix correctly', () => {
            // use 'none' cull class so emitters are transparent to light
            const registry = buildTestRegistry([
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
                { id: 'bluelight', cull: CullType.NONE, texId: 'blue', lightEmission: [0, 0, 15], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // red at (4,8,8), blue at (12,8,8)
            setChunkBlock(chunk, 4, 8, 8, 'redlight', registry);
            setChunkBlock(chunk, 12, 8, 8, 'bluelight', registry);

            propagateAllLight(voxels);

            // at the midpoint (8,8,8): both lights reach here
            // red: 15 - 4 = 11
            // blue: 15 - 4 = 11
            const mid = readLight(chunk, 8, 8, 8);
            expect(mid.r).toBe(11);
            expect(mid.b).toBe(11);
            expect(mid.g).toBe(0);

            // at red emitter: r=15, blue has to travel 8 steps: 15-8=7
            // emitter blocks are transparent (opacity=0), so light can enter
            const atRed = readLight(chunk, 4, 8, 8);
            expect(atRed.r).toBe(15);
            expect(atRed.b).toBe(7);
        });

        it('light passes through translucent blocks without extra decay', () => {
            const registry = buildTestRegistry([
                { id: 'redlight', texId: 'red', lightEmission: [15, 0, 0] },
                { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // emitter at (8,8,8), glass at (9,8,8)
            setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);
            setChunkBlock(chunk, 9, 8, 8, 'glass', registry);

            propagateAllLight(voxels);

            // glass has opacity=0, so decay=max(1,0)=1, same as air.
            // light at glass: 14 (1 step from emitter)
            expect(readLight(chunk, 9, 8, 8).r).toBe(14);
            // light beyond glass: 13 (2 steps from emitter)
            expect(readLight(chunk, 10, 8, 8).r).toBe(13);
        });

        it('cutout blocks (leaves) have slight filtering (opacity=1)', () => {
            const registry = buildTestRegistry([
                { id: 'redlight', texId: 'red', lightEmission: [15, 0, 0] },
                { id: 'leaves', cull: CullType.SELF, texId: 'leaves' },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // emitter at (8,8,8), leaves at (9,8,8)
            setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);
            setChunkBlock(chunk, 9, 8, 8, 'leaves', registry);

            propagateAllLight(voxels);

            // leaves opacity=1, decay=max(1,1)=1, same as air.
            // at leaves: 14
            expect(readLight(chunk, 9, 8, 8).r).toBe(14);
            // beyond: 13
            expect(readLight(chunk, 10, 8, 8).r).toBe(13);
        });
    });

    describe('cross-chunk propagation', () => {
        it('light crosses chunk boundary', () => {
            const registry = buildTestRegistry([{ id: 'redlight', texId: 'red', lightEmission: [15, 0, 0] }]);
            const voxels = createVoxels(registry);

            // two adjacent chunks on X axis: chunk(0,0,0) and chunk(1,0,0)
            const chunk0 = createChunk(0, 0, 0);
            const chunk1 = createChunk(1, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk0);
            voxels.chunks.set(chunkKey(1, 0, 0), chunk1);
            linkChunkNeighbors(voxels, chunk0);
            linkChunkNeighbors(voxels, chunk1);

            // emitter at local (15,8,8) in chunk0, right at the boundary
            setChunkBlock(chunk0, 15, 8, 8, 'redlight', registry);

            propagateAllLight(voxels);

            // at the emitter: r=15
            expect(readLight(chunk0, 15, 8, 8).r).toBe(15);

            // 1 step into chunk1 at local (0,8,8): r=14
            expect(readLight(chunk1, 0, 8, 8).r).toBe(14);

            // 2 steps into chunk1: r=13
            expect(readLight(chunk1, 1, 8, 8).r).toBe(13);

            // 5 steps into chunk1: r=10
            expect(readLight(chunk1, 4, 8, 8).r).toBe(10);
        });

        it('sky light crosses chunk boundary vertically', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);

            // two chunks stacked: chunk(0,1,0) on top, chunk(0,0,0) below
            const chunkTop = createChunk(0, 1, 0);
            const chunkBot = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
            voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
            linkChunkNeighbors(voxels, chunkTop);
            linkChunkNeighbors(voxels, chunkBot);

            // all air, sky should propagate down through both chunks
            propagateAllLight(voxels);

            // top of upper chunk: sky=15
            expect(readLight(chunkTop, 8, 15, 8).sky).toBe(15);
            // bottom of upper chunk: sky=15
            expect(readLight(chunkTop, 8, 0, 8).sky).toBe(15);
            // top of lower chunk: sky=15
            expect(readLight(chunkBot, 8, 15, 8).sky).toBe(15);
            // bottom of lower chunk: sky=15
            expect(readLight(chunkBot, 8, 0, 8).sky).toBe(15);
        });
    });

    describe('all chunks marked dirty', () => {
        it('marks all chunks dirty after propagation', () => {
            const registry = buildTestRegistry([]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            chunk.dirty = false;
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            propagateAllLight(voxels);

            expect(chunk.dirty).toBe(true);
        });
    });

    describe('mesher integration', () => {
        it('light is present in mesh output and non-zero for lit blocks', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // place a stone block, sky light should illuminate from above
            setChunkBlock(chunk, 8, 8, 8, 'stone', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);
            expect(mesh.light).toBeInstanceOf(Uint32Array);
            expect(mesh.light.length).toBe(mesh.vertexCount);

            // the top face should have sky light packed in bits 24-31.
            // format: R|(G<<8)|(B<<16)|(sky<<24)
            let hasLight = false;
            for (let i = 0; i < mesh.light.length; i++) {
                if (mesh.light[i]! > 0) {
                    hasLight = true;
                    break;
                }
            }
            expect(hasLight).toBe(true);
        });

        it('light encodes sky channel separately from rgb', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // stone block with only sky light, no block emitters
            setChunkBlock(chunk, 8, 8, 8, 'stone', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            const mesh = decodeCubeBucket(result!.opaque);

            // find the top face vertex (should have sky=15 from the air above)
            let maxSky = 0;
            let maxR = 0;
            for (let i = 0; i < mesh.light.length; i++) {
                const packed = mesh.light[i]!;
                const r = packed & 0xff;
                const sky = (packed >>> 24) & 0xff;
                if (sky > maxSky) maxSky = sky;
                if (r > maxR) maxR = r;
            }
            // sky should be 15 on the top face (raw 4-bit channel; LUT is
            // applied in WGSL voxel-material).
            expect(maxSky).toBe(15);
            // no block emitters, so rgb channels should be 0
            expect(maxR).toBe(0);
        });

        it('light encodes colored light from emitter', () => {
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // place a stone block with a red emitter next to it
            setChunkBlock(chunk, 8, 4, 8, 'stone', registry);
            setChunkBlock(chunk, 9, 4, 8, 'redlight', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();

            // the stone's east face (+x) points toward the red emitter.
            // that face should have red light (r > 0). unpack:
            // r = packed & 0xFF, g = (packed >> 8) & 0xFF, b = (packed >> 16) & 0xFF
            const mesh = decodeCubeBucket(result!.opaque);
            let maxR = 0;
            for (let i = 0; i < mesh.light.length; i++) {
                const r = mesh.light[i]! & 0xff;
                if (r > maxR) maxR = r;
            }
            // the red emitter at distance 1 should give r=14 → curved via LIGHT_LUT
            expect(maxR).toBeGreaterThan(0);
        });

        it('smooth lighting: top face vertices near emitter are brighter', () => {
            // place stone at (8,4,8) with a red emitter at (10,4,8) (2 away in +X).
            // the top (+Y) face samples light from (8,5,8), one step up.
            // smooth lighting averages each vertex with its 2 edge + 1 corner neighbors.
            //
            // top face vertex layout (XZ plane at Y+1):
            //   v0(8,5,8): neighbors at -X, -Z  (far from emitter)
            //   v1(8,5,9): neighbors at -X, +Z  (far from emitter)
            //   v2(9,5,9): neighbors at +X, +Z  (near emitter)
            //   v3(9,5,8): neighbors at +X, -Z  (near emitter)
            //
            // v2 and v3 have an edge neighbor at +X which is closer to the emitter,
            // so they should have higher red values than v0 and v1.
            // emitter placed at (10,4,8) instead of (9,4,8) so its geometry doesn't
            // overlap with the stone's top face vertices.
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 8, 4, 8, 'stone', registry);
            setChunkBlock(chunk, 10, 4, 8, 'redlight', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find the 4 vertices of the stone's top face at (8,4,8).
            // stone top face: y=5, normal=(0,1,0), x in [8,9], z in [8,9].
            const topFaceVerts: { x: number; z: number; r: number }[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                const px = mesh.positions[i * 3]!;
                const pz = mesh.positions[i * 3 + 2]!;
                if (ny === 1 && py === 5 && px >= 8 && px <= 9 && pz >= 8 && pz <= 9) {
                    topFaceVerts.push({ x: px, z: pz, r: mesh.light[i]! & 0xff });
                }
            }
            expect(topFaceVerts.length).toBe(4);

            // vertices at x=9 (the +X edge, near emitter) should have more red
            // than vertices at x=8 (the -X edge, far from emitter)
            const nearVerts = topFaceVerts.filter((v) => v.x === 9);
            const farVerts = topFaceVerts.filter((v) => v.x === 8);
            expect(nearVerts.length).toBe(2);
            expect(farVerts.length).toBe(2);

            const nearAvgR = (nearVerts[0]!.r + nearVerts[1]!.r) / 2;
            const farAvgR = (farVerts[0]!.r + farVerts[1]!.r) / 2;
            // near side should be strictly brighter
            expect(nearAvgR).toBeGreaterThan(farAvgR);
            // both should be non-zero (red light reaches everywhere around the stone)
            expect(nearAvgR).toBeGreaterThan(0);
            expect(farAvgR).toBeGreaterThan(0);
        });

        it('smooth lighting: opaque edge blocks obstruct corner sampling', () => {
            // tests that when both edge neighbors of a vertex are opaque,
            // the diagonal corner isn't sampled (minetest obstruction rule).
            //
            // setup: stone at (8,4,8). for the top face, we examine two vertices:
            //   v2 at (9,5,9): edge neighbors at +X=(9,5,8) and +Z=(8,5,9)
            //   v0 at (8,5,8): edge neighbors at -X=(7,5,8) and -Z=(8,5,7)
            //
            // place a red emitter at (9,5,9), the corner position for v2.
            // with both edge positions blocked by stone, the corner (where the
            // emitter sits) is NOT sampled for v2.
            // place nothing at v0's corner (7,5,7), all air, gets averaged normally.
            //
            // without obstruction, v2 would sample the emitter (r=15) and get a
            // high average. with obstruction, v2 only samples the face center.
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 8, 4, 8, 'stone', registry);
            // emitter at the corner position for v2
            setChunkBlock(chunk, 9, 5, 9, 'redlight', registry);
            // block both edge neighbors of v2 to trigger obstruction
            setChunkBlock(chunk, 9, 5, 8, 'stone', registry); // +X edge
            setChunkBlock(chunk, 8, 5, 9, 'stone', registry); // +Z edge
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find top face vertices of the stone at (8,4,8)
            const topFaceVerts: { x: number; z: number; r: number }[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                const px = mesh.positions[i * 3]!;
                const pz = mesh.positions[i * 3 + 2]!;
                if (ny === 1 && py === 5 && px >= 8 && px <= 9 && pz >= 8 && pz <= 9) {
                    topFaceVerts.push({ x: px, z: pz, r: mesh.light[i]! & 0xff });
                }
            }
            expect(topFaceVerts.length).toBe(4);

            // v2 at (9,9): both edges opaque → corner obstructed → count=1 (face only)
            const v2 = topFaceVerts.find((v) => v.x === 9 && v.z === 9);
            expect(v2).toBeDefined();

            // v0 at (8,8): both edges transparent → corner sampled → count=4
            const v0 = topFaceVerts.find((v) => v.x === 8 && v.z === 8);
            expect(v0).toBeDefined();

            // v2's corner is obstructed so the emitter's light is NOT sampled.
            // v2 should have less red than it would without obstruction.
            // v0's edge/corner positions are all air (r=0), so v0 should have low red.
            // the key assertion: both edges opaque means v2 averages only face center
            // while the emitter light bleeds around to v0's neighborhood.
            // v2 should NOT have the high value it would get from directly sampling
            // the r=15 emitter at its corner. specifically, v2.r should be similar
            // to the face center value (not boosted by the emitter).
            // since the emitter is completely blocked behind stone on both edges,
            // its light doesn't reach the face center (8,5,8) easily either.
            // both vertices should have relatively low red.
            // the critical invariant: obstruction prevents the corner from contributing.
            // we verify by checking v2 doesn't have a high red value (emitter r=15
            // would give ~LUT[round(15/4)]≈LUT[4]=56 if sampled as 1 of 4,
            // or LUT[15]=255 if it were the only sample).
            // with obstruction, v2.count=1, only the face center contributes.
            // face center (8,5,8) should have relatively low red since the emitter
            // has to go around the stone walls.
            expect(v2!.r).toBeLessThan(200); // would be ~255 if corner was sampled alone
        });

        it('partial blocks (stairs) receive light at their own position', () => {
            // partial blocks have opacity=0, so light propagates into them.
            // the custom model path samples from the block's own position.
            const registry = buildTestRegistry([{ id: 'stairs', cull: CullType.PARTIAL, texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // place a partial block, sky light should reach it
            setChunkBlock(chunk, 8, 8, 8, 'stairs', registry);
            propagateAllLight(voxels);

            // the partial block itself should have sky=15 (opacity=0, sky passes through)
            const light = readLight(chunk, 8, 8, 8);
            expect(light.sky).toBe(15);
        });

        it('smooth lighting: no dark seams at chunk boundaries', () => {
            // regression test: vertices at chunk boundaries sample edge/corner
            // positions in the slab. before the fix, the light slab only filled
            // the 6 face borders, leaving 12 edge strips and 8 corners at 0.
            // this caused dark patches on flat ground at chunk boundaries.
            //
            // setup: two adjacent chunks along X, both with a flat ground layer
            // at y=0. all blocks are fully sky-lit. mesh chunk 0 and verify that
            // top-face vertices at x=0 (the -X boundary) have the same sky light
            // as vertices in the chunk interior.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk0 = createChunk(0, 0, 0);
            const chunkM1 = createChunk(-1, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk0);
            voxels.chunks.set(chunkKey(-1, 0, 0), chunkM1);
            linkChunkNeighbors(voxels, chunk0);
            linkChunkNeighbors(voxels, chunkM1);

            // fill y=0 layer in both chunks
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    setChunkBlock(chunk0, x, 0, z, 'stone', registry);
                    setChunkBlock(chunkM1, x, 0, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk0, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // collect sky light from all top-face vertices (+Y normal, y=1)
            const boundarySkys: number[] = []; // x=0, at the -X chunk boundary
            const interiorSkys: number[] = []; // x=8, well inside the chunk
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                const px = mesh.positions[i * 3]!;
                if (ny !== 1 || py !== 1) continue;
                const sky = (mesh.light[i]! >>> 24) & 0xff;
                if (px === 0) boundarySkys.push(sky);
                else if (px === 8) interiorSkys.push(sky);
            }

            expect(boundarySkys.length).toBeGreaterThan(0);
            expect(interiorSkys.length).toBeGreaterThan(0);

            // all boundary vertices should have the same sky light as interior
            // (flat open ground, no obstructions, no reason for any difference)
            const interiorSky = interiorSkys[0]!;
            for (const sky of boundarySkys) {
                expect(sky).toBe(interiorSky);
            }
        });
    });
});

// ── incremental light update tests ──────────────────────────────────

describe('updateLightOnBlockChange', () => {
    /** helper: get the global state id for a block key */
    function stateIdForKey(key: string, registry: ReturnType<typeof buildBlockRegistry>): number {
        const stateId = registry.keyToState.get(key);
        if (stateId === undefined) throw new Error(`unknown key: ${key}`);
        return stateId;
    }

    it('placing opaque block dims nearby light', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        // place emitter at (4,8,8)
        setChunkBlock(chunk, 4, 8, 8, 'redlight', registry);
        propagateAllLight(voxels);

        // light at (7,8,8) should be 12 (3 steps from emitter)
        expect(readLight(chunk, 7, 8, 8).r).toBe(12);

        // place opaque stone at (6,8,8), between emitter and sample point
        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk, 6, 8, 8, 'stone', registry);
        updateLightOnBlockChange(voxels, 6, 8, 8, oldState);

        // light at (7,8,8) should now be much lower, the direct path is blocked.
        // light has to go around the stone, so it'll be significantly attenuated.
        const afterPlace = readLight(chunk, 7, 8, 8);
        expect(afterPlace.r).toBeLessThan(12);

        // emitter itself should still have r=15
        expect(readLight(chunk, 4, 8, 8).r).toBe(15);
    });

    it('removing opaque block restores light', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        // place emitter and stone wall
        setChunkBlock(chunk, 4, 8, 8, 'redlight', registry);
        setChunkBlock(chunk, 6, 8, 8, 'stone', registry);
        propagateAllLight(voxels);

        // light beyond the wall should be low
        const blockedR = readLight(chunk, 7, 8, 8).r;
        expect(blockedR).toBeLessThan(12);

        // remove the stone
        const oldState = stateIdForKey('stone', registry);
        setChunkBlock(chunk, 6, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 6, 8, 8, oldState);

        // light should be restored: 15 - 3 = 12
        expect(readLight(chunk, 7, 8, 8).r).toBe(12);
    });

    it('placing a light emitter adds light', () => {
        const registry = buildTestRegistry([
            { id: 'greenlight', cull: CullType.NONE, texId: 'green', lightEmission: [0, 10, 0], lightOpacity: 0 },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        propagateAllLight(voxels);

        // no emitters yet, green should be 0
        expect(readLight(chunk, 8, 8, 8).g).toBe(0);

        // place emitter
        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk, 8, 8, 8, 'greenlight', registry);
        updateLightOnBlockChange(voxels, 8, 8, 8, oldState);

        // emitter should have g=10
        expect(readLight(chunk, 8, 8, 8).g).toBe(10);
        // 1 step away: g=9
        expect(readLight(chunk, 9, 8, 8).g).toBe(9);
        // 5 steps: g=5
        expect(readLight(chunk, 13, 8, 8).g).toBe(5);
    });

    it('placing an opaque emitter (glowstone-style) spreads light', () => {
        // regression: opaque emitters (lightOpacity=15) were silently skipped in
        // handleChannelChange, the placement path only handled transparent blocks.
        const registry = buildTestRegistry([
            { id: 'glowstone', texId: 'glow', lightEmission: [15, 12, 8] },
            // default cull=SOLID, no explicit lightOpacity → defaults to 15
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        propagateAllLight(voxels);

        // place glowstone incrementally
        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk, 8, 8, 8, 'glowstone', registry);
        updateLightOnBlockChange(voxels, 8, 8, 8, oldState);

        // neighbors should be lit (emission propagates from opaque emitter)
        expect(readLight(chunk, 9, 8, 8).r).toBe(14);
        expect(readLight(chunk, 7, 8, 8).r).toBe(14);
        expect(readLight(chunk, 10, 8, 8).r).toBe(13);

        // green and blue channels too
        expect(readLight(chunk, 9, 8, 8).g).toBe(11);
        expect(readLight(chunk, 9, 8, 8).b).toBe(7);
    });

    it('removing an opaque emitter removes its light', () => {
        // regression: verify that removing a glowstone-style block (opaque+emitter)
        // correctly unspread its light.
        const registry = buildTestRegistry([{ id: 'glowstone', texId: 'glow', lightEmission: [15, 12, 8] }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        setChunkBlock(chunk, 8, 8, 8, 'glowstone', registry);
        propagateAllLight(voxels);
        expect(readLight(chunk, 9, 8, 8).r).toBe(14);

        const oldState = stateIdForKey('glowstone', registry);
        setChunkBlock(chunk, 8, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 8, 8, 8, oldState);

        // all emitted light should be gone
        expect(readLight(chunk, 8, 8, 8).r).toBe(0);
        expect(readLight(chunk, 9, 8, 8).r).toBe(0);
        expect(readLight(chunk, 13, 8, 8).r).toBe(0);
    });

    it('removing a light emitter removes its light', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        // place and propagate
        setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);
        propagateAllLight(voxels);
        expect(readLight(chunk, 9, 8, 8).r).toBe(14);

        // remove emitter
        const oldState = stateIdForKey('redlight', registry);
        setChunkBlock(chunk, 8, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 8, 8, 8, oldState);

        // all red light should be gone (no other red sources)
        expect(readLight(chunk, 8, 8, 8).r).toBe(0);
        expect(readLight(chunk, 9, 8, 8).r).toBe(0);
        expect(readLight(chunk, 13, 8, 8).r).toBe(0);
    });

    it('placing opaque block blocks sky column below', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        propagateAllLight(voxels);
        // all air, sky=15 everywhere
        expect(readLight(chunk, 8, 8, 8).sky).toBe(15);
        expect(readLight(chunk, 8, 5, 8).sky).toBe(15);

        // place stone at y=10
        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk, 8, 10, 8, 'stone', registry);
        updateLightOnBlockChange(voxels, 8, 10, 8, oldState);

        // above stone: still sky=15
        expect(readLight(chunk, 8, 11, 8).sky).toBe(15);

        // below stone: sky should be less than 15 (no direct column access)
        // horizontal spread from neighbors will provide some sky light
        expect(readLight(chunk, 8, 9, 8).sky).toBeLessThan(15);
    });

    it('removing opaque block restores sky column below', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        // start with stone at y=10
        setChunkBlock(chunk, 8, 10, 8, 'stone', registry);
        propagateAllLight(voxels);

        expect(readLight(chunk, 8, 9, 8).sky).toBeLessThan(15);

        // remove the stone
        const oldState = stateIdForKey('stone', registry);
        setChunkBlock(chunk, 8, 10, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 8, 10, 8, oldState);

        // sky column should be restored
        expect(readLight(chunk, 8, 9, 8).sky).toBe(15);
        expect(readLight(chunk, 8, 5, 8).sky).toBe(15);
        expect(readLight(chunk, 8, 0, 8).sky).toBe(15);
    });

    it('cross-chunk incremental update', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
        ]);
        const voxels = createVoxels(registry);
        const chunk0 = createChunk(0, 0, 0);
        const chunk1 = createChunk(1, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk0);
        voxels.chunks.set(chunkKey(1, 0, 0), chunk1);
        linkChunkNeighbors(voxels, chunk0);
        linkChunkNeighbors(voxels, chunk1);

        propagateAllLight(voxels);

        // place emitter at (15,8,8) in chunk0, right at the boundary
        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk0, 15, 8, 8, 'redlight', registry);
        updateLightOnBlockChange(voxels, 15, 8, 8, oldState);

        // at the emitter: r=15
        expect(readLight(chunk0, 15, 8, 8).r).toBe(15);
        // 1 step into chunk1: r=14
        expect(readLight(chunk1, 0, 8, 8).r).toBe(14);
        // 5 steps into chunk1: r=10
        expect(readLight(chunk1, 4, 8, 8).r).toBe(10);
    });

    it('incremental matches full recompute for single emitter', () => {
        // place emitter incrementally and compare vs full recompute
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // scenario 1: incremental
        const voxelsInc = createVoxels(registry);
        const chunkInc = createChunk(0, 0, 0);
        voxelsInc.chunks.set(chunkKey(0, 0, 0), chunkInc);
        propagateAllLight(voxelsInc);

        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunkInc, 8, 8, 8, 'redlight', registry);
        updateLightOnBlockChange(voxelsInc, 8, 8, 8, oldState);

        // scenario 2: full recompute
        const voxelsFull = createVoxels(registry);
        const chunkFull = createChunk(0, 0, 0);
        voxelsFull.chunks.set(chunkKey(0, 0, 0), chunkFull);
        setChunkBlock(chunkFull, 8, 8, 8, 'redlight', registry);
        propagateAllLight(voxelsFull);

        // compare all light values
        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            expect(chunkInc.light[i]).toBe(chunkFull.light[i]);
        }
    });

    it('incremental matches full recompute for emitter removal', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
        ]);

        // start with emitter, then remove incrementally
        const voxelsInc = createVoxels(registry);
        const chunkInc = createChunk(0, 0, 0);
        voxelsInc.chunks.set(chunkKey(0, 0, 0), chunkInc);
        setChunkBlock(chunkInc, 8, 8, 8, 'redlight', registry);
        propagateAllLight(voxelsInc);

        const oldState = stateIdForKey('redlight', registry);
        setChunkBlock(chunkInc, 8, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxelsInc, 8, 8, 8, oldState);

        // full recompute: just air, no emitter
        const voxelsFull = createVoxels(registry);
        const chunkFull = createChunk(0, 0, 0);
        voxelsFull.chunks.set(chunkKey(0, 0, 0), chunkFull);
        propagateAllLight(voxelsFull);

        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            expect(chunkInc.light[i]).toBe(chunkFull.light[i]);
        }
    });

    it('incremental matches full recompute for opaque block placement', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // incremental: place emitter first, then add wall
        const voxelsInc = createVoxels(registry);
        const chunkInc = createChunk(0, 0, 0);
        voxelsInc.chunks.set(chunkKey(0, 0, 0), chunkInc);
        setChunkBlock(chunkInc, 4, 8, 8, 'redlight', registry);
        propagateAllLight(voxelsInc);

        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunkInc, 6, 8, 8, 'stone', registry);
        updateLightOnBlockChange(voxelsInc, 6, 8, 8, oldState);

        // full recompute: emitter + wall from the start
        const voxelsFull = createVoxels(registry);
        const chunkFull = createChunk(0, 0, 0);
        voxelsFull.chunks.set(chunkKey(0, 0, 0), chunkFull);
        setChunkBlock(chunkFull, 4, 8, 8, 'redlight', registry);
        setChunkBlock(chunkFull, 6, 8, 8, 'stone', registry);
        propagateAllLight(voxelsFull);

        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            if (chunkInc.light[i] !== chunkFull.light[i]) {
                const lx = i & 0xf;
                const ly = (i >> 4) & 0xf;
                const lz = (i >> 8) & 0xf;
                expect(chunkInc.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(chunkFull.light[i]);
            }
        }
    });

    it('incremental matches full recompute for opaque block removal', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // incremental: start with emitter + wall, then remove wall
        const voxelsInc = createVoxels(registry);
        const chunkInc = createChunk(0, 0, 0);
        voxelsInc.chunks.set(chunkKey(0, 0, 0), chunkInc);
        setChunkBlock(chunkInc, 4, 8, 8, 'redlight', registry);
        setChunkBlock(chunkInc, 6, 8, 8, 'stone', registry);
        propagateAllLight(voxelsInc);

        const oldState = stateIdForKey('stone', registry);
        setChunkBlock(chunkInc, 6, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxelsInc, 6, 8, 8, oldState);

        // full recompute: just emitter, no wall
        const voxelsFull = createVoxels(registry);
        const chunkFull = createChunk(0, 0, 0);
        voxelsFull.chunks.set(chunkKey(0, 0, 0), chunkFull);
        setChunkBlock(chunkFull, 4, 8, 8, 'redlight', registry);
        propagateAllLight(voxelsFull);

        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            if (chunkInc.light[i] !== chunkFull.light[i]) {
                const lx = i & 0xf;
                const ly = (i >> 4) & 0xf;
                const lz = (i >> 8) & 0xf;
                expect(chunkInc.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(chunkFull.light[i]);
            }
        }
    });

    it('two emitters: removing one preserves the other', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'bluelight', cull: CullType.NONE, texId: 'blue', lightEmission: [0, 0, 15], lightOpacity: 0 },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        setChunkBlock(chunk, 4, 8, 8, 'redlight', registry);
        setChunkBlock(chunk, 12, 8, 8, 'bluelight', registry);
        propagateAllLight(voxels);

        // midpoint should have both colors
        expect(readLight(chunk, 8, 8, 8).r).toBe(11);
        expect(readLight(chunk, 8, 8, 8).b).toBe(11);

        // remove red emitter
        const oldState = stateIdForKey('redlight', registry);
        setChunkBlock(chunk, 4, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 4, 8, 8, oldState);

        // red should be gone everywhere
        expect(readLight(chunk, 4, 8, 8).r).toBe(0);
        expect(readLight(chunk, 8, 8, 8).r).toBe(0);

        // blue should be preserved
        expect(readLight(chunk, 12, 8, 8).b).toBe(15);
        expect(readLight(chunk, 8, 8, 8).b).toBe(11);
    });

    it('marks affected chunks dirty', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);
        propagateAllLight(voxels);

        // reset dirty
        chunk.dirty = false;

        const oldState = stateIdForKey('air', registry);
        setChunkBlock(chunk, 8, 8, 8, 'redlight', registry);
        updateLightOnBlockChange(voxels, 8, 8, 8, oldState);

        expect(chunk.dirty).toBe(true);
    });

    it('opaque emitter acts as border seed during removal', () => {
        // an opaque block that emits light (e.g. glowstone) should still
        // contribute its emission as a border seed during unspread.
        // setup: opaque emitter at (6,8,8), transparent emitter at (4,8,8).
        // remove the transparent emitter. the voxel at (5,8,8), between
        // them, should get relit from the opaque emitter's emission.
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [10, 0, 0], lightOpacity: 0 },
            { id: 'glowstone', cull: CullType.SOLID, texId: 'glow', lightEmission: [12, 0, 0] },
        ]);
        const voxels = createVoxels(registry);
        const chunk = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 0, 0), chunk);

        // place both emitters
        setChunkBlock(chunk, 4, 8, 8, 'redlight', registry);
        setChunkBlock(chunk, 6, 8, 8, 'glowstone', registry);
        propagateAllLight(voxels);

        // before removal: (5,8,8) has light from both sources
        // red from transparent emitter at dist 1: 10-1=9
        // red from opaque emitter at dist 1: but opaque blocks don't propagate INTO
        // their neighbors via spread (their own light stays 0 in the stored array).
        // however, in propagateAllLight, the opaque emitter writes emission=12 to
        // chunk.light and pushes to spread queue, but spreadChannel skips opaque
        // neighbors. the emitter itself gets its value written, then spread tries
        // to propagate outward. neighbor (5,8,8) coming from the glowstone:
        // decay = max(1, opacity_of_5,8,8=0) = 1, spreading = 12-1 = 11.
        // so (5,8,8) gets max(9, 11) = 11.
        expect(readLight(chunk, 5, 8, 8).r).toBe(11);

        // remove the transparent emitter
        const oldState = stateIdForKey('redlight', registry);
        setChunkBlock(chunk, 4, 8, 8, 'air', registry);
        updateLightOnBlockChange(voxels, 4, 8, 8, oldState);

        // (5,8,8) should still be lit from the glowstone, the opaque emitter's
        // emission should serve as a border seed during unspread.
        // the glowstone at (6,8,8) has light=12 stored. during unspread,
        // the opaque neighbor enters the border branch, gets boosted to
        // emission=12, which becomes the brightest neighbor for (5,8,8).
        // relight level = 12 - 1 = 11.
        expect(readLight(chunk, 5, 8, 8).r).toBe(11);

        // verify it matches a full recompute
        const voxelsFull = createVoxels(registry);
        const chunkFull = createChunk(0, 0, 0);
        voxelsFull.chunks.set(chunkKey(0, 0, 0), chunkFull);
        setChunkBlock(chunkFull, 6, 8, 8, 'glowstone', registry);
        propagateAllLight(voxelsFull);

        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            if (chunk.light[i] !== chunkFull.light[i]) {
                const lx = i & 0xf;
                const ly = (i >> 4) & 0xf;
                const lz = (i >> 8) & 0xf;
                expect(chunk.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(chunkFull.light[i]);
            }
        }
    });
});

// ── min_safe_light: batched changes produce same results as sequential ──

describe('min_safe_light batch correctness', () => {
    /** helper: get the global state id for a block key */
    function stateIdForKey(key: string, registry: ReturnType<typeof buildBlockRegistry>): number {
        const stateId = registry.keyToState.get(key);
        if (stateId === undefined) throw new Error(`unknown key: ${key}`);
        return stateId;
    }

    it('placing two adjacent opaque blocks in batch matches sequential', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // setup: emitter at (4,8,8), place stones at (6,8,8) and (7,8,8) in a batch
        // these two blocks are adjacent, both lit by the emitter, and both
        // change in the same batch. without min_safe_light, the neighbor
        // read for one could see stale light from the other.

        // --- sequential path ---
        const vSeq = createVoxels(registry);
        const cSeq = createChunk(0, 0, 0);
        vSeq.chunks.set(chunkKey(0, 0, 0), cSeq);
        setChunkBlock(cSeq, 4, 8, 8, 'redlight', registry);
        propagateAllLight(vSeq);

        const airState = stateIdForKey('air', registry);
        setChunkBlock(cSeq, 6, 8, 8, 'stone', registry);
        updateLightOnBlockChange(vSeq, 6, 8, 8, airState);
        setChunkBlock(cSeq, 7, 8, 8, 'stone', registry);
        updateLightOnBlockChange(vSeq, 7, 8, 8, airState);

        // --- batched path ---
        const vBatch = createVoxels(registry);
        const cBatch = createChunk(0, 0, 0);
        vBatch.chunks.set(chunkKey(0, 0, 0), cBatch);
        setChunkBlock(cBatch, 4, 8, 8, 'redlight', registry);
        propagateAllLight(vBatch);

        setChunkBlock(cBatch, 6, 8, 8, 'stone', registry);
        setChunkBlock(cBatch, 7, 8, 8, 'stone', registry);
        updateLightBatch(vBatch, [
            { wx: 6, wy: 8, wz: 8, oldStateId: airState },
            { wx: 7, wy: 8, wz: 8, oldStateId: airState },
        ]);

        // compare all light values in the chunk
        for (let i = 0; i < cSeq.light.length; i++) {
            const lx = i & 0xf;
            const lz = (i >> 4) & 0xf;
            const ly = i >> 8;
            expect(cBatch.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(cSeq.light[i]);
        }
    });

    it('removing two adjacent opaque blocks in batch matches sequential', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // setup: emitter at (4,8,8), stones at (6,8,8) and (7,8,8), then remove both

        // --- sequential path ---
        const vSeq = createVoxels(registry);
        const cSeq = createChunk(0, 0, 0);
        vSeq.chunks.set(chunkKey(0, 0, 0), cSeq);
        setChunkBlock(cSeq, 4, 8, 8, 'redlight', registry);
        setChunkBlock(cSeq, 6, 8, 8, 'stone', registry);
        setChunkBlock(cSeq, 7, 8, 8, 'stone', registry);
        propagateAllLight(vSeq);

        const stoneState = stateIdForKey('stone', registry);
        setChunkBlock(cSeq, 6, 8, 8, 'air', registry);
        updateLightOnBlockChange(vSeq, 6, 8, 8, stoneState);
        setChunkBlock(cSeq, 7, 8, 8, 'air', registry);
        updateLightOnBlockChange(vSeq, 7, 8, 8, stoneState);

        // --- batched path ---
        const vBatch = createVoxels(registry);
        const cBatch = createChunk(0, 0, 0);
        vBatch.chunks.set(chunkKey(0, 0, 0), cBatch);
        setChunkBlock(cBatch, 4, 8, 8, 'redlight', registry);
        setChunkBlock(cBatch, 6, 8, 8, 'stone', registry);
        setChunkBlock(cBatch, 7, 8, 8, 'stone', registry);
        propagateAllLight(vBatch);

        setChunkBlock(cBatch, 6, 8, 8, 'air', registry);
        setChunkBlock(cBatch, 7, 8, 8, 'air', registry);
        updateLightBatch(vBatch, [
            { wx: 6, wy: 8, wz: 8, oldStateId: stoneState },
            { wx: 7, wy: 8, wz: 8, oldStateId: stoneState },
        ]);

        // compare all light values
        for (let i = 0; i < cSeq.light.length; i++) {
            const lx = i & 0xf;
            const lz = (i >> 4) & 0xf;
            const ly = i >> 8;
            expect(cBatch.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(cSeq.light[i]);
        }
    });

    it('removing row of 5 blocks near emitter in batch matches sequential', () => {
        const registry = buildTestRegistry([
            { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            { id: 'stone', texId: 'stone' },
        ]);

        // setup: emitter at (4,8,8), wall of stone at x=6..10 y=8 z=8
        // remove all 5 stones in a single batch

        // --- sequential path ---
        const vSeq = createVoxels(registry);
        const cSeq = createChunk(0, 0, 0);
        vSeq.chunks.set(chunkKey(0, 0, 0), cSeq);
        setChunkBlock(cSeq, 4, 8, 8, 'redlight', registry);
        for (let x = 6; x <= 10; x++) setChunkBlock(cSeq, x, 8, 8, 'stone', registry);
        propagateAllLight(vSeq);

        const stoneState = stateIdForKey('stone', registry);
        for (let x = 6; x <= 10; x++) {
            setChunkBlock(cSeq, x, 8, 8, 'air', registry);
            updateLightOnBlockChange(vSeq, x, 8, 8, stoneState);
        }

        // --- batched path ---
        const vBatch = createVoxels(registry);
        const cBatch = createChunk(0, 0, 0);
        vBatch.chunks.set(chunkKey(0, 0, 0), cBatch);
        setChunkBlock(cBatch, 4, 8, 8, 'redlight', registry);
        for (let x = 6; x <= 10; x++) setChunkBlock(cBatch, x, 8, 8, 'stone', registry);
        propagateAllLight(vBatch);

        const changes = [];
        for (let x = 6; x <= 10; x++) {
            setChunkBlock(cBatch, x, 8, 8, 'air', registry);
            changes.push({ wx: x, wy: 8, wz: 8, oldStateId: stoneState });
        }
        updateLightBatch(vBatch, changes);

        // compare all light values
        for (let i = 0; i < cSeq.light.length; i++) {
            const lx = i & 0xf;
            const lz = (i >> 4) & 0xf;
            const ly = i >> 8;
            expect(cBatch.light[i], `mismatch at (${lx},${ly},${lz})`).toBe(cSeq.light[i]);
        }
    });
});

// ── perf measurement: 5x5 ceiling removal ───────────────────────────

describe('perf: 5x5 ceiling removal', () => {
    const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
    // Setup propagateAllLight on a ~250-chunk world dominates wall-clock
    // (the actual updateLightBatch measurement is sub-millisecond). Bump
    // past vitest's 5s default so the perf assertion can be reached.
    it('measures BFS scope for ceiling removal', { timeout: 180000 }, () => {
        // setup: rocket-spleef style arena with larger surrounding world
        const voxels = createVoxels(registry);
        voxels.authority = createVoxelsAuthority();

        // larger chunk grid, 6x4x6 = 144 chunks (more realistic loaded world)
        for (let cx = -3; cx <= 3; cx++)
            for (let cy = -1; cy <= 3; cy++) for (let cz = -3; cz <= 3; cz++) ensureChunk(voxels, cx, cy, cz);

        // stone floor across the whole world
        for (let x = -48; x < 48; x++) for (let z = -48; z < 48; z++) setBlock(voxels, x, 0, z, 'stone');
        // walls around interior (5x5 interior from x=1..5, z=1..5)
        const boxX = 1,
            boxZ = 1,
            boxW = 5,
            boxD = 5,
            boxH = 5;
        for (let dy = 1; dy <= boxH; dy++) {
            for (let dx = -1; dx <= boxW; dx++) {
                setBlock(voxels, boxX + dx, dy, boxZ - 1, 'stone');
                setBlock(voxels, boxX + dx, dy, boxZ + boxD, 'stone');
            }
            for (let dz = 0; dz < boxD; dz++) {
                setBlock(voxels, boxX - 1, dy, boxZ + dz, 'stone');
                setBlock(voxels, boxX + boxW, dy, boxZ + dz, 'stone');
            }
        }

        // ceiling at y=6 (5x5)
        const ceilingY = boxH + 1;
        for (let dx = 0; dx < boxW; dx++)
            for (let dz = 0; dz < boxD; dz++) setBlock(voxels, boxX + dx, ceilingY, boxZ + dz, 'stone');

        // compute initial light
        propagateAllLight(voxels);

        // now remove the ceiling, this is the operation we're measuring
        const changes: { wx: number; wy: number; wz: number; oldStateId: number }[] = [];
        for (let dx = 0; dx < boxW; dx++)
            for (let dz = 0; dz < boxD; dz++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                const oldStateId = resolveKey(registry, 'stone');
                setBlock(voxels, wx, ceilingY, wz, 'air');
                changes.push({ wx, wy: ceilingY, wz, oldStateId });
            }

        // drain pending light so updateLightBatch sees the changes
        voxels.authority!.changes.pendingLight.length = 0;

        const t0 = performance.now();
        updateLightBatch(voxels, changes);
        const t1 = performance.now();

        const elapsed = t1 - t0;
        // eslint-disable-next-line no-console
        console.log(`5x5 ceiling removal: ${elapsed.toFixed(2)}ms`);

        // sanity: should complete in reasonable time
        expect(elapsed).toBeLessThan(50); // generous upper bound
        // sanity: light should be correct at center of arena
        const centerChunk = voxels.chunks.get(chunkKey(0, 0, 0));
        expect(centerChunk).toBeTruthy();
        const skyAtCenter = getSky(centerChunk!.light[voxelIndex(3, 3, 3)]!);
        // inside the walled arena below ceiling, should have sky light now
        expect(skyAtCenter).toBeGreaterThan(0);
    });

    it('measures BFS scope for ceiling placement', { timeout: 60000 }, () => {
        // same setup but WITHOUT ceiling, then place it
        const voxels = createVoxels(registry);
        voxels.authority = createVoxelsAuthority();

        for (let cx = -2; cx <= 2; cx++)
            for (let cy = -1; cy <= 2; cy++) for (let cz = -2; cz <= 2; cz++) ensureChunk(voxels, cx, cy, cz);

        for (let x = -8; x < 24; x++) for (let z = -8; z < 24; z++) setBlock(voxels, x, 0, z, 'stone');

        const boxX = 1,
            boxZ = 1,
            boxW = 5,
            boxD = 5,
            boxH = 5;
        for (let dy = 1; dy <= boxH; dy++) {
            for (let dx = -1; dx <= boxW; dx++) {
                setBlock(voxels, boxX + dx, dy, boxZ - 1, 'stone');
                setBlock(voxels, boxX + dx, dy, boxZ + boxD, 'stone');
            }
            for (let dz = 0; dz < boxD; dz++) {
                setBlock(voxels, boxX - 1, dy, boxZ + dz, 'stone');
                setBlock(voxels, boxX + boxW, dy, boxZ + dz, 'stone');
            }
        }

        // NO ceiling, open top
        propagateAllLight(voxels);

        // now PLACE the ceiling
        const ceilingY = boxH + 1;
        const changes: { wx: number; wy: number; wz: number; oldStateId: number }[] = [];
        for (let dx = 0; dx < boxW; dx++)
            for (let dz = 0; dz < boxD; dz++) {
                const wx = boxX + dx;
                const wz = boxZ + dz;
                const oldStateId = resolveKey(registry, 'air');
                setBlock(voxels, wx, ceilingY, wz, 'stone');
                changes.push({ wx, wy: ceilingY, wz, oldStateId });
            }

        voxels.authority!.changes.pendingLight.length = 0;

        const t0 = performance.now();
        updateLightBatch(voxels, changes);
        const t1 = performance.now();

        const elapsed = t1 - t0;
        // eslint-disable-next-line no-console
        console.log(`5x5 ceiling placement: ${elapsed.toFixed(2)}ms`);

        expect(elapsed).toBeLessThan(50);
    });
});

// ── chunk boundary lighting tests ───────────────────────────────────
//
// regression tests for lighting at chunk boundaries where neighbor
// chunks don't exist. verifies both the light propagation engine and
// the mesher slab handle these boundaries correctly.

describe('chunk boundary lighting (no neighbor chunks)', () => {
    describe('mesher: side faces at chunk edge without neighbor', () => {
        it('side face of block at chunk boundary is lit, not dark', () => {
            // single chunk with a stone floor. blocks at x=0 have their -X
            // face pointing into the void (no neighbor chunk). that face
            // should still receive sky light from the air above, not be dark.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // stone floor at y=0
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunk, x, 0, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);
            expect(mesh).not.toBeNull();

            // find all -X face vertices (normal=(-1,0,0), x=0) on the floor blocks
            // these are the side faces at the chunk boundary
            const boundaryFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const nx = mesh.normals[i * 3]!;
                const px = mesh.positions[i * 3]!;
                if (nx === -1 && px === 0) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    boundaryFaceSkys.push(sky);
                }
            }
            expect(boundaryFaceSkys.length).toBeGreaterThan(0);

            // the -X faces should not be completely dark. the air adjacent
            // to these faces has sky light, so the faces should be lit.
            for (const sky of boundaryFaceSkys) {
                expect(sky).toBeGreaterThan(0);
            }
        });

        it('side face at +X chunk boundary without neighbor is lit', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // stone floor at y=0
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunk, x, 0, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find all +X face vertices (normal=(1,0,0), x=16) on the floor blocks
            const boundaryFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const nx = mesh.normals[i * 3]!;
                const px = mesh.positions[i * 3]!;
                if (nx === 1 && px === 16) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    boundaryFaceSkys.push(sky);
                }
            }
            expect(boundaryFaceSkys.length).toBeGreaterThan(0);

            for (const sky of boundaryFaceSkys) {
                expect(sky).toBeGreaterThan(0);
            }
        });

        it('side face at -Z chunk boundary without neighbor is lit', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // stone floor at y=0
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunk, x, 0, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find all -Z face vertices (normal=(0,0,-1), z=0) on the floor blocks
            const boundaryFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const nz = mesh.normals[i * 3 + 2]!;
                const pz = mesh.positions[i * 3 + 2]!;
                if (nz === -1 && pz === 0) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    boundaryFaceSkys.push(sky);
                }
            }
            expect(boundaryFaceSkys.length).toBeGreaterThan(0);

            for (const sky of boundaryFaceSkys) {
                expect(sky).toBeGreaterThan(0);
            }
        });

        it('side face at -Y chunk boundary without neighbor gets sky light from void', () => {
            // stone at y=0 with no chunk below. the -Y face faces void.
            // void = sky-lit air (sky=15, rgb=0). the bottom face should
            // receive sky light, not block light from emitters above.
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // single stone block at (8, 0, 8) with a red emitter next to it
            setChunkBlock(chunk, 8, 0, 8, 'stone', registry);
            setChunkBlock(chunk, 8, 1, 8, 'redlight', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find -Y face vertices (normal=(0,-1,0), y=0) on the stone at (8,0,8)
            const bottomFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                const px = mesh.positions[i * 3]!;
                const pz = mesh.positions[i * 3 + 2]!;
                if (ny === -1 && py === 0 && px >= 8 && px <= 9 && pz >= 8 && pz <= 9) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    bottomFaceSkys.push(sky);
                }
            }
            expect(bottomFaceSkys.length).toBe(4);

            // void below = sky=15. the bottom face should have sky light.
            for (const sky of bottomFaceSkys) {
                expect(sky).toBeGreaterThan(0);
            }
        });

        it('boundary side faces match interior side faces on isolated columns', () => {
            // two isolated stone columns at z=0 (chunk boundary) and z=8
            // (interior). both have exposed -Z faces toward air. the one at
            // z=0 faces the void (no neighbor chunk), while z=8 faces interior
            // air. both should receive similar sky light. this catches the
            // fallback bug where boundary faces read light from the opaque
            // block itself (= 0) instead of the sky-lit void.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // two isolated columns at x=8, y=0, at z=0 and z=8
            setChunkBlock(chunk, 8, 0, 0, 'stone', registry);
            setChunkBlock(chunk, 8, 0, 8, 'stone', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // collect sky values from -Z faces (nz=-1)
            const boundarySkys: number[] = []; // at z=0 (chunk boundary)
            const interiorSkys: number[] = []; // at z=8 (interior)
            for (let i = 0; i < mesh.vertexCount; i++) {
                const nz = mesh.normals[i * 3 + 2]!;
                const pz = mesh.positions[i * 3 + 2]!;
                const sky = (mesh.light[i]! >>> 24) & 0xff;

                if (nz === -1) {
                    if (pz === 0) boundarySkys.push(sky);
                    else if (pz === 8) interiorSkys.push(sky);
                }
            }

            expect(boundarySkys.length).toBeGreaterThan(0);
            expect(interiorSkys.length).toBeGreaterThan(0);

            // boundary side faces should be at least as bright as interior
            const avgBoundary = boundarySkys.reduce((a, b) => a + b, 0) / boundarySkys.length;
            const avgInterior = interiorSkys.reduce((a, b) => a + b, 0) / interiorSkys.length;

            // they should be similar, both see sky-lit air. allow some
            // tolerance for smooth lighting averaging differences.
            expect(avgBoundary).toBeGreaterThan(avgInterior * 0.5);
        });
    });

    describe('sky light at top of world', () => {
        it('top face of block at worldMaxY receives sky light without chunk above', () => {
            // single chunk, stone at y=15 (top of chunk). no chunk above.
            // the top face should receive sky light since it faces open sky.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 8, 15, 8, 'stone', registry);
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find top face vertices of the stone at (8,15,8)
            // top face: normal=(0,1,0), y=16
            const topFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                if (ny === 1 && py === 16) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    topFaceSkys.push(sky);
                }
            }
            expect(topFaceSkys.length).toBe(4);

            // top face should have full sky light (facing open sky).
            // raw 4-bit channel; LUT is applied in WGSL voxel-material.
            for (const sky of topFaceSkys) {
                expect(sky).toBe(15);
            }
        });

        it('full stone layer at y=15 top faces all receive sky light', () => {
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // fill y=15 with stone
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunk, x, 15, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // all top face vertices should have sky light
            const topFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                if (ny === 1 && py === 16) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    topFaceSkys.push(sky);
                }
            }
            expect(topFaceSkys.length).toBeGreaterThan(0);

            // every top face vertex should have full sky light (raw 4-bit).
            for (const sky of topFaceSkys) {
                expect(sky).toBe(15);
            }
        });

        it('stacked leaves at top of world: topmost leaf top face gets full sky light', () => {
            // leaves have lightOpacity=1, so sky decays through them. but the
            // topmost leaf's top face samples the air above it (which is void =
            // sky=15). the mesher border fill must not copy the leaf's own
            // (decayed) light into the slab border above, it should be sky=15.
            const registry = buildTestRegistry([
                { id: 'stone', texId: 'stone' },
                { id: 'leaves', texId: 'leaves', cull: CullType.SELF, lightOpacity: 1 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            // stone floor at y=0, leaves from y=12 to y=15 (4 layers)
            for (let x = 4; x < 12; x++) {
                for (let z = 4; z < 12; z++) {
                    setChunkBlock(chunk, x, 0, z, 'stone', registry);
                    for (let y = 12; y < CHUNK_SIZE; y++) {
                        setChunkBlock(chunk, x, y, z, 'leaves', registry);
                    }
                }
            }
            propagateAllLight(voxels);

            // propagateAllLight seeds sky=15 only in fully transparent columns.
            // leaves have opacity=1, so the sky column breaks at the first leaf.
            // the leaves then receive sky light via horizontal spreading from
            // adjacent air positions, with decay = 1 (step) + 1 (opacity) = 2
            // per step. interior leaves at (8,15,8) in an 8x8 patch are 4 steps
            // from the nearest air → sky = 15 - 2*4 = 7... but in practice it
            // may be higher due to diagonal spreading. just verify it's reasonable.
            const topLeafSky = readLight(chunk, 8, 15, 8).sky;
            expect(topLeafSky).toBeGreaterThan(0);
            expect(topLeafSky).toBeLessThan(15);

            const result = meshAndLight(voxels, chunk, registry);
            expect(result).not.toBeNull();
            const mesh = decodeCubeBucket(result!.opaque);

            // find top face vertices of leaves at y=15 (topmost layer)
            // top face: normal=(0,1,0), y=16
            const topFaceSkys: number[] = [];
            for (let i = 0; i < mesh.vertexCount; i++) {
                const ny = mesh.normals[i * 3 + 1]!;
                const py = mesh.positions[i * 3 + 1]!;
                if (ny === 1 && py === 16) {
                    const sky = (mesh.light[i]! >>> 24) & 0xff;
                    topFaceSkys.push(sky);
                }
            }
            expect(topFaceSkys.length).toBeGreaterThan(0);

            // the top face samples the air above (void = sky=15) and its
            // edge/corner neighbors (also void = sky=15). smooth lighting
            // averages these, giving raw sky=15 for all vertices.
            // with the old bug, void border positions copied decayed sky from
            // the leaf below, giving much dimmer values.
            for (const sky of topFaceSkys) {
                expect(sky).toBe(15);
            }
        });
    });

    describe('light propagation treats missing neighbors as air', () => {
        it('single chunk all-air has sky=15 everywhere', () => {
            // basic sanity: a lone chunk should get full sky light
            const registry = buildTestRegistry([]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            propagateAllLight(voxels);

            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const light = readLight(chunk, x, y, 8);
                    expect(light.sky).toBe(15);
                }
            }
        });

        it('block light propagates correctly at chunk boundary without neighbor', () => {
            // red emitter at (0,8,8), right at the -X boundary with no neighbor.
            // light should still spread inward within the chunk.
            const registry = buildTestRegistry([
                { id: 'redlight', cull: CullType.NONE, texId: 'red', lightEmission: [15, 0, 0], lightOpacity: 0 },
            ]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 0, 8, 8, 'redlight', registry);
            propagateAllLight(voxels);

            expect(readLight(chunk, 0, 8, 8).r).toBe(15);
            expect(readLight(chunk, 1, 8, 8).r).toBe(14);
            expect(readLight(chunk, 2, 8, 8).r).toBe(13);
        });
    });

    describe('incremental sky light at top of world', () => {
        it('removing opaque block at top of world seeds sky column from void above', () => {
            // single chunk. stone at (8,15,8) blocks sky. remove it.
            // since there's no chunk above, the void IS sky, sky=15 should
            // propagate down from the top of the world.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            setChunkBlock(chunk, 8, 15, 8, 'stone', registry);
            propagateAllLight(voxels);

            // stone at top blocks sky, air below should not have sky=15 in this column
            expect(readLight(chunk, 8, 14, 8).sky).toBeLessThan(15);

            // remove the stone
            const oldStateId = chunk.palette[chunk.data[voxelIndex(8, 15, 8)]!]!;
            setChunkBlock(chunk, 8, 15, 8, 'air', registry);
            updateLightOnBlockChange(voxels, 8, 15, 8, oldStateId);

            // now the column is unobstructed, sky=15 should reach all the way down
            expect(readLight(chunk, 8, 15, 8).sky).toBe(15);
            expect(readLight(chunk, 8, 14, 8).sky).toBe(15);
            expect(readLight(chunk, 8, 0, 8).sky).toBe(15);
        });

        it('placing block in new top chunk gets correct sky light', () => {
            // start with chunk at cy=0 with a stone floor.
            // place a block at y=16 (in a new chunk at cy=1).
            // after incremental update, the air above the new block should
            // have sky=15 and the new block's top face should be lit.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            voxels.authority = createVoxelsAuthority();

            // lower chunk with stone floor
            const chunkBot = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkBot, x, 0, z, 'stone', registry);
                }
            }
            propagateAllLight(voxels);

            // verify sky=15 at top of lower chunk (air above floor)
            expect(readLight(chunkBot, 8, 15, 8).sky).toBe(15);

            // place stone at world y=16 (local y=0 in chunk cy=1), creates new chunk
            setBlock(voxels, 8, 16, 8, 'stone');
            const chunkTop = voxels.chunks.get(chunkKey(0, 1, 0))!;
            expect(chunkTop).toBeDefined();

            // flush, this seeds sky in the new chunk, then processes the block change
            flushPendingLight(voxels);

            // air above the new stone (y=17, local y=1 in top chunk) should have sky=15
            expect(readLight(chunkTop, 8, 1, 8).sky).toBe(15);
            expect(readLight(chunkTop, 8, 15, 8).sky).toBe(15);
        });

        it('computeNewLevel: air at top of world with no chunk above gets sky=15', () => {
            // single chunk, all air. propagateAllLight gives sky=15 everywhere.
            // place an opaque block at y=15 (blocks sky), then remove it.
            // the incremental update should restore sky=15 at y=15 even though
            // there's no chunk above.
            const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
            const voxels = createVoxels(registry);
            const chunk = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 0, 0), chunk);

            propagateAllLight(voxels);
            expect(readLight(chunk, 8, 15, 8).sky).toBe(15);

            // place stone at y=15
            const oldAir = chunk.palette[chunk.data[voxelIndex(8, 15, 8)]!]!;
            setChunkBlock(chunk, 8, 15, 8, 'stone', registry);
            updateLightOnBlockChange(voxels, 8, 15, 8, oldAir);

            // stone blocks sky
            expect(readLight(chunk, 8, 14, 8).sky).toBeLessThan(15);

            // remove stone
            const oldStone = chunk.palette[chunk.data[voxelIndex(8, 15, 8)]!]!;
            setChunkBlock(chunk, 8, 15, 8, 'air', registry);
            updateLightOnBlockChange(voxels, 8, 15, 8, oldStone);

            // sky should be restored, the void above acts as sky=15
            expect(readLight(chunk, 8, 15, 8).sky).toBe(15);
            expect(readLight(chunk, 8, 14, 8).sky).toBe(15);
        });
    });
});

// ── bottom chunk sky light (bug: bottom of bottom chunks fully lit) ──
//
// the flood fill should NOT give sky=15 to opaque blocks or to air that
// is completely enclosed underground. the "bottom of bottom chunks" cases
// are the bottommost loaded chunks (no chunk below them). with a sky-
// blocking layer in a chunk above, air/blocks at the very bottom should
// remain dark, not sky=15.

describe('bottom chunk sky light', () => {
    it('stone layer in upper chunk blocks sky from lower air chunk', () => {
        // cy=1 is a full stone layer. cy=0 is all air. no chunk at cy=-1.
        // sky should NOT reach cy=0 at all.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const chunkTop = createChunk(0, 1, 0);
        const chunkBot = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
        voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
        linkChunkNeighbors(voxels, chunkTop);
        linkChunkNeighbors(voxels, chunkBot);

        // fill entire cy=1 chunk with stone
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkTop, x, y, z, 'stone', registry);
                }
            }
        }

        propagateAllLight(voxels);

        // the entire bottom chunk is air under a solid stone ceiling.
        // no sky should reach any of it.
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    const light = readLight(chunkBot, x, y, z);
                    expect(light.sky, `sky at (${x},${y},${z}) in bottom chunk should be 0`).toBe(0);
                }
            }
        }
    });

    it('bottom of bottom chunk stays dark under full-stone upper chunk', () => {
        // specifically targets the bottommost y-layer (ly=0) of the bottommost chunk.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const chunkTop = createChunk(0, 1, 0);
        const chunkBot = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
        voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
        linkChunkNeighbors(voxels, chunkTop);
        linkChunkNeighbors(voxels, chunkBot);

        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkTop, x, y, z, 'stone', registry);
                }
            }
        }

        propagateAllLight(voxels);

        // bottom layer (ly=0) is the bottommost row of the bottommost chunk
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const light = readLight(chunkBot, x, 0, z);
                expect(light.sky, `sky at bottom (${x},0,${z}) should be 0`).toBe(0);
            }
        }
    });

    it('three stacked chunks: bottom two chunks dark under solid top', () => {
        // cy=2 is solid stone, cy=1 and cy=0 are air
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const chunkHi = createChunk(0, 2, 0);
        const chunkMid = createChunk(0, 1, 0);
        const chunkLo = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 2, 0), chunkHi);
        voxels.chunks.set(chunkKey(0, 1, 0), chunkMid);
        voxels.chunks.set(chunkKey(0, 0, 0), chunkLo);
        linkChunkNeighbors(voxels, chunkHi);
        linkChunkNeighbors(voxels, chunkMid);
        linkChunkNeighbors(voxels, chunkLo);

        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkHi, x, y, z, 'stone', registry);
                }
            }
        }

        propagateAllLight(voxels);

        // both lower chunks should have sky=0 everywhere
        for (let y = 0; y < CHUNK_SIZE; y++) {
            const midLight = readLight(chunkMid, 8, y, 8);
            expect(midLight.sky, `cy=1 sky at y=${y} should be 0`).toBe(0);
            const loLight = readLight(chunkLo, 8, y, 8);
            expect(loLight.sky, `cy=0 sky at y=${y} should be 0`).toBe(0);
        }
    });

    it('single column shaft: only cells below shaft bottom should be dark', () => {
        // two stacked chunks. a 1x1 vertical air shaft (cx=8,cz=8) goes
        // through a solid stone ceiling in chunkTop (stone at all columns
        // except (8,*,8)). chunkBot is all air.
        //
        // sky=15 should propagate down the shaft into chunkBot at x=8,z=8
        // but NOT spread to (7,*,8) or adjacent positions at the very bottom.
        // adjacent positions at ly=0 in the bottom chunk should have low sky.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const chunkTop = createChunk(0, 1, 0);
        const chunkBot = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
        voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
        linkChunkNeighbors(voxels, chunkTop);
        linkChunkNeighbors(voxels, chunkBot);

        // fill the top chunk with stone, except column (8,*,8)
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    if (x === 8 && z === 8) continue;
                    setChunkBlock(chunkTop, x, y, z, 'stone', registry);
                }
            }
        }

        propagateAllLight(voxels);

        // the shaft (8,*,8) in chunkBot should have sky=15 at top (light shines in)
        expect(readLight(chunkBot, 8, 15, 8).sky).toBe(15);

        // far away from shaft (x=0,z=0) at bottom of bottom chunk:
        // sky should be low, it can only arrive via horizontal spreading
        // which decays by 1 each step. from shaft at x=8,z=8, the position
        // (0,0,0) is at manhattan distance ~16, so sky would be ~0 or very low.
        const farBottomLight = readLight(chunkBot, 0, 0, 0);
        expect(farBottomLight.sky).toBeLessThan(15);
    });

    it('incremental: placing stone ceiling dims bottom chunk correctly', () => {
        // start: two stacked chunks both all air. sky fills both chunks fully.
        // then incrementally place a complete stone layer at the bottom of
        // chunkTop (ly=0). this should darken the entire bottom chunk.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const chunkTop = createChunk(0, 1, 0);
        const chunkBot = createChunk(0, 0, 0);
        voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
        voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
        linkChunkNeighbors(voxels, chunkTop);
        linkChunkNeighbors(voxels, chunkBot);

        propagateAllLight(voxels);

        // confirm both chunks fully sky-lit before placing ceiling
        expect(readLight(chunkBot, 8, 0, 8).sky).toBe(15);
        expect(readLight(chunkBot, 8, 15, 8).sky).toBe(15);

        // place full stone ceiling at ly=0 of chunkTop (world y=16)
        const changes: { wx: number; wy: number; wz: number; oldStateId: number }[] = [];
        const airState = chunkTop.palette[chunkTop.data[voxelIndex(0, 0, 0)]!]!;
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                setChunkBlock(chunkTop, x, 0, z, 'stone', registry);
                changes.push({ wx: x, wy: 16, wz: z, oldStateId: airState });
            }
        }
        updateLightBatch(voxels, changes);

        // bottom chunk should now have sky=0 at the bottom (stone blocks all sky)
        // at center column: sky should be significantly dimmer than 15
        expect(readLight(chunkBot, 8, 15, 8).sky).toBeLessThan(15);
        // bottom of bottom chunk definitely dark
        expect(readLight(chunkBot, 8, 0, 8).sky).toBe(0);
    });

    it('incremental matches full recompute: two chunks with stone ceiling', () => {
        // compare incremental vs full recompute for a two-chunk world with
        // a stone floor in the top chunk and air in the bottom chunk.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);

        const setup = () => {
            const voxels = createVoxels(registry);
            const chunkTop = createChunk(0, 1, 0);
            const chunkBot = createChunk(0, 0, 0);
            voxels.chunks.set(chunkKey(0, 1, 0), chunkTop);
            voxels.chunks.set(chunkKey(0, 0, 0), chunkBot);
            linkChunkNeighbors(voxels, chunkTop);
            linkChunkNeighbors(voxels, chunkBot);
            return { voxels, chunkTop, chunkBot };
        };

        // incremental path: start with all air, then add stone floor in top chunk
        const inc = setup();
        propagateAllLight(inc.voxels);
        const airState = inc.chunkTop.palette[inc.chunkTop.data[voxelIndex(0, 0, 0)]!]!;
        const changes: { wx: number; wy: number; wz: number; oldStateId: number }[] = [];
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    setChunkBlock(inc.chunkTop, x, y, z, 'stone', registry);
                }
                // only the bottom layer changes are needed for incremental to process,
                // but we batch all changes since we placed all of chunkTop at once.
                // use a single representative change at the bottom layer (world y=16+y).
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    changes.push({ wx: x, wy: 16 + y, wz: z, oldStateId: airState });
                }
            }
        }
        updateLightBatch(inc.voxels, changes);

        // full recompute path: place stone in top chunk from the start
        const full = setup();
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(full.chunkTop, x, y, z, 'stone', registry);
                }
            }
        }
        propagateAllLight(full.voxels);

        // compare all light in the bottom chunk
        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; i++) {
            const lx = i & 0xf;
            const lz = (i >> 4) & 0xf;
            const ly = i >> 8;
            expect(inc.chunkBot.light[i], `bottom chunk mismatch at (${lx},${ly},${lz})`).toBe(full.chunkBot.light[i]);
        }
    });

    // ── chunk creation order bug ─────────────────────────────────────────
    //
    // when a bottom chunk is created BEFORE the chunk above it, seedNewChunkSky
    // sees no chunk above → treats void as sky → seeds the entire bottom chunk
    // as sky=15. later, when the upper chunk is created with stone, there is no
    // mechanism to retroactively darken the already-sky-seeded bottom chunk.
    // the bottom chunk retains sky=15 even though it should be dark underground.

    it('bottom chunk created before upper stone chunk: should not be fully sky-lit', () => {
        // simulate ensureChunk-style loading where cy=0 is created first (no chunk above),
        // then cy=1 is created with stone, then flushPendingLight is called.
        // the bottom chunk should NOT have sky=15 after the upper stone chunk is processed.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        voxels.authority = createVoxelsAuthority();

        // step 1: create bottom chunk first (no upper neighbor yet)
        const chunkBot = ensureChunk(voxels, 0, 0, 0);
        // at this point pendingNewChunks has chunkBot, no upper neighbor

        // step 2: create upper chunk with solid stone
        const chunkTop = ensureChunk(voxels, 0, 1, 0);
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkTop, x, y, z, 'stone', registry);
                }
            }
        }
        // clear block change ops from setChunkBlock (we just want to test sky seeding)
        voxels.authority!.changes.pendingLight.length = 0;

        // step 3: flush, seeds sky for both new chunks, then processes block changes
        flushPendingLight(voxels);

        // the bottom chunk is all air under a solid stone ceiling.
        // it should have sky=0, not sky=15.
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    const light = readLight(chunkBot, x, y, z);
                    expect(light.sky, `sky at (${x},${y},${z}) should be 0 (underground)`).toBe(0);
                }
            }
        }
    });

    it('bottom chunk loaded via setBlock before upper stone chunk: sky should be 0', () => {
        // setBlock triggers ensureChunk. if you place a block in cy=0 BEFORE
        // cy=1 exists, cy=0 gets seeded as sky=15 (no chunk above = open sky).
        // later, cy=1 is added with solid stone. after flushPendingLight, cy=0
        // should NOT have sky=15 throughout.
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);
        voxels.authority = createVoxelsAuthority();

        // place a block in cy=0 first, this triggers ensureChunk(0,0,0)
        // with no upper neighbor. the new chunk gets pushed to pendingNewChunks.
        setBlock(voxels, 8, 8, 8, 'air'); // force chunk creation at cy=0

        // now create cy=1 with full stone
        const chunkTop = ensureChunk(voxels, 0, 1, 0);
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    setChunkBlock(chunkTop, x, y, z, 'stone', registry);
                }
            }
        }
        voxels.authority!.changes.pendingLight.length = 0;

        flushPendingLight(voxels);

        const chunkBot = voxels.chunks.get(chunkKey(0, 0, 0))!;
        expect(chunkBot).toBeDefined();

        // after flushing with stone above, sky should not be 15
        const centerLight = readLight(chunkBot, 8, 0, 8);
        expect(centerLight.sky).toBe(0);
    });
});

// ── multi-chunk cave (sealed) ─────────────────────────────────────────
//
// build a sealed rectangular cave that spans many chunks horizontally
// (and a vertical extent inside a single cy=0 column). interior must be
// completely dark, no sky should reach any interior cell.

describe('multi-chunk sealed cave', () => {
    it('sky=0 throughout the interior of a 3x1x3 sealed cave', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const voxels = createVoxels(registry);

        const GRID = 3; // 3x3 chunks in X/Z at cy=0
        const chunks: ReturnType<typeof createChunk>[][] = [];
        for (let cx = 0; cx < GRID; cx++) {
            chunks[cx] = [];
            for (let cz = 0; cz < GRID; cz++) {
                const c = createChunk(cx, 0, cz);
                voxels.chunks.set(chunkKey(cx, 0, cz), c);
                chunks[cx]![cz] = c;
            }
        }
        for (let cx = 0; cx < GRID; cx++) {
            for (let cz = 0; cz < GRID; cz++) {
                linkChunkNeighbors(voxels, chunks[cx]![cz]!);
            }
        }

        const setAt = (wx: number, wy: number, wz: number, key: string) => {
            const cx = (wx / CHUNK_SIZE) | 0;
            const cz = (wz / CHUNK_SIZE) | 0;
            const lx = wx & (CHUNK_SIZE - 1);
            const lz = wz & (CHUNK_SIZE - 1);
            setChunkBlock(chunks[cx]![cz]!, lx, wy, lz, key, registry);
        };

        const W = GRID * CHUNK_SIZE;
        const H = CHUNK_SIZE;
        // floor (y=0) + ceiling (y=H-1), solid stone across the whole grid
        for (let wx = 0; wx < W; wx++) {
            for (let wz = 0; wz < W; wz++) {
                setAt(wx, 0, wz, 'stone');
                setAt(wx, H - 1, wz, 'stone');
            }
        }
        // four side walls, solid stone columns at x=0, x=W-1, z=0, z=W-1
        for (let wy = 0; wy < H; wy++) {
            for (let i = 0; i < W; i++) {
                setAt(0, wy, i, 'stone');
                setAt(W - 1, wy, i, 'stone');
                setAt(i, wy, 0, 'stone');
                setAt(i, wy, W - 1, 'stone');
            }
        }

        propagateAllLight(voxels);

        // every interior cell (x∈[1,W-2], y∈[1,H-2], z∈[1,W-2]) must be dark
        const offenders: string[] = [];
        for (let wx = 1; wx < W - 1; wx++) {
            for (let wy = 1; wy < H - 1; wy++) {
                for (let wz = 1; wz < W - 1; wz++) {
                    const cx = (wx / CHUNK_SIZE) | 0;
                    const cz = (wz / CHUNK_SIZE) | 0;
                    const lx = wx & (CHUNK_SIZE - 1);
                    const lz = wz & (CHUNK_SIZE - 1);
                    const light = readLight(chunks[cx]![cz]!, lx, wy, lz);
                    if (light.sky !== 0) {
                        offenders.push(`(${wx},${wy},${wz})=sky${light.sky}`);
                    }
                }
            }
        }

        expect(offenders.slice(0, 20), `${offenders.length} interior cells have sky>0`).toEqual([]);
    });

    // ── disk-load roundtrip (the actual runtime path) ────────────────
    //
    // mirrors what initializeRoom does on boot:
    //   1. saveVoxels  → save to disk
    //   2. loadVoxels (fresh Voxels)
    //   3. propagateAllLight
    //
    // the cave is underground: cy=-1 contains a hollow cave with a stone
    // shell, and cy=0 above is a solid stone "surface" cap. with the cap
    // sealing the cave from sky above, the cave interior must stay dark.

    it('underground cave stays dark after save → load → propagateAllLight', () => {
        const registry = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);

        // build the world: 3x3 in X/Z, two y-layers (cy=-1 cave, cy=0 surface)
        const GRID = 3;
        const src = createVoxels(registry);
        const caveChunks: ReturnType<typeof createChunk>[][] = [];
        const surfChunks: ReturnType<typeof createChunk>[][] = [];

        for (let cx = 0; cx < GRID; cx++) {
            caveChunks[cx] = [];
            surfChunks[cx] = [];
            for (let cz = 0; cz < GRID; cz++) {
                const cave = createChunk(cx, -1, cz);
                const surf = createChunk(cx, 0, cz);
                src.chunks.set(chunkKey(cx, -1, cz), cave);
                src.chunks.set(chunkKey(cx, 0, cz), surf);
                caveChunks[cx]![cz] = cave;
                surfChunks[cx]![cz] = surf;
            }
        }
        for (const c of src.chunks.values()) linkChunkNeighbors(src, c);

        // surface (cy=0): solid stone everywhere, acts as the world's
        // sky-blocking cap above the cave.
        for (const row of surfChunks) {
            for (const c of row) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    for (let y = 0; y < CHUNK_SIZE; y++) {
                        for (let z = 0; z < CHUNK_SIZE; z++) {
                            setChunkBlock(c, x, y, z, 'stone', registry);
                        }
                    }
                }
            }
        }

        // cave layer (cy=-1): solid stone walls on all six sides of the
        // GRIDxGRIDx1 cuboid, hollow interior. world coords: x∈[0,W-1],
        // y∈[-16,-1], z∈[0,W-1]. interior: x∈[1,W-2], y∈[-15,-2], z∈[1,W-2].
        const W = GRID * CHUNK_SIZE;
        const setCaveAt = (wx: number, wy: number, wz: number, key: string) => {
            const cx = (wx / CHUNK_SIZE) | 0;
            const cz = (wz / CHUNK_SIZE) | 0;
            const lx = wx & (CHUNK_SIZE - 1);
            const ly = wy - -CHUNK_SIZE; // wy is in [-16,-1] → ly in [0,15]
            const lz = wz & (CHUNK_SIZE - 1);
            setChunkBlock(caveChunks[cx]![cz]!, lx, ly, lz, key, registry);
        };

        // fill the entire cave layer with stone, then carve the interior.
        for (let wx = 0; wx < W; wx++) {
            for (let wy = -CHUNK_SIZE; wy < 0; wy++) {
                for (let wz = 0; wz < W; wz++) {
                    setCaveAt(wx, wy, wz, 'stone');
                }
            }
        }
        // carve interior: x∈[1,W-2], y∈[-15,-2], z∈[1,W-2] → air
        for (let wx = 1; wx < W - 1; wx++) {
            for (let wy = -(CHUNK_SIZE - 1); wy <= -2; wy++) {
                for (let wz = 1; wz < W - 1; wz++) {
                    setCaveAt(wx, wy, wz, 'air');
                }
            }
        }

        // ── disk roundtrip ───────────────────────────────────────────
        const saved = saveVoxels(src);
        const dst = createVoxels(registry);
        loadVoxels(dst, saved, registry);

        // sanity: chunks restored
        expect(dst.chunks.size).toBe(GRID * GRID * 2);

        // this is what initializeRoom calls after deserialize
        propagateAllLight(dst);

        // every air cell inside the cave must have sky=0
        const offenders: string[] = [];
        for (let wx = 1; wx < W - 1; wx++) {
            for (let wy = -(CHUNK_SIZE - 1); wy <= -2; wy++) {
                for (let wz = 1; wz < W - 1; wz++) {
                    const cx = (wx / CHUNK_SIZE) | 0;
                    const cz = (wz / CHUNK_SIZE) | 0;
                    const lx = wx & (CHUNK_SIZE - 1);
                    const ly = wy + CHUNK_SIZE;
                    const lz = wz & (CHUNK_SIZE - 1);
                    const chunk = dst.chunks.get(chunkKey(cx, -1, cz))!;
                    const light = readLight(chunk, lx, ly, lz);
                    if (light.sky !== 0) {
                        offenders.push(`(${wx},${wy},${wz})=sky${light.sky}`);
                    }
                }
            }
        }

        expect(offenders.slice(0, 20), `${offenders.length}/${(W - 2) * (CHUNK_SIZE - 2) * (W - 2)} cave cells lit`).toEqual([]);
    });
});
