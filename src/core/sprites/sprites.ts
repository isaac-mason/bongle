import type { AssetMeta } from '../asset-meta';
import type { DepKey } from '../capture/dep-graph';
import type { TextureHandle } from '../textures/textures';

/** A project-relative path or an `asset()` href. A composed image is a `texture()` instead, which has an id, a hash and real dep edges. */
export type ImageSource = string;

export type SpriteOptions = AssetMeta & {
    /** Source image(s): single entry for static sprites, array for flipbooks (one entry per frame). Each entry declares a texture. */
    src?: ImageSource | ImageSource[];

    /** The textures this sprite's frames come from directly; `src` is sugar that declares textures for you. */
    frames?: TextureHandle[];

    /** Gutter pixels in the atlas to avoid bleed at mip levels. Default 1. */
    padding?: number;
    /** Generate mips for this sprite. Default true; set false for a crisp pixel-art look. */
    mipmap?: boolean;
};

/** The declared data for one sprite. Hashed and swapped wholesale on re-declaration. */
export type SpriteDef = {
    spriteId: string;
    /** Always set, defaults to `spriteId` when the author didn't supply one. */
    name: string;
    tags: readonly string[];
    /** The textures this sprite's frames come from, in order. UV rects + sizes live in the atlas JSON sidecar. */
    frames: DepKey[];
    padding: number;
    mipmap: boolean;
};

/** Stable wrapper around a `SpriteDef`; identity plus the live def. */
export type SpriteHandle = {
    /** The declared id, identity, never changes. */
    readonly id: string;
    dependency: { registry: 'sprites'; id: string };
    /** Re-pointed on every re-declaration. */
    def: SpriteDef;
};
