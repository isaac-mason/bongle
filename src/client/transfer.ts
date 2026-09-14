/** How long a refused target rests before it can be asked again. */
const COOLDOWN_MS = 3_000;

export type Transfer = {
    /** true while a cross-project ask is outstanding with the host. */
    pending: boolean;
    /** target slug -> the time it may next be asked about. Keyed by slug alone
     *  so a varying joinData field can't defeat the cooldown. */
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

/** Run one ask, holding the single-flight for its lifetime. A host that throws
 *  counts as a refusal, so it still rests the target. */
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
            // no rest once they really went: the host is navigating away with this client
            if (!went) transfer.cooldowns.set(slug, performance.now() + COOLDOWN_MS);
        });
}
