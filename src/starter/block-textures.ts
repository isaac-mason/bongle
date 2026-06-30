// Starter pack block textures.
//
// Each `blockTexture()` uses the URL form so the texture file ships
// bundled with the starter package: vite rewrites the URL into the
// client bundle, and the asset pipeline resolves `file://` via
// fileURLToPath.
//
// Exposed individually so the package index can re-export them as
// `export * as blockTextures`. Consumers reach them as
// `blockTextures.stone`, `blockTextures.grassTop`, etc.

import { blockTexture } from 'bongle';

export const stone = blockTexture('starter:stone', {
    src: new URL('./assets/textures/stone.png', import.meta.url),
});
export const dirt = blockTexture('starter:dirt', {
    src: new URL('./assets/textures/dirt.png', import.meta.url),
});
export const grassTop = blockTexture('starter:grass_top', {
    src: new URL('./assets/textures/grass_top.png', import.meta.url),
});
export const grassSide = blockTexture('starter:grass_side', {
    src: new URL('./assets/textures/dirt_grass.png', import.meta.url),
});
export const farmlandTop = blockTexture('starter:farmland_top', {
    src: new URL('./assets/textures/farmland_top.png', import.meta.url),
});
export const dirtPathTop = blockTexture('starter:dirt_path_top', {
    src: new URL('./assets/textures/dirt_path_top.png', import.meta.url),
});
export const mushroomRed = blockTexture('starter:mushroom_red', {
    src: new URL('./assets/textures/mushroom_plant_red.png', import.meta.url),
});
export const oakLeaves = blockTexture('starter:oak_leaves', {
    src: new URL('./assets/textures/leaves.png', import.meta.url),
});
export const grassPlant1 = blockTexture('starter:grass_plant_1', {
    src: new URL('./assets/textures/grass_plant_1.png', import.meta.url),
});
export const grassPlant2 = blockTexture('starter:grass_plant_2', {
    src: new URL('./assets/textures/grass_plant_2.png', import.meta.url),
});
export const shortGrass = blockTexture('starter:short_grass', {
    src: new URL('./assets/textures/short_grass.png', import.meta.url),
});

export const water = blockTexture('starter:water', {
    src: [new URL('./assets/textures/water_1.png', import.meta.url), new URL('./assets/textures/water_2.png', import.meta.url)],
    fps: 1.5,
    interpolate: true,
});

export const lava = blockTexture('starter:lava', {
    src: [new URL('./assets/textures/lava_1.png', import.meta.url), new URL('./assets/textures/lava_2.png', import.meta.url)],
    fps: 1.5,
    interpolate: true,
});

export const ice = blockTexture('starter:ice', {
    src: new URL('./assets/textures/ice.png', import.meta.url),
});

export const ladder = blockTexture('starter:ladder', {
    src: new URL('./assets/textures/ladder.png', import.meta.url),
});
export const oakPlanks = blockTexture('starter:oak_planks', {
    src: new URL('./assets/textures/oak_planks.png', import.meta.url),
});
export const torch = blockTexture('starter:torch', {
    src: new URL('./assets/textures/torch.png', import.meta.url),
});
export const redTorch = blockTexture('starter:red_torch', {
    src: new URL('./assets/textures/red_torch.png', import.meta.url),
});
export const greenTorch = blockTexture('starter:green_torch', {
    src: new URL('./assets/textures/green_torch.png', import.meta.url),
});
export const blueTorch = blockTexture('starter:blue_torch', {
    src: new URL('./assets/textures/blue_torch.png', import.meta.url),
});
export const oakLogTop = blockTexture('starter:oak_log_top', {
    src: new URL('./assets/textures/oak_log_top.png', import.meta.url),
});
export const oakLogSide = blockTexture('starter:oak_log_side', {
    src: new URL('./assets/textures/oak_log_side.png', import.meta.url),
});
export const cobblestone = blockTexture('starter:cobblestone', {
    src: new URL('./assets/textures/cobblestone.png', import.meta.url),
});
export const mossyCobblestone = blockTexture('starter:mossy_cobblestone', {
    src: new URL('./assets/textures/mossy_cobblestone.png', import.meta.url),
});
export const glass = blockTexture('starter:glass', {
    src: new URL('./assets/textures/glass.png', import.meta.url),
});
export const snow = blockTexture('starter:snow', {
    src: new URL('./assets/textures/snow.png', import.meta.url),
});

// wool, 15 dye colors. names follow Minecraft's palette (textures sourced
// from minetest_game's wool mod, MIT-licensed). there's no `light_blue`,
// MC's 16th color, without a hand-tinted texture; skip for now.
export const woolWhite = blockTexture('starter:wool_white', {
    src: new URL('./assets/textures/wool_white.png', import.meta.url),
});
export const woolLightGray = blockTexture('starter:wool_light_gray', {
    src: new URL('./assets/textures/wool_light_gray.png', import.meta.url),
});
export const woolGray = blockTexture('starter:wool_gray', { src: new URL('./assets/textures/wool_gray.png', import.meta.url) });
export const woolBlack = blockTexture('starter:wool_black', {
    src: new URL('./assets/textures/wool_black.png', import.meta.url),
});
export const woolBrown = blockTexture('starter:wool_brown', {
    src: new URL('./assets/textures/wool_brown.png', import.meta.url),
});
export const woolRed = blockTexture('starter:wool_red', { src: new URL('./assets/textures/wool_red.png', import.meta.url) });
export const woolOrange = blockTexture('starter:wool_orange', {
    src: new URL('./assets/textures/wool_orange.png', import.meta.url),
});
export const woolYellow = blockTexture('starter:wool_yellow', {
    src: new URL('./assets/textures/wool_yellow.png', import.meta.url),
});
export const woolLime = blockTexture('starter:wool_lime', { src: new URL('./assets/textures/wool_lime.png', import.meta.url) });
export const woolGreen = blockTexture('starter:wool_green', {
    src: new URL('./assets/textures/wool_green.png', import.meta.url),
});
export const woolCyan = blockTexture('starter:wool_cyan', { src: new URL('./assets/textures/wool_cyan.png', import.meta.url) });
export const woolBlue = blockTexture('starter:wool_blue', { src: new URL('./assets/textures/wool_blue.png', import.meta.url) });
export const woolPurple = blockTexture('starter:wool_purple', {
    src: new URL('./assets/textures/wool_purple.png', import.meta.url),
});
export const woolMagenta = blockTexture('starter:wool_magenta', {
    src: new URL('./assets/textures/wool_magenta.png', import.meta.url),
});
export const woolPink = blockTexture('starter:wool_pink', { src: new URL('./assets/textures/wool_pink.png', import.meta.url) });
