import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// lib build → dist/*.js — an ENV-NEUTRAL PREBUNDLE of the engine. This is not
// the shipped realm code and it does NOT bake env: it's just compiled JS chunks
// so the editor doesn't ship/parse raw TS. env DCE happens later, IN THE
// BROWSER: the editor's in-browser bundler (@rolldown/browser) bundles the user
// project + these prebundled lib chunks TOGETHER, per realm, with envPlugin
// applied there — so env.client/server → literals and the other realm's
// branches shake out at that bundle step, not here.
//
// ONE build, many entry points (the exports-map subpaths). Shared code
// (mathcat/gpucat/…) lands in shared chunks each entry imports by the same url →
// native ESM URL dedup. d.ts is emitted separately by tsgo (env-agnostic tree).

// our own libs (github deps, `export * from 'x'`) get BUNDLED so they dedupe as
// shared chunks; everything else bare (react, gltf-transform, …) stays external
// and is resolved by the consumer.

// Keep the `env` seam intact through the prebundle: instead of bundling the env
// object into an internal chunk (which relativizes + renames the import, hiding
// it from the editor's in-browser envPlugin), externalize it under the stable
// specifier `bongle/env`. Every lib chunk then keeps `import { env } from
// 'bongle/env'`, which the browser envPlugin recognizes + replaces per realm.
// `dist/env.js` (the `env` entry) provides the object for any residual read.
const externalizeEnvSeam = () => ({
    name: 'externalize-env-seam',
    // 'pre' so this resolveId runs BEFORE vite's resolver turns `./api/env` into
    // a real file path (otherwise vite resolves it first and we never see it).
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
        if (!importer) return null; // the env entry itself — build it, don't externalize
        if (source === 'bongle/env' || /(^|\/)api\/env(\.ts)?$/.test(source)) {
            return { id: 'bongle/env', external: true };
        }
        return null;
    },
});

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    // relative base → builtin `new URL(asset, import.meta.url)` refs resolve
    // against the chunk's own location (…/dist/chunks/x.js → ../assets/y), so
    // they land on the seeded vfs path AND re-root to a CDN in prod. A default
    // '/' base would emit root-absolute /assets/… that drop the dist prefix.
    base: './',
    plugins: [externalizeEnvSeam()],
    // bundled npm deps branch on process.env.NODE_ENV; fold it to a literal so
    // rollup DCEs the dev-only paths. (The realm also installs a process shim for
    // the residual runtime probes — see editor/bundler/runner.ts.)
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // the engine's inline mesh worker must emit ESM (code-splitting isn't valid
    // with the iife default).
    worker: { format: 'es', plugins: () => [externalizeEnvSeam()] },
    build: {
        outDir: 'dist',
        // d.ts is emitted into dist too (separate tsgo step); don't wipe it, and
        // the build script rm's dist once up front.
        emptyOutDir: false,
        target: 'esnext',
        minify: false,
        // Emit every builtin `new URL(asset, import.meta.url)` reference as a FILE
        // under dist/assets/ instead of inlining it as a data: URL. Vite's lib
        // mode force-inlines these (to keep a library self-contained), so we drive
        // the same multi-entry build through rollupOptions.input instead, where
        // assetsInlineLimit is respected. The editor seeds dist/ into the vfs, so
        // builtin textures / models / sample-avatar glbs resolve to real files
        // there — same delivery as prod, where import.meta.url re-roots to a CDN.
        assetsInlineLimit: 0,
        // not build.lib: see above. cssCodeSplit off → one bongle.css like before.
        cssCodeSplit: false,
        rollupOptions: {
            // build.lib set this to 'strict'; without it (we drive input directly
            // to avoid lib-mode asset inlining) Rollup tree-shakes every entry's
            // exports — these are re-export barrels nothing in-graph consumes, so
            // they'd shake to empty and orphan their `new URL` assets. 'strict'
            // preserves the full export signature (and its asset refs).
            preserveEntrySignatures: 'strict',
            input: {
                index: 'src/index.ts',
                env: 'src/api/env.ts',
                internal: 'src/internal.ts',
                'engine-client': 'src/engine-client.ts',
                'engine-server': 'src/engine-server.ts',
                'engine-server-node': 'src/engine-server-node.ts',
                'engine-editor': 'src/engine-editor.ts',
                'engine-asset-pipeline': 'src/asset-pipeline/index.ts',
                mathcat: 'src/libs/mathcat.ts',
                gpucat: 'src/libs/gpucat.ts',
                crashcat: 'src/libs/crashcat.ts',
                starter: 'src/starter/index.ts',
                interface: 'interface/index.ts',
            },
            external(id: string) {
                if (id.startsWith('node:')) return true;
                // first-party libs are NOT bundled into bongle: they're seeded as
                // their own vfs node_modules packages (built dist) and resolved
                // there, so they dedupe across bongle + games instead of being
                // duplicated inside every bongle chunk. Third-party npm stays
                // bundled (CJS + react-dedup make it not worth un-bundling yet).
                if (/^(mathcat|packcat|gpucat|crashcat)(\/|$)/.test(id)) return true;
                return false;
            },
            output: {
                format: 'es',
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
        },
    },
});
