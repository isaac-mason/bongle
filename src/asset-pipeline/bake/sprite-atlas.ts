// builds the sprite atlas from spritesRegistry.
//
// reads source images from each sprite's `src` (one entry per flipbook
// frame), skyline-packs them into a single texture, and writes:
//   resources/client/sprites-atlas.png, the atlas image
//   resources/client/sprites-atlas.json, per-sprite uvRects + sizePx
//
// shape mirrors tile-atlas: content-hash sidecar gates rebuild, missing
// sources get a magenta placeholder, and the shared packer (core/atlas/pack)
// grows the atlas from 256 up to 4096 until all frames fit. Sprites pack at
// texel alignment with their declared padding and ship no mips; that is why
// they are their own atlas rather than tiles in the block one, whose cells are
// 16-aligned so its mip chain stays clean.
//
// computed textures are baked upstream by `bake-textures.ts` and threaded in
// via `bakedTextures` as raster surfaces; the composite draws them directly.

import type { Filesystem } from '../../../os/interface';
import { packAtlas } from '../../core/atlas/pack';
import type { Region } from '../../core/atlas/skyline';
import type { RegistryStore as KindStore } from '../../core/registry';
import type { ResourceLoader } from '../../core/resource-loader';
import type { SpriteAtlasEntry, SpriteAtlasMetadata, SpriteFrameRect } from '../../core/sprites/atlas';
import type { SpriteDef } from '../../core/sprites/sprites';
import type { TextureDef } from '../../core/textures/textures';
import type { BakedTextures } from './bake-textures';
import { readArtifactHash } from './cache';
import type { Raster, RasterCanvas, RasterImage } from './raster';
import { sha256HexParts } from './raster';

const INITIAL_ATLAS_SIZE = 256;
const MAX_ATLAS_SIZE = 4096;
const PLACEHOLDER_SIZE = 16;
const ATLAS_PNG = 'resources/client/sprites-atlas.png';
const ATLAS_JSON = 'resources/client/sprites-atlas.json';

