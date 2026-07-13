// lib/editor/entry.ts — the editor core, engine-client-shaped.
//
// `initEditor(opts) -> EditorState`, then standalone functions that take the
// state and act on it (loadProjectZip, listFiles, …). Functional TS, matching
// the engine's init()+State+free-fns convention — no closures-over-methods.
//
// The editor owns the project working copy (a `Filesystem`). The bundler and
// pipeline hook in as later slices; for now this is the fs-owning spine the
// shell UI renders over. Browser-native: the memory Filesystem for the eval
// (OPFS parked). A project is files under the fs root: src/, assets/,
// content/, manifest.json.

import { unzipSync } from 'fflate';
import { AssetPipeline } from './asset-pipeline';
import { createBrowserDecodeAudio } from './asset-pipeline/decode-audio-browser';
import { createBakeLoader } from './asset-pipeline/loader';
import { createMemoryFilesystem, type Filesystem, type FsChange, type FsStat } from './fs';

export type InitEditorOptions = {
    /** the project working copy. Defaults to a fresh in-memory Filesystem. */
    fs?: Filesystem;
};

export function initEditor(opts: InitEditorOptions = {}) {
    const fs = opts.fs ?? createMemoryFilesystem();

    // the bake pipeline reads project files through this loader (project-
    // relative paths → fs; absolute URLs → fetch) and decodes audio through
    // the browser's OfflineAudioContext.
    const loader = createBakeLoader(fs);
    const decodeAudio = createBrowserDecodeAudio();

    // the bake pipeline is a plain in-graph object (no GPU / worker / handles),
    // so it's cheap to init eagerly and hold on the state.
    const pipeline = AssetPipeline.init({ mode: 'edit', cache: true, fs, loader, decodeAudio });

    return { fs, pipeline };
}

export type EditorState = ReturnType<typeof initEditor>;

/** Replace the working copy with a project .zip (STORE or deflate). Returns the
 *  file paths written. Start from a fresh state for a clean load. */
export async function loadProjectZip(state: EditorState, zip: Uint8Array): Promise<string[]> {
    const entries = unzipSync(zip);
    const written: string[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
        // zip dir entries end in '/' with empty bytes — skip, the fs derives
        // dirs from file paths.
        if (path.endsWith('/')) continue;
        await state.fs.write(path, bytes);
        written.push(path);
    }
    written.sort();
    return written;
}

/** List every file in the working copy (recursive, sorted). */
export function listFiles(state: EditorState): Promise<FsStat[]> {
    return state.fs.list('', { recursive: true });
}

/** Subscribe to working-copy changes (file-tree refresh; later: bundler + bake
 *  triggers). */
export function onFsChange(state: EditorState, cb: (changes: FsChange[]) => void): { close(): void } {
    return state.fs.watch(cb);
}

/** Run one asset-pipeline bake pass against the working copy. Requires the
 *  registries to be populated (the bundler slice evaluates the user module);
 *  returns the pass result. */
export function runPipeline(state: EditorState, opts: { forceAll?: boolean } = {}) {
    return AssetPipeline.run(state.pipeline, { forceAll: opts.forceAll });
}

/** Tear down. Idempotent. */
export function disposeEditor(state: EditorState): void {
    AssetPipeline.dispose(state.pipeline);
}
