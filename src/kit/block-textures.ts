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

// one texture per growth stage, youngest first, matching the order the crop
// preset indexes them by its `age` state. Spelled out rather than mapped, for
// the same reason as the liquid frames above: the dist asset rewrite only sees
// literal `asset()` paths.
export const wheatStages = [
    blockTexture('kit:wheat_1', { src: asset('./assets/textures/wheat_1.png', import.meta.url) }),
    blockTexture('kit:wheat_2', { src: asset('./assets/textures/wheat_2.png', import.meta.url) }),
    blockTexture('kit:wheat_3', { src: asset('./assets/textures/wheat_3.png', import.meta.url) }),
    blockTexture('kit:wheat_4', { src: asset('./assets/textures/wheat_4.png', import.meta.url) }),
];

// liquids carry a separate top and side: the top ripples in place while the
// side runs downward, which only reads correctly if the two faces animate
// independently. four frames each, and the last frame leads back into the
// first, so the loop is continuous.
//
// interpolate is ON. It does blend between frames, which puts colours on screen
// that are not in the four-tone palette, but a liquid whose whole animation is a
// scroll of one tile per cycle steps hard in four-pixel jumps without it. The
// motion matters more here than palette purity, and the blend is between two
// neighbouring frames of the same ramp, so it stays in the family.
//
// Speeds are slow on purpose. One full tile of travel per cycle is a long way,
// so a frame rate that looks reasonable as a number is far too fast on screen:
// at 6fps the water crossed a whole block in well under a second. 1fps with
// interpolation gives four seconds of continuous drift per cycle, which is
// what reads as a body of liquid rather than a conveyor belt.
//
// Every frame is spelled out as its own `asset('<literal>', import.meta.url)`.
// The dist build rewrites and copies asset refs by matching that exact literal
// form (scripts/bongle-asset-rewrite.ts), so a path built with a template
// string is silently skipped: the file never lands in dist/assets and the ref
// resolves against the chunk instead. It renders magenta, and only once built.
export const waterTop = blockTexture('kit:water_top', {
    src: [
        asset('./assets/textures/water_top_1.png', import.meta.url),
        asset('./assets/textures/water_top_2.png', import.meta.url),
        asset('./assets/textures/water_top_3.png', import.meta.url),
        asset('./assets/textures/water_top_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const waterSide = blockTexture('kit:water_side', {
    src: [
        asset('./assets/textures/water_side_1.png', import.meta.url),
        asset('./assets/textures/water_side_2.png', import.meta.url),
        asset('./assets/textures/water_side_3.png', import.meta.url),
        asset('./assets/textures/water_side_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const lavaTop = blockTexture('kit:lava_top', {
    src: [
        asset('./assets/textures/lava_top_1.png', import.meta.url),
        asset('./assets/textures/lava_top_2.png', import.meta.url),
        asset('./assets/textures/lava_top_3.png', import.meta.url),
        asset('./assets/textures/lava_top_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const lavaSide = blockTexture('kit:lava_side', {
    src: [
        asset('./assets/textures/lava_side_1.png', import.meta.url),
        asset('./assets/textures/lava_side_2.png', import.meta.url),
        asset('./assets/textures/lava_side_3.png', import.meta.url),
        asset('./assets/textures/lava_side_4.png', import.meta.url),
    ],
    fps: 1,
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
export const sand = blockTexture('kit:sand', {
    src: asset('./assets/textures/sand.png', import.meta.url),
});
export const sandstoneTop = blockTexture('kit:sandstone_top', {
    src: asset('./assets/textures/sandstone_top.png', import.meta.url),
});
export const sandstoneSide = blockTexture('kit:sandstone_side', {
    src: asset('./assets/textures/sandstone_side.png', import.meta.url),
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
export const slime = blockTexture('kit:slime', {
    src: asset('./assets/textures/slime.png', import.meta.url),
});
export const slimeTransparent = blockTexture('kit:slime_transparent', {
    src: asset('./assets/textures/slime_transparent.png', import.meta.url),
});

// How much surface contrast a tinted family keeps, in luminance levels, after
// being tinted to any colour.
//
// A plain multiply cannot hold this at the dark end: black wool is tinted by
// 48/255, so the base's contrast arrives divided by five and the block renders
// as a flat dark square. The tint below adds back enough of each pixel's
// deviation from the mean to reach the target again.
//
// The two families want very different numbers. Wool is cloth and should show
// its weave. Concrete is poured and should not: Minecraft's own concrete spans
// three luminance levels across a whole tile, so anything above single figures
// reads as grain on what is meant to be a smooth slab.
const WOOL_WEAVE = 30;
const CONCRETE_WEAVE = 5;

const multiplyTintedTexture = (id: string, baseHref: string, r: number, g: number, b: number, minWeave: number) =>
    blockTexture(id, {
        src: draw(
            (ctx, { base }, params) => {
                ctx.drawImage(base, 0, 0);
                const image = ctx.getImageData(0, 0, 16, 16);
                const px = image.data;
                const luminance = (i: number) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

                let mean = 0;
                let lowest = 255;
                let highest = 0;
                for (let i = 0; i < px.length; i += 4) {
                    const value = luminance(i);
                    mean += value;
                    lowest = Math.min(lowest, value);
                    highest = Math.max(highest, value);
                }
                mean /= px.length / 4;
                const baseSpread = Math.max(1, highest - lowest);

                // Add back exactly enough of the base's own contrast to reach the
                // family's target, given how much the multiply already left.
                const tintLuminance = 0.299 * params.r + 0.587 * params.g + 0.114 * params.b;
                const afterMultiply = baseSpread * (tintLuminance / 255);
                const gain = Math.max(0, params.minWeave - afterMultiply) / baseSpread;

                for (let i = 0; i < px.length; i += 4) {
                    const boost = (luminance(i) - mean) * gain;
                    px[i] = Math.max(0, Math.min(255, (px[i] * params.r) / 255 + boost));
                    px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] * params.g) / 255 + boost));
                    px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] * params.b) / 255 + boost));
                }
                ctx.putImageData(image, 0, 0);
            },
            { size: [16, 16], inputs: { base: baseHref }, params: { r, g, b, minWeave } },
        ),
    });

// wool, all 16 dye colors mirroring Minecraft's palette. `wool_white.png`
// (MIT-licensed, from minetest_game's wool mod) is the shared grayscale weave;
// the other 15 multiply-tint it, so only the one base PNG is authored. RGB
// values are Minecraft's per-color wool averages.
const WOOL_BASE = asset('./assets/textures/wool_white.png', import.meta.url);
export const woolWhite = blockTexture('kit:wool_white', { src: WOOL_BASE });
export const woolLightGray = multiplyTintedTexture('kit:wool_light_gray', WOOL_BASE, 142, 142, 134, WOOL_WEAVE);
export const woolGray = multiplyTintedTexture('kit:wool_gray', WOOL_BASE, 62, 68, 71, WOOL_WEAVE);
// lifted well above Minecraft's own black wool average (20,21,25). That value
// is honest to their texture but reads as a flat black hole in a build; this
// sits as a very dark charcoal, still clearly below `woolGray`.
export const woolBlack = multiplyTintedTexture('kit:wool_black', WOOL_BASE, 48, 49, 56, WOOL_WEAVE);
export const woolBrown = multiplyTintedTexture('kit:wool_brown', WOOL_BASE, 114, 71, 40, WOOL_WEAVE);
export const woolRed = multiplyTintedTexture('kit:wool_red', WOOL_BASE, 160, 39, 34, WOOL_WEAVE);
export const woolOrange = multiplyTintedTexture('kit:wool_orange', WOOL_BASE, 240, 118, 19, WOOL_WEAVE);
export const woolYellow = multiplyTintedTexture('kit:wool_yellow', WOOL_BASE, 248, 198, 39, WOOL_WEAVE);
export const woolLime = multiplyTintedTexture('kit:wool_lime', WOOL_BASE, 112, 185, 25, WOOL_WEAVE);
export const woolGreen = multiplyTintedTexture('kit:wool_green', WOOL_BASE, 84, 109, 27, WOOL_WEAVE);
export const woolCyan = multiplyTintedTexture('kit:wool_cyan', WOOL_BASE, 21, 137, 145, WOOL_WEAVE);
export const woolLightBlue = multiplyTintedTexture('kit:wool_light_blue', WOOL_BASE, 58, 175, 217, WOOL_WEAVE);
export const woolBlue = multiplyTintedTexture('kit:wool_blue', WOOL_BASE, 53, 57, 157, WOOL_WEAVE);
export const woolPurple = multiplyTintedTexture('kit:wool_purple', WOOL_BASE, 121, 42, 172, WOOL_WEAVE);
export const woolMagenta = multiplyTintedTexture('kit:wool_magenta', WOOL_BASE, 189, 68, 179, WOOL_WEAVE);
export const woolPink = multiplyTintedTexture('kit:wool_pink', WOOL_BASE, 237, 141, 172, WOOL_WEAVE);

// concrete, all 16 dye colors, tinted from one shared near-white grain base
// (`concrete_base.png`) the same way as wool above. the base sits near white, so
// multiplying by the target leaves the color intact with only the faint grain
// showing through. RGB values are Minecraft's per-color concrete averages.
const CONCRETE_BASE = asset('./assets/textures/concrete_base.png', import.meta.url);
const concreteTexture = (id: string, r: number, g: number, b: number) =>
    multiplyTintedTexture(id, CONCRETE_BASE, r, g, b, CONCRETE_WEAVE);

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
