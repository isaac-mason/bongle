// editor/ui/components/Monaco.tsx — a code editor instance, one per editor group.
// Every instance shares the module-level per-path model cache, so the same file
// open in two groups is the SAME buffer (edits + dirty mirror). Ctrl/Cmd+S writes
// to the project fs (→ bundler watcher → HMR re-bake); dirty state is published to
// the editor store (path-keyed) so tabs + the tree can show it VSCode-style.

import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef } from 'react';
import type { Filesystem } from '../../fs';
import { isIgnored } from '../../ignored';
import { useEditor } from '../../stores/editor';
import './monaco-env'; // side-effect: bundle + register the language workers.

// Bundler resolution (TS `ModuleResolutionKind.Bundler` = 100) so the TS worker
// reads package.json `exports` maps — bongle's types resolve through an `exports`
// `types` condition (./dist/types/…), which classic NodeJs resolution finds but
// refuses to use ("could not be resolved under your current moduleResolution").
// monaco's own enum only names Classic/NodeJs, but its bundled TS (5.x) supports
// Bundler; the option is a plain number, so we pass it directly.
const BUNDLER_MODULE_RESOLUTION = 100 as monaco.typescript.ModuleResolutionKind;

monaco.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: BUNDLER_MODULE_RESOLUTION,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    strict: true,
    allowNonTsExtensions: true,
});
// semantic checking stays OFF until the engine .d.ts are loaded (else every
// `import … from 'bongle'` is a red squiggle). loadEngineTypes flips it on.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
});

let engineTypesLoaded = false;

/** feed the seeded engine + first-party lib `.d.ts` (+ @webgpu/types ambient
 *  globals) into Monaco's TS worker so user code gets real `bongle` / `mathcat` /
 *  `gpucat` / GPU* types. Reads node_modules/**.d.ts + package.json from the
 *  project fs — call once, after seedEngineDist has populated it. */
export async function loadEngineTypes(fs: Filesystem): Promise<void> {
    if (engineTypesLoaded) return;
    engineTypesLoaded = true;
    try {
        // only the type-bearing files: the .d.ts trees + each package's package.json
        // (bundler resolution reads each package.json `exports` → the `types`
        // condition, then loads that .d.ts from the layout below).
        const files = (await fs.list('node_modules', { recursive: true })).filter(
            (e) => e.kind === 'file' && (e.path.endsWith('.d.ts') || e.path.endsWith('package.json')),
        );
        const libs = await Promise.all(
            files.map(async (e) => ({ content: await fs.readText(e.path), filePath: `file:///${e.path}` })),
        );
        monaco.typescript.typescriptDefaults.setExtraLibs(libs);
        // packages now resolve → turn semantic checking on.
        monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
    } catch (err) {
        console.warn('[monaco] failed to load engine types', err);
        engineTypesLoaded = false; // let a later call retry
    }
}

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

// the seeds (node_modules) + bake outputs (dist / resources) are generated, not
// the user's source — Monaco shows them read-only and refuses to save, matching
// the file tree's `isIgnored` read-only territory.
const isReadOnlyPath = isIgnored;

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

// the group whose editor most recently held focus — where go-to-definition opens
// the target (a Cmd/Ctrl+click always happens in a focused editor).
let activeGroupId: string | null = null;

const isSrc = (p: string) => /^src\/.+\.tsx?$/.test(p);

/** create Monaco models for EVERY src `.ts`/`.tsx` file (not just open tabs) so
 *  the TS worker sees the whole project — cross-file type resolution, go-to-
 *  definition, find-references. Keeps models in sync with the fs. Call once. */
export async function syncProjectModels(fs: Filesystem): Promise<void> {
    try {
        const files = await fs.list('src', { recursive: true });
        await Promise.all(files.filter((f) => f.kind === 'file' && isSrc(f.path)).map((f) => getOrCreateModel(fs, f.path)));
    } catch {
        /* no src yet */
    }
    fs.watch((changes) => {
        for (const c of changes) {
            if (!isSrc(c.path)) continue;
            if (c.type === 'deleted') {
                models.get(c.path)?.dispose();
                models.delete(c.path);
                savedText.delete(c.path);
            } else {
                void refreshModel(fs, c.path);
            }
        }
    });
}

/** create a newly-added src model, or refresh a CLEAN one whose disk copy drifted
 *  (e.g. folder sync) — never clobber an unsaved buffer. */
async function refreshModel(fs: Filesystem, path: string): Promise<void> {
    const existing = models.get(path);
    if (!existing) {
        await getOrCreateModel(fs, path);
        return;
    }
    if (existing.getValue() !== (savedText.get(path) ?? '')) return; // dirty — leave it
    const text = await fs.readText(path).catch(() => null);
    if (text != null && text !== existing.getValue()) {
        savedText.set(path, text);
        existing.setValue(text);
    }
}

// route "go to definition" (Cmd/Ctrl+click, F12) navigation into the tab system:
// open the target — a src file OR a seeded node_modules .d.ts — in the active
// group and jump to the line. The TS worker already resolved it against the
// models + extra libs; this just opens/reveals it.
monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
        const path = resource.path.replace(/^\/+/, '');
        const group = activeGroupId ? useEditor.getState().groups[activeGroupId] : undefined;
        if (!group) return false;
        const line = selectionOrPosition
            ? 'startLineNumber' in selectionOrPosition
                ? selectionOrPosition.startLineNumber
                : selectionOrPosition.lineNumber
            : 1;
        useEditor.getState().openAt(group.pane, path, line);
        return true;
    },
});

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
        // focusing this editor makes its group the pane's active target + the
        // destination for go-to-definition navigation.
        ed.onDidFocusEditorText(() => {
            activeGroupId = group;
            useEditor.getState().focusGroup(group);
        });
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const model = ed.getModel();
            if (!model) return;
            const path = model.uri.path.replace(/^\/+/, '');
            if (isReadOnlyPath(path)) return; // seeded/derived — not writable
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
            ed.updateOptions({ readOnly: isReadOnlyPath(active) });
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
