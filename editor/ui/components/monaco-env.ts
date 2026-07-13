// editor/ui/components/monaco-env.ts — Monaco worker wiring for vite.
//
// Monaco's language services run in web workers. We BUNDLE them (vite `?worker`)
// rather than CDN-load, because the editor origin is cross-origin isolated
// (COEP require-corp) and a CDN worker would be blocked. Import this once
// before creating any editor.

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: { getWorker(id: string, label: string): Worker } }).MonacoEnvironment = {
    getWorker(_id, label) {
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
    },
};
