// lib/editor/fs.ts — the editor's project filesystem contract.
//
// `Filesystem` is the authoring-side substrate: the working copy the editor
// shell owns, the tree the asset pipeline bakes from and into, the store the
// module host reads sources from, and the thing a game save zips. Paths are
// POSIX-style, root-relative, no leading slash ('resources/client/atlas.png').
//
// Editor-resident by design: play-mode client and server never see this type.
// Where the server needs project-file access in the editor (scene IO), the
// editor implements the server's own narrow driver ON TOP of a Filesystem;
// the runtime contract stays Filesystem-agnostic.
//
// Impls: `createMemoryFilesystem` (below — tests, the pipeline proof harness,
// and frozen snapshots) and OPFS (the real one, ./fs-opfs.ts). There is no
// node impl: the authoring stack is browser-native. All I/O is async; per
// the vfs spike's measurements only an in-memory snapshot can offer sync
// reads, so sync access exists solely on `FilesystemSnapshot`.
//
// The pipeline artifact is version-pinned while the shell is latest-wins, so
// `Filesystem` is part of the harness↔artifact boot contract: keep it
// structurally stable.

export type FsPath = string;

export type FsStat = {
    path: FsPath;
    kind: 'file' | 'dir';
    size: number;
    /** ms epoch. change-detection quality, not ordering (OPFS mtimes are
     *  approximate). */
    mtime: number;
};

export type FsChange = {
    type: 'created' | 'modified' | 'deleted' | 'moved';
    path: FsPath;
    /** present for 'moved'. */
    from?: FsPath;
};

export type FsWatchHandle = { close(): void };

/** Frozen, synchronously-readable view of a subtree. The pipeline worker
 *  bakes against one of these; sync reads keep the bake code's sync style
 *  without lying about OPFS latency. */
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
    /** entries under `dir` ('' = root). recursive lists the whole subtree.
     *  [] when the dir is missing — absent output dirs read as empty. */
    list(dir?: FsPath, opts?: { recursive?: boolean }): Promise<FsStat[]>;
    exists(path: FsPath): Promise<boolean>;
    /** write, creating parent dirs. */
    write(path: FsPath, data: Uint8Array | string): Promise<void>;
    /** write only when content differs (byte compare); returns true if a
     *  write happened. Emitters rely on this to avoid pointless HMR
     *  cascades, so it's part of the contract, not a helper. */
    writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean>;
    /** delete a file (or a dir with recursive). missing is fine. */
    remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void>;
    move(from: FsPath, to: FsPath): Promise<void>;
    /** change events, batched per flush. */
    watch(cb: (changes: FsChange[]) => void): FsWatchHandle;
    /** materialize a frozen sync-readable view of `dir` ('' = root). */
    snapshot(dir?: FsPath): Promise<FilesystemSnapshot>;
};

