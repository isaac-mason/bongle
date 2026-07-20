// editor/net/remote-fs.ts — the guest's read/write Filesystem over the relay, and
// the host responder that serves it from real OPFS.
//
// A guest tab has no shared OPFS; it works THROUGH to the host on demand — each fs
// op is ONE packcat-framed binary message over the fsrpc channel, the host applies
// it to its authoritative Filesystem and replies. Writes are allowed: multiplayer
// editing is last-writer-wins (the host OPFS is the single source of truth; a guest
// write triggers the host's watch → HMR + fanout to every participant).
//
// One self-describing frame per message (request / response / change push), so file
// bytes ride inline with no base64/JSON tax and no id-prefix framing to hand-roll —
// the same codec the engine net layer uses (packcat, see core/net.ts). It rides both
// a relay PortLike (guest↔host) and a plain MessageChannel (the local iframe proxy),
// since either delivers the packed Uint8Array intact.

import * as pack from 'packcat';
import type { PortLike } from '../../build';
import type { Filesystem, FilesystemSnapshot, FsChange, FsStat } from '../fs';

// ── wire protocol (packcat) ─────────────────────────────────────────
// `kind` / change `type` ride as strings (host-controlled enums, cold paths) and
// are cast back on the guest — cheaper in code than fighting enum-tuple typing.
const statSchema = pack.object({
    path: pack.string(),
    kind: pack.string(),
    size: pack.float64(),
    mtime: pack.float64(),
});
const dirEntry = pack.object({ name: pack.string(), kind: pack.string() });
const changeSchema = pack.object({ type: pack.string(), path: pack.string(), from: pack.optional(pack.string()) });
// write payload: text inline, or raw bytes inline (tax-free).
const writeData = pack.union('d', [
    pack.object({ d: pack.literal('text'), text: pack.string() }),
    pack.object({ d: pack.literal('bin'), bytes: pack.uint8Array() }),
]);

