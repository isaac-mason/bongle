// editor/ui/components/Monaco.tsx — a code editor instance, one per editor group.
// Every instance shares the module-level per-path model cache, so the same file
// open in two groups is the SAME buffer (edits + dirty mirror). Ctrl/Cmd+S writes
// to the project fs (→ bundler watcher → HMR re-bake); dirty state is published to
// the editor store (path-keyed) so tabs + the tree can show it VSCode-style.

import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef } from 'react';
import type { Filesystem } from '../../fs';
import { useEditor } from '../../stores/editor';
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

// models + last-saved text persist across file switches + groups (shared buffers).
const models = new Map<string, monaco.editor.ITextModel>();
const savedText = new Map<string, string>();

/** the live editor buffer for a path (incl. unsaved edits), or null if not open.
 *  Lets the .md preview reflect what's currently in the editor. */
export function getBufferText(path: string): string | null {
    return models.get(path)?.getValue() ?? null;
}

function langOf(path: string): string {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.json')) return 'json';
    return 'plaintext';
}

/** get (or lazily create) the shared model for a path. The dirty listener is
 *  attached once, here, so N group editors showing the file don't double-count. */
async function getOrCreateModel(fs: Filesystem, path: string): Promise<monaco.editor.ITextModel> {
    const cached = models.get(path);
    if (cached) return cached;
    let text = '';
    try {
        text = await fs.readText(path);
    } catch {
        /* new/empty file */
    }
    const raced = models.get(path); // another instance may have created it during the await
    if (raced) return raced;
    const uri = monaco.Uri.parse(`file:///${path}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, langOf(path), uri);
    models.set(path, model);
    savedText.set(path, text);
    model.onDidChangeContent(() => {
        useEditor.getState().setDirty(path, model.getValue() !== (savedText.get(path) ?? ''));
    });
    return model;
}

export function Monaco({ fs, group }: { fs: Filesystem; group: string }) {
    const active = useEditor((s) => s.groups[group]?.active ?? null);
    const reveal = useEditor((s) => s.reveal);
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    const revealLine = useCallback((line: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
    }, []);

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
            theme: 'vs-dark', // match the dark editor chrome
        });
        editorRef.current = ed;
        // focusing this editor makes its group the pane's active target.
        ed.onDidFocusEditorText(() => useEditor.getState().focusGroup(group));
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const model = ed.getModel();
            if (!model) return;
            const path = model.uri.path.replace(/^\/+/, '');
            const value = model.getValue();
            void fs.write(path, value);
            savedText.set(path, value);
            useEditor.getState().setDirty(path, false);
        });
        return () => ed.dispose();
    }, [fs, group]);

    // swap the model when this group's active file changes (load lazily, cache).
    useEffect(() => {
        const ed = editorRef.current;
        if (!ed) return;
        // no active tab (e.g. "close all") → detach the model so the editor clears.
        if (!active) {
            ed.setModel(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            const model = await getOrCreateModel(fs, active);
            if (cancelled) return;
            ed.setModel(model);
            // if a search hit asked to jump here, do it now the model is loaded.
            const r = useEditor.getState().reveal;
            if (r && r.group === group && r.path === active) revealLine(r.line);
        })();
        return () => {
            cancelled = true;
        };
    }, [active, fs, group, revealLine]);

    // reveal a line when the request changes and the model is already loaded
    // (jumping to another hit in the file that's already open in this group).
    useEffect(() => {
        if (!reveal || reveal.group !== group) return;
        const model = editorRef.current?.getModel();
        if (model && model.uri.path.replace(/^\/+/, '') === reveal.path) revealLine(reveal.line);
    }, [reveal, group, revealLine]);

    return <div ref={containerRef} className="h-full w-full" />;
}
