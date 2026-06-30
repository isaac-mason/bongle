// Free helper: resolve a connected Client (per-connection number) to
// its authenticated User (durable platform identity). Server-only.
// Throws if the client isn't connected, a stale Client reference is
// a bug, not something scripts should branch on.

import type { Client, User } from 'bongle/interface';
import type { ScriptContext } from '../core/scene/scripts';

export function clientToUser(ctx: ScriptContext, client: Client): User {
    if (!ctx.server) throw new Error('[bongle] clientToUser: server-only');
    const state = ctx.server.state.clients.connected.get(client);
    if (!state) throw new Error(`[bongle] clientToUser: client ${client} is not connected`);
    return state.user;
}
