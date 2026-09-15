import {
    type BlockShape,
    block,
    blockModel,
    blockPreset,
    blockShape,
    blockState,
    CullType,
    MaterialType,
    type TileHandle,
    VertexAnimation,
} from 'bongle';
import * as soundPreset from './block-sound-presets';
import * as tex from './tiles';

// The ground family draws at one of four y rotations chosen from its world
// position, so a floor or a hillside does not show the 16px tile repeating on a
// grid. It is the most common use of the mechanism in minecraft (grass_block,
// dirt, sand, podzol, mycelium, lily_pad and all sixteen concrete powders are
// one model x four rotations), and it costs four UV sets per block and no extra
// geometry.
//
// It does not replace the tiling discipline in scripts/textures/README.md. It
// weakens what that discipline has to achieve: a texture now only has to
// survive being tiled against rotations of itself.
export const stone = blockPreset.cube('kit:stone', {
    name: 'Stone',
    tags: ['stone', 'ground', 'nature'],
    tiles: tex.stone,
    varyRotation: true,
    sounds: soundPreset.stone,
});

export const dirt = blockPreset.cube('kit:dirt', {
    name: 'Dirt',
    tags: ['dirt', 'ground', 'nature'],
    tiles: tex.dirt,
    varyRotation: true,
    sounds: soundPreset.dirt,
});

export const grass = blockPreset.cube('kit:grass', {
    name: 'Grass',
    tags: ['grass', 'dirt', 'ground', 'nature'],
    tiles: { top: tex.grassTop, bottom: tex.dirt, sides: tex.grassSide },
    varyRotation: true,
    sounds: soundPreset.grass,
});

// farmland (tilled dirt) and dirt path (flattened dirt). both sit 1px below a
// full cube via surfaceHeight, the mesher lowers the top quad and clips the
// side quads to match. CullType.NONE so adjacent full blocks still draw their
// faces flush down past the lowered lip (a SOLID cull would over-cull and leave
// a see-through gap); lightOpacity 15 keeps them light-blocking like dirt.
// surfaceHeight is shape-defining and not exposed by blockPreset.cube, so these
// two stay on raw block().
// tilled soil is dry or wet. Vanilla tracks moisture 0..7 and draws only two
// looks, dry and soaked at 7; the two looks are the state here, and how it
// gets wet (water nearby, rain, a script) is the game's to decide:
// `farmland.stateKey({ moisture: 'wet' })`.
export const FarmlandMoisture = blockState.create({ moisture: blockState.enumeration(['dry', 'wet'] as const) });
export const farmland = block('kit:farmland', {
    name: 'Farmland',
    tags: ['dirt', 'farm', 'crop', 'ground', 'nature'],
    states: FarmlandMoisture,
    defaultState: { moisture: 'dry' },
    model: ({ moisture }) => ({
        type: 'cube',
        tiles: { top: moisture === 'wet' ? tex.farmlandTopWet : tex.farmlandTop, bottom: tex.dirt, sides: tex.dirt },
    }),
    surfaceHeight: 15 / 16,
    cull: CullType.NONE,
    lightOpacity: 15,
    sounds: soundPreset.dirt,
});

export const dirtPath = block('kit:dirt_path', {
    name: 'Dirt Path',
    tags: ['dirt', 'path', 'ground', 'nature'],
    model: () => ({
        type: 'cube',
        tiles: { top: tex.dirtPathTop, bottom: tex.dirt, sides: tex.dirt },
    }),
    surfaceHeight: 15 / 16,
    cull: CullType.NONE,
    lightOpacity: 15,
    sounds: soundPreset.dirt,
});

export const sand = blockPreset.cube('kit:sand', {
    name: 'Sand',
    tags: ['sand', 'ground', 'nature'],
    tiles: tex.sand,
    varyRotation: true,
    sounds: soundPreset.sand,
});

// sandstone's cut faces differ from its banded sides, so it takes the column
// preset (end covers top and bottom) rather than a plain cube.
export const sandstone = blockPreset.column('kit:sandstone', {
    name: 'Sandstone',
    tags: ['sand', 'stone', 'nature'],
    tiles: { end: tex.sandstoneTop, side: tex.sandstoneSide },
    sounds: soundPreset.stone,
});

export const gravel = blockPreset.cube('kit:gravel', {
    name: 'Gravel',
    tags: ['gravel', 'stone', 'ground', 'nature'],
    tiles: tex.gravel,
    varyRotation: true,
    sounds: soundPreset.gravel,
});

// building blocks worked from stone and cobble: the raw cobble cubes plus the
// stairs / slabs / walls / pressure plate for both the stone and cobble lines.

export const cobblestone = blockPreset.cube('kit:cobblestone', {
    name: 'Cobblestone',
    tags: ['stone', 'cobble'],
    tiles: tex.cobblestone,
    sounds: soundPreset.stone,
});

export const mossyCobblestone = blockPreset.cube('kit:mossy_cobblestone', {
    name: 'Mossy Cobblestone',
    tags: ['stone', 'cobble', 'moss', 'nature'],
    tiles: tex.mossyCobblestone,
    sounds: soundPreset.stone,
});

