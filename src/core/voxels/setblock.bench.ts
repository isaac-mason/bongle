// ── setBlock benchmark ──────────────────────────────────────────────
//
// run with: pnpm vitest bench src/core/voxels/setblock.bench.ts
//
// measures setBlock() and setChunkBlock() throughput across patterns
// that stress different parts of the write path: palette growth,
// boundary neighbor invalidation, change tracking (server mode),
// flood-fill vs inline-light seed.
//
// each iteration performs a bulk operation (typically CHUNK_VOLUME
// writes) so the per-iteration teardown — re-creating the Voxels —
// is amortized across thousands of calls. divide reported time by
// the op count to get a per-call estimate.

import { bench, describe } from 'vitest';
import { registry } from '../registry';
import { SetBlockFlags } from './block-flags';
import { runNeighbourRecompute } from './block-hooks';
import { BLOCK_FLAG_FENCE, buildBlockRegistry } from './block-registry';
import * as bs from './block-state';
import { type BlockDef, type BlockTextureDef, block, CullType, MaterialType } from './blocks';
import {
    CHUNK_SIZE,
    CHUNK_VOLUME,
    createChunk,
    createVoxels,
    createVoxelsAuthority,
    getBlockState,
    setBlock,
    setChunkBlock,
    type Voxels,
} from './voxels';

// ── registry ────────────────────────────────────────────────────────

const SINGLE_STATE = {
    props: {},
    totalStates: 1,
    encode: () => 0,
    decode: () => ({}),
};

function texDef(id: string): BlockTextureDef {
    return { id, frames: [`textures/${id}.png`], fps: 1, interpolate: false };
}

function buildBenchRegistry(extraKeys: string[] = []) {
    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, any>();
    const textures = new Map<string, BlockTextureDef>();

    const baseIds = ['stone', 'dirt', 'grass', 'sand', 'wood', 'leaves'];
    const allIds = [...baseIds, ...extraKeys];

    for (const id of allIds) {
        const tex = texDef(id);
        textures.set(id, tex);

        const def: BlockDef = {
            id,
            states: SINGLE_STATE as any,
            model: () => ({ type: 'cube' as const, textures: { all: { texture: tex } } }),
            cull: CullType.SOLID,
            material: MaterialType.OPAQUE,
        };
        defs.set(id, def);
        handles.set(id, {
            id,
            states: SINGLE_STATE,
            _def: def,
            _baseStateId: 0,
            _index: 0,
            totalStates: 1,
            stateId: () => 0,
            defaultId: () => 0,
            stateKey: () => id,
            defaultKey: () => id,
        });
    }

    return buildBlockRegistry(defs, handles, textures);
}

const baseRegistry = buildBenchRegistry();

// many-key registry for palette-growth bench (one key per voxel in a chunk)
const manyKeys = Array.from({ length: 64 }, (_, i) => `block_${i}`);
const manyKeyRegistry = buildBenchRegistry(manyKeys);

// ── helpers ─────────────────────────────────────────────────────────

/** disable flood-fill so light writes take the inline-seed path. */
function withoutFloodFill(voxels: Voxels): Voxels {
    voxels.authority!.floodFillLighting.enabled = false;
    return voxels;
}

// ── setChunkBlock (chunk-local, no boundary / change tracking) ──────

describe('setChunkBlock', () => {
    bench('linear fill — 4096 single-key writes', () => {
        const chunk = createChunk(0, 0, 0);
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(chunk, x, y, z, 'stone', baseRegistry);
    });

    bench('palette growth — 4096 writes, 64 distinct keys', () => {
        const chunk = createChunk(0, 0, 0);
        let i = 0;
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    setChunkBlock(chunk, x, y, z, manyKeys[i++ & 63]!, manyKeyRegistry);
                }
    });

    bench('overwrite same key — 4096 writes, palette stable', () => {
        const chunk = createChunk(0, 0, 0);
        // pre-fill so the writes are pure overwrites (no aggregate / palette changes)
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(chunk, x, y, z, 'stone', baseRegistry);

        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setChunkBlock(chunk, x, y, z, 'stone', baseRegistry);
    });
});

// ── setBlock (world-level, full path) ───────────────────────────────

