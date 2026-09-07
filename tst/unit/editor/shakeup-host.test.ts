import type { Fs } from 'shakeup';
import { afterEach, describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../../build/dev/shakeup-port';
import { browserEvaluator, ensureProcessShim, makeImportMeta } from '../../../build/dev/shakeup-runner-host';
import type { ModuleEvaluator } from 'shakeup';

function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

// An ASYNC in-memory fs over a mutable map — mirrors OPFS's async reads. shakeup's Fs is
// first-class async, so it plugs straight into the dev server (no eager mirror, no seed step).
function asyncFs(files: Record<string, string>): Fs {
    return {
        read: async (id) => files[id] ?? null,
        exists: async (id) => id in files,
    };
}

// Full Stage-2 assembly, end-to-end: one shakeup-backed host (async fs + capture plugin + dev
// server) serving a realm that evaluates over a port with the browser runner host bits.
describe('createShakeupBundlerHost (full assembly, async fs)', () => {
    it('serves a realm that fetches, evaluates, and sees its project import.meta.url', async () => {
        const host = createShakeupBundlerHost({
            fs: asyncFs({
                '/base.ts': 'export const base = 40;',
                '/index.ts':
                    "import { base } from './base';\nexport const value = base + 2;\nexport const here = import.meta.url;",
            }),
            jsx: false,
            isUserModule: () => false, // host mechanics test — not exercising __bongle capture
        });

        const [bundlerPort, runnerPort] = portPair();
        host.connectRealm('client', bundlerPort);
        const env = connectRealmPort(runnerPort, {
            name: 'client',
            evaluator: browserEvaluator,
            prepare: ensureProcessShim,
            createImportMeta: makeImportMeta((p) => `https://app.test/@project${p}`),
        });

        const ns = await env.import('/index.ts');
        expect(ns.value).toBe(42); // cross-module eval over the port, read from the async fs
        expect(ns.here).toBe('https://app.test/@project/index.ts'); // import.meta.url wired through

        host.close();
    });

    it('serves a ?url asset import as the injected assetUrl (projectUrl in the editor)', async () => {
        const host = createShakeupBundlerHost({
            fs: asyncFs({
                '/logo.png': 'PNG-BYTES',
                '/index.ts': "import u from './logo.png?url';\nexport const url = u;",
            }),
            jsx: false,
            isUserModule: () => false, // host mechanics test — not exercising __bongle capture
            assetUrl: (p) => `https://app.test/@project${p}`,
        });
        const [bp, rp] = portPair();
        host.connectRealm('client', bp);
        const env = connectRealmPort(rp, { name: 'client' });

        // the file is served by the host (SW in the editor), so the import is just its URL — no
        // bytes are read into the graph.
        expect((await env.import('/index.ts')).url).toBe('https://app.test/@project/logo.png');

        host.close();
    });

    it('serves a ?worker&inline import as a WorkerWrapper (nested-bundled, no rolldown)', async () => {
        const host = createShakeupBundlerHost({
            fs: asyncFs({
                '/lib.ts': 'export const step = (n) => n + 1;',
                '/task.worker.ts': "import { step } from './lib';\nonmessage = (e) => postMessage(step(e.data));",
                '/index.ts': "import W from './task.worker.ts?worker&inline';\nexport const Ctor = W;",
            }),
            jsx: false,
            isUserModule: () => false, // host mechanics test — not exercising __bongle capture
        });
        const [bp, rp] = portPair();
        host.connectRealm('client', bp);
        const env = connectRealmPort(rp, { name: 'client' });

        // self/Worker are absent in node → the wrapper module evaluates but constructs nothing until
        // called. The default export is the WorkerWrapper constructor.
        const ns = await env.import('/index.ts');
        expect(typeof ns.Ctor).toBe('function');

        host.close();
    });

    it('disconnectRealm retires a dead realm so edits stop fanning into its closed port', async () => {
        const files: Record<string, string> = { '/m.ts': 'export const v = 1;' };
        const host = createShakeupBundlerHost({ fs: asyncFs(files), jsx: false, isUserModule: () => false });
        const [bp, rp] = portPair();
        // count what the host posts toward the realm, so a push to a retired realm is visible.
        let posted = 0;
        const counting: RealmPort = {
            postMessage: (d) => {
                posted++;
                bp.postMessage(d);
            },
            onmessage: null,
        };
        bp.onmessage = (e) => counting.onmessage?.(e);
        host.connectRealm('client:1', counting);
        const env = connectRealmPort(rp, { name: 'client' });
        await env.import('/m.ts');

        host.disconnectRealm('client:1');
        posted = 0;
        files['/m.ts'] = 'export const v = 2;';
        await host.server.handleChange('/m.ts');

        // realm names are per-process and never reused, so nothing else would ever retire this one:
        // without disconnectRealm every later edit keeps pushing into a port whose process is gone.
        expect(posted).toBe(0);
        host.close();
    });

    it('an fs edit re-serves the updated module to a fresh import', async () => {
        const files: Record<string, string> = { '/m.ts': 'export const v = 1;' };
        const host = createShakeupBundlerHost({ fs: asyncFs(files), jsx: false, isUserModule: () => false });
        const [bp, rp] = portPair();
        host.connectRealm('client', bp);
        const env = connectRealmPort(rp, { name: 'client' });

        expect((await env.import('/m.ts')).v).toBe(1);

        // Edit the live fs + fan HMR; the runner drops its instance and re-imports fresh source.
        files['/m.ts'] = 'export const v = 2;';
        host.onFsChange(['/m.ts']);
        env.runner.invalidate('/m.ts');
        expect((await env.import('/m.ts')).v).toBe(2);

        host.close();
    });

    describe('fs-relative id scheme (the editor: OPFS ids like `src/index.ts`, no leading slash)', () => {
        const realCwd = process.cwd;
        afterEach(() => {
            process.cwd = realCwd;
        });

        // The editor's opfsFs: ids are fs-relative, and a leading slash on a resolver candidate is
        // stripped, so `/src/index.ts` and `src/index.ts` both read the same file.
        function editorFs(files: Record<string, string>): Fs {
            const norm = (id: string) => id.replace(/^\/+/, '');
            return { read: async (id) => files[norm(id)] ?? null, exists: async (id) => norm(id) in files };
        }

        const project = {
            'node_modules/pkg/package.json': '{ "name": "pkg", "type": "module", "main": "index.js" }',
            'node_modules/pkg/index.js': 'export const state = { fromEntry: false };',
            // the user entry: mutates the package singleton, the way `use(blocks)` registers into
            // the engine's module-scope registry.
            'src/index.ts': "import { state } from 'pkg';\nstate.fromEntry = true;",
        };

        it('a bare entry and a bare package share ONE module instance even when the resolver cwd is `/`', async () => {
            // In a browser shakeup's resolver cwd defaults to `/`; the host must not let that leak a
            // second, slash-prefixed id family into the graph.
            process.cwd = () => '/';
            const host = createShakeupBundlerHost({ fs: editorFs(project), jsx: false, isUserModule: () => false });
            const [bp, rp] = portPair();
            host.connectRealm('client', bp);
            const env = connectRealmPort(rp, { name: 'client', evaluator: browserEvaluator, prepare: ensureProcessShim });

            // the realm's boot order: the user entry first, then the engine reaching the same package
            // by its bare name (bongle/os/apps/client importing bongle/engine-client).
            await env.import('src/index.ts');
            const pkg = await env.import('pkg');

            expect(pkg.state).toEqual({ fromEntry: true }); // one instance: the entry's write is visible
            expect(host.server.moduleIds().filter((id) => id.startsWith('/'))).toEqual([]);
            expect(host.server.moduleIds()).toContain('src/index.ts');
            expect(host.server.moduleIds()).toContain('node_modules/pkg/index.js');
            host.close();
        });

        it('an fs-relative edit path matches the graph key, so a save reaches the realm', async () => {
            process.cwd = () => '/';
            const files = { ...project };
            const host = createShakeupBundlerHost({ fs: editorFs(files), jsx: false, isUserModule: () => false });
            const [bp, rp] = portPair();
            host.connectRealm('client', bp);
            const env = connectRealmPort(rp, { name: 'client', evaluator: browserEvaluator, prepare: ensureProcessShim });
            await env.import('src/index.ts');

            files['src/index.ts'] = "import { state } from 'pkg';\nstate.fromEntry = 'edited';";
            const updates = await host.server.handleChange('src/index.ts'); // what onFsChange fans
            expect(updates.length).toBeGreaterThan(0); // the graph knew the module under this key
            host.close();
        });
    });

    describe('moduleUrl: dependencies are imported natively, only user modules are served', () => {
        const project = {
            'node_modules/pkg/package.json': '{ "name": "pkg", "type": "module", "exports": { ".": "./index.js" } }',
            'node_modules/pkg/index.js': 'export const state = { fromEntry: false };',
            'src/index.ts': "import { state } from 'pkg';\nstate.fromEntry = true;\nexport const seen = state;",
        };
        const editorFs = (files: Record<string, string>): Fs => {
            const norm = (id: string) => id.replace(/^\/+/, '');
            return { read: async (id) => files[norm(id)] ?? null, exists: async (id) => norm(id) in files };
        };
        const moduleUrl = (path: string) => `https://app.test/@project/${path}`;

        // The realm's native `import()`, recorded: hands back one shared instance per URL, the way a
        // browser's module map does.
        function recordingEvaluator(): { evaluator: ModuleEvaluator; imported: string[]; instances: Map<string, unknown> } {
            const imported: string[] = [];
            const instances = new Map<string, unknown>();
            const evaluator: ModuleEvaluator = {
                ...browserEvaluator,
                async runExternalModule(spec) {
                    imported.push(spec);
                    let ns = instances.get(spec);
                    if (ns === undefined) {
                        ns = { state: { fromEntry: false } };
                        instances.set(spec, ns);
                    }
                    return ns;
                },
            };
            return { evaluator, imported, instances };
        }

        it('a user import of a package resolves to its URL and never enters the dev server graph', async () => {
            const host = createShakeupBundlerHost({ fs: editorFs(project), jsx: false, isUserModule: () => false, moduleUrl });
            const [bp, rp] = portPair();
            host.connectRealm('client', bp);
            const { evaluator, imported } = recordingEvaluator();
            const env = connectRealmPort(rp, { name: 'client', evaluator, prepare: ensureProcessShim });

            const ns = await env.import('src/index.ts');

            expect(imported).toEqual(['https://app.test/@project/node_modules/pkg/index.js']); // resolved through `exports`, then redirected
            expect((ns.seen as { fromEntry: boolean }).fromEntry).toBe(true); // the user module ran against the native namespace
            expect(host.server.moduleIds()).toEqual(['src/index.ts']); // nothing under node_modules was transformed
            host.close();
        });

        it('the realm and user code reach a package by ONE URL, so they share its instance', async () => {
            const host = createShakeupBundlerHost({ fs: editorFs(project), jsx: false, isUserModule: () => false, moduleUrl });
            const [bp, rp] = portPair();
            host.connectRealm('client', bp);
            const { evaluator, imported, instances } = recordingEvaluator();
            const env = connectRealmPort(rp, { name: 'client', evaluator, prepare: ensureProcessShim });

            await env.import('src/index.ts');
            // the engine's boot order: the OS app imports a dependency by bare name AFTER user code did.
            const direct = await env.import('pkg');

            expect(new Set(imported).size).toBe(1);
            expect(instances.size).toBe(1);
            expect((direct.state as { fromEntry: boolean }).fromEntry).toBe(true);
            host.close();
        });

        it('without moduleUrl, dependencies are served through the runner as before', async () => {
            const host = createShakeupBundlerHost({ fs: editorFs(project), jsx: false, isUserModule: () => false });
            const [bp, rp] = portPair();
            host.connectRealm('client', bp);
            const { evaluator, imported } = recordingEvaluator();
            const env = connectRealmPort(rp, { name: 'client', evaluator, prepare: ensureProcessShim });

            await env.import('src/index.ts');

            expect(imported).toEqual([]);
            expect(host.server.moduleIds()).toContain('node_modules/pkg/index.js');
            host.close();
        });
    });
});
