// Starter pack block textures.
//
// Each `blockTexture()` sources its image via `asset('./…', import.meta.url)`,
// so the texture file ships alongside this module and resolves relative to it
// wherever the starter package is installed; the pipeline reads the resolved
// path and bakes it into the atlas.
//
// Exposed individually so the package index can re-export them as
// `export * as blockTextures`. Consumers reach them as
// `blockTextures.stone`, `blockTextures.grassTop`, etc.

import { asset, blockTexture } from 'bongle';

export const stone = blockTexture('kit:stone', {
    src: asset('./assets/textures/stone.png', import.meta.url),
});
export const dirt = blockTexture('kit:dirt', {
    src: asset('./assets/textures/dirt.png', import.meta.url),
});
export const grassTop = blockTexture('kit:grass_top', {
    src: asset('./assets/textures/grass_top.png', import.meta.url),
});
export const grassSide = blockTexture('kit:grass_side', {
    src: asset('./assets/textures/dirt_grass.png', import.meta.url),
});
export const farmlandTop = blockTexture('kit:farmland_top', {
    src: asset('./assets/textures/farmland_top.png', import.meta.url),
});
export const dirtPathTop = blockTexture('kit:dirt_path_top', {
    src: asset('./assets/textures/dirt_path_top.png', import.meta.url),
});
export const mushroomRed = blockTexture('kit:mushroom_red', {
    src: asset('./assets/textures/mushroom_plant_red.png', import.meta.url),
});
export const oakLeaves = blockTexture('kit:oak_leaves', {
    src: asset('./assets/textures/leaves.png', import.meta.url),
});
export const grassPlant1 = blockTexture('kit:grass_plant_1', {
    src: asset('./assets/textures/grass_plant_1.png', import.meta.url),
});
export const grassPlant2 = blockTexture('kit:grass_plant_2', {
    src: asset('./assets/textures/grass_plant_2.png', import.meta.url),
});
export const shortGrass = blockTexture('kit:short_grass', {
    src: asset('./assets/textures/short_grass.png', import.meta.url),
});

export const water = blockTexture('kit:water', {
    src: [asset('./assets/textures/water_1.png', import.meta.url), asset('./assets/textures/water_2.png', import.meta.url)],
    fps: 1.5,
    interpolate: true,
});

export const lava = blockTexture('kit:lava', {
    src: [asset('./assets/textures/lava_1.png', import.meta.url), asset('./assets/textures/lava_2.png', import.meta.url)],
    fps: 1.5,
    interpolate: true,
});

export const ice = blockTexture('kit:ice', {
    src: asset('./assets/textures/ice.png', import.meta.url),
});

export const ladder = blockTexture('kit:ladder', {
    src: asset('./assets/textures/ladder.png', import.meta.url),
});
export const oakPlanks = blockTexture('kit:oak_planks', {
    src: asset('./assets/textures/oak_planks.png', import.meta.url),
});
export const torch = blockTexture('kit:torch', {
    src: asset('./assets/textures/torch.png', import.meta.url),
});
export const redTorch = blockTexture('kit:red_torch', {
    src: asset('./assets/textures/red_torch.png', import.meta.url),
});
export const greenTorch = blockTexture('kit:green_torch', {
    src: asset('./assets/textures/green_torch.png', import.meta.url),
});
export const blueTorch = blockTexture('kit:blue_torch', {
    src: asset('./assets/textures/blue_torch.png', import.meta.url),
});
export const oakLogTop = blockTexture('kit:oak_log_top', {
    src: asset('./assets/textures/oak_log_top.png', import.meta.url),
});
export const oakLogSide = blockTexture('kit:oak_log_side', {
    src: asset('./assets/textures/oak_log_side.png', import.meta.url),
});
export const cobblestone = blockTexture('kit:cobblestone', {
    src: asset('./assets/textures/cobblestone.png', import.meta.url),
});
export const gravel = blockTexture('kit:gravel', {
    src: asset('./assets/textures/gravel.png', import.meta.url),
});
export const mossyCobblestone = blockTexture('kit:mossy_cobblestone', {
    src: asset('./assets/textures/mossy_cobblestone.png', import.meta.url),
});
export const glass = blockTexture('kit:glass', {
    src: asset('./assets/textures/glass.png', import.meta.url),
});
export const snow = blockTexture('kit:snow', {
    src: asset('./assets/textures/snow.png', import.meta.url),
});

// wool, 15 dye colors. names follow Minecraft's palette (textures sourced
// from minetest_game's wool mod, MIT-licensed). there's no `light_blue`,
// MC's 16th color, without a hand-tinted texture; skip for now.
export const woolWhite = blockTexture('kit:wool_white', {
    src: asset('./assets/textures/wool_white.png', import.meta.url),
});
export const woolLightGray = blockTexture('kit:wool_light_gray', {
    src: asset('./assets/textures/wool_light_gray.png', import.meta.url),
});
export const woolGray = blockTexture('kit:wool_gray', { src: asset('./assets/textures/wool_gray.png', import.meta.url) });
export const woolBlack = blockTexture('kit:wool_black', {
    src: asset('./assets/textures/wool_black.png', import.meta.url),
});
export const woolBrown = blockTexture('kit:wool_brown', {
    src: asset('./assets/textures/wool_brown.png', import.meta.url),
});
export const woolRed = blockTexture('kit:wool_red', { src: asset('./assets/textures/wool_red.png', import.meta.url) });
export const woolOrange = blockTexture('kit:wool_orange', {
    src: asset('./assets/textures/wool_orange.png', import.meta.url),
});
export const woolYellow = blockTexture('kit:wool_yellow', {
    src: asset('./assets/textures/wool_yellow.png', import.meta.url),
});
export const woolLime = blockTexture('kit:wool_lime', { src: asset('./assets/textures/wool_lime.png', import.meta.url) });
export const woolGreen = blockTexture('kit:wool_green', {
    src: asset('./assets/textures/wool_green.png', import.meta.url),
});
export const woolCyan = blockTexture('kit:wool_cyan', { src: asset('./assets/textures/wool_cyan.png', import.meta.url) });
export const woolBlue = blockTexture('kit:wool_blue', { src: asset('./assets/textures/wool_blue.png', import.meta.url) });
export const woolPurple = blockTexture('kit:wool_purple', {
    src: asset('./assets/textures/wool_purple.png', import.meta.url),
});
export const woolMagenta = blockTexture('kit:wool_magenta', {
    src: asset('./assets/textures/wool_magenta.png', import.meta.url),
});
export const woolPink = blockTexture('kit:wool_pink', { src: asset('./assets/textures/wool_pink.png', import.meta.url) });
