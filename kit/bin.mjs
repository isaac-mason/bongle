#!/usr/bin/env node
// npm strips `bin` entries whose path doesn't end in `.js`/`.cjs`/`.mjs`,
// so the published bin can't point straight at `./index.ts`. This shim
// runs the real TS entry through Vite's SSR module runner.
//
// Why not tsx: tsx registers a global Node module loader and transforms
// every `.ts` it sees, including third-party CJS in node_modules. That
// runtime patching is fragile across Node versions — it mis-resolves
// trailing-slash specifiers (readable-stream's `require('process/')`) and
// throws on require()-of-ESM import cycles (our generated/index.ts). Vite
// instead transforms only our own source (the kit + the linked `bongle`
// engine) and hands node_modules to native Node, so those footguns vanish.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const libRoot = path.resolve(here, '..');

const server = await createServer({
    root: libRoot,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    // No HTTP server / HMR / file watching — we only want the transform
    // pipeline to load one entry and exit.
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    ssr: {
        // `bongle` is the engine: linked into node_modules but shipped as
        // TS source, so it must be transformed, not externalized as JS.
        noExternal: [/^bongle(\/|$)/],
    },
});

try {
    const runner = createServerModuleRunner(server.environments.ssr);
    // index.ts top-level-awaits main(), so this resolves only once the
    // command has fully finished — safe to tear the server down after.
    await runner.import(path.join(here, 'index.ts'));
} catch (err) {
    console.error(err);
    process.exitCode = 1;
} finally {
    await server.close();
}
