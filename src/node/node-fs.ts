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
                // engine sample avatars live outside the project root as absolute paths; the
                // engine's loader strips the leading slash before fs.read, so restore it and
                // try the absolute location before giving up.
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
        async list(dir) {
            const out: FsEntry[] = [];
            const walk = (d: string) => {
                let entries: Dirent<string>[] = [];
                try {
                    entries = readdirSync(abs(d), { withFileTypes: true });
                } catch {
                    // missing dir yields empty (mirrors a fresh project)
                }
                for (const e of entries) {
                    const rel = d ? `${d}/${e.name}` : e.name;
                    const kind = e.isDirectory() ? 'dir' : 'file';
                    out.push({ path: rel, kind });
                    if (kind === 'dir') walk(rel);
                }
            };
            walk(dir);
            return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        },
        async remove(p) {
            await rm(abs(p), { force: true });
        },
    };
}
