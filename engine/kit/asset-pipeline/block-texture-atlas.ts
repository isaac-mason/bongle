// builds a texture atlas from block registry data.
//
// reads source PNGs from the project's textures/ directory, composites
// them into a grid atlas, and writes:
//   resources/client/voxels-atlas.png   — the atlas image
//   resources/client/voxels-atlas.json  — metadata (tile positions, sizes, hash)
//
// the atlas grid order matches BlockRegistryData.textures[], so the
// client can use textureIndex values directly as grid indices to
// extract pixel data for each layer of its ArrayTexture.
//
// rebuild is gated by the `hash` field in voxels-atlas.json — the
// artifact IS the cache marker, no separate cache file. Same convention
// the offline-renderer icon tasks use; cold-start wipe just deletes the
// artifact files. Missing source textures get a magenta placeholder tile.
//
// DrawSource frames (procedural / composed block textures) are baked
// upstream by `draw-textures.ts` and threaded in via `bakedDraws`.
// Frames whose declaration is a DrawSource land here as `null` in
// `resolveSourcePaths`; the composite loop consults `bakedDraws` for
// the rendered canvas, falling back to magenta if the bake pass didn't
// produce one (registry mismatch / cycle error etc).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { resolveSrcToAbsPath } from './util';
import type { DrawSource, ModuleVersion } from 'bongle/internal';
import { readArtifactHashSync } from '../cache';
import type { BakedDraws } from './draw-textures';

// ── constants ───────────────────────────────────────────────────────

const TILE_SIZE = 16;

export type BuildBlockTextureAtlasOptions = {
    /** absolute path to the project root. All input + output paths resolve
     *  against this — no reliance on process.cwd(). */
    projectDir: string;
    /** in-memory canvases for any DrawSource frames in this module,
     *  keyed by descriptor identity. produced by the upstream
     *  `bakeDrawTextures` pass. missing entries → magenta. */
    bakedDraws: BakedDraws;
    /** consult the on-disk hash sidecar and skip the build when it matches.
     *  dev HMR passes true (upstream revision gate already filtered the
     *  call); prod build paths pass false because the sidecar's DrawSource
     *  entries collapse to a constant `'draw'` marker and can mask draw-fn
     *  changes between build invocations. */
    cache: boolean;
};

// ── atlas metadata (written to json, read by client) ────────────────

export type BlockTextureAtlasMetadata = {
    tileSize: number;
    columns: number;
    rows: number;
    atlasWidth: number;
    atlasHeight: number;
    /** texture names in order (same as BlockRegistryData.textures) */
    textures: string[];
    /** content hash — sources hash + ICON_PX. Acts as the rebuild cache
     *  marker (read back on next run via readArtifactHashSync) and is
     *  folded into downstream icon tasks' input hashes so texture pixel
     *  changes invalidate the icon caches transitively. */
    hash: string;
};

// ── public api ──────────────────────────────────────────────────────

/**
 * build the texture atlas from the block registry's texture list.
 *
 * for each texture name in registry.textures, looks for a source file:
 *   1. if declared via blockTexture(), uses blockTextures.get(name).src
 *   2. otherwise, resolves as textures/{name}.png (convention)
 *
 * missing source files get a magenta placeholder tile.
 *
 * returns true if the atlas was rebuilt, false if skipped (unchanged).
 */
