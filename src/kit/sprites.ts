import { asset, sprite } from 'bongle';
import {
    beetrootItem as beetrootItemTexture,
    blueberryItem as blueberryItemTexture,
    cabbageItem as cabbageItemTexture,
    carrotItem as carrotItemTexture,
    cornItem as cornItemTexture,
    potatoItem as potatoItemTexture,
    strawberryItem as strawberryItemTexture,
    wheatItem as wheatItemTexture,
    white as whiteTexture,
} from './textures';

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
