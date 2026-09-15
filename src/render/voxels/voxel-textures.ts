import {
    createStorageBuffer,
    d,
    type GpuBuffer,
    layoutStrideOf,
    Source,
    struct,
    Texture,
    type UniformNode,
    uniform,
} from 'gpucat';
import type { Region } from '../../core/atlas/skyline';
import type { ResourceLoader } from '../../core/resource-loader';
import type { Blocks } from '../../core/voxels/block-registry';

/** bytes per pixel (rgba8unorm). */
const BPP = 4;

/** the artifact format this loader reads; anything else is treated as missing. */
const ATLAS_VERSION = 4;

/** mip levels beyond 0 the bake ships; must match tile-atlas's MIP_LEVELS. The
 *  sampler's lodMaxClamp says the same thing to the hardware. */
export const ATLAS_MIP_LEVELS = 3;

/** anisotropic taps for the block atlas, the knob Sodium and VulkanMod expose for
 *  grazing-angle shimmer. Backends clamp it to what the device reports. */
const ATLAS_ANISOTROPY = 8;

/** what a texture index means: where the tile is, and how it animates.
 *  `rect` is the normalised atlas rect `(u, v, w, h)`; `anim` is
 *  `(frameCount, fps, interpolate, 0)`, the registry's `texAnimData` row. */
export const TextureEntry = /* @__PURE__ */ struct('VoxelTextureEntry', {
    rect: d.vec4f,
    anim: d.vec4f,
});
/** floats per entry. */
const ENTRY_F32S = layoutStrideOf(TextureEntry) / 4;
const RECT_OFFSET = 0;
const ANIM_OFFSET = 4;

// must match asset-pipeline/bake/tile-atlas
export type TileAtlasMetadata = {
    version: number;
    atlasWidth: number;
    atlasHeight: number;
    mipLevels: number;
    /** texture names in bake order; `rects[i]` is the rect of `textures[i]`. */
    textures: string[];
    /** level-0 texel rects. */
    rects: Region[];
    /** content hash from the bongle asset pipeline (sources + version). */
    hash: string;
};

/** Loads the atlas manifest. Client fetches it, asset pipeline reads it off disk via the
 *  injected loader, editor reads the vfs. A missing atlas (404 or parse fail) resolves to
 *  null, so the world renders untextured. */
export async function loadAtlasMeta(loader: ResourceLoader): Promise<TileAtlasMetadata | null> {
    try {
        const bytes = await loader.loadBytes('voxels-atlas.json');
        return JSON.parse(new TextDecoder().decode(bytes)) as TileAtlasMetadata;
    } catch {
        return null;
    }
}

export type VoxelTextures = {
    /** the packed block atlas. */
    atlas: Texture;
    /** `TextureEntry` per texture index. The anim half is written here from the
     *  registry; the rect half once the manifest loads. */
    entriesBuffer: GpuBuffer;
    /** `(1 / atlasWidth, 1 / atlasHeight)`, the material's texel size. */
    texelSize: UniformNode<d.vec2f>;
    /** registry.texAnimData this was built against (the HMR refresh compares it). */
    texAnimData: Float32Array;
    /** atlas manifest hash this was built against (null on fetch fail). */
    hash: string | null;
    /** resolves once the atlas pixels finish uploading. */
    ready: Promise<void>;
    /** @internal settled by {@link loadVoxelTextures} once atlas pixels upload. */
    _resolveReady: () => void;
};

/** Build the voxel texture subsystem: the placeholder atlas + rects + texAnim
 *  buffers + the atlas-ready gate. Pixels upload later via {@link loadVoxelTextures}. */