describe('setBlock — client mode (no change tracking)', () => {
    bench('linear fill — 4096 writes in one chunk', () => {
        const voxels = createVoxels(baseRegistry);
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setBlock(voxels, x, y, z, 'stone', SetBlockFlags.BULK);
    });

    bench('random scatter — 4096 writes across 27 chunks', () => {
        const voxels = createVoxels(baseRegistry);
        let seed = 12345;
        const range = CHUNK_SIZE * 3; // spans -CHUNK_SIZE..2*CHUNK_SIZE, 27 chunks
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const x = (seed % range) - CHUNK_SIZE;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const y = (seed % range) - CHUNK_SIZE;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const z = (seed % range) - CHUNK_SIZE;
            setBlock(voxels, x, y, z, 'stone', SetBlockFlags.BULK);
        }
    });

    bench('boundary edits — 1024 writes on chunk faces', () => {
        const voxels = createVoxels(baseRegistry);
        // walk the +X face of chunk (0,0,0): every write triggers
        // markBoundaryNeighborsDirty + creates neighbor chunks via getBlock
        const wx = CHUNK_SIZE - 1;
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++) {
                setBlock(voxels, wx, y, z, 'stone');
                setBlock(voxels, 0, y, z, 'stone');
                setBlock(voxels, wx, y, z, 'dirt');
                setBlock(voxels, 0, y, z, 'dirt');
            }
    });

    bench('chunk creation churn — 4096 writes across 64 fresh chunks', () => {
        const voxels = createVoxels(baseRegistry);
        // one write per chunk in a 4×4×4 region, 64 chunks total, repeat 64×
        // dominated by ensureChunk + linkChunkNeighbors + first-write palette fill
        for (let pass = 0; pass < 64; pass++) {
            for (let cy = 0; cy < 4; cy++)
                for (let cz = 0; cz < 4; cz++)
                    for (let cx = 0; cx < 4; cx++) {
                        const wx = cx * CHUNK_SIZE + (pass & 15);
                        const wy = cy * CHUNK_SIZE + ((pass >> 4) & 15);
                        const wz = cz * CHUNK_SIZE + ((pass >> 4) & 15);
                        setBlock(voxels, wx, wy, wz, 'stone');
                    }
        }
    });
});

describe('setBlock — server mode (change tracking on)', () => {
    bench('linear fill — 4096 writes, flood-fill enabled', () => {
        const voxels = createVoxels(baseRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setBlock(voxels, x, y, z, 'stone', SetBlockFlags.BULK);
    });

    bench('linear fill — 4096 writes, flood-fill disabled (inline light seed)', () => {
        const voxels = withoutFloodFill(createVoxels(baseRegistry));
        voxels.authority = createVoxelsAuthority();
        for (let y = 0; y < CHUNK_SIZE; y++)
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) setBlock(voxels, x, y, z, 'stone', SetBlockFlags.BULK);
    });

    bench('random scatter — 4096 writes across 27 chunks, flood-fill enabled', () => {
        const voxels = createVoxels(baseRegistry);
        voxels.authority = createVoxelsAuthority();
        let seed = 12345;
        const range = CHUNK_SIZE * 3;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const x = (seed % range) - CHUNK_SIZE;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const y = (seed % range) - CHUNK_SIZE;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const z = (seed % range) - CHUNK_SIZE;
            setBlock(voxels, x, y, z, 'stone', SetBlockFlags.BULK);
        }
    });
});

// ── fence onNeighbourUpdate (state recompute on placement) ──────────
//
// declares a stone + 4-bool fence (16 states) via the public block() API
// — same module-scope path user code takes. onNeighbourUpdate sets
// {north,east,south,west} based on solid/fence neighbours. measures the
// full place-and-recompute flow: setBlock writes the op,
// runNeighbourRecompute drains ops and fires onNeighbourUpdate on the
// placed cell + its 6 neighbours (chains when the handler issues
// another setBlock).
//
// `bench:` id prefix keeps these out of the way of any other declarations
// that might be picked up by the shared module-scope registry.

const StoneBlock = block('bench:stone_solid', {
    model: () => ({ type: 'cube', textures: { all: { texture: 'bench:stone' } } }),
});

const FenceState = bs.create({
    north: bs.bool(),
    east: bs.bool(),
    south: bs.bool(),
    west: bs.bool(),
});