export const stoneStairs = blockPreset.stairs('kit:stone_stairs', {
    name: 'Stone Stairs',
    tags: ['stone', 'stairs'],
    tiles: tex.stone,
    sounds: soundPreset.stone,
});
export const stoneSlab = blockPreset.slab('kit:stone_slab', {
    name: 'Stone Slab',
    tags: ['stone', 'slab'],
    tiles: tex.stone,
    sounds: soundPreset.stone,
});
export const stonePlate = blockPreset.plate('kit:stone_plate', {
    name: 'Stone Pressure Plate',
    tags: ['stone', 'plate'],
    tiles: tex.stone,
    sounds: soundPreset.stone,
});

export const cobblestoneStairs = blockPreset.stairs('kit:cobblestone_stairs', {
    name: 'Cobblestone Stairs',
    tags: ['stone', 'cobble', 'stairs'],
    tiles: tex.cobblestone,
    sounds: soundPreset.stone,
});
export const cobblestoneSlab = blockPreset.slab('kit:cobblestone_slab', {
    name: 'Cobblestone Slab',
    tags: ['stone', 'cobble', 'slab'],
    tiles: tex.cobblestone,
    sounds: soundPreset.stone,
});
export const cobblestoneWall = blockPreset.wall('kit:cobblestone_wall', {
    name: 'Cobblestone Wall',
    tags: ['stone', 'cobble', 'wall', 'fence'],
    tiles: tex.cobblestone,
    sounds: soundPreset.stone,
});

// cut stone in a running bond, with the mossy, cracked and chiseled variants
// and the stairs / slab / wall of the plain block.

export const stoneBricks = blockPreset.cube('kit:stone_bricks', {
    name: 'Stone Bricks',
    tags: ['stone', 'brick', 'building'],
    tiles: tex.stoneBricks,
    sounds: soundPreset.stone,
});
export const mossyStoneBricks = blockPreset.cube('kit:mossy_stone_bricks', {
    name: 'Mossy Stone Bricks',
    tags: ['stone', 'brick', 'building', 'moss', 'nature'],
    tiles: tex.mossyStoneBricks,
    sounds: soundPreset.stone,
});
export const crackedStoneBricks = blockPreset.cube('kit:cracked_stone_bricks', {
    name: 'Cracked Stone Bricks',
    tags: ['stone', 'brick', 'building'],
    tiles: tex.crackedStoneBricks,
    sounds: soundPreset.stone,
});
export const chiseledStoneBricks = blockPreset.cube('kit:chiseled_stone_bricks', {
    name: 'Chiseled Stone Bricks',
    tags: ['stone', 'brick', 'building', 'decor'],
    tiles: tex.chiseledStoneBricks,
    sounds: soundPreset.stone,
});
export const stoneBricksStairs = blockPreset.stairs('kit:stone_bricks_stairs', {
    name: 'Stone Brick Stairs',
    tags: ['stone', 'brick', 'stairs'],
    tiles: tex.stoneBricks,
    sounds: soundPreset.stone,
});
export const stoneBricksSlab = blockPreset.slab('kit:stone_bricks_slab', {
    name: 'Stone Brick Slab',
    tags: ['stone', 'brick', 'slab'],
    tiles: tex.stoneBricks,
    sounds: soundPreset.stone,
});
export const stoneBricksWall = blockPreset.wall('kit:stone_bricks_wall', {
    name: 'Stone Brick Wall',
    tags: ['stone', 'brick', 'wall', 'fence'],
    tiles: tex.stoneBricks,
    sounds: soundPreset.stone,
});

// fired clay bricks with pale mortar, plus the stairs / slab / wall.

export const bricks = blockPreset.cube('kit:bricks', {
    name: 'Bricks',
    tags: ['brick', 'clay', 'building'],
    tiles: tex.bricks,
    sounds: soundPreset.stone,
});
export const bricksStairs = blockPreset.stairs('kit:bricks_stairs', {
    name: 'Brick Stairs',
    tags: ['brick', 'clay', 'stairs'],
    tiles: tex.bricks,
    sounds: soundPreset.stone,
});
export const bricksSlab = blockPreset.slab('kit:bricks_slab', {
    name: 'Brick Slab',
    tags: ['brick', 'clay', 'slab'],
    tiles: tex.bricks,
    sounds: soundPreset.stone,
});
export const bricksWall = blockPreset.wall('kit:bricks_wall', {
    name: 'Brick Wall',
    tags: ['brick', 'clay', 'wall', 'fence'],
    tiles: tex.bricks,
    sounds: soundPreset.stone,
});

// a glowing yellow rock: the block that lights a room the way glowstone does.

export const sunstone = blockPreset.cube('kit:sunstone', {
    name: 'Sunstone',
    tags: ['stone', 'light', 'glow', 'mineral'],
    tiles: tex.sunstone,
    sounds: soundPreset.stone,
    emissive: true,
    lightEmission: [15, 14, 9],
});

export const oakPlanks = blockPreset.cube('kit:oak_planks', {
    name: 'Oak Planks',
    tags: ['wood', 'oak', 'planks'],
    tiles: tex.oakPlanks,
    sounds: soundPreset.wood,
});

export const oakLog = blockPreset.column('kit:oak_log', {
    name: 'Oak Log',
    tags: ['wood', 'oak', 'tree', 'log', 'nature'],
    tiles: { end: tex.oakLogTop, side: tex.oakLogSide },
    sounds: soundPreset.wood,
});

