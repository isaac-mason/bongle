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
// expose is needed (e.g. `surfaceHeight` on farmland / dirt path).

import { block, blockPreset, CullType, MaterialType } from 'bongle';
import * as soundPreset from './block-sound-presets';
import * as tex from './block-textures';

// ── Ground ──────────────────────────────────────────────────────────

export const stone = blockPreset.cube(
    'kit:stone',
    { all: { texture: tex.stone } },
    {
        name: 'Stone',
        sounds: soundPreset.stone,
    },
);

export const dirt = blockPreset.cube(
    'kit:dirt',
    { all: { texture: tex.dirt } },
    {
        name: 'Dirt',
        sounds: soundPreset.dirt,
    },
);

export const grass = blockPreset.cube(
    'kit:grass',
    { top: { texture: tex.grassTop }, bottom: { texture: tex.dirt }, sides: { texture: tex.grassSide } },
    { name: 'Grass', sounds: soundPreset.grass },
);

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

export const gravel = blockPreset.cube(
    'kit:gravel',
    { all: { texture: tex.gravel } },
    {
        name: 'Gravel',
        sounds: soundPreset.gravel,
    },
);

// ── Stone & cobblestone ─────────────────────────────────────────────
//
// building blocks worked from stone and cobble: the raw cobble cubes plus the
// stairs / slabs / walls / pressure plate for both the stone and cobble lines.

export const cobblestone = blockPreset.cube(
    'kit:cobblestone',
    { all: { texture: tex.cobblestone } },
    {
        name: 'Cobblestone',
        sounds: soundPreset.stone,
    },
);

export const mossyCobblestone = blockPreset.cube(
    'kit:mossy_cobblestone',
    { all: { texture: tex.mossyCobblestone } },
    {
        name: 'Mossy Cobblestone',
        sounds: soundPreset.stone,
    },
);

export const stoneStairs = blockPreset.stairs(
    'kit:stone_stairs',
    { all: { texture: tex.stone } },
    { name: 'Stone Stairs', sounds: soundPreset.stone },
);
export const stoneSlab = blockPreset.slab(
    'kit:stone_slab',
    { all: { texture: tex.stone } },
    { name: 'Stone Slab', sounds: soundPreset.stone },
);
export const stonePlate = blockPreset.plate('kit:stone_plate', tex.stone, {
    name: 'Stone Pressure Plate',
    sounds: soundPreset.stone,
});

export const cobblestoneStairs = blockPreset.stairs(
    'kit:cobblestone_stairs',
    { all: { texture: tex.cobblestone } },
    { name: 'Cobblestone Stairs', sounds: soundPreset.stone },
);
export const cobblestoneSlab = blockPreset.slab(
    'kit:cobblestone_slab',
    { all: { texture: tex.cobblestone } },
    { name: 'Cobblestone Slab', sounds: soundPreset.stone },
);
export const cobblestoneWall = blockPreset.wall(
    'kit:cobblestone_wall',
    { all: { texture: tex.cobblestone } },
    { name: 'Cobblestone Wall', sounds: soundPreset.stone },
);

// ── Oak ─────────────────────────────────────────────────────────────

export const oakPlanks = blockPreset.cube(
    'kit:oak_planks',
    { all: { texture: tex.oakPlanks } },
    {
        name: 'Oak Planks',
        sounds: soundPreset.wood,
    },
);

export const oakLog = blockPreset.column(
    'kit:oak_log',
    { end: tex.oakLogTop, side: tex.oakLogSide },
    { name: 'Oak Log', sounds: soundPreset.wood },
);

export const oakStairs = blockPreset.stairs(
    'kit:oak_stairs',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Stairs', sounds: soundPreset.wood },
);
export const oakSlab = blockPreset.slab(
    'kit:oak_slab',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Slab', sounds: soundPreset.wood },
);
export const oakFence = blockPreset.fence(
    'kit:oak_fence',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Fence', sounds: soundPreset.wood },
);
export const oakTrapdoor = blockPreset.trapdoor(
    'kit:oak_trapdoor',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Trapdoor', sounds: soundPreset.wood },
);

