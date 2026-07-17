// cli/dev/config.ts — Vite config for `bongle dev` (client + server envs).
//
// Resurrected from the pre-pivot kit/vite/config.ts (commit 0ca35db). Two named
// environments via the Environment API:
//   • client — browser bundle (default web env). user code + engine client sources.
//   • server — createRunnableDevEnvironment (node runner, in-process). Hosts
//     EngineServer + the /game WS.
// The bongle() plugin is shared across both; per-env envPlugin scopes the env-flag
// substitution. optimizeDeps.exclude keeps bongle/engine served raw (one module
// instance + one capture registry across user + engine code); the client dep
// scanner still pre-bundles the UI dep closure (react/…) with correct CJS interop.
// (pipeline env — worker_thread bake — lands in M4.)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { createRunnableDevEnvironment, defineConfig, type Plugin, searchForWorkspaceRoot, type UserConfig } from 'vite';
import { envPlugin } from '../../editor/env-plugin';
import { bongle, type EngineRebootRef } from './plugin';
import { serveAvatars } from './serve-avatars';
import { serveResources } from './serve-resources';
import { serveScenes } from './serve-scenes';
import { virtualEntries } from './virtual-entries';

/** bongle's package root (this file is <root>/cli/dev/config.ts). */
const BONGLE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toGlob = (p: string) => p.replace(/\\/g, '/');

export type BongleDevConfigOptions = {
    /** absolute project root (contains src/, resources/). */
    projectDir: string;
    /** vite root (holds index.html). */
    rootDir: string;
    port: number;
    /** set by the dev orchestrator so engine-source changes reboot server/pipeline. */
    engineReboot?: EngineRebootRef;
};

/** bongle + engine + workspace deps shared as ONE module instance per env. */
const SHARED = ['bongle', /^@bongle\//, 'gpucat', 'mathcat', 'packcat', 'crashcat'];

export function defineBongleDevConfig(opts: BongleDevConfigOptions): UserConfig {
    const { projectDir, rootDir, port, engineReboot } = opts;
    return defineConfig({
        root: rootDir,
        plugins: [
            // tailwind for the edit UI — client env only (server/SSR running
            // editor.css through vite:css-post races per-env cssModulesCache init
            // and crashes startup; the edit UI's css is only reachable client-side).
            ...tailwindcss().map((p: Plugin): Plugin => ({ ...p, applyToEnvironment: (e) => e.name === 'client' })),
            // edit mode: the in-game scene/voxel editor (editor:true all envs).
            envPlugin({ client: true, server: false, editor: true }, 'client'),
            envPlugin({ client: false, server: true, editor: true }, 'server'),
            envPlugin({ client: false, server: true, editor: true }, 'pipeline'),
            virtualEntries({ projectDir }),
            serveResources({ projectDir }),
            serveScenes({ projectDir }),
            serveAvatars(),
            ...bongle({ projectDir, engineReboot }),
        ],
        server: {
            port,
            host: '127.0.0.1',
            fs: { allow: [searchForWorkspaceRoot(projectDir), projectDir, rootDir, BONGLE_ROOT] },
            watch: {
                // the bake writes resources/ + we serve content/scenes ourselves;
                // without this vite's watcher HMRs/reloads on those writes.
                ignored: [
                    path.join(projectDir, 'resources', '**'),
                    path.join(projectDir, 'content', 'scenes', '**'),
                    path.join(projectDir, 'public', '**'),
                ],
            },
        },
        resolve: {
            preserveSymlinks: false,
            // the shell imports the user's entry by this specifier.
            alias: { 'bongle-project-entry': path.join(projectDir, 'src/index.ts') },
        },
        optimizeDeps: {
            // Point the scanner at bongle's own client source + the project src so it
            // discovers + pre-bundles the real UI dep closure (react, zustand, …)
            // with correct CJS interop — the fix for the react-family wall.
            entries: [
                // client + editor UI source so the scanner finds the full dep
                // closure (react, zustand, @base-ui, @dnd-kit — the edit UI's deps).
                toGlob(path.join(BONGLE_ROOT, 'src/client/**/*.{ts,tsx}')),
                toGlob(path.join(BONGLE_ROOT, 'src/editor/**/*.{ts,tsx}')),
                toGlob(path.join(projectDir, 'src/**/*.{ts,tsx}')),
                `!${toGlob(path.join(BONGLE_ROOT, 'src/**/*.{test,bench}.{ts,tsx}'))}`,
            ],
            exclude: ['bongle', 'bongle/engine-client', 'bongle/internal', 'bongle/env', 'gpucat', 'mathcat', 'packcat', 'crashcat'],
        },
        environments: {
            client: {},
            server: {
                resolve: {
                    conditions: ['node'],
                    // bundle bongle + engine + workspace deps into the server graph
                    // so user code + engine share one instance (+ one capture
                    // registry). Everything else stays external → node's native
                    // require loads it (essential for CJS-only leaf deps: vite's
                    // module-runner can't eval CJS, so bundling those would crash).
                    noExternal: SHARED,
                },
                dev: {
                    createEnvironment(name, config) {
                        return createRunnableDevEnvironment(name, config, { runnerOptions: { hmr: { logger: false } } });
                    },
                },
            },
            // the asset pipeline realm: same bundling as server (one shared bongle
            // instance), also a node RunnableDevEnvironment. Runs the DATA bake on
            // flush (see realms/pipeline/pipeline.ts); no icons (no Dawn in this process).
            pipeline: {
                resolve: { conditions: ['node'], noExternal: SHARED },
                dev: {
                    createEnvironment(name, config) {
                        return createRunnableDevEnvironment(name, config, { runnerOptions: { hmr: { logger: false } } });
                    },
                },
            },
        },
    });
}
