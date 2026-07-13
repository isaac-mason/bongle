// editor/session-files.ts — snapshot the project fs into a plain
// Record<path, bytes> for shipping to another realm (the server worker at init,
// a client iframe at init). Both realms rebuild a memory fs from it and then
// receive incremental `fs-change` updates.

import type { Filesystem } from './fs';

export type SessionFiles = Record<string, Uint8Array>;

export async function snapshotFiles(fs: Filesystem): Promise<SessionFiles> {
    const snap = await fs.snapshot();
    const files: SessionFiles = {};
    for (const path of snap.list()) {
        // node_modules (the seeded engine dist) stays host-side — realms get
        // transformed modules from the host bundler, not the lib source.
        if (path.startsWith('node_modules/')) continue;
        files[path] = snap.read(path);
    }
    return files;
}
