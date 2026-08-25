// api/lighting.ts, script-facing voxel-lighting controls.
//
// Configures how the voxel world propagates light. The default
// (`enabled: true`) runs the BFS flood-fill on every block change and on
// new chunks. Games that mutate huge volumes per tick (procgen, fast-fill
// builders) can opt out to a flat sky-light seed instead.
//
// Call this from a shared-realm system so client and server configure
// identically. A client propagates light for blocks it writes itself, so
// a config skew between the two sides diverges silently.

import type { ScriptContext } from '../core/scene/scripts';

/**
 * configure flood-fill light propagation for this room's voxel world.
 *
 * fields default to their current value, pass only what you want to
 * change. shallow merge.
 *
 * - `enabled`: when false, `setBlock` and new chunks skip the BFS queue
 *   and inline-seed `chunk.light` from block emission + `minLevel` sky.
 * - `minLevel`: sky-channel seed used by inline writes (0-15). `15`
 *   keeps the world fully lit; `0` is pitch black except for block
 *   emission.
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
