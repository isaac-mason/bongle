// builds a texture atlas from block registry data.
//
// reads source images (declared via blockTexture() or the textures/{name}.png
// convention), composites them into a grid atlas, and writes:
//   resources/client/voxels-atlas.png, the atlas image
//   resources/client/voxels-atlas.json, metadata (tile positions, sizes, hash)
//
// the atlas grid order matches BlockRegistryData.textures[], so the client
// can use textureIndex values directly as grid indices to extract pixel data
// for each layer of its ArrayTexture.
//
// rebuild is gated by the `hash` field in voxels-atlas.json (content hash over
// the source bytes), the artifact IS the cache marker. Missing source images
// get a magenta placeholder tile.
//
// DrawSource frames (procedural / composed block textures) are baked upstream
// by `draw-textures.ts` and threaded in via `bakedDraws` as OffscreenCanvases;
// the composite loop draws them directly.

import type { ResourceLoader } from '../../../src/core/resource-loader';
import type { DrawSource, ModuleVersion } from '../../../src/internal';
import type { Filesystem } from '../../fs';
import { readArtifactHash } from './cache';
import type { BakedDraws } from './draw-textures';
import { canvasPixels, decodeBitmap, encodePng, makeCanvas, scaleTo, sha256HexParts } from './raster';

const TILE_SIZE = 16;
const ATLAS_PNG = 'resources/client/voxels-atlas.png';
const ATLAS_JSON = 'resources/client/voxels-atlas.json';

