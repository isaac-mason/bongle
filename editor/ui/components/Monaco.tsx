// editor/ui/components/Monaco.tsx — the code editor (Monaco), one editor
// instance sharing a per-path model cache with the file tree. Ctrl/Cmd+S writes
// to the project fs (→ bundler watcher → HMR re-bake); dirty state is published
// to the shared open-file store so the tree can show it VSCode-style.

import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import type { Filesystem } from '../../fs';
import { useOpenFile } from '../../stores/open-file';
import './monaco-env'; // side-effect: bundle + register the language workers.

monaco.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    strict: true,
    allowNonTsExtensions: true,
});
// no "cannot find module 'bongle'" squiggles until we feed the engine .d.ts
// (the tsgo per-file emit artifact) — that's the next Monaco upgrade.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
});

// models + last-saved text persist across file switches (buffers survive).
const models = new Map<string, monaco.editor.ITextModel>();
const savedText = new Map<string, string>();

function langOf(path: string): string {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.json')) return 'json';
    return 'plaintext';
}

export function Monaco({ fs }: { fs: Filesystem }) {
    const active = useOpenFile((s) => s.active);
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    // create the editor once.
    useEffect(() => {
        if (!containerRef.current) return;
        const ed = monaco.editor.create(containerRef.current, {
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            scrollBeyondLastLine: false,
            tabSize: 4,
        });
        editorRef.current = ed;
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const model = ed.getModel();
            if (!model) return;
            const path = model.uri.path.replace(/^\/+/, '');
            const value = model.getValue();
            void fs.write(path, value);
            savedText.set(path, value);
            useOpenFile.getState().setDirty(path, false);
        });
        return () => ed.dispose();
    }, [fs]);

    // swap the model when the active file changes (load lazily, cache).
    useEffect(() => {
        const ed = editorRef.current;
        if (!ed || !active) return;
        let cancelled = false;
        void (async () => {
            let model = models.get(active);
            if (!model) {
                let text = '';
                try {
                    text = await fs.readText(active);
                } catch {
                    /* new/empty file */
                }
                if (cancelled) return;
                const uri = monaco.Uri.parse(`file:///${active}`);
                model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, langOf(active), uri);
                models.set(active, model);
                savedText.set(active, text);
                model.onDidChangeContent(() => {
                    useOpenFile.getState().setDirty(active, model!.getValue() !== (savedText.get(active) ?? ''));
                });
            }
            if (!cancelled) ed.setModel(model);
        })();
        return () => {
            cancelled = true;
        };
    }, [active, fs]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