export const oakStairs = blockPreset.stairs('kit:oak_stairs', {
    name: 'Oak Stairs',
    tags: ['wood', 'oak', 'stairs'],
    tiles: tex.oakPlanks,
    sounds: soundPreset.wood,
});
export const oakSlab = blockPreset.slab('kit:oak_slab', {
    name: 'Oak Slab',
    tags: ['wood', 'oak', 'slab'],
    tiles: tex.oakPlanks,
    sounds: soundPreset.wood,
});
export const oakFence = blockPreset.fence('kit:oak_fence', {
    name: 'Oak Fence',
    tags: ['wood', 'oak', 'fence'],
    tiles: tex.oakPlanks,
    sounds: soundPreset.wood,
});

// planks top and bottom, spines on all four sides, which is how minecraft does
// it. luanti's own puts books on the front and back only and adds a facedir so
// you turn the shelf to face the room. more honest for a shelf against a wall,
// but it needs rotation state and a placement the player can get wrong; this
// one reads right in any orientation.
export const bookshelf = blockPreset.cube('kit:bookshelf', {
    name: 'Bookshelf',
    tags: ['wood', 'oak', 'decor', 'book'],
    tiles: { top: tex.oakPlanks, bottom: tex.oakPlanks, sides: tex.bookshelf },
    sounds: soundPreset.wood,
});
export const oakTrapdoor = blockPreset.trapdoor('kit:oak_trapdoor', {
    name: 'Oak Trapdoor',
    tags: ['wood', 'oak', 'door', 'trapdoor'],
    tiles: tex.oakPlanks,
    sounds: soundPreset.wood,
});

// two-cell door (lower + upper). top/bottom tiles reuse oak planks as a
// placeholder until dedicated door art lands. open/close via setDoorOpen.
export const oakDoor = blockPreset.door('kit:oak_door', {
    name: 'Oak Door',
    tags: ['wood', 'oak', 'door'],
    tiles: { top: tex.oakPlanks, bottom: tex.oakPlanks },
    sounds: soundPreset.wood,
});

// fluff is on for oak only, as a spike. the cube self-culls, so an interior
// leaf block emits nothing for its faces, but the 4 fluff planes are uncullable
// and every leaf block pays their 8 quads. worth watching a dense forest for the
// silent-truncation signature (leaves gone from one consistent side) before
// turning it on for anything else.
export const oakLeaves = blockPreset.leaves('kit:oak_leaves', {
    name: 'Oak Leaves',
    tags: ['tree', 'oak', 'foliage', 'plant', 'nature'],
    tiles: tex.oakLeaves,
    // the planes sample the masked blob, not the square leaf tile.
    fluff: tex.oakLeavesFluff,
    varyRotation: true,
    sounds: soundPreset.leaves,
});

// full glass cube. transparent (alpha-cutout) like the glass pane, with
// CullType.SELF so a wall of glass culls its internal shared faces and only
// the outer shell draws, adjacent glass reads as one clear pane.
export const glass = blockPreset.cube('kit:glass', {
    name: 'Glass',
    tags: ['glass', 'window'],
    tiles: tex.glass,
    cull: CullType.SELF,
    material: MaterialType.TRANSPARENT,
    sounds: soundPreset.glass,
});

export const glassPane = blockPreset.pane('kit:glass_pane', {
    name: 'Glass Pane',
    tags: ['glass', 'window', 'pane'],
    tiles: tex.glass,
    sounds: soundPreset.glass,
});

export const snowBlock = blockPreset.cube('kit:snow_block', {
    name: 'Snow Block',
    tags: ['snow', 'ice', 'winter', 'nature'],
    tiles: tex.snow,
    sounds: soundPreset.snow,
});

export const snowSlab = blockPreset.slab('kit:snow_slab', {
    name: 'Snow Slab',
    tags: ['snow', 'winter', 'slab'],
    tiles: tex.snow,
    sounds: soundPreset.snow,
});

export const snowCarpet = blockPreset.carpet('kit:snow_carpet', {
    name: 'Snow Carpet',
    tags: ['snow', 'winter', 'carpet'],
    tiles: tex.snow,
    sounds: soundPreset.snow,
});

// slippery. sneakGuard so crouching stops sliding.
export const ice = blockPreset.cube('kit:ice', {
    name: 'Ice',
    tags: ['ice', 'winter', 'water', 'nature'],
    tiles: tex.ice,
    friction: 0.1,
    sneakGuard: true,
    sounds: soundPreset.ice,
});

// translucent outer shell + opaque inner core, both full cubes. bouncy, slightly slippery.
export const slime = block('kit:slime', {
    name: 'Slime',
    tags: ['slime', 'bounce'],
    model: () => ({
        type: 'custom',
        quads: [
            ...blockModel.box([0, 0, 0], [1, 1, 1], { all: tex.slimeTransparent }, { material: MaterialType.TRANSLUCENT }),
            ...blockModel.box([0.15, 0.15, 0.15], [0.85, 0.85, 0.85], { all: tex.slime }, { material: MaterialType.OPAQUE }),
        ],
    }),
    cull: CullType.SELF,
    restitution: 0.8,
    friction: 0.6,
    sounds: soundPreset.grass,
});