export function createVoxelTextures(registry: Blocks): VoxelTextures {
    const atlas = new Texture(
        { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 },
        {
            format: 'rgba8unorm-srgb',
            // all three linear is what lets the sampler honour maxAnisotropy at all, and
            // what makes the material's texel snap resolve to a crisp one-pixel ramp
            // instead of quantising straight back to nearest. Safe against neighbouring
            // tiles because the bake extrudes a TILE_PADDING border around every tile.
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            anisotropy: ATLAS_ANISOTROPY,
            wrapS: 'clamp-to-edge',
            wrapT: 'clamp-to-edge',
            generateMipmaps: false,
        },
    );
    atlas._gpuSampler.lodMaxClamp = ATLAS_MIP_LEVELS;

    // every rect covers the whole (white) placeholder until the manifest lands;
    // the anim half is the registry's table, already padded to one entry.
    const { texAnimData } = registry;
    const entryCount = texAnimData.length / 4;
    const entries = new Float32Array(entryCount * ENTRY_F32S);
    for (let i = 0; i < entryCount; i++) {
        const base = i * ENTRY_F32S;
        entries[base + RECT_OFFSET + 2] = 1;
        entries[base + RECT_OFFSET + 3] = 1;
        entries[base + ANIM_OFFSET] = texAnimData[i * 4]!;
        entries[base + ANIM_OFFSET + 1] = texAnimData[i * 4 + 1]!;
        entries[base + ANIM_OFFSET + 2] = texAnimData[i * 4 + 2]!;
        entries[base + ANIM_OFFSET + 3] = texAnimData[i * 4 + 3]!;
    }
    const entriesBuffer = createStorageBuffer(d.array(TextureEntry), entries, 'voxel-texture-entries');

    const texelSize = uniform('voxelAtlasTexelSize', d.vec2f);
    texelSize.value = [1, 1];

    const { promise: ready, resolve: _resolveReady } = Promise.withResolvers<void>();
    return {
        atlas,
        entriesBuffer,
        texelSize,
        texAnimData,
        hash: null,
        ready,
        _resolveReady,
    };
}

/** Fetches the server-built atlas manifest and uploads its pixels, settling textures.ready.
 *  By default the upload is fire-and-forget; with serialize, the returned promise awaits
 *  the pixel upload before resolving, which the WebGPU backend needs before compiling the
 *  voxel computes. */
export async function loadVoxelTextures(
    textures: VoxelTextures,
    registry: Blocks,
    loader: ResourceLoader,
    meta?: TileAtlasMetadata | null,
    serialize = false,
): Promise<void> {
    // start the level-0 download before resolving the manifest, since the PNG doesn't
    // depend on it and awaiting first would stack two serial round trips on a cold client.
    const pixelBytes = registry.textures.length > 0 ? loader.loadBytes('voxels-atlas.png') : null;
    pixelBytes?.catch(() => {});

    let resolvedMeta = meta !== undefined ? meta : await loadAtlasMeta(loader);
    if (resolvedMeta && resolvedMeta.version !== ATLAS_VERSION) {
        console.warn(`[voxel-textures] atlas manifest is version ${resolvedMeta.version}, need ${ATLAS_VERSION}; rebake`);
        resolvedMeta = null;
    }
    textures.hash = resolvedMeta?.hash ?? null;

    const atlasWrite =
        resolvedMeta && pixelBytes && resolvedMeta.textures.length > 0
            ? writeAtlas(textures, registry, resolvedMeta, loader, pixelBytes)
            : Promise.resolve();
    if (serialize) {
        await atlasWrite.catch((e) => console.warn('[voxel-textures] atlas load failed:', e));
        textures._resolveReady();
        return;
    }
    atlasWrite
        .then(() => {
            console.log('[voxel-textures] atlas loaded');
            textures._resolveReady();
        })
        .catch((e) => {
            console.warn('[voxel-textures] atlas load failed:', e);
            textures._resolveReady();
        });
}

