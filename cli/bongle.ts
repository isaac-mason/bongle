#!/usr/bin/env -S node --import tsx
// lib/cli/bongle.ts — the `bongle` CLI entry.
//
// Run under a TS loader (tsx): bongle ships SOURCE, so lib/build + the engine use
// extensionless bundler-style imports node's own resolver won't follow. tsx is the
// loader; packaging (bundle the CLI to .js, or declare tsx a dep) is a later call.
//
// Today: `bongle build`. `bongle dev` is next — its core (lib/build/dev-server.ts)
// is ready; it needs a node HTTP/WS realm transport (the browser uses MessagePort).

import { buildCommand } from './build';
import { bakeCommand } from './pipeline';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
};
const projectArg = () => rest.find((a) => !a.startsWith('-')) ?? '.';

function usage(): never {
    console.error('usage:\n  bongle build <project> [--max-players N] [--out bundle.zip]\n  bongle bake <project>');
    process.exit(1);
}

if (cmd === 'build') {
    await buildCommand(projectArg(), {
        maxPlayers: Number(flag('--max-players') ?? 8),
        out: flag('--out') ?? 'bundle.zip',
    });
} else if (cmd === 'bake') {
    await bakeCommand(projectArg());
} else {
    usage();
}
