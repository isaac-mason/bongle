import type { ResourceLoader } from '../resource-loader';

// Must match src/asset-pipeline/bake sprite-atlas.

/** UV rect in pixel coords of the atlas; divide by `atlasSize` for 0..1. */
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

/** Fetches and parses the sprite atlas sidecar through the injected loader. Returns null on a missing or unparseable atlas. */
export async function loadAtlasMetadata(loader: ResourceLoader): Promise<SpriteAtlasMetadata | null> {
    try {
        const bytes = await loader.loadBytes('sprites-atlas.json');
        return JSON.parse(new TextDecoder().decode(bytes)) as SpriteAtlasMetadata;
    } catch {
        return null;
    }
}
