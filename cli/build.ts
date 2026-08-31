// lib/cli/build.ts — `bongle build <project>`: the host-neutral build core
// (lib/build/bundle.ts) driven from node. Bundling is shakeup, the same bundler the
// dev server and the editor's build run — nothing injected, no host prep.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildBundle } from '../build';
import type { Config } from '../src/core/config';
import { bake } from './bake/bake';
import { openNodeFs } from './node-fs';

export async function buildCommand(projectDir: string, opts: { maxPlayers: number; out: string }): Promise<void> {
    const root = resolve(projectDir);
    const fs = openNodeFs(root);
    const t0 = performance.now();

    // bake assets first → resources/client on disk; buildBundle copies them in.
    // The bake also evaluates the project (populating the registry), so the launch
    // config comes off the config() registration rather than the CLI flag. When
    // the project didn't call config(), fall back to a server config using the
    // --max-players flag.
    console.log('  · Baking assets');
    const baked = await bake(fs, root);
    const config: Config = baked.config ?? { server: { maxPlayers: opts.maxPlayers } };

    const zip = await buildBundle(fs, { config, onProgress: (l: string) => console.log(`  · ${l}`) });
    writeFileSync(opts.out, zip);
    console.log(`✓ ${opts.out} — ${(zip.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)}ms`);
}
