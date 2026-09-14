import type { JsonValue } from 'bongle/interface';
import * as Transfer from '../client/transfer';
import type { ScriptContext } from '../core/scene/scripts';
import { releasePointer } from './pointer-lock';

export const client = {
    /**
     * Move this player into a different game session. Client-only.
     *
     * Without `project`: re-enters matchmaking for the current project with
     * new options/joinData, no confirmation needed. With `project`: asks the
     * player first, then sends them to that project by slug, ending this
     * session. A refused target rests for a while, so repeated calls resolve
     * false without re-asking every tick; only one ask may be outstanding.
     *
     * Resolves whether the player is going. False means they stayed
     * (declined, invalid target, or nowhere to send them). True on the
     * cross-project path means the host is already navigating away.
     *
     * @example
     * transfer(ctx, { options: { mode: 'coop' } });
     * await transfer(ctx, { project: 'neon-drift' });
     *
     * The destination receives `joinData` from an arbitrary source project,
     * treat your own `joinData` as untrusted input.
     */
    async transfer(
        ctx: ScriptContext,
        o?: {
            /** Target project slug. Omitted means "this project, new server". */
            project?: string;
            options?: Record<string, string | number | boolean>;
            joinData?: Record<string, JsonValue>;
        },
    ): Promise<boolean> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] client.transfer: client-only');
        const state = client.state;
        const options = o?.options ?? {};

        if (o?.project === undefined) {
            state.driver.matchmake({ options, joinData: o?.joinData });
            return true;
        }

        const slug = o.project;
        if (Transfer.resting(state.transfer, slug)) return false;

        // pointer lock is held by this document; the confirmation dialog is
        // drawn by the host, so the cursor must be freed before asking.
        const pointer = releasePointer(ctx);
        try {
            return await Transfer.whileAsking(state.transfer, slug, () =>
                state.driver.transfer({ slug, options, joinData: o?.joinData }),
            );
        } finally {
            pointer.restore();
        }
    },
};
