import type * as nodes from './nodes';
import type { ScriptContext } from './scripts';

/**
 * the client's current subject: the node local input drives and the engine
 * treats as this client's point of view (renderer + audio). scripts compare
 * their own ctx.node to it to gate per-frame work that should only run on the
 * active subject (camera writes, input-driven movement, etc.); other nodes
 * still run their remaining hooks unconditionally.
 *
 * a plain field on the single client state (`ctx.client.subject`), so a write
 * is observed everywhere without re-seating. server-side, ctx.client is
 * undefined and this returns null (server scripts shouldn't gate on POV).
 */
export function getSubject(ctx: ScriptContext): nodes.Node | null {
    return ctx.client?.subject ?? null;
}

/**
 * swap the client's subject. plain in-place write to `ctx.client.subject`.
 * pass `null` to clear. client-only: a no-op on the server. purely local, it
 * changes what this client controls/sees, never ownership or the server-side
 * streaming anchor (that stays the player node).
 */
export function setSubject(ctx: ScriptContext, node: nodes.Node | null): void {
    if (ctx.client) ctx.client.subject = node;
}

/**
 * the active render camera node, what the renderer composes the render camera
 * from each frame (its TransformTrait pose + CameraTrait projection). defaults
 * to the room's camera node; the editor lens and DIY setups repoint it.
 *
 * server-side, ctx.client is undefined and this returns null.
 */
export function getCamera(ctx: ScriptContext): nodes.Node | null {
    return ctx.client?.camera ?? null;
}

/**
 * point the active render camera at `node`. plain in-place write to the single
 * client state (`ctx.client.camera`), observed by the renderer and every
 * script without re-seating. client-only: a no-op on the server.
 */
export function setCamera(ctx: ScriptContext, node: nodes.Node): void {
    if (ctx.client) ctx.client.camera = node;
}
