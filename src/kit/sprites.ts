/**
 * Starter pack particle sprites. Source pngs live in `assets/textures/` with
 * every other picture the pack ships: `texture()` is what a png declares, and
 * `tile()` / `sprite()` are the two things built from one, so a split by
 * consumer put the same kind of file in two places.
 *
 * Pixel-art textures sourced from
 * minetest_game (CC BY-SA 3.0) and Mineclonia/VoxeLibre (GPL-3.0 /
 * CC BY-SA 4.0). Each `sprite()` sources its pixels via
 * `asset('./…', import.meta.url)`, so they ship alongside this module and
 * resolve relative to it wherever the starter package is installed; the
 * pipeline reads the resolved path at bake time.
 *
 * Exposed individually so the package index re-exports them as
 * `export * as sprites`. Consumers reach them as `sprites.smoke`,
 * `sprites.snowflake`, etc., and pass them straight into
 * `particlePresets.smoke('puff', { sprite: sprites.smoke })`.
 *
 * `mipmap: false` across the board, pixel-art particles look mushy
 * with mips and these textures are tiny enough that mipping buys
 * nothing for atlas memory.
 */

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
// `kit:snowflake`, NOT `kit:snow`: that id already belongs to the snow block TILE,
// and ids are shared across tiles and sprites. The collision put this 12x12
// snowflake - transparent everywhere except the flake - into the block atlas layer
// the terrain samples, so snow blocks rendered the flake's cutout as black holes.
//
// The FILE is `snowflake.png` for the same reason. It was `sprites/snow.png`, and
// once every source png shares one directory that name collides with the snow
// block's own texture on disk, which is the same mistake one layer down.
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
