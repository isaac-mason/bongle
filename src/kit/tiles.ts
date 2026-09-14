import { asset, type TextureHandle, texture, tile } from 'bongle';
import * as tex from './textures';

export const stone = tile('kit:stone', {
    src: asset('./assets/textures/stone.png', import.meta.url),
});
export const dirt = tile('kit:dirt', {
    src: asset('./assets/textures/dirt.png', import.meta.url),
});
export const grassTop = tile('kit:grass_top', {
    src: asset('./assets/textures/grass_top.png', import.meta.url),
});
export const grassSide = tile('kit:grass_side', {
    src: asset('./assets/textures/dirt_grass.png', import.meta.url),
});
export const farmlandTop = tile('kit:farmland_top', {
    src: asset('./assets/textures/farmland_top.png', import.meta.url),
});
export const farmlandTopWet = tile('kit:farmland_top_wet', {
    src: asset('./assets/textures/farmland_top_wet.png', import.meta.url),
});
export const dirtPathTop = tile('kit:dirt_path_top', {
    src: asset('./assets/textures/dirt_path_top.png', import.meta.url),
});
export const mushroomRed = tile('kit:mushroom_red', {
    src: asset('./assets/textures/mushroom_red.png', import.meta.url),
});
export const mushroomBrown = tile('kit:mushroom_brown', {
    src: asset('./assets/textures/mushroom_brown.png', import.meta.url),
});
// built from the named texture rather than its own `src`, so the leaf image is
// declared once and `textures.leavesFluff` can derive its blob from the same
// entry. Same reason `sprites.white` is built from `textures.white`.
export const oakLeaves = tile('kit:oak_leaves', {
    frames: [tex.leaves],
});

/** the leaf texture masked to a round blob, for `leaves({ fluff })`. */
export const oakLeavesFluff = tile('kit:oak_leaves_fluff', {
    frames: [tex.leavesFluff],
});
// three tufts the `shortGrass` block picks between per position. Spelled out
// rather than mapped, for the same reason as the crop stages below: the dist
// asset rewrite only sees literal `asset()` paths.
// three tall tufts on 16x32 tiles, the top of each left empty: `tallGrass`
// shows their bottom 1.4 blocks (see `blockModel.cross` on `height`).
export const tallGrassVariants = [
    tile('kit:tall_grass_1', { src: asset('./assets/textures/tall_grass_1.png', import.meta.url) }),
    tile('kit:tall_grass_2', { src: asset('./assets/textures/tall_grass_2.png', import.meta.url) }),
    tile('kit:tall_grass_3', { src: asset('./assets/textures/tall_grass_3.png', import.meta.url) }),
];
export const shortGrassVariants = [
    tile('kit:short_grass_1', { src: asset('./assets/textures/short_grass_1.png', import.meta.url) }),
    tile('kit:short_grass_2', { src: asset('./assets/textures/short_grass_2.png', import.meta.url) }),
    tile('kit:short_grass_3', { src: asset('./assets/textures/short_grass_3.png', import.meta.url) }),
];

// three scatterings of fallen oak leaves the `oakLeafLitter` block picks
// between per position.
export const oakLeafLitterVariants = [
    tile('kit:oak_leaf_litter_1', { src: asset('./assets/textures/oak_leaf_litter_1.png', import.meta.url) }),
    tile('kit:oak_leaf_litter_2', { src: asset('./assets/textures/oak_leaf_litter_2.png', import.meta.url) }),
    tile('kit:oak_leaf_litter_3', { src: asset('./assets/textures/oak_leaf_litter_3.png', import.meta.url) }),
];

// one texture per growth stage, youngest first, matching the order `wheat`
// indexes them by its `age` state. Spelled out rather than mapped, for
// the same reason as the liquid frames above: the dist asset rewrite only sees
// literal `asset()` paths.
export const wheatStages = [
    tile('kit:wheat_1', { src: asset('./assets/textures/crop_wheat_1.png', import.meta.url) }),
    tile('kit:wheat_2', { src: asset('./assets/textures/crop_wheat_2.png', import.meta.url) }),
    tile('kit:wheat_3', { src: asset('./assets/textures/crop_wheat_3.png', import.meta.url) }),
    tile('kit:wheat_4', { src: asset('./assets/textures/crop_wheat_4.png', import.meta.url) }),
];

