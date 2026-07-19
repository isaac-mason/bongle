// editor/ui/components/monaco-env.ts — Monaco worker wiring for vite.
//
// Monaco's language services run in web workers. We route worker creation through
// `MonacoEnvironment.getWorker`, returning vite `?worker` bundles — in particular
// our OWN TS worker (auto-import + diagnostic sanitizing). Without this, monaco
// falls back to its internal `new URL('x.worker.js')` default workers and our
// custom TS worker is never used.
//
// This MUST be exported + CALLED, not run as a bare `import './monaco-env'` side
// effect: lib/package.json's `sideEffects` allowlist excludes editor/**, so the
// production build tree-shakes bare side-effect imports — which silently dropped
// this whole assignment (monaco then used its defaults; auto-import broke). A real
// function call with a global side effect survives DCE. Call once before any editor.

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// our own TS worker: sanitizes diagnostics for structured clone + adds auto-import
// completion methods. See ts.worker.ts.
import tsWorker from './ts.worker?worker';

export function installMonacoWorkers(): void {
    (self as unknown as { MonacoEnvironment: { getWorker(id: string, label: string): Worker } }).MonacoEnvironment = {
        getWorker(_id, label) {
            if (label === 'typescript' || label === 'javascript') return new tsWorker();
            if (label === 'json') return new jsonWorker();
            if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
            if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
            return new editorWorker();
        },
    };
}