const FenceBlock = block('bench:fence', {
    states: FenceState,
    model: () => ({ type: 'cube', textures: { all: { texture: 'bench:fence' } } }),
    cull: CullType.PARTIAL,
    flags: BLOCK_FLAG_FENCE,
    onNeighbourUpdate(ctx) {
        const v = ctx.voxels;
        const cullTable = v.registry.cull;
        const flagsTable = v.registry.flags;

        const idN = getBlockState(v, ctx.worldX, ctx.worldY, ctx.worldZ - 1);
        const idS = getBlockState(v, ctx.worldX, ctx.worldY, ctx.worldZ + 1);
        const idE = getBlockState(v, ctx.worldX + 1, ctx.worldY, ctx.worldZ);
        const idW = getBlockState(v, ctx.worldX - 1, ctx.worldY, ctx.worldZ);

        const connectsN = idN !== 0 && (cullTable[idN] === CullType.SOLID || (flagsTable[idN]! & BLOCK_FLAG_FENCE) !== 0);
        const connectsS = idS !== 0 && (cullTable[idS] === CullType.SOLID || (flagsTable[idS]! & BLOCK_FLAG_FENCE) !== 0);
        const connectsE = idE !== 0 && (cullTable[idE] === CullType.SOLID || (flagsTable[idE]! & BLOCK_FLAG_FENCE) !== 0);
        const connectsW = idW !== 0 && (cullTable[idW] === CullType.SOLID || (flagsTable[idW]! & BLOCK_FLAG_FENCE) !== 0);

        return FenceBlock.stateId({ north: connectsN, east: connectsE, south: connectsS, west: connectsW });
    },
});

const fenceRegistry = registry.blockRegistry;
const FENCE_KEY = FenceBlock.defaultKey();
const STONE_KEY = StoneBlock.defaultKey();

// each bench is explicit about flags so the comparison is real. BULK +
// trailing drain mirrors the editor command path (the fast one). DEFAULT
// (inline drain per setBlock) mirrors gameplay code that just calls
// setBlock and expects the new fence to be connected on the next line —
// this is the slow path the bench guards against accidentally entering
// from a bulk loop.

describe('setBlock + onNeighbourUpdate (fence state recompute)', () => {
    bench('place 1 fence in empty world (DEFAULT, inline drain)', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        setBlock(voxels, 8, 8, 8, FENCE_KEY);
    });

    bench('place 1 fence with 4 stone neighbours pre-placed (DEFAULT)', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        setBlock(voxels, 7, 8, 8, STONE_KEY, SetBlockFlags.BULK);
        setBlock(voxels, 9, 8, 8, STONE_KEY, SetBlockFlags.BULK);
        setBlock(voxels, 8, 8, 7, STONE_KEY, SetBlockFlags.BULK);
        setBlock(voxels, 8, 8, 9, STONE_KEY, SetBlockFlags.BULK);
        voxels.authority!.changes.ops.length = 0;

        setBlock(voxels, 8, 8, 8, FENCE_KEY);
    });

    bench('place 16 fences in a line, BULK + one drain', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let x = 0; x < 16; x++) setBlock(voxels, x, 8, 8, FENCE_KEY, SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);
    });

    bench('place 16 fences in a line, DEFAULT (inline drain per op)', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let x = 0; x < 16; x++) setBlock(voxels, x, 8, 8, FENCE_KEY);
    });

    bench('place 16x16 grid, BULK + one drain', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) setBlock(voxels, x, 8, z, FENCE_KEY, SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);
    });

    bench('place 16x16 grid, DEFAULT (inline drain per op)', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) setBlock(voxels, x, 8, z, FENCE_KEY);
    });

    bench('break 1 fence in a 16x16 grid (DEFAULT, ripple to 4 neighbours)', () => {
        const voxels = createVoxels(fenceRegistry);
        voxels.authority = createVoxelsAuthority();
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) setBlock(voxels, x, 8, z, FENCE_KEY, SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);
        voxels.authority!.changes.ops.length = 0;

        // remove the centre fence — DEFAULT drains inline so the 4
        // neighbouring fences see settled state by the time setBlock returns
        setBlock(voxels, 8, 8, 8, 'air');
    });
});
