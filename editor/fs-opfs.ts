// lib/editor/fs-opfs.ts — OPFS-backed `Filesystem`, the editor's real working
// copy. Origin Private File System (navigator.storage.getDirectory) rooted at
// a named project subdir.
//
// All I/O is async (the vfs spike measured OPFS reads at ~0.5-2ms/file, and
// sync access handles take an exclusive lock, so the public API stays async
// and single-writer). `snapshot()` materializes a subtree into memory for the
// pipeline worker's sync reads.
//
// Change events: OPFS has no native watcher, so writes THROUGH this instance
// emit synthetically. Cross-context change propagation (host → guest, or a
// linked-folder mirror) is the caller's concern (BroadcastChannel), not this
// leaf driver's.

import { createMemoryFilesystem, type Filesystem, type FilesystemSnapshot, type FsChange, type FsPath, type FsStat } from './fs';

function normalize(path: FsPath): FsPath {
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function split(path: FsPath): { dirs: string[]; name: string } {
    const parts = normalize(path).split('/').filter(Boolean);
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] ?? '' };
}

/** Open an OPFS `Filesystem` rooted at `projectName` under the OPFS root. */
export async function openOpfsFilesystem(projectName: string): Promise<Filesystem> {
    const opfsRoot = await navigator.storage.getDirectory();
    const root = await opfsRoot.getDirectoryHandle(projectName, { create: true });
    return new OpfsFilesystem(root);
}

class OpfsFilesystem implements Filesystem {
    private watchers = new Set<(changes: FsChange[]) => void>();

    constructor(private root: FileSystemDirectoryHandle) {}

    private async dirHandle(dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
        let cur = this.root;
        for (const d of dirs) {
            try {
                cur = await cur.getDirectoryHandle(d, { create });
            } catch {
                return null;
            }
        }
        return cur;
    }

    private async fileHandle(path: FsPath, create: boolean): Promise<FileSystemFileHandle | null> {
        const { dirs, name } = split(path);
        const dir = await this.dirHandle(dirs, create);
        if (!dir) return null;
        try {
            return await dir.getFileHandle(name, { create });
        } catch {
            return null;
        }
    }

    private emit(changes: FsChange[]): void {
        if (changes.length === 0) return;
        for (const cb of this.watchers) cb(changes);
    }

    async read(path: FsPath): Promise<Uint8Array> {
        const handle = await this.fileHandle(path, false);
        if (!handle) throw new Error(`[fs] missing: ${path}`);
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
    }

    async readText(path: FsPath): Promise<string> {
        const handle = await this.fileHandle(path, false);
        if (!handle) throw new Error(`[fs] missing: ${path}`);
        return (await handle.getFile()).text();
    }

    async stat(path: FsPath): Promise<FsStat | null> {
        const p = normalize(path);
        const handle = await this.fileHandle(p, false);
        if (handle) {
            const file = await handle.getFile();
            return { path: p, kind: 'file', size: file.size, mtime: file.lastModified };
        }
        // directory?
        const { dirs, name } = split(p);
        const parent = await this.dirHandle(dirs, false);
        if (parent) {
            try {
                await parent.getDirectoryHandle(name, { create: false });
                return { path: p, kind: 'dir', size: 0, mtime: 0 };
            } catch {
                /* not a dir */
            }
        }
        return null;
    }

    async list(dir: FsPath = '', opts?: { recursive?: boolean }): Promise<FsStat[]> {
        const base = normalize(dir);
        const dirHandle = await this.dirHandle(base ? base.split('/') : [], false);
        if (!dirHandle) return [];
        const out: FsStat[] = [];
        const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
            for await (const [name, child] of handle.entries() as AsyncIterable<[string, FileSystemHandle]>) {
                const path = prefix ? `${prefix}/${name}` : name;
                try {
                    if (child.kind === 'directory') {
                        out.push({ path, kind: 'dir', size: 0, mtime: 0 });
                        if (opts?.recursive) await walk(child as FileSystemDirectoryHandle, path);
                    } else {
                        const file = await (child as FileSystemFileHandle).getFile();
                        out.push({ path, kind: 'file', size: file.size, mtime: file.lastModified });
                    }
                } catch {
                    // entry vanished mid-walk (a concurrent write/remove/move) — skip
                    // it; the caller re-lists on the next change. Listing must never
                    // hard-fail because the tree moved under it.
                }
            }
        };
        // the iterator itself can throw if `dirHandle` is removed mid-walk; return
        // whatever was gathered rather than rejecting.
        try {
            await walk(dirHandle, base);
        } catch {
            /* dir removed mid-walk — return the partial list */
        }
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    async exists(path: FsPath): Promise<boolean> {
        return (await this.stat(path)) !== null;
    }

    async write(path: FsPath, data: Uint8Array | string): Promise<void> {
        await this.writeRaw(path, data, true);
    }

    async writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean> {
        const next = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const existing = await this.fileHandle(path, false);
        if (existing) {
            const cur = new Uint8Array(await (await existing.getFile()).arrayBuffer());
            if (cur.length === next.length && cur.every((b, i) => b === next[i])) return false;
        }
        await this.writeRaw(path, next, !!existing);
        return true;
    }

    private async writeRaw(path: FsPath, data: Uint8Array | string, existed: boolean): Promise<void> {
        const handle = await this.fileHandle(path, true);
        if (!handle) throw new Error(`[fs] cannot create: ${path}`);
        const writable = await handle.createWritable();
        await writable.write(typeof data === 'string' ? data : (data as unknown as BufferSource));
        await writable.close();
        this.emit([{ type: existed ? 'modified' : 'created', path: normalize(path) }]);
    }

    async remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void> {
        const { dirs, name } = split(path);
        const parent = await this.dirHandle(dirs, false);
        if (!parent) return;
        try {
            await parent.removeEntry(name, { recursive: opts?.recursive ?? false });
            this.emit([{ type: 'deleted', path: normalize(path) }]);
        } catch {
            // missing is fine.
        }
    }

    async move(from: FsPath, to: FsPath): Promise<void> {
        // OPFS has no atomic rename across dirs; copy + delete. Files only
        // (the pipeline never moves dirs).
        const bytes = await this.read(from);
        await this.write(to, bytes);
        await this.remove(from);
        this.emit([{ type: 'moved', path: normalize(to), from: normalize(from) }]);
    }

    watch(cb: (changes: FsChange[]) => void): { close(): void } {
        this.watchers.add(cb);
        return { close: () => this.watchers.delete(cb) };
    }

    async snapshot(dir: FsPath = ''): Promise<FilesystemSnapshot> {
        // Materialize the subtree into an in-memory Filesystem, then borrow its
        // (already sync-readable) snapshot. Cheap relative to the OPFS reads.
        const base = normalize(dir);
        const files = await this.list(base, { recursive: true });
        const seed: Record<FsPath, Uint8Array> = {};
        await Promise.all(
            files
                .filter((f) => f.kind === 'file')
                .map(async (f) => {
                    const rel = base ? f.path.slice(base.length + 1) : f.path;
                    seed[rel] = await this.read(f.path);
                }),
        );
        return createMemoryFilesystem(seed).snapshot();
    }
}
