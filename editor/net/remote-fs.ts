// editor/net/remote-fs.ts — the guest's read-through Filesystem over the relay,
// and the host responder that serves it from real OPFS.
//
// A guest tab has no shared OPFS (it's in another browser), but its client
// iframe reads project files — baked `resources/`, `content/scenes/`,
// `node_modules/bongle/dist/bongle.css`, builtin `file:` assets. Instead of
// replicating the whole tree (the design doc's heavier option), the guest reads
// THROUGH to the host on demand: each read/list/stat is an RPC over the fsrpc
// channel; the host answers from its authoritative Filesystem. Guests never
// write — edit authority stays with the host (design-multiplayer-editing.md §5),
// so the write half of the contract throws.
//
// Protocol over one PortLike (relay fsrpc channel):
//   guest → host : { __fsrpc:'req', id, op, args }              (JSON)
//   host → guest : { __fsrpc:'res', id, ok:true, value }        (JSON, small results)
//                  { __fsrpc:'res', id, ok:false, error }       (JSON)
//                  [u32 id][...bytes]                            (BINARY — read() payloads)
//                  { __fsrpc:'change', changes }                (JSON push — drives watch)
// read() bytes ride raw binary (id in a 4-byte prefix) so a multi-MB atlas
// doesn't pay a base64/JSON tax; everything else is JSON.

import type { Filesystem, FilesystemSnapshot, FsChange, FsPath, FsStat } from '../fs';
import type { PortLike } from '../../build';

type ReqFrame = { __fsrpc: 'req'; id: number; op: string; args: unknown[] };
type ResFrame = { __fsrpc: 'res'; id: number; ok: true; value: unknown } | { __fsrpc: 'res'; id: number; ok: false; error: string };
type ChangeFrame = { __fsrpc: 'change'; changes: FsChange[] };

function isUint8Array(v: unknown): v is Uint8Array {
    return v instanceof Uint8Array;
}

// ── guest: read-through Filesystem ──────────────────────────────────

const READ_ONLY = '[remote-fs] guest editor filesystem is read-only';

/** A `Filesystem` whose reads RPC to the host over `port`. Writes throw — a
 *  guest never mutates the authoritative tree. The pipeline/module-host/loaders
 *  read it unaware they're on a replica. */
export function createRemoteFilesystem(port: PortLike): Filesystem {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const watchers = new Set<(changes: FsChange[]) => void>();
    let nextId = 1;

    port.onmessage = (e) => {
        const data = e.data;
        if (isUint8Array(data)) {
            // read() payload: [u32 id][bytes].
            if (data.byteLength < 4) return;
            const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
            pending.get(id)?.resolve(data.slice(4));
            pending.delete(id);
            return;
        }
        const msg = data as ResFrame | ChangeFrame;
        if (msg.__fsrpc === 'change') {
            for (const cb of watchers) cb(msg.changes);
            return;
        }
        if (msg.__fsrpc === 'res') {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.value);
            else p.reject(new Error(msg.error));
        }
    };

    const call = <T>(op: string, ...args: unknown[]): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            port.postMessage({ __fsrpc: 'req', id, op, args } satisfies ReqFrame);
        });

    return {
        read: (path) => call<Uint8Array>('read', path),
        readText: (path) => call<string>('readText', path),
        stat: (path) => call<FsStat | null>('stat', path),
        list: (dir, opts) => call<FsStat[]>('list', dir ?? '', opts ?? {}),
        readDir: (dir) => call<Map<string, 'file' | 'dir'>>('readDir', dir ?? ''),
        exists: (path) => call<boolean>('exists', path),
        write: () => Promise.reject(new Error(READ_ONLY)),
        writeIfChanged: () => Promise.reject(new Error(READ_ONLY)),
        remove: () => Promise.reject(new Error(READ_ONLY)),
        move: () => Promise.reject(new Error(READ_ONLY)),
        watch(cb) {
            watchers.add(cb);
            return { close: () => watchers.delete(cb) };
        },
        // a guest runs no pipeline, so no one materializes a sync snapshot; if
        // that changes, snapshot would fetch the subtree over RPC.
        snapshot(): Promise<FilesystemSnapshot> {
            return Promise.reject(new Error('[remote-fs] snapshot is not supported on a guest replica'));
        },
    };
}

// ── host: serve a Filesystem over the fsrpc port ────────────────────

/** Answer a guest's read-through RPCs from `fs` (the host's authoritative
 *  Filesystem), and push its change stream so the guest's watch fires. Returns a
 *  handle to detach on guest-leave. */
export function serveFilesystemOverPort(fs: Filesystem, port: PortLike): { close(): void } {
    const respondBytes = (id: number, bytes: Uint8Array) => {
        const out = new Uint8Array(4 + bytes.byteLength);
        new DataView(out.buffer).setUint32(0, id);
        out.set(bytes, 4);
        port.postMessage(out);
    };
    const respond = (id: number, value: unknown) => port.postMessage({ __fsrpc: 'res', id, ok: true, value } satisfies ResFrame);
    const respondError = (id: number, error: string) =>
        port.postMessage({ __fsrpc: 'res', id, ok: false, error } satisfies ResFrame);

    port.onmessage = (e) => {
        const msg = e.data as ReqFrame;
        if (msg?.__fsrpc !== 'req') return;
        void handle(msg);
    };

    async function handle(req: ReqFrame): Promise<void> {
        const [a, b] = req.args as [FsPath, unknown];
        try {
            switch (req.op) {
                case 'read':
                    return respondBytes(req.id, await fs.read(a));
                case 'readText':
                    return respond(req.id, await fs.readText(a));
                case 'stat':
                    return respond(req.id, await fs.stat(a));
                case 'list':
                    return respond(req.id, await fs.list(a, b as { recursive?: boolean } | undefined));
                case 'readDir':
                    return respond(req.id, await fs.readDir(a));
                case 'exists':
                    return respond(req.id, await fs.exists(a));
                default:
                    return respondError(req.id, `unknown op: ${req.op}`);
            }
        } catch (err) {
            respondError(req.id, err instanceof Error ? err.message : String(err));
        }
    }

    // push the host's change stream so guest watchers (resource/scene refresh)
    // fire. Not filtered: source edits also flow, but the guest's client ignores
    // non-resource/scene paths (HMR handles source over the bundler lane).
    const handle2 = fs.watch((changes) => port.postMessage({ __fsrpc: 'change', changes } satisfies ChangeFrame));

    return { close: () => handle2.close() };
}
