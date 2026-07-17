// ── voxel texture array ─────────────────────────────────────────────
//
// builds a gpucat ArrayTexture for the block registry's texture list.
// each texture name becomes one layer in the array texture.
//
// two-phase approach:
//   1. createVoxelTextureArray(layerCount), sync, immediate. creates an
//      array texture with magenta placeholder layers. the world renders
//      instantly (with magenta blocks) while real textures load.
//   2. loadBlockTextureAtlasIntoTextureArray(atlas, textureNames), async. fetches
//      the server-built atlas PNG, extracts each tile, and writes it
//      into the corresponding layer. progressive enhancement.
//
// nearest magnification for crisp pixel art, with mipmaps + trilinear mip
// blending to kill minification aliasing at distance. all layers are TILE_SIZE².

import { ArrayTexture } from 'gpucat';
import type { ResourceLoader } from '../../core/resource-loader';
import { buildVoxelMipPyramid } from './voxel-mip-pyramid';

// ── constants ───────────────────────────────────────────────────────

/** tile resolution in pixels. all textures are square. */
const TILE_SIZE = 16;

/** bytes per pixel (rgba8unorm). */
const BPP = 4;

/** bytes per tile layer. */
const TILE_BYTES = TILE_SIZE * TILE_SIZE * BPP;

// ── atlas metadata (must match server format) ───────────────────────

export type BlockTextureAtlasMetadata = {
    tileSize: number;
    columns: number;
    rows: number;
    atlasWidth: number;
    atlasHeight: number;
    textures: string[];
    /** content hash from the bongle asset pipeline (sources + tile size). */
    hash: string;
};

// ── create the array texture (sync, white placeholder) ──────────────

/**
 * create a gpucat ArrayTexture with the given number of layers.
 * all layers are filled with white so the world reads neutral while
 * loadBlockTextureAtlasIntoTextureArray() streams in real textures.
 *
 * @param layerCount - number of layers (one per texture in the registry)
 * @returns the ArrayTexture, ready to use in a material
 */
export function createVoxelTextureArray(layerCount: number): ArrayTexture {
    const count = Math.max(layerCount, 1); // at least 1 layer
    const totalBytes = count * TILE_BYTES;
    const data = new Uint8Array(totalBytes).fill(255);

    return new ArrayTexture(data, TILE_SIZE, TILE_SIZE, count, {
        format: 'rgba8unorm-srgb',
        magFilter: 'nearest', // crisp texels up close (pixel art, no blur)
        minFilter: 'nearest', // within a mip level; the levels are pre-averaged
        mipmapFilter: 'linear', // trilinear blend between levels, no LOD popping
        wrapS: 'repeat',
        wrapT: 'repeat',
        // generateMipmaps reserves the full mip chain on the placeholder so the
        // GPU texture is allocated with every level. The real chain is built on
        // the CPU and uploaded as explicit `atlas.mipmaps` once the atlas loads
        // (see writeBlockTextureAtlasIntoTextureArray), premultiplied RGB plus
        // coverage-preserving alpha for cutout layers, which the naive GPU
        // box filter can't do. Each tile is its own layer, so no cross-tile bleed.
        generateMipmaps: true,
    });
}

// ── async atlas loading ─────────────────────────────────────────────

/**
 * fetch the atlas PNG and write each tile into the corresponding layer
 * of the existing ArrayTexture. Caller passes pre-fetched metadata so
 * the hash can be reused for cache decisions upstream.
 *
 * layers that fail to load keep their magenta placeholder. progressive
 * enhancement, the world renders immediately with placeholders, then
 * upgrades to real textures when the PNG arrives.
 *
 * @param atlas - the existing ArrayTexture (created by createVoxelTextureArray)
 * @param textureNames - registry.textures (string[])
 * @param meta - pre-fetched atlas metadata from fetchBlockTextureAtlasMetadata()
 * @param textureCutout - registry.textureCutout (1 per cutout layer)
 */