/** decode level 0 and the baked levels, then swap them and the rects in. */
async function writeAtlas(
    textures: VoxelTextures,
    registry: Blocks,
    meta: TileAtlasMetadata,
    loader: ResourceLoader,
    pixelBytes: Promise<Uint8Array>,
): Promise<void> {
    const { atlasWidth, atlasHeight } = meta;
    // the level fetches are named by the manifest, so they start here; the
    // client prefetched them by their fixed names, so this is a cache hit.
    const levelBytes: Promise<Uint8Array>[] = [];
    for (let level = 1; level <= meta.mipLevels; level++) levelBytes.push(loader.loadBytes(`voxels-atlas.${level}.png`));
    for (const p of levelBytes) p.catch(() => {});

    const base = await decodeRgba(loader, await pixelBytes, atlasWidth, atlasHeight);

    // A partial chain is worse than none: if any level is missing, let the GPU
    // box-filter the whole chain (no coverage preservation, but no holes).
    let levels: Source[] | null = null;
    try {
        levels = [];
        for (let level = 1; level <= meta.mipLevels; level++) {
            const width = Math.max(1, atlasWidth >> level);
            const height = Math.max(1, atlasHeight >> level);
            const data = await decodeRgba(loader, await levelBytes[level - 1]!, width, height);
            levels.push(new Source({ data, width, height }));
        }
    } catch (e) {
        console.warn('[voxel-textures] baked mip levels unavailable, generating on the GPU:', e);
        levels = null;
    }

    const { atlas } = textures;
    atlas.source = new Source({ data: base, width: atlasWidth, height: atlasHeight });
    atlas.mipmaps = levels ?? [];
    atlas.generateMipmaps = levels === null;
    atlas.needsUpdate = true;

    writeRects(textures, registry.textures, meta);
}

/** normalised rect per registry texture index, matched to the bake by name so a
 *  registry the atlas has not caught up with (an HMR edit mid-bake) still maps
 *  every texture the atlas does have. */
function writeRects(textures: VoxelTextures, textureNames: string[], meta: TileAtlasMetadata): void {
    const metaIndexByName = new Map<string, number>();
    for (let i = 0; i < meta.textures.length; i++) metaIndexByName.set(meta.textures[i]!, i);

    const entries = textures.entriesBuffer.array as Float32Array;
    const invW = 1 / meta.atlasWidth;
    const invH = 1 / meta.atlasHeight;
    const entryCount = entries.length / ENTRY_F32S;
    for (let i = 0; i < textureNames.length && i < entryCount; i++) {
        const metaIdx = metaIndexByName.get(textureNames[i]!);
        if (metaIdx === undefined) continue;
        const { x, y, w, h } = meta.rects[metaIdx]!;
        const base = i * ENTRY_F32S + RECT_OFFSET;
        entries[base] = x * invW;
        entries[base + 1] = y * invH;
        entries[base + 2] = w * invW;
        entries[base + 3] = h * invH;
    }
    textures.entriesBuffer.needsUpdate = true;
    textures.texelSize.value = [invW, invH];
}

/** Decodes PNG bytes to tightly packed RGBA8 of the expected size. The asset pipeline has
 *  no DOM and injects loader.decodeImage (sharp/skia); the browser path is below. */
async function decodeRgba(loader: ResourceLoader, bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    const rgba = loader.decodeImage
        ? (await loader.decodeImage(bytes, 'image/png')).rgba
        : await decodeRgbaInBrowser(bytes, width, height);
    if (rgba.length !== width * height * BPP) throw new Error(`atlas image is not ${width}x${height}`);
    return rgba;
}

/** WebCodecs first, since it hands back raw RGBA with no canvas in the middle. The canvas
 *  fallback is lossy for every partially transparent texel: a 2D backing store is
 *  premultiplied, so the premultiply/un-premultiply round trip quantises low-alpha RGB. */
async function decodeRgbaInBrowser(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    const tightBytes = width * height * BPP;
    if (typeof ImageDecoder !== 'undefined') {
        try {
            const decoder = new ImageDecoder({ data: bytes, type: 'image/png' });
            const { image } = await decoder.decode();
            try {
                if (image.allocationSize({ format: 'RGBA' }) !== tightBytes) throw new Error('unexpected atlas size');
                const rgba = new Uint8Array(tightBytes);
                const [plane] = await image.copyTo(rgba, { format: 'RGBA' });
                // a padded stride would mean the rows don't line up with the width.
                if (plane?.stride !== width * BPP) throw new Error('unexpected atlas stride');
                return rgba;
            } finally {
                image.close();
                decoder.close();
            }
        } catch {
            // no PNG track, or no RGBA conversion on this engine: use the canvas.
        }
    }
    // colorSpaceConversion 'none' skips colour management on decode; the atlas is
    // authored in sRGB and the texture is already srgb-typed.
    const img = await createImageBitmap(new Blob([bytes as unknown as BlobPart]), { colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(width, height);
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.drawImage(img, 0, 0);
    img.close();
    const { data } = ctx2d.getImageData(0, 0, width, height);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
