/**
 * Starter pack sound clips. Most are Minetest-Game-derived (CC BY-SA 3.0); the
 * `itemPickup` coin blip is CC0 (wobbleboxx, via OpenGameArt). Per-file terms +
 * attribution in `assets/sounds/NOTICE.txt`.
 *
 * Each `sound()` here uses `new URL('./assets/sounds/<file>.ogg',
 * import.meta.url)`. That same form works in both worlds the engine
 * compiles for:
 *   - **Vite** (client bundle): statically rewrites the call into a
 *     bundled asset URL, so the .ogg ships alongside the user's game.
 *   - **Bun** (asset pipeline): resolves to `file:///abs/path`, which
 *     the pipeline's `fileURLToPath` turns into a real disk path for
 *     ffmpeg.
 *
 * IDs are namespaced `starter:*` so they don't collide with anything a
 * user game declares. Re-exported as the `sounds` namespace from the
 * package index, so consumers reach them as `sounds.chestOpen` etc.
 */

import { sound } from 'bongle';

/* footsteps */
export const dirtFootstep1 = sound('starter:dirt_footstep_1', {
    src: new URL('./assets/sounds/default_dirt_footstep.1.ogg', import.meta.url),
});
export const dirtFootstep2 = sound('starter:dirt_footstep_2', {
    src: new URL('./assets/sounds/default_dirt_footstep.2.ogg', import.meta.url),
});
export const glassFootstep = sound('starter:glass_footstep', {
    src: new URL('./assets/sounds/default_glass_footstep.ogg', import.meta.url),
});
export const grassFootstep1 = sound('starter:grass_footstep_1', {
    src: new URL('./assets/sounds/default_grass_footstep.1.ogg', import.meta.url),
});
export const grassFootstep2 = sound('starter:grass_footstep_2', {
    src: new URL('./assets/sounds/default_grass_footstep.2.ogg', import.meta.url),
});
export const grassFootstep3 = sound('starter:grass_footstep_3', {
    src: new URL('./assets/sounds/default_grass_footstep.3.ogg', import.meta.url),
});
export const gravelFootstep1 = sound('starter:gravel_footstep_1', {
    src: new URL('./assets/sounds/default_gravel_footstep.1.ogg', import.meta.url),
});
export const gravelFootstep2 = sound('starter:gravel_footstep_2', {
    src: new URL('./assets/sounds/default_gravel_footstep.2.ogg', import.meta.url),
});
export const gravelFootstep3 = sound('starter:gravel_footstep_3', {
    src: new URL('./assets/sounds/default_gravel_footstep.3.ogg', import.meta.url),
});
export const gravelFootstep4 = sound('starter:gravel_footstep_4', {
    src: new URL('./assets/sounds/default_gravel_footstep.4.ogg', import.meta.url),
});
export const hardFootstep1 = sound('starter:hard_footstep_1', {
    src: new URL('./assets/sounds/default_hard_footstep.1.ogg', import.meta.url),
});
export const hardFootstep2 = sound('starter:hard_footstep_2', {
    src: new URL('./assets/sounds/default_hard_footstep.2.ogg', import.meta.url),
});
export const hardFootstep3 = sound('starter:hard_footstep_3', {
    src: new URL('./assets/sounds/default_hard_footstep.3.ogg', import.meta.url),
});
export const iceFootstep1 = sound('starter:ice_footstep_1', {
    src: new URL('./assets/sounds/default_ice_footstep.1.ogg', import.meta.url),
});
export const iceFootstep2 = sound('starter:ice_footstep_2', {
    src: new URL('./assets/sounds/default_ice_footstep.2.ogg', import.meta.url),
});
export const iceFootstep3 = sound('starter:ice_footstep_3', {
    src: new URL('./assets/sounds/default_ice_footstep.3.ogg', import.meta.url),
});
export const metalFootstep1 = sound('starter:metal_footstep_1', {
    src: new URL('./assets/sounds/default_metal_footstep.1.ogg', import.meta.url),
});
export const metalFootstep2 = sound('starter:metal_footstep_2', {
    src: new URL('./assets/sounds/default_metal_footstep.2.ogg', import.meta.url),
});
export const metalFootstep3 = sound('starter:metal_footstep_3', {
    src: new URL('./assets/sounds/default_metal_footstep.3.ogg', import.meta.url),
});
export const sandFootstep1 = sound('starter:sand_footstep_1', {
    src: new URL('./assets/sounds/default_sand_footstep.1.ogg', import.meta.url),
});
export const sandFootstep2 = sound('starter:sand_footstep_2', {
    src: new URL('./assets/sounds/default_sand_footstep.2.ogg', import.meta.url),
});
export const sandFootstep3 = sound('starter:sand_footstep_3', {
    src: new URL('./assets/sounds/default_sand_footstep.3.ogg', import.meta.url),
});
export const snowFootstep1 = sound('starter:snow_footstep_1', {
    src: new URL('./assets/sounds/default_snow_footstep.1.ogg', import.meta.url),
});
export const snowFootstep2 = sound('starter:snow_footstep_2', {
    src: new URL('./assets/sounds/default_snow_footstep.2.ogg', import.meta.url),
});
export const snowFootstep3 = sound('starter:snow_footstep_3', {
    src: new URL('./assets/sounds/default_snow_footstep.3.ogg', import.meta.url),
});
export const snowFootstep4 = sound('starter:snow_footstep_4', {
    src: new URL('./assets/sounds/default_snow_footstep.4.ogg', import.meta.url),
});
export const snowFootstep5 = sound('starter:snow_footstep_5', {
    src: new URL('./assets/sounds/default_snow_footstep.5.ogg', import.meta.url),
});
export const waterFootstep1 = sound('starter:water_footstep_1', {
    src: new URL('./assets/sounds/water_splash.1.ogg', import.meta.url),
});
export const waterFootstep2 = sound('starter:water_footstep_2', {
    src: new URL('./assets/sounds/water_splash.2.ogg', import.meta.url),
});
export const waterFootstep3 = sound('starter:water_footstep_3', {
    src: new URL('./assets/sounds/water_splash.3.ogg', import.meta.url),
});
export const woodFootstep1 = sound('starter:wood_footstep_1', {
    src: new URL('./assets/sounds/default_wood_footstep.1.ogg', import.meta.url),
});
export const woodFootstep2 = sound('starter:wood_footstep_2', {
    src: new URL('./assets/sounds/default_wood_footstep.2.ogg', import.meta.url),
});

