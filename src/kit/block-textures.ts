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

import { asset, blockTexture, draw } from 'bongle';

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

// multiply-tint a shared grayscale/near-white base to a target color at bake
// time via `draw()`. one source image yields a whole color family (wool,
// concrete) instead of a hand-drawn PNG per color: the base's luminance texture
// (weave, grain) survives the multiply, only the hue changes. `r`/`g`/`b` are
// the 0..255 target color.
const multiplyTintedTexture = (id: string, baseHref: string, r: number, g: number, b: number) =>
    blockTexture(id, {
        src: draw(
            (ctx, { base }, params) => {
                ctx.drawImage(base, 0, 0);
                ctx.globalCompositeOperation = 'multiply';
                ctx.fillStyle = `rgb(${params.r}, ${params.g}, ${params.b})`;
                ctx.fillRect(0, 0, 16, 16);
            },
            { size: [16, 16], inputs: { base: baseHref }, params: { r, g, b } },
        ),
    });

// wool, all 16 dye colors mirroring Minecraft's palette. `wool_white.png`
// (MIT-licensed, from minetest_game's wool mod) is the shared grayscale weave;
// the other 15 multiply-tint it, so only the one base PNG is authored. RGB
// values are Minecraft's per-color wool averages.
const WOOL_BASE = asset('./assets/textures/wool_white.png', import.meta.url);
export const woolWhite = blockTexture('kit:wool_white', { src: WOOL_BASE });
export const woolLightGray = multiplyTintedTexture('kit:wool_light_gray', WOOL_BASE, 142, 142, 134);
export const woolGray = multiplyTintedTexture('kit:wool_gray', WOOL_BASE, 62, 68, 71);
export const woolBlack = multiplyTintedTexture('kit:wool_black', WOOL_BASE, 20, 21, 25);
export const woolBrown = multiplyTintedTexture('kit:wool_brown', WOOL_BASE, 114, 71, 40);
export const woolRed = multiplyTintedTexture('kit:wool_red', WOOL_BASE, 160, 39, 34);
export const woolOrange = multiplyTintedTexture('kit:wool_orange', WOOL_BASE, 240, 118, 19);
export const woolYellow = multiplyTintedTexture('kit:wool_yellow', WOOL_BASE, 248, 198, 39);
export const woolLime = multiplyTintedTexture('kit:wool_lime', WOOL_BASE, 112, 185, 25);
export const woolGreen = multiplyTintedTexture('kit:wool_green', WOOL_BASE, 84, 109, 27);
export const woolCyan = multiplyTintedTexture('kit:wool_cyan', WOOL_BASE, 21, 137, 145);
export const woolLightBlue = multiplyTintedTexture('kit:wool_light_blue', WOOL_BASE, 58, 175, 217);
export const woolBlue = multiplyTintedTexture('kit:wool_blue', WOOL_BASE, 53, 57, 157);
export const woolPurple = multiplyTintedTexture('kit:wool_purple', WOOL_BASE, 121, 42, 172);
export const woolMagenta = multiplyTintedTexture('kit:wool_magenta', WOOL_BASE, 189, 68, 179);
export const woolPink = multiplyTintedTexture('kit:wool_pink', WOOL_BASE, 237, 141, 172);

// concrete, all 16 dye colors, tinted from one shared near-white grain base
// (`concrete_base.png`) the same way as wool above. the base sits near white, so
// multiplying by the target leaves the color intact with only the faint grain
// showing through. RGB values are Minecraft's per-color concrete averages.
const CONCRETE_BASE = asset('./assets/textures/concrete_base.png', import.meta.url);
const concreteTexture = (id: string, r: number, g: number, b: number) =>
    multiplyTintedTexture(id, CONCRETE_BASE, r, g, b);

export const concreteWhite = concreteTexture('kit:concrete_white', 207, 213, 214);
export const concreteLightGray = concreteTexture('kit:concrete_light_gray', 125, 125, 115);
export const concreteGray = concreteTexture('kit:concrete_gray', 55, 58, 62);
export const concreteBlack = concreteTexture('kit:concrete_black', 8, 10, 15);
export const concreteBrown = concreteTexture('kit:concrete_brown', 96, 60, 32);
export const concreteRed = concreteTexture('kit:concrete_red', 142, 33, 33);
export const concreteOrange = concreteTexture('kit:concrete_orange', 224, 97, 0);
export const concreteYellow = concreteTexture('kit:concrete_yellow', 241, 175, 21);
export const concreteLime = concreteTexture('kit:concrete_lime', 94, 169, 24);
export const concreteGreen = concreteTexture('kit:concrete_green', 73, 91, 36);
export const concreteCyan = concreteTexture('kit:concrete_cyan', 21, 119, 136);
export const concreteLightBlue = concreteTexture('kit:concrete_light_blue', 36, 137, 199);
export const concreteBlue = concreteTexture('kit:concrete_blue', 44, 46, 143);
export const concretePurple = concreteTexture('kit:concrete_purple', 100, 32, 156);
export const concreteMagenta = concreteTexture('kit:concrete_magenta', 169, 48, 159);
export const concretePink = concreteTexture('kit:concrete_pink', 213, 101, 143);
