// Starter pack block handles.
//
// Textures come from `./block-textures`, sound presets from
// `./block-sound-presets` — pure composition here. Each block is its
// own `export const` so the package index can re-export them as
// `export * as blocks` and bundlers can drop unused declarations.

import { block, blockPreset } from 'bongle';
import * as soundPreset from './block-sound-presets';
import * as tex from './block-textures';

export const stone = block('starter:stone', {
    name: 'Stone',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.stone } } }),
    sounds: soundPreset.stone,
});

export const dirt = block('starter:dirt', {
    name: 'Dirt',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.dirt } } }),
    sounds: soundPreset.dirt,
});

export const grass = block('starter:grass', {
    name: 'Grass',
    model: () => ({
        type: 'cube',
        textures: { top: { texture: tex.grassTop }, bottom: { texture: tex.dirt }, sides: { texture: tex.grassSide } },
    }),
    sounds: soundPreset.grass,
});

export const cobblestone = block('starter:cobblestone', {
    name: 'Cobblestone',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.cobblestone } } }),
    sounds: soundPreset.stone,
});

export const oakPlanks = block('starter:oak_planks', {
    name: 'Oak Planks',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.oakPlanks } } }),
    sounds: soundPreset.wood,
});

export const oakLog = blockPreset.column(
    'starter:oak_log',
    { end: tex.oakLogTop, side: tex.oakLogSide },
    { name: 'Oak Log', sounds: soundPreset.wood },
);

// slippery. sneakGuard so crouching stops sliding.
export const ice = block('starter:ice', {
    name: 'Ice',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.ice } } }),
    friction: 0.1,
    sneakGuard: true,
    sounds: soundPreset.ice,
});

export const stoneStairs = blockPreset.stairs(
    'starter:stone_stairs',
    { all: { texture: tex.stone } },
    { name: 'Stone Stairs', sounds: soundPreset.stone },
);
export const oakStairs = blockPreset.stairs(
    'starter:oak_stairs',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Stairs', sounds: soundPreset.wood },
);
export const stoneSlab = blockPreset.slab(
    'starter:stone_slab',
    { all: { texture: tex.stone } },
    { name: 'Stone Slab', sounds: soundPreset.stone },
);
export const oakSlab = blockPreset.slab(
    'starter:oak_slab',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Slab', sounds: soundPreset.wood },
);
export const cobblestoneWall = blockPreset.wall(
    'starter:cobblestone_wall',
    { all: { texture: tex.cobblestone } },
    { name: 'Cobblestone Wall', sounds: soundPreset.stone },
);
export const glassPane = blockPreset.pane(
    'starter:glass_pane',
    { all: { texture: tex.glass } },
    { name: 'Glass Pane', sounds: soundPreset.glass },
);
export const snowCarpet = blockPreset.carpet(
    'starter:snow_carpet',
    { all: { texture: tex.snow } },
    { name: 'Snow Carpet', sounds: soundPreset.snow },
);
export const oakTrapdoor = blockPreset.trapdoor(
    'starter:oak_trapdoor',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Trapdoor', sounds: soundPreset.wood },
);
// two-cell door (lower + upper). top/bottom textures reuse oak planks as a
// placeholder until dedicated door art lands. open/close via setDoorOpen.
export const oakDoor = blockPreset.door(
    'starter:oak_door',
    { top: tex.oakPlanks, bottom: tex.oakPlanks },
    { name: 'Oak Door', sounds: soundPreset.wood },
);
export const stonePlate = blockPreset.plate('starter:stone_plate', tex.stone, {
    name: 'Stone Pressure Plate',
    sounds: soundPreset.stone,
});
export const mushroomRed = blockPreset.plant('starter:mushroom_red', tex.mushroomRed, {
    name: 'Red Mushroom',
    sounds: soundPreset.leaves,
});
export const grassPlant1 = blockPreset.plant('starter:grass_plant_1', tex.grassPlant1, {
    name: 'Grass',
    sounds: soundPreset.leaves,
});
export const grassPlant2 = blockPreset.plant('starter:grass_plant_2', tex.grassPlant2, {
    name: 'Tall Grass',
    sounds: soundPreset.leaves,
});
export const oakLeaves = blockPreset.leaves(
    'starter:oak_leaves',
    { all: { texture: tex.oakLeaves } },
    { name: 'Oak Leaves', sounds: soundPreset.leaves },
);

