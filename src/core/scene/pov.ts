import type * as nodes from './nodes';
import type { ScriptContext } from './scripts';

// PovState (the `{ node }` box) is the shape of `ClientContext.pov`, so it
// lives with ClientContext in scripts.ts; re-export it here so callers can
// reach the type alongside the accessors.
export type { PovState } from './scripts';

/**
 * resolve the room's current POV node, the node the engine renders
 * through and routes input through. scripts compare to their own ctx.node
 * to gate per-frame work that should only run on the active POV (camera
 * writes, input-driven movement, etc.); non-POV nodes still run other
 * hooks (animation, state ticks) unconditionally.
 *
 * server-side, ctx.client is undefined and this returns null. that's
 * intentional: server scripts shouldn't conditionalize on POV.
 */
export function getPov(ctx: ScriptContext): nodes.Node | null {
    return ctx.client?.pov.node ?? null;
}

/**
 * swap the room's POV pointer. writes `ctx.client.pov.node` in place, the
 * same box `room.pov` and every script's `ctx.client.pov` reference, so the
 * swap is observed everywhere without re-seating. pass `null` to clear (no
 * POV node, input still routes via room.input, but `getPov(ctx)` returns
 * null everywhere and rendering bails for this room until a POV node is set
 * again).
 *
 * client-only: a no-op on the server (ctx.client is undefined), like getPov.
 * the renderer reads the active POV camera each frame via `getPovCamera`, so
 * POV swaps need no pipeline rebuild.
 */
export function setPov(ctx: ScriptContext, node: nodes.Node | null): void {
    if (ctx.client) ctx.client.pov.node = node;
}
