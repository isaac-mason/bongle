/**
 * kit/vite/config.ts — Vite UserConfig factory for `bongle edit`.
 *
 * Two named environments via Vite 6's Environment API:
 *   • `client`         — browser bundle. default web env. user code + engine
 *                        client sources live here.
 *   • `gameServer`     — `createRunnableDevEnvironment`. node-side runner
 *                        loaded by `kit/src/dev/game-env.ts`. Hosts the
 *                        EngineServer; receives WS upgrades via the
 *                        `/game` transport. Also hosts the asset-pipeline
 *                        flush handler registered by the `bongle:pipeline`
 *                        plugin — gameServer-local registries already hold
 *                        every declarative entry the pipeline reads, so
 *                        there's no need for a third env.
 *
 * The `bongle()` plugin is shared across both envs — every user-src file
 * gets the same push/pop/decideReload transform regardless of which env
 * evaluates it. Each env's runtime separately calls
 * `__kit.registerFlush(...)` at boot, so the same `__kit.flush()` call
 * site routes to the right consumer per env (engine dispatch + pipeline
 * on gameServer; engine dispatch on client).
 *
 * `optimizeDeps.exclude` covers engine + external workspace deps so vite
 * serves them as source, not pre-bundled chunks. Pre-bundling would fork
 * the per-side capture registries between user code and engine code.
 */

import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, createRunnableDevEnvironment, defineConfig, type Logger, searchForWorkspaceRoot, type Plugin, type UserConfig } from 'vite';
import { envPlugin } from '../env-plugin';
import { bongle } from './plugin';

export type BongleConfigOptions = {
    /** absolute path to project root (contains src/, resources/). */
    projectDir: string;
    /** absolute path to .bongle/ (vite root). */
    bongleDir: string;
    /** vite dev server port for the client env. */
    port: number;
};

// Engine + workspace deps are served raw (see `optimizeDeps.exclude`), and
// some — notably `@dnd-kit/*`, pulled in by the editor UI — ship a
// `//# sourceMappingURL=*.js.map` comment without the actual `.map` file.
// Vite warns on every such transform; the warnings are cosmetic and not
// fixable from here, so drop them while leaving every other warning intact.
function makeLogger(): Logger {
    const base = createLogger();
    const suppress = (msg: unknown) => typeof msg === 'string' && msg.includes('Failed to load source map');
    return {
        ...base,
        warn(msg, options) {
            if (suppress(msg)) return;
            base.warn(msg, options);
        },
        warnOnce(msg, options) {
            if (suppress(msg)) return;
            base.warnOnce(msg, options);
        },
    };
}

export function defineBongleConfig(opts: BongleConfigOptions): UserConfig {
    const { projectDir, bongleDir, port } = opts;

    return defineConfig({
        root: bongleDir,
        customLogger: makeLogger(),
        // authored client static (favicon, fonts, …). resources/client is
        // served live by the bongle() plugin instead — see plugin.ts.
        publicDir: path.join(projectDir, 'public'),
        plugins: [
            // Scope tailwind to the client env only. Without this the plugin
            // pipeline also runs editor.css through gameServer/SSR, which
            // races vite's per-env `cssModulesCache` init in `vite:css-post`
            // and crashes the dev server at startup with
            // `cssModulesCache.get(config)` undefined. editor.css is only
            // reachable from client/ui/ui.tsx anyway.
            ...tailwindcss().map((p: Plugin): Plugin => ({
                ...p,
                applyToEnvironment(env) {
                    return env.name === 'client';
                },
            })),
            // Per-env envPlugin instances — `applyToEnvironment` scopes each
            // substitution set to its own env's module graph. The persistent-
            // puppeteer page is a regular client (env.client=true) loaded by
            // the bongle:pipeline plugin's browser; no third env needed.
            envPlugin({ client: true, server: false, editor: true }, 'client'),
            envPlugin({ client: false, server: true, editor: true }, 'gameServer'),
            ...bongle({ projectDir, bongleDir }),
        ],
        server: {
            port,
            host: '127.0.0.1',
            fs: {
                // workspace root for engine sources + hoisted node_modules;
                // projectDir so content/* and resources/* are reachable.
                allow: [searchForWorkspaceRoot(projectDir), projectDir],
            },
            watch: {
                // artifacts kit writes into .bongle/ at runtime + asset
                // pipeline outputs in projectDir. without these, vite's
                // watcher picks the writes up, has no HMR strategy outside
                // its module graph, and fullReloads the page.
                //
                // `content/scenes/**` is scoped (not `content/**`) so the
                // bongle:pipeline plugin's `server.watcher` hook can see
                // other project-rooted asset sources (gltf/png/ogg/...)
                // users drop anywhere under projectDir. The scenes dir is
                // still suppressed — bongle:scenes runs its own fs.watch
                // and routes changes through a dedicated HMR channel.
                ignored: [
                    path.join(projectDir, 'content', 'scenes', '**'),
                    path.join(projectDir, 'resources', '**'),
                    path.join(projectDir, 'public', '**'),
                ],
            },
        },
        resolve: {
            preserveSymlinks: false,
        },
        optimizeDeps: {
            // react is only reachable through `bongle` (excluded below), so
            // vite's entry scan never discovers it and skips pre-bundling.
            // It would then be served raw without CJS→ESM interop, breaking
            // `import React from 'react'` (no `default` export). Force-include
            // the react packages so they're pre-bundled with interop; every
            // consumer (engine UI, dnd-kit, zustand, …) shares this one copy.
            include: [
                'react',
                'react-dom',
                'react-dom/client',
                'react/jsx-runtime',
                'react/jsx-dev-runtime',
            ],
            // engine + workspace deps must share the SAME module instance
            // across user code and engine code; pre-bundling would fork
            // the capture registries.
            exclude: [
                'bongle',
                'bongle/engine-client',
                'bongle/offline-renderer',
                'bongle/internal',
                'bongle/interface',
                'gpucat',
                'mathcat',
                'packcat',
                'crashcat',
            ],
        },
        environments: {
            client: {
                // browser env defaults; the bongle() plugin's transform
                // applies here too.
            },
            gameServer: {
                resolve: {
                    conditions: ['node'],
                    // bundle engine + workspace deps so user code and engine
                    // code share one module instance (and one set of capture
                    // registries). everything else stays external — node
                    // loads it via its native require, which is essential
                    // for CJS-only leaf deps reached via the editor module
                    // (react, react-dom, zustand). vite's module-runner
                    // can't evaluate CJS, so bundling those crashes the
                    // gameServer env at boot.
                    noExternal: [
                        'bongle',
                        /^@bongle\//,
                        'gpucat',
                        'mathcat',
                        'packcat',
                        'crashcat',
                    ],
                },
                dev: {
                    createEnvironment(name, config) {
                        return createRunnableDevEnvironment(name, config, {
                            runnerOptions: { hmr: { logger: false } },
                        });
                    },
                },
            },
        },
        logLevel: 'info',
    });
}

