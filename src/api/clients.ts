import type { Client, User } from 'bongle/interface';
import type { ScriptContext } from '../core/scene/scripts';

export function clientToUser(ctx: ScriptContext, client: Client): User {
    if (!ctx.server) throw new Error('[bongle] clientToUser: server-only');
    const state = ctx.server.state.clients.connected.get(client);
    if (!state) throw new Error(`[bongle] clientToUser: client ${client} is not connected`);
    return state.user;
}
