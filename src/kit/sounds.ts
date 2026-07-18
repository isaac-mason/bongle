/**
 * Starter pack sound clips. Most are Minetest-Game-derived (CC BY-SA 3.0); the
 * `itemPickup` coin blip is CC0 (wobbleboxx, via OpenGameArt). Per-file terms +
 * attribution in `assets/sounds/NOTICE.txt`.
 *
 * Each `sound()` here sources its clip via `asset('./assets/sounds/<file>.ogg',
 * import.meta.url)`, so the .ogg ships alongside this module and resolves
 * relative to it wherever the starter package is installed; the pipeline reads
 * the resolved path and bakes it into the audio atlas.
 *
 * IDs are namespaced `starter:*` so they don't collide with anything a
 * user game declares. Re-exported as the `sounds` namespace from the
 * package index, so consumers reach them as `sounds.chestOpen` etc.
 */

import { asset, sound } from 'bongle';

/* footsteps */
export const dirtFootstep1 = sound('kit:dirt_footstep_1', {
    src: asset('./assets/sounds/dirt_footstep.1.ogg', import.meta.url),
});
export const dirtFootstep2 = sound('kit:dirt_footstep_2', {
    src: asset('./assets/sounds/dirt_footstep.2.ogg', import.meta.url),
});
export const glassFootstep = sound('kit:glass_footstep', {
    src: asset('./assets/sounds/glass_footstep.ogg', import.meta.url),
});
export const grassFootstep1 = sound('kit:grass_footstep_1', {
    src: asset('./assets/sounds/grass_footstep.1.ogg', import.meta.url),
});
export const grassFootstep2 = sound('kit:grass_footstep_2', {
    src: asset('./assets/sounds/grass_footstep.2.ogg', import.meta.url),
});
export const grassFootstep3 = sound('kit:grass_footstep_3', {
    src: asset('./assets/sounds/grass_footstep.3.ogg', import.meta.url),
});
export const gravelFootstep1 = sound('kit:gravel_footstep_1', {
    src: asset('./assets/sounds/gravel_footstep.1.ogg', import.meta.url),
});
export const gravelFootstep2 = sound('kit:gravel_footstep_2', {
    src: asset('./assets/sounds/gravel_footstep.2.ogg', import.meta.url),
});
export const gravelFootstep3 = sound('kit:gravel_footstep_3', {
    src: asset('./assets/sounds/gravel_footstep.3.ogg', import.meta.url),
});
export const gravelFootstep4 = sound('kit:gravel_footstep_4', {
    src: asset('./assets/sounds/gravel_footstep.4.ogg', import.meta.url),
});
export const hardFootstep1 = sound('kit:hard_footstep_1', {
    src: asset('./assets/sounds/hard_footstep.1.ogg', import.meta.url),
});
export const hardFootstep2 = sound('kit:hard_footstep_2', {
    src: asset('./assets/sounds/hard_footstep.2.ogg', import.meta.url),
});
export const hardFootstep3 = sound('kit:hard_footstep_3', {
    src: asset('./assets/sounds/hard_footstep.3.ogg', import.meta.url),
});
export const iceFootstep1 = sound('kit:ice_footstep_1', {
    src: asset('./assets/sounds/ice_footstep.1.ogg', import.meta.url),
});
export const iceFootstep2 = sound('kit:ice_footstep_2', {
    src: asset('./assets/sounds/ice_footstep.2.ogg', import.meta.url),
});
export const iceFootstep3 = sound('kit:ice_footstep_3', {
    src: asset('./assets/sounds/ice_footstep.3.ogg', import.meta.url),
});
export const metalFootstep1 = sound('kit:metal_footstep_1', {
    src: asset('./assets/sounds/metal_footstep.1.ogg', import.meta.url),
});
export const metalFootstep2 = sound('kit:metal_footstep_2', {
    src: asset('./assets/sounds/metal_footstep.2.ogg', import.meta.url),
});
export const metalFootstep3 = sound('kit:metal_footstep_3', {
    src: asset('./assets/sounds/metal_footstep.3.ogg', import.meta.url),
});
export const sandFootstep1 = sound('kit:sand_footstep_1', {
    src: asset('./assets/sounds/sand_footstep.1.ogg', import.meta.url),
});
export const sandFootstep2 = sound('kit:sand_footstep_2', {
    src: asset('./assets/sounds/sand_footstep.2.ogg', import.meta.url),
});
export const sandFootstep3 = sound('kit:sand_footstep_3', {
    src: asset('./assets/sounds/sand_footstep.3.ogg', import.meta.url),
});
export const snowFootstep1 = sound('kit:snow_footstep_1', {
    src: asset('./assets/sounds/snow_footstep.1.ogg', import.meta.url),
});
export const snowFootstep2 = sound('kit:snow_footstep_2', {
    src: asset('./assets/sounds/snow_footstep.2.ogg', import.meta.url),
});
export const snowFootstep3 = sound('kit:snow_footstep_3', {
    src: asset('./assets/sounds/snow_footstep.3.ogg', import.meta.url),
});
export const snowFootstep4 = sound('kit:snow_footstep_4', {
    src: asset('./assets/sounds/snow_footstep.4.ogg', import.meta.url),
});
export const snowFootstep5 = sound('kit:snow_footstep_5', {
    src: asset('./assets/sounds/snow_footstep.5.ogg', import.meta.url),
});
export const waterFootstep1 = sound('kit:water_footstep_1', {
    src: asset('./assets/sounds/water_splash.1.ogg', import.meta.url),
});
export const waterFootstep2 = sound('kit:water_footstep_2', {
    src: asset('./assets/sounds/water_splash.2.ogg', import.meta.url),
});
export const waterFootstep3 = sound('kit:water_footstep_3', {
    src: asset('./assets/sounds/water_splash.3.ogg', import.meta.url),
});
export const woodFootstep1 = sound('kit:wood_footstep_1', {
    src: asset('./assets/sounds/wood_footstep.1.ogg', import.meta.url),
});
export const woodFootstep2 = sound('kit:wood_footstep_2', {
    src: asset('./assets/sounds/wood_footstep.2.ogg', import.meta.url),
});