export const carrotStages = [
    tile('kit:carrot_1', { src: asset('./assets/textures/crop_carrot_1.png', import.meta.url) }),
    tile('kit:carrot_2', { src: asset('./assets/textures/crop_carrot_2.png', import.meta.url) }),
    tile('kit:carrot_3', { src: asset('./assets/textures/crop_carrot_3.png', import.meta.url) }),
    tile('kit:carrot_4', { src: asset('./assets/textures/crop_carrot_4.png', import.meta.url) }),
];

export const beetrootStages = [
    tile('kit:beetroot_1', { src: asset('./assets/textures/crop_beetroot_1.png', import.meta.url) }),
    tile('kit:beetroot_2', { src: asset('./assets/textures/crop_beetroot_2.png', import.meta.url) }),
    tile('kit:beetroot_3', { src: asset('./assets/textures/crop_beetroot_3.png', import.meta.url) }),
    tile('kit:beetroot_4', { src: asset('./assets/textures/crop_beetroot_4.png', import.meta.url) }),
];

export const potatoStages = [
    tile('kit:potato_1', { src: asset('./assets/textures/crop_potato_1.png', import.meta.url) }),
    tile('kit:potato_2', { src: asset('./assets/textures/crop_potato_2.png', import.meta.url) }),
    tile('kit:potato_3', { src: asset('./assets/textures/crop_potato_3.png', import.meta.url) }),
    tile('kit:potato_4', { src: asset('./assets/textures/crop_potato_4.png', import.meta.url) }),
];

export const cabbageStages = [
    tile('kit:cabbage_1', { src: asset('./assets/textures/crop_cabbage_1.png', import.meta.url) }),
    tile('kit:cabbage_2', { src: asset('./assets/textures/crop_cabbage_2.png', import.meta.url) }),
    tile('kit:cabbage_3', { src: asset('./assets/textures/crop_cabbage_3.png', import.meta.url) }),
    tile('kit:cabbage_4', { src: asset('./assets/textures/crop_cabbage_4.png', import.meta.url) }),
];