export type BuildSpriteAtlasOptions = {
    /** computed textures baked upstream by `bakeTextures`, keyed by texture id.
     *  missing entries → magenta. */
    bakedTextures: BakedTextures;
    /** the texture store, for resolving each frame's source. */
    textures: KindStore<TextureDef>;
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

/**
 * Build the sprite atlas. Returns true if a rebuild happened, false if
 * skipped because nothing changed.
 */
export async function buildSpriteAtlas(spritesRegistry: KindStore<SpriteDef>, opts: BuildSpriteAtlasOptions): Promise<boolean> {
    const { bakedTextures, textures, cache, loader, fs, raster } = opts;

    const handles = [...spritesRegistry.byId.values()];

    if (handles.length === 0) {
        await fs.remove(ATLAS_PNG);
        await fs.write(
            ATLAS_JSON,
            JSON.stringify({ atlasSize: 0, sprites: {}, hash: '' } satisfies SpriteAtlasMetadata, null, 2),
        );
        return false;
    }

    // sort by id so the packer's input order is deterministic across runs.
    handles.sort((a, b) => (a.spriteId < b.spriteId ? -1 : a.spriteId > b.spriteId ? 1 : 0));

    const items = handles.flatMap(collectFrames);

    // load every frame up front: bitmap/canvas source + dimensions + hash part.
    const loaded = await Promise.all(items.map((it) => loadFrame(it, textures, bakedTextures, loader, raster)));

    const hash = await computeBuildHash(handles, loaded);
    if (cache) {
        const existing = await readArtifactHash(fs, ATLAS_JSON);
        if (existing === hash && (await fs.exists(ATLAS_PNG))) return false;
    }

    const buildStart = performance.now();
    console.log(`[bongle] building sprite atlas (${handles.length} sprites, ${items.length} frames)...`);

    // padding reserves `padding` texels on each side; the frame is drawn at the
    // interior rect the packer reports.
    const result = packAtlas(
        loaded.map((f) => ({ w: f.w, h: f.h, padding: f.padding })),
        1,
        INITIAL_ATLAS_SIZE,
        MAX_ATLAS_SIZE,
    );
    if (!result) {
        throw new Error(`[bongle] sprite atlas: ${items.length} frames don't fit in ${MAX_ATLAS_SIZE}x${MAX_ATLAS_SIZE}`);
    }
    const { atlasSize } = result;
    const packed: PackedFrame[] = loaded.map((f, i) => ({ ...f, ...result.rects[i]! }));

    const { canvas: atlas, ctx } = raster.makeCanvas(atlasSize, atlasSize);
    for (const p of packed) {
        if (p.drawSource) ctx.drawImage(p.drawSource, p.x, p.y);
        else {
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(p.x, p.y, p.w, p.h);
        }
    }
    await fs.write(ATLAS_PNG, await raster.encodePng(atlas));

    // bundle frames back into per-sprite entries.
    const sprites: Record<string, SpriteAtlasEntry> = {};
    let cursor = 0;
    for (const h of handles) {
        const frameCount = h.frames.length;
        const frames: SpriteFrameRect[] = [];
        for (let i = 0; i < frameCount; i++) {
            const p = packed[cursor++]!;
            frames.push({ x: p.x, y: p.y, w: p.w, h: p.h });
        }
        sprites[h.spriteId] = { frames, padding: h.padding, mipmap: h.mipmap };
    }

    await fs.write(ATLAS_JSON, JSON.stringify({ atlasSize, sprites, hash } satisfies SpriteAtlasMetadata, null, 2));

    console.log(
        `[bongle] sprite atlas built: ${atlasSize}x${atlasSize} (${handles.length} sprites, ${items.length} frames) in ${(performance.now() - buildStart).toFixed(0)}ms`,
    );
    return true;
}

// ── internals ───────────────────────────────────────────────────────

type FrameItem = {
    spriteId: string;
    frameIdx: number;
    padding: number;
    /** the texture this frame comes from. */
    textureId: string;
};

type LoadedFrame = FrameItem & {
    /** draw source (bitmap/canvas), null → magenta. */
    drawSource: RasterImage | RasterCanvas | null;
    w: number;
    h: number;
    /** hash input for the rebuild gate. */
    hashPart: string | Uint8Array | Uint8ClampedArray;
};

type PackedFrame = LoadedFrame & Region;

function collectFrames(def: SpriteDef): FrameItem[] {
    return def.frames.map((dep, frameIdx) => ({
        spriteId: def.spriteId,
        frameIdx,
        padding: def.padding,
        textureId: dep.id,
    }));
}

async function loadFrame(
    item: FrameItem,
    textures: KindStore<TextureDef>,
    baked: BakedTextures,
    loader: ResourceLoader,
    raster: Raster,
): Promise<LoadedFrame> {
    const def = textures.byId.get(item.textureId);
    if (def === undefined) {
        console.warn(
            `[bongle] sprite "${item.spriteId}" frame ${item.frameIdx} texture '${item.textureId}' is not declared (magenta)`,
        );
        return { ...item, drawSource: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE, hashPart: `missing:${item.textureId}` };
    }
    if (def.from === 'computed') {
        const canvas = baked.get(item.textureId);
        if (!canvas) {
            console.warn(
                `[bongle] sprite "${item.spriteId}" frame ${item.frameIdx} texture '${item.textureId}' has no baked canvas (magenta)`,
            );
            return { ...item, drawSource: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE, hashPart: 'magenta' };
        }
        return { ...item, drawSource: canvas, w: canvas.width, h: canvas.height, hashPart: raster.canvasPixels(canvas) };
    }
    let bytes: Uint8Array;
    try {
        bytes = await loader.loadBytes(def.src);
    } catch {
        console.warn(`[bongle] sprite source not found: ${def.src} (magenta)`);
        return { ...item, drawSource: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE, hashPart: `missing:${def.src}` };
    }
    const bitmap = await raster.decodeBitmap(bytes);
    return { ...item, drawSource: bitmap, w: bitmap.width, h: bitmap.height, hashPart: bytes };
}

async function computeBuildHash(defs: SpriteDef[], frames: LoadedFrame[]): Promise<string> {
    const parts: (string | Uint8Array | Uint8ClampedArray)[] = [];
    for (const h of defs) parts.push(h.spriteId, String(h.padding), h.mipmap ? '1' : '0');
    for (const f of frames) parts.push(f.spriteId, String(f.frameIdx), f.hashPart);
    return sha256HexParts(parts);
}
