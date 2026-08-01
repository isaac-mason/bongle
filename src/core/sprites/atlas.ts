// Sprite atlas sidecar metadata, CPU-owned.
//
// `sprites-atlas.json` is a build-pipeline sidecar describing where each sprite
// landed in the atlas (pixel rects) + per-sprite flags. It is pure CPU asset data
// — nothing GPU about it — so it lives here, loaded once via the ResourceLoader
// and held on `Resources.spriteAtlas`. Two consumers read it: the render layer's
// `SpriteResources` (derives normalized frame UVs + the pixel-extrusion bake) and
// script-API helpers like `spriteWorldSize` (native pixel dims). Neither reaches
// through the renderer for it.

import type { ResourceLoader } from '../resource-loader';

// ── sidecar shape (must match src/asset-pipeline/bake sprite-atlas) ──

/** uv rect in pixel coords of the atlas. divide by `atlasSize` for 0..1. */
export type SpriteFrameRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

export type SpriteAtlasEntry = {
    frames: SpriteFrameRect[];
    padding: number;
    mipmap: boolean;
};

export type SpriteAtlasMetadata = {
    atlasSize: number;
    sprites: Record<string, SpriteAtlasEntry>;
    hash: string;
};

/**
 * Fetch + parse the sprite atlas sidecar through the injected loader (prod:
 * `fetch(assetUrl)`; editor: vfs). A missing atlas (404 / parse fail) → null.
 * Loaded into `Resources.spriteAtlas` at boot + on HMR atlas change.
 */
export async function loadAtlasMetadata(loader: ResourceLoader): Promise<SpriteAtlasMetadata | null> {
    try {
        const bytes = await loader.loadBytes('sprites-atlas.json');
        return JSON.parse(new TextDecoder().decode(bytes)) as SpriteAtlasMetadata;
    } catch {
        return null;
    }
}
