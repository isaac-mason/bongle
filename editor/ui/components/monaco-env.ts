// editor/ui/components/monaco-env.ts — Monaco worker wiring for vite.
//
// Monaco's language services run in web workers. We BUNDLE each language worker
// through vite's `?worker` import rather than relying on Monaco's built-in
// `new URL(..., import.meta.url)` pattern (which breaks under COEP + Vite's
// dep pre-bundling). Import this once before creating any editor.

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

(self as unknown as { MonacoEnvironment: { getWorker(id: string, label: string): Worker } }).MonacoEnvironment = {
    getWorker(_id, label) {
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        if (label === 'json') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
        return new editorWorker();
    },
};
