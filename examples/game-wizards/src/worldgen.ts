// worldgen.ts — deterministic procedural terrain for the wizards arena.
//
// hilly grass: a seeded fractal value-noise heightmap, fill stone → dirt →
// grass, with a light surface scatter of plants. fully deterministic from a
// hardcoded SEED, so every room (each round's `rooms.recreate`) rebuilds the
// identical map and both server + client agree.
//
// structures (towers / houses / castle) are deliberately NOT here yet — this
// is the terrain pass only. they'll stamp hand-authored scenes on top later.

import { createVoxelRaycastResult, raycastVoxels, type ScriptContext, setBlock } from 'bongle';
import { blocks } from 'bongle/starter';

// resolved block keys (defaultKey, not raw strings) — matches the working
// performance-terrain example and removes any key-resolution ambiguity.
const STONE = blocks.stone.defaultKey();
const DIRT = blocks.dirt.defaultKey();
const GRASS = blocks.grass.defaultKey();
const LOG = blocks.oakLog.defaultKey();
const LEAVES = blocks.oakLeaves.defaultKey();

// ── tunables ─────────────────────────────────────────────────────────
export const SEED = 1337; // hardcoded — change for a different map

// the arena is a square [0, MAP_SIZE) in x/z. centred play: spawn + homes sit
// at the middle (see MAP_CENTER). y grows up from 0.
export const MAP_SIZE = 128;
export const MAP_CENTER: [number, number] = [MAP_SIZE / 2, MAP_SIZE / 2];

const BASE_HEIGHT = 10; // ground floor — lowest valley surface
const HILL_AMP = 12; // peak-to-valley swing added by the noise
const NOISE_SCALE = 44; // blocks per noise lattice cell — bigger = broader hills
const OCTAVES = 4; // fractal detail layers
const PERSISTENCE = 0.5; // amplitude falloff per octave
const LACUNARITY = 2; // frequency growth per octave

const DIRT_DEPTH = 3; // dirt layers between grass cap and stone

// surface scatter chances (per grass cell), rolled from the same seed.
const SCATTER = [
    { key: blocks.grassPlant1.defaultKey(), chance: 0.06 },
    { key: blocks.grassPlant2.defaultKey(), chance: 0.03 },
    { key: blocks.mushroomRed.defaultKey(), chance: 0.004 },
] as const;

// trees — one candidate per TREE_GRID×TREE_GRID cell (so trunks never touch),
// placed with probability TREE_CHANCE at a hash-jittered spot in the cell.
const TREE_GRID = 10; // cell size in blocks — also the minimum trunk spacing
const TREE_CHANCE = 0.2; // fraction of cells that actually grow a tree
const TREE_MIN_H = 4; // shortest trunk
const TREE_MAX_H = 6; // tallest trunk
const TREE_MARGIN = 3; // keep trunks this far from the map edge (canopy fits)
const SPAWN_CLEAR = 8; // radius around MAP_CENTER kept tree-free for spawns

// ── deterministic noise ──────────────────────────────────────────────
// integer lattice hash → [0,1). pure function of (ix, iz, salt) — no global
// state, so sampling order never affects the result.
function hash2(ix: number, iz: number, salt: number): number {
    let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x85ebca6b) ^ Math.imul(salt | 0, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
}

// quintic smoothstep (Perlin's fade) for C2-continuous interpolation.
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

// bilinearly-interpolated value noise at (x, z) on the integer lattice.
function valueNoise(x: number, z: number, salt: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const u = fade(x - x0);
    const v = fade(z - z0);
    const v00 = hash2(x0, z0, salt);
    const v10 = hash2(x0 + 1, z0, salt);
    const v01 = hash2(x0, z0 + 1, salt);
    const v11 = hash2(x0 + 1, z0 + 1, salt);
    const a = v00 + (v10 - v00) * u;
    const b = v01 + (v11 - v01) * u;
    return a + (b - a) * v;
}

// fractal sum of octaves, normalised to [0,1).
function fbm(x: number, z: number): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < OCTAVES; o++) {
        sum += amplitude * valueNoise(x * frequency, z * frequency, SEED + o * 101);
        norm += amplitude;
        amplitude *= PERSISTENCE;
        frequency *= LACUNARITY;
    }
    return sum / norm;
}

// surface height (top grass y) at a column — the single source of truth for
// where the ground sits, so spawns can snap to it.
export function surfaceHeight(x: number, z: number): number {
    return Math.floor(BASE_HEIGHT + fbm(x / NOISE_SCALE, z / NOISE_SCALE) * HILL_AMP);
}

// ── shared ground util for spawn placement ───────────────────────────
const _groundRay = createVoxelRaycastResult();
// start the downward probe above all terrain + trees, and crucially NOT on a
// chunk boundary: a y that's a multiple of 16 makes the DDA's first exit test
// resolve to t=0 and the ray reports an immediate miss (this is exactly why the
// old y=64 start buried everything once the surface rose above ~1).
const GROUND_PROBE_Y = 200.5;
const GROUND_PROBE_DIST = 260;

