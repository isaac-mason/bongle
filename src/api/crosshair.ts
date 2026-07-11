/**
 * Screen-center crosshair HUD. A controller trait declares a
 * `crosshair: CrosshairConfig` bundle (factory: `defaultCrosshairConfig`)
 * for game code to mutate at runtime (recoil bloom, hit-marker pulses,
 * focus tightening) and creates one `Crosshair` (starts removed).
 * Presence is explicit: `addCrosshair` shows it, `removeCrosshair` hides
 * it, and `updateCrosshair(crosshair, cfg, dt)` drives geometry once per
 * frame while added. `PlayerControllerTrait` adds while it holds the POV
 * with `cfg.enabled` set, removes otherwise; a custom controller gets the
 * same crosshair by doing the same.
 *
 * The factory early-returns `null` on the server so call sites can write
 * `createCrosshair(ctx)` unconditionally.
 */

import { type Crosshair, type CrosshairConfig, createCrosshairImpl } from '../client/crosshair';
import { env } from './env';
import type { ScriptContext } from './scripts';

export type { Crosshair, CrosshairConfig };
export { addCrosshair, defaultCrosshairConfig, removeCrosshair, updateCrosshair } from '../client/crosshair';

/** create a crosshair owning its own DOM + lerp state, initially removed
 *  (nothing shows until `addCrosshair`). returns `null` on the server. */
export function createCrosshair(ctx: ScriptContext): Crosshair | null {
    if (!env.client) return null;
    return createCrosshairImpl(ctx);
}
