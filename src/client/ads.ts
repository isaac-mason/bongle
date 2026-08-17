/**
 * Host portal ad state (CrazyGames / Poki / none). The game's audio is muted
 * for the lifetime of every ad automatically: `whileShowing` raises `active`
 * while the ad runs, and the client update loop reconciles the audio output mute
 * against it each frame. Games never manage it.
 */

export type Ads = {
    /** true while an interstitial / rewarded break is showing. */
    active: boolean;
};

export function init(): Ads {
    return { active: false };
}

/** Mark an ad as showing for the lifetime of `run`, clearing it whatever the outcome. */
export function whileShowing<T>(ads: Ads, run: () => Promise<T>): Promise<T> {
    ads.active = true;
    return run().finally(() => {
        ads.active = false;
    });
}
