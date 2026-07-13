// ── performance: terrain ────────────────────────────────────────────
//
// A 512×64×512 world with rolling hills, lakes, forests and scattered
// buildings — high geometric variance across every voxel render path:
//   opaque      stone / dirt / grass / gravel / snow / cobblestone / planks /
//               logs / wool (varied palette, lots of surface material changes)
//   transparent glass windows + leaf canopies (alpha-cutout)
//   translucent lake water (the back-to-front sorted pass)
// so it exercises streaming, culling, meshing and all three draw passes at
// map scale. Generation is deterministic (hash noise, no RNG) so runs are
// reproducible for A/B perf comparisons. `size` etc. are trait controls,
// applied on room restart.

import {
    CHUNK_SIZE,
    chunkData,
    control,
    ENVIRONMENT_OVERWORLD,
    ensureChunk,
    ensureChunkPaletteSlot,
    env,
    getTrait,
    invalidateChunk,
    matchmaking,
    onInit,
    onJoin,
    prop,
    SetBlockFlags,
    script,
    setBlock,
    setEnvironment,
    setPosition,
    TransformTrait,
    trait,
    type Voxels,
    voxelIndex,
} from 'bongle';
import { blocks } from 'bongle/starter';

matchmaking({ maxPlayers: 4 });

const stone = blocks.stone.defaultKey();
const dirt = blocks.dirt.defaultKey();
const grass = blocks.grass.defaultKey();
const gravel = blocks.gravel.defaultKey();
const snow = blocks.snowBlock.defaultKey();
const cobble = blocks.cobblestone.defaultKey();
const mossy = blocks.mossyCobblestone.defaultKey();
const planks = blocks.oakPlanks.defaultKey();
const log = blocks.oakLog.defaultKey();
const leaves = blocks.oakLeaves.defaultKey();
const glass = blocks.glass.defaultKey();
const water = blocks.water.defaultKey();
const wool = [
    blocks.woolRed,
    blocks.woolOrange,
    blocks.woolYellow,
    blocks.woolGreen,
    blocks.woolBlue,
    blocks.woolPurple,
    blocks.woolWhite,
].map((w) => w.defaultKey());

const WATER_LEVEL = 14;
const SNOW_LINE = 44;
const BASE_HEIGHT = 18;

// deterministic 2D hash in [0, 1) — the RNG-free noise source.
function hash2(x: number, z: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// multi-octave rolling terrain height, clamped to the 64-tall world.
function terrainHeight(x: number, z: number): number {
    let h = BASE_HEIGHT;
    h += Math.sin(x * 0.03) * Math.cos(z * 0.035) * 12; // broad hills
    h += Math.sin(x * 0.09 + 1.3) * Math.sin(z * 0.08 + 2.1) * 5; // medium
    h += Math.sin(x * 0.21 + 4.2) * Math.cos(z * 0.19 + 0.7) * 2.5; // bumps
    h += (hash2(x, z) - 0.5) * 2; // fine roughness
    return Math.max(2, Math.min(60, Math.floor(h)));
}

// features (trees, buildings) cross chunk boundaries, so they author by world
// coordinate through setBlock with the BULK flag: skips inline hooks and defers
// light to the same scoped relight the terrain fill schedules.
const BULK = SetBlockFlags.BULK;

/** a tree: log trunk + a rounded leaf canopy, bounds-guarded at the map edge. */
function placeTree(voxels: Voxels, x: number, z: number, groundY: number, lo: number, hi: number): void {
    const trunk = 4 + Math.floor(hash2(x * 7, z * 13) * 3); // 4..6
    const topY = groundY + trunk;
    for (let y = groundY + 1; y <= topY; y++) setBlock(voxels, x, y, z, log, BULK);
    // canopy: 5×5 lower rings tapering to a 3×3 cap.
    for (let dy = -2; dy <= 1; dy++) {
        const r = dy >= 0 ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (dx === 0 && dz === 0 && dy < 1) continue; // trunk core
                if (Math.abs(dx) === r && Math.abs(dz) === r && hash2(x + dx, z + dz) < 0.5) continue; // ragged corners
                const cx = x + dx;
                const cz = z + dz;
                if (cx < lo || cx > hi || cz < lo || cz > hi) continue;
                setBlock(voxels, cx, topY + dy, cz, leaves, BULK);
            }
        }
    }
    setBlock(voxels, x, topY + 1, z, leaves, BULK);
}

