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
const FIRST_PARTY_LIBS = /^(mathcat|gpucat|packcat|crashcat)(\/|$)/;
const isBare = (id: string) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');

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
    plugins: [externalizeEnvSeam()],
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
        lib: {
            entry: {
                index: 'src/index.ts',
                env: 'src/api/env.ts',
                internal: 'src/internal.ts',
                'engine-client': 'src/engine-client.ts',
                'engine-server': 'src/engine-server.ts',
                'engine-editor': 'src/engine-editor.ts',
                'engine-asset-pipeline': 'src/asset-pipeline/index.ts',
                mathcat: 'src/libs/mathcat.ts',
                gpucat: 'src/libs/gpucat.ts',
                crashcat: 'src/libs/crashcat.ts',
                starter: 'src/starter/index.ts',
                interface: 'interface/index.ts',
            },
            formats: ['es'],
        },
        rollupOptions: {
            external(id: string) {
                if (id.startsWith('node:')) return true;
                if (FIRST_PARTY_LIBS.test(id)) return false;
                return isBare(id);
            },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
            },
        },
    },
});
