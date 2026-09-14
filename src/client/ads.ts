/** Host platform ad state; the client mutes audio output while `active`. */
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
