// lib/cli/bongle.ts — the `bongle` CLI logic. The installable bin is bongle.mjs,
// which registers a TS loader (tsx) then imports this: bongle ships SOURCE, so
// lib/build + the engine use extensionless bundler-style imports node's own
// resolver won't follow.
//
// Today: `bongle build` (bake + bundle), `bongle bake`, `bongle dev` (the node
// local dev host: the lib/build dev-server core served over HTTP/WS, dev.ts), and
// `bongle start` (run a built bundle standalone: server + served client).

import { bakeCommand } from './bake/bake';
import { buildCommand } from './build';
import { devCommand } from './dev/start';
import { startCommand } from './start';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
};
const projectArg = () => rest.find((a) => !a.startsWith('-')) ?? '.';

function usage(): never {
    console.error(
        'usage:\n  bongle build <project> [--max-players N] [--out bundle.zip]\n  bongle bake <project>\n  bongle dev <project> [--port N]\n  bongle start <bundle.zip|dir> [--port N]',
    );
    process.exit(1);
}

if (cmd === 'build') {
    await buildCommand(projectArg(), {
        maxPlayers: Number(flag('--max-players') ?? 8),
        out: flag('--out') ?? 'bundle.zip',
    });
    exitOneShot();
} else if (cmd === 'bake') {
    await bakeCommand(projectArg());
    exitOneShot();
} else if (cmd === 'dev') {
    await devCommand(projectArg(), { port: flag('--port') ? Number(flag('--port')) : undefined });
} else if (cmd === 'start') {
    // the built bundle (dir or zip), defaulting to `bongle build`'s default output.
    const bundle = rest.find((a) => !a.startsWith('-')) ?? 'bundle.zip';
    await startCommand(bundle, { port: flag('--port') ? Number(flag('--port')) : undefined });
} else {
    usage();
}

// The icon render loads webgpu (Dawn), whose AsyncRunner keeps scheduling
// ProcessEvents on the event loop and segfaults on native teardown. For a one-shot
// command all work is already flushed to disk (writeFileSync) by the time we get
// here, so exit(0) explicitly — this stops the loop before the next Dawn callback
// fires, turning a spurious signal-death into a clean exit. `bongle dev` stays up.
function exitOneShot(): never {
    process.exit(0);
}
