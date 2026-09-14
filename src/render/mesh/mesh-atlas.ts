import { Texture } from 'gpucat';
import { addSkylineLevel, emptySkyline, findBestFit, type Region, type SkylineNode } from '../../core/atlas/skyline';

export type { Region, SkylineNode };

export type MeshAtlas = {
    /** square atlas; grows from 1024 toward 8192. */
    size: number;
    /** allocated regions, keyed by caller-supplied ownerKey. */
    regions: Map<string, Region>;
    /** GPU texture; format rgba8unorm-srgb (PNG/JPG bytes are sRGB-encoded
     *  per glTF spec, so the GPU decodes to linear at sample time), no mipmaps. */
    texture: Texture;
    /** CPU-side rgba8 backing, `size * size * 4` bytes. Skyline writes
     *  go through this; texture re-uploads on `needsUpdate`. */
    pixels: Uint8Array;
    /** sorted-by-x skyline edges. invariant: nodes cover [0, size]
     *  contiguously, no gaps, no overlaps. */
    skyline: SkylineNode[];
};

/** Construct an empty atlas. `initialSize` defaults to 1024 (1 MiB pixels). */
export function create(initialSize = 1024): MeshAtlas {
    const pixels = new Uint8Array(initialSize * initialSize * 4);
    const texture = new Texture(
        { data: pixels, width: initialSize, height: initialSize },
        {
            format: 'rgba8unorm-srgb',
            magFilter: 'nearest',
            minFilter: 'nearest',
            wrapS: 'clamp-to-edge',
            wrapT: 'clamp-to-edge',
            generateMipmaps: false,
        },
    );
    return {
        size: initialSize,
        regions: new Map(),
        texture,
        pixels,
        skyline: emptySkyline(initialSize),
    };
}

/** Reserve a `w x h` region tagged with `ownerKey`; caller writes pixels into
 *  `atlas.pixels` at the returned offset, then calls `markDirty`. Idempotent, and
 *  returns `null` on overflow (caller decides whether to defrag, grow, or evict). */
export function allocate(atlas: MeshAtlas, w: number, h: number, ownerKey: string): Region | null {
    const existing = atlas.regions.get(ownerKey);
    if (existing) return existing;

    if (w <= 0 || h <= 0 || w > atlas.size || h > atlas.size) return null;

    const fit = findBestFit(atlas.skyline, atlas.size, w, h);
    if (!fit) return null;

    const region: Region = { x: fit.x, y: fit.y, w, h };
    atlas.regions.set(ownerKey, region);
    addSkylineLevel(atlas.skyline, fit.nodeIdx, fit.x, fit.y, w, h);
    return region;
}

/** Free a region by ownerKey. Skyline is not restructured (append-only); reclaim
 *  happens via `defrag`. Pixels stay in `pixels` until overwritten. */
export function release(atlas: MeshAtlas, ownerKey: string): void {
    atlas.regions.delete(ownerKey);
}

/** Flag the texture for full re-upload on next render. */
export function markDirty(atlas: MeshAtlas): void {
    atlas.texture.needsUpdate = true;
}

export type DefragMove = {
    from: Region;
    to: Region;
    ownerKey: string;
};

/** Compact allocated regions to eliminate skyline gaps: sorts by max-side desc and
 *  re-packs. Returns the moves so the caller can patch `meshInfo catalog` uv entries.
 *  Throws if a region no longer fits after compaction (would need a grow). */
export function defrag(atlas: MeshAtlas): { moved: DefragMove[] } {
    const old = Array.from(atlas.regions.entries()).sort(([, a], [, b]) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
    const oldPixels = new Uint8Array(atlas.pixels); // snapshot for blit source

    atlas.regions.clear();
    atlas.skyline = emptySkyline(atlas.size);
    atlas.pixels.fill(0);

    const moved: DefragMove[] = [];
    for (const [key, oldRegion] of old) {
        const fit = findBestFit(atlas.skyline, atlas.size, oldRegion.w, oldRegion.h);
        if (!fit) {
            throw new Error(`MeshAtlas.defrag: "${key}" no longer fits after compaction`);
        }
        const newRegion: Region = { x: fit.x, y: fit.y, w: oldRegion.w, h: oldRegion.h };
        atlas.regions.set(key, newRegion);
        addSkylineLevel(atlas.skyline, fit.nodeIdx, fit.x, fit.y, oldRegion.w, oldRegion.h);

        blitRegion(oldPixels, atlas.pixels, atlas.size, oldRegion, newRegion);
        if (newRegion.x !== oldRegion.x || newRegion.y !== oldRegion.y) {
            moved.push({ from: oldRegion, to: newRegion, ownerKey: key });
        }
    }

    if (moved.length > 0) markDirty(atlas);
    return { moved };
}

/** Free GPU resources. After this the atlas is unusable. */
export function dispose(atlas: MeshAtlas): void {
    atlas.texture.dispose();
    atlas.regions.clear();
    atlas.skyline.length = 0;
}

/** Copy `from` region pixels (in `src`) to `to` region (in `dst`). */
function blitRegion(src: Uint8Array, dst: Uint8Array, size: number, from: Region, to: Region): void {
    const stride = size * 4;
    for (let row = 0; row < from.h; row++) {
        const srcOff = (from.y + row) * stride + from.x * 4;
        const dstOff = (to.y + row) * stride + to.x * 4;
        dst.set(src.subarray(srcOff, srcOff + from.w * 4), dstOff);
    }
}
