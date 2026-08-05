// Typechecked snippets for Voxels & blocks.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    AIR,
    asset,
    block,
    blockModel,
    blockPreset,
    blockState,
    blockTexture,
    CullType,
    forEachBlock,
    getBlock,
    getBlockState,
    log,
    MaterialType,
    onBlockBreak,
    onBlockBuild,
    onInit,
    setBlock,
    system,
    use,
    VertexAnimation,
} from 'bongle';
import { blockTextures } from 'bongle/kit';

/* SNIPPET_START: first-cube */
// 1. declare a texture from your own image. drop the .png in assets/ (drawn at
//    16x16) and point src at it with asset(rel, import.meta.url).
const StoneTexture = blockTexture('guide:stone', { src: asset('./assets/stone.png', import.meta.url) });

// 2. wrap it in a cube. one texture argument paints all six faces the same.
const StoneBlock = blockPreset.cube('guide:stone', { name: 'Stone', textures: StoneTexture });

// keep the handle alive through bundling if nothing else in code references it
use(StoneBlock);
/* SNIPPET_END: first-cube */

/* SNIPPET_START: cube-faces */
// a block can draw from several textures, one per face. declare one blockTexture
// per image, then pass a per-face map instead of a single texture: top/bottom/
// sides (a grass-topped dirt block), or name all six for full control
// (top/bottom/north/south/east/west).
const GrassTop = blockTexture('guide:grass_top', { src: asset('./assets/grass_top.png', import.meta.url) });
const GrassSide = blockTexture('guide:grass_side', { src: asset('./assets/grass_side.png', import.meta.url) });
const DirtTexture = blockTexture('guide:dirt', { src: asset('./assets/dirt.png', import.meta.url) });

const GrassBlock = blockPreset.cube('guide:grass', {
    name: 'Grass',
    textures: {
        top: { texture: GrassTop },
        bottom: { texture: DirtTexture },
        sides: { texture: GrassSide },
    },
});
use(GrassBlock);
/* SNIPPET_END: cube-faces */

/* SNIPPET_START: block-api */
// every preset is sugar over block(). here is what blockPreset.plant expands to:
// a flower is not a cube at all but two crossed quads (blockModel.cross), plus
// the handful of options that make vegetation behave. reach for block() directly
// whenever a preset's shape or defaults do not fit.
const PoppyTexture = blockTexture('guide:poppy', { src: asset('./assets/poppy.png', import.meta.url) });
const PoppyBlock = block('guide:poppy', {
    name: 'Poppy',
    model: () => ({ type: 'custom' as const, quads: blockModel.cross(PoppyTexture) }),
    collision: false, // walk straight through it
    cull: CullType.SELF, // only hide faces against other poppies, never neighbours
    lightOpacity: 0, // sparse quads, let light pass instead of shadowing
    material: MaterialType.TRANSPARENT, // cutout alpha around the petals
    vertexAnimation: VertexAnimation.PLANT_WIND_SWAY, // sway in the wind
});
use(PoppyBlock);
/* SNIPPET_END: block-api */

/* SNIPPET_START: edit-world */
// read and write blocks through ctx.voxels, addressed by world x/y/z
system('place-grass', (ctx) => {
    onInit(ctx, () => {
        // write a block; server edits replicate to clients automatically
        setBlock(ctx.voxels, 0, 0, 0, GrassBlock.defaultKey());

        // read a block's key, and its numeric state id (block kind + block state)
        const key = getBlock(ctx.voxels, 0, 0, 0);
        const stateId = getBlockState(ctx.voxels, 0, 0, 0);
        log(ctx, key, stateId);

        // AIR is the empty-cell state id: compare a state against it to test for air
        if (getBlockState(ctx.voxels, 0, 1, 0) === AIR) {
            log(ctx, 'nothing above the block');
        }

        // walk every non-air block that has been set
        forEachBlock(ctx.voxels, (x, y, z, blockKey) => {
            log(ctx, 'block at', x, y, z, blockKey);
        });
    });
});
/* SNIPPET_END: edit-world */

/* SNIPPET_START: block-events */
// react when a block of this type is placed or broken (server-only)
system('grass-events', (ctx) => {
    onBlockBuild(ctx, GrassBlock, (ev) => {
        console.log('placed at', ev.worldX, ev.worldY, ev.worldZ);
    });
    onBlockBreak(ctx, GrassBlock, (ev) => {
        console.log('broke at', ev.worldX, ev.worldY, ev.worldZ);
    });
});
/* SNIPPET_END: block-events */

/* SNIPPET_START: block-states */
// a block with a boolean `lit` property, so it has two states
const LampBlock = block('guide:lamp', {
    name: 'LampBlock',
    states: blockState.create({ lit: blockState.bool() }),
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
});

// address a specific state by its property values; pass the key to setBlock
const litKey = LampBlock.stateKey({ lit: true });
console.log(litKey);
/* SNIPPET_END: block-states */