// ── memory impl ─────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBytes(data: Uint8Array | string): Uint8Array {
    return typeof data === 'string' ? enc.encode(data) : data;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function normalize(path: FsPath): FsPath {
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function inDir(path: FsPath, dir: FsPath): boolean {
    return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/** In-memory Filesystem: tests, the pipeline proof harness, scratch trees.
 *  Dirs are implicit (derived from file paths). */
export function createMemoryFilesystem(initial?: Record<FsPath, Uint8Array | string>): Filesystem {
    const files = new Map<FsPath, { bytes: Uint8Array; mtime: number }>();
    const watchers = new Set<(changes: FsChange[]) => void>();
    let now = 1;

    if (initial) {
        for (const [p, data] of Object.entries(initial)) {
            files.set(normalize(p), { bytes: toBytes(data), mtime: now });
        }
    }

    const emit = (changes: FsChange[]) => {
        if (changes.length === 0) return;
        for (const cb of watchers) cb(changes);
    };

    const statOf = (path: FsPath): FsStat | null => {
        const f = files.get(path);
        if (f) return { path, kind: 'file', size: f.bytes.length, mtime: f.mtime };
        for (const p of files.keys()) {
            if (p.startsWith(`${path}/`)) return { path, kind: 'dir', size: 0, mtime: 0 };
        }
        return null;
    };

    return {
        async read(path) {
            const f = files.get(normalize(path));
            if (!f) throw new Error(`[fs] missing: ${path}`);
            return f.bytes;
        },
        async readText(path) {
            const f = files.get(normalize(path));
            if (!f) throw new Error(`[fs] missing: ${path}`);
            return dec.decode(f.bytes);
        },
        async stat(path) {
            return statOf(normalize(path));
        },
        async list(dir = '', opts) {
            const d = normalize(dir);
            const out: FsStat[] = [];
            const seenDirs = new Set<FsPath>();
            for (const [p, f] of files) {
                if (!inDir(p, d) || p === d) continue;
                const rest = d === '' ? p : p.slice(d.length + 1);
                const slash = rest.indexOf('/');
                if (opts?.recursive || slash === -1) {
                    out.push({ path: p, kind: 'file', size: f.bytes.length, mtime: f.mtime });
                }
                if (slash !== -1) {
                    const child = d === '' ? rest.slice(0, slash) : `${d}/${rest.slice(0, slash)}`;
                    if (!seenDirs.has(child)) {
                        seenDirs.add(child);
                        out.push({ path: child, kind: 'dir', size: 0, mtime: 0 });
                    }
                }
            }
            out.sort((a, b) => a.path.localeCompare(b.path));
            return out;
        },
        async exists(path) {
            return statOf(normalize(path)) !== null;
        },
        async write(path, data) {
            const p = normalize(path);
            const existed = files.has(p);
            files.set(p, { bytes: toBytes(data), mtime: ++now });
            emit([{ type: existed ? 'modified' : 'created', path: p }]);
        },
        async writeIfChanged(path, data) {
            const p = normalize(path);
            const next = toBytes(data);
            const existing = files.get(p);
            if (existing && sameBytes(existing.bytes, next)) return false;
            files.set(p, { bytes: next, mtime: ++now });
            emit([{ type: existing ? 'modified' : 'created', path: p }]);
            return true;
        },
        async remove(path, opts) {
            const p = normalize(path);
            const changes: FsChange[] = [];
            if (files.delete(p)) changes.push({ type: 'deleted', path: p });
            if (opts?.recursive) {
                for (const key of Array.from(files.keys())) {
                    if (key.startsWith(`${p}/`)) {
                        files.delete(key);
                        changes.push({ type: 'deleted', path: key });
                    }
                }
            }
            emit(changes);
        },
        async move(from, to) {
            const f = normalize(from);
            const t = normalize(to);
            const changes: FsChange[] = [];
            const direct = files.get(f);
            if (direct) {
                files.delete(f);
                files.set(t, direct);
                changes.push({ type: 'moved', path: t, from: f });
            } else {
                for (const key of Array.from(files.keys())) {
                    if (!key.startsWith(`${f}/`)) continue;
                    const dest = `${t}/${key.slice(f.length + 1)}`;
                    files.set(dest, files.get(key)!);
                    files.delete(key);
                    changes.push({ type: 'moved', path: dest, from: key });
                }
            }
            emit(changes);
        },
        watch(cb) {
            watchers.add(cb);
            return { close: () => watchers.delete(cb) };
        },
        async snapshot(dir = '') {
            const d = normalize(dir);
            const frozen = new Map<FsPath, Uint8Array>();
            for (const [p, f] of files) {
                if (!inDir(p, d)) continue;
                const rel = d === '' ? p : p.slice(d.length + 1);
                frozen.set(rel, f.bytes.slice());
            }
            return {
                read(path) {
                    const bytes = frozen.get(normalize(path));
                    if (!bytes) throw new Error(`[fs snapshot] missing: ${path}`);
                    return bytes;
                },
                readText(path) {
                    const bytes = frozen.get(normalize(path));
                    if (!bytes) throw new Error(`[fs snapshot] missing: ${path}`);
                    return dec.decode(bytes);
                },
                exists(path) {
                    return frozen.has(normalize(path));
                },
                list() {
                    return Array.from(frozen.keys()).sort();
                },
            };
        },
    };
}
