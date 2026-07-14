import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { envPlugin } from './bundler/env-plugin';

// The one vite setup for the editor. `pnpm exec vite` from lib/editor runs it
// standalone (local dev); the website imports the same `mountEditor` entry.
//
// The engine is bundled from workspace source; envPlugin replaces compile-time
// `env.<key>` so the right branches survive + DCE. This realm is the pipeline
// realm (evaluate user declarations + bake): server + editor, no client. The
// client iframe (client:true) is a separate realm/build, added later.
const SERVER_ENV = { client: false, server: true, editor: true };

export default defineConfig(({ command }) => ({
    root: fileURLToPath(new URL('.', import.meta.url)),
    // the deployed editor is served same-origin at /static/bongle-editor/ (mirrors
    // blockbench). A build-only base re-roots every asset + document URL under that
    // subpath; dev stays at '/' so `pnpm exec vite` / ./dev.sh are unchanged. The
    // one runtime-string reference (the client iframe src) reads import.meta.env.
    // BASE_URL to match — see client/client-host.ts.
    base: command === 'build' ? '/static/bongle-editor/' : '/',
    // tailwind only needs the main document build; workers render no CSS.
    plugins: [tailwindcss(), envPlugin(SERVER_ENV)],
    // worker.plugins is BLANKET (applies to every worker bundle — vite has no
    // per-worker granularity). Safe here because EVERY worker is server-env:
    // the server worker, and later the pipeline worker (server:true,
    // editor:true). The one client-env realm is an IFRAME (separate document +
    // build), not a worker, so it's unaffected.
    worker: { format: 'es', plugins: () => [envPlugin(SERVER_ENV)] },
    server: {
        // rolldown-wasm (and later ffmpeg.wasm threads) use SharedArrayBuffer,
        // which requires cross-origin isolation. These headers make
        // `self.crossOriginIsolated` true. `credentialless` (not require-corp)
        // matches the website embed (server.mjs) so cross-origin fetches load
        // without being CORP-blocked.
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        },
        // reach ../src (engine source) + hoisted node_modules.
        fs: { allow: ['..'] },
    },
    build: {
        // TWO HTML documents: the editor shell + the client realm's iframe. The
        // client (client/index.html → client-main) is loaded at RUNTIME via
        // iframe.src, not a static import, so it must be an explicit input or the
        // production build omits it (dev's vite serves any index.html on demand).
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                client: fileURLToPath(new URL('./client/index.html', import.meta.url)),
            },
        },
    },
    // engine + workspace deps must resolve to ONE module instance so the
    // registry user code writes to is the same one the pipeline reads.
    optimizeDeps: {
        exclude: ['bongle', 'gpucat', 'mathcat', 'packcat', 'crashcat'],
        // @rolldown/browser: the bundler worker uses `/experimental` (transform +
        // module-runner rewrite); the main-thread prod build (editor/build) uses
        // the `.` export (full `rolldown` bundler). Both must be pre-bundled or
        // vite resolves their `default` (node) export, which imports `node:url`
        // and dies silently on load — force the `browser` build for each.
        include: ['@rolldown/browser/experimental', '@rolldown/browser'],
    },
}));
