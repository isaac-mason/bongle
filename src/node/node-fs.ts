// bongle/engine-server-node's node filesystem: a `bongle/interface` Filesystem
// rooted at a directory, backed by node:fs. Node hosts (the deployed play-room, a
// node solo host) inject this so the neutral server bundle reads its package —
// scenes under content/scenes/, model bins under resources/server/ — without ever
// importing node itself. Paths are root-relative, '/'-separated, no leading slash.

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Filesystem, FsEntry } from '../../interface/index';

export function openNodeFs(root: string): Filesystem {
    const abs = (p: string) => join(root, p.replace(/^\/+/, ''));
    return {
        async read(p) {
            try {
                return readFileSync(abs(p));
            } catch (e) {
                // engine sample avatars live OUTSIDE the project root as absolute
                // paths; the engine's loader strips the leading slash before fs.read,
                // so restore it and try the absolute location before giving up.
                try {
                    return readFileSync(`/${p.replace(/^\/+/, '')}`);
                } catch {
                    throw e;
                }
            }
        },
        async write(p, bytes) {
            const f = abs(p);
            await mkdir(dirname(f), { recursive: true });
            await writeFile(f, bytes);
        },
        async list(dir, opts) {
            const out: FsEntry[] = [];
            const walk = (d: string) => {
                let entries: Dirent<string>[] = [];
                try {
                    entries = readdirSync(abs(d), { withFileTypes: true });
                } catch {
                    // missing dir → empty (mirrors a fresh project)
                }
                for (const e of entries) {
                    const rel = d ? `${d}/${e.name}` : e.name;
                    const kind = e.isDirectory() ? 'dir' : 'file';
                    out.push({ path: rel, kind });
                    if (kind === 'dir' && opts?.recursive) walk(rel);
                }
            };
            walk(dir);
            return out;
        },
        async remove(p) {
            await rm(abs(p), { force: true });
        },
    };
}
