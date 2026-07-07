// Profile harness, runs meshChunk repeatedly on bench scenes.
// Intended to be run under node --cpu-prof (via vitest --inspect-brk or
// the convenience wrapper at lib/scripts/run-profile.sh):
//   PROFILE_MESH=1 pnpm vitest run src/core/voxels/profile-mesh.test.ts
//
// Pair with scripts/analyze-cpuprofile.ts to summarize the .cpuprofile.
//
// This file is gated by `PROFILE_MESH=1` so normal test runs skip it.

import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';

import { test } from 'vitest';

import * as blockModel from '../../../../src/core/voxels/block-model';
import { buildBlockRegistry } from '../../../../src/core/voxels/block-registry';
import { type BlockDef, type BlockQuad, type BlockTextureDef, CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../../../src/core/voxels/chunk-mesher';
import { CHUNK_SIZE, type Chunk, createChunk, createVoxels, setChunkBlock, type Voxels } from '../../../../src/core/voxels/voxels';

const SHOULD_RUN = process.env.PROFILE_MESH === '1';

const SINGLE_STATE = { props: {}, totalStates: 1, encode: () => 0, decode: () => ({}) };
function texDef(id: string): BlockTextureDef {
    return { id, dependency: { registry: 'blockTextures', id }, frames: [`textures/${id}.png`], fps: 1, interpolate: false };
}

function buildBenchRegistry() {
    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, any>();
    const textures = new Map<string, BlockTextureDef>();

    type Entry = {
        id: string;
        cull?: CullType;
        material?: MaterialType;
        texId: string;
        model?: (tex: BlockTextureDef) => { type: 'cube'; textures: any } | { type: 'custom'; quads: BlockQuad[] };
    };

    function slabModel(tex: BlockTextureDef): BlockQuad[] {
        return blockModel.box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });
    }
    function stairModel(tex: BlockTextureDef): BlockQuad[] {
        const lo = blockModel.box([0, 0, 0], [1, 0.5, 1], { all: { texture: tex } });
        const hi = blockModel.box([0, 0.5, 0], [1, 1, 0.5], { all: { texture: tex } });
        return [...lo, ...hi];
    }
    function fenceModel(tex: BlockTextureDef): BlockQuad[] {
        const post = blockModel.box([0.375, 0, 0.375], [0.625, 1, 0.625], { all: { texture: tex } });
        const armN = blockModel.box([0.4375, 0.375, 0], [0.5625, 0.5625, 0.375], { all: { texture: tex } });
        const armS = blockModel.box([0.4375, 0.375, 0.625], [0.5625, 0.5625, 1], { all: { texture: tex } });
        return [...post, ...armN, ...armS];
    }

    const blocks: Entry[] = [
        { id: 'stone', texId: 'stone' },
        { id: 'dirt', texId: 'dirt' },
        { id: 'grass', texId: 'grass' },
        { id: 'leaves', cull: CullType.SELF, texId: 'leaves' },
        { id: 'water', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'water' },
        { id: 'glass', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'glass' },
        { id: 'sand', texId: 'sand' },
        { id: 'gravel', texId: 'gravel' },
        { id: 'cobblestone', texId: 'cobblestone' },
        { id: 'mossy_cobblestone', texId: 'mossy_cobblestone' },
        { id: 'oak_log', texId: 'oak_log' },
        { id: 'oak_planks', texId: 'oak_planks' },
        { id: 'oak_stairs', texId: 'oak_stairs' },
        { id: 'oak_slab', texId: 'oak_slab' },
        { id: 'bricks', texId: 'bricks' },
        { id: 'wool_white', texId: 'wool_white' },
        { id: 'glowstone', texId: 'glowstone' },
        { id: 'ice', cull: CullType.SELF, material: MaterialType.TRANSLUCENT, texId: 'ice' },
        { id: 'snow', texId: 'snow' },
        { id: 'torch', cull: CullType.NONE, texId: 'torch' },
        { id: 'slab_b', cull: CullType.PARTIAL, texId: 'oak_planks', model: (t) => ({ type: 'custom', quads: slabModel(t) }) },
        { id: 'stair_b', cull: CullType.PARTIAL, texId: 'oak_stairs', model: (t) => ({ type: 'custom', quads: stairModel(t) }) },
        { id: 'fence_b', cull: CullType.PARTIAL, texId: 'oak_log', model: (t) => ({ type: 'custom', quads: fenceModel(t) }) },
    ];

    for (const b of blocks) {
        const tex = texDef(b.texId);
        textures.set(b.texId, tex);
        const def: BlockDef = {
            id: b.id,
            name: b.id,
            states: SINGLE_STATE as any,
            model: b.model ? () => b.model!(tex) : () => ({ type: 'cube' as const, textures: { all: { texture: tex } } }),
            cull: b.cull ?? CullType.SOLID,
            material: b.material ?? MaterialType.OPAQUE,
        };
        defs.set(b.id, def);
        handles.set(b.id, {
            id: b.id,
            states: SINGLE_STATE,
            _def: def,
            _baseStateId: 0,
            _index: 0,
            totalStates: 1,
            stateId: () => 0,
            defaultId: () => 0,
            stateKey: () => b.id,
            defaultKey: () => b.id,
        });
    }
    return buildBlockRegistry(defs, handles, textures);
}

