import * as Ads from '../client/ads';
import type { ScriptContext } from '../core/scene/scripts';

/**
 * Game-facing bridge to the active host platform (CrazyGames / Poki / none).
 * Client-only; standalone hosts wire these to an inert impl so a game can
 * call them unconditionally. Covers ad moments only the game knows the
 * timing of (between rounds, on death); audio muting is handled automatically.
 */
export const platform = {
    /** Show an interstitial at a natural break. Resolves when the ad finishes
     *  or is skipped (or immediately when there's no host platform). */
    commercialBreak(ctx: ScriptContext): Promise<void> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.commercialBreak: client-only');
        const state = client.state;
        return Ads.whileShowing(state.ads, () => state.driver.platform.commercialBreak());
    },
    /** Offer an opt-in rewarded ad. Resolves whether the reward was earned
     *  (false when there's no host platform). */
    rewardedBreak(ctx: ScriptContext): Promise<boolean> {
        const client = ctx.client;
        if (!client?.state) throw new Error('[bongle] platform.rewardedBreak: client-only');
        const state = client.state;
        return Ads.whileShowing(state.ads, () => state.driver.platform.rewardedBreak());
    },
};
