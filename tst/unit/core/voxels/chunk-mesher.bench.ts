// ── chunk mesher benchmark ──────────────────────────────────────────
//
// run with: pnpm vitest bench src/core/voxels/chunk-mesher.bench.ts
//
// meshChunk emits geometry + AO + per-vertex light in a single pass.
// the bench scenarios below cover the realistic shape mix and neighbour
// states the production remesh path hits.

import { bench, describe } from 'vitest';
import * as blockModel from '../../../../src/core/voxels/block-model';
import { buildBlockRegistry } from '../../../../src/core/voxels/block-registry';
import { type BlockDef, type BlockQuad, type BlockTextureDef, CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { buildMeshInput, createMeshOutput, meshChunk } from '../../../../src/core/voxels/chunk-mesher';
import { CHUNK_SIZE, type Chunk, createChunk, createVoxels, setChunkBlock, type Voxels } from '../../../../src/core/voxels/voxels';

// ── helpers ─────────────────────────────────────────────────────────

const SINGLE_STATE = {
    props: {},
    totalStates: 1,
    encode: () => 0,
    decode: () => ({}),
};

function texDef(id: string): BlockTextureDef {
    return { id, frames: [`textures/${id}.png`], fps: 1, interpolate: false };
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

    // simple custom models that exercise MODEL_MESH dispatch:
    // - slab_b: bottom half-cube → ALIGNED_PARTIAL on side faces
    // - stair_b: two stacked boxes → ALIGNED_PARTIAL + PARALLEL inset faces
    // - fence_b: thin post + arms → NON_PARALLEL / IRREGULAR cases
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
        // village-scenario filler, varied cull/material to exercise diverse-state cache behavior.
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
        // model-shape benchers, drive MODEL_MESH dispatch in chunk-mesher.
        { id: 'slab_b', cull: CullType.PARTIAL, texId: 'oak_planks', model: (t) => ({ type: 'custom', quads: slabModel(t) }) },
        { id: 'stair_b', cull: CullType.PARTIAL, texId: 'oak_stairs', model: (t) => ({ type: 'custom', quads: stairModel(t) }) },
        { id: 'fence_b', cull: CullType.PARTIAL, texId: 'oak_log', model: (t) => ({ type: 'custom', quads: fenceModel(t) }) },
    ];

    for (const b of blocks) {
        const tex = texDef(b.texId);
        textures.set(b.texId, tex);

        const def: BlockDef = {
            id: b.id,
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

const registry = buildBenchRegistry();

// ── chunk generators ────────────────────────────────────────────────

/** fully solid chunk, worst case for vertex count (only surface faces visible) */
function makeDenseChunk(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    for (let y = 0; y < CHUNK_SIZE; y++)
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(chunk, x, y, z, 'stone', registry);
    chunk.dirty = true;
    return voxels;
}

/** dense chunk with 6 solid neighbors, most faces culled */
function makeDenseWithNeighbors(): Voxels {
    const voxels = createVoxels(registry);
    // center chunk
    const center = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', center);
    for (let y = 0; y < CHUNK_SIZE; y++)
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(center, x, y, z, 'stone', registry);

    // 6 neighbors, all solid
    const dirs = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
    ];
    for (const [dx, dy, dz] of dirs) {
        const nc = createChunk(dx!, dy!, dz!);
        voxels.chunks.set(`${dx},${dy},${dz}`, nc);
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(nc, x, y, z, 'stone', registry);
    }

    center.dirty = true;
    return voxels;
}

/** terrain-like: stone below y=8, air above, typical real-world pattern */
function makeTerrainChunk(): Voxels {
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

/** checkerboard, maximum exposed faces, worst case for face count */
function makeCheckerboard(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    for (let y = 0; y < CHUNK_SIZE; y++)
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let x = 0; x < CHUNK_SIZE; x++) if ((x + y + z) % 2 === 0) setChunkBlock(chunk, x, y, z, 'stone', registry);
    chunk.dirty = true;
    return voxels;
}

/** sparse, 64 randomly placed blocks */
function makeSparse(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);

    // deterministic "random" placement
    let seed = 12345;
    for (let i = 0; i < 64; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const x = seed % CHUNK_SIZE;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const y = seed % CHUNK_SIZE;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const z = seed % CHUNK_SIZE;
        setChunkBlock(chunk, x, y, z, 'stone', registry);
    }
    chunk.dirty = true;
    return voxels;
}

/** mixed cull classes, solid terrain + water pool + leaves canopy */
function makeMixed(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);

    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let x = 0; x < CHUNK_SIZE; x++) {
            // stone base y=0..3
            for (let y = 0; y < 4; y++) setChunkBlock(chunk, x, y, z, 'stone', registry);
            // water pool y=4..5 in one quadrant
            if (x < 8 && z < 8) {
                for (let y = 4; y < 6; y++) setChunkBlock(chunk, x, y, z, 'water', registry);
            }
            // leaves canopy y=10..12 scattered
            if ((x + z) % 3 === 0 && x > 4 && z > 4) {
                for (let y = 10; y < 13; y++) setChunkBlock(chunk, x, y, z, 'leaves', registry);
            }
        }
    chunk.dirty = true;
    return voxels;
}

/** village, diverse real-world chunk with ~18 distinct stateIds, clustered
 *  spatially (not random noise). meant to expose cache-pressure regressions
 *  that single/few-state benches miss: per-state tables get accessed across
 *  a wider footprint, and chunks like this are typical, not pathological. */
