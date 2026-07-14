// editor/engine-dist.ts — seed the engine + first-party libs into the vfs at
// node_modules/, so the in-browser bundler resolves `bongle` / `mathcat` / … like
// any project module (one vfs-driven resolver; realms read assets from the same
// fs).
//
// The payload is ONE zip (scripts/pack-vfs.mjs) fetched + unpacked into OPFS
// once, rather than inlining every file into the editor bundle (bundle bloat) +
// fetching each asset separately. A version marker (the fingerprinted zip url)
// makes reboots skip the fetch — the vfs already holds it.
//
// env is left as a real property read in the bongle chunks (behind the
// `bongle/env` seam) — the dev-server's per-env transform does the replacement.

import { unzipSync } from 'fflate';
import type { Filesystem } from './fs';

// glob (not a bare `import ?url`) so a missing zip is an empty map + clear warn,
// not a build error. vite fingerprints the url → the marker cache-busts on
// rebuild. Built by `pnpm run build` (pack-vfs).
const ZIP = import.meta.glob('./editor-node-modules.zip', { query: '?url', eager: true, import: 'default' }) as Record<
    string,
    string
>;
const ZIP_URL: string | undefined = Object.values(ZIP)[0];

const SEED_MARKER = 'node_modules/.bongle-seed';

export async function seedEngineDist(fs: Filesystem): Promise<void> {
    if (!ZIP_URL) {
        console.warn('[engine-dist] editor-node-modules.zip not found — run `pnpm run build` in lib/ first');
        return;
    }
    // already unpacked this exact build? the vfs persists across reboots.
    try {
        if ((await fs.readText(SEED_MARKER)) === ZIP_URL) return;
    } catch {}

    const buf = new Uint8Array(await (await fetch(ZIP_URL)).arrayBuffer());
    const entries = unzipSync(buf);
    let count = 0;
    for (const [path, bytes] of Object.entries(entries)) {
        if (path.endsWith('/')) continue; // directory entry
        await fs.write(`node_modules/${path}`, bytes);
        count++;
    }
    await fs.write(SEED_MARKER, ZIP_URL);
    if (count === 0) console.warn('[engine-dist] seed zip was empty');
}
