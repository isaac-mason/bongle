// lib/cli/node-fs.ts — a node:fs adapter rooted at a project directory. Satisfies
// BOTH build's `BuildFs` (read/list/readDir — the mirror of the editor's OPFS fs
// the build core reads) AND the pipeline's fuller `Filesystem` (write/exists/
// remove/… — baked outputs land back on disk). One impl, so `bongle build` runs
// the exact same graph + bake the browser editor does.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildFs } from '../build';
import type { Filesystem, FilesystemSnapshot, FsStat } from '../src/asset-pipeline/filesystem';

export function openNodeFs(root: string): Filesystem & BuildFs {
    const abs = (p: string) => join(root, p);

    const readDirEntries = (d: string) => {
        try {
            return readdirSync(abs(d), { withFileTypes: true });
        } catch {
            return [];
        }
    };
    const listStats = (dir: string, recursive: boolean): FsStat[] => {
        const out: FsStat[] = [];
        const walk = (d: string) => {
            for (const e of readDirEntries(d)) {
                const rel = d ? `${d}/${e.name}` : e.name;
                let st: ReturnType<typeof statSync>;
                try {
                    // statSync follows symlinks so a workspace-linked package dir
                    // (node_modules/bongle → lib) is a 'dir', not lstat's 'file'.
                    st = statSync(abs(rel));
                } catch {
                    continue; // broken symlink / vanished entry
                }
                const kind = st.isDirectory() ? 'dir' : 'file';
                out.push({ path: rel, kind, size: st.size, mtime: st.mtimeMs });
                // recurse only into REAL dirs — never follow a symlink (a workspace
                // link can point back into a parent and cycle).
                if (kind === 'dir' && !e.isSymbolicLink() && recursive) walk(rel);
            }
        };
        walk(dir);
        return out;
    };

    // file:// URLs to builtin engine assets (e.g. the avatar glb) reach the bake
    // loader as stripped-absolute paths — they live OUTSIDE the project root (in
    // node_modules/bongle/…), so a project-relative read misses. Fall back to the
    // restored absolute path. Project files hit the fast path (no extra stat).
    const readAt = (p: string, enc?: 'utf8') => {
        try {
            return enc ? readFileSync(abs(p), enc) : readFileSync(abs(p));
        } catch (e) {
            const asAbsolute = `/${p}`;
            if (existsSync(asAbsolute)) return enc ? readFileSync(asAbsolute, enc) : readFileSync(asAbsolute);
            throw e;
        }
    };

    return {
        async read(p) {
            return readAt(p) as Uint8Array; // Buffer is a Uint8Array
        },
        async readText(p) {
            return readAt(p, 'utf8') as string;
        },
        async stat(p) {
            try {
                const st = statSync(abs(p));
                return { path: p, kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
            } catch {
                return null;
            }
        },
        async list(dir = '', opts) {
            return listStats(dir, !!opts?.recursive);
        },
        // resolve.ts probes directories constantly — a missing dir is a normal
        // "no such candidate", not an error (mirrors OPFS readDir).
        async readDir(dir) {
            const m = new Map<string, 'file' | 'dir'>();
            try {
                for (const e of readdirSync(abs(dir), { withFileTypes: true })) {
                    // follow symlinks so a workspace-linked package dir
                    // (node_modules/bongle → lib) reads as 'dir', not lstat's 'file'
                    // — otherwise the resolver never finds the package.
                    let kind: 'file' | 'dir' = e.isDirectory() ? 'dir' : 'file';
                    if (e.isSymbolicLink()) {
                        try {
                            kind = statSync(abs(dir ? `${dir}/${e.name}` : e.name)).isDirectory() ? 'dir' : 'file';
                        } catch {
                            kind = 'file';
                        }
                    }
                    m.set(e.name, kind);
                }
            } catch {}
            return m;
        },
        async exists(p) {
            return existsSync(abs(p));
        },
        async write(p, data) {
            const f = abs(p);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, data);
        },
        async writeIfChanged(p, data) {
            const f = abs(p);
            const next = Buffer.from(typeof data === 'string' ? Buffer.from(data) : data);
            try {
                if (readFileSync(f).equals(next)) return false;
            } catch {}
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, next);
            return true;
        },
        async remove(p, opts) {
            rmSync(abs(p), { recursive: !!opts?.recursive, force: true });
        },
        async move(from, to) {
            const t = abs(to);
            mkdirSync(dirname(t), { recursive: true });
            renameSync(abs(from), t);
        },
        // one-shot build: no file watching.
        watch() {
            return { close() {} };
        },
        async snapshot(dir = '') {
            const paths = listStats(dir, true)
                .filter((s) => s.kind === 'file')
                .map((s) => s.path)
                .sort();
            return {
                read: (p) => readFileSync(abs(p)),
                readText: (p) => readFileSync(abs(p), 'utf8'),
                exists: (p) => existsSync(abs(p)),
                list: () => paths,
            } satisfies FilesystemSnapshot;
        },
    };
}
