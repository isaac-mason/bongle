import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// lib build → dist/bongle.css ONLY.
//
// World C (llm/plan-in-browser-editor.md): bongle ships as SOURCE — the editor's
// in-browser bundler compiles it, and the publish build (editor/build) bundles it
// from source too. So this no longer prebundles the engine into dist/*.js; it
// survives solely to compile the engine UI's tailwind entry (src/client/ui/
// editor.css, whose @source scans src/client/ui + src/editor) into a stable
// dist/bongle.css that pack-vfs seeds + client-main injects. Everything else —
// source, first-party libs, the dependency prebundle, d.ts — is assembled by
// build-deps.mjs / gather-lib-*.mjs / pack-vfs.mjs.
//
// A CSS file can't be a rolldown input directly (cssCodeSplit:false rejects it),
// so a tiny JS entry (scripts/bongle-css.entry.ts) just imports the css; its
// ~0-byte chunk is unused (pack-vfs seeds only bongle.css).
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [tailwindcss()],
    build: {
        outDir: 'dist',
        // d.ts (tsgo) also writes into dist; don't wipe it. The build script rm's
        // dist once up front.
        emptyOutDir: false,
        cssCodeSplit: false,
        rollupOptions: {
            input: { bongle: 'scripts/bongle-css.entry.ts' },
            output: {
                // stable name for the one engine stylesheet; the entry's empty js
                // chunk lands under assets/ and is ignored.
                assetFileNames: (info) => (info.name?.endsWith('.css') ? 'bongle.css' : 'assets/[name]-[hash][extname]'),
            },
        },
    },
});
