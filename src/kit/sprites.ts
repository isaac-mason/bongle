import { asset, type SpriteHandle, sprite, texture } from 'bongle';
import {
    beetrootItem as beetrootItemTexture,
    blueberryItem as blueberryItemTexture,
    cabbageItem as cabbageItemTexture,
    carrotItem as carrotItemTexture,
    cornItem as cornItemTexture,
    fontSheet,
    potatoItem as potatoItemTexture,
    strawberryItem as strawberryItemTexture,
    wheatItem as wheatItemTexture,
    white as whiteTexture,
} from './textures';

const GLYPH_FIRST_CODE = 0x20;
const GLYPH_COUNT = 95;
const GLYPH_CELL = 8;
const GLYPH_COLUMNS = 16;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

const GLYPH_FALLBACK = '?'.charCodeAt(0) - GLYPH_FIRST_CODE;

/** one static sprite per printable ASCII character, `kit:glyph:<code>`, in code order from space. */
export const glyphSprites: SpriteHandle[] = Array.from({ length: GLYPH_COUNT }, (_, i) => {
    const id = `kit:glyph:${GLYPH_FIRST_CODE + i}`;
    const x = (i % GLYPH_COLUMNS) * GLYPH_CELL;
    const y = Math.floor(i / GLYPH_COLUMNS) * GLYPH_CELL;
    return sprite(id, { frames: [texture(id, { of: fontSheet, region: [x, y, GLYPH_WIDTH, GLYPH_HEIGHT] })], mipmap: false });
});

/** the font's pixel metrics: every glyph is `width` by `height`, and a run steps `advance` per character. */
export const glyphMetrics = { width: GLYPH_WIDTH, height: GLYPH_HEIGHT, advance: GLYPH_WIDTH + 1 } as const;

/** the sprite for one character; anything outside printable ASCII draws as `?`. */
export function glyph(char: string): SpriteHandle {
    const index = char.charCodeAt(0) - GLYPH_FIRST_CODE;
    return glyphSprites[index >= 0 && index < GLYPH_COUNT ? index : GLYPH_FALLBACK]!;
}

/** one sprite per character of `text`, in order. */
export function glyphs(text: string): SpriteHandle[] {
    return Array.from(text, (char) => glyph(char));
}

/** one white 8x8 icon per builtin trait family, `kit:icon:<name>`; `trait(id, body, { icon })` names them. */
export const icons = {
    transform: sprite('kit:icon:transform', {
        src: asset('./assets/textures/icons/transform.png', import.meta.url),
        mipmap: false,
    }),
    body: sprite('kit:icon:body', { src: asset('./assets/textures/icons/body.png', import.meta.url), mipmap: false }),
    character: sprite('kit:icon:character', {
        src: asset('./assets/textures/icons/character.png', import.meta.url),
        mipmap: false,
    }),
    camera: sprite('kit:icon:camera', { src: asset('./assets/textures/icons/camera.png', import.meta.url), mipmap: false }),
    sprite: sprite('kit:icon:sprite', { src: asset('./assets/textures/icons/sprite.png', import.meta.url), mipmap: false }),
    mesh: sprite('kit:icon:mesh', { src: asset('./assets/textures/icons/mesh.png', import.meta.url), mipmap: false }),
    voxels: sprite('kit:icon:voxels', { src: asset('./assets/textures/icons/voxels.png', import.meta.url), mipmap: false }),
    player: sprite('kit:icon:player', { src: asset('./assets/textures/icons/player.png', import.meta.url), mipmap: false }),
    sound: sprite('kit:icon:sound', { src: asset('./assets/textures/icons/sound.png', import.meta.url), mipmap: false }),
    controller: sprite('kit:icon:controller', {
        src: asset('./assets/textures/icons/controller.png', import.meta.url),
        mipmap: false,
    }),
    animator: sprite('kit:icon:animator', { src: asset('./assets/textures/icons/animator.png', import.meta.url), mipmap: false }),
    canvas: sprite('kit:icon:canvas', { src: asset('./assets/textures/icons/canvas.png', import.meta.url), mipmap: false }),
} as const;

/**
 * A single opaque white pixel, for anything tinted at runtime rather than
 * drawn: a solid-colour billboard, a flat particle, a coloured underlay. Tint
 * multiplies against it, so white is the identity.
 *
 * Built from `textures.white` instead of its own file, so a game that also
 * wants that texture as a `texture()` input shares the one atlas entry.
 */
export const white = sprite('kit:white', {
    frames: [whiteTexture],
    mipmap: false,
});

/** 8x8 white pin, tinted by the marker that draws it. */
export const marker = sprite('kit:marker', {
    src: asset('./assets/textures/marker.png', import.meta.url),
    mipmap: false,
});

/** 16×16 RGBA puff. minetest_game tnt mod. */
export const smoke = sprite('kit:smoke', {
    src: asset('./assets/textures/smoke.png', import.meta.url),
    mipmap: false,
});

/** 12×12 snowflake. VoxeLibre mcl_weather (snowflake4, the largest
 *  of the 11 weather-pack flakes that's still cleanly readable). */
// `kit:snowflake`, not `kit:snow`: that id belongs to the snow block tile, and ids
// are shared across tiles and sprites. The file is `snowflake.png` to avoid the
// same collision with the snow block's own texture on disk.
export const snowflake = sprite('kit:snowflake', {
    src: asset('./assets/textures/snowflake.png', import.meta.url),
    mipmap: false,
});

/** 16×16 raindrop. VoxeLibre mcl_weather. */
export const rain = sprite('kit:rain', {
    src: asset('./assets/textures/rain.png', import.meta.url),
    mipmap: false,
});

/** 8×8 small dust mote. minetest_game default_item_smoke, repurposed
 *  as dust because it's the closest size to what `particleUpdate.dust`
 *  motion expects (small, neutral, monotone). */
export const dust = sprite('kit:dust', {
    src: asset('./assets/textures/dust.png', import.meta.url),
    mipmap: false,
});

/**
 * The harvested crop items, as drawable sprites.
 *
 * Built from the `textures.*Item` entries rather than from their own `src`, so
 * a game that wants one as a `texture()` input shares the single atlas entry.
 * Same reason `white` is built that way.
 *
 * `mipmap: false` like the rest of the pack's pixel art: these are 16x16 and
 * mipping them only softens the edges.
 */
export const wheatItem = sprite('kit:wheat_item', {
    frames: [wheatItemTexture],
    mipmap: false,
});
export const carrotItem = sprite('kit:carrot_item', {
    frames: [carrotItemTexture],
    mipmap: false,
});
export const potatoItem = sprite('kit:potato_item', {
    frames: [potatoItemTexture],
    mipmap: false,
});
export const beetrootItem = sprite('kit:beetroot_item', {
    frames: [beetrootItemTexture],
    mipmap: false,
});
export const cabbageItem = sprite('kit:cabbage_item', {
    frames: [cabbageItemTexture],
    mipmap: false,
});
export const cornItem = sprite('kit:corn_item', {
    frames: [cornItemTexture],
    mipmap: false,
});
export const strawberryItem = sprite('kit:strawberry_item', {
    frames: [strawberryItemTexture],
    mipmap: false,
});
export const blueberryItem = sprite('kit:blueberry_item', {
    frames: [blueberryItemTexture],
    mipmap: false,
});