export const water = blockPreset.liquid('kit:water', {
    name: 'Water',
    tags: ['water', 'liquid', 'nature'],
    tiles: { top: tex.waterTop, bottom: tex.waterTop, sides: tex.waterSide },
    viscosity: 0.5,
    translucent: true,
    levels: 8,
    maxHeight: 15 / 16,
    tint: blockPreset.WATER_DEFAULT_TINT,
    sounds: soundPreset.water,
});

export const lava = blockPreset.liquid('kit:lava', {
    name: 'Lava',
    tags: ['lava', 'liquid', 'light', 'fire', 'nature'],
    tiles: { top: tex.lavaTop, bottom: tex.lavaTop, sides: tex.lavaSide },
    viscosity: 1.5,
    levels: 8,
    tint: blockPreset.LAVA_DEFAULT_TINT,
    emissive: true,
    lightEmission: [14, 6, 2],
});

export const mushroomRed = blockPreset.cross('kit:mushroom_red', {
    name: 'Red Mushroom',
    tags: ['mushroom', 'plant', 'fungus', 'nature'],
    tiles: tex.mushroomRed,
    sounds: soundPreset.leaves,
});

export const mushroomBrown = blockPreset.cross('kit:mushroom_brown', {
    name: 'Brown Mushroom',
    tags: ['mushroom', 'plant', 'fungus', 'nature'],
    tiles: tex.mushroomBrown,
    sounds: soundPreset.leaves,
});

// the oak family's start: plant it and grow a tree (the growing is the
// game's; the kit ships the block).
export const oakSapling = blockPreset.cross('kit:oak_sapling', {
    name: 'Oak Sapling',
    tags: ['tree', 'oak', 'plant', 'sapling', 'nature'],
    tiles: tex.oakSapling,
    sounds: soundPreset.leaves,
});

// one-cell crosses like short grass, each with a selection box cut to its own
// sprite (minetest_game's approach) so a low flower does not block aiming at
// the ground around it. No jitter: it moves only the geometry, and a narrow
// box beside its flower reads as broken. Tagged by colour so "blue" finds the
// cornflower.

const flowerShape = (halfWidth: number, height: number) =>
    blockShape.aabbs([[0.5 - halfWidth, 0, 0.5 - halfWidth, 0.5 + halfWidth, height, 0.5 + halfWidth]]);
const flower = (id: string, name: string, tile: TileHandle, colour: string, shape: BlockShape) =>
    blockPreset.cross(id, {
        name,
        tags: ['flower', 'plant', colour, 'nature'],
        tiles: tile,
        shape,
        sounds: soundPreset.leaves,
    });

export const dandelion = flower('kit:dandelion', 'Dandelion', tex.dandelion, 'yellow', flowerShape(4 / 16, 8 / 16));
export const poppy = flower('kit:poppy', 'Poppy', tex.poppy, 'red', flowerShape(3 / 16, 12 / 16));
export const cornflower = flower('kit:cornflower', 'Cornflower', tex.cornflower, 'blue', flowerShape(4 / 16, 14 / 16));
export const allium = flower('kit:allium', 'Allium', tex.allium, 'purple', flowerShape(4 / 16, 14 / 16));
export const oxeyeDaisy = flower('kit:oxeye_daisy', 'Oxeye Daisy', tex.oxeyeDaisy, 'white', flowerShape(4 / 16, 13 / 16));
export const orangeTulip = flower('kit:orange_tulip', 'Orange Tulip', tex.orangeTulip, 'orange', flowerShape(3 / 16, 11 / 16));
export const pinkTulip = flower('kit:pink_tulip', 'Pink Tulip', tex.pinkTulip, 'pink', flowerShape(3 / 16, 11 / 16));
export const lilyOfTheValley = flower(
    'kit:lily_of_the_valley',
    'Lily of the Valley',
    tex.lilyOfTheValley,
    'white',
    flowerShape(4 / 16, 10 / 16),
);
export const babysBreath = flower('kit:babys_breath', "Baby's Breath", tex.babysBreath, 'white', flowerShape(5 / 16, 12 / 16));

// one grass plant, three tufts: the cross preset picks a tile per world
// position and the jitter (vanilla short grass's XYZ offset: a quarter block
// sideways, up to a fifth of a block sunk) takes it off the grid. `grass` is
// the ground cube above; this is vanilla's `short_grass`.
export const shortGrass = blockPreset.cross('kit:short_grass', {
    name: 'Short Grass',
    tags: ['grass', 'plant', 'foliage', 'nature'],
    tiles: tex.shortGrassVariants,
    jitter: { xz: 0.25, y: 0.2 },
    sounds: soundPreset.leaves,
});

// the short tuft grown up, a block and a half tall in one cell: the planes
// reach into the cell above rather than vanilla's two-block plant, so nothing
// has to be placed or broken as a pair. Sideways jitter only, so the roots
// stay on the ground.
export const tallGrass = blockPreset.cross('kit:tall_grass', {
    name: 'Tall Grass',
    tags: ['grass', 'plant', 'foliage', 'nature'],
    tiles: tex.tallGrassVariants,
    height: 1.5,
    jitter: { xz: 0.25 },
    sounds: soundPreset.leaves,
});

