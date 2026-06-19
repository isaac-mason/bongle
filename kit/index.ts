import { parseArgs } from 'node:util';
import { build } from './build';
import { buildStatic } from './build-static';
import { edit } from './edit';
import { migrate } from './migrate';
import { newProject } from './new';
import { start } from './start';
import { upgrade } from './upgrade';

async function main() {
    const { positionals, values } = parseArgs({
        options: {
            help: { type: 'boolean', short: 'h' },
            inspect: { type: 'boolean' },
            'performance-logs': { type: 'boolean' },
            static: { type: 'boolean' },
            share: { type: 'boolean' },
            port: { type: 'string' },
            check: { type: 'boolean' },
            template: { type: 'string' },
            'skip-install': { type: 'boolean' },
            'skip-migrate': { type: 'boolean' },
        },
        allowPositionals: true,
    });

    const cmd = positionals[0];
    const args = positionals.slice(1);

    if (values.help || !cmd) {
        console.log(`bongle - cli for the bongle engine

Usage:
  bongle new <project-dir> [--template NAME] [--skip-install]   scaffold a new project
  bongle edit    [--inspect] [--performance-logs] [--share]   run the editor in dev mode
  bongle build   [--static]                         build the project into dist/bundle.zip
  bongle start   [--port N]                         serve a built dist/ locally (smoke test)
  bongle migrate [--check]                          migrate content/* to latest schema;
                                                    --check fails non-zero if anything is behind
  bongle upgrade [--skip-install] [--skip-migrate]  refetch \`bongle\` from github main, run migrate

All commands except \`new\` operate on the current working directory.

Flags:
  --inspect          with edit: open a node inspector on this process so a debugger
                     or profiler can attach (chrome://inspect)
  --performance-logs with edit: print the per-tick server perf digest to the CLI
  --static        with build: emit a self-contained browser bundle (no server, no
                  matchmaking) servable from any static host or iframed subpath
  --share         with edit: expose the dev server publicly via a cloudflared
                  tunnel (requires cloudflared on PATH)
  --port          with start: override the listen port (default 3002)
  --check         with migrate: check-only mode; exits non-zero if any file is behind
  --template      with new: pick a template (default: "default")
  --skip-install  with new/upgrade: skip the install step
  --skip-migrate  with upgrade: skip the content migrate step
`);
        process.exit(cmd ? 0 : 1);
    }

    switch (cmd) {
        case 'new': {
            const projectDir = args[0];
            if (!projectDir) {
                console.error('[bongle] new requires a project directory: bongle new <project-dir>');
                process.exit(1);
            }
            await newProject(projectDir, {
                template: values.template,
                skipInstall: values['skip-install'],
            });
            break;
        }
        case 'edit': {
            await edit(process.cwd(), {
                inspect: values.inspect,
                share: values.share,
                performanceLogs: values['performance-logs'],
            });
            break;
        }
        case 'build': {
            if (values.static) {
                await buildStatic(process.cwd());
            } else {
                await build(process.cwd());
            }
            break;
        }
        case 'start': {
            const port = values.port ? Number(values.port) : undefined;
            await start(process.cwd(), { port });
            break;
        }
        case 'migrate': {
            await migrate(process.cwd(), { check: values.check });
            break;
        }
        case 'upgrade': {
            await upgrade(process.cwd(), {
                skipInstall: values['skip-install'],
                skipMigrate: values['skip-migrate'],
            });
            break;
        }
        default:
            console.error('Unknown command:', cmd);
            process.exit(1);
    }
}

main();
