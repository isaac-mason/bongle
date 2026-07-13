import { fileURLToPath } from 'node:url';
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

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [envPlugin(SERVER_ENV)],
    // worker.plugins is BLANKET (applies to every worker bundle — vite has no
    // per-worker granularity). Safe here because EVERY worker is server-env:
    // the server worker, and later the pipeline worker (server:true,
    // editor:true). The one client-env realm is an IFRAME (separate document +
    // build), not a worker, so it's unaffected.
    worker: { format: 'es', plugins: () => [envPlugin(SERVER_ENV)] },
    server: {
        // rolldown-wasm (and later ffmpeg.wasm threads) use SharedArrayBuffer,
        // which requires cross-origin isolation. These headers make
        // `self.crossOriginIsolated` true.
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        // reach ../src (engine source) + hoisted node_modules.
        fs: { allow: ['..'] },
    },
    // engine + workspace deps must resolve to ONE module instance so the
    // registry user code writes to is the same one the pipeline reads.
    optimizeDeps: {
        exclude: ['bongle', 'gpucat', 'mathcat', 'packcat', 'crashcat'],
    },
});
