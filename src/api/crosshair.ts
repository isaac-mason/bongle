import { type Crosshair, type CrosshairConfig, createCrosshairImpl } from '../client/crosshair';
import { env } from '../env';
import type { ScriptContext } from './scripts';

export { addCrosshair, defaultCrosshairConfig, removeCrosshair, updateCrosshair } from '../client/crosshair';
export type { Crosshair, CrosshairConfig };

/** create a crosshair owning its own DOM + lerp state, initially removed
 *  (nothing shows until `addCrosshair`). returns `null` on the server. */
export function createCrosshair(ctx: ScriptContext): Crosshair | null {
    if (!env.client) return null;
    return createCrosshairImpl(ctx);
}
