import type { JsonValue } from 'bongle/interface';
import type { ScriptContext } from '../core/scene/scripts';

/**
 * Drop this client from the current allocation and re-enter the matchmaker
 * with new options / joinData. Client-only. The transport (engine
 * `play` message in dev, iframe-bridge re-enqueue in deployed) lives on the
 * ClientDriver supplied at engine init, this just hands off to it.
 *
 * Use cases: gamemode switches, team splits, lobby→game transitions.
 */
export const client = {
    matchmake(
        ctx: ScriptContext,
        opts: {
            options: Record<string, string | number | boolean>;
            joinData?: Record<string, JsonValue>;
        },
    ): void {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] client.matchmake: client-only');
        client.state.driver.matchmake(opts);
    },
};
