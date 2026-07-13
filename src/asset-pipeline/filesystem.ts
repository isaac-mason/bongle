// src/asset-pipeline/filesystem.ts — the `Filesystem` contract the pipeline
// bakes against. Owned HERE (the versioned artifact side) rather than imported
// from the editor shell, so the pipeline has NO shell dependency — it's the
// harness↔artifact boot contract (the shell's fs impls, editor/fs.ts memory +
// fs-opfs.ts, structurally satisfy this). Keep it structurally stable.

export type FsPath = string;

export type FsStat = {
    path: FsPath;
    kind: 'file' | 'dir';
    size: number;
    /** ms epoch. change-detection quality, not ordering. */
    mtime: number;
};

export type FsChange = {
    type: 'created' | 'modified' | 'deleted' | 'moved';
    path: FsPath;
    /** present for 'moved'. */
    from?: FsPath;
};

export type FsWatchHandle = { close(): void };

/** Frozen, synchronously-readable view of a subtree — the bake reads against
 *  one of these to keep its sync-fs style without lying about OPFS latency. */
export type FilesystemSnapshot = {
    read(path: FsPath): Uint8Array;
    readText(path: FsPath): string;
    exists(path: FsPath): boolean;
    /** every file path in the snapshot (recursive, sorted). */
    list(): FsPath[];
};

export type Filesystem = {
    /** bytes of a file. throws if missing. */
    read(path: FsPath): Promise<Uint8Array>;
    /** utf-8 text of a file. throws if missing. */
    readText(path: FsPath): Promise<string>;
    stat(path: FsPath): Promise<FsStat | null>;
    /** entries under `dir` ('' = root). recursive lists the whole subtree. */
    list(dir?: FsPath, opts?: { recursive?: boolean }): Promise<FsStat[]>;
    exists(path: FsPath): Promise<boolean>;
    /** write, creating parent dirs. */
    write(path: FsPath, data: Uint8Array | string): Promise<void>;
    /** write only when content differs; returns true if a write happened. */
    writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean>;
    /** delete a file (or a dir with recursive). missing is fine. */
    remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void>;
    move(from: FsPath, to: FsPath): Promise<void>;
    /** change events, batched per flush. */
    watch(cb: (changes: FsChange[]) => void): FsWatchHandle;
    /** materialize a frozen sync-readable view of `dir` ('' = root). */
    snapshot(dir?: FsPath): Promise<FilesystemSnapshot>;
};
