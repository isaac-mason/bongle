// performance: translucent blocks.
//
// A worst-case stress world for the translucent GPU pipeline (global stable
// radix sort plus alpha-blended draw). Four stations, each targeting a
// different cost centre:
//
//   A. Solid checker monolith. A 3D checkerboard of two alternating glass
//      colours. CullType.SELF only culls same-type neighbours, so every
//      internal face survives on both sides: size cubed times 6 quads (48
//      cubed is about 660k), none greedy-mergeable because the textures
//      alternate, about 24k quads per section. This stresses expand and
//      radix N, coincident-interface tie-breaking at scale, and fill-rate
//      overdraw with dozens of blended layers per pixel.
//
//   B. Sparse lattice. Glass at every other cell with air between. No
//      coincident faces at all; every quad sits at a distinct depth: size
//      cubed over 2, times 6 quads. This stresses pure sort ordering and
//      blend churn without ties.
//
//   C. Ocean and glass forest. A broad two-level water pool with a grid of
//      glass pillars standing in it. Big greedy-merged surface quads, a
//      step-down riser seam, and the water-to-glass coincident-interface
//      case (the historical flicker reproducer) at scale.
//
//   D. Nested shells. Concentric alternating-colour hollow shells: deep
//      stacks of parallel translucent layers along every view ray.
//
// The churn trait (off by default) recolours random monolith cells every tick.
// Continuous remesh plus translucent arena churn makes the sort's arena-dirty
// gate fire every frame even with a static camera. Crank it to profile the
// gated path under sustained invalidation.
//
// Size controls apply on room restart, since generation runs in onInit.

import {
    block,
    blockTexture,
    CullType,
    control,
    draw,
    env,
    getTrait,
    MaterialType,
    matchmaking,
    onInit,
    onJoin,
    onTick,
    prop,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
} from 'bongle';
import { blockSoundPresets, blocks } from 'bongle/kit';

matchmaking({ maxPlayers: 4 });

const { stone: Stone, water: Water } = blocks;
const stoneKey = Stone.defaultKey();

// Translucent stained glass, the same recipe as examples/blocks. These are
// alpha-blended cubes, and CullType.SELF so only same-colour neighbours cull.
const stainedGlass = (id: string, r: number, g: number, b: number) => {
    const tex = blockTexture(id, {
        src: draw(
            (c, _inputs, params) => {
                const packed = params.rgb as number;
                const pr = (packed >> 16) & 0xff;
                const pg = (packed >> 8) & 0xff;
                const pb = packed & 0xff;
                c.fillStyle = `rgba(${pr}, ${pg}, ${pb}, 0.5)`;
                c.fillRect(0, 0, 16, 16);
                c.fillStyle = `rgba(${pr}, ${pg}, ${pb}, 0.85)`;
                c.fillRect(0, 0, 16, 1);
                c.fillRect(0, 15, 16, 1);
                c.fillRect(0, 0, 1, 16);
                c.fillRect(15, 0, 1, 16);
            },
            { size: [16, 16], params: { rgb: (r << 16) | (g << 8) | b } },
        ),
    });
    return block(id, {
        model: () => ({ type: 'cube', textures: { all: { texture: tex } } }),
        cull: CullType.SELF,
        material: MaterialType.TRANSLUCENT,
        sounds: blockSoundPresets.glass,
    });
};

const GlassRed = stainedGlass('perf:glass_red', 220, 60, 60);
const GlassBlue = stainedGlass('perf:glass_blue', 70, 110, 230);
const GlassGreen = stainedGlass('perf:glass_green', 60, 200, 90);
const GlassAmber = stainedGlass('perf:glass_amber', 235, 175, 60);

const redKey = GlassRed.defaultKey();
const blueKey = GlassBlue.defaultKey();
const greenKey = GlassGreen.defaultKey();
const amberKey = GlassAmber.defaultKey();

// Station layout in world XZ, with spawn at the origin.
//   A monolith:  x in [-size/2, size/2), z in [40, 40+size)
//   B lattice:   x in [-size/2, size/2), z in [-40-size, -40)
//   C ocean:     centred on x = +120
//   D shells:    centred on x = -120

const OCEAN_X = 120;
const SHELLS_X = -120;

const GroundTrait = trait('ground', {
    /** half-extent of the central stone floor slab */
    half: 110,
});

script(GroundTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        const half = ctx.trait.half;
        for (let x = -half; x <= half; x++) {
            for (let z = -half; z <= half; z++) {
                setBlock(ctx.voxels, x, 0, z, stoneKey);
            }
        }
        // extend under the offset ocean station.
        for (let x = OCEAN_X - 52; x <= OCEAN_X + 52; x++) {
            for (let z = -52; z <= 52; z++) {
                setBlock(ctx.voxels, x, 0, z, stoneKey);
            }
        }
    });
});

// A: solid checker monolith.
const MonolithTrait = trait('monolith', {
    /** cube edge length in blocks. quads are about size cubed times 6 (48 gives about 660k). */
    size: 48,
});

control(MonolithTrait, 'size', {
    label: 'Monolith size (restart to apply)',
    schema: prop.number(),
    get: (t) => t.size,
    set: (t, v) => {
        t.size = Math.max(2, Math.floor(v));
    },
});

script(MonolithTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        const size = ctx.trait.size;
        const half = size >> 1;
        for (let x = -half; x < size - half; x++) {
            for (let y = 1; y <= size; y++) {
                for (let z = 40; z < 40 + size; z++) {
                    setBlock(ctx.voxels, x, y, z, (x + y + z) % 2 === 0 ? redKey : blueKey);
                }
            }
        }
    });
});

