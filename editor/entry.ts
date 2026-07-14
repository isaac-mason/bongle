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
import { createMemoryFilesystem, type Filesystem, type FsChange, type FsStat } from './fs';

// The pipeline (bake) + engine realms run OFF the main thread now — see
// pipeline-worker.ts / server-worker.ts. This main-doc state is just the
// fs-owning spine the shell UI renders over.

export type InitEditorOptions = {
    /** the project working copy. Defaults to a fresh in-memory Filesystem. */
    fs?: Filesystem;
};

export type EditorState = {
    fs: Filesystem;
};

export function initEditor(opts: InitEditorOptions = {}): EditorState {
    return { fs: opts.fs ?? createMemoryFilesystem() };
}

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

/** Subscribe to working-copy changes (file-tree refresh; bundler + bake triggers
 *  fan out from main.tsx's watch). */
export function onFsChange(state: EditorState, cb: (changes: FsChange[]) => void): { close(): void } {
    return state.fs.watch(cb);
}