function makeTerrainChunk(registry: ReturnType<typeof buildBenchRegistry>): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    for (let y = 0; y < 8; y++)
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const key = y < 6 ? 'stone' : y < 7 ? 'dirt' : 'grass';
                setChunkBlock(chunk, x, y, z, key, registry);
            }
    chunk.dirty = true;
    return voxels;
}

function makeVillage(registry: ReturnType<typeof buildBenchRegistry>): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            setChunkBlock(chunk, x, 0, z, 'stone', registry);
            setChunkBlock(chunk, x, 1, z, 'stone', registry);
            setChunkBlock(chunk, x, 2, z, 'cobblestone', registry);
            setChunkBlock(chunk, x, 3, z, 'dirt', registry);
            setChunkBlock(chunk, x, 4, z, ((x + z) & 3) === 0 ? 'mossy_cobblestone' : 'grass', registry);
            if (z === 8) setChunkBlock(chunk, x, 5, z, 'gravel', registry);
            if (x < 5 && z < 5) {
                setChunkBlock(chunk, x, 4, z, 'sand', registry);
                if (x < 3 && z < 3) setChunkBlock(chunk, x, 4, z, 'water', registry);
            }
        }
    }
    const hx0 = 6,
        hz0 = 2,
        hx1 = 13,
        hz1 = 9;
    for (let z = hz0; z <= hz1; z++) for (let x = hx0; x <= hx1; x++) setChunkBlock(chunk, x, 5, z, 'oak_planks', registry);
    for (let y = 6; y < 9; y++) {
        for (let x = hx0; x <= hx1; x++) {
            const corner = x === hx0 || x === hx1;
            const window = !corner && y === 7 && (x & 1) === 0;
            setChunkBlock(chunk, x, y, hz0, corner ? 'oak_log' : window ? 'glass' : 'bricks', registry);
            setChunkBlock(chunk, x, y, hz1, corner ? 'oak_log' : window ? 'glass' : 'bricks', registry);
        }
        for (let z = hz0 + 1; z < hz1; z++) {
            const wallW = y === 7 && (z & 1) === 0 ? 'glass' : 'bricks';
            const wallE = y === 7 && ((z + 1) & 1) === 0 ? 'glass' : 'bricks';
            setChunkBlock(chunk, hx0, y, z, wallW, registry);
            setChunkBlock(chunk, hx1, y, z, wallE, registry);
        }
    }
    for (let x = hx0; x <= hx1; x++) {
        setChunkBlock(chunk, x, 9, hz0, 'oak_stairs', registry);
        setChunkBlock(chunk, x, 9, hz1, 'oak_stairs', registry);
    }
    for (let z = hz0 + 1; z < hz1; z++) {
        setChunkBlock(chunk, hx0, 9, z, 'oak_stairs', registry);
        setChunkBlock(chunk, hx1, 9, z, 'oak_stairs', registry);
        for (let x = hx0 + 1; x < hx1; x++) setChunkBlock(chunk, x, 9, z, 'oak_slab', registry);
    }
    setChunkBlock(chunk, hx0 + 3, 9, hz0 + 3, 'wool_white', registry);
    setChunkBlock(chunk, hx0 + 4, 8, hz0 + 4, 'glowstone', registry);
    setChunkBlock(chunk, hx0 + 1, 7, hz0 + 1, 'torch', registry);
    setChunkBlock(chunk, hx1 - 1, 7, hz1 - 1, 'torch', registry);
    const tx = 2,
        tz = 12;
    for (let y = 5; y < 9; y++) setChunkBlock(chunk, tx, y, tz, 'oak_log', registry);
    for (let dy = 0; dy < 3; dy++) {
        const radius = dy === 2 ? 1 : 2;
        for (let dz = -radius; dz <= radius; dz++)
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dz === 0 && dy < 2) continue;
                const lx = tx + dx,
                    ly = 8 + dy,
                    lz = tz + dz;
                if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE)
                    setChunkBlock(chunk, lx, ly, lz, 'leaves', registry);
            }
    }
    for (let z = 13; z < CHUNK_SIZE; z++)
        for (let x = 13; x < CHUNK_SIZE; x++) {
            setChunkBlock(chunk, x, 5, z, 'ice', registry);
            setChunkBlock(chunk, x, 6, z, 'snow', registry);
        }
    chunk.dirty = true;
    return voxels;
}

