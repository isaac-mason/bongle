/**
 * kit/vite/config.ts — Vite UserConfig factory for `bongle edit`.
 *
 * Three named environments via Vite's Environment API:
 *   • `client`         — browser bundle. default web env. user code + engine
 *                        client sources live here.
 *   • `server`     — `createRunnableDevEnvironment`. node-side runner
 *                        loaded by `kit/dev/game-env.ts`. Hosts the
 *                        EngineServer; receives WS upgrades via the
 *                        `/game` transport. Also hosts the asset-pipeline
 *                        flush handler (atlas/models/scenes codegen) registered
 *                        by the `bongle:pipeline` plugin.
 * The asset pipeline (`AssetPipeline`, behind `engine-asset-pipeline`) is NOT
 * its own env — it runs inside the `server` graph (compiled `env.client=false`;
 * the render path is env-agnostic), so bake + codegen + render share one
 * registry. The `bongle:pipeline` plugin inits + drives it; see
 * `src/asset-pipeline/pipeline.ts`.
 *
 * The `bongle()` plugin is shared across the envs — every user-src file
 * gets the same push/pop/decideReload transform regardless of which env
 * evaluates it. Each env's runtime separately calls
 * `__kit.registerFlush(...)` at boot, so the same `__kit.flush()` call
 * site routes to the right consumer per env (engine dispatch + pipeline
 * on server; engine dispatch on client).
 *
 * `optimizeDeps.exclude` covers engine + external workspace deps so vite
 * serves them as source, not pre-bundled chunks. Pre-bundling would fork
 * the per-side capture registries between user code and engine code.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import {
    createLogger,
    createRunnableDevEnvironment,
    defineConfig,
    type Logger,
    type Plugin,
    searchForWorkspaceRoot,
    type UserConfig,
} from 'vite';

// Absolute path to bongle's package root, derived from this file's own
// location (`<root>/kit/vite/config.ts`). Works whether bongle is the
// linked workspace source or an installed node_modules package — both ship
// `kit/` and `src/` in the same layout.
const BONGLE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Normalise to a forward-slash glob (vite's dep scanner globs want posix). */
const toGlob = (p: string) => p.replace(/\\/g, '/');

import { envPlugin } from '../env-plugin';
import { bongle, type EngineRebootRef } from './plugin';

