import type { JsonValue } from 'bongle/interface';
import type { ScriptContext } from '../core/scene/scripts';
import { releasePointer } from './pointer-lock';

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

    /**
     * Ask the host to send this player to a different project, by slug.
     * Client-only.
     *
     * The host asks the player first — a game cannot move someone silently —
     * and on accept it navigates to that project's play page, ending this
     * session. `options` / `joinData` ride along to the destination exactly as
     * they do for `matchmake`.
     *
     * Resolves **false** whenever the player stays: they declined, the target
     * does not exist or is not theirs to play, they are not signed in, or the
     * host has nowhere to send them (local dev, a standalone build, an embed).
     * A **true** resolution means the host is already navigating away, so the
     * game gets a frame or two at most. Treat false as the actionable outcome.
     *
     *   if (!(await client.portal(ctx, 'neon-drift'))) showStayedBehindUi();
     *
     * The destination receives `joinData` from an arbitrary source project, so
     * a game should treat its own `joinData` as untrusted input.
     */
    async portal(
        ctx: ScriptContext,
        slug: string,
        o?: {
            options?: Record<string, string | number | boolean>;
            joinData?: Record<string, JsonValue>;
        },
    ): Promise<boolean> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] client.portal: client-only');
        const pointer = releasePointer(ctx);
        try {
            return await client.state.driver.portal({ slug, options: o?.options ?? {}, joinData: o?.joinData });
        } finally {
            pointer.restore();
        }
    },
};