// the canonical "what y is the ground at (x, z)?" helper for any spawn
// decision. raycasts down through the live voxels — so it sees trees and
// (later) stamped structures, not just the noise — and returns the surface y.
// falls back to the analytic surface height if the ray finds nothing (off the
// map, or called before terrain exists).
export function groundHeightAt(ctx: ScriptContext, x: number, z: number): number {
    raycastVoxels(_groundRay, ctx.voxels, ctx.voxels.registry, x, GROUND_PROBE_Y, z, 0, -1, 0, GROUND_PROBE_DIST, 0);
    return _groundRay.hit ? _groundRay.py : surfaceHeight(x, z) + 1;
}

// grow one tree at column (bx, bz): an oak trunk rising from the surface with
// a small leaf canopy. trunk height + the canopy shape are deterministic from
// the column + seed, so the forest is identical every run.
function placeTree(voxels: ScriptContext['voxels'], bx: number, bz: number): void {
    const base = surfaceHeight(bx, bz);
    const trunkH = TREE_MIN_H + Math.floor(hash2(bx, bz, SEED ^ 0x7a3) * (TREE_MAX_H - TREE_MIN_H + 1));
    const topY = base + trunkH; // y of the topmost trunk log

    for (let y = base + 1; y <= topY; y++) setBlock(voxels, bx, y, bz, LOG);

    // canopy: two wide layers (radius 2, clipped corners) under two narrow
    // ones, capped by a plus. the trunk column stays clear up to the top log;
    // the very top gets a single leaf above the trunk.
    for (let dy = -2; dy <= 1; dy++) {
        const y = topY + dy;
        const r = dy <= -1 ? 2 : 1;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (dx === 0 && dz === 0 && dy <= 0) continue; // don't bury the trunk
                if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // clip corners
                if (dy === 1 && Math.abs(dx) + Math.abs(dz) > 1) continue; // plus-shaped cap
                setBlock(voxels, bx + dx, y, bz + dz, LEAVES);
            }
        }
    }
}

// ── terrain pass ─────────────────────────────────────────────────────
// fill the whole arena: stone column up to the dirt band, dirt band, grass
// cap, then a scattered plant on top. server-authoritative; the voxel edits
// replicate to clients automatically.
export function generateTerrain(ctx: ScriptContext): void {
    const voxels = ctx.voxels;
    for (let x = 0; x < MAP_SIZE; x++) {
        for (let z = 0; z < MAP_SIZE; z++) {
            const top = surfaceHeight(x, z);
            const dirtFrom = top - DIRT_DEPTH;
            for (let y = 0; y < top; y++) {
                setBlock(voxels, x, y, z, y >= dirtFrom ? DIRT : STONE);
            }
            setBlock(voxels, x, top, z, GRASS);

            // surface scatter — first matching roll wins, so chances don't stack.
            const roll = hash2(x, z, SEED ^ 0x5f5f);
            let acc = 0;
            for (const { key, chance } of SCATTER) {
                acc += chance;
                if (roll < acc) {
                    setBlock(voxels, x, top + 1, z, key);
                    break;
                }
            }
        }
    }

    // forest pass: one hash-jittered candidate per grid cell, grown with
    // probability TREE_CHANCE. the grid guarantees a minimum spacing so trunks
    // never merge.
    for (let cz = 0; cz < MAP_SIZE; cz += TREE_GRID) {
        for (let cx = 0; cx < MAP_SIZE; cx += TREE_GRID) {
            if (hash2(cx, cz, SEED ^ 0x2ee) >= TREE_CHANCE) continue;
            const jx = cx + 1 + Math.floor(hash2(cx, cz, SEED ^ 0x111) * (TREE_GRID - 2));
            const jz = cz + 1 + Math.floor(hash2(cx, cz, SEED ^ 0x222) * (TREE_GRID - 2));
            if (jx < TREE_MARGIN || jx >= MAP_SIZE - TREE_MARGIN || jz < TREE_MARGIN || jz >= MAP_SIZE - TREE_MARGIN) continue;
            // keep the centre spawn clearing free so players/npcs don't spawn in a tree.
            const dxC = jx - MAP_CENTER[0];
            const dzC = jz - MAP_CENTER[1];
            if (dxC * dxC + dzC * dzC < SPAWN_CLEAR * SPAWN_CLEAR) continue;
            placeTree(voxels, jx, jz);
        }
    }

    // TEMP diagnostic — confirms the pass ran + produced non-empty chunks.
    console.log(`[worldgen] terrain done: keys=${STONE}/${DIRT}/${GRASS} chunks=${voxels.chunks.size}`);
}