/* dig (while-mining loops) */
export const digChoppy1 = sound('starter:dig_choppy_1', {
    src: new URL('./assets/sounds/default_dig_choppy.1.ogg', import.meta.url),
});
export const digChoppy2 = sound('starter:dig_choppy_2', {
    src: new URL('./assets/sounds/default_dig_choppy.2.ogg', import.meta.url),
});
export const digChoppy3 = sound('starter:dig_choppy_3', {
    src: new URL('./assets/sounds/default_dig_choppy.3.ogg', import.meta.url),
});
export const digCracky1 = sound('starter:dig_cracky_1', {
    src: new URL('./assets/sounds/default_dig_cracky.1.ogg', import.meta.url),
});
export const digCracky2 = sound('starter:dig_cracky_2', {
    src: new URL('./assets/sounds/default_dig_cracky.2.ogg', import.meta.url),
});
export const digCracky3 = sound('starter:dig_cracky_3', {
    src: new URL('./assets/sounds/default_dig_cracky.3.ogg', import.meta.url),
});
export const digCrumbly = sound('starter:dig_crumbly', {
    src: new URL('./assets/sounds/default_dig_crumbly.ogg', import.meta.url),
});
export const digDigImmediate = sound('starter:dig_dig_immediate', {
    src: new URL('./assets/sounds/default_dig_dig_immediate.ogg', import.meta.url),
});
export const digMetal = sound('starter:dig_metal', {
    src: new URL('./assets/sounds/default_dig_metal.ogg', import.meta.url),
});
export const digOddlyBreakableByHand = sound('starter:dig_oddly_breakable_by_hand', {
    src: new URL('./assets/sounds/default_dig_oddly_breakable_by_hand.ogg', import.meta.url),
});
export const digSnappy = sound('starter:dig_snappy', {
    src: new URL('./assets/sounds/default_dig_snappy.ogg', import.meta.url),
});
export const gravelDig1 = sound('starter:gravel_dig_1', {
    src: new URL('./assets/sounds/default_gravel_dig.1.ogg', import.meta.url),
});
export const gravelDig2 = sound('starter:gravel_dig_2', {
    src: new URL('./assets/sounds/default_gravel_dig.2.ogg', import.meta.url),
});
export const iceDig1 = sound('starter:ice_dig_1', {
    src: new URL('./assets/sounds/default_ice_dig.1.ogg', import.meta.url),
});
export const iceDig2 = sound('starter:ice_dig_2', {
    src: new URL('./assets/sounds/default_ice_dig.2.ogg', import.meta.url),
});
export const iceDig3 = sound('starter:ice_dig_3', {
    src: new URL('./assets/sounds/default_ice_dig.3.ogg', import.meta.url),
});

