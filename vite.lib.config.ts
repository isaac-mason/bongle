import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// lib build → dist/*.js — the versioned engine artifact the editor realms load
// as PRE-BUILT JS (not raw TS re-transformed at runtime). ONE rolldown build
// (vite 8 is rolldown-based) with many entry points = the exports-map subpaths;
// shared code (mathcat/gpucat/…) lands in shared chunks each entry imports by
// the SAME url → native ESM URL dedup → one instance within a realm. Env is NOT
// baked here — `env.client/server` are runtime flags each realm sets at boot;
// envPlugin DCE is a publish-size concern, not this build.
//
// d.ts is emitted separately by `tsgo -p tsconfig.build.json` (per-file tree).

// our own libs (github deps, `export * from 'x'`) get BUNDLED so they dedupe as
// shared chunks; everything else bare (react, gltf-transform, …) stays external
// and is resolved by the consumer.
const FIRST_PARTY_LIBS = /^(mathcat|gpucat|packcat|crashcat)(\/|$)/;
const isBare = (id: string) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    // the engine's inline mesh worker must emit ESM (code-splitting isn't valid
    // with the iife default).
    worker: { format: 'es' },
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
                internal: 'src/internal.ts',
                'engine-client': 'src/engine-client.ts',
                'engine-server': 'src/engine-server.ts',
                'engine-editor': 'src/engine-editor.ts',
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