function makeVillage(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);

    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            // bedrock-ish layer + dirt + grass
            setChunkBlock(chunk, x, 0, z, 'stone', registry);
            setChunkBlock(chunk, x, 1, z, 'stone', registry);
            setChunkBlock(chunk, x, 2, z, 'cobblestone', registry);
            setChunkBlock(chunk, x, 3, z, 'dirt', registry);
            setChunkBlock(chunk, x, 4, z, ((x + z) & 3) === 0 ? 'mossy_cobblestone' : 'grass', registry);

            // gravel path running along z=8
            if (z === 8) setChunkBlock(chunk, x, 5, z, 'gravel', registry);

            // sandy beach + water moat in one quadrant
            if (x < 5 && z < 5) {
                setChunkBlock(chunk, x, 4, z, 'sand', registry);
                if (x < 3 && z < 3) setChunkBlock(chunk, x, 4, z, 'water', registry);
            }
        }
    }

    // house: planks floor + log corners + bricks walls + glass windows + roof
    const hx0 = 6,
        hz0 = 2,
        hx1 = 13,
        hz1 = 9;
    // floor
    for (let z = hz0; z <= hz1; z++) for (let x = hx0; x <= hx1; x++) setChunkBlock(chunk, x, 5, z, 'oak_planks', registry);
    // walls (bricks) + corners (logs) + windows (glass)
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
    // roof: stairs perimeter, slab interior, wool decoration
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

    // interior light + torches on walls
    setChunkBlock(chunk, hx0 + 4, 8, hz0 + 4, 'glowstone', registry);
    setChunkBlock(chunk, hx0 + 1, 7, hz0 + 1, 'torch', registry);
    setChunkBlock(chunk, hx1 - 1, 7, hz1 - 1, 'torch', registry);

    // tree behind house: oak_log trunk + leaves canopy
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

    // ice patch + snow cap in opposite corner
    for (let z = 13; z < CHUNK_SIZE; z++)
        for (let x = 13; x < CHUNK_SIZE; x++) {
            setChunkBlock(chunk, x, 5, z, 'ice', registry);
            setChunkBlock(chunk, x, 6, z, 'snow', registry);
        }

    chunk.dirty = true;
    return voxels;
}

/** model dispatch, stairs/slabs/fences carpet over a stone base.
 *  exercises the MODEL_MESH bake/relight path that single-shape benches miss
 *  (AoFaceData blend + 5-shape dispatch + per-quad inset face cache). */
function makeModelDispatch(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);

    // stone base y=0..3 (background, mostly culled, keeps light/AO realistic)
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let x = 0; x < CHUNK_SIZE; x++) for (let y = 0; y < 4; y++) setChunkBlock(chunk, x, y, z, 'stone', registry);

    // model carpet at y=4..6, 3 model variants tiled across the chunk
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const k = (x + z * 3) % 5;
            // k=0,1 → slab, k=2,3 → stair, k=4 → fence (rough 2:2:1 mix)
            const id = k < 2 ? 'slab_b' : k < 4 ? 'stair_b' : 'fence_b';
            setChunkBlock(chunk, x, 4, z, id, registry);
            // occasional second-layer stair to drive ALIGNED_PARTIAL pairings
            if ((x ^ z) % 4 === 0) setChunkBlock(chunk, x, 5, z, 'stair_b', registry);
            // sparse fence posts above to add IRREGULAR-heavy work
            if ((x + z) % 7 === 0) setChunkBlock(chunk, x, 6, z, 'fence_b', registry);
        }
    }
    chunk.dirty = true;
    return voxels;
}

// ── benchmarks ──────────────────────────────────────────────────────

/** real-remesh cost: meshChunk emits geometry, AO and per-vertex
 *  light in a single pass. */
const _benchMeshOutput = createMeshOutput();
function meshAndLight(voxels: Voxels, chunk: Chunk): void {
    meshChunk(_benchMeshOutput, buildMeshInput(voxels, chunk), registry);
}

describe('meshAndLight', () => {
    // pre-build voxels outside bench loop (we measure mesh + light only)
    const dense = makeDenseChunk();
    const denseNeighbors = makeDenseWithNeighbors();
    const terrain = makeTerrainChunk();
    const checkerboard = makeCheckerboard();
    const sparse = makeSparse();
    const mixed = makeMixed();
    const village = makeVillage();
    const modelDispatch = makeModelDispatch();

    bench('dense (4096 blocks, no neighbors)', () => {
        const chunk = dense.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(dense, chunk);
    });

    bench('dense + 6 solid neighbors (4096 blocks, all faces culled)', () => {
        const chunk = denseNeighbors.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(denseNeighbors, chunk);
    });

    bench('terrain (half-filled, stone+dirt+grass)', () => {
        const chunk = terrain.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(terrain, chunk);
    });

    bench('checkerboard (2048 blocks, max exposed faces)', () => {
        const chunk = checkerboard.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(checkerboard, chunk);
    });

    bench('sparse (64 blocks)', () => {
        const chunk = sparse.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(sparse, chunk);
    });

    bench('mixed (solid + water + leaves)', () => {
        const chunk = mixed.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(mixed, chunk);
    });

    bench('village (~18 distinct stateIds, realistic clustering)', () => {
        const chunk = village.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(village, chunk);
    });

    bench('model dispatch (stairs+slabs+fences, MODEL_MESH path)', () => {
        const chunk = modelDispatch.chunks.get('0,0,0')!;
        chunk.dirty = true;
        meshAndLight(modelDispatch, chunk);
    });
});
