// lib/cli/node-fs.ts — a node:fs adapter rooted at a project directory. Satisfies
// BOTH build's `BuildFs` (read/list/readDir — the mirror of the editor's OPFS fs
// the build core reads) AND the pipeline's fuller `Filesystem` (write/exists/
// remove/… — baked outputs land back on disk). One impl, so `bongle build` runs
// the exact same graph + bake the browser editor does.

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildFs } from '../build';
import type { Filesystem, FsEntry, FsKind } from '../os/interface';

export function openNodeFs(root: string): Filesystem & BuildFs {
    // Ids are project-relative, EXCEPT the ones `realpath` hands back: a pnpm package's
    // real home is outside the project root, so it can only be named absolutely. Both
    // live in the same id space, distinguished by the leading slash.
    const abs = (p: string) => (p.startsWith('/') ? p : join(root, p));

    const readDirEntries = (d: string) => {
        try {
            return readdirSync(abs(d), { withFileTypes: true });
        } catch {
            return [];
        }
    };
    // kind of a dirent, following symlinks so a workspace-linked package dir
    // (node_modules/bongle → lib) is a 'dir', not lstat's 'file'. null when the
    // link is broken or the entry vanished.
    const kindOf = (rel: string, e: { isDirectory(): boolean; isSymbolicLink(): boolean }): FsKind | null => {
        if (!e.isSymbolicLink()) return e.isDirectory() ? 'dir' : 'file';
        try {
            return statSync(abs(rel)).isDirectory() ? 'dir' : 'file';
        } catch {
            return null;
        }
    };
    const listTree = (dir: string): FsEntry[] => {
        const out: FsEntry[] = [];
        const walk = (d: string) => {
            for (const e of readDirEntries(d)) {
                const rel = d ? `${d}/${e.name}` : e.name;
                const kind = kindOf(rel, e);
                if (kind === null) continue;
                out.push({ path: rel, kind });
                // recurse only into REAL dirs — never follow a symlink (a workspace
                // link can point back into a parent and cycle).
                if (kind === 'dir' && !e.isSymbolicLink()) walk(rel);
            }
        };
        walk(dir);
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
        async list(dir = '') {
            return listTree(dir);
        },
        // resolve.ts probes directories constantly — a missing dir is a normal
        // "no such candidate", not an error (mirrors OPFS readDir).
        async readDir(dir = '') {
            const m = new Map<string, FsKind>();
            for (const e of readDirEntries(dir)) {
                const kind = kindOf(dir ? `${dir}/${e.name}` : e.name, e);
                // a broken link is still a name the resolver must not treat as a dir.
                m.set(e.name, kind ?? 'file');
            }
            return m;
        },
        async exists(p) {
            return existsSync(abs(p));
        },
        // pnpm puts only DIRECT deps in a package's node_modules, each a symlink into
        // the store; a transitive dep sits beside its dependent inside that store. So a
        // dep is only reachable from its dependent's REAL path, which is what shakeup
        // derefs every resolved id to (scan.ts, `resolve.symlinks`, on by default).
        // Without this the deref is a no-op and transitive deps silently externalize.
        async realpath(p) {
            try {
                return realpathSync(abs(p));
            } catch {
                return p;
            }
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
    };
}
