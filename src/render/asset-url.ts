// Bundle-relative asset URL resolver.
//
// Production: the engine ships as a single file at `client/index.js`.
// Generated assets (atlases, model bins, …) sit as siblings under the
// same dir. `import.meta.url` of the bundled module is that dir's URL,
// so `new URL(rel, import.meta.url)` lands on the asset regardless of
// whether the bundle was deployed to localhost, play.bongle.io, or a
// CDN with an arbitrary prefix.
//
// Dev: Vite serves each engine module at its own dev URL, so
// `import.meta.url` is module-specific and useless as a base. Instead,
// the dev middleware (cli/dev/serve-resources.ts + the editor's serveResources)
// streams everything in `resources/client/` from the document origin's
// root, so a leading `/` works.
//
// `import.meta.env.PROD` is replaced at build time by Vite, so each
// shipped bundle ends up with only the relevant branch.

import type { ResourceLoader } from '../core/resource-loader';

const env = (import.meta as { env?: { PROD?: boolean } }).env;

export function assetUrl(rel: string): string {
    const stripped = rel.replace(/^\//, '');
    if (env?.PROD) {
        return new URL(stripped, import.meta.url).toString();
    }
    return `/${stripped}`;
}

/**
 * Default browser byte loader: fetch a bin by `assetUrl(url)` (or verbatim if
 * it's already an absolute http(s) URL, e.g. runtime-source avatars).
 */
export const fetchResourceLoader = async (url: string): Promise<Uint8Array> => {
    const resolved = url.startsWith('http:') || url.startsWith('https:') ? url : assetUrl(url);
    const r = await fetch(resolved);
    if (!r.ok) throw new Error(`fetch ${resolved}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
};

/**
 * The browser's `ResourceLoader` bag passed to `EngineClient.init`. Byte loading
 * only, no `decodeImage`, so the texture loaders take their DOM image path. The
 * asset pipeline (`src/asset-pipeline`) supplies a different loader (disk +
 * sharp `decodeImage`).
 */
export const browserResourceLoader: ResourceLoader = {
    loadBytes: fetchResourceLoader,
};
