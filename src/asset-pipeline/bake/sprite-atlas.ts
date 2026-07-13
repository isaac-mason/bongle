// builds the sprite atlas from spritesRegistry.
//
// reads source images from each sprite's `src` (one entry per flipbook
// frame), skyline-packs them into a single texture, and writes:
//   resources/client/sprites-atlas.png, the atlas image
//   resources/client/sprites-atlas.json, per-sprite uvRects + sizePx
//
// shape mirrors block-texture-atlas: content-hash sidecar gates rebuild,
// missing sources get a magenta placeholder, atlas size starts at 256 and
// doubles up to 4096 until all frames fit.
//
// DrawSource frames are baked upstream by `draw-textures.ts` and threaded in
// via `bakedDraws` as OffscreenCanvases; the composite draws them directly.

import type { ResourceLoader } from '../../core/resource-loader';
import type { DrawSource, KindStore, NormalizedImageSource, Region, SpriteHandle } from '../../internal';
import { addSkylineLevel, emptySkyline, findBestFit } from '../../internal';
import type { Filesystem } from '../filesystem';
import { readArtifactHash } from './cache';
import type { BakedDraws } from './draw-textures';
import { canvasPixels, decodeBitmap, encodePng, makeCanvas, sha256HexParts } from './raster';

const INITIAL_ATLAS_SIZE = 256;
const MAX_ATLAS_SIZE = 4096;
const PLACEHOLDER_SIZE = 16;
const ATLAS_PNG = 'resources/client/sprites-atlas.png';
const ATLAS_JSON = 'resources/client/sprites-atlas.json';