/** a small building: walls of one material with glass windows, corner logs, a
 *  doorway gap and a plank floor, sitting on the flattest footing corner. */
function placeBuilding(voxels: Voxels, cx: number, cz: number, floorY: number, seed: number): void {
    const half = 3 + (seed % 2); // 3 or 4 → 7×7 or 9×9
    const floors = 1 + (seed % 3); // 1..3
    const wallH = floors * 4;
    const wallMat = seed % 3 === 0 ? cobble : seed % 3 === 1 ? planks : wool[seed % wool.length]!;

    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) {
            const x = cx + dx;
            const z = cz + dz;
            const edge = Math.abs(dx) === half || Math.abs(dz) === half;
            const corner = Math.abs(dx) === half && Math.abs(dz) === half;
            setBlock(voxels, x, floorY, z, planks, BULK); // floor
            if (!edge) continue;
            for (let y = 1; y <= wallH; y++) {
                if (dz === -half && dx === 0 && y <= 2) continue; // doorway in the −Z wall
                const isWindow = !corner && y % 4 === 2 && (dx + dz) % 2 === 0;
                setBlock(voxels, x, floorY + y, z, corner ? log : isWindow ? glass : wallMat, BULK);
            }
        }
    }
    // flat roof one block proud of the walls.
    for (let dx = -half - 1; dx <= half + 1; dx++) {
        for (let dz = -half - 1; dz <= half + 1; dz++) {
            setBlock(voxels, cx + dx, floorY + wallH + 1, cz + dz, seed % 2 === 0 ? mossy : planks, BULK);
        }
    }
}

const TerrainTrait = trait('terrain', {
    /** map footprint on X/Z (blocks). 512 = 32×32 chunks. */
    size: 512,
    /** grass columns that sprout a tree, per mille (‰). */
    treePerMille: 12,
    /** coarse building-grid cells that get a building, percent. */
    buildingPercent: 45,
});

control(TerrainTrait, 'size', {
    label: 'Map size (restart to apply)',
    schema: prop.number(),
    get: (t) => t.size,
    set: (t, v) => {
        t.size = Math.max(16, Math.floor(v));
    },
});
control(TerrainTrait, 'treePerMille', {
    label: 'Tree density (‰, restart)',
    schema: prop.number(),
    get: (t) => t.treePerMille,
    set: (t, v) => {
        t.treePerMille = Math.max(0, Math.floor(v));
    },
});
control(TerrainTrait, 'buildingPercent', {
    label: 'Building density (%, restart)',
    schema: prop.number(),
    get: (t) => t.buildingPercent,
    set: (t, v) => {
        t.buildingPercent = Math.max(0, Math.min(100, Math.floor(v)));
    },
});

