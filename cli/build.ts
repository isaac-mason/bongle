// lib/cli/build.ts — `bongle build <project>`: the host-neutral build core
// (lib/build/bundle.ts) driven from node. Node `rolldown` is the reference type
// the core injects, so it's passed straight through — no cast, no `prepare` shim
// (that's the browser's `process` workaround). Same graph → same zip the editor
// produces.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { buildBundle } from '../build';
import { openNodeFs } from './node-fs';
import { bake } from './pipeline/pipeline';

export async function buildCommand(projectDir: string, opts: { maxPlayers: number; out: string }): Promise<void> {
    const root = resolve(projectDir);
    const fs = openNodeFs(root);
    const t0 = performance.now();

    // bake assets first → resources/client on disk; buildBundle copies them in.
    // The bake also evaluates the project (populating the registry), so maxPlayers
    // comes off the matchmaking registration rather than the CLI flag.
    console.log('  · Baking assets');
    const baked = await bake(fs, root);
    const maxPlayers = baked.matchmaking?.maxPlayers ?? opts.maxPlayers;

    const zip = await buildBundle(fs, { rolldown }, { maxPlayers, onProgress: (l) => console.log(`  · ${l}`) });
    writeFileSync(opts.out, zip);
    console.log(`✓ ${opts.out} — ${(zip.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)}ms`);
}
