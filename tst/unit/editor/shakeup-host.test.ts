import type { Fs } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../../build/dev/shakeup-port';
import { browserEvaluator, ensureProcessShim, makeImportMeta } from '../../../build/dev/shakeup-runner-host';

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
});