// B: sparse lattice.
const LatticeTrait = trait('lattice', {
    /** cube edge length in blocks. quads are about size cubed over 2, times 6 (48 gives about 330k). */
    size: 48,
});

control(LatticeTrait, 'size', {
    label: 'Lattice size (restart to apply)',
    schema: prop.number(),
    get: (t) => t.size,
    set: (t, v) => {
        t.size = Math.max(2, Math.floor(v));
    },
});

script(LatticeTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        const size = ctx.trait.size;
        const half = size >> 1;
        for (let x = -half; x < size - half; x++) {
            for (let y = 1; y <= size; y++) {
                for (let z = -40 - size; z < -40; z++) {
                    // JS % keeps sign: use a mask-safe parity test for negatives.
                    if (((x + y + z) & 1) !== 0) continue; // air between cells
                    setBlock(ctx.voxels, x, y, z, greenKey);
                }
            }
        }
    });
});

// C: ocean and glass forest.
const OceanTrait = trait('ocean', {
    /** half-extent of the pool on X/Z, so the final span is 2*half */
    half: 48,
    /** water depth in blocks */
    depth: 4,
    /** glass pillar grid pitch in blocks; 0 disables the forest */
    pillarPitch: 6,
});

control(OceanTrait, 'half', {
    label: 'Ocean half-extent (restart to apply)',
    schema: prop.number(),
    get: (t) => t.half,
    set: (t, v) => {
        t.half = Math.max(4, Math.floor(v));
    },
});

control(OceanTrait, 'pillarPitch', {
    label: 'Pillar pitch (0 = none, restart to apply)',
    schema: prop.number(),
    get: (t) => t.pillarPitch,
    set: (t, v) => {
        t.pillarPitch = Math.max(0, Math.floor(v));
    },
});

script(OceanTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        const half = ctx.trait.half;
        const depth = ctx.trait.depth;
        const pitch = ctx.trait.pillarPitch;
        for (let x = -half; x < half; x++) {
            for (let z = -half; z < half; z++) {
                const wx = OCEAN_X + x;
                // Two surface levels split down the middle give a step-down
                // riser seam across the whole pool, with full-height water below.
                const surface = z < 0 ? Water.level(8) : Water.level(4);
                for (let y = 1; y <= depth; y++) {
                    setBlock(ctx.voxels, wx, y, z, y === depth ? surface : Water.level(8));
                }
            }
        }
        if (pitch > 0) {
            // Glass pillars standing through the water: submerged coincident
            // water-to-glass interfaces, and pillars breaking the merged surface.
            for (let x = -half + 2; x < half - 1; x += pitch) {
                for (let z = -half + 2; z < half - 1; z += pitch) {
                    for (let y = 1; y <= depth + 2; y++) {
                        setBlock(ctx.voxels, OCEAN_X + x, y, z, amberKey);
                    }
                }
            }
        }
    });
});

// D: nested shells.
const ShellsTrait = trait('shells', {
    /** number of concentric hollow shells, with radii 2, 4, 6, and so on */
    count: 10,
});

control(ShellsTrait, 'count', {
    label: 'Shell count (restart to apply)',
    schema: prop.number(),
    get: (t) => t.count,
    set: (t, v) => {
        t.count = Math.max(1, Math.floor(v));
    },
});

script(ShellsTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        const count = ctx.trait.count;
        const cy = 2 * count + 3;
        for (let s = 0; s < count; s++) {
            const r = 2 * (s + 1);
            const key = s % 2 === 0 ? redKey : blueKey;
            for (let x = -r; x <= r; x++) {
                for (let y = -r; y <= r; y++) {
                    for (let z = -r; z <= r; z++) {
                        // hollow box shell: any coordinate on the surface.
                        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== r) continue;
                        const wy = cy + y;
                        if (wy < 1) continue;
                        setBlock(ctx.voxels, SHELLS_X + x, wy, z, key);
                    }
                }
            }
        }
    });
});

// Churn: continuous translucent invalidation.
const ChurnTrait = trait('churn', {
    /** monolith cells recoloured per tick (0 = off). Each swap dirties its
     *  chunk, forcing a remesh and translucent arena churn, so the sort's
     *  arena-dirty gate fires every frame even with a static camera. */
    swapsPerTick: 0,
});

control(ChurnTrait, 'swapsPerTick', {
    label: 'Glass swaps per tick',
    schema: prop.number(),
    get: (t) => t.swapsPerTick,
    set: (t, v) => {
        t.swapsPerTick = Math.max(0, Math.floor(v));
    },
});

script(ChurnTrait, 'tick', (ctx) => {
    if (!env.server) return;
    onTick(ctx, () => {
        const k = ctx.trait.swapsPerTick;
        if (k <= 0) return;
        // Recolour random cells inside the monolith footprint. This keeps the
        // quad count roughly stable while forcing a remesh and arena realloc.
        const size = 48;
        const half = size >> 1;
        for (let i = 0; i < k; i++) {
            const x = -half + Math.floor(Math.random() * size);
            const y = 1 + Math.floor(Math.random() * size);
            const z = 40 + Math.floor(Math.random() * size);
            setBlock(ctx.voxels, x, y, z, Math.random() < 0.5 ? redKey : blueKey);
        }
    });
});

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;
    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        // spawn high above the origin with every station in view range.
        setPosition(transform, [0, 70, 0]);
    });
});