script(TerrainTrait, 'generate', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const voxels = ctx.voxels;
        const size = ctx.trait.size;
        const lo = -(size >> 1);
        const hi = lo + size - 1;
        const treeChance = ctx.trait.treePerMille / 1000;

        // ── terrain + water: per-chunk tier-1 fill ──
        //
        // resolve each chunk once, grab its palette slots once, and write voxel
        // data straight into the chunk's typed array; `invalidateChunk` then
        // reconciles counts + schedules the scoped relight. this skips the
        // per-block chunk-key lookup + op + light-queue work entirely — the
        // meat of the speedup.
        const ccLo = lo >> 4;
        const ccHi = hi >> 4;
        for (let cx = ccLo; cx <= ccHi; cx++) {
            for (let cz = ccLo; cz <= ccHi; cz++) {
                // precompute this chunk column's 16×16 heights + surface once.
                const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
                const surface = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE); // 0 grass, 1 snow, 2 gravel
                let columnTop = WATER_LEVEL;
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const wx = (cx << 4) + lx;
                        const wz = (cz << 4) + lz;
                        if (wx < lo || wx > hi || wz < lo || wz > hi) {
                            heights[lz * CHUNK_SIZE + lx] = -1; // outside the map → air column
                            continue;
                        }
                        const h = terrainHeight(wx, wz);
                        heights[lz * CHUNK_SIZE + lx] = h;
                        surface[lz * CHUNK_SIZE + lx] = h >= SNOW_LINE ? 1 : h <= WATER_LEVEL + 1 ? 2 : 0;
                        if (h > columnTop) columnTop = h;
                    }
                }

                for (let cy = 0; cy <= columnTop >> 4; cy++) {
                    const chunk = ensureChunk(voxels, cx, cy, cz);
                    const data = chunkData(chunk);
                    const sStone = ensureChunkPaletteSlot(chunk, stone, voxels.registry);
                    const sDirt = ensureChunkPaletteSlot(chunk, dirt, voxels.registry);
                    const sGrass = ensureChunkPaletteSlot(chunk, grass, voxels.registry);
                    const sSnow = ensureChunkPaletteSlot(chunk, snow, voxels.registry);
                    const sGravel = ensureChunkPaletteSlot(chunk, gravel, voxels.registry);
                    const sWater = ensureChunkPaletteSlot(chunk, water, voxels.registry);
                    const baseY = cy << 4;
                    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                            const col = lz * CHUNK_SIZE + lx;
                            const h = heights[col]!;
                            if (h < 0) continue;
                            const snowy = surface[col] === 1;
                            const beach = surface[col] === 2;
                            const topSlot = snowy ? sSnow : beach ? sGravel : sGrass;
                            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                                const wy = baseY + ly;
                                let slot = -1;
                                if (wy < h) slot = wy >= h - 3 && !beach && !snowy ? sDirt : sStone;
                                else if (wy === h) slot = topSlot;
                                else if (h < WATER_LEVEL && wy <= WATER_LEVEL) slot = sWater;
                                if (slot >= 0) data[voxelIndex(lx, ly, lz)] = slot;
                            }
                        }
                    }
                    invalidateChunk(voxels, chunk);
                }
            }
        }

        // ── trees on exposed grass (canopies cross chunk boundaries) ──
        for (let x = lo + 3; x < hi - 2; x++) {
            for (let z = lo + 3; z < hi - 2; z++) {
                const h = terrainHeight(x, z);
                const exposed = h < SNOW_LINE && h > WATER_LEVEL + 1; // grass surface
                if (exposed && hash2(x * 3, z * 5) < treeChance) placeTree(voxels, x, z, h, lo, hi);
            }
        }

        // ── scattered buildings on a coarse jittered grid ──
        const PITCH = 22;
        const chance = ctx.trait.buildingPercent / 100;
        for (let gx = lo + PITCH; gx < hi - PITCH; gx += PITCH) {
            for (let gz = lo + PITCH; gz < hi - PITCH; gz += PITCH) {
                if (hash2(gx, gz) > chance) continue;
                const cx = gx + Math.floor((hash2(gx, gz * 2) - 0.5) * 8);
                const cz = gz + Math.floor((hash2(gx * 2, gz) - 0.5) * 8);
                // require a flat, dry footing so buildings don't bury in a hillside.
                const h0 = terrainHeight(cx - 4, cz - 4);
                const h1 = terrainHeight(cx + 4, cz + 4);
                const h2 = terrainHeight(cx - 4, cz + 4);
                const h3 = terrainHeight(cx + 4, cz - 4);
                const minH = Math.min(h0, h1, h2, h3);
                const maxH = Math.max(h0, h1, h2, h3);
                if (minH <= WATER_LEVEL + 1 || maxH - minH > 3 || maxH >= SNOW_LINE) continue;
                placeBuilding(voxels, cx, cz, maxH, Math.floor(hash2(gx * 5, gz * 7) * 997));
            }
        }
    });
});

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (env.client) {
        // overworld sky: LUT gradient + sun/moon/star billboards + drifting clouds.
        setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
    }
    if (env.server) {
        onJoin(ctx, ({ playerNode }) => {
            const transform = getTrait(playerNode, TransformTrait)!;
            // high central vantage over the whole map (peaks reach ~60).
            setPosition(transform, [0, 72, 0]);
        });
    }
});
