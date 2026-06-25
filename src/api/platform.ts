import type { ScriptContext } from '../core/scene/scripts';

/**
 * Game-facing bridge to the active host portal (CrazyGames / Poki / none).
 * Client-only. The transport lives on the ClientDriver supplied at engine init
 * — this just hands off to it. Standalone / kit-dev hosts wire these to an
 * inert impl, so a game can call them unconditionally regardless of where it's
 * running.
 *
 * Loading/gameplay lifecycle is NOT here — the host infers that from the
 * connection. These are the ad moments only the game knows the timing of
 * (between rounds, on death, etc.).
 *
 * Audio is muted for the duration of every ad automatically: we set
 * `state.adActive` while the ad runs, and the client update loop reconciles the
 * engine's audio output mute against it each frame. Games don't think about it.
 */
export const platform = {
    /** Show an interstitial at a natural break. Resolves when the ad finishes
     *  or is skipped (or immediately when there's no portal). */
    commercialBreak(ctx: ScriptContext): Promise<void> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.commercialBreak: client-only');
        const state = client.state;
        return whileAdActive(state, () => state.driver.platform.commercialBreak());
    },
    /** Offer an opt-in rewarded ad. Resolves whether the reward was earned
     *  (false when there's no portal). */
    rewardedBreak(ctx: ScriptContext): Promise<boolean> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.rewardedBreak: client-only');
        const state = client.state;
        return whileAdActive(state, () => state.driver.platform.rewardedBreak());
    },
};

/** Flag the engine as showing an ad for the lifetime of `run`, clearing it
 *  whatever the outcome. The audio mute is driven off this flag in the update
 *  loop — see `EngineClient.update`. */
function whileAdActive<T>(state: { adActive: boolean }, run: () => Promise<T>): Promise<T> {
    state.adActive = true;
    return run().finally(() => {
        state.adActive = false;
    });
}
