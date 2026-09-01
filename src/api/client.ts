import type { JsonValue } from 'bongle/interface';
import * as Transfer from '../client/transfer';
import type { ScriptContext } from '../core/scene/scripts';
import { releasePointer } from './pointer-lock';

/**
 * Where this client is playing. One verb covers both moves, because they differ
 * only in the destination: a new server of the project they are in, or another
 * project entirely.
 *
 * The transport lives on the `ClientDriver` supplied at engine init — the engine
 * knows a project slug and nothing else. Whether to ask, what the card says, and
 * whether "going" is a navigation or a new tab are all the host's, since routes
 * and navigation are platform knowledge this layer deliberately does not hold.
 */
export const client = {
    /**
     * Move this player into a different game session. Client-only.
     *
     * **Without `project`**: re-enter matchmaking for the project they are
     * already in, with new options / joinData — a gamemode switch, a team split,
     * lobby to game. There is nothing to confirm; the host detaches this client
     * and reconnects it to the new allocation.
     *
     * **With `project`**: send them to a DIFFERENT project, by slug. The host
     * asks them first (a game cannot move someone silently) and on accept takes
     * them there, ending this session. A refused target then rests for a while,
     * so the natural spelling — "while the player is standing on the trigger,
     * ask" — does not re-ask every tick; calls for that target simply resolve
     * false until it lapses. Only one ask may be outstanding at a time.
     *
     * Resolves whether the player is going. False means they stayed: they
     * declined, the target is not theirs to play, or the host has nowhere to
     * send them (local dev, a standalone build, an embed). True on the
     * cross-project path means the host is already navigating away, so the game
     * gets a frame or two at most.
     *
     *   transfer(ctx, { options: { mode: 'coop' } });               // new server, here
     *   await transfer(ctx, { project: 'neon-drift' });             // elsewhere, asks first
     *
     * The destination receives `joinData` from an arbitrary source project, so a
     * game should treat its own `joinData` as untrusted input.
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

        // Same project: no confirmation to gather, so this stays the plain
        // fire-and-forget re-enqueue it has always been.
        if (o?.project === undefined) {
            state.driver.matchmake({ options, joinData: o?.joinData });
            return true;
        }

        const slug = o.project;
        // The engine cannot tell whether `slug` IS the project it is running —
        // that is platform knowledge it deliberately does not hold — so a game
        // naming its own slug takes the asking path. Harmless, just redundant.
        if (Transfer.resting(state.transfer, slug)) return false;

        // The host draws the confirmation, and in a deployed session it draws it
        // in the parent frame — outside this sandboxed document. Pointer lock is
        // held HERE, by the game's own document, and only this document can drop
        // it, so a locked cursor would leave the player unable to click a dialog
        // they can see. A raw `exitPointerLock` from the host would not do: the
        // engine's own reconcile would re-acquire on the next click.
        const pointer = releasePointer(ctx);
        try {
            return await Transfer.whileAsking(state.transfer, slug, () =>
                state.driver.transfer({ slug, options, joinData: o?.joinData }),
            );
        } finally {
            // Unconditional. Where the host really navigates this is inert, since
            // re-acquiring needs a user gesture the departing page never gets; but
            // a host that stays alive after a transfer (the editor opens a new
            // tab) would otherwise be left with a free cursor for good.
            pointer.restore();
        }
    },
};
