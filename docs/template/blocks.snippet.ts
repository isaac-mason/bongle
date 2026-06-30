// Typechecked snippets for Voxels & blocks.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    AIR,
    block,
    blockState,
    forEachBlock,
    getBlock,
    getBlockState,
    log,
    onBlockBreak,
    onBlockBuild,
    onInit,
    script,
    setBlock,
    WorldTrait,
} from 'bongle';
import { blockTextures } from 'bongle/starter';

/* SNIPPET_START: define-block */
// declare a block type at module scope. a cube model maps a texture to its
// faces; `all` covers every face (use top/bottom/sides to differ them).
const RubyBlock = block('guide:ruby', {
    name: 'RubyBlock Block',
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
});
/* SNIPPET_END: define-block */

/* SNIPPET_START: edit-world */
// read and write blocks through ctx.voxels, addressed by world x/y/z
script(WorldTrait, 'place-ruby', (ctx) => {
    onInit(ctx, () => {
        // write a block; server edits replicate to clients automatically
        setBlock(ctx.voxels, 0, 0, 0, RubyBlock.defaultKey());

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
script(WorldTrait, 'ruby-events', (ctx) => {
    onBlockBuild(ctx, RubyBlock, (ev) => {
        console.log('placed at', ev.worldX, ev.worldY, ev.worldZ);
    });
    onBlockBreak(ctx, RubyBlock, (ev) => {
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