export const cornStages = [
    tile('kit:corn_1', { src: asset('./assets/textures/crop_corn_1.png', import.meta.url) }),
    tile('kit:corn_2', { src: asset('./assets/textures/crop_corn_2.png', import.meta.url) }),
    tile('kit:corn_3', { src: asset('./assets/textures/crop_corn_3.png', import.meta.url) }),
    tile('kit:corn_4', { src: asset('./assets/textures/crop_corn_4.png', import.meta.url) }),
];
export const strawberryStages = [
    tile('kit:strawberry_1', { src: asset('./assets/textures/crop_strawberry_1.png', import.meta.url) }),
    tile('kit:strawberry_2', { src: asset('./assets/textures/crop_strawberry_2.png', import.meta.url) }),
    tile('kit:strawberry_3', { src: asset('./assets/textures/crop_strawberry_3.png', import.meta.url) }),
    tile('kit:strawberry_4', { src: asset('./assets/textures/crop_strawberry_4.png', import.meta.url) }),
];
export const blueberryStages = [
    tile('kit:blueberry_1', { src: asset('./assets/textures/crop_blueberry_1.png', import.meta.url) }),
    tile('kit:blueberry_2', { src: asset('./assets/textures/crop_blueberry_2.png', import.meta.url) }),
    tile('kit:blueberry_3', { src: asset('./assets/textures/crop_blueberry_3.png', import.meta.url) }),
    tile('kit:blueberry_4', { src: asset('./assets/textures/crop_blueberry_4.png', import.meta.url) }),
];
// three frames: the glow flickers, blended so the flame drifts rather than
// snaps.
export const lantern = tile('kit:lantern', {
    frames: [tex.lantern1, tex.lantern2, tex.lantern3],
    fps: 3,
    interpolate: true,
});
// eight frames, no blend: fire snaps between arrangements rather than melting
export const fire = tile('kit:fire', {
    frames: [tex.fire1, tex.fire2, tex.fire3, tex.fire4, tex.fire5, tex.fire6, tex.fire7, tex.fire8],
    fps: 8,
});
export const cobweb = tile('kit:cobweb', {
    src: asset('./assets/textures/cobweb.png', import.meta.url),
});
export const lanternOff = tile('kit:lantern_off', {
    src: asset('./assets/textures/lantern_off.png', import.meta.url),
});
export const chain = tile('kit:chain', {
    src: asset('./assets/textures/chain.png', import.meta.url),
});
// the flowers, one sprite each, real names
export const dandelion = tile('kit:dandelion', { src: asset('./assets/textures/flower_dandelion.png', import.meta.url) });
export const poppy = tile('kit:poppy', { src: asset('./assets/textures/flower_poppy.png', import.meta.url) });
export const cornflower = tile('kit:cornflower', { src: asset('./assets/textures/flower_cornflower.png', import.meta.url) });
export const allium = tile('kit:allium', { src: asset('./assets/textures/flower_allium.png', import.meta.url) });
export const oxeyeDaisy = tile('kit:oxeye_daisy', { src: asset('./assets/textures/flower_oxeye_daisy.png', import.meta.url) });
export const orangeTulip = tile('kit:orange_tulip', { src: asset('./assets/textures/flower_orange_tulip.png', import.meta.url) });
export const pinkTulip = tile('kit:pink_tulip', { src: asset('./assets/textures/flower_pink_tulip.png', import.meta.url) });
export const babysBreath = tile('kit:babys_breath', { src: asset('./assets/textures/flower_babys_breath.png', import.meta.url) });
export const lilyOfTheValley = tile('kit:lily_of_the_valley', {
    src: asset('./assets/textures/flower_lily_of_the_valley.png', import.meta.url),
});
export const oakSapling = tile('kit:oak_sapling', {
    src: asset('./assets/textures/oak_sapling.png', import.meta.url),
});
// liquids carry a separate top and side: the top ripples in place while the
// side runs downward, which only reads correctly if the two faces animate
// independently. four frames each, and the last frame leads back into the
// first, so the loop is continuous.
//
// interpolate is on. It does blend between frames, which puts colours on screen
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
export const waterTop = tile('kit:water_top', {
    src: [
        asset('./assets/textures/water_top_1.png', import.meta.url),
        asset('./assets/textures/water_top_2.png', import.meta.url),
        asset('./assets/textures/water_top_3.png', import.meta.url),
        asset('./assets/textures/water_top_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const waterSide = tile('kit:water_side', {
    src: [
        asset('./assets/textures/water_side_1.png', import.meta.url),
        asset('./assets/textures/water_side_2.png', import.meta.url),
        asset('./assets/textures/water_side_3.png', import.meta.url),
        asset('./assets/textures/water_side_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const lavaTop = tile('kit:lava_top', {
    src: [
        asset('./assets/textures/lava_top_1.png', import.meta.url),
        asset('./assets/textures/lava_top_2.png', import.meta.url),
        asset('./assets/textures/lava_top_3.png', import.meta.url),
        asset('./assets/textures/lava_top_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const lavaSide = tile('kit:lava_side', {
    src: [
        asset('./assets/textures/lava_side_1.png', import.meta.url),
        asset('./assets/textures/lava_side_2.png', import.meta.url),
        asset('./assets/textures/lava_side_3.png', import.meta.url),
        asset('./assets/textures/lava_side_4.png', import.meta.url),
    ],
    fps: 1,
    interpolate: true,
});

export const ice = tile('kit:ice', {
    src: asset('./assets/textures/ice.png', import.meta.url),
});

export const ladder = tile('kit:ladder', {
    src: asset('./assets/textures/ladder.png', import.meta.url),
});
export const oakPlanks = tile('kit:oak_planks', {
    src: asset('./assets/textures/oak_planks.png', import.meta.url),
});
export const torch = tile('kit:torch', {
    src: asset('./assets/textures/torch.png', import.meta.url),
});
export const redTorch = tile('kit:red_torch', {
    src: asset('./assets/textures/red_torch.png', import.meta.url),
});
export const greenTorch = tile('kit:green_torch', {
    src: asset('./assets/textures/green_torch.png', import.meta.url),
});
export const blueTorch = tile('kit:blue_torch', {
    src: asset('./assets/textures/blue_torch.png', import.meta.url),
});
export const oakLogTop = tile('kit:oak_log_top', {
    src: asset('./assets/textures/oak_log_top.png', import.meta.url),
});
export const oakLogSide = tile('kit:oak_log_side', {
    src: asset('./assets/textures/oak_log_side.png', import.meta.url),
});

export const bookshelf = tile('kit:bookshelf', {
    src: asset('./assets/textures/bookshelf.png', import.meta.url),
});
export const cobblestone = tile('kit:cobblestone', {
    src: asset('./assets/textures/cobblestone.png', import.meta.url),
});
export const sand = tile('kit:sand', {
    src: asset('./assets/textures/sand.png', import.meta.url),
});
export const sandstoneTop = tile('kit:sandstone_top', {
    src: asset('./assets/textures/sandstone_top.png', import.meta.url),
});
export const sandstoneSide = tile('kit:sandstone_side', {
    src: asset('./assets/textures/sandstone_side.png', import.meta.url),
});
export const gravel = tile('kit:gravel', {
    src: asset('./assets/textures/gravel.png', import.meta.url),
});
export const mossyCobblestone = tile('kit:mossy_cobblestone', {
    src: asset('./assets/textures/mossy_cobblestone.png', import.meta.url),
});
export const stoneBricks = tile('kit:stone_bricks', {
    src: asset('./assets/textures/stone_bricks.png', import.meta.url),
});
export const mossyStoneBricks = tile('kit:mossy_stone_bricks', {
    src: asset('./assets/textures/mossy_stone_bricks.png', import.meta.url),
});
export const crackedStoneBricks = tile('kit:cracked_stone_bricks', {
    src: asset('./assets/textures/cracked_stone_bricks.png', import.meta.url),
});
export const chiseledStoneBricks = tile('kit:chiseled_stone_bricks', {
    src: asset('./assets/textures/chiseled_stone_bricks.png', import.meta.url),
});
export const bricks = tile('kit:bricks', {
    src: asset('./assets/textures/bricks.png', import.meta.url),
});
export const sunstone = tile('kit:sunstone', {
    src: asset('./assets/textures/sunstone.png', import.meta.url),
});
export const glass = tile('kit:glass', {
    src: asset('./assets/textures/glass.png', import.meta.url),
});
export const snow = tile('kit:snow', {
    src: asset('./assets/textures/snow.png', import.meta.url),
});
export const slime = tile('kit:slime', {
    src: asset('./assets/textures/slime.png', import.meta.url),
});
export const slimeTransparent = tile('kit:slime_transparent', {
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

// The tint is a computed texture wrapped in a single-frame tile. `base` is passed as a
// texture handle, so the derived texture carries a real dep edge back to the shared
// grayscale base rather than a copy of its resolved path, so re-authoring the base
// invalidates all 31 tints. The texture takes the tile's id verbatim: different stores,
// so there is no collision, and it matches what the `src` sugar does for a single frame.
const multiplyTintedTile = (id: string, base: TextureHandle, r: number, g: number, b: number, minWeave: number) =>
    tile(id, {
        frames: [
            texture(id, {
                size: [16, 16],
                inputs: { base },
                params: { r, g, b, minWeave },
                fn: (ctx, inputs, params) => {
                    ctx.drawImage(inputs.base, 0, 0);
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
                    const tintR = params.r as number;
                    const tintG = params.g as number;
                    const tintB = params.b as number;
                    const tintLuminance = 0.299 * tintR + 0.587 * tintG + 0.114 * tintB;
                    const afterMultiply = baseSpread * (tintLuminance / 255);
                    const gain = Math.max(0, (params.minWeave as number) - afterMultiply) / baseSpread;

                    for (let i = 0; i < px.length; i += 4) {
                        const boost = (luminance(i) - mean) * gain;
                        px[i] = Math.max(0, Math.min(255, (px[i] * tintR) / 255 + boost));
                        px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] * tintG) / 255 + boost));
                        px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] * tintB) / 255 + boost));
                    }
                    ctx.putImageData(image, 0, 0);
                },
            }),
        ],
    });

