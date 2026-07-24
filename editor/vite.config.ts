import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { envPlugin } from './env-plugin';

// The engine prebundle (editor-node-modules.zip) is imported as a `?url` asset,
// which rollup does NOT treat as a watched input — so `vite build --watch`
// wouldn't rebuild when a `pnpm -C lib build` regenerates it. Register it as a
// watch file so dev.sh's engine watcher (lib/src → rebuild zip) flows through the
// same persistent editor watcher, incrementally.
function watchEngineZip(): Plugin {
    const zip = fileURLToPath(new URL('./editor-node-modules.zip', import.meta.url));
    return {
        name: 'bongle:watch-engine-zip',
        buildStart() {
            this.addWatchFile(zip);
        },
    };
}

// The project-fs SW (sw.ts) is bundled via `?worker&url`, so its script isn't at the
// origin root — to control root-level `@project/` URLs it registers with `scope: '/'`,
// which the browser only allows if the script response carries `Service-Worker-
// Allowed: /`. This adds it for standalone `vite dev`; dev.sh (dev-static-server.mjs)
// and prod (the editor.<zone> edge rule) set the same header their own way.
function serviceWorkerScope(): Plugin {
    return {
        name: 'bongle:sw-scope',
        configureServer(server) {
            server.middlewares.use((_req, res, next) => {
                res.setHeader('Service-Worker-Allowed', '/');
                next();
            });
        },
    };
}

// `vite build --watch` dumps the full chunk listing on EVERY rebuild, which
// floods the dev.sh logs. dev.sh runs it at `--logLevel warn` to silence that
// info spew (build errors still print in full), and this plugin restores a
// single terse success line per rebuild — so a green build is one line and a
// broken one is the whole stack. Watch-mode only; a one-shot prod build stays
// silent-on-success as before.
function quietWatchLog(): Plugin {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        name: 'bongle:quiet-watch-log',
        closeBundle() {
            if (!this.meta.watchMode) return;
            // debounce: closeBundle can fire more than once per rebuild; collapse
            // the burst into one line. The first (cold) build logs too — a ready
            // signal that /editor has stopped 404ing.
            clearTimeout(timer);
            timer = setTimeout(() => console.log('rebuilt ✓'), 150);
        },
    };
}

// The one vite setup for the editor. `pnpm exec vite` from lib/editor runs it
// standalone (local dev); the website imports the same `mountEditor` entry.
//
// The engine is bundled from workspace source; envPlugin replaces compile-time
// `env.<key>` so the right branches survive + DCE. This realm is the pipeline
// realm (evaluate user declarations + bake): server + editor, no client. The
// client iframe (client:true) is a separate realm/build, added later.
const SERVER_ENV = { client: false, server: true, editor: true };

export default defineConfig(() => ({
    root: fileURLToPath(new URL('.', import.meta.url)),
    // The editor is served from its own origin root (editor.<zone> in prod, a
    // localhost port in dev — see dev.sh). base '/' both ways: assets, the two
    // HTML documents, and the blockbench tree all sit at the origin root. The
    // one runtime-string reference (the client iframe src) reads import.meta.env.
    // BASE_URL to match — see client/client-host.ts.
    base: '/',
    // tailwind only needs the main document build; workers render no CSS.
    plugins: [serviceWorkerScope(), watchEngineZip(), quietWatchLog(), tailwindcss(), envPlugin(SERVER_ENV)],
    // worker.plugins is BLANKET (applies to every worker bundle — vite has no
    // per-worker granularity). Safe here because EVERY worker is server-env:
    // the server worker, and later the pipeline worker (server:true,
    // editor:true). The one client-env realm is an IFRAME (separate document +
    // build), not a worker, so it's unaffected. (The monaco TS worker's
    // diagnostic sanitizing now lives in our ts.worker.ts subclass, not a plugin.)
    worker: {
        format: 'es' as const,
        plugins: () => [envPlugin(SERVER_ENV)],
        // Pin the project-fs SW (sw.ts) to a ROOT filename so its default scope is '/'
        // — it controls root-level `@project/` URLs, and a root script needs no
        // Service-Worker-Allowed header in the build-based flows (dev.sh, prod). Other
        // workers keep hashed names. An unhashed SW name is also correct: the browser
        // byte-diffs a stable SW URL to detect updates. (Standalone `vite dev` serves
        // the SW from a non-root dev URL, so the sw-scope plugin's header covers it.)
        rollupOptions: {
            output: {
                entryFileNames: (chunk) => {
                    // the project-fs SW → root `sw.js` (scope '/'); every other worker keeps a hashed name.
                    if (chunk.name === 'sw' || chunk.facadeModuleId?.endsWith('/sw.ts')) return 'sw.js';
                    return 'assets/[name]-[hash].js';
                },
            },
        },
    },
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
        // client (realms/client/index.html → client-main) is loaded at RUNTIME via
        // iframe.src, not a static import, so it must be an explicit input or the
        // production build omits it (dev's vite serves any index.html on demand).
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                client: fileURLToPath(new URL('./realms/client/index.html', import.meta.url)),
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
