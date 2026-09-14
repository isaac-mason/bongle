import type { Filesystem } from '../../../os/interface';
import { packAtlas } from '../../core/atlas/pack';
import type { Region } from '../../core/atlas/skyline';
import { textureStore } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import { BPP, blitRect, buildMipLevels, sliceRect } from '../../core/voxels/mip-levels';
import type { ModuleVersion } from '../../internal';
import type { BakedTextures } from './bake-textures';
import { readArtifactHash } from './cache';
import type { Raster, RasterCanvas, RasterContext2D, RasterImage } from './raster';
import { sha256HexParts } from './raster';

/** cell alignment; every tile side is a multiple of this. */
const TILE_ALIGN = 16;
/** levels beyond 0. 2^MIP_LEVELS = TILE_ALIGN, so the smallest tile's last
 *  level is one texel and every level of every tile is whole texels. */
const MIP_LEVELS = Math.log2(TILE_ALIGN);
const PLACEHOLDER_SIZE = TILE_ALIGN;
const INITIAL_ATLAS_SIZE = 256;
const MAX_ATLAS_SIZE = 8192;
const ATLAS_VERSION = 3;
const ATLAS_PNG = 'resources/client/voxels-atlas.png';
const ATLAS_JSON = 'resources/client/voxels-atlas.json';
const atlasLevelPng = (level: number) => `resources/client/voxels-atlas.${level}.png`;

