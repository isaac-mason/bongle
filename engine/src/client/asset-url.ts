// Bundle-relative asset URL resolver.
//
// Production: the engine ships as a single file at `client/index.js`.
// Generated assets (atlases, model bins, …) sit as siblings under the
// same dir. `import.meta.url` of the bundled module is that dir's URL,
// so `new URL(rel, import.meta.url)` lands on the asset regardless of
// whether the bundle was deployed to localhost, play.bongle.io, or a
// CDN with an arbitrary prefix.
//
// Dev: Vite serves each engine module at its own dev URL — so
// `import.meta.url` is module-specific and useless as a base. Instead,
// the kit's dev middleware (kit/src/dev.ts → bongle-serve-resources)
// streams everything in `resources/client/` from the document origin's
// root, so a leading `/` works.
//
// `import.meta.env.PROD` is replaced at build time by Vite, so each
// shipped bundle ends up with only the relevant branch.

const env = (import.meta as { env?: { PROD?: boolean } }).env;

export function assetUrl(rel: string): string {
    const stripped = rel.replace(/^\//, '');
    if (env?.PROD) {
        return new URL(stripped, import.meta.url).toString();
    }
    return `/${stripped}`;
}