/* dig (while-mining loops) */
export const digChoppy1 = sound('kit:dig_choppy_1', {
    src: asset('./assets/sounds/dig_choppy.1.ogg', import.meta.url),
});
export const digChoppy2 = sound('kit:dig_choppy_2', {
    src: asset('./assets/sounds/dig_choppy.2.ogg', import.meta.url),
});
export const digChoppy3 = sound('kit:dig_choppy_3', {
    src: asset('./assets/sounds/dig_choppy.3.ogg', import.meta.url),
});
export const digCracky1 = sound('kit:dig_cracky_1', {
    src: asset('./assets/sounds/dig_cracky.1.ogg', import.meta.url),
});
export const digCracky2 = sound('kit:dig_cracky_2', {
    src: asset('./assets/sounds/dig_cracky.2.ogg', import.meta.url),
});
export const digCracky3 = sound('kit:dig_cracky_3', {
    src: asset('./assets/sounds/dig_cracky.3.ogg', import.meta.url),
});
export const digCrumbly = sound('kit:dig_crumbly', {
    src: asset('./assets/sounds/dig_crumbly.ogg', import.meta.url),
});
export const digDigImmediate = sound('kit:dig_dig_immediate', {
    src: asset('./assets/sounds/dig_dig_immediate.ogg', import.meta.url),
});
export const digMetal = sound('kit:dig_metal', {
    src: asset('./assets/sounds/dig_metal.ogg', import.meta.url),
});
export const digOddlyBreakableByHand = sound('kit:dig_oddly_breakable_by_hand', {
    src: asset('./assets/sounds/dig_oddly_breakable_by_hand.ogg', import.meta.url),
});
export const digSnappy = sound('kit:dig_snappy', {
    src: asset('./assets/sounds/dig_snappy.ogg', import.meta.url),
});
export const gravelDig1 = sound('kit:gravel_dig_1', {
    src: asset('./assets/sounds/gravel_dig.1.ogg', import.meta.url),
});
export const gravelDig2 = sound('kit:gravel_dig_2', {
    src: asset('./assets/sounds/gravel_dig.2.ogg', import.meta.url),
});
export const iceDig1 = sound('kit:ice_dig_1', {
    src: asset('./assets/sounds/ice_dig.1.ogg', import.meta.url),
});
export const iceDig2 = sound('kit:ice_dig_2', {
    src: asset('./assets/sounds/ice_dig.2.ogg', import.meta.url),
});
export const iceDig3 = sound('kit:ice_dig_3', {
    src: asset('./assets/sounds/ice_dig.3.ogg', import.meta.url),
});

/* dug (final-break) */
export const dugMetal1 = sound('kit:dug_metal_1', {
    src: asset('./assets/sounds/dug_metal.1.ogg', import.meta.url),
});
export const dugMetal2 = sound('kit:dug_metal_2', {
    src: asset('./assets/sounds/dug_metal.2.ogg', import.meta.url),
});
export const dugNode1 = sound('kit:dug_node_1', {
    src: asset('./assets/sounds/dug_node.1.ogg', import.meta.url),
});
export const dugNode2 = sound('kit:dug_node_2', {
    src: asset('./assets/sounds/dug_node.2.ogg', import.meta.url),
});
export const gravelDug1 = sound('kit:gravel_dug_1', {
    src: asset('./assets/sounds/gravel_dug.1.ogg', import.meta.url),
});
export const gravelDug2 = sound('kit:gravel_dug_2', {
    src: asset('./assets/sounds/gravel_dug.2.ogg', import.meta.url),
});
export const gravelDug3 = sound('kit:gravel_dug_3', {
    src: asset('./assets/sounds/gravel_dug.3.ogg', import.meta.url),
});
export const iceDug = sound('kit:ice_dug', {
    src: asset('./assets/sounds/ice_dug.ogg', import.meta.url),
});

