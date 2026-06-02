export type {
    ClipChannel,
    ClipChannelProperty,
    ClipChannels,
    ClipDef,
    MeshId,
    ModelHandle,
} from '../core/models/handle';
export type { ModelHandleMap, ModelOptions } from '../core/models/models';
export { model } from '../core/models/models';

export { BUILTIN_BASE_AVATAR_ID, baseAvatar } from '../core/player/base-avatar';

export type { AABB, BlockShape, BlockShapeAabbs, BlockShapeCube } from '../core/voxels/block-collider';
export * as blockShape from '../core/voxels/block-collider';
export * as blockModel from '../core/voxels/block-model';
export * as blockPreset from '../core/voxels/block-presets';
export type {
    BlockRegistry as BlockRegistryData,
} from '../core/voxels/block-registry';
export {
    AIR,
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_FENCE,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_PANE,
    BLOCK_FLAG_SELECTION,
    BLOCK_FLAG_SNEAK_GUARD,
    BLOCK_FLAG_WALL,
    encodeVertexAnimation,
    MISSING,
} from '../core/voxels/block-registry';
export * as blockState from '../core/voxels/block-state';
export type {
    BlockHandle,
    BlockModel,
    BlockOptions,
    BlockSoundConfig,
    BlockTextureDef,
    BlockTextureOptions,
    BlockQuad,
    CubeModel,
    CubeTextures,
    CustomModel,
    TextureRef,
} from '../core/voxels/blocks';
export { block, blockTexture, CullType, MaterialType, resolveTextureRef, VertexAnimation } from '../core/voxels/blocks';
export { propagateAllLight } from '../core/voxels/light';
export type { VoxelRaycastResult } from '../core/voxels/voxel-raycast';
export { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
export type { Chunk, Voxels, VoxelsAuthority } from '../core/voxels/voxels';
export {
    BLOCK_AIR,
    blockTopCenter,
    CHUNK_BITS,
    CHUNK_SIZE,
    CHUNK_VOLUME,
    chunkKey,
    clearVoxelsAuthority,
    createChunk,
    createVoxels,
    createVoxelsAuthority,
    ensureChunk,
    getBlock,
    getBlockKey,
    getChunkBlock,
    getChunkBlockKey,
    resolveAllChunks,
    resolveChunk,
    setBlock,
    setChunkBlock,
    toChunkCoord,
    toLocalCoord,
    voxelIndex,
    worldToBlockCoord,
} from '../core/voxels/voxels';
