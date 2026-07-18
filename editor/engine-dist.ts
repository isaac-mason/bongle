// editor/engine-dist.ts — seed the engine + first-party libs into the vfs at
// node_modules/, so the in-browser bundler resolves `bongle` / `mathcat` / … like
// any project module (one vfs-driven resolver; realms read assets from the same
// fs).
//
// The payload is ONE zip (scripts/pack-vfs.mjs) fetched + unpacked into OPFS on
// every boot, rather than inlining every file into the editor bundle (bundle
// bloat) + fetching each asset separately. node_modules is wiped-and-replaced
// each time (a seed-managed tree — no merge, no cache); see seedEngineDist.
//
// env is left as a real property read in the bongle chunks (behind the
// `bongle/env` seam) — the dev-server's per-env transform does the replacement.

import { unzipSync } from 'fflate';
import type { Filesystem } from './fs';

// glob (not a bare `import ?url`) so a missing zip is an empty map + clear warn,
// not a build error. Built by `pnpm run build` (pack-vfs).
const ZIP = import.meta.glob('./editor-node-modules.zip', { query: '?url', eager: true, import: 'default' }) as Record<
    string,
    string
>;
const ZIP_URL: string | undefined = Object.values(ZIP)[0];

export async function seedEngineDist(fs: Filesystem): Promise<void> {
    if (!ZIP_URL) {
        console.warn('[engine-dist] editor-node-modules.zip not found — run `pnpm run build` in lib/ first');
        return;
    }
    // REPLACE node_modules wholesale every boot: it's a seed-managed (ignored)
    // tree, so wipe-then-write rather than merge — a merge orphans files dropped
    // from a newer seed (e.g. the whole bongle/src tree, after the src→dist
    // switch), which the bundler + Monaco then pick up stale. No marker/cache:
    // prod runs in a credentialless iframe (ephemeral OPFS) so it reseeds every
    // load anyway, and always-reseed keeps dev from ever going stale. Everything
    // under node_modules comes from the zip, so a clean slate is safe.
    await fs.remove('node_modules', { recursive: true }).catch(() => {});
    const buf = new Uint8Array(await (await fetch(ZIP_URL)).arrayBuffer());
    const entries = unzipSync(buf);
    const files = Object.entries(entries).filter(([path]) => !path.endsWith('/')); // skip dir entries
    // batched, bounded-concurrency writes so the per-write OPFS latencies overlap
    // (sequential awaits cost ~3s); distinct paths + OPFS's idempotent dir creation
    // make concurrent writes safe, and the batch cap avoids thrashing the disk.
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(([path, bytes]) => fs.write(`node_modules/${path}`, bytes)));
    }
    if (files.length === 0) console.warn('[engine-dist] seed zip was empty');
}