// fallen leaves lying under a canopy: a flat cutout layer, three scatterings
// at four rotations, so a forest floor is not one sprite tiled.
export const oakLeafLitter = blockPreset.litter('kit:oak_leaf_litter', {
    name: 'Oak Leaf Litter',
    tags: ['tree', 'oak', 'foliage', 'ground', 'leaves', 'nature'],
    tiles: tex.oakLeafLitterVariants,
    sounds: soundPreset.leaves,
});

// growth stages shared by every crop in the pack, the way doors share one
// DoorState. a crop is a plain `block()`: staging is an `age` state plus a
// model that indexes its tiles by that age, which is too little to be worth a
// preset and too opinionated to make one fit every plant.
export const GROWTH_STAGES = 4;
export const GrowthStage = blockState.create({ age: blockState.int(1, GROWTH_STAGES) });

// every crop's planes lean this far outward at the top, so the tops of a
// planted field fan over the cell edges and close up into one mass.
export const CROP_LEAN = 20;

// a crop's selection box grows with it and stays inset from the cell sides, so
// the farmland it stands on can be aimed at past its edges, and a seedling is
// not a full block to the cursor. vanilla's `CropBlock.SHAPE_BY_AGE`, with
// the sides brought in. `heights` per stage, in blocks.
const cropShape = (heights: readonly [number, number, number, number]) => {
    const boxes = heights.map((h) => blockShape.aabbs([[2 / 16, 0, 2 / 16, 14 / 16, h, 14 / 16]]));
    return ({ age }: { age: number }) => boxes[age - 1]!;
};
const LOW_CROP_SHAPE = cropShape([0.2, 0.4, 0.6, 0.75]);
const BUSH_SHAPE = cropShape([0.3, 0.5, 0.75, 0.9]);
const TALL_CROP_SHAPE = cropShape([0.4, 0.8, 1, 1]);

