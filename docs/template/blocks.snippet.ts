// Typechecked snippets for Voxels & blocks.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import type { BlockRegistryData, Voxels } from 'bongle';
import {
    AIR,
    asset,
    block,
    blockModel,
    blockPreset,
    blockState,
    CullType,
    chunkData,
    debug,
    ensureChunk,
    ensureChunkPaletteSlot,
    forEachBlock,
    getBlock,
    getBlockState,
    getChunk,
    getChunkAt,
    invalidateChunk,
    MaterialType,
    onBlockBreak,
    onBlockBuild,
    onInit,
    SetBlockFlags,
    setBlock,
    setChunkBlock,
    system,
    tile,
    use,
    VertexAnimation,
    voxelIndex,
} from 'bongle';
import { tiles } from 'bongle/kit';

/* SNIPPET_START: first-cube */
// 1. declare a tile from your own image. a tile is one 16x16 entry in the voxel
//    atlas. drop the .png in assets/ and point src at it with
//    asset(rel, import.meta.url).
const StoneTile = tile('guide:stone', { src: asset('./assets/stone.png', import.meta.url) });

// 2. wrap it in a cube. one tile argument paints all six faces the same.
const StoneBlock = blockPreset.cube('guide:stone', { name: 'Stone', tiles: StoneTile });

// keep the handle alive through bundling if nothing else in code references it
use(StoneBlock);
/* SNIPPET_END: first-cube */

/* SNIPPET_START: cube-faces */
// a block can wear a different tile per face. declare one tile per image, then
// pass a per-face map instead of a single tile: top/bottom/sides (a grass-topped
// dirt block), or name all six for full control
// (top/bottom/north/south/east/west).
const GrassTop = tile('guide:grass_top', { src: asset('./assets/grass_top.png', import.meta.url) });
const GrassSide = tile('guide:grass_side', { src: asset('./assets/grass_side.png', import.meta.url) });
const DirtTile = tile('guide:dirt', { src: asset('./assets/dirt.png', import.meta.url) });

const GrassBlock = blockPreset.cube('guide:grass', {
    name: 'Grass',
    // a bare handle is the common case; use `{ tile, rotation }` to turn a face.
    tiles: { top: GrassTop, bottom: DirtTile, sides: GrassSide },
});
use(GrassBlock);
/* SNIPPET_END: cube-faces */

/* SNIPPET_START: block-api */
// every preset is sugar over block(). here is what blockPreset.cross expands to:
// a flower is not a cube at all but two crossed quads (blockModel.cross), plus
// the handful of options that make vegetation behave. reach for block() directly
// whenever a preset's shape or defaults do not fit.
const PoppyTile = tile('guide:poppy', { src: asset('./assets/poppy.png', import.meta.url) });
const PoppyBlock = block('guide:poppy', {
    name: 'Poppy',
    model: () => ({ type: 'custom' as const, quads: blockModel.cross(PoppyTile) }),
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
        debug.log(ctx, key, stateId);

        // AIR is the empty-cell state id: compare a state against it to test for air
        if (getBlockState(ctx.voxels, 0, 1, 0) === AIR) {
            debug.log(ctx, 'nothing above the block');
        }

        // walk every non-air block that has been set
        forEachBlock(ctx.voxels, (x, y, z, blockKey) => {
            debug.log(ctx, 'block at', x, y, z, blockKey);
        });
    });
});
/* SNIPPET_END: edit-world */

/* SNIPPET_START: chunks */
// chunks are 16x16x16. getChunkAt takes the same block coordinates as getBlock.
system('chunk-lookup', (ctx) => {
    onInit(ctx, () => {
        const chunk = getChunkAt(ctx.voxels, 0, 64, 0);

        // undefined means the chunk is not loaded here, which is NOT the same as
        // "all air": getBlock reports air for both, so test with getChunkAt when
        // the difference matters (streaming, worldgen, or a scan you want to skip).
        if (chunk === undefined) {
            debug.log(ctx, 'not loaded yet');
        }

        // already holding chunk coordinates? getChunk takes those directly.
        const origin = getChunk(ctx.voxels, 0, 4, 0);
        debug.log(ctx, origin !== undefined);
    });
});
/* SNIPPET_END: chunks */

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
    model: () => ({ type: 'cube', tiles: { all: tiles.stone } }),
});

// address a specific state by its property values; pass the key to setBlock
const litKey = LampBlock.stateKey({ lit: true });
console.log(litKey);
/* SNIPPET_END: block-states */

/* SNIPPET_START: gen-simple */
// a 64x64 stone platform, one call per block. BULK still settles block-def
// hooks (fences join, stairs shape) but fires no script events.
function generateFlat(voxels: Voxels): void {
    for (let x = 0; x < 64; x++) {
        for (let z = 0; z < 64; z++) {
            setBlock(voxels, x, 0, z, StoneBlock.defaultKey(), SetBlockFlags.BULK);
        }
    }
}
/* SNIPPET_END: gen-simple */

/* SNIPPET_START: gen-chunk */
// the same platform, resolving the chunk once per chunk instead of once per
// block. coordinates are chunk-local now, so the outer loops step in chunks.
function generateFlatByChunk(voxels: Voxels): void {
    for (let cx = 0; cx < 4; cx++) {
        for (let cz = 0; cz < 4; cz++) {
            const chunk = ensureChunk(voxels, cx, 0, cz);
            for (let lx = 0; lx < 16; lx++) {
                for (let lz = 0; lz < 16; lz++) {
                    setChunkBlock(voxels, chunk, lx, 0, lz, StoneBlock.defaultKey(), SetBlockFlags.BULK);
                }
            }
        }
    }
}
/* SNIPPET_END: gen-chunk */

/* SNIPPET_START: gen-raw */
// the same platform again, writing palette slots straight into the chunk array.
function generateFlatRaw(voxels: Voxels, blocks: BlockRegistryData): void {
    for (let cx = 0; cx < 4; cx++) {
        for (let cz = 0; cz < 4; cz++) {
            const chunk = ensureChunk(voxels, cx, 0, cz);
            const data = chunkData(chunk);

            // one slot per key per chunk, reused for every cell below
            const stone = ensureChunkPaletteSlot(chunk, StoneBlock.defaultKey(), blocks);
            for (let lx = 0; lx < 16; lx++) {
                for (let lz = 0; lz < 16; lz++) {
                    data[voxelIndex(lx, 0, lz)] = stone;
                }
            }

            // once per chunk, after the writes: rescan counts, mark mesh-dirty,
            // schedule the relight. nothing above did any of that.
            invalidateChunk(voxels, chunk);
        }
    }
}
/* SNIPPET_END: gen-raw */

system('worldgen', (ctx) => {
    onInit(ctx, () => {
        generateFlat(ctx.voxels);
        generateFlatByChunk(ctx.voxels);
        generateFlatRaw(ctx.voxels, ctx.blocks);
    });
});
