/**
 * `client.transfer` bookkeeping for the cross-project case: whose turn it is to
 * ask, and which targets are resting.
 *
 * Both exist because of how a portal is naturally written — "while the player is
 * standing in it, ask" — which calls from a tick. Without the single-flight that
 * stacks asks faster than a person can answer, orphaning every promise but the
 * last (and with it the paired pointer-lock restore). Without the cooldown a
 * refusal is re-asked on the very next frame, and since the host resolves the
 * target over the network before it can refuse, that is a request per frame.
 *
 * A same-project transfer (no `project`) needs neither: there is nothing to
 * confirm, and re-entering matchmaking on a game event is a legitimate thing to
 * do at whatever pace the game wants.
 */

/** How long a refused target rests. Long enough that a player standing in a
 *  portal they declined is not asked again immediately, short enough that
 *  walking away and coming back works. */
const COOLDOWN_MS = 3_000;

export type Transfer = {
    /** true while a cross-project ask is outstanding with the host. */
    pending: boolean;
    /** target slug -> the time it may next be asked about. Keyed by slug alone,
     *  deliberately: including the payload would let a joinData field that
     *  happens to vary (a timestamp, a position) defeat the cooldown entirely. */
    cooldowns: Map<string, number>;
};

export function init(): Transfer {
    return { pending: false, cooldowns: new Map() };
}

/** true when an ask for `slug` must be refused without troubling the host. */
export function resting(transfer: Transfer, slug: string): boolean {
    if (transfer.pending) return true;
    const readyAt = transfer.cooldowns.get(slug);
    return readyAt !== undefined && performance.now() < readyAt;
}

/**
 * Run one ask, holding the single-flight for its lifetime and resting the target
 * unless the player actually went. A host that throws counts as a refusal — the
 * player is still here, and a broken host should not be retried every frame.
 */
export function whileAsking(transfer: Transfer, slug: string, run: () => Promise<boolean>): Promise<boolean> {
    transfer.pending = true;
    let went = false;
    return run()
        .then((result) => {
            went = result;
            return result;
        })
        .finally(() => {
            transfer.pending = false;
            // No rest once they really went: the host is navigating away and
            // this client is going with it.
            if (!went) transfer.cooldowns.set(slug, performance.now() + COOLDOWN_MS);
        });
}