// two-cell door (lower + upper). top/bottom textures reuse oak planks as a
// placeholder until dedicated door art lands. open/close via setDoorOpen.
export const oakDoor = blockPreset.door(
    'kit:oak_door',
    { top: tex.oakPlanks, bottom: tex.oakPlanks },
    { name: 'Oak Door', sounds: soundPreset.wood },
);

export const oakLeaves = blockPreset.leaves(
    'kit:oak_leaves',
    { all: { texture: tex.oakLeaves } },
    { name: 'Oak Leaves', sounds: soundPreset.leaves },
);

// ── Glass ───────────────────────────────────────────────────────────

// full glass cube. transparent (alpha-cutout) like the glass pane, with
// CullType.SELF so a wall of glass culls its internal shared faces and only
// the outer shell draws, adjacent glass reads as one clear pane.
export const glass = blockPreset.cube(
    'kit:glass',
    { all: { texture: tex.glass } },
    {
        name: 'Glass',
        cull: CullType.SELF,
        material: MaterialType.TRANSPARENT,
        sounds: soundPreset.glass,
    },
);

export const glassPane = blockPreset.pane(
    'kit:glass_pane',
    { all: { texture: tex.glass } },
    { name: 'Glass Pane', sounds: soundPreset.glass },
);

// ── Snow ────────────────────────────────────────────────────────────

export const snowBlock = blockPreset.cube(
    'kit:snow_block',
    { all: { texture: tex.snow } },
    {
        name: 'Snow Block',
        sounds: soundPreset.snow,
    },
);

export const snowSlab = blockPreset.slab(
    'kit:snow_slab',
    { all: { texture: tex.snow } },
    { name: 'Snow Slab', sounds: soundPreset.snow },
);

export const snowCarpet = blockPreset.carpet(
    'kit:snow_carpet',
    { all: { texture: tex.snow } },
    { name: 'Snow Carpet', sounds: soundPreset.snow },
);

// ── Ice ─────────────────────────────────────────────────────────────

// slippery. sneakGuard so crouching stops sliding.
export const ice = blockPreset.cube(
    'kit:ice',
    { all: { texture: tex.ice } },
    {
        name: 'Ice',
        friction: 0.1,
        sneakGuard: true,
        sounds: soundPreset.ice,
    },
);

// ── Liquids ─────────────────────────────────────────────────────────

export const water = blockPreset.liquid(
    'kit:water',
    { all: { texture: tex.water } },
    {
        name: 'Water',
        viscosity: 0.5,
        translucent: true,
        levels: 8,
        maxHeight: 15 / 16,
        tint: blockPreset.WATER_DEFAULT_TINT,
        sounds: soundPreset.water,
    },
);

export const lava = blockPreset.liquid(
    'kit:lava',
    { all: { texture: tex.lava } },
    {
        name: 'Lava',
        viscosity: 1.5,
        levels: 8,
        tint: blockPreset.LAVA_DEFAULT_TINT,
        emissive: true,
        lightEmission: [14, 6, 2],
    },
);

// ── Vegetation ──────────────────────────────────────────────────────

export const mushroomRed = blockPreset.plant('kit:mushroom_red', tex.mushroomRed, {
    name: 'Red Mushroom',
    sounds: soundPreset.leaves,
});

export const grassPlant1 = blockPreset.plant('kit:grass_plant_1', tex.grassPlant1, {
    name: 'Grass',
    sounds: soundPreset.leaves,
});

export const grassPlant2 = blockPreset.plant('kit:grass_plant_2', tex.grassPlant2, {
    name: 'Tall Grass',
    sounds: soundPreset.leaves,
});

