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

import { block, blockModel, blockPreset, CullType, MaterialType } from 'bongle';
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

// ── Slime ───────────────────────────────────────────────────────────

// translucent outer shell + opaque inner core, both full cubes. bouncy, slightly slippery.
export const slime = block('kit:slime', {
    name: 'Slime',
    model: () => ({
        type: 'custom',
        quads: [
            ...blockModel.box([0, 0, 0], [1, 1, 1], { all: { texture: tex.slimeTransparent } }, { material: MaterialType.TRANSLUCENT }),
            ...blockModel.box([0.15, 0.15, 0.15], [0.85, 0.85, 0.85], { all: { texture: tex.slime } }, { material: MaterialType.OPAQUE }),
        ],
    }),
    cull: CullType.SELF,
    restitution: 0.8,
    friction: 0.6,
    sounds: soundPreset.grass,
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

// ── Concrete ────────────────────────────────────────────────────────
//
// all 16 dye colors, each as a full cube plus slab and stairs. the textures are
// one shared grain base tinted per color at bake time (see block-textures), so
// this section is pure composition. hard mineral surface: stone sounds. kept as
// individual exports so bundlers tree-shake unused colors and shapes.
export const concreteWhite = blockPreset.cube('kit:concrete_white', {
    name: 'White Concrete',
    textures: tex.concreteWhite,
    sounds: soundPreset.stone,
});
export const concreteWhiteSlab = blockPreset.slab('kit:concrete_white_slab', {
    name: 'White Concrete Slab',
    textures: tex.concreteWhite,
    sounds: soundPreset.stone,
});
export const concreteWhiteStairs = blockPreset.stairs('kit:concrete_white_stairs', {
    name: 'White Concrete Stairs',
    textures: tex.concreteWhite,
    sounds: soundPreset.stone,
});

export const concreteLightGray = blockPreset.cube('kit:concrete_light_gray', {
    name: 'Light Gray Concrete',
    textures: tex.concreteLightGray,
    sounds: soundPreset.stone,
});
export const concreteLightGraySlab = blockPreset.slab('kit:concrete_light_gray_slab', {
    name: 'Light Gray Concrete Slab',
    textures: tex.concreteLightGray,
    sounds: soundPreset.stone,
});
export const concreteLightGrayStairs = blockPreset.stairs('kit:concrete_light_gray_stairs', {
    name: 'Light Gray Concrete Stairs',
    textures: tex.concreteLightGray,
    sounds: soundPreset.stone,
});

export const concreteGray = blockPreset.cube('kit:concrete_gray', {
    name: 'Gray Concrete',
    textures: tex.concreteGray,
    sounds: soundPreset.stone,
});
export const concreteGraySlab = blockPreset.slab('kit:concrete_gray_slab', {
    name: 'Gray Concrete Slab',
    textures: tex.concreteGray,
    sounds: soundPreset.stone,
});
export const concreteGrayStairs = blockPreset.stairs('kit:concrete_gray_stairs', {
    name: 'Gray Concrete Stairs',
    textures: tex.concreteGray,
    sounds: soundPreset.stone,
});

export const concreteBlack = blockPreset.cube('kit:concrete_black', {
    name: 'Black Concrete',
    textures: tex.concreteBlack,
    sounds: soundPreset.stone,
});
export const concreteBlackSlab = blockPreset.slab('kit:concrete_black_slab', {
    name: 'Black Concrete Slab',
    textures: tex.concreteBlack,
    sounds: soundPreset.stone,
});
export const concreteBlackStairs = blockPreset.stairs('kit:concrete_black_stairs', {
    name: 'Black Concrete Stairs',
    textures: tex.concreteBlack,
    sounds: soundPreset.stone,
});

export const concreteBrown = blockPreset.cube('kit:concrete_brown', {
    name: 'Brown Concrete',
    textures: tex.concreteBrown,
    sounds: soundPreset.stone,
});
export const concreteBrownSlab = blockPreset.slab('kit:concrete_brown_slab', {
    name: 'Brown Concrete Slab',
    textures: tex.concreteBrown,
    sounds: soundPreset.stone,
});
export const concreteBrownStairs = blockPreset.stairs('kit:concrete_brown_stairs', {
    name: 'Brown Concrete Stairs',
    textures: tex.concreteBrown,
    sounds: soundPreset.stone,
});

export const concreteRed = blockPreset.cube('kit:concrete_red', {
    name: 'Red Concrete',
    textures: tex.concreteRed,
    sounds: soundPreset.stone,
});
export const concreteRedSlab = blockPreset.slab('kit:concrete_red_slab', {
    name: 'Red Concrete Slab',
    textures: tex.concreteRed,
    sounds: soundPreset.stone,
});
export const concreteRedStairs = blockPreset.stairs('kit:concrete_red_stairs', {
    name: 'Red Concrete Stairs',
    textures: tex.concreteRed,
    sounds: soundPreset.stone,
});

export const concreteOrange = blockPreset.cube('kit:concrete_orange', {
    name: 'Orange Concrete',
    textures: tex.concreteOrange,
    sounds: soundPreset.stone,
});
export const concreteOrangeSlab = blockPreset.slab('kit:concrete_orange_slab', {
    name: 'Orange Concrete Slab',
    textures: tex.concreteOrange,
    sounds: soundPreset.stone,
});
export const concreteOrangeStairs = blockPreset.stairs('kit:concrete_orange_stairs', {
    name: 'Orange Concrete Stairs',
    textures: tex.concreteOrange,
    sounds: soundPreset.stone,
});

export const concreteYellow = blockPreset.cube('kit:concrete_yellow', {
    name: 'Yellow Concrete',
    textures: tex.concreteYellow,
    sounds: soundPreset.stone,
});
export const concreteYellowSlab = blockPreset.slab('kit:concrete_yellow_slab', {
    name: 'Yellow Concrete Slab',
    textures: tex.concreteYellow,
    sounds: soundPreset.stone,
});
export const concreteYellowStairs = blockPreset.stairs('kit:concrete_yellow_stairs', {
    name: 'Yellow Concrete Stairs',
    textures: tex.concreteYellow,
    sounds: soundPreset.stone,
});

export const concreteLime = blockPreset.cube('kit:concrete_lime', {
    name: 'Lime Concrete',
    textures: tex.concreteLime,
    sounds: soundPreset.stone,
});
export const concreteLimeSlab = blockPreset.slab('kit:concrete_lime_slab', {
    name: 'Lime Concrete Slab',
    textures: tex.concreteLime,
    sounds: soundPreset.stone,
});
export const concreteLimeStairs = blockPreset.stairs('kit:concrete_lime_stairs', {
    name: 'Lime Concrete Stairs',
    textures: tex.concreteLime,
    sounds: soundPreset.stone,
});

export const concreteGreen = blockPreset.cube('kit:concrete_green', {
    name: 'Green Concrete',
    textures: tex.concreteGreen,
    sounds: soundPreset.stone,
});
export const concreteGreenSlab = blockPreset.slab('kit:concrete_green_slab', {
    name: 'Green Concrete Slab',
    textures: tex.concreteGreen,
    sounds: soundPreset.stone,
});
export const concreteGreenStairs = blockPreset.stairs('kit:concrete_green_stairs', {
    name: 'Green Concrete Stairs',
    textures: tex.concreteGreen,
    sounds: soundPreset.stone,
});

export const concreteCyan = blockPreset.cube('kit:concrete_cyan', {
    name: 'Cyan Concrete',
    textures: tex.concreteCyan,
    sounds: soundPreset.stone,
});
export const concreteCyanSlab = blockPreset.slab('kit:concrete_cyan_slab', {
    name: 'Cyan Concrete Slab',
    textures: tex.concreteCyan,
    sounds: soundPreset.stone,
});
export const concreteCyanStairs = blockPreset.stairs('kit:concrete_cyan_stairs', {
    name: 'Cyan Concrete Stairs',
    textures: tex.concreteCyan,
    sounds: soundPreset.stone,
});

export const concreteLightBlue = blockPreset.cube('kit:concrete_light_blue', {
    name: 'Light Blue Concrete',
    textures: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});
export const concreteLightBlueSlab = blockPreset.slab('kit:concrete_light_blue_slab', {
    name: 'Light Blue Concrete Slab',
    textures: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});
export const concreteLightBlueStairs = blockPreset.stairs('kit:concrete_light_blue_stairs', {
    name: 'Light Blue Concrete Stairs',
    textures: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});

export const concreteBlue = blockPreset.cube('kit:concrete_blue', {
    name: 'Blue Concrete',
    textures: tex.concreteBlue,
    sounds: soundPreset.stone,
});
export const concreteBlueSlab = blockPreset.slab('kit:concrete_blue_slab', {
    name: 'Blue Concrete Slab',
    textures: tex.concreteBlue,
    sounds: soundPreset.stone,
});
export const concreteBlueStairs = blockPreset.stairs('kit:concrete_blue_stairs', {
    name: 'Blue Concrete Stairs',
    textures: tex.concreteBlue,
    sounds: soundPreset.stone,
});

export const concretePurple = blockPreset.cube('kit:concrete_purple', {
    name: 'Purple Concrete',
    textures: tex.concretePurple,
    sounds: soundPreset.stone,
});
export const concretePurpleSlab = blockPreset.slab('kit:concrete_purple_slab', {
    name: 'Purple Concrete Slab',
    textures: tex.concretePurple,
    sounds: soundPreset.stone,
});
export const concretePurpleStairs = blockPreset.stairs('kit:concrete_purple_stairs', {
    name: 'Purple Concrete Stairs',
    textures: tex.concretePurple,
    sounds: soundPreset.stone,
});

export const concreteMagenta = blockPreset.cube('kit:concrete_magenta', {
    name: 'Magenta Concrete',
    textures: tex.concreteMagenta,
    sounds: soundPreset.stone,
});
export const concreteMagentaSlab = blockPreset.slab('kit:concrete_magenta_slab', {
    name: 'Magenta Concrete Slab',
    textures: tex.concreteMagenta,
    sounds: soundPreset.stone,
});
export const concreteMagentaStairs = blockPreset.stairs('kit:concrete_magenta_stairs', {
    name: 'Magenta Concrete Stairs',
    textures: tex.concreteMagenta,
    sounds: soundPreset.stone,
});

export const concretePink = blockPreset.cube('kit:concrete_pink', {
    name: 'Pink Concrete',
    textures: tex.concretePink,
    sounds: soundPreset.stone,
});
export const concretePinkSlab = blockPreset.slab('kit:concrete_pink_slab', {
    name: 'Pink Concrete Slab',
    textures: tex.concretePink,
    sounds: soundPreset.stone,
});
export const concretePinkStairs = blockPreset.stairs('kit:concrete_pink_stairs', {
    name: 'Pink Concrete Stairs',
    textures: tex.concretePink,
    sounds: soundPreset.stone,
});