export type BuildBlockTextureAtlasOptions = {
    /** in-memory canvases for any DrawSource frames in this module, keyed by
     *  descriptor identity. produced by the upstream `bakeDrawTextures` pass.
     *  missing entries → magenta. */
    bakedDraws: BakedDraws;
    /** consult the on-disk hash sidecar and skip the build when it matches. */
    cache: boolean;
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** the editor project filesystem the atlas artifacts write into
     *  (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
};

export type BlockTextureAtlasMetadata = {
    tileSize: number;
    columns: number;
    rows: number;
    atlasWidth: number;
    atlasHeight: number;
    /** texture names in order (same as BlockRegistryData.textures) */
    textures: string[];
    /** content hash over the source bytes; the rebuild cache marker. */
    hash: string;
};

/** one resolved tile source: a raw registry ref (URL / project-relative
 *  string) or the DrawSource descriptor for procedural frames. */
type TileSource = string | DrawSource;

/** loaded tile: decoded bytes (file) or a baked canvas (draw), plus the
 *  hash input that gates rebuilds. `null` bytes/canvas → magenta. */
type LoadedTile =
    | { kind: 'file'; bytes: Uint8Array | null; hashPart: string | Uint8Array }
    | { kind: 'draw'; canvas: OffscreenCanvas | null; hashPart: string | Uint8ClampedArray };

/**
 * build the texture atlas from the block registry's texture list.
 * returns true if the atlas was rebuilt, false if skipped (unchanged).
 */
export async function buildBlockTextureAtlas(module: ModuleVersion, opts: BuildBlockTextureAtlasOptions): Promise<boolean> {
    const { bakedDraws, cache, loader, fs } = opts;

    const textures = module.blocks.textures;

    if (textures.length === 0) {
        // No textures, but still emit a valid empty manifest so the client
        // always gets a well-formed atlas (0 layers) rather than a 404. Drop
        // the PNG (nothing references it at 0 layers). The empty `hash` reads
        // back falsy, so change gates treat it like a missing atlas.
        await fs.remove(ATLAS_PNG);
        await fs.write(
            ATLAS_JSON,
            JSON.stringify(
                { tileSize: TILE_SIZE, columns: 0, rows: 0, atlasWidth: 0, atlasHeight: 0, textures: [], hash: '' },
                null,
                2,
            ),
        );
        return false;
    }

    const sources = resolveSources(textures, module);

    // load phase: pull bytes / baked canvases up front so we can content-hash
    // before deciding whether to composite.
    const loaded: LoadedTile[] = await Promise.all(
        sources.map(async (src, i): Promise<LoadedTile> => {
            if (typeof src !== 'string') {
                const canvas = bakedDraws.get(src) ?? null;
                if (!canvas) {
                    console.warn(`[bongle] block texture "${textures[i]}" is a DrawSource with no baked canvas (magenta)`);
                    return { kind: 'draw', canvas: null, hashPart: 'magenta' };
                }
                return { kind: 'draw', canvas, hashPart: canvasPixels(canvas) };
            }
            let bytes: Uint8Array | null = null;
            try {
                bytes = await loader.loadBytes(src);
            } catch {
                console.warn(`[bongle] texture not found: ${src} (magenta)`);
            }
            return { kind: 'file', bytes, hashPart: bytes ?? `missing:${src}` };
        }),
    );

    const hash = await sha256HexParts(loaded.map((t) => t.hashPart));
    if (cache) {
        const existing = await readArtifactHash(fs, ATLAS_JSON);
        if (existing === hash && (await fs.exists(ATLAS_PNG))) return false;
    }

    const buildStart = performance.now();

    const columns = Math.ceil(Math.sqrt(textures.length));
    const rows = Math.ceil(textures.length / columns);
    const atlasWidth = columns * TILE_SIZE;
    const atlasHeight = rows * TILE_SIZE;
    const { canvas: atlas, ctx } = makeCanvas(atlasWidth, atlasHeight);

    for (let i = 0; i < loaded.length; i++) {
        const tile = loaded[i]!;
        const u = (i % columns) * TILE_SIZE;
        const v = Math.floor(i / columns) * TILE_SIZE;

        let tileCanvas: OffscreenCanvas | null = null;
        if (tile.kind === 'draw') {
            tileCanvas = tile.canvas ? scaleTo(tile.canvas, TILE_SIZE, TILE_SIZE) : null;
        } else if (tile.bytes) {
            const bitmap = await decodeBitmap(tile.bytes);
            tileCanvas = scaleTo(bitmap, TILE_SIZE, TILE_SIZE);
            bitmap.close();
        }

        if (tileCanvas) {
            ctx.drawImage(tileCanvas, u, v);
        } else {
            drawMagenta(ctx, u, v);
        }
    }

    await fs.write(ATLAS_PNG, await encodePng(atlas));
    const metadata: BlockTextureAtlasMetadata = { tileSize: TILE_SIZE, columns, rows, atlasWidth, atlasHeight, textures, hash };
    await fs.write(ATLAS_JSON, JSON.stringify(metadata, null, 2));

    console.log(
        `[bongle] texture atlas built: ${atlasWidth}x${atlasHeight} (${textures.length} tiles) in ${(performance.now() - buildStart).toFixed(0)}ms`,
    );
    return true;
}

// ── internals ───────────────────────────────────────────────────────

/**
 * resolve each texture name to its raw source ref (URL / project-relative
 * string) or the DrawSource descriptor. Animated textures store one frame
 * per registry entry ("lava:0", "lava:1", …); static ones store one. An
 * undeclared name falls back to the `textures/{name}.png` convention.
 */
function resolveSources(textures: string[], module: ModuleVersion): TileSource[] {
    return textures.map((name) => {
        const colonIdx = name.lastIndexOf(':');
        if (colonIdx !== -1) {
            const texId = name.substring(0, colonIdx);
            const frameIdx = parseInt(name.substring(colonIdx + 1), 10);
            const decl = module.blockTextures.get(texId);
            if (decl && Number.isFinite(frameIdx) && frameIdx < decl.frames.length) return decl.frames[frameIdx]!;
        }
        const decl = module.blockTextures.get(name);
        if (decl) return decl.frames[0]!;
        return `textures/${name}.png`;
    });
}

function drawMagenta(ctx: OffscreenCanvasRenderingContext2D, u: number, v: number): void {
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(u, v, TILE_SIZE, TILE_SIZE);
}
