// Starter pack block handles.
//
// Textures come from `./block-textures`, sound presets from
// `./block-sound-presets`, pure composition here. Each block is its
// own `export const` so the package index can re-export them as
// `export * as blocks` and bundlers can drop unused declarations.
//
// Blocks are grouped by material family (ground, stone, oak, ...) so adding
// or extending a material is a single contiguous edit. Reach for a
// `blockPreset.*` factory for the shape (cube, stairs, slab, ...) and drop
// down to raw `block()` only when a shape-defining field a preset doesn't
// expose is needed (e.g. `surfaceHeight` on farmland / dirt path). Cube-shaped
// presets take a bare texture as shorthand for "all faces"; pass a full
// per-face map only when the faces differ (grass, logs).

import { block, blockPreset, CullType, MaterialType } from 'bongle';
import * as soundPreset from './block-sound-presets';
import * as tex from './block-textures';

// ── Ground ──────────────────────────────────────────────────────────

export const stone = blockPreset.cube('kit:stone', { name: 'Stone', textures: tex.stone, sounds: soundPreset.stone });

export const dirt = blockPreset.cube('kit:dirt', { name: 'Dirt', textures: tex.dirt, sounds: soundPreset.dirt });

export const grass = blockPreset.cube('kit:grass', {
    name: 'Grass',
    textures: { top: { texture: tex.grassTop }, bottom: { texture: tex.dirt }, sides: { texture: tex.grassSide } },
    sounds: soundPreset.grass,
});

// farmland (tilled dirt) and dirt path (flattened dirt). both sit 1px below a
// full cube via surfaceHeight, the mesher lowers the top quad and clips the
// side quads to match. CullType.NONE so adjacent full blocks still draw their
// faces flush down past the lowered lip (a SOLID cull would over-cull and leave
// a see-through gap); lightOpacity 15 keeps them light-blocking like dirt.
// surfaceHeight is shape-defining and not exposed by blockPreset.cube, so these
// two stay on raw block().
export const farmland = block('kit:farmland', {
    name: 'Farmland',
    model: () => ({
        type: 'cube',
        textures: { top: { texture: tex.farmlandTop }, bottom: { texture: tex.dirt }, sides: { texture: tex.dirt } },
    }),
    surfaceHeight: 15 / 16,
    cull: CullType.NONE,
    lightOpacity: 15,
    sounds: soundPreset.dirt,
});

export const dirtPath = block('kit:dirt_path', {
    name: 'Dirt Path',
    model: () => ({
        type: 'cube',
        textures: { top: { texture: tex.dirtPathTop }, bottom: { texture: tex.dirt }, sides: { texture: tex.dirt } },
    }),
    surfaceHeight: 15 / 16,
    cull: CullType.NONE,
    lightOpacity: 15,
    sounds: soundPreset.dirt,
});

export const gravel = blockPreset.cube('kit:gravel', { name: 'Gravel', textures: tex.gravel, sounds: soundPreset.gravel });

// ── Stone & cobblestone ─────────────────────────────────────────────
//
// building blocks worked from stone and cobble: the raw cobble cubes plus the
// stairs / slabs / walls / pressure plate for both the stone and cobble lines.

export const cobblestone = blockPreset.cube('kit:cobblestone', {
    name: 'Cobblestone',
    textures: tex.cobblestone,
    sounds: soundPreset.stone,
});

export const mossyCobblestone = blockPreset.cube('kit:mossy_cobblestone', {
    name: 'Mossy Cobblestone',
    textures: tex.mossyCobblestone,
    sounds: soundPreset.stone,
});

export const stoneStairs = blockPreset.stairs('kit:stone_stairs', {
    name: 'Stone Stairs',
    textures: tex.stone,
    sounds: soundPreset.stone,
});
export const stoneSlab = blockPreset.slab('kit:stone_slab', {
    name: 'Stone Slab',
    textures: tex.stone,
    sounds: soundPreset.stone,
});
export const stonePlate = blockPreset.plate('kit:stone_plate', {
    name: 'Stone Pressure Plate',
    textures: tex.stone,
    sounds: soundPreset.stone,
});

export const cobblestoneStairs = blockPreset.stairs('kit:cobblestone_stairs', {
    name: 'Cobblestone Stairs',
    textures: tex.cobblestone,
    sounds: soundPreset.stone,
});
export const cobblestoneSlab = blockPreset.slab('kit:cobblestone_slab', {
    name: 'Cobblestone Slab',
    textures: tex.cobblestone,
    sounds: soundPreset.stone,
});
export const cobblestoneWall = blockPreset.wall('kit:cobblestone_wall', {
    name: 'Cobblestone Wall',
    textures: tex.cobblestone,
    sounds: soundPreset.stone,
});

