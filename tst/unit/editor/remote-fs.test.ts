// Read-through remote fs: a guest's createRemoteFilesystem RPCs to a host's
// serveFilesystemOverPort backed by a real (in-memory) Filesystem. Reads round
// trip; writes throw; host changes push to the guest's watch.

import { describe, expect, it } from 'vitest';
import { createMemoryFilesystem } from '../../../editor/fs';
import type { PortLike } from '../../../build';
import { createRemoteFilesystem, serveFilesystemOverPort } from '../../../editor/net/remote-fs';

/** two PortLikes cross-wired like a MessageChannel (async delivery). */
function portPair(): [PortLike, PortLike] {
    const a: PortLike = { onmessage: null, postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), close() {} };
    const b: PortLike = { onmessage: null, postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), close() {} };
    return [a, b];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function connect(initial?: Record<string, Uint8Array | string>) {
    const hostFs = createMemoryFilesystem(initial);
    const [hostPort, guestPort] = portPair();
    const handle = serveFilesystemOverPort(hostFs, hostPort);
    const guestFs = createRemoteFilesystem(guestPort);
    return { hostFs, guestFs, handle };
}

describe('remote fs', () => {
    it('reads bytes through to the host (binary payload)', async () => {
        const { guestFs } = connect({ 'resources/client/atlas.png': new Uint8Array([137, 80, 78, 71]) });
        const bytes = await guestFs.read('resources/client/atlas.png');
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect([...bytes]).toEqual([137, 80, 78, 71]);
    });

    it('reads text, stat, list, exists through to the host', async () => {
        const { guestFs } = connect({
            'content/scenes/main.scene.json': '{"nodes":[]}',
            'content/scenes/other.scene.json': '{}',
        });
        expect(await guestFs.readText('content/scenes/main.scene.json')).toBe('{"nodes":[]}');
        expect(await guestFs.exists('content/scenes/main.scene.json')).toBe(true);
        expect(await guestFs.exists('nope')).toBe(false);
        const stat = await guestFs.stat('content/scenes/other.scene.json');
        expect(stat?.kind).toBe('file');
        const list = await guestFs.list('content/scenes', { recursive: true });
        expect(list.filter((e) => e.kind === 'file').map((e) => e.path).sort()).toEqual([
            'content/scenes/main.scene.json',
            'content/scenes/other.scene.json',
        ]);
    });

    it('rejects a read of a missing file with the host error', async () => {
        const { guestFs } = connect();
        await expect(guestFs.read('missing')).rejects.toThrow(/missing/);
    });

    it('is read-only — writes throw', async () => {
        const { guestFs } = connect();
        await expect(guestFs.write('x', 'y')).rejects.toThrow(/read-only/);
        await expect(guestFs.writeIfChanged('x', 'y')).rejects.toThrow(/read-only/);
        await expect(guestFs.remove('x')).rejects.toThrow(/read-only/);
        await expect(guestFs.move('x', 'y')).rejects.toThrow(/read-only/);
    });

    it('pushes host fs changes to the guest watch', async () => {
        const { hostFs, guestFs } = connect();
        const seen: string[] = [];
        guestFs.watch((changes) => {
            for (const c of changes) seen.push(`${c.type}:${c.path}`);
        });
        await hostFs.write('resources/client/atlas.png', new Uint8Array([1]));
        await flush();
        expect(seen).toContain('created:resources/client/atlas.png');
    });

    it('concurrent reads correlate by id (binary payloads not mixed up)', async () => {
        const { guestFs } = connect({ a: new Uint8Array([1]), b: new Uint8Array([2, 2]), c: new Uint8Array([3, 3, 3]) });
        const [a, b, c] = await Promise.all([guestFs.read('a'), guestFs.read('b'), guestFs.read('c')]);
        expect([...a]).toEqual([1]);
        expect([...b]).toEqual([2, 2]);
        expect([...c]).toEqual([3, 3, 3]);
    });
});
