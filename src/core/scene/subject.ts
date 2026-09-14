import type * as sceneTree from './scene-tree';
import type { ScriptContext } from './scripts';

/**
 * The client's current subject: the node local input drives and the engine treats as this
 * client's point of view (renderer + audio). Scripts compare their own ctx.node to it to
 * gate per-frame work that should only run on the active subject. Server-side, ctx.client
 * is undefined and this returns null.
 */
export function getSubject(ctx: ScriptContext): sceneTree.Node | null {
    return ctx.client?.subject ?? null;
}

/** Swaps the client's subject; pass `null` to clear. Client-only, a no-op on the server. Purely local: it never changes ownership or the server-side streaming anchor. */
export function setSubject(ctx: ScriptContext, node: sceneTree.Node | null): void {
    if (ctx.client) ctx.client.subject = node;
}

/**
 * The active render camera node, composed each frame from its TransformTrait pose and
 * CameraTrait projection. Defaults to the room's camera node. Server-side, ctx.client is
 * undefined and this returns null.
 */
export function getCamera(ctx: ScriptContext): sceneTree.Node | null {
    return ctx.client?.camera ?? null;
}

/** Points the active render camera at `node`. Client-only, a no-op on the server. */
export function setCamera(ctx: ScriptContext, node: sceneTree.Node): void {
    if (ctx.client) ctx.client.camera = node;
}