// wool, all 16 dye colors mirroring Minecraft's palette. `wool_white.png`
// (MIT-licensed, from minetest_game's wool mod) is the shared grayscale weave;
// the other 15 multiply-tint it, so only the one base PNG is authored. RGB
// values are Minecraft's per-color wool averages.
const WOOL_BASE = texture('kit:wool_base', { src: asset('./assets/textures/wool_white.png', import.meta.url) });
export const woolWhite = tile('kit:wool_white', { frames: [WOOL_BASE] });
export const woolLightGray = multiplyTintedTile('kit:wool_light_gray', WOOL_BASE, 142, 142, 134, WOOL_WEAVE);
export const woolGray = multiplyTintedTile('kit:wool_gray', WOOL_BASE, 62, 68, 71, WOOL_WEAVE);
// lifted well above Minecraft's own black wool average (20,21,25). That value
// is honest to their texture but reads as a flat black hole in a build; this
// sits as a very dark charcoal, still clearly below `woolGray`.
export const woolBlack = multiplyTintedTile('kit:wool_black', WOOL_BASE, 48, 49, 56, WOOL_WEAVE);
export const woolBrown = multiplyTintedTile('kit:wool_brown', WOOL_BASE, 114, 71, 40, WOOL_WEAVE);
export const woolRed = multiplyTintedTile('kit:wool_red', WOOL_BASE, 160, 39, 34, WOOL_WEAVE);
export const woolOrange = multiplyTintedTile('kit:wool_orange', WOOL_BASE, 240, 118, 19, WOOL_WEAVE);
export const woolYellow = multiplyTintedTile('kit:wool_yellow', WOOL_BASE, 248, 198, 39, WOOL_WEAVE);
export const woolLime = multiplyTintedTile('kit:wool_lime', WOOL_BASE, 112, 185, 25, WOOL_WEAVE);
export const woolGreen = multiplyTintedTile('kit:wool_green', WOOL_BASE, 84, 109, 27, WOOL_WEAVE);
export const woolCyan = multiplyTintedTile('kit:wool_cyan', WOOL_BASE, 21, 137, 145, WOOL_WEAVE);
export const woolLightBlue = multiplyTintedTile('kit:wool_light_blue', WOOL_BASE, 58, 175, 217, WOOL_WEAVE);
export const woolBlue = multiplyTintedTile('kit:wool_blue', WOOL_BASE, 53, 57, 157, WOOL_WEAVE);
export const woolPurple = multiplyTintedTile('kit:wool_purple', WOOL_BASE, 121, 42, 172, WOOL_WEAVE);
export const woolMagenta = multiplyTintedTile('kit:wool_magenta', WOOL_BASE, 189, 68, 179, WOOL_WEAVE);
export const woolPink = multiplyTintedTile('kit:wool_pink', WOOL_BASE, 237, 141, 172, WOOL_WEAVE);