// ── Oak ─────────────────────────────────────────────────────────────

export const oakPlanks = blockPreset.cube('kit:oak_planks', {
    name: 'Oak Planks',
    textures: tex.oakPlanks,
    sounds: soundPreset.wood,
});

export const oakLog = blockPreset.column('kit:oak_log', {
    name: 'Oak Log',
    textures: { end: tex.oakLogTop, side: tex.oakLogSide },
    sounds: soundPreset.wood,
});

export const oakStairs = blockPreset.stairs('kit:oak_stairs', {
    name: 'Oak Stairs',
    textures: tex.oakPlanks,
    sounds: soundPreset.wood,
});
export const oakSlab = blockPreset.slab('kit:oak_slab', {
    name: 'Oak Slab',
    textures: tex.oakPlanks,
    sounds: soundPreset.wood,
});
export const oakFence = blockPreset.fence('kit:oak_fence', {
    name: 'Oak Fence',
    textures: tex.oakPlanks,
    sounds: soundPreset.wood,
});
export const oakTrapdoor = blockPreset.trapdoor('kit:oak_trapdoor', {
    name: 'Oak Trapdoor',
    textures: tex.oakPlanks,
    sounds: soundPreset.wood,
});

// two-cell door (lower + upper). top/bottom textures reuse oak planks as a
// placeholder until dedicated door art lands. open/close via setDoorOpen.
export const oakDoor = blockPreset.door('kit:oak_door', {
    name: 'Oak Door',
    textures: { top: tex.oakPlanks, bottom: tex.oakPlanks },
    sounds: soundPreset.wood,
});

export const oakLeaves = blockPreset.leaves('kit:oak_leaves', {
    name: 'Oak Leaves',
    textures: tex.oakLeaves,
    sounds: soundPreset.leaves,
});

// ── Glass ───────────────────────────────────────────────────────────

// full glass cube. transparent (alpha-cutout) like the glass pane, with
// CullType.SELF so a wall of glass culls its internal shared faces and only
// the outer shell draws, adjacent glass reads as one clear pane.
export const glass = blockPreset.cube('kit:glass', {
    name: 'Glass',
    textures: tex.glass,
    cull: CullType.SELF,
    material: MaterialType.TRANSPARENT,
    sounds: soundPreset.glass,
});

export const glassPane = blockPreset.pane('kit:glass_pane', {
    name: 'Glass Pane',
    textures: tex.glass,
    sounds: soundPreset.glass,
});

// ── Snow ────────────────────────────────────────────────────────────

export const snowBlock = blockPreset.cube('kit:snow_block', {
    name: 'Snow Block',
    textures: tex.snow,
    sounds: soundPreset.snow,
});

export const snowSlab = blockPreset.slab('kit:snow_slab', {
    name: 'Snow Slab',
    textures: tex.snow,
    sounds: soundPreset.snow,
});

export const snowCarpet = blockPreset.carpet('kit:snow_carpet', {
    name: 'Snow Carpet',
    textures: tex.snow,
    sounds: soundPreset.snow,
});

// ── Ice ─────────────────────────────────────────────────────────────

// slippery. sneakGuard so crouching stops sliding.
export const ice = blockPreset.cube('kit:ice', {
    name: 'Ice',
    textures: tex.ice,
    friction: 0.1,
    sneakGuard: true,
    sounds: soundPreset.ice,
});

// ── Liquids ─────────────────────────────────────────────────────────

export const water = blockPreset.liquid('kit:water', {
    name: 'Water',
    textures: tex.water,
    viscosity: 0.5,
    translucent: true,
    levels: 8,
    maxHeight: 15 / 16,
    tint: blockPreset.WATER_DEFAULT_TINT,
    sounds: soundPreset.water,
});

export const lava = blockPreset.liquid('kit:lava', {
    name: 'Lava',
    textures: tex.lava,
    viscosity: 1.5,
    levels: 8,
    tint: blockPreset.LAVA_DEFAULT_TINT,
    emissive: true,
    lightEmission: [14, 6, 2],
});

// ── Vegetation ──────────────────────────────────────────────────────

export const mushroomRed = blockPreset.plant('kit:mushroom_red', {
    name: 'Red Mushroom',
    textures: tex.mushroomRed,
    sounds: soundPreset.leaves,
});

export const grassPlant1 = blockPreset.plant('kit:grass_plant_1', {
    name: 'Grass',
    textures: tex.grassPlant1,
    sounds: soundPreset.leaves,
});

export const grassPlant2 = blockPreset.plant('kit:grass_plant_2', {
    name: 'Tall Grass',
    textures: tex.grassPlant2,
    sounds: soundPreset.leaves,
});