const codec = pack.build(
    pack.union('t', [
        // requests (guest → host)
        pack.object({ t: pack.literal('read'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('readText'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('stat'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('list'), id: pack.uint32(), path: pack.string(), recursive: pack.boolean() }),
        pack.object({ t: pack.literal('readDir'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('exists'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('write'), id: pack.uint32(), path: pack.string(), data: writeData }),
        pack.object({ t: pack.literal('writeIfChanged'), id: pack.uint32(), path: pack.string(), data: writeData }),
        pack.object({ t: pack.literal('remove'), id: pack.uint32(), path: pack.string(), recursive: pack.boolean() }),
        pack.object({ t: pack.literal('move'), id: pack.uint32(), from: pack.string(), to: pack.string() }),
        // responses (host → guest)
        pack.object({ t: pack.literal('ok:bytes'), id: pack.uint32(), bytes: pack.uint8Array() }),
        pack.object({ t: pack.literal('ok:text'), id: pack.uint32(), text: pack.string() }),
        pack.object({ t: pack.literal('ok:stat'), id: pack.uint32(), stat: pack.nullable(statSchema) }),
        pack.object({ t: pack.literal('ok:list'), id: pack.uint32(), entries: pack.list(statSchema) }),
        pack.object({ t: pack.literal('ok:dir'), id: pack.uint32(), entries: pack.list(dirEntry) }),
        pack.object({ t: pack.literal('ok:bool'), id: pack.uint32(), value: pack.boolean() }),
        pack.object({ t: pack.literal('ok:void'), id: pack.uint32() }),
        pack.object({ t: pack.literal('err'), id: pack.uint32(), error: pack.string() }),
        // change push (host → guest)
        pack.object({ t: pack.literal('change'), changes: pack.list(changeSchema) }),
    ]),
);

type Frame = ReturnType<typeof codec.unpack>;

/** wire form of a write's payload — string inline, or raw bytes inline (tax-free). */
const dataFrame = (data: Uint8Array | string) =>
    typeof data === 'string' ? ({ d: 'text', text: data } as const) : ({ d: 'bin', bytes: data } as const);

// ── chunking ────────────────────────────────────────────────────────
// The fsrpc lane carries whole files, so a packed frame can dwarf the few MB a
// single relay frame allows. Split an oversized packed frame into ordered `part`s
// and reassemble before unpack. The game lane does the same (core/net.ts), but its
// splitter is coupled to the game message-list shape, so fsrpc gets its own.
//
// Single-buffer reassembly is safe because sendFramed emits ALL parts of one frame
// synchronously (no await between posts), so on a reliable, ordered transport two
// frames never interleave — a `part` sequence is always contiguous.
const CHUNK = 1 << 20; // 1 MiB — comfortably under the relay's frame budget
const MAX_REASSEMBLY = 512 * 1024 * 1024; // guard vs a peer claiming an absurd total

const transport = pack.build(
    pack.union('k', [
        pack.object({ k: pack.literal('whole'), body: pack.uint8Array() }),
        pack.object({ k: pack.literal('part'), offset: pack.uint32(), total: pack.uint32(), body: pack.uint8Array() }),
    ]),
);

/** send a packed frame, splitting into ordered parts if it exceeds one chunk. */
function sendFramed(port: PortLike, packed: Uint8Array): void {
    if (packed.byteLength <= CHUNK) {
        port.postMessage(transport.pack({ k: 'whole', body: packed }));
        return;
    }
    for (let offset = 0; offset < packed.byteLength; offset += CHUNK) {
        const body = packed.subarray(offset, Math.min(offset + CHUNK, packed.byteLength));
        port.postMessage(transport.pack({ k: 'part', offset, total: packed.byteLength, body }));
    }
}

/** a per-port reassembly buffer: feed it raw frames, it calls `deliver` with each
 *  complete packed frame. Relies on ordered delivery (reliable socket / channel). */
function framedReceiver(deliver: (packed: Uint8Array) => void): (raw: Uint8Array) => void {
    let buf: Uint8Array | null = null;
    return (raw) => {
        const f = transport.unpack(raw);
        if (f.k === 'whole') return deliver(f.body);
        if (f.total > MAX_REASSEMBLY) throw new Error(`[remote-fs] reassembly total ${f.total} too large`);
        if (f.offset === 0) buf = new Uint8Array(f.total);
        if (!buf || f.offset + f.body.byteLength > buf.byteLength) return; // desync — drop
        buf.set(f.body, f.offset);
        if (f.offset + f.body.byteLength >= buf.byteLength) {
            const complete = buf;
            buf = null;
            deliver(complete);
        }
    };
}

// ── guest: read/write Filesystem over the relay ─────────────────────

/** A `Filesystem` whose ops RPC to the host over `port`. Reads/lists return the
 *  host's authoritative tree; writes/removes/moves apply to it (last-writer-wins,
 *  no merge). The apps/FileTree/Monaco read + write it unaware they're on a relay. */
export function createRemoteFilesystem(port: PortLike): Filesystem {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const watchers = new Set<(changes: FsChange[]) => void>();
    let nextId = 1;

    const onFrame = framedReceiver((packed) => {
        const msg = codec.unpack(packed);
        if (msg.t === 'change') {
            for (const cb of watchers) cb(msg.changes as FsChange[]);
            return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.t === 'err') p.reject(new Error(msg.error));
        else p.resolve(resultOf(msg));
    });
    port.onmessage = (e) => onFrame(e.data as Uint8Array);

    const call = <T>(build: (id: number) => Frame): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            sendFramed(port, codec.pack(build(id)));
        });

    return {
        read: (path) => call<Uint8Array>((id) => ({ t: 'read', id, path })),
        readText: (path) => call<string>((id) => ({ t: 'readText', id, path })),
        stat: (path) => call<FsStat | null>((id) => ({ t: 'stat', id, path })),
        list: (dir, opts) => call<FsStat[]>((id) => ({ t: 'list', id, path: dir ?? '', recursive: opts?.recursive ?? false })),
        readDir: (dir) => call<Map<string, 'file' | 'dir'>>((id) => ({ t: 'readDir', id, path: dir ?? '' })),
        exists: (path) => call<boolean>((id) => ({ t: 'exists', id, path })),
        write: (path, data) => call<void>((id) => ({ t: 'write', id, path, data: dataFrame(data) })),
        writeIfChanged: (path, data) => call<boolean>((id) => ({ t: 'writeIfChanged', id, path, data: dataFrame(data) })),
        remove: (path, opts) => call<void>((id) => ({ t: 'remove', id, path, recursive: opts?.recursive ?? false })),
        move: (from, to) => call<void>((id) => ({ t: 'move', id, from, to })),
        watch(cb) {
            watchers.add(cb);
            return { close: () => watchers.delete(cb) };
        },
        // a guest runs no pipeline, so no one materializes a sync snapshot; if that
        // changes, snapshot would fetch the subtree over RPC.
        snapshot(): Promise<FilesystemSnapshot> {
            return Promise.reject(new Error('[remote-fs] snapshot is not supported on a guest replica'));
        },
    };
}

/** unwrap a response frame to the value the matching call() resolves with. */
function resultOf(msg: Frame): unknown {
    switch (msg.t) {
        case 'ok:bytes':
            return msg.bytes;
        case 'ok:text':
            return msg.text;
        case 'ok:stat':
            return msg.stat as FsStat | null;
        case 'ok:list':
            return msg.entries as FsStat[];
        case 'ok:dir':
            return new Map(msg.entries.map((e) => [e.name, e.kind as 'file' | 'dir'] as const));
        case 'ok:bool':
            return msg.value;
        default:
            return undefined; // ok:void
    }
}

// ── host: serve a Filesystem over the fsrpc port ────────────────────

/** Answer a guest's fs RPCs from `fs` (the host's authoritative Filesystem) and
 *  push its change stream so the guest's watch fires. Returns a handle to detach on
 *  guest-leave. `fs` can be OPFS (host serving the relay) or itself a remote fs (a
 *  guest serving its play iframe a local port). */
export function serveFilesystemOverPort(fs: Filesystem, port: PortLike): { close(): void } {
    const reply = (msg: Frame) => sendFramed(port, codec.pack(msg));

    const onFrame = framedReceiver((packed) => void handle(codec.unpack(packed)));
    port.onmessage = (e) => onFrame(e.data as Uint8Array);

    async function handle(req: Frame): Promise<void> {
        if (req.t === 'change') return; // change/response frames never arrive host-side
        const id = req.id;
        try {
            switch (req.t) {
                case 'read':
                    return reply({ t: 'ok:bytes', id, bytes: await fs.read(req.path) });
                case 'readText':
                    return reply({ t: 'ok:text', id, text: await fs.readText(req.path) });
                case 'stat':
                    return reply({ t: 'ok:stat', id, stat: await fs.stat(req.path) });
                case 'list':
                    return reply({ t: 'ok:list', id, entries: await fs.list(req.path, { recursive: req.recursive }) });
                case 'readDir': {
                    const map = await fs.readDir(req.path);
                    return reply({ t: 'ok:dir', id, entries: [...map].map(([name, kind]) => ({ name, kind })) });
                }
                case 'exists':
                    return reply({ t: 'ok:bool', id, value: await fs.exists(req.path) });
                case 'write':
                    await fs.write(req.path, req.data.d === 'text' ? req.data.text : req.data.bytes);
                    return reply({ t: 'ok:void', id });
                case 'writeIfChanged':
                    return reply({
                        t: 'ok:bool',
                        id,
                        value: await fs.writeIfChanged(req.path, req.data.d === 'text' ? req.data.text : req.data.bytes),
                    });
                case 'remove':
                    await fs.remove(req.path, { recursive: req.recursive });
                    return reply({ t: 'ok:void', id });
                case 'move':
                    await fs.move(req.from, req.to);
                    return reply({ t: 'ok:void', id });
                default:
                    return; // a response frame reaching the host — ignore
            }
        } catch (err) {
            reply({ t: 'err', id, error: err instanceof Error ? err.message : String(err) });
        }
    }

    // push the host's change stream so guest watchers (FileTree/Monaco/resource
    // refresh) fire — source edits included; the guest applies what it cares about.
    // Map to the wire shape so optional `from` is present (undefined when absent).
    const watch = fs.watch((changes) =>
        reply({ t: 'change', changes: changes.map((c) => ({ type: c.type, path: c.path, from: c.from })) }),
    );
    return { close: () => watch.close() };
}
