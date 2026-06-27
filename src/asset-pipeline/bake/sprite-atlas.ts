// builds the sprite atlas from spritesRegistry.
//
// reads source PNGs from each sprite's `src` (one entry per flipbook
// frame), skyline-packs them into a single texture, and writes:
//   resources/client/sprites-atlas.png    — the atlas image
//   resources/client/sprites-atlas.json   — per-sprite uvRects + sizePx
//
// shape mirrors `atlas.ts` (block textures): hash sidecar gates rebuild,
// missing source files get a magenta placeholder, atlas size starts
// at 256 and doubles up to 4096 until all frames fit.
//
// DrawSource frames are baked upstream by `draw-textures.ts` and
// threaded in via `bakedDraws`. Each frame item carries either an
// absolute disk path (file-backed) or the DrawSource descriptor itself
// (procedural); `loadFramePixels` consults `bakedDraws` for the rendered
// canvas, falling back to magenta if the bake didn't produce one.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import type { DrawSource, KindStore, NormalizedImageSource, Region, SpriteHandle } from '../../internal';
import { addSkylineLevel, emptySkyline, findBestFit } from '../../internal';
import { readArtifactHashSync } from './cache';
import type { BakedDraws } from './draw-textures';
import { resolveSrcToAbsPath } from './util';

// ── constants ───────────────────────────────────────────────────────

const INITIAL_ATLAS_SIZE = 256;
const MAX_ATLAS_SIZE = 4096;
const PLACEHOLDER_SIZE = 16;

export type BuildSpriteAtlasOptions = {
    /** absolute path to the project root. */
    projectDir: string;
    /** in-memory canvases for any DrawSource frames in spritesRegistry,
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

// ── sidecar shape (written to json, consumed by SpriteResources) ────

/** uv rect in pixel coords of the atlas. SpriteResources divides by
 *  atlasSize to produce 0..1 sampler uvs. */
export type SpriteFrameRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

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
    /** content hash — sources + sprite knobs. acts as the rebuild gate
     *  (read back next run via readArtifactHashSync). */
    hash: string;
};

// ── public api ──────────────────────────────────────────────────────

/**
 * Build the sprite atlas. Returns true if a rebuild happened, false if
 * skipped because nothing changed.
 */