// concrete, all 16 dye colors, tinted from one shared near-white grain base
// (`concrete_base.png`) the same way as wool above. the base sits near white, so
// multiplying by the target leaves the color intact with only the faint grain
// showing through. RGB values are Minecraft's per-color concrete averages.
const CONCRETE_BASE = texture('kit:concrete_base', {
    src: asset('./assets/textures/concrete_base.png', import.meta.url),
});
const concreteTile = (id: string, r: number, g: number, b: number) =>
    multiplyTintedTile(id, CONCRETE_BASE, r, g, b, CONCRETE_WEAVE);

export const concreteWhite = concreteTile('kit:concrete_white', 207, 213, 214);
export const concreteLightGray = concreteTile('kit:concrete_light_gray', 125, 125, 115);
export const concreteGray = concreteTile('kit:concrete_gray', 55, 58, 62);
export const concreteBlack = concreteTile('kit:concrete_black', 8, 10, 15);
export const concreteBrown = concreteTile('kit:concrete_brown', 96, 60, 32);
export const concreteRed = concreteTile('kit:concrete_red', 142, 33, 33);
export const concreteOrange = concreteTile('kit:concrete_orange', 224, 97, 0);
export const concreteYellow = concreteTile('kit:concrete_yellow', 241, 175, 21);
export const concreteLime = concreteTile('kit:concrete_lime', 94, 169, 24);
export const concreteGreen = concreteTile('kit:concrete_green', 73, 91, 36);
export const concreteCyan = concreteTile('kit:concrete_cyan', 21, 119, 136);
export const concreteLightBlue = concreteTile('kit:concrete_light_blue', 36, 137, 199);
export const concreteBlue = concreteTile('kit:concrete_blue', 44, 46, 143);
export const concretePurple = concreteTile('kit:concrete_purple', 100, 32, 156);
export const concreteMagenta = concreteTile('kit:concrete_magenta', 169, 48, 159);
export const concretePink = concreteTile('kit:concrete_pink', 213, 101, 143);
