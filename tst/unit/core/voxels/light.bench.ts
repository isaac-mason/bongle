// ── light propagation benchmark ─────────────────────────────────────
//
// run with: pnpm vitest bench src/core/voxels/light.bench.ts
//
// two suites:
//   1. propagateAllLight, full recompute. characterizes the cost of
//      the editor "rebake light" command (and the now-removed startup
//      pass that initializeRoom used to run). measures sky-only,
//      emitter-only, and mixed scenarios across chunk counts.
//
//   2. flushPendingLight, incremental updates triggered by setBlock.
//      models the gameplay path: place a block, drain pendingLight at
//      end of tick. covers single-block / batch / per-tick scenarios.
//
// setup work is performed inside each iteration (same as setblock.bench);
// for the incremental suite we keep the pre-lit world small (1-2 chunks)
// so the propagateAllLight setup doesn't dominate the measurement of the
// actual flush.

import { bench, describe } from 'vitest';
import { SetBlockFlags } from '../../../../src/core/voxels/block-flags';
import { buildBlockRegistry } from '../../../../src/core/voxels/block-registry';
import { type BlockDef, type BlockTextureDef, CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { flushPendingLight, propagateAllLight, updateLightBatch } from '../../../../src/core/voxels/light';
import { CHUNK_SIZE, createVoxels, createVoxelsAuthority, ensureChunk, setBlock, type Voxels } from '../../../../src/core/voxels/voxels';

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

type Spec = {
    id: string;
    cull?: CullType;
    material?: MaterialType;
    lightEmission?: [number, number, number];
    lightOpacity?: number;
};

function buildLightRegistry(specs: Spec[]) {
    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, any>();
    const textures = new Map<string, BlockTextureDef>();
    for (const s of specs) {
        const tex = texDef(s.id);
        textures.set(s.id, tex);
        const def: BlockDef = {
            id: s.id,
            states: SINGLE_STATE as any,
            model: () => ({ type: 'cube' as const, textures: { all: { texture: tex } } }),
            cull: s.cull ?? CullType.SOLID,
            material: s.material ?? MaterialType.OPAQUE,
            lightEmission: s.lightEmission,
            lightOpacity: s.lightOpacity,
        };
        defs.set(s.id, def);
        handles.set(s.id, {
            id: s.id,
            states: SINGLE_STATE,
            _def: def,
            _baseStateId: 0,
            _index: 0,
            totalStates: 1,
            stateId: () => 0,
            defaultId: () => 0,
            stateKey: () => s.id,
            defaultKey: () => s.id,
        });
    }
    return buildBlockRegistry(defs, handles, textures);
}

// stone (solid opaque), glowstone (full RGB emitter, transparent so it
// doesn't block its own light), glass (low-opacity passthrough)
const registry = buildLightRegistry([{ id: 'stone' }, { id: 'glowstone', cull: CullType.NONE, lightEmission: [15, 15, 15] }]);

// ── helpers ─────────────────────────────────────────────────────────

/** create an empty server-tracked voxels instance (sky enabled). */
function blankServerVoxels(): Voxels {
    const v = createVoxels(registry);
    v.authority = createVoxelsAuthority();
    return v;
}

/** ensure every chunk in a [minC..maxC]^3 cube exists (all air). */
function seedChunkCube(v: Voxels, minC: number, maxC: number): void {
    for (let cx = minC; cx <= maxC; cx++)
        for (let cy = minC; cy <= maxC; cy++) for (let cz = minC; cz <= maxC; cz++) ensureChunk(v, cx, cy, cz);
}

/** fill y=0 plane across [minC*CHUNK_SIZE..(maxC+1)*CHUNK_SIZE) with stone. */
function seedFloor(v: Voxels, minC: number, maxC: number): void {
    const lo = minC * CHUNK_SIZE;
    const hi = (maxC + 1) * CHUNK_SIZE;
    for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) setBlock(v, x, 0, z, 'stone', SetBlockFlags.BULK);
}

// ── suite 1: propagateAllLight (rebake-light cost) ──────────────────

