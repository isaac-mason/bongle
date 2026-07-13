import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { envPlugin } from '../bundler/env-plugin';

// The CLIENT realm's vite setup — a SEPARATE origin from the main editor
// (editor/vite.config.ts). It has to be separate because:
//   1. env: the client is client:true; the main doc + its workers are
//      server:true. env is compile-time (DCE strips node-only server code from
//      the client, GPU-only client code from the server), and one vite graph
//      can't compile the shared engine source under both envs at once.
//   2. origin: each client is an <iframe> the main document embeds. A distinct
//      origin is the isolation seam for untrusted remixed code later, and lets
//      us open MANY client windows (each its own document + input + canvas),
//      all wired to the one server worker.
const CLIENT_ENV = { client: true, server: false, editor: true };

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [envPlugin(CLIENT_ENV)],
    // a future client-side bundler-in-worker would be client-env too.
    worker: { format: 'es', plugins: () => [envPlugin(CLIENT_ENV)] },
    server: {
        port: 5174,
        strictPort: true,
        headers: {
            // the client bundler (rolldown-wasm) uses SharedArrayBuffer → this
            // document must be cross-origin isolated too.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            // the main editor is require-corp; without this its <iframe> embed
            // of this cross-origin document would be blocked.
            'Cross-Origin-Resource-Policy': 'cross-origin',
        },
        // reach ../../src (engine source) + hoisted node_modules.
        fs: { allow: ['../..'] },
    },
    optimizeDeps: {
        exclude: ['bongle', 'gpucat', 'mathcat', 'packcat', 'crashcat'],
    },
});
