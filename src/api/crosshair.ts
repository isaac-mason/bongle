/**
 * Screen-center crosshair HUD. A controller trait declares a
 * `crosshair: CrosshairConfig` bundle (factory: `defaultCrosshairConfig`)
 * for game code to mutate at runtime (recoil bloom, hit-marker pulses,
 * focus tightening), creates one `Crosshair`, and drives it with
 * `updateCrosshair(crosshair, cfg, dt)` once per frame while it holds the
 * POV; `disposeCrosshair` on POV loss and from `onDispose`.
 * `PlayerControllerTrait` does exactly this; a custom controller gets the
 * same crosshair by doing the same.
 *
 * The factory early-returns `null` on the server so call sites can write
 * `createCrosshair(ctx)` unconditionally.
 */

import { type Crosshair, type CrosshairConfig, createCrosshairImpl } from '../client/crosshair';
import { env } from './env';
import type { ScriptContext } from './scripts';

export type { Crosshair, CrosshairConfig };
export { defaultCrosshairConfig, disposeCrosshair, updateCrosshair } from '../client/crosshair';

/** create a crosshair owning its own DOM + lerp state. returns `null` on
 *  the server. */
export function createCrosshair(ctx: ScriptContext): Crosshair | null {
    if (!env.client) return null;
    return createCrosshairImpl(ctx);
}
