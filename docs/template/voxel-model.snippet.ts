// Typechecked snippets for Voxel meshes (VoxelModel).
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    addChild,
    addTrait,
    block,
    createNode,
    createVoxelModel,
    createVoxels,
    onInit,
    script,
    setBlock,
    TransformTrait,
    VoxelMeshTrait,
    WorldTrait,
} from 'bongle';
import { blockTextures } from 'bongle/starter';

const PlankBlock = block('guide:plank', {
    name: 'Plank',
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
});

/* SNIPPET_START: voxel-model */
script(WorldTrait, 'spawn-platform', (ctx) => {
    if (!ctx.client) return; // VoxelMeshTrait is a visual; build the model client-side

    onInit(ctx, () => {
        // a standalone voxel grid, separate from the world, using the room's
        // block registry (ctx.blocks). paint into it with setBlock.
        const grid = createVoxels(ctx.blocks);
        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 4; z++) setBlock(grid, x, 0, z, PlankBlock.defaultKey());
        }

        // wrap the grid in a VoxelModel and draw it through a VoxelMeshTrait
        const platform = createNode({ name: 'platform', realm: 'client' });
        addTrait(platform, TransformTrait);
        addTrait(platform, VoxelMeshTrait).model = createVoxelModel(grid);
        addChild(ctx.node, platform);
    });
});
/* SNIPPET_END: voxel-model */
