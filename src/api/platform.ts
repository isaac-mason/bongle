import * as Ads from '../client/ads';
import type { ScriptContext } from '../core/scene/scripts';

/**
 * Game-facing bridge to the active host portal (CrazyGames / Poki / none).
 * Client-only. The transport lives on the ClientDriver supplied at engine init,
 * this just hands off to it. Standalone / bongle-dev hosts wire these to an
 * inert impl, so a game can call them unconditionally regardless of where it's
 * running.
 *
 * Loading/gameplay lifecycle is NOT here, the host infers that from the
 * connection. These are the ad moments only the game knows the timing of
 * (between rounds, on death, etc.). Audio muting for the ad's duration is
 * handled by `Ads` + the update loop, so games don't think about it.
 */
export const platform = {
    /** Show an interstitial at a natural break. Resolves when the ad finishes
     *  or is skipped (or immediately when there's no portal). */
    commercialBreak(ctx: ScriptContext): Promise<void> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.commercialBreak: client-only');
        const state = client.state;
        return Ads.whileShowing(state.ads, () => state.driver.platform.commercialBreak());
    },
    /** Offer an opt-in rewarded ad. Resolves whether the reward was earned
     *  (false when there's no portal). */
    rewardedBreak(ctx: ScriptContext): Promise<boolean> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.rewardedBreak: client-only');
        const state = client.state;
        return Ads.whileShowing(state.ads, () => state.driver.platform.rewardedBreak());
    },
};