export async function buildBlockTextureAtlas(module: ModuleVersion, opts: BuildBlockTextureAtlasOptions): Promise<boolean> {
    const { projectDir, bakedDraws, cache } = opts;
    const atlasDir = path.join(projectDir, 'resources', 'client');
    const atlasPng = path.join(atlasDir, 'voxels-atlas.png');
    const atlasJson = path.join(atlasDir, 'voxels-atlas.json');

    const registry = module.blocks;
    const textures = registry.textures;

    if (textures.length === 0) {
        // no textures — drop any leftover artifacts so downstream icon tasks
        // hash a clean slate. Deleting the JSON also clears the cache marker,
        // so the next non-empty build rebuilds unconditionally.
        try { fs.unlinkSync(atlasPng); } catch { /* missing is fine */ }
        try { fs.unlinkSync(atlasJson); } catch { /* missing is fine */ }
        return false;
    }

    const sources = resolveSources(textures, module, projectDir);

    // hash (sorted paths + file mtimes) drives change detection. The PNG
    // is also required: if it was deleted (e.g. a cold-start wipe) we have
    // to rebuild even when the JSON's hash still matches.
    const hash = computeBuildHash(sources);
    if (cache) {
        const existingHash = readArtifactHashSync(atlasJson);
        if (existingHash === hash && fs.existsSync(atlasPng)) {
            return false;
        }
    }

    console.log(`[bongle] building texture atlas (${textures.length} tiles)...`);

    const columns = Math.ceil(Math.sqrt(textures.length));
    const rows = Math.ceil(textures.length / columns);
    const atlasWidth = columns * TILE_SIZE;
    const atlasHeight = rows * TILE_SIZE;

    const composites: sharp.OverlayOptions[] = [];

    for (let i = 0; i < textures.length; i++) {
        const src = sources[i];

        const col = i % columns;
        const row = Math.floor(i / columns);
        const u = col * TILE_SIZE;
        const v = row * TILE_SIZE;

        let tileBuffer: Buffer;

        if (typeof src !== 'string') {
            // DrawSource — look up the in-memory bake produced upstream.
            // Missing entry means bake didn't run / errored out: fall
            // back to magenta + warn rather than failing the whole atlas.
            const canvas = bakedDraws.get(src);
            if (!canvas) {
                tileBuffer = createMagentaTile();
                console.warn(`[bongle] block texture "${textures[i]}" is a DrawSource with no baked canvas (magenta placeholder)`);
            } else {
                const png = await canvas.toBuffer('png');
                tileBuffer = await sharp(png).resize(TILE_SIZE, TILE_SIZE, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer();
            }
        } else if (fs.existsSync(src)) {
            tileBuffer = await sharp(src).resize(TILE_SIZE, TILE_SIZE, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer();
        } else {
            tileBuffer = createMagentaTile();
            console.warn(`[bongle] texture not found: ${src} (using magenta placeholder)`);
        }

        composites.push({
            input: tileBuffer,
            left: u,
            top: v,
            raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
        });
    }

    const atlas = sharp({
        create: {
            width: atlasWidth,
            height: atlasHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    });

    fs.mkdirSync(atlasDir, { recursive: true });
    await atlas.composite(composites).png().toFile(atlasPng);

    const metadata: BlockTextureAtlasMetadata = {
        tileSize: TILE_SIZE,
        columns,
        rows,
        atlasWidth,
        atlasHeight,
        textures,
        hash,
    };
    fs.writeFileSync(atlasJson, JSON.stringify(metadata, null, 2));

    console.log(`[bongle] texture atlas built: ${atlasWidth}x${atlasHeight} (${textures.length} tiles)`);

    return true;
}

// ── internals ───────────────────────────────────────────────────────

/**
 * resolve each texture name to its declaration: an absolute disk path
 * for file-backed frames, or the `DrawSource` descriptor itself for
 * procedural ones (the composite loop looks it up in `bakedDraws`).
 *
 * for animated textures, each frame source is stored separately in
 * BlockTextureDef.frames[]. the registry's texture list already has one
 * entry per frame (e.g. "lava:0", "lava:1", ...), so we need to map
 * each entry back to its source.
 *
 * for static textures declared with blockTexture(), frames has one element.
 * the texture name in the registry is just the id (e.g. "stone").
 *
 * undeclared texture names (plain string refs) fall back to convention:
 * textures/{name}.png
 */
function resolveSources(textures: string[], module: ModuleVersion, projectDir: string): (string | DrawSource)[] {
    return textures.map((name) => {
        const colonIdx = name.lastIndexOf(':');
        if (colonIdx !== -1) {
            const texId = name.substring(0, colonIdx);
            const frameIdx = parseInt(name.substring(colonIdx + 1), 10);
            const decl = module.blockTextures.get(texId);
            if (decl && Number.isFinite(frameIdx) && frameIdx < decl.frames.length) {
                const entry = decl.frames[frameIdx]!;
                return typeof entry === 'string' ? resolveSrcToAbsPath(entry, projectDir) : entry;
            }
        }

        const decl = module.blockTextures.get(name);
        if (decl) {
            const entry = decl.frames[0]!;
            return typeof entry === 'string' ? resolveSrcToAbsPath(entry, projectDir) : entry;
        }

        return path.join(projectDir, 'textures', `${name}.png`);
    });
}

/** compute a hash from source paths + file mtimes for change detection.
 *  path entries are already absolute (resolveSources threads projectDir
 *  through), so no cwd-dependent resolve here. DrawSource entries
 *  participate in the hash via the registry payload's `structuralHash`
 *  upstream (which walks fn bodies), so a fixed 'draw' marker here is
 *  enough to keep this builder's gate stable across runs. */
function computeBuildHash(sources: (string | DrawSource)[]): string {
    const hash = crypto.createHash('sha256');
    for (const src of sources) {
        if (typeof src !== 'string') {
            hash.update('draw');
            continue;
        }
        const srcPath = src;
        hash.update(srcPath);
        try {
            const stat = fs.statSync(srcPath);
            hash.update(String(stat.mtimeMs));
        } catch {
            hash.update('missing');
        }
    }
    return hash.digest('hex');
}

/** create a 16x16 magenta tile as raw rgba buffer */
function createMagentaTile(): Buffer {
    const buf = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
        buf[i * 4] = 255;
        buf[i * 4 + 1] = 0;
        buf[i * 4 + 2] = 255;
        buf[i * 4 + 3] = 255;
    }
    return buf;
}