export async function loadBlockTextureAtlasIntoTextureArray(
    atlas: ArrayTexture,
    textureNames: string[],
    meta: BlockTextureAtlasMetadata,
    textureCutout: Uint8Array,
    loader: ResourceLoader,
): Promise<void> {
    // Empty atlas (0 textures): no PNG is emitted, and there's nothing to load.
    if (meta.textures.length === 0) return;
    // whole-atlas RGBA. Two decode paths (mirrors model-resources): the asset
    // pipeline injects `loader.decodeImage` (node: sharp) → raw bytes, no DOM; the
    // browser/editor client has no decoder → createImageBitmap + OffscreenCanvas
    // (worker-safe, but both absent in node).
    let fullPixels: Uint8Array | Uint8ClampedArray;
    try {
        // bytes through the injected loader (prod: fetch(assetUrl); editor: vfs).
        const bytes = await loader.loadBytes('voxels-atlas.png');
        if (loader.decodeImage) {
            fullPixels = (await loader.decodeImage(bytes, 'image/png')).rgba;
        } else {
            const img = await createImageBitmap(new Blob([bytes as unknown as BlobPart]));
            const canvas = new OffscreenCanvas(meta.atlasWidth, meta.atlasHeight);
            const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx2d.imageSmoothingEnabled = false;
            ctx2d.drawImage(img, 0, 0);
            img.close();
            fullPixels = ctx2d.getImageData(0, 0, meta.atlasWidth, meta.atlasHeight).data;
        }
    } catch {
        return;
    }
    writeBlockTextureAtlasIntoTextureArray(
        atlas,
        textureNames,
        meta,
        new Uint8Array(fullPixels.buffer, fullPixels.byteOffset, fullPixels.byteLength),
        textureCutout,
    );
}

/**
 * Pure (no DOM) variant of `loadBlockTextureAtlasIntoTextureArray` for offline / Node
 * callers, atlas pixels are passed in as a tightly-packed RGBA8
 * buffer of size `meta.atlasWidth * meta.atlasHeight * 4`. Same tile
 * extraction + layer-write logic, just sourced from the supplied buffer
 * instead of a canvas readback.
 */
export function writeBlockTextureAtlasIntoTextureArray(
    atlas: ArrayTexture,
    textureNames: string[],
    meta: BlockTextureAtlasMetadata,
    pixels: Uint8Array,
    textureCutout: Uint8Array,
): void {
    const metaIndexByName = new Map<string, number>();
    for (let i = 0; i < meta.textures.length; i++) {
        metaIndexByName.set(meta.textures[i]!, i);
    }

    const sourceData = atlas.image?.data;
    if (!sourceData || !(sourceData instanceof Uint8Array)) return;

    const atlasStride = meta.atlasWidth * BPP;

    for (let layerIdx = 0; layerIdx < textureNames.length; layerIdx++) {
        const name = textureNames[layerIdx]!;
        const gridIdx = metaIndexByName.get(name);
        if (gridIdx === undefined) continue;

        const col = gridIdx % meta.columns;
        const row = Math.floor(gridIdx / meta.columns);
        const u = col * meta.tileSize;
        const v = row * meta.tileSize;

        const layerOffset = layerIdx * TILE_BYTES;
        if (meta.tileSize === TILE_SIZE) {
            // fast path, row-by-row copy out of the atlas buffer
            for (let y = 0; y < TILE_SIZE; y++) {
                const srcRow = (v + y) * atlasStride + u * BPP;
                const dstRow = layerOffset + y * TILE_SIZE * BPP;
                for (let i = 0; i < TILE_SIZE * BPP; i++) {
                    sourceData[dstRow + i] = pixels[srcRow + i]!;
                }
            }
        } else {
            // slow path, nearest-neighbor resample
            for (let y = 0; y < TILE_SIZE; y++) {
                for (let x = 0; x < TILE_SIZE; x++) {
                    const srcX = Math.floor((x / TILE_SIZE) * meta.tileSize);
                    const srcY = Math.floor((y / TILE_SIZE) * meta.tileSize);
                    const srcOffset = (v + srcY) * atlasStride + (u + srcX) * BPP;
                    const dstOffset = layerOffset + (y * TILE_SIZE + x) * BPP;
                    sourceData[dstOffset] = pixels[srcOffset]!;
                    sourceData[dstOffset + 1] = pixels[srcOffset + 1]!;
                    sourceData[dstOffset + 2] = pixels[srcOffset + 2]!;
                    sourceData[dstOffset + 3] = pixels[srcOffset + 3]!;
                }
            }
        }

        atlas.addLayerUpdate(layerIdx);
    }

    // Build the CPU mip chain from the freshly-written level-0 data and upload
    // it as explicit mips: premultiplied RGB everywhere (no transparent-texel
    // fringe), coverage-preserving alpha on cutout layers (no foliage erosion).
    // This replaces gpucat's naive box-filter generation for this texture.
    atlas.mipmaps = buildVoxelMipPyramid(
        sourceData,
        atlas.depth,
        TILE_SIZE,
        (layer) => layer < textureCutout.length && textureCutout[layer] === 1,
    );
    atlas.generateMipmaps = false;

    atlas.needsUpdate = true;
}