export type BuildTileAtlasOptions = {
    /** computed textures baked upstream by `bakeTextures`, keyed by texture id.
     *  missing entries → magenta. */
    bakedTextures: BakedTextures;
    /** consult the on-disk hash sidecar and skip the build when it matches. */
    cache: boolean;
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** the editor project filesystem the atlas artifacts write into
     *  (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
    /** host-injected 2d raster (host-provided; see pipeline InitCtx). */
    raster: Raster;
};

export type TileAtlasMetadata = {
    /** artifact format; bumped when the set of files or their layout changes. */
    version: number;
    atlasWidth: number;
    atlasHeight: number;
    /** how many `voxels-atlas.<L>.png` files sit beside the base image. */
    mipLevels: number;
    /** texture names in order (same as BlockRegistryData.textures) */
    textures: string[];
    /** atlas rect of `textures[i]`, in level-0 texels. */
    rects: Region[];
    /** content hash over the source bytes; the rebuild cache marker. */
    hash: string;
};

/** one resolved tile source: the id of the texture this tile comes from, or a
 *  `textures/{name}.png` fallback path for an undeclared name. */
type TileSource = { textureId: string } | { path: string };

/** loaded tile: decoded bytes (file) or a baked canvas (draw), plus the
 *  hash input that gates rebuilds. `null` bytes/canvas → magenta. */
type LoadedTile =
    | { kind: 'file'; bytes: Uint8Array | null; hashPart: string | Uint8Array }
    | { kind: 'draw'; canvas: RasterCanvas | null; hashPart: string | Uint8ClampedArray };

/** a tile ready to composite: its draw source (null → magenta) and size. */
type TileImage = { source: RasterImage | RasterCanvas | null; w: number; h: number };

/**
 * build the texture atlas from the block registry's texture list.
 * returns true if the atlas was rebuilt, false if skipped (unchanged).
 */
export async function buildTileAtlas(module: ModuleVersion, opts: BuildTileAtlasOptions): Promise<boolean> {
    const { bakedTextures, cache, loader, fs, raster } = opts;

    const textures = module.blocks.textures;

    if (textures.length === 0) {
        // emit a valid empty manifest so the client always gets a well-formed atlas rather than
        // a 404; the empty `hash` reads back falsy, so change gates treat it like a missing atlas.
        await fs.remove(ATLAS_PNG);
        for (let level = 1; level <= MIP_LEVELS; level++) await fs.remove(atlasLevelPng(level));
        const empty: TileAtlasMetadata = {
            version: ATLAS_VERSION,
            atlasWidth: 0,
            atlasHeight: 0,
            mipLevels: 0,
            textures: [],
            rects: [],
            hash: '',
        };
        await fs.write(ATLAS_JSON, JSON.stringify(empty, null, 2));
        return false;
    }

    const sources = resolveSources(textures, module);

    // pulls bytes/baked canvases up front so we can content-hash before deciding whether to composite.
    const loaded: LoadedTile[] = await Promise.all(
        sources.map(async (src, i): Promise<LoadedTile> => {
            let path: string | null = 'path' in src ? src.path : null;
            if ('textureId' in src) {
                const def = textureStore.byId.get(src.textureId);
                if (def === undefined) {
                    console.warn(
                        `[bongle] block texture "${textures[i]}" references undeclared texture '${src.textureId}' (magenta)`,
                    );
                    return { kind: 'draw', canvas: null, hashPart: `missing:${src.textureId}` };
                }
                if (def.from !== 'file') {
                    const canvas = bakedTextures.get(src.textureId) ?? null;
                    if (!canvas) {
                        console.warn(
                            `[bongle] block texture "${textures[i]}" texture '${src.textureId}' has no baked canvas (magenta)`,
                        );
                        return { kind: 'draw', canvas: null, hashPart: 'magenta' };
                    }
                    assertTileSize(textures[i]!, canvas.width, canvas.height);
                    return { kind: 'draw', canvas, hashPart: raster.canvasPixels(canvas) };
                }
                path = def.src;
            }
            let bytes: Uint8Array | null = null;
            try {
                bytes = await loader.loadBytes(path!);
            } catch {
                console.warn(`[bongle] texture not found: ${path} (magenta)`);
            }
            return { kind: 'file', bytes, hashPart: bytes ?? `missing:${path}` };
        }),
    );

    // the version is part of the hash so an older artifact never passes the gate.
    const hash = await sha256HexParts([`voxels-atlas:${ATLAS_VERSION}`, ...loaded.map((t) => t.hashPart)]);
    if (cache && (await readArtifactHash(fs, ATLAS_JSON)) === hash && (await artifactsPresent(fs))) return false;

    const buildStart = performance.now();

    // sizes are needed to pack; only a rebuild pays for decoding.
    const images: TileImage[] = await Promise.all(
        loaded.map(async (tile, i): Promise<TileImage> => {
            if (tile.kind === 'draw') {
                return tile.canvas
                    ? { source: tile.canvas, w: tile.canvas.width, h: tile.canvas.height }
                    : { source: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE };
            }
            if (!tile.bytes) return { source: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE };
            const bitmap = await raster.decodeBitmap(tile.bytes);
            assertTileSize(textures[i]!, bitmap.width, bitmap.height);
            return { source: bitmap, w: bitmap.width, h: bitmap.height };
        }),
    );

    const packed = packAtlas(
        images.map(({ w, h }) => ({ w, h, padding: 0 })),
        TILE_ALIGN,
        INITIAL_ATLAS_SIZE,
        MAX_ATLAS_SIZE,
    );
    if (!packed) {
        throw new Error(`[bongle] voxel atlas: ${textures.length} tiles do not fit in ${MAX_ATLAS_SIZE}x${MAX_ATLAS_SIZE}`);
    }
    const { atlasSize, rects } = packed;

    const { canvas: atlas, ctx } = raster.makeCanvas(atlasSize, atlasSize);
    for (let i = 0; i < images.length; i++) {
        const { source } = images[i]!;
        const rect = rects[i]!;
        if (source) ctx.drawImage(source, rect.x, rect.y);
        else drawMagenta(ctx, rect);
        (source as RasterImage | null)?.close?.();
    }
    await fs.write(ATLAS_PNG, await raster.encodePng(atlas));

    // each tile's own mip chain, blitted into the atlas level at the tile's rect halved per level.
    const levelPixels: Uint8Array[] = [];
    for (let level = 1; level <= MIP_LEVELS; level++) {
        const size = atlasSize >> level;
        levelPixels.push(new Uint8Array(size * size * BPP));
    }
    const base = raster.canvasPixels(atlas);
    const cutout = module.blocks.textureCutout;
    for (let i = 0; i < rects.length; i++) {
        const { x, y, w, h } = rects[i]!;
        const isCutout = i < cutout.length && cutout[i] === 1;
        const levels = buildMipLevels(sliceRect(base, atlasSize, x, y, w, h), 1, w, h, MIP_LEVELS, () => isCutout);
        for (let level = 1; level <= MIP_LEVELS; level++) {
            const { data, width, height } = levels[level - 1]!;
            blitRect(levelPixels[level - 1]!, atlasSize >> level, x >> level, y >> level, data, width, height);
        }
    }
    for (let level = 1; level <= MIP_LEVELS; level++) {
        const size = atlasSize >> level;
        await fs.write(atlasLevelPng(level), await raster.encodePng(raster.putPixels(levelPixels[level - 1]!, size, size)));
    }

    const metadata: TileAtlasMetadata = {
        version: ATLAS_VERSION,
        atlasWidth: atlasSize,
        atlasHeight: atlasSize,
        mipLevels: MIP_LEVELS,
        textures,
        rects,
        hash,
    };
    await fs.write(ATLAS_JSON, JSON.stringify(metadata, null, 2));

    console.log(
        `[bongle] texture atlas built: ${atlasSize}x${atlasSize} (${textures.length} tiles) in ${(performance.now() - buildStart).toFixed(0)}ms`,
    );
    return true;
}

/** the same rule `tile()` applies to computed frames at declaration; file frames are only sized here. */
function assertTileSize(name: string, w: number, h: number): void {
    if (w > 0 && h > 0 && w % TILE_ALIGN === 0 && h % TILE_ALIGN === 0) return;
    throw new Error(
        `[bongle] block texture "${name}" is ${w}x${h}; the voxel atlas packs tiles in multiples of ${TILE_ALIGN}x${TILE_ALIGN}`,
    );
}

/** the hash alone is not enough to skip: every level file has to be there. */
async function artifactsPresent(fs: Filesystem): Promise<boolean> {
    if (!(await fs.exists(ATLAS_PNG))) return false;
    for (let level = 1; level <= MIP_LEVELS; level++) {
        if (!(await fs.exists(atlasLevelPng(level)))) return false;
    }
    return true;
}

/** animated textures store one frame per registry entry ("lava:0", "lava:1", ...); static ones
 *  store one. an undeclared name falls back to the `textures/{name}.png` convention. */
function resolveSources(textures: string[], module: ModuleVersion): TileSource[] {
    return textures.map((name) => {
        const colonIdx = name.lastIndexOf(':');
        if (colonIdx !== -1) {
            const texId = name.substring(0, colonIdx);
            const frameIdx = parseInt(name.substring(colonIdx + 1), 10);
            const decl = module.tiles.get(texId);
            if (decl && Number.isFinite(frameIdx) && frameIdx < decl.frames.length) {
                return { textureId: decl.frames[frameIdx]!.id };
            }
        }
        const decl = module.tiles.get(name);
        if (decl) return { textureId: decl.frames[0]!.id };
        return { path: `textures/${name}.png` };
    });
}

function drawMagenta(ctx: RasterContext2D, { x, y, w, h }: Region): void {
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(x, y, w, h);
}
