import type { ResourceLoader } from '../core/resource-loader';

const env = (import.meta as { env?: { PROD?: boolean } }).env;

/** In prod, resolves relative to the bundled module's URL so assets follow the deploy prefix. In dev, Vite serves resources from the document origin's root, so a leading `/` works. */
export function assetUrl(rel: string): string {
    const stripped = rel.replace(/^\//, '');
    if (env?.PROD) {
        return new URL(stripped, import.meta.url).toString();
    }
    return `/${stripped}`;
}

/** Default browser byte loader: fetches by `assetUrl(url)`, or verbatim if already an absolute http(s) URL (e.g. runtime-source avatars). */
export const fetchResourceLoader = async (url: string): Promise<Uint8Array> => {
    const inFlight = prefetches.get(url);
    if (inFlight) {
        prefetches.delete(url);
        return inFlight;
    }
    const resolved = url.startsWith('http:') || url.startsWith('https:') ? url : assetUrl(url);
    const r = await fetch(resolved);
    if (!r.ok) throw new Error(`fetch ${resolved}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
};

/** Prefetches started but not yet claimed by a `fetchResourceLoader` call. */
const prefetches = new Map<string, Promise<Uint8Array>>();

/** Starts downloading a bundle asset now, so it can overlap the render-backend load instead of queuing behind it. */
export function prefetchResource(url: string): void {
    if (prefetches.has(url)) return;
    const inFlight = fetchResourceLoader(url);
    inFlight.catch(() => {});
    prefetches.set(url, inFlight);
}

/** The browser's `ResourceLoader` for `EngineClient.init`. Byte loading only; texture loaders take the DOM image path instead of `decodeImage`. */
export const browserResourceLoader: ResourceLoader = {
    loadBytes: fetchResourceLoader,
    prefetch: prefetchResource,
};