describe('propagateAllLight — full recompute', () => {
    bench('1 chunk, all air (sky-only)', () => {
        const v = blankServerVoxels();
        ensureChunk(v, 0, 0, 0);
        propagateAllLight(v);
    });

    bench('4x4x1 chunks (16), all air', () => {
        const v = blankServerVoxels();
        for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) ensureChunk(v, cx, 0, cz);
        propagateAllLight(v);
    });

    bench('4x4x4 chunks (64), all air', () => {
        const v = blankServerVoxels();
        seedChunkCube(v, 0, 3);
        propagateAllLight(v);
    });

    bench('4x4x4 chunks (64), solid floor at y=0', () => {
        const v = blankServerVoxels();
        seedChunkCube(v, 0, 3);
        seedFloor(v, 0, 3);
        propagateAllLight(v);
    });

    bench('4x4x4 chunks (64), single emitter at centre (no sky)', () => {
        const v = blankServerVoxels();
        // wrap a single emitter in a 1-chunk ceiling so sky never reaches it
        // (isolates block-light cost). instead: just place emitter in an
        // otherwise sky-open world, sky still propagates normally, but the
        // emitter adds independent block-light work.
        seedChunkCube(v, 0, 3);
        setBlock(v, 32, 32, 32, 'glowstone', SetBlockFlags.BULK);
        propagateAllLight(v);
    });

    bench('4x4x4 chunks (64), 8 emitters scattered', () => {
        const v = blankServerVoxels();
        seedChunkCube(v, 0, 3);
        const positions: [number, number, number][] = [
            [8, 8, 8],
            [24, 8, 24],
            [40, 8, 40],
            [56, 8, 56],
            [8, 32, 56],
            [56, 32, 8],
            [24, 48, 24],
            [40, 48, 40],
        ];
        for (const [x, y, z] of positions) setBlock(v, x, y, z, 'glowstone', SetBlockFlags.BULK);
        propagateAllLight(v);
    });

    // ── sparsity comparison: same chunk count, different bbox shape ──
    //
    // hypothesis: propagateAllLight's sky-seed walks every (wx,wz) column
    // in the world bbox top-down, *regardless* of whether each chunk
    // actually exists. sparse layouts should scale with bbox volume, not
    // chunk count. the editor's 28ms/chunk vs the dense bench's 2ms/chunk
    // implies a ~14× bbox-to-chunk-count ratio in real scenes.

    bench('SPARSITY — 32 chunks dense (4x4x2, bbox=32)', () => {
        const v = blankServerVoxels();
        for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 4; cz++) ensureChunk(v, cx, cy, cz);
        propagateAllLight(v);
    });

    bench('SPARSITY — 32 chunks flat plane (8x1x4, bbox=32)', () => {
        const v = blankServerVoxels();
        for (let cx = 0; cx < 8; cx++) for (let cz = 0; cz < 4; cz++) ensureChunk(v, cx, 0, cz);
        propagateAllLight(v);
    });

    bench('SPARSITY — 32 chunks, tall bbox (8x4x1 plane + 1 high, bbox=128)', () => {
        // 8×4 plane at cy=0 plus a single chunk at cy=3, same 32 chunks
        // (31 floor + 1 high) but bbox now 8×4×4 = 128 (4× sparser).
        const v = blankServerVoxels();
        for (let cx = 0; cx < 8; cx++) for (let cz = 0; cz < 4; cz++) ensureChunk(v, cx, 0, cz);
        ensureChunk(v, 0, 3, 0);
        propagateAllLight(v);
    });

    bench('SPARSITY — 32 chunks scattered in 4x4x4 (bbox=64, ~2x sparsity)', () => {
        const v = blankServerVoxels();
        // deterministic 50% scatter across a 4×4×4 chunk volume
        let seed = 42;
        const occupied = new Set<string>();
        while (occupied.size < 32) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const cx = seed % 4;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const cy = seed % 4;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const cz = seed % 4;
            const key = `${cx},${cy},${cz}`;
            if (occupied.has(key)) continue;
            occupied.add(key);
            ensureChunk(v, cx, cy, cz);
        }
        propagateAllLight(v);
    });
});

// ── suite 2: flushPendingLight (gameplay incremental) ───────────────
//
// world: 2x2x2 chunks (32x32x32), pre-lit with sky. small enough that
// the setup propagateAllLight stays under ~10ms, so the measurement
// reflects the flush cost rather than setup. each bench builds the
// world fresh, runs the edit + flush, and reports the combined time,
// since setup is identical across iterations of one bench, the
// *relative* cost between benches in this suite is meaningful even
// though absolute numbers include setup.

function prelitWorld(): Voxels {
    const v = blankServerVoxels();
    seedChunkCube(v, 0, 1);
    propagateAllLight(v);
    return v;
}