export async function buildSpriteAtlas(
    spritesRegistry: KindStore<SpriteHandle>,
    opts: BuildSpriteAtlasOptions,
): Promise<boolean> {
    const { projectDir, bakedDraws, cache } = opts;
    const atlasDir = path.join(projectDir, 'resources', 'client');
    const atlasPng = path.join(atlasDir, 'sprites-atlas.png');
    const atlasJson = path.join(atlasDir, 'sprites-atlas.json');

    const handles = [...spritesRegistry.byId.values()].map((h) => h.payload);

    if (handles.length === 0) {
        // empty registry — drop any leftover artifacts so the cache marker
        // resets cleanly. parallels buildBlockTextureAtlas's empty path.
        try {
            fs.unlinkSync(atlasPng);
        } catch {
            /* missing is fine */
        }
        try {
            fs.unlinkSync(atlasJson);
        } catch {
            /* missing is fine */
        }
        return false;
    }

    // sort by id so the packer's input order is deterministic across
    // pipeline runs (same atlas layout for the same registry contents).
    handles.sort((a, b) => (a.spriteId < b.spriteId ? -1 : a.spriteId > b.spriteId ? 1 : 0));

    const items = handles.flatMap((h) => collectFrames(h, projectDir));
    const hash = computeBuildHash(handles, items);

    if (cache) {
        const existingHash = readArtifactHashSync(atlasJson);
        if (existingHash === hash && fs.existsSync(atlasPng)) {
            return false;
        }
    }

    const buildStart = performance.now();
    console.log(`[bongle] building sprite atlas (${handles.length} sprites, ${items.length} frames)...`);

    // load every frame's pixels in parallel so we know dimensions before
    // packing. magenta placeholder for missing files / DrawSource frames
    // (handled in step 10).
    const loaded = await Promise.all(items.map((it) => loadFramePixels(it, bakedDraws)));

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

    fs.mkdirSync(atlasDir, { recursive: true });

    const composites: sharp.OverlayOptions[] = packed.map((p) => ({
        input: p.pixels,
        left: p.x,
        top: p.y,
        raw: { width: p.w, height: p.h, channels: 4 },
    }));

    await sharp({
        create: {
            width: atlasSize,
            height: atlasSize,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite(composites)
        .png()
        .toFile(atlasPng);

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

    const metadata: SpriteAtlasMetadata = { atlasSize, sprites, hash };
    fs.writeFileSync(atlasJson, JSON.stringify(metadata, null, 2));

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
    /** absolute disk path for file-backed frames, or the DrawSource
     *  descriptor for procedural frames (looked up in bakedDraws). */
    source: string | DrawSource;
};

type LoadedFrame = FrameItem & {
    /** raw rgba pixels. */
    pixels: Buffer;
    w: number;
    h: number;
};

type PackedFrame = LoadedFrame & Region;

function collectFrames(handle: SpriteHandle, projectDir: string): FrameItem[] {
    const srcs: NormalizedImageSource[] = Array.isArray(handle.src) ? handle.src : [handle.src];
    return srcs.map((s, frameIdx) => ({
        spriteId: handle.spriteId,
        frameIdx,
        padding: handle.padding,
        source: typeof s === 'string' ? resolveSrcToAbsPath(s, projectDir) : s,
    }));
}

async function loadFramePixels(item: FrameItem, bakedDraws: BakedDraws): Promise<LoadedFrame> {
    if (typeof item.source !== 'string') {
        const canvas = bakedDraws.get(item.source);
        if (!canvas) {
            console.warn(
                `[bongle] sprite "${item.spriteId}" frame ${item.frameIdx} is a DrawSource with no baked canvas (magenta placeholder)`,
            );
            return placeholder(item, PLACEHOLDER_SIZE);
        }
        const png = await canvas.toBuffer('png');
        const img = sharp(png).ensureAlpha();
        const meta = await img.metadata();
        const w = meta.width ?? PLACEHOLDER_SIZE;
        const h = meta.height ?? PLACEHOLDER_SIZE;
        const pixels = await img.raw().toBuffer();
        return { ...item, pixels, w, h };
    }
    if (!fs.existsSync(item.source)) {
        console.warn(`[bongle] sprite source not found: ${item.source} (magenta placeholder)`);
        return placeholder(item, PLACEHOLDER_SIZE);
    }
    const img = sharp(item.source).ensureAlpha();
    const meta = await img.metadata();
    const w = meta.width ?? PLACEHOLDER_SIZE;
    const h = meta.height ?? PLACEHOLDER_SIZE;
    const pixels = await img.raw().toBuffer();
    return { ...item, pixels, w, h };
}

function placeholder(item: FrameItem, size: number): LoadedFrame {
    const pixels = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        pixels[i * 4] = 255;
        pixels[i * 4 + 1] = 0;
        pixels[i * 4 + 2] = 255;
        pixels[i * 4 + 3] = 255;
    }
    return { ...item, pixels, w: size, h: size };
}

/**
 * Skyline-pack at `atlasSize`. Returns null on overflow so the caller
 * can retry at a larger size. Padding is honoured by reserving `padding`
 * pixels on each side — the frame pixels are written at the inset
 * position, and the recorded uv rect points at the frame interior.
 */
function tryPack(frames: LoadedFrame[], atlasSize: number): PackedFrame[] | null {
    // pack tallest-first for skyline efficiency (matches the model-atlas
    // defrag heuristic). preserve original order separately so the
    // caller can recombine frames per sprite without losing position.
    const indices = frames.map((_, i) => i);
    indices.sort((a, b) => {
        const fa = frames[a]!;
        const fb = frames[b]!;
        const ah = fa.h + fa.padding * 2;
        const bh = fb.h + fb.padding * 2;
        return bh - ah;
    });

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

        out[idx] = {
            ...f,
            x: fit.x + f.padding,
            y: fit.y + f.padding,
            w: f.w,
            h: f.h,
        };
    }
    return out;
}

function computeBuildHash(handles: SpriteHandle[], items: FrameItem[]): string {
    const hash = crypto.createHash('sha256');
    for (const h of handles) {
        hash.update(h.spriteId);
        hash.update(String(h.padding));
        hash.update(h.mipmap ? '1' : '0');
    }
    for (const it of items) {
        hash.update(it.spriteId);
        hash.update(String(it.frameIdx));
        if (typeof it.source !== 'string') {
            hash.update('draw');
        } else {
            hash.update(it.source);
            try {
                hash.update(String(fs.statSync(it.source).mtimeMs));
            } catch {
                hash.update('missing');
            }
        }
    }
    return hash.digest('hex');
}
