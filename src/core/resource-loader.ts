export type ResourceLoader = {
    /** Loads an asset's raw bytes by relative url/path. */
    loadBytes(url: string): Promise<Uint8Array>;
    /** Decodes encoded image bytes into RGBA + dimensions. Present only where the environment has no DOM image APIs (the asset pipeline). */
    decodeImage?(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number; rgba: Uint8Array }>;
    /** Starts loading `url` now so the matching `loadBytes` resolves from the in-flight request. Advisory: every caller must work unchanged when it is absent. */
    prefetch?(url: string): void;
};
