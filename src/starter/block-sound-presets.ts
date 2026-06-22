/**
 * Material-keyed bundles of starter sound handles for block sound slots.
 *
 * `block({ sounds: blockSoundPresets.grass })` wires up the four sound
 * categories (`footstep`, `dig`, `break`, `place`) for a typical grass
 * block in one go.
 *
 * Each preset is a plain object; spread + override to customize:
 *
 *   block({ sounds: { ...blockSoundPresets.grass, footstep: [mySound] } })
 *
 * Each preset is exported as its own `const` so the package index can
 * re-export them as `export * as blockSoundPresets`. Tree-shaking can
 * drop presets you don't reference.
 */

import type { BlockSoundConfig } from 'bongle';
import * as s from './sounds';

export const grass = {
    footstep: [s.grassFootstep1, s.grassFootstep2, s.grassFootstep3],
    dig: [s.digCrumbly],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const dirt = {
    footstep: [s.dirtFootstep1, s.dirtFootstep2],
    dig: [s.digCrumbly],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const sand = {
    footstep: [s.sandFootstep1, s.sandFootstep2, s.sandFootstep3],
    dig: [s.digCrumbly],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const gravel = {
    footstep: [s.gravelFootstep1, s.gravelFootstep2, s.gravelFootstep3, s.gravelFootstep4],
    dig: [s.gravelDig1, s.gravelDig2],
    break: [s.gravelDug1, s.gravelDug2, s.gravelDug3],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const snow = {
    footstep: [s.snowFootstep1, s.snowFootstep2, s.snowFootstep3, s.snowFootstep4, s.snowFootstep5],
    dig: [s.digCrumbly],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const stone = {
    footstep: [s.hardFootstep1, s.hardFootstep2, s.hardFootstep3],
    dig: [s.digCracky1, s.digCracky2, s.digCracky3],
    break: [s.dugNode1, s.dugNode2],
    place: [s.placeHard1, s.placeHard2],
} as const satisfies BlockSoundConfig;

export const wood = {
    footstep: [s.woodFootstep1, s.woodFootstep2],
    dig: [s.digChoppy1, s.digChoppy2, s.digChoppy3],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;

export const metal = {
    footstep: [s.metalFootstep1, s.metalFootstep2, s.metalFootstep3],
    dig: [s.digMetal],
    break: [s.dugMetal1, s.dugMetal2],
    place: [s.placeMetal1, s.placeMetal2],
} as const satisfies BlockSoundConfig;

export const glass = {
    footstep: [s.glassFootstep],
    dig: [s.digCracky1, s.digCracky2, s.digCracky3],
    break: [s.breakGlass1, s.breakGlass2, s.breakGlass3],
    place: [s.placeHard1, s.placeHard2],
} as const satisfies BlockSoundConfig;

export const ice = {
    footstep: [s.iceFootstep1, s.iceFootstep2, s.iceFootstep3],
    dig: [s.iceDig1, s.iceDig2, s.iceDig3],
    break: [s.iceDug],
    place: [s.placeHard1, s.placeHard2],
} as const satisfies BlockSoundConfig;

export const water = {
    footstep: [s.waterFootstep1, s.waterFootstep2, s.waterFootstep3],
} as const satisfies BlockSoundConfig;

export const leaves = {
    footstep: [s.grassFootstep1, s.grassFootstep2, s.grassFootstep3],
    dig: [s.digSnappy],
    break: [s.dugNode1, s.dugNode2],
    place: [s.place1, s.place2, s.place3],
} as const satisfies BlockSoundConfig;