// minecraft-style short grass: a denser blade tuft on the same cross-quad
// plant preset, kept alongside the existing grass_plant_1/2 sprites.
export const shortGrass = blockPreset.plant('kit:short_grass', {
    name: 'Short Grass',
    textures: tex.shortGrass,
    sounds: soundPreset.leaves,
});

// ── Light & utility ─────────────────────────────────────────────────

export const ladder = blockPreset.ladder('kit:ladder', { name: 'Ladder', textures: tex.ladder, sounds: soundPreset.wood });

export const torch = blockPreset.torch('kit:torch', { name: 'Torch', textures: tex.torch, sounds: soundPreset.wood });

// rgb variants, same preset, colored-flame texture + custom lightEmission per channel.
export const redTorch = blockPreset.torch('kit:red_torch', {
    name: 'Red Torch',
    textures: tex.redTorch,
    lightEmission: [15, 0, 0],
    sounds: soundPreset.wood,
});
export const greenTorch = blockPreset.torch('kit:green_torch', {
    name: 'Green Torch',
    textures: tex.greenTorch,
    lightEmission: [0, 15, 0],
    sounds: soundPreset.wood,
});
export const blueTorch = blockPreset.torch('kit:blue_torch', {
    name: 'Blue Torch',
    textures: tex.blueTorch,
    lightEmission: [0, 0, 15],
    sounds: soundPreset.wood,
});

// ── Wool ────────────────────────────────────────────────────────────
//
// all 16 dye colors mirroring Minecraft's palette. soft cloth: leaves sounds
// (snappy dig). kept as individual exports so bundlers tree-shake unused colors.
export const woolWhite = blockPreset.cube('kit:wool_white', {
    name: 'White Wool',
    textures: tex.woolWhite,
    sounds: soundPreset.leaves,
});
export const woolLightGray = blockPreset.cube('kit:wool_light_gray', {
    name: 'Light Gray Wool',
    textures: tex.woolLightGray,
    sounds: soundPreset.leaves,
});
export const woolGray = blockPreset.cube('kit:wool_gray', {
    name: 'Gray Wool',
    textures: tex.woolGray,
    sounds: soundPreset.leaves,
});
export const woolBlack = blockPreset.cube('kit:wool_black', {
    name: 'Black Wool',
    textures: tex.woolBlack,
    sounds: soundPreset.leaves,
});
export const woolBrown = blockPreset.cube('kit:wool_brown', {
    name: 'Brown Wool',
    textures: tex.woolBrown,
    sounds: soundPreset.leaves,
});
export const woolRed = blockPreset.cube('kit:wool_red', {
    name: 'Red Wool',
    textures: tex.woolRed,
    sounds: soundPreset.leaves,
});
export const woolOrange = blockPreset.cube('kit:wool_orange', {
    name: 'Orange Wool',
    textures: tex.woolOrange,
    sounds: soundPreset.leaves,
});
export const woolYellow = blockPreset.cube('kit:wool_yellow', {
    name: 'Yellow Wool',
    textures: tex.woolYellow,
    sounds: soundPreset.leaves,
});
export const woolLime = blockPreset.cube('kit:wool_lime', {
    name: 'Lime Wool',
    textures: tex.woolLime,
    sounds: soundPreset.leaves,
});
export const woolGreen = blockPreset.cube('kit:wool_green', {
    name: 'Green Wool',
    textures: tex.woolGreen,
    sounds: soundPreset.leaves,
});
export const woolCyan = blockPreset.cube('kit:wool_cyan', {
    name: 'Cyan Wool',
    textures: tex.woolCyan,
    sounds: soundPreset.leaves,
});
export const woolLightBlue = blockPreset.cube('kit:wool_light_blue', {
    name: 'Light Blue Wool',
    textures: tex.woolLightBlue,
    sounds: soundPreset.leaves,
});
export const woolBlue = blockPreset.cube('kit:wool_blue', {
    name: 'Blue Wool',
    textures: tex.woolBlue,
    sounds: soundPreset.leaves,
});
export const woolPurple = blockPreset.cube('kit:wool_purple', {
    name: 'Purple Wool',
    textures: tex.woolPurple,
    sounds: soundPreset.leaves,
});
export const woolMagenta = blockPreset.cube('kit:wool_magenta', {
    name: 'Magenta Wool',
    textures: tex.woolMagenta,
    sounds: soundPreset.leaves,
});
export const woolPink = blockPreset.cube('kit:wool_pink', {
    name: 'Pink Wool',
    textures: tex.woolPink,
    sounds: soundPreset.leaves,
});
