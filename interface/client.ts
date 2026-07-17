export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type ClientDriver = {
    matchmake(opts: {
        options: Record<string, string | number | boolean>;
        joinData?: Record<string, JsonValue>;
    }): void;
    /** Bridge to the active host portal (CrazyGames / Poki / none). The game
     *  calls these generic, platform-agnostic verbs; the host routes them to
     *  whatever SDK it holds, or no-ops when there's no portal. Required, so
     *  call sites need no optional-chaining — no-portal hosts pass an inert
     *  impl. */
    platform: Platform;
};

/** Game-authored moments the host forwards to the active portal SDK. Flat and
 *  small by design — only things *no host can infer*. Loading/gameplay
 *  lifecycle is host-inferred (the website derives it from connection state),
 *  so it is deliberately absent here. */
export type Platform = {
    /** Interstitial at a natural break; resolves when done or skipped. */
    commercialBreak(): Promise<void>;
    /** Opt-in ad for a reward; resolves whether the reward was earned. */
    rewardedBreak(): Promise<boolean>;
};

export type ClientApp<S = any> = {
    init: (driver: ClientDriver) => S;
    load: (state: S) => Promise<void>;
    update: (state: S, dt: number) => void;
    dispose?: (state: S) => void;

    getInbox: (state: S) => Uint8Array[];
    getOutbox: (state: S) => Uint8Array[];
    clearOutbox: (state: S) => void;
};

export function client<S>(app: ClientApp<S>): ClientApp<S> {
    return app;
}