/* break (glass) */
export const breakGlass1 = sound('kit:break_glass_1', {
    src: asset('./assets/sounds/break_glass.1.ogg', import.meta.url),
});
export const breakGlass2 = sound('kit:break_glass_2', {
    src: asset('./assets/sounds/break_glass.2.ogg', import.meta.url),
});
export const breakGlass3 = sound('kit:break_glass_3', {
    src: asset('./assets/sounds/break_glass.3.ogg', import.meta.url),
});

/* place */
export const place1 = sound('kit:place_1', {
    src: asset('./assets/sounds/place.1.ogg', import.meta.url),
});
export const place2 = sound('kit:place_2', {
    src: asset('./assets/sounds/place.2.ogg', import.meta.url),
});
export const place3 = sound('kit:place_3', {
    src: asset('./assets/sounds/place.3.ogg', import.meta.url),
});
export const placeHard1 = sound('kit:place_hard_1', {
    src: asset('./assets/sounds/place_hard.1.ogg', import.meta.url),
});
export const placeHard2 = sound('kit:place_hard_2', {
    src: asset('./assets/sounds/place_hard.2.ogg', import.meta.url),
});
export const placeMetal1 = sound('kit:place_metal_1', {
    src: asset('./assets/sounds/place_metal.1.ogg', import.meta.url),
});
export const placeMetal2 = sound('kit:place_metal_2', {
    src: asset('./assets/sounds/place_metal.2.ogg', import.meta.url),
});

/* misc */
export const chestClose = sound('kit:chest_close', {
    src: asset('./assets/sounds/chest_close.ogg', import.meta.url),
});
export const chestOpen = sound('kit:chest_open', {
    src: asset('./assets/sounds/chest_open.ogg', import.meta.url),
});
export const coolLava1 = sound('kit:cool_lava_1', {
    src: asset('./assets/sounds/cool_lava.1.ogg', import.meta.url),
});
export const coolLava2 = sound('kit:cool_lava_2', {
    src: asset('./assets/sounds/cool_lava.2.ogg', import.meta.url),
});
export const coolLava3 = sound('kit:cool_lava_3', {
    src: asset('./assets/sounds/cool_lava.3.ogg', import.meta.url),
});
export const furnaceActive = sound('kit:furnace_active', {
    src: asset('./assets/sounds/furnace_active.ogg', import.meta.url),
});
export const itemSmoke = sound('kit:item_smoke', {
    src: asset('./assets/sounds/item_smoke.ogg', import.meta.url),
});
export const toolBreaks1 = sound('kit:tool_breaks_1', {
    src: asset('./assets/sounds/tool_breaks.1.ogg', import.meta.url),
});
export const toolBreaks2 = sound('kit:tool_breaks_2', {
    src: asset('./assets/sounds/tool_breaks.2.ogg', import.meta.url),
});
export const toolBreaks3 = sound('kit:tool_breaks_3', {
    src: asset('./assets/sounds/tool_breaks.3.ogg', import.meta.url),
});
export const playerDamage = sound('kit:player_damage', {
    src: asset('./assets/sounds/player_damage.ogg', import.meta.url),
});

/* combat */
// a bow loosing an arrow, the string's twang + release.
export const bowShoot = sound('kit:bow_shoot', {
    src: asset('./assets/sounds/bow_shoot.ogg', import.meta.url),
});
// a whooshing fireball launch, spell/projectile cast.
export const cast = sound('kit:cast', {
    src: asset('./assets/sounds/fireball_whoosh.ogg', import.meta.url),
});
// a solid hard impact, projectile/spell hit.
export const impact = sound('kit:impact', {
    src: asset('./assets/sounds/snowball_hard_impact.ogg', import.meta.url),
});
// a sharper, punchier hit, a critical / killing blow on a fighter.
export const impactCrit = sound('kit:impact_crit', {
    src: asset('./assets/sounds/impact_crit.ogg', import.meta.url),
});
// a rising chime, player level-up / progression.
export const levelUp = sound('kit:level_up', {
    src: asset('./assets/sounds/levelup.ogg', import.meta.url),
});
