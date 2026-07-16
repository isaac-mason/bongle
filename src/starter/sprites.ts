/**
 * Starter pack particle sprites. Pixel-art textures sourced from
 * minetest_game (CC BY-SA 3.0) and Mineclonia/VoxeLibre (GPL-3.0 /
 * CC BY-SA 4.0). Each `sprite()` sources its pixels via
 * `asset('./…', import.meta.url)`, so they ship alongside this module and
 * resolve relative to it wherever the starter package is installed; the
 * pipeline reads the resolved path at bake time.
 *
 * Exposed individually so the package index re-exports them as
 * `export * as sprites`. Consumers reach them as `sprites.smoke`,
 * `sprites.snow`, etc., and pass them straight into
 * `particlePresets.smoke('puff', { sprite: sprites.smoke })`.
 *
 * `mipmap: false` across the board, pixel-art particles look mushy
 * with mips and these textures are tiny enough that mipping buys
 * nothing for atlas memory.
 */

import { asset, sprite } from 'bongle';

/** 16×16 RGBA puff. minetest_game tnt mod. */
export const smoke = sprite('starter:smoke', {
    src: asset('./assets/sprites/smoke.png', import.meta.url),
    mipmap: false,
});

/** 12×12 snowflake. VoxeLibre mcl_weather (snowflake4, the largest
 *  of the 11 weather-pack flakes that's still cleanly readable). */
export const snow = sprite('starter:snow', {
    src: asset('./assets/sprites/snow.png', import.meta.url),
    mipmap: false,
});

/** 16×16 raindrop. VoxeLibre mcl_weather. */
export const rain = sprite('starter:rain', {
    src: asset('./assets/sprites/rain.png', import.meta.url),
    mipmap: false,
});

/** 8×8 small dust mote. minetest_game default_item_smoke, repurposed
 *  as dust because it's the closest size to what `particleUpdate.dust`
 *  motion expects (small, neutral, monotone). */
export const dust = sprite('starter:dust', {
    src: asset('./assets/sprites/dust.png', import.meta.url),
    mipmap: false,
});
