/**
 * Starter pack particle sprites. Pixel-art textures sourced from
 * minetest_game (CC BY-SA 3.0) and Mineclonia/VoxeLibre (GPL-3.0 /
 * CC BY-SA 4.0). Each `sprite()` uses the URL form so pixels ship
 * bundled with the package, vite rewrites `new URL(...)` in client
 * bundles, and the asset pipeline resolves `file://` via
 * `fileURLToPath` at bake time.
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

import { sprite } from 'bongle';

/** 16×16 RGBA puff. minetest_game tnt mod. */
export const smoke = sprite('starter:smoke', {
    src: new URL('./assets/sprites/smoke.png', import.meta.url),
    mipmap: false,
});

/** 12×12 snowflake. VoxeLibre mcl_weather (snowflake4, the largest
 *  of the 11 weather-pack flakes that's still cleanly readable). */
export const snow = sprite('starter:snow', {
    src: new URL('./assets/sprites/snow.png', import.meta.url),
    mipmap: false,
});

/** 16×16 raindrop. VoxeLibre mcl_weather. */
export const rain = sprite('starter:rain', {
    src: new URL('./assets/sprites/rain.png', import.meta.url),
    mipmap: false,
});

/** 8×8 small dust mote. minetest_game default_item_smoke, repurposed
 *  as dust because it's the closest size to what `particleUpdate.dust`
 *  motion expects (small, neutral, monotone). */
export const dust = sprite('starter:dust', {
    src: new URL('./assets/sprites/dust.png', import.meta.url),
    mipmap: false,
});
