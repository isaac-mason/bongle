import type { ScriptContext } from '../core/scene/scripts';

/**
 * configure flood-fill light propagation for this room's voxel world.
 * fields default to their current value, pass only what you want to change.
 * call from a shared-realm system so client and server stay in sync, since a
 * config skew between the two sides diverges silently.
 *
 * - `enabled`: when false, `setBlock` and new chunks skip the BFS queue and
 *   inline-seed `chunk.light` from block emission + `minLevel` sky instead.
 * - `minLevel`: sky-channel seed used by inline writes (0-15). `15` keeps
 *   the world fully lit; `0` is pitch black except for block emission.
 */
export function configureFloodFillLighting(ctx: ScriptContext, o: { enabled?: boolean; minLevel?: number }): void {
    const state = ctx.voxels.lighting.floodFill;
    if (o.enabled !== undefined) state.enabled = o.enabled;
    if (o.minLevel !== undefined) {
        if (o.minLevel < 0 || o.minLevel > 15 || (o.minLevel | 0) !== o.minLevel) {
            throw new Error(`[bongle] configureFloodFillLighting: minLevel must be int 0-15, got ${o.minLevel}`);
        }
        state.minLevel = o.minLevel;
    }
}