/* dug (final-break) */
export const dugMetal1 = sound('starter:dug_metal_1', {
    src: new URL('./assets/sounds/default_dug_metal.1.ogg', import.meta.url),
});
export const dugMetal2 = sound('starter:dug_metal_2', {
    src: new URL('./assets/sounds/default_dug_metal.2.ogg', import.meta.url),
});
export const dugNode1 = sound('starter:dug_node_1', {
    src: new URL('./assets/sounds/default_dug_node.1.ogg', import.meta.url),
});
export const dugNode2 = sound('starter:dug_node_2', {
    src: new URL('./assets/sounds/default_dug_node.2.ogg', import.meta.url),
});
export const gravelDug1 = sound('starter:gravel_dug_1', {
    src: new URL('./assets/sounds/default_gravel_dug.1.ogg', import.meta.url),
});
export const gravelDug2 = sound('starter:gravel_dug_2', {
    src: new URL('./assets/sounds/default_gravel_dug.2.ogg', import.meta.url),
});
export const gravelDug3 = sound('starter:gravel_dug_3', {
    src: new URL('./assets/sounds/default_gravel_dug.3.ogg', import.meta.url),
});
export const iceDug = sound('starter:ice_dug', {
    src: new URL('./assets/sounds/default_ice_dug.ogg', import.meta.url),
});

/* break (glass) */
export const breakGlass1 = sound('starter:break_glass_1', {
    src: new URL('./assets/sounds/default_break_glass.1.ogg', import.meta.url),
});
export const breakGlass2 = sound('starter:break_glass_2', {
    src: new URL('./assets/sounds/default_break_glass.2.ogg', import.meta.url),
});
export const breakGlass3 = sound('starter:break_glass_3', {
    src: new URL('./assets/sounds/default_break_glass.3.ogg', import.meta.url),
});

/* place */
export const placeNode1 = sound('starter:place_node_1', {
    src: new URL('./assets/sounds/default_place_node.1.ogg', import.meta.url),
});
export const placeNode2 = sound('starter:place_node_2', {
    src: new URL('./assets/sounds/default_place_node.2.ogg', import.meta.url),
});
export const placeNode3 = sound('starter:place_node_3', {
    src: new URL('./assets/sounds/default_place_node.3.ogg', import.meta.url),
});
export const placeNodeHard1 = sound('starter:place_node_hard_1', {
    src: new URL('./assets/sounds/default_place_node_hard.1.ogg', import.meta.url),
});
export const placeNodeHard2 = sound('starter:place_node_hard_2', {
    src: new URL('./assets/sounds/default_place_node_hard.2.ogg', import.meta.url),
});
export const placeNodeMetal1 = sound('starter:place_node_metal_1', {
    src: new URL('./assets/sounds/default_place_node_metal.1.ogg', import.meta.url),
});
export const placeNodeMetal2 = sound('starter:place_node_metal_2', {
    src: new URL('./assets/sounds/default_place_node_metal.2.ogg', import.meta.url),
});

/* misc */
export const chestClose = sound('starter:chest_close', {
    src: new URL('./assets/sounds/default_chest_close.ogg', import.meta.url),
});
export const chestOpen = sound('starter:chest_open', {
    src: new URL('./assets/sounds/default_chest_open.ogg', import.meta.url),
});
export const coolLava1 = sound('starter:cool_lava_1', {
    src: new URL('./assets/sounds/default_cool_lava.1.ogg', import.meta.url),
});
export const coolLava2 = sound('starter:cool_lava_2', {
    src: new URL('./assets/sounds/default_cool_lava.2.ogg', import.meta.url),
});
export const coolLava3 = sound('starter:cool_lava_3', {
    src: new URL('./assets/sounds/default_cool_lava.3.ogg', import.meta.url),
});
export const furnaceActive = sound('starter:furnace_active', {
    src: new URL('./assets/sounds/default_furnace_active.ogg', import.meta.url),
});
export const itemSmoke = sound('starter:item_smoke', {
    src: new URL('./assets/sounds/default_item_smoke.ogg', import.meta.url),
});
export const toolBreaks1 = sound('starter:tool_breaks_1', {
    src: new URL('./assets/sounds/default_tool_breaks.1.ogg', import.meta.url),
});
export const toolBreaks2 = sound('starter:tool_breaks_2', {
    src: new URL('./assets/sounds/default_tool_breaks.2.ogg', import.meta.url),
});
export const toolBreaks3 = sound('starter:tool_breaks_3', {
    src: new URL('./assets/sounds/default_tool_breaks.3.ogg', import.meta.url),
});
export const playerDamage = sound('starter:player_damage', {
    src: new URL('./assets/sounds/player_damage.ogg', import.meta.url),
});

/* pickup — coin blip from wobbleboxx's "Level up, power up, Coin get" pack
 * (CC0, via OpenGameArt), trimmed to a short mono hit. see NOTICE.txt. */
export const itemPickup = sound('starter:item_pickup', {
    src: new URL('./assets/sounds/wobbleboxx_coin.ogg', import.meta.url),
});