export const lava = blockPreset.liquid(
    'starter:lava',
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

export const water = blockPreset.liquid(
    'starter:water',
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

export const ladder = blockPreset.ladder('starter:ladder', tex.ladder, { name: 'Ladder', sounds: soundPreset.wood });
export const oakFence = blockPreset.fence(
    'starter:oak_fence',
    { all: { texture: tex.oakPlanks } },
    { name: 'Oak Fence', sounds: soundPreset.wood },
);
export const torch = blockPreset.torch('starter:torch', tex.oakPlanks, { name: 'Torch', sounds: soundPreset.wood });

// rgb variants — same preset, custom lightEmission per channel.
export const redTorch = blockPreset.torch('starter:red_torch', tex.oakPlanks, {
    name: 'Red Torch',
    lightEmission: [15, 0, 0],
    sounds: soundPreset.wood,
});
export const greenTorch = blockPreset.torch('starter:green_torch', tex.oakPlanks, {
    name: 'Green Torch',
    lightEmission: [0, 15, 0],
    sounds: soundPreset.wood,
});
export const blueTorch = blockPreset.torch('starter:blue_torch', tex.oakPlanks, {
    name: 'Blue Torch',
    lightEmission: [0, 0, 15],
    sounds: soundPreset.wood,
});

// wool — 15 dye colors mirroring Minecraft's palette (light_blue omitted;
// no source texture). soft cloth: leaves sounds (snappy dig).
export const woolWhite = block('starter:wool_white', {
    name: 'White Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolWhite } } }),
    sounds: soundPreset.leaves,
});
export const woolLightGray = block('starter:wool_light_gray', {
    name: 'Light Gray Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolLightGray } } }),
    sounds: soundPreset.leaves,
});
export const woolGray = block('starter:wool_gray', {
    name: 'Gray Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolGray } } }),
    sounds: soundPreset.leaves,
});
export const woolBlack = block('starter:wool_black', {
    name: 'Black Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolBlack } } }),
    sounds: soundPreset.leaves,
});
export const woolBrown = block('starter:wool_brown', {
    name: 'Brown Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolBrown } } }),
    sounds: soundPreset.leaves,
});
export const woolRed = block('starter:wool_red', {
    name: 'Red Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolRed } } }),
    sounds: soundPreset.leaves,
});
export const woolOrange = block('starter:wool_orange', {
    name: 'Orange Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolOrange } } }),
    sounds: soundPreset.leaves,
});
export const woolYellow = block('starter:wool_yellow', {
    name: 'Yellow Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolYellow } } }),
    sounds: soundPreset.leaves,
});
export const woolLime = block('starter:wool_lime', {
    name: 'Lime Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolLime } } }),
    sounds: soundPreset.leaves,
});
export const woolGreen = block('starter:wool_green', {
    name: 'Green Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolGreen } } }),
    sounds: soundPreset.leaves,
});
export const woolCyan = block('starter:wool_cyan', {
    name: 'Cyan Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolCyan } } }),
    sounds: soundPreset.leaves,
});
export const woolBlue = block('starter:wool_blue', {
    name: 'Blue Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolBlue } } }),
    sounds: soundPreset.leaves,
});
export const woolPurple = block('starter:wool_purple', {
    name: 'Purple Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolPurple } } }),
    sounds: soundPreset.leaves,
});
export const woolMagenta = block('starter:wool_magenta', {
    name: 'Magenta Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolMagenta } } }),
    sounds: soundPreset.leaves,
});
export const woolPink = block('starter:wool_pink', {
    name: 'Pink Wool',
    model: () => ({ type: 'cube', textures: { all: { texture: tex.woolPink } } }),
    sounds: soundPreset.leaves,
});