export type BuildSpriteAtlasOptions = {
    /** in-memory canvases for any DrawSource frames in spritesRegistry, keyed
     *  by descriptor identity. produced by `bakeDrawTextures`. missing → magenta. */
    bakedDraws: BakedDraws;
    /** consult the on-disk hash sidecar and skip the build when it matches. */
    cache: boolean;
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** the editor project filesystem the atlas artifacts write into
     *  (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
};

/** uv rect in pixel coords of the atlas. SpriteResources divides by
 *  atlasSize to produce 0..1 sampler uvs. */
export type SpriteFrameRect = { x: number; y: number; w: number; h: number };

export type SpriteAtlasEntry = {
    /** ordered per-frame uv rects. single-element for static sprites. */
    frames: SpriteFrameRect[];
    /** atlas gutter (pixels) on each side of each frame. */
    padding: number;
    /** generate mips for this sprite on the runtime side. */
    mipmap: boolean;
};

export type SpriteAtlasMetadata = {
    atlasSize: number;
    sprites: Record<string, SpriteAtlasEntry>;
    /** content hash over sources + sprite knobs; the rebuild gate. */
    hash: string;
};

/**
 * Build the sprite atlas. Returns true if a rebuild happened, false if
 * skipped because nothing changed.
 */
export async function buildSpriteAtlas(
    spritesRegistry: KindStore<SpriteHandle>,
    opts: BuildSpriteAtlasOptions,
): Promise<boolean> {
    const { bakedDraws, cache, loader, fs } = opts;

    const handles = [...spritesRegistry.byId.values()].map((h) => h.payload);

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
    const loaded = await Promise.all(items.map((it) => loadFrame(it, bakedDraws, loader)));

    const hash = await computeBuildHash(handles, loaded);
    if (cache) {
        const existing = await readArtifactHash(fs, ATLAS_JSON);
        if (existing === hash && (await fs.exists(ATLAS_PNG))) return false;
    }

    const buildStart = performance.now();
    console.log(`[bongle] building sprite atlas (${handles.length} sprites, ${items.length} frames)...`);

    // skyline-pack at increasing sizes until everything fits.
    let atlasSize = INITIAL_ATLAS_SIZE;
    let packed: PackedFrame[] | null = null;
    while (atlasSize <= MAX_ATLAS_SIZE) {
        packed = tryPack(loaded, atlasSize);
        if (packed) break;
        atlasSize *= 2;
    }
    if (!packed) {
        throw new Error(`[bongle] sprite atlas: ${items.length} frames don't fit in ${MAX_ATLAS_SIZE}x${MAX_ATLAS_SIZE}`);
    }

    const { canvas: atlas, ctx } = makeCanvas(atlasSize, atlasSize);
    for (const p of packed) {
        if (p.drawSource) ctx.drawImage(p.drawSource, p.x, p.y);
        else {
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(p.x, p.y, p.w, p.h);
        }
    }
    await fs.write(ATLAS_PNG, await encodePng(atlas));

    // bundle frames back into per-sprite entries.
    const sprites: Record<string, SpriteAtlasEntry> = {};
    let cursor = 0;
    for (const h of handles) {
        const frameCount = Array.isArray(h.src) ? h.src.length : 1;
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
    /** raw registry ref (URL / project-relative) or DrawSource descriptor. */
    source: string | DrawSource;
};

type LoadedFrame = FrameItem & {
    /** draw source (bitmap/canvas), null → magenta. */
    drawSource: CanvasImageSource | null;
    w: number;
    h: number;
    /** hash input for the rebuild gate. */
    hashPart: string | Uint8Array | Uint8ClampedArray;
};

type PackedFrame = LoadedFrame & Region;

function collectFrames(handle: SpriteHandle): FrameItem[] {
    const srcs: NormalizedImageSource[] = Array.isArray(handle.src) ? handle.src : [handle.src];
    return srcs.map((s, frameIdx) => ({ spriteId: handle.spriteId, frameIdx, padding: handle.padding, source: s }));
}

async function loadFrame(item: FrameItem, bakedDraws: BakedDraws, loader: ResourceLoader): Promise<LoadedFrame> {
    if (typeof item.source !== 'string') {
        const canvas = bakedDraws.get(item.source);
        if (!canvas) {
            console.warn(`[bongle] sprite "${item.spriteId}" frame ${item.frameIdx} DrawSource has no baked canvas (magenta)`);
            return { ...item, drawSource: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE, hashPart: 'magenta' };
        }
        return { ...item, drawSource: canvas, w: canvas.width, h: canvas.height, hashPart: canvasPixels(canvas) };
    }
    let bytes: Uint8Array;
    try {
        bytes = await loader.loadBytes(item.source);
    } catch {
        console.warn(`[bongle] sprite source not found: ${item.source} (magenta)`);
        return { ...item, drawSource: null, w: PLACEHOLDER_SIZE, h: PLACEHOLDER_SIZE, hashPart: `missing:${item.source}` };
    }
    const bitmap = await decodeBitmap(bytes);
    return { ...item, drawSource: bitmap, w: bitmap.width, h: bitmap.height, hashPart: bytes };
}

/**
 * Skyline-pack at `atlasSize`. Returns null on overflow so the caller can
 * retry at a larger size. Padding reserves `padding` pixels on each side; the
 * frame is drawn at the inset position and the recorded uv rect points at the
 * frame interior.
 */
function tryPack(frames: LoadedFrame[], atlasSize: number): PackedFrame[] | null {
    // pack tallest-first for skyline efficiency; preserve original order so
    // the caller can recombine frames per sprite without losing position.
    const indices = frames.map((_, i) => i);
    indices.sort((a, b) => frames[b]!.h + frames[b]!.padding * 2 - (frames[a]!.h + frames[a]!.padding * 2));

    const skyline = emptySkyline(atlasSize);
    const out: PackedFrame[] = new Array(frames.length);
    for (const idx of indices) {
        const f = frames[idx]!;
        const padW = f.w + f.padding * 2;
        const padH = f.h + f.padding * 2;
        if (padW > atlasSize || padH > atlasSize) return null;

        const fit = findBestFit(skyline, atlasSize, padW, padH);
        if (!fit) return null;
        addSkylineLevel(skyline, fit.nodeIdx, fit.x, fit.y, padW, padH);

        out[idx] = { ...f, x: fit.x + f.padding, y: fit.y + f.padding, w: f.w, h: f.h };
    }
    return out;
}

async function computeBuildHash(handles: SpriteHandle[], frames: LoadedFrame[]): Promise<string> {
    const parts: (string | Uint8Array | Uint8ClampedArray)[] = [];
    for (const h of handles) parts.push(h.spriteId, String(h.padding), h.mipmap ? '1' : '0');
    for (const f of frames) parts.push(f.spriteId, String(f.frameIdx), f.hashPart);
    return sha256HexParts(parts);
}
