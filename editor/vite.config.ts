import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { envPlugin } from './bundler/env-plugin';

// monaco-editor 0.55's bundled TypeScript attaches a `repopulateInfo` FUNCTION to
// the "cannot find declaration for module / try npm i @types" DIAGNOSTIC message
// chain. The TS language worker returns diagnostics verbatim, so monaco's worker
// RPC throws
//   DataCloneError: ()=>({moduleReference,mode,packageName}) could not be cloned
// when it postMessages the result to the main thread — fires on every edit, since
// getSemanticDiagnostics/getSuggestionDiagnostics run in the background. Monaco
// spawns the worker via `new Worker(new URL('ts.worker.js', ...))` in
// workerManager.js (MonacoEnvironment.getWorker routing is unreliable), so we
// patch the shared worker SOURCE (tsWorker.js, imported by every TS worker entry)
// to strip the function before results are returned. The diagnostic path funnels
// through `clearFiles` (monaco's existing per-diagnostic sanitizer that already
// strips the non-cloneable `.file`); we strip `repopulateInfo` from each
// diagnostic's messageText chain there, so every diagnostic method is covered by
// one patch. TS recomputes from the other fields, so auto-import quick-fixes still
// work; the diagnostic just becomes structured-cloneable.
//
// The strip walks ONLY the DiagnosticMessageChain shape (`.repopulateInfo` +
// `.next`) — NOT a blind Object.keys walk. A blind walk reads every property
// (`o[k]`), which invokes getters; TS diagnostics reference live compiler objects
// whose getters can throw, and an uncaught throw here kills the worker
// (onError → "Could not create web worker(s)" fallback). Touching only the two
// known chain fields keeps it getter-safe.
function stripMonacoRepopulateInfo(): Plugin {
    const STRIP =
        'function __bongleStripRepopulate(chain,depth){if(!chain||typeof chain!=="object"||depth>32)return;if(typeof chain.repopulateInfo==="function"){try{delete chain.repopulateInfo}catch{}}const n=chain.next;if(Array.isArray(n))for(let i=0;i<n.length;i++)__bongleStripRepopulate(n[i],depth+1)}';
    // clearFiles' per-diagnostic push is the injection point; strip the diagnostic's
    // messageText chain (+ any relatedInformation chains) before it's collected.
    const NEEDLE = 'diagnostics.push(diagnostic);';
    const PATCH =
        '__bongleStripRepopulate(diagnostic.messageText,0);if(diagnostic.relatedInformation)for(const __ri of diagnostic.relatedInformation)__bongleStripRepopulate(__ri.messageText,0);diagnostics.push(diagnostic);';
    return {
        name: 'bongle:strip-monaco-repopulate-info',
        enforce: 'pre',
        transform(code, id) {
            if (!id.includes('monaco-editor') || !id.replace(/\?.*$/, '').endsWith('tsWorker.js')) return null;
            if (!code.includes(NEEDLE)) return null;
            return `${STRIP}\n${code.replace(NEEDLE, PATCH)}`;
        },
    };
}

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
    plugins: [stripMonacoRepopulateInfo(), watchEngineZip(), tailwindcss(), envPlugin(SERVER_ENV)],
    // worker.plugins is BLANKET (applies to every worker bundle — vite has no
    // per-worker granularity). Safe here because EVERY worker is server-env:
    // the server worker, and later the pipeline worker (server:true,
    // editor:true). The one client-env realm is an IFRAME (separate document +
    // build), not a worker, so it's unaffected. The monaco strip must live here
    // too: the TS language worker (which imports tsWorker.js) is a worker bundle.
    worker: { format: 'es', plugins: () => [stripMonacoRepopulateInfo(), envPlugin(SERVER_ENV)] },
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
