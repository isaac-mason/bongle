// editor/sync/disk-mirror.ts — a thin path-addressed wrapper over a picked
// on-disk folder (File System Access API `FileSystemDirectoryHandle`). Mirrors
// the slice of `Filesystem` the reconciler needs — list/read/write/remove/stat —
// walking recursively and skipping unmanaged paths (vendored / baked / generated,
// see policy.ts) so a real project's `node_modules` is never read or touched.
//
// Chromium-only: the handle comes from `showDirectoryPicker`, which Firefox and
// Safari don't implement. Callers feature-detect before constructing one.

import { syncManaged } from './policy';

export type DiskStat = { path: string; size: number; mtime: number };

export type DiskMirror = {
    /** every non-ignored file under the folder (recursive), with size + mtime. */
    list(): Promise<DiskStat[]>;
    read(path: string): Promise<Uint8Array>;
    /** write bytes, creating parent dirs. */
    write(path: string, data: Uint8Array): Promise<void>;
    /** delete a file. missing is fine. */
    remove(path: string): Promise<void>;
    stat(path: string): Promise<{ size: number; mtime: number } | null>;
};

type AnyDirHandle = FileSystemDirectoryHandle & {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
};

function split(path: string): { dirs: string[]; name: string } {
    const parts = path.split('/');
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1]! };
}

export function openDiskMirror(root: FileSystemDirectoryHandle): DiskMirror {
    const dirHandle = async (dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> => {
        let cur = root;
        for (const d of dirs) {
            try {
                cur = await cur.getDirectoryHandle(d, { create });
            } catch {
                return null;
            }
        }
        return cur;
    };

    return {
        async list() {
            const out: DiskStat[] = [];
            const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
                for await (const [name, h] of (dir as AnyDirHandle).entries()) {
                    const path = prefix ? `${prefix}/${name}` : name;
                    if (!syncManaged(path)) continue;
                    if (h.kind === 'directory') {
                        await walk(h as FileSystemDirectoryHandle, path);
                    } else {
                        const f = await (h as FileSystemFileHandle).getFile();
                        out.push({ path, size: f.size, mtime: f.lastModified });
                    }
                }
            };
            await walk(root, '');
            return out;
        },
        async read(path) {
            const { dirs, name } = split(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) throw new Error(`disk-mirror: no dir for ${path}`);
            const fh = await dir.getFileHandle(name);
            const f = await fh.getFile();
            return new Uint8Array(await f.arrayBuffer());
        },
        async write(path, data) {
            const { dirs, name } = split(path);
            const dir = await dirHandle(dirs, true);
            if (!dir) throw new Error(`disk-mirror: cannot create dir for ${path}`);
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            // cast: the DOM lib types a Uint8Array<ArrayBufferLike> as not-quite a
            // BufferSource, but the bytes write fine.
            await w.write(data as BufferSource);
            await w.close();
        },
        async remove(path) {
            const { dirs, name } = split(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) return;
            try {
                await dir.removeEntry(name);
            } catch {
                /* already gone */
            }
        },
        async stat(path) {
            const { dirs, name } = split(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) return null;
            try {
                const fh = await dir.getFileHandle(name);
                const f = await fh.getFile();
                return { size: f.size, mtime: f.lastModified };
            } catch {
                return null;
            }
        },
    };
}