// minecraft-style short grass: a denser blade tuft on the same cross-quad
// plant preset, kept alongside the existing grass_plant_1/2 sprites.
export const shortGrass = blockPreset.plant('kit:short_grass', tex.shortGrass, {
    name: 'Short Grass',
    sounds: soundPreset.leaves,
});

// ── Light & utility ─────────────────────────────────────────────────

export const ladder = blockPreset.ladder('kit:ladder', tex.ladder, { name: 'Ladder', sounds: soundPreset.wood });

export const torch = blockPreset.torch('kit:torch', tex.torch, { name: 'Torch', sounds: soundPreset.wood });

// rgb variants, same preset, colored-flame texture + custom lightEmission per channel.
export const redTorch = blockPreset.torch('kit:red_torch', tex.redTorch, {
    name: 'Red Torch',
    lightEmission: [15, 0, 0],
    sounds: soundPreset.wood,
});
export const greenTorch = blockPreset.torch('kit:green_torch', tex.greenTorch, {
    name: 'Green Torch',
    lightEmission: [0, 15, 0],
    sounds: soundPreset.wood,
});
export const blueTorch = blockPreset.torch('kit:blue_torch', tex.blueTorch, {
    name: 'Blue Torch',
    lightEmission: [0, 0, 15],
    sounds: soundPreset.wood,
});

// ── Wool ────────────────────────────────────────────────────────────
//
// all 16 dye colors mirroring Minecraft's palette. soft cloth: leaves sounds
// (snappy dig). kept as individual exports so bundlers tree-shake unused colors.
export const woolWhite = blockPreset.cube(
    'kit:wool_white',
    { all: { texture: tex.woolWhite } },
    {
        name: 'White Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolLightGray = blockPreset.cube(
    'kit:wool_light_gray',
    { all: { texture: tex.woolLightGray } },
    {
        name: 'Light Gray Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolGray = blockPreset.cube(
    'kit:wool_gray',
    { all: { texture: tex.woolGray } },
    {
        name: 'Gray Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolBlack = blockPreset.cube(
    'kit:wool_black',
    { all: { texture: tex.woolBlack } },
    {
        name: 'Black Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolBrown = blockPreset.cube(
    'kit:wool_brown',
    { all: { texture: tex.woolBrown } },
    {
        name: 'Brown Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolRed = blockPreset.cube(
    'kit:wool_red',
    { all: { texture: tex.woolRed } },
    {
        name: 'Red Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolOrange = blockPreset.cube(
    'kit:wool_orange',
    { all: { texture: tex.woolOrange } },
    {
        name: 'Orange Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolYellow = blockPreset.cube(
    'kit:wool_yellow',
    { all: { texture: tex.woolYellow } },
    {
        name: 'Yellow Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolLime = blockPreset.cube(
    'kit:wool_lime',
    { all: { texture: tex.woolLime } },
    {
        name: 'Lime Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolGreen = blockPreset.cube(
    'kit:wool_green',
    { all: { texture: tex.woolGreen } },
    {
        name: 'Green Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolCyan = blockPreset.cube(
    'kit:wool_cyan',
    { all: { texture: tex.woolCyan } },
    {
        name: 'Cyan Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolLightBlue = blockPreset.cube(
    'kit:wool_light_blue',
    { all: { texture: tex.woolLightBlue } },
    {
        name: 'Light Blue Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolBlue = blockPreset.cube(
    'kit:wool_blue',
    { all: { texture: tex.woolBlue } },
    {
        name: 'Blue Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolPurple = blockPreset.cube(
    'kit:wool_purple',
    { all: { texture: tex.woolPurple } },
    {
        name: 'Purple Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolMagenta = blockPreset.cube(
    'kit:wool_magenta',
    { all: { texture: tex.woolMagenta } },
    {
        name: 'Magenta Wool',
        sounds: soundPreset.leaves,
    },
);
export const woolPink = blockPreset.cube(
    'kit:wool_pink',
    { all: { texture: tex.woolPink } },
    {
        name: 'Pink Wool',
        sounds: soundPreset.leaves,
    },
);