function makeModelDispatch(registry: ReturnType<typeof buildBenchRegistry>): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let x = 0; x < CHUNK_SIZE; x++) for (let y = 0; y < 4; y++) setChunkBlock(chunk, x, y, z, 'stone', registry);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const k = (x + z * 3) % 5;
            const id = k < 2 ? 'slab_b' : k < 4 ? 'stair_b' : 'fence_b';
            setChunkBlock(chunk, x, 4, z, id, registry);
            if ((x ^ z) % 4 === 0) setChunkBlock(chunk, x, 5, z, 'stair_b', registry);
            if ((x + z) % 7 === 0) setChunkBlock(chunk, x, 6, z, 'fence_b', registry);
        }
    }
    chunk.dirty = true;
    return voxels;
}

const _profileMeshOutput = createMeshOutput();
function meshAndLight(voxels: Voxels, chunk: Chunk, registry: ReturnType<typeof buildBenchRegistry>): void {
    meshChunk(_profileMeshOutput, buildMeshInput(voxels, chunk), registry);
}

test.skipIf(!SHOULD_RUN)(
    'profile meshChunk',
    async () => {
        const registry = buildBenchRegistry();
        const scenes = [
            { name: 'terrain', voxels: makeTerrainChunk(registry) },
            { name: 'village', voxels: makeVillage(registry) },
            { name: 'model_dispatch', voxels: makeModelDispatch(registry) },
        ];
        const ITERS = 8000;

        // warm-up
        for (const s of scenes) {
            const c = s.voxels.chunks.get('0,0,0')!;
            for (let i = 0; i < 200; i++) {
                c.dirty = true;
                meshAndLight(s.voxels, c, registry);
            }
        }

        // start CPU profiler, captures only the hot region (skips vitest boot,
        // pnpm wrapper, etc. that --cpu-prof would otherwise dominate)
        const session = new Session();
        session.connect();
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 100 }); // µs
        await session.post('Profiler.start');

        console.log(`\n# scene timings (${ITERS} iters each)`);
        for (const s of scenes) {
            const c = s.voxels.chunks.get('0,0,0')!;
            const t0 = performance.now();
            for (let i = 0; i < ITERS; i++) {
                c.dirty = true;
                meshAndLight(s.voxels, c, registry);
            }
            const t1 = performance.now();
            const total = t1 - t0;
            console.log(`  ${s.name.padEnd(20)} ${(total / ITERS).toFixed(3)} ms/iter   (${total.toFixed(0)} ms total)`);
        }

        const { profile } = await session.post('Profiler.stop');
        const outPath = process.env.PROFILE_MESH_OUT ?? 'mesh.cpuprofile';
        writeFileSync(outPath, JSON.stringify(profile));
        console.log(`\n# cpuprofile written: ${outPath}`);
        session.disconnect();
    },
    120_000,
);
