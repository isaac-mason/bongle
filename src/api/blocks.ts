export type {
    ClipChannel,
    ClipChannelProperty,
    ClipChannels,
    ClipDef,
    MeshId,
    ModelDef,
    ModelHandle,
} from '../core/models/handle';
export type { ModelHandleMap, ModelOptions } from '../core/models/models';
export { BUILTIN_BASE_AVATAR_ID, baseAvatar } from '../core/player/base-avatar';
export { block, model, tile } from '../core/registry';
export type { AABB, BlockShape, BlockShapeAabbs, BlockShapeCube } from '../core/voxels/block-collider';
export * as blockShape from '../core/voxels/block-collider';
// bulk write flag: setBlock(..., SetBlockFlags.BULK) / setChunkBlock(..., BULK) defer
// lighting to a scoped whole-chunk relight + skip inline hooks. for worldgen, paste,
// prefab stamping. plain setBlock (DEFAULT) stays per-block incremental.
export { SetBlockFlags } from '../core/voxels/block-flags';
export * as blockModel from '../core/voxels/block-model';
// directional placement utils, for user-defined directional blocks' `place`.
export * as blockPlace from '../core/voxels/block-place';
export * as blockPreset from '../core/voxels/block-presets';
// door and lantern operations (also reachable via blockPreset.*), top-level
// since they're operations on a placed block, not preset factories.
export { getDoorOpen, getLanternLit, setDoorOpen, setLanternLit } from '../core/voxels/block-presets';
export type { Blocks as BlockRegistryData } from '../core/voxels/block-registry';
export {
    AIR,
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_FENCE,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_PANE,
    BLOCK_FLAG_PATHFINDABLE,
    BLOCK_FLAG_SELECTION,
    BLOCK_FLAG_SNEAK_GUARD,
    BLOCK_FLAG_WALL,
    encodeVertexAnimation,
    keyToBlock,
    MISSING,
    stateToBlock,
} from '../core/voxels/block-registry';
export * as blockState from '../core/voxels/block-state';
export type {
    BlockHandle,
    BlockModel,
    BlockOptions,
    BlockQuad,
    BlockSoundConfig,
    CubeFaceRotation,
    CubeFaceSpec,
    CubeModel,
    CubeTiles,
    CustomModel,
    TileDef,
    TileHandle,
    TileOptions,
} from '../core/voxels/blocks';
export { CullType, faceRotation, faceTile, MaterialType, tileFrame, VertexAnimation } from '../core/voxels/blocks';
export { propagateAllLight, relightChunks } from '../core/voxels/light';
export type { VoxelSweepHit } from '../core/voxels/voxel-aabb-sweep';
export { createVoxelSweepHit, sweepAabbVsVoxels } from '../core/voxels/voxel-aabb-sweep';
export type { VoxelRaycastResult } from '../core/voxels/voxel-raycast';
export { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
export type { Chunk, Voxels, VoxelsAuthority } from '../core/voxels/voxels';
export * from '../core/voxels/voxels';
