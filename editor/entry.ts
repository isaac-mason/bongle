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
import { createBrowserDecodeAudio } from '../src/asset-pipeline/decode-audio-browser';
import { createBakeLoader } from '../src/asset-pipeline/loader';
import { createMemoryFilesystem, type Filesystem, type FsChange, type FsStat } from './fs';

// type-only: the RUNTIME AssetPipeline comes from the pipeline realm's
// ModuleRunner (initPipeline), so it reads the SAME engine registry the user
// declarations registered into — a native import would read a different one.
type AssetPipelineApi = typeof import('../src/asset-pipeline').AssetPipeline;
type PipelineState = ReturnType<AssetPipelineApi['init']>;

export type InitEditorOptions = {
    /** the project working copy. Defaults to a fresh in-memory Filesystem. */
    fs?: Filesystem;
};

export type EditorState = {
    fs: Filesystem;
    loader: ReturnType<typeof createBakeLoader>;
    decodeAudio: ReturnType<typeof createBrowserDecodeAudio>;
    /** set by initPipeline() once the pipeline realm's AssetPipeline is loaded. */
    AssetPipeline: AssetPipelineApi | null;
    pipeline: PipelineState | null;
};

export function initEditor(opts: InitEditorOptions = {}): EditorState {
    const fs = opts.fs ?? createMemoryFilesystem();
    // the bake reads project files through this loader (project-relative → fs;
    // absolute URLs → fetch) and decodes audio via OfflineAudioContext.
    const loader = createBakeLoader(fs);
    const decodeAudio = createBrowserDecodeAudio();
    // pipeline is deferred to initPipeline — it must run the runner's
    // AssetPipeline instance to see the populated registry.
    return { fs, loader, decodeAudio, AssetPipeline: null, pipeline: null };
}

/** Attach the pipeline realm's AssetPipeline (from `runner.import`) + init it,
 *  so bakes read the registry the user declarations registered into. */
export function initPipeline(state: EditorState, AssetPipeline: AssetPipelineApi): void {
    state.AssetPipeline = AssetPipeline;
    state.pipeline = AssetPipeline.init({ mode: 'edit', cache: true, fs: state.fs, loader: state.loader, decodeAudio: state.decodeAudio });
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

/** Subscribe to working-copy changes (file-tree refresh; later: bundler + bake
 *  triggers). */
export function onFsChange(state: EditorState, cb: (changes: FsChange[]) => void): { close(): void } {
    return state.fs.watch(cb);
}

/** Run one asset-pipeline bake pass against the working copy. Requires the
 *  registries to be populated (the bundler slice evaluates the user module);
 *  returns the pass result. */
export function runPipeline(state: EditorState, opts: { forceAll?: boolean } = {}) {
    if (!state.AssetPipeline || !state.pipeline) throw new Error('[editor] pipeline not initialized — call initPipeline first');
    return state.AssetPipeline.run(state.pipeline, { forceAll: opts.forceAll });
}

/** Tear down. Idempotent. */
export function disposeEditor(state: EditorState): void {
    if (state.AssetPipeline && state.pipeline) state.AssetPipeline.dispose(state.pipeline);
}