export type BongleConfigOptions = {
    /** absolute path to project root (contains src/, resources/). */
    projectDir: string;
    /** absolute path to .bongle/ (vite root). */
    bongleDir: string;
    /** vite dev server port for the client env. */
    port: number;
    /** set by the dev orchestrator so engine-source changes reboot the server
     *  env. Omitted by non-dev consumers (build). */
    engineReboot?: EngineRebootRef;
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
    const { projectDir, bongleDir, port, engineReboot } = opts;

    return defineConfig({
        root: bongleDir,
        customLogger: makeLogger(),
        // authored client static (favicon, fonts, …). resources/client is
        // served live by the bongle() plugin instead — see plugin.ts.
        publicDir: path.join(projectDir, 'public'),
        plugins: [
            // Scope tailwind to the client env only. Without this the plugin
            // pipeline also runs editor.css through server/SSR, which
            // races vite's per-env `cssModulesCache` init in `vite:css-post`
            // and crashes the dev server at startup with
            // `cssModulesCache.get(config)` undefined. editor.css is only
            // reachable from client/ui/ui.tsx anyway.
            ...tailwindcss().map(
                (p: Plugin): Plugin => ({
                    ...p,
                    applyToEnvironment(env) {
                        return env.name === 'client';
                    },
                }),
            ),
            // Per-env envPlugin instances — `applyToEnvironment` scopes each
            // substitution set to its own env's module graph.
            envPlugin({ client: true, server: false, editor: true }, 'client'),
            envPlugin({ client: false, server: true, editor: true }, 'server'),
            ...bongle({ projectDir, engineReboot }),
        ],
        server: {
            port,
            host: '127.0.0.1',
            // Cross-origin isolation, ON by default in dev (opt out with `COI=0 ./dev.sh`).
            // Chrome quantizes WebGPU timestamp-query results unless `crossOriginIsolated`,
            // making the inspector's GPU timings coarse/untrustworthy; this flips it on.
            // `credentialless` COEP keeps cross-origin (R2/CDN) assets + CORS fetches working.
            // Dev-server only — prod (server.mjs / static host) is unaffected. Only takes
            // effect when the embedding website is ALSO COI (see its vite config). Opt out
            // if a cross-origin POPUP flow (COOP severs window.opener) or a credentialed
            // cross-origin subresource breaks locally.
            headers:
                process.env.COI !== '0'
                    ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }
                    : {},
            fs: {
                // workspace root for engine sources + hoisted node_modules;
                // projectDir so content/* and resources/* are reachable.
                allow: [searchForWorkspaceRoot(projectDir), projectDir],
            },
            watch: {
                // Vite (7.x/8.x) defaults `usePolling` to `true` on macOS when
                // FSEvents can't initialize (vitejs/vite#21033) — chokidar then
                // stats every watched file on a timer, burning CPU + allocating
                // continuously at idle. Force it off so we use FSEvents/native
                // fs.watch; harmless when FSEvents is available.
                usePolling: false,
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
            // Reproduce the monorepo's linked-package behaviour for installed
            // consumers. When `bongle` is a workspace symlink it resolves as
            // *source*, so vite crawls it and auto-discovers + pre-bundles the
            // editor's whole UI dep closure (react, zustand, @dnd-kit, …) in a
            // single optimize pass — correct CJS→ESM interop, proper @dnd-kit
            // shared-state dedup, zero config. An *installed* `bongle` lives in
            // node_modules and is excluded below, so vite won't crawl it and
            // those deps stay invisible to the scanner — every `import … from
            // 'react'` then breaks on missing interop, dep by dep.
            //
            // Fix without a hand-maintained `include` list: point the dep
            // scanner straight at bongle's browser source (client/ + editor/)
            // and the project's own src. It reads the real files — not the
            // excluded `bongle` specifier — so it finds exactly the deps the
            // monorepo finds. Scoped to client/ + editor/ so the scan never
            // reaches server/pipeline code (which pulls native node deps).
            entries: [
                toGlob(path.join(BONGLE_ROOT, 'src/client/**/*.{ts,tsx}')),
                toGlob(path.join(BONGLE_ROOT, 'src/editor/**/*.{ts,tsx}')),
                toGlob(path.join(projectDir, 'src/**/*.{ts,tsx}')),
                // test/bench files import vitest and aren't part of the app
                // graph — keep them out of the dep scan (they'd fail to resolve
                // in a consuming game that has no test deps installed).
                `!${toGlob(path.join(BONGLE_ROOT, 'src/**/*.{test,bench}.{ts,tsx}'))}`,
                `!${toGlob(path.join(projectDir, 'src/**/*.{test,bench}.{ts,tsx}'))}`,
            ],
            // engine + workspace deps must share the SAME module instance
            // across user code and engine code; pre-bundling would fork
            // the capture registries.
            exclude: [
                'bongle',
                'bongle/engine-client',
                'bongle/engine-asset-pipeline',
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
            server: {
                resolve: {
                    conditions: ['node'],
                    // bundle engine + workspace deps so user code and engine
                    // code share one module instance (and one set of capture
                    // registries). everything else stays external — node
                    // loads it via its native require, which is essential
                    // for CJS-only leaf deps reached via the editor module
                    // (react, react-dom, zustand). vite's module-runner
                    // can't evaluate CJS, so bundling those crashes the
                    // server env at boot.
                    noExternal: ['bongle', /^@bongle\//, 'gpucat', 'mathcat', 'packcat', 'crashcat'],
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