describe('flushPendingLight — incremental updates', () => {
    bench('baseline: 2x2x2 pre-lit world, no edit (setup-only)', () => {
        prelitWorld();
    });

    bench('place 1 stone in open sky', () => {
        const v = prelitWorld();
        setBlock(v, 8, 8, 8, 'stone', SetBlockFlags.BULK);
        flushPendingLight(v);
    });

    bench('break 1 stone (placed in pre-lit world)', () => {
        const v = prelitWorld();
        setBlock(v, 8, 8, 8, 'stone', SetBlockFlags.BULK);
        flushPendingLight(v);
        setBlock(v, 8, 8, 8, 'air', SetBlockFlags.BULK);
        flushPendingLight(v);
    });

    bench('place 1 emitter (full RGB spread)', () => {
        const v = prelitWorld();
        setBlock(v, 8, 8, 8, 'glowstone', SetBlockFlags.BULK);
        flushPendingLight(v);
    });

    bench('break 1 emitter (full RGB removal)', () => {
        const v = prelitWorld();
        setBlock(v, 8, 8, 8, 'glowstone', SetBlockFlags.BULK);
        flushPendingLight(v);
        setBlock(v, 8, 8, 8, 'air', SetBlockFlags.BULK);
        flushPendingLight(v);
    });

    bench('place 16 stones in a line, one flush', () => {
        const v = prelitWorld();
        for (let i = 0; i < 16; i++) setBlock(v, i, 8, 8, 'stone', SetBlockFlags.BULK);
        flushPendingLight(v);
    });

    bench('place 16 stones in a line, flush per edit', () => {
        const v = prelitWorld();
        for (let i = 0; i < 16; i++) {
            setBlock(v, i, 8, 8, 'stone', SetBlockFlags.BULK);
            flushPendingLight(v);
        }
    });

    bench('random scatter — 64 changes batched', () => {
        const v = prelitWorld();
        let seed = 12345;
        for (let i = 0; i < 64; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const x = seed % 32;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const y = seed % 32;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const z = seed % 32;
            setBlock(v, x, y, z, 'stone', SetBlockFlags.BULK);
        }
        flushPendingLight(v);
    });

    bench('sky-pierce: drop a 1x16 air column through a ceiling', () => {
        // build a ceiling at y=15, then break a 16-tall column through it.
        // worst case for sky cascade, every voxel below the breach relights.
        const v = blankServerVoxels();
        seedChunkCube(v, 0, 1);
        for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) setBlock(v, x, 15, z, 'stone', SetBlockFlags.BULK);
        propagateAllLight(v);
        for (let y = 15; y >= 0; y--) setBlock(v, 16, y, 16, 'air', SetBlockFlags.BULK);
        flushPendingLight(v);
    });
});

// ── suite 3: updateLightBatch direct (skips setBlock overhead) ──────
//
// useful diff: how much of incremental cost is light vs setBlock bookkeeping?

describe('updateLightBatch — direct (no setBlock)', () => {
    bench('1-block batch: place stone', () => {
        const v = prelitWorld();
        // place the block directly via raw setBlock with no change tracking,
        // then hand-craft the LightChange so updateLightBatch is what we measure
        v.authority!.changes.light.blocks.length = 0;
        // overwrite voxel in-place
        const cx = 0,
            cy = 0,
            cz = 0;
        const chunk = v.chunks.get(`${cx},${cy},${cz}`)!;
        const lx = 8,
            ly = 8,
            lz = 8;
        const oldStateId = chunk.palette[chunk.data[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE]!]!;
        setBlock(v, 8, 8, 8, 'stone', SetBlockFlags.BULK);
        v.authority!.changes.light.blocks.length = 0;
        updateLightBatch(v, [{ wx: 8, wy: 8, wz: 8, oldStateId }]);
    });

    bench('16-block batch: stones in a line', () => {
        const v = prelitWorld();
        const changes: { wx: number; wy: number; wz: number; oldStateId: number }[] = [];
        for (let i = 0; i < 16; i++) {
            const chunk = v.chunks.get('0,0,0')!;
            const oldStateId = chunk.palette[chunk.data[i + 8 * CHUNK_SIZE + 8 * CHUNK_SIZE * CHUNK_SIZE]!]!;
            setBlock(v, i, 8, 8, 'stone', SetBlockFlags.BULK);
            changes.push({ wx: i, wy: 8, wz: 8, oldStateId });
        }
        v.authority!.changes.light.blocks.length = 0;
        updateLightBatch(v, changes);
    });
});
