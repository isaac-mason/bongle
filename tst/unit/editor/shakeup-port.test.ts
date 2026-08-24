import { createDevServer, type Fs } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { attachRealmPort, connectRealmPort, type RealmPort } from '../../../build/dev/shakeup-port';

// A simulated MessagePort pair: each side's postMessage delivers to the other's onmessage on a
// microtask (async, like a real port), so the transport's invoke/result round-trips are exercised.
function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

describe('shakeup realm port bridge', () => {
    it('a runner-side Environment fetches + evaluates a 2-module graph over a port', async () => {
        const files: Record<string, string> = {
            '/mod.ts': "import { base } from './base';\nexport const value = base + 2;",
            '/base.ts': 'export const base = 40;',
        };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({ fs });

        const [bundlerPort, runnerPort] = portPair();
        const attached = attachRealmPort(server, 'client', bundlerPort);
        const env = connectRealmPort(runnerPort, { name: 'client' });

        // import → fetchModule('/mod.ts') + '/base.ts' invoked over the port → transformed by the
        // dev server → evaluated in the env → live namespace.
        const ns = await env.import('/mod.ts');
        expect(ns.value).toBe(42);

        attached.close();
    });

    it('two realms share the one dev server: transform-once, independent instances', async () => {
        let transforms = 0;
        let reads = 0;
        const files: Record<string, string> = { '/counter.ts': 'export const n = 7;' };
        const fs: Fs = {
            read: (id) => {
                if (id === '/counter.ts') reads++;
                return files[id] ?? null;
            },
            exists: (id) => id in files,
        };
        // A transform hook runs only on a cache MISS — so it counts real transforms, not fetches.
        const countPlugin = { name: 'count', transform: () => void transforms++ } as const;
        const server = createDevServer({ fs, plugins: [countPlugin] });

        const [bpA, rpA] = portPair();
        const [bpB, rpB] = portPair();
        attachRealmPort(server, 'A', bpA);
        attachRealmPort(server, 'B', bpB);
        const envA = connectRealmPort(rpA, { name: 'A' });
        const envB = connectRealmPort(rpB, { name: 'B' });

        const [a, b] = [await envA.import('/counter.ts'), await envB.import('/counter.ts')];
        expect(a.n).toBe(7);
        expect(b.n).toBe(7);
        // Transform runs ONCE across both realms, AND the second realm serves from the known-clean
        // cache WITHOUT re-reading source (invalidate/handleChange are the change signal). So 1 read
        // + 1 transform serve 2 realms — each still evaluating its own instance.
        expect(transforms).toBe(1);
        expect(reads).toBe(1);
    });
});
