import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { bongleAssetRewrite } from './scripts/bongle-asset-rewrite';

// lib build → dist/* : bongle built as a normal package.
//
// bongle ships as a BUILT package (reverses the earlier "ship as source"): one
// dist/* per exports entry, so every consumer — the editor dev-server, the CLI
// dev server, the game publish build, and any `npm i bongle` — resolves the
// built package through package.json `exports`, instead of re-transforming
// ~3600 source modules at dev boot. The `source` export condition keeps src
// reachable for in-repo engine dev + the game publish build (unchanged DCE).
// See llm/plan-engine-dist-bundle.md.
//
// env-NEUTRAL: no envPlugin here, so `env.x` stays a runtime read. Each realm
// sets env at boot; the game publish build bakes+DCEs per target. tailwind only
// builds the one engine stylesheet (src/client/ui/editor.css → dist/bongle.css,
// seeded by pack-vfs + injected by client-main); the css rides a tiny JS entry
// (scripts/bongle-css.entry.ts) since a CSS file can't be a rollup input.
const entry = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [tailwindcss(), bongleAssetRewrite()],
    // self-imports (`bongle/env`, `bongle/internal`, …) resolve to SRC during
    // this build, so shared modules dedupe into the one core chunk (below)
    // instead of becoming external self-refs (which would double-instance the
    // singletons). Needs exports.source → src.
    resolve: { conditions: ['source', 'import', 'module', 'browser', 'default'] },
    build: {
        outDir: 'dist',
        // d.ts (tsgo) also writes into dist; don't wipe it. The build script rm's
        // dist once up front.
        emptyOutDir: false,
        cssCodeSplit: false,
        minify: false, // a lib dist; the consuming game build minifies
        sourcemap: false, // keep the seed lean
        lib: {
            formats: ['es'], // ESM only — tree-shakeable by the downstream build
            entry: {
                index: entry('src/index.ts'),
                'engine-client': entry('src/engine-client.ts'),
                'engine-server': entry('src/engine-server.ts'),
                'engine-server-node': entry('src/engine-server-node.ts'),
                'engine-editor': entry('src/engine-editor.ts'),
                'engine-asset-pipeline': entry('src/asset-pipeline/index.ts'),
                env: entry('src/env.ts'),
                internal: entry('src/internal.ts'),
                kit: entry('src/kit/index.ts'),
                interface: entry('interface/index.ts'), // its own top-level dir
                bongle: entry('scripts/bongle-css.entry.ts'), // css-only entry
            },
        },
        rollupOptions: {
            // Bundle bongle's OWN graph (relative imports + bongle/* self-refs,
            // which resolve to src above). Externalize EVERYTHING else bare:
            // third-party (react, zustand, fflate…), first-party siblings
            // (gpucat, mathcat, packcat, crashcat), and node builtins.
            external: (id) => {
                if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return false; // bundle
                if (id === 'bongle' || id.startsWith('bongle/')) return false; // self → src, bundle+dedupe
                if (isBuiltin(id)) return true; // node:* external
                return true; // every other bare specifier is a dependency → external
            },
            output: {
                entryFileNames: '[name].js', // dist/engine-client.js, dist/avatar/rig.js, …
                // chunks live at dist/ root (NOT dist/chunks/) so they sit at the
                // SAME depth as the entry files. asset() refs rewritten to
                // ./assets/<pkgrel> (bongle-asset-rewrite) then resolve to
                // dist/assets/ from BOTH entries and chunks — a dist/chunks/ subdir
                // would make ./assets resolve one level off for entries.
                chunkFileNames: '[name]-[hash].js',
                assetFileNames: (info) => (info.name?.endsWith('.css') ? 'bongle.css' : 'assets/[name]-[hash][extname]'),
                // Chunk bongle's own graph by SUBSYSTEM — one SEPARATE group per
                // src/<dir>. Assigning every module to exactly one chunk keeps the
                // stateful singletons single (env, the __bongle registry, id
                // counters live in one chunk, imported everywhere). Two things make
                // this work: (1) SEPARATE groups, not one group with a name function
                // — separate groups let rolldown SHARE a module across chunks; a
                // name function re-duplicates small shared modules. (2) minSize:0
                // disables the small-chunk merger. The tests are non-overlapping
                // (env lives at src/env.ts now, NOT src/api/, so it no longer
                // collides with the api group).
                advancedChunks: {
                    minSize: 0,
                    minShareCount: 1,
                    groups: [
                        // ORDER = priority for SHARED modules a group pulls
                        // transitively. Rule: LEAF groups that pull nothing (env,
                        // internal) go FIRST so the general subsystems don't
                        // capture them into a bigger chunk; groups that PULL shared
                        // modules (node imports the avatar rig) go LAST so the leaf
                        // groups (avatar) claim those shared modules first — else
                        // `node` grabs rig.ts and drags node:fs into every realm
                        // that imports rig.
                        { name: 'env', test: /\/lib\/src\/env\.ts$/ },
                        { name: 'internal', test: /\/lib\/src\/internal(-runtime)?\.ts$/ },
                        { name: 'core', test: /\/lib\/src\/core\// },
                        { name: 'api', test: /\/lib\/src\/api\// },
                        { name: 'builtins', test: /\/lib\/src\/builtins\// },
                        { name: 'client', test: /\/lib\/src\/client\// },
                        { name: 'editor', test: /\/lib\/src\/editor\// },
                        { name: 'icons', test: /\/lib\/icons\// },
                        { name: 'avatar', test: /\/lib\/avatar\// },
                        { name: 'migrations', test: /\/lib\/src\/migrations\// },
                        { name: 'render', test: /\/lib\/src\/render\// },
                        { name: 'server', test: /\/lib\/src\/server\// },
                        { name: 'pipeline', test: /\/lib\/src\/asset-pipeline\// },
                        { name: 'interface', test: /\/lib\/interface\// },
                        // node-realm code (node:fs/zlib, reachable ONLY via
                        // engine-server-node) — LAST, its own chunk, so it never
                        // lands in the browser-safe chunks other realms load.
                        { name: 'node', test: /\/lib\/src\/node\// },
                    ],
                },
            },
        },
    },
});
