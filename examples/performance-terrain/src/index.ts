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
    control,
    env,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    prop,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
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

type Voxels = Parameters<typeof setBlock>[0];

/** a tree: log trunk + a rounded leaf canopy, bounds-guarded at the map edge. */
function placeTree(voxels: Voxels, x: number, z: number, groundY: number, lo: number, hi: number): void {
    const trunk = 4 + Math.floor(hash2(x * 7, z * 13) * 3); // 4..6
    const topY = groundY + trunk;
    for (let y = groundY + 1; y <= topY; y++) setBlock(voxels, x, y, z, log);
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
                setBlock(voxels, cx, topY + dy, cz, leaves);
            }
        }
    }
    setBlock(voxels, x, topY + 1, z, leaves);
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
            setBlock(voxels, x, floorY, z, planks); // floor
            if (!edge) continue;
            for (let y = 1; y <= wallH; y++) {
                if (dz === -half && dx === 0 && y <= 2) continue; // doorway in the −Z wall
                const isWindow = !corner && y % 4 === 2 && (dx + dz) % 2 === 0;
                setBlock(voxels, x, floorY + y, z, corner ? log : isWindow ? glass : wallMat);
            }
        }
    }
    // flat roof one block proud of the walls.
    for (let dx = -half - 1; dx <= half + 1; dx++) {
        for (let dz = -half - 1; dz <= half + 1; dz++) {
            setBlock(voxels, cx + dx, floorY + wallH + 1, cz + dz, seed % 2 === 0 ? mossy : planks);
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
    const voxels = ctx.voxels;

    onInit(ctx, () => {
        const size = ctx.trait.size;
        const lo = -(size >> 1);
        const hi = lo + size - 1;
        const treeChance = ctx.trait.treePerMille / 1000;

        // ── terrain columns + water + trees ──
        for (let x = lo; x <= hi; x++) {
            for (let z = lo; z <= hi; z++) {
                const h = terrainHeight(x, z);
                const beach = h <= WATER_LEVEL + 1;
                const snowy = h >= SNOW_LINE;
                const top = snowy ? snow : beach ? gravel : grass;
                for (let y = 0; y <= h; y++) {
                    const key = y === h ? top : y >= h - 3 && !beach && !snowy ? dirt : stone;
                    setBlock(voxels, x, y, z, key);
                }
                if (h < WATER_LEVEL) {
                    for (let y = h + 1; y <= WATER_LEVEL; y++) setBlock(voxels, x, y, z, water);
                }
                // trees on exposed grass, kept clear of the map edge for canopy.
                if (top === grass && x > lo + 2 && x < hi - 2 && z > lo + 2 && z < hi - 2 && hash2(x * 3, z * 5) < treeChance) {
                    placeTree(voxels, x, z, h, lo, hi);
                }
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
    if (!env.server) return;
    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        // high central vantage over the whole map (peaks reach ~60).
        setPosition(transform, [0, 72, 0]);
    });
});