// green shoots through to ripe gold. `blockModel.hash` is the crop shape: four
// axis-aligned planes that line up across cells, so a field reads as rows.
// place a stage with `wheat.stateKey({ age: n })`, ripe with
// `wheat.stateKey({ age: GROWTH_STAGES })`.
export const wheat = block('kit:wheat', {
    name: 'Wheat',
    tags: ['crop', 'plant', 'farm', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({ type: 'custom' as const, quads: blockModel.hash(tex.wheatStages[age - 1]!, { lean: CROP_LEAN }) }),
    cull: CullType.SELF,
    collision: false,
    // sparse quads, don't filter light. without this, CullType.SELF would
    // default to opacity 1 (like leaves/glass) and dim what's behind.
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// green ferny tops through to a mature rosette with the root shoulder showing.
// same GrowthStage as wheat: four stages is the pack's shared crop cadence.
export const carrot = block('kit:carrot', {
    name: 'Carrot',
    tags: ['crop', 'plant', 'farm', 'vegetable', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({ type: 'custom' as const, quads: blockModel.hash(tex.carrotStages[age - 1]!, { lean: CROP_LEAN }) }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// broad upright leaves on red stems, the bulb shouldering out of the soil at
// maturity. a third silhouette next to carrot's fan and potato's bands.
export const beetroot = block('kit:beetroot', {
    name: 'Beetroot',
    tags: ['crop', 'plant', 'farm', 'vegetable', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({ type: 'custom' as const, quads: blockModel.hash(tex.beetrootStages[age - 1]!, { lean: CROP_LEAN }) }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// leafy bush with tan tuber shoulders at maturity. deliberately a different
// silhouette from carrot, upright bands against carrot's spreading fan, so the
// two read apart in a mixed field rather than as one plant in two greens.
export const potato = block('kit:potato', {
    name: 'Potato',
    tags: ['crop', 'plant', 'farm', 'vegetable', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({ type: 'custom' as const, quads: blockModel.hash(tex.potatoStages[age - 1]!, { lean: CROP_LEAN }) }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// a head of leaves: the leaning `hash` and the `cross` together, twelve quads,
// so the head is dense from every angle. A seedling is the cross alone; the
// hash's leaning outer leaves come in as it grows.
export const cabbage = block('kit:cabbage', {
    name: 'Cabbage',
    tags: ['crop', 'plant', 'farm', 'vegetable', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => {
        const leaf = tex.cabbageStages[age - 1]!;
        const quads =
            age < 3 ? blockModel.cross(leaf) : [...blockModel.hash(leaf, { lean: CROP_LEAN }), ...blockModel.cross(leaf)];
        return { type: 'custom' as const, quads };
    },
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// corn grows past the cell: a cross that starts as a sprout and reaches a
// block and a half when ripe, sampling the bottom of a 16x32 tile at every
// stage so the texel density never changes. The first crop on the tall-plane
// machinery, and the reason it exists for crops at all.
const CORN_HEIGHT = [0.6, 1, 1.3, 1.5];
export const corn = block('kit:corn', {
    name: 'Corn',
    tags: ['crop', 'plant', 'farm', 'vegetable', 'nature'],
    shape: TALL_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({
        type: 'custom' as const,
        quads: blockModel.cross(tex.cornStages[age - 1]!, { height: CORN_HEIGHT[age - 1], tileBlocks: 2 }),
    }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// a low spreading plant: the leaning hash like carrot, flowers at stage 3,
// berries at 4.
export const strawberry = block('kit:strawberry', {
    name: 'Strawberry',
    tags: ['crop', 'plant', 'farm', 'fruit', 'berry', 'nature'],
    shape: LOW_CROP_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => ({
        type: 'custom' as const,
        quads: blockModel.hash(tex.strawberryStages[age - 1]!, { lean: CROP_LEAN + 5 }),
    }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

// an upright bush: the hash barely leaning plus the cross through the middle,
// so it is dense from every side, berries at 4.
export const blueberry = block('kit:blueberry', {
    name: 'Blueberry',
    tags: ['crop', 'plant', 'farm', 'fruit', 'berry', 'bush', 'nature'],
    shape: BUSH_SHAPE,
    states: GrowthStage,
    defaultState: { age: 1 },
    model: ({ age }) => {
        const bush = tex.blueberryStages[age - 1]!;
        return { type: 'custom' as const, quads: [...blockModel.hash(bush, { lean: 8 }), ...blockModel.cross(bush)] };
    },
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    sounds: soundPreset.leaves,
});

export const ladder = blockPreset.ladder('kit:ladder', {
    name: 'Ladder',
    tags: ['wood', 'climb', 'ladder'],
    tiles: tex.ladder,
    sounds: soundPreset.wood,
});

// a hanging or standing light on a chain handle; hangs from a chain or any
// solid ceiling, stands on any solid floor. lit by default, put out with
// setLanternLit.
export const lantern = blockPreset.lantern('kit:lantern', {
    name: 'Lantern',
    tags: ['light', 'metal', 'decor', 'hanging'],
    tiles: { lit: tex.lantern, unlit: tex.lanternOff },
    sounds: soundPreset.metal,
});

// a chain along any axis; hangs from ceilings, runs along walls, and holds a
// lantern below it.
export const chain = blockPreset.chain('kit:chain', {
    name: 'Chain',
    tags: ['metal', 'chain', 'decor', 'hanging'],
    tiles: tex.chain,
    sounds: soundPreset.metal,
});

// fire: a cross on an eight-frame flipbook. Lights like a torch and a half,
// blocks nothing. Spread and burning are gameplay and live in a script, not
// the block.
const FIRE_SHAPE = blockShape.aabbs([[1 / 16, 0, 1 / 16, 15 / 16, 10 / 16, 15 / 16]]);
export const fire = block('kit:fire', {
    name: 'Fire',
    tags: ['fire', 'light', 'hazard'],
    shape: FIRE_SHAPE,
    model: () => ({ type: 'custom' as const, quads: blockModel.cross(tex.fire) }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
    emissive: true,
    lightEmission: [15, 10, 4],
});

// a cobweb across the cell: a still cross (not the plant preset, which sways
// in the wind), walk-through. Slowing whatever is inside it is a script's
// job for now.
export const cobweb = block('kit:cobweb', {
    name: 'Cobweb',
    tags: ['web', 'cobweb', 'spider', 'decor'],
    model: () => ({ type: 'custom' as const, quads: blockModel.cross(tex.cobweb) }),
    cull: CullType.SELF,
    collision: false,
    lightOpacity: 0,
    material: MaterialType.TRANSPARENT,
});

export const torch = blockPreset.torch('kit:torch', {
    name: 'Torch',
    tags: ['light', 'wood', 'fire'],
    tiles: tex.torch,
    sounds: soundPreset.wood,
});

// rgb variants, same preset, colored-flame texture + custom lightEmission per channel.
export const redTorch = blockPreset.torch('kit:red_torch', {
    name: 'Red Torch',
    tags: ['light', 'wood', 'fire', 'color'],
    tiles: tex.redTorch,
    lightEmission: [15, 0, 0],
    sounds: soundPreset.wood,
});
export const greenTorch = blockPreset.torch('kit:green_torch', {
    name: 'Green Torch',
    tags: ['light', 'wood', 'fire', 'color'],
    tiles: tex.greenTorch,
    lightEmission: [0, 15, 0],
    sounds: soundPreset.wood,
});
export const blueTorch = blockPreset.torch('kit:blue_torch', {
    name: 'Blue Torch',
    tags: ['light', 'wood', 'fire', 'color'],
    tiles: tex.blueTorch,
    lightEmission: [0, 0, 15],
    sounds: soundPreset.wood,
});

// all 16 dye colors mirroring Minecraft's palette. soft cloth: leaves sounds
// (snappy dig). kept as individual exports so bundlers tree-shake unused colors.
export const woolWhite = blockPreset.cube('kit:wool_white', {
    name: 'White Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolWhite,
    sounds: soundPreset.leaves,
});
export const woolLightGray = blockPreset.cube('kit:wool_light_gray', {
    name: 'Light Gray Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolLightGray,
    sounds: soundPreset.leaves,
});
export const woolGray = blockPreset.cube('kit:wool_gray', {
    name: 'Gray Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolGray,
    sounds: soundPreset.leaves,
});
export const woolBlack = blockPreset.cube('kit:wool_black', {
    name: 'Black Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolBlack,
    sounds: soundPreset.leaves,
});
export const woolBrown = blockPreset.cube('kit:wool_brown', {
    name: 'Brown Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolBrown,
    sounds: soundPreset.leaves,
});
export const woolRed = blockPreset.cube('kit:wool_red', {
    name: 'Red Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolRed,
    sounds: soundPreset.leaves,
});
export const woolOrange = blockPreset.cube('kit:wool_orange', {
    name: 'Orange Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolOrange,
    sounds: soundPreset.leaves,
});
export const woolYellow = blockPreset.cube('kit:wool_yellow', {
    name: 'Yellow Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolYellow,
    sounds: soundPreset.leaves,
});
export const woolLime = blockPreset.cube('kit:wool_lime', {
    name: 'Lime Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolLime,
    sounds: soundPreset.leaves,
});
export const woolGreen = blockPreset.cube('kit:wool_green', {
    name: 'Green Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolGreen,
    sounds: soundPreset.leaves,
});
export const woolCyan = blockPreset.cube('kit:wool_cyan', {
    name: 'Cyan Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolCyan,
    sounds: soundPreset.leaves,
});
export const woolLightBlue = blockPreset.cube('kit:wool_light_blue', {
    name: 'Light Blue Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolLightBlue,
    sounds: soundPreset.leaves,
});
export const woolBlue = blockPreset.cube('kit:wool_blue', {
    name: 'Blue Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolBlue,
    sounds: soundPreset.leaves,
});
export const woolPurple = blockPreset.cube('kit:wool_purple', {
    name: 'Purple Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolPurple,
    sounds: soundPreset.leaves,
});
export const woolMagenta = blockPreset.cube('kit:wool_magenta', {
    name: 'Magenta Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolMagenta,
    sounds: soundPreset.leaves,
});
export const woolPink = blockPreset.cube('kit:wool_pink', {
    name: 'Pink Wool',
    tags: ['wool', 'cloth', 'color'],
    tiles: tex.woolPink,
    sounds: soundPreset.leaves,
});

// all 16 dye colors, each as a full cube plus slab and stairs. the tiles are
// one shared grain base tinted per color at bake time (see ./tiles), so
// this section is pure composition. hard mineral surface: stone sounds. kept as
// individual exports so bundlers tree-shake unused colors and shapes.
export const concreteWhite = blockPreset.cube('kit:concrete_white', {
    name: 'White Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteWhite,
    sounds: soundPreset.stone,
});
export const concreteWhiteSlab = blockPreset.slab('kit:concrete_white_slab', {
    name: 'White Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteWhite,
    sounds: soundPreset.stone,
});
export const concreteWhiteStairs = blockPreset.stairs('kit:concrete_white_stairs', {
    name: 'White Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteWhite,
    sounds: soundPreset.stone,
});

export const concreteLightGray = blockPreset.cube('kit:concrete_light_gray', {
    name: 'Light Gray Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteLightGray,
    sounds: soundPreset.stone,
});
export const concreteLightGraySlab = blockPreset.slab('kit:concrete_light_gray_slab', {
    name: 'Light Gray Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteLightGray,
    sounds: soundPreset.stone,
});
export const concreteLightGrayStairs = blockPreset.stairs('kit:concrete_light_gray_stairs', {
    name: 'Light Gray Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteLightGray,
    sounds: soundPreset.stone,
});

export const concreteGray = blockPreset.cube('kit:concrete_gray', {
    name: 'Gray Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteGray,
    sounds: soundPreset.stone,
});
export const concreteGraySlab = blockPreset.slab('kit:concrete_gray_slab', {
    name: 'Gray Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteGray,
    sounds: soundPreset.stone,
});
export const concreteGrayStairs = blockPreset.stairs('kit:concrete_gray_stairs', {
    name: 'Gray Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteGray,
    sounds: soundPreset.stone,
});

export const concreteBlack = blockPreset.cube('kit:concrete_black', {
    name: 'Black Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteBlack,
    sounds: soundPreset.stone,
});
export const concreteBlackSlab = blockPreset.slab('kit:concrete_black_slab', {
    name: 'Black Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteBlack,
    sounds: soundPreset.stone,
});
export const concreteBlackStairs = blockPreset.stairs('kit:concrete_black_stairs', {
    name: 'Black Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteBlack,
    sounds: soundPreset.stone,
});

export const concreteBrown = blockPreset.cube('kit:concrete_brown', {
    name: 'Brown Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteBrown,
    sounds: soundPreset.stone,
});
export const concreteBrownSlab = blockPreset.slab('kit:concrete_brown_slab', {
    name: 'Brown Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteBrown,
    sounds: soundPreset.stone,
});
export const concreteBrownStairs = blockPreset.stairs('kit:concrete_brown_stairs', {
    name: 'Brown Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteBrown,
    sounds: soundPreset.stone,
});

export const concreteRed = blockPreset.cube('kit:concrete_red', {
    name: 'Red Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteRed,
    sounds: soundPreset.stone,
});
export const concreteRedSlab = blockPreset.slab('kit:concrete_red_slab', {
    name: 'Red Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteRed,
    sounds: soundPreset.stone,
});
export const concreteRedStairs = blockPreset.stairs('kit:concrete_red_stairs', {
    name: 'Red Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteRed,
    sounds: soundPreset.stone,
});

export const concreteOrange = blockPreset.cube('kit:concrete_orange', {
    name: 'Orange Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteOrange,
    sounds: soundPreset.stone,
});
export const concreteOrangeSlab = blockPreset.slab('kit:concrete_orange_slab', {
    name: 'Orange Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteOrange,
    sounds: soundPreset.stone,
});
export const concreteOrangeStairs = blockPreset.stairs('kit:concrete_orange_stairs', {
    name: 'Orange Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteOrange,
    sounds: soundPreset.stone,
});

export const concreteYellow = blockPreset.cube('kit:concrete_yellow', {
    name: 'Yellow Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteYellow,
    sounds: soundPreset.stone,
});
export const concreteYellowSlab = blockPreset.slab('kit:concrete_yellow_slab', {
    name: 'Yellow Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteYellow,
    sounds: soundPreset.stone,
});
export const concreteYellowStairs = blockPreset.stairs('kit:concrete_yellow_stairs', {
    name: 'Yellow Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteYellow,
    sounds: soundPreset.stone,
});

export const concreteLime = blockPreset.cube('kit:concrete_lime', {
    name: 'Lime Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteLime,
    sounds: soundPreset.stone,
});
export const concreteLimeSlab = blockPreset.slab('kit:concrete_lime_slab', {
    name: 'Lime Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteLime,
    sounds: soundPreset.stone,
});
export const concreteLimeStairs = blockPreset.stairs('kit:concrete_lime_stairs', {
    name: 'Lime Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteLime,
    sounds: soundPreset.stone,
});

export const concreteGreen = blockPreset.cube('kit:concrete_green', {
    name: 'Green Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteGreen,
    sounds: soundPreset.stone,
});
export const concreteGreenSlab = blockPreset.slab('kit:concrete_green_slab', {
    name: 'Green Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteGreen,
    sounds: soundPreset.stone,
});
export const concreteGreenStairs = blockPreset.stairs('kit:concrete_green_stairs', {
    name: 'Green Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteGreen,
    sounds: soundPreset.stone,
});

export const concreteCyan = blockPreset.cube('kit:concrete_cyan', {
    name: 'Cyan Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteCyan,
    sounds: soundPreset.stone,
});
export const concreteCyanSlab = blockPreset.slab('kit:concrete_cyan_slab', {
    name: 'Cyan Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteCyan,
    sounds: soundPreset.stone,
});
export const concreteCyanStairs = blockPreset.stairs('kit:concrete_cyan_stairs', {
    name: 'Cyan Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteCyan,
    sounds: soundPreset.stone,
});

export const concreteLightBlue = blockPreset.cube('kit:concrete_light_blue', {
    name: 'Light Blue Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});
export const concreteLightBlueSlab = blockPreset.slab('kit:concrete_light_blue_slab', {
    name: 'Light Blue Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});
export const concreteLightBlueStairs = blockPreset.stairs('kit:concrete_light_blue_stairs', {
    name: 'Light Blue Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteLightBlue,
    sounds: soundPreset.stone,
});

export const concreteBlue = blockPreset.cube('kit:concrete_blue', {
    name: 'Blue Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteBlue,
    sounds: soundPreset.stone,
});
export const concreteBlueSlab = blockPreset.slab('kit:concrete_blue_slab', {
    name: 'Blue Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteBlue,
    sounds: soundPreset.stone,
});
export const concreteBlueStairs = blockPreset.stairs('kit:concrete_blue_stairs', {
    name: 'Blue Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteBlue,
    sounds: soundPreset.stone,
});

export const concretePurple = blockPreset.cube('kit:concrete_purple', {
    name: 'Purple Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concretePurple,
    sounds: soundPreset.stone,
});
export const concretePurpleSlab = blockPreset.slab('kit:concrete_purple_slab', {
    name: 'Purple Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concretePurple,
    sounds: soundPreset.stone,
});
export const concretePurpleStairs = blockPreset.stairs('kit:concrete_purple_stairs', {
    name: 'Purple Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concretePurple,
    sounds: soundPreset.stone,
});

export const concreteMagenta = blockPreset.cube('kit:concrete_magenta', {
    name: 'Magenta Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concreteMagenta,
    sounds: soundPreset.stone,
});
export const concreteMagentaSlab = blockPreset.slab('kit:concrete_magenta_slab', {
    name: 'Magenta Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concreteMagenta,
    sounds: soundPreset.stone,
});
export const concreteMagentaStairs = blockPreset.stairs('kit:concrete_magenta_stairs', {
    name: 'Magenta Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concreteMagenta,
    sounds: soundPreset.stone,
});

export const concretePink = blockPreset.cube('kit:concrete_pink', {
    name: 'Pink Concrete',
    tags: ['concrete', 'stone', 'color'],
    tiles: tex.concretePink,
    sounds: soundPreset.stone,
});
export const concretePinkSlab = blockPreset.slab('kit:concrete_pink_slab', {
    name: 'Pink Concrete Slab',
    tags: ['concrete', 'stone', 'color', 'slab'],
    tiles: tex.concretePink,
    sounds: soundPreset.stone,
});
export const concretePinkStairs = blockPreset.stairs('kit:concrete_pink_stairs', {
    name: 'Pink Concrete Stairs',
    tags: ['concrete', 'stone', 'color', 'stairs'],
    tiles: tex.concretePink,
    sounds: soundPreset.stone,
});
