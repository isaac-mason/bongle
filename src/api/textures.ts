/**
 * Script-facing texture API.
 *
 * A texture is the pixel SOURCE — one picture, from disk or computed at bake
 * time from other textures. It is named for what it IS; the consumers that
 * sample it are named for what they are FOR (`tile()` for the 16x16 voxel
 * atlas, `sprite()` for the sprite atlas).
 */

export { texture } from '../core/registry';
export type {
    TextureComputedOptions,
    TextureDef,
    TextureFileOptions,
    TextureHandle,
    TextureOptions,
} from '../core/textures/textures';
