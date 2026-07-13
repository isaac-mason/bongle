// editor/engine-dist.ts — seed the prebundled engine dist into the vfs at
// node_modules/bongle/dist/, so the in-browser bundler resolves `bongle*` like
// any project module (one vfs-driven resolver; the pipeline reads assets from
// the same fs).
//
// In dev the dist is globbed from ../dist (built by `pnpm run build`); a
// standalone editor build copies dist in and globs its own copy. env is left as
// a real property read in these chunks (behind the `bongle/env` seam) — the
// dev-server's per-env transform does the envPlugin replacement.

import type { Filesystem } from './fs';

// eager + raw: the prebundled JS chunks inline into the editor bundle, so the
// editor carries the engine (embeddable, no external fetch).
const DIST = import.meta.glob('../dist/**/*.js', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

export async function seedEngineDist(fs: Filesystem): Promise<void> {
    let count = 0;
    for (const [key, code] of Object.entries(DIST)) {
        // '../dist/chunks/x.js' → 'chunks/x.js'
        const rel = key.replace(/^.*\/dist\//, '');
        await fs.write(`node_modules/bongle/dist/${rel}`, code);
        count++;
    }
    // minimal manifest so node_modules resolution / tooling sees the package.
    await fs.write('node_modules/bongle/package.json', JSON.stringify({ name: 'bongle', type: 'module' }));
    if (count === 0) {
        console.warn('[engine-dist] no dist chunks found — run `pnpm run build` in lib/ first');
    }
}
