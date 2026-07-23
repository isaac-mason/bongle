// lib/editor/fs-idb.ts — IndexedDB-backed `Filesystem`: the fallback for contexts
// where OPFS is unavailable. Firefox denies OPFS in private windows and under
// strict storage settings but STILL provides IndexedDB there, so this keeps the
// editor bootable (and cloud-savable) where the OPFS working copy can't open.
//
// Same async `Filesystem` contract as fs-opfs.ts, so every consumer — the main
// thread plus the bundler / pipeline / server / build workers — runs unchanged
// once `openProjectFilesystem` (fs-open.ts) hands one back.
//
// Shape: an in-memory mirror (fast reads — exactly the createMemoryFilesystem
// model, with implicit dirs derived from paths) that write-throughs every mutation
// to an IndexedDB object store keyed by path. Cross-context coherence rides a
// per-project BroadcastChannel like the OPFS impl — but because our reads serve the
// mirror (IDB has no live cross-context read the way OPFS reads live off disk), a
// RECEIVED change refreshes the affected paths from IDB BEFORE firing watchers, so
// a consumer reacting to the change record reads fresh bytes. Eventually consistent
// between a write and a peer's refresh — the same tolerance remote-fs already
// relies on, and fine for a fallback.

import type { Filesystem, FilesystemSnapshot, FsChange, FsPath, FsStat } from './fs';

const STORE = 'files';
type Row = { bytes: Uint8Array; mtime: number };

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (d: Uint8Array | string): Uint8Array => (typeof d === 'string' ? enc.encode(d) : d);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const normalize = (p: FsPath): FsPath => p.replace(/^\/+/, '').replace(/\/+$/, '');
const inDir = (path: FsPath, dir: FsPath): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`);

function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function openDb(projectName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(`bongle-fs:${projectName}`, 1);
        open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('[fs-idb] open blocked by another connection'));
    });
}

/** Open an IndexedDB-backed `Filesystem` for `projectName`. Throws if IndexedDB
 *  itself is unavailable (fully blocked storage) — the caller owns the fallback. */
export async function openIdbFilesystem(projectName: string): Promise<Filesystem> {
    if (typeof indexedDB === 'undefined') throw new Error('[fs-idb] IndexedDB unavailable');
    const db = await openDb(projectName);
    // Load the whole tree into the mirror up front — projects are small and the
    // bundler/pipeline read many files, so a per-read IDB txn each would crawl.
    const files = new Map<FsPath, Row>();
    await new Promise<void>((resolve, reject) => {
        const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) return resolve();
            files.set(String(c.key), c.value as Row);
            c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
    });
    return new IdbFilesystem(db, projectName, files);
}

class IdbFilesystem implements Filesystem {
    private watchers = new Set<(changes: FsChange[]) => void>();
    private channel: BroadcastChannel | null = null;

    constructor(
        private db: IDBDatabase,
        projectName: string,
        private files: Map<FsPath, Row>,
    ) {
        if (typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel(`bongle-fs:${projectName}`);
            this.channel.onmessage = (e: MessageEvent) => void this.receiveRemote(e.data as FsChange[]);
        }
    }

    private get(path: FsPath): Promise<Row | undefined> {
        return req(this.db.transaction(STORE, 'readonly').objectStore(STORE).get(path)) as Promise<Row | undefined>;
    }

    private async put(path: FsPath, row: Row): Promise<void> {
        const tx = this.db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row, path);
        await txDone(tx);
    }

    // local mutation: notify our watchers, then mirror to the other contexts. IDB is
    // written through by the caller BEFORE this, so a peer that refreshes on the
    // broadcast reads the committed bytes.
    private emit(changes: FsChange[]): void {
        if (changes.length === 0) return;
        for (const cb of this.watchers) cb(changes);
        this.channel?.postMessage(changes);
    }

    // a mutation from another context: refresh the mirror from IDB for the affected
    // paths FIRST (so a consumer reading in response sees fresh bytes), then notify.
    // Never re-broadcast, or two instances ping-pong forever.
    private async receiveRemote(changes: FsChange[]): Promise<void> {
        if (!changes?.length) return;
        for (const c of changes) {
            const path = normalize(c.path);
            if (c.type === 'deleted') {
                this.files.delete(path);
                continue;
            }
            if (c.type === 'moved' && c.from) this.files.delete(normalize(c.from));
            const row = await this.get(path);
            if (row) this.files.set(path, row);
            else this.files.delete(path);
        }
        for (const cb of this.watchers) cb(changes);
    }

    private statOf(path: FsPath): FsStat | null {
        const f = this.files.get(path);
        if (f) return { path, kind: 'file', size: f.bytes.length, mtime: f.mtime };
        for (const p of this.files.keys()) if (p.startsWith(`${path}/`)) return { path, kind: 'dir', size: 0, mtime: 0 };
        return null;
    }

    async read(path: FsPath): Promise<Uint8Array> {
        const f = this.files.get(normalize(path));
        if (!f) throw new Error(`[fs] missing: ${path}`);
        return f.bytes;
    }

    async readText(path: FsPath): Promise<string> {
        const f = this.files.get(normalize(path));
        if (!f) throw new Error(`[fs] missing: ${path}`);
        return dec.decode(f.bytes);
    }

    async stat(path: FsPath): Promise<FsStat | null> {
        return this.statOf(normalize(path));
    }

    async list(dir: FsPath = '', opts?: { recursive?: boolean }): Promise<FsStat[]> {
        const d = normalize(dir);
        const out: FsStat[] = [];
        const seenDirs = new Set<FsPath>();
        for (const [p, f] of this.files) {
            if (!inDir(p, d) || p === d) continue;
            const rest = d === '' ? p : p.slice(d.length + 1);
            const slash = rest.indexOf('/');
            if (opts?.recursive || slash === -1) out.push({ path: p, kind: 'file', size: f.bytes.length, mtime: f.mtime });
            if (slash !== -1) {
                const child = d === '' ? rest.slice(0, slash) : `${d}/${rest.slice(0, slash)}`;
                if (!seenDirs.has(child)) {
                    seenDirs.add(child);
                    out.push({ path: child, kind: 'dir', size: 0, mtime: 0 });
                }
            }
        }
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    async readDir(dir: FsPath = ''): Promise<Map<string, 'file' | 'dir'>> {
        const d = normalize(dir);
        const out = new Map<string, 'file' | 'dir'>();
        for (const p of this.files.keys()) {
            if (!inDir(p, d) || p === d) continue;
            const rest = d === '' ? p : p.slice(d.length + 1);
            const slash = rest.indexOf('/');
            out.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'dir');
        }
        return out;
    }

    async exists(path: FsPath): Promise<boolean> {
        return this.statOf(normalize(path)) !== null;
    }

    async write(path: FsPath, data: Uint8Array | string): Promise<void> {
        const p = normalize(path);
        const existed = this.files.has(p);
        const row = { bytes: toBytes(data), mtime: Date.now() };
        this.files.set(p, row);
        await this.put(p, row);
        this.emit([{ type: existed ? 'modified' : 'created', path: p }]);
    }

    async writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean> {
        const p = normalize(path);
        const next = toBytes(data);
        const existing = this.files.get(p);
        if (existing && sameBytes(existing.bytes, next)) return false;
        const row = { bytes: next, mtime: Date.now() };
        this.files.set(p, row);
        await this.put(p, row);
        this.emit([{ type: existing ? 'modified' : 'created', path: p }]);
        return true;
    }

    async remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void> {
        const p = normalize(path);
        const changes: FsChange[] = [];
        const gone: FsPath[] = [];
        if (this.files.delete(p)) {
            changes.push({ type: 'deleted', path: p });
            gone.push(p);
        }
        if (opts?.recursive) {
            for (const key of Array.from(this.files.keys())) {
                if (key.startsWith(`${p}/`)) {
                    this.files.delete(key);
                    changes.push({ type: 'deleted', path: key });
                    gone.push(key);
                }
            }
        }
        if (gone.length) {
            const tx = this.db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const g of gone) store.delete(g);
            await txDone(tx);
        }
        this.emit(changes);
    }

    async move(from: FsPath, to: FsPath): Promise<void> {
        const f = normalize(from);
        const t = normalize(to);
        const changes: FsChange[] = [];
        const writes: Array<[FsPath, Row]> = [];
        const gone: FsPath[] = [];
        const direct = this.files.get(f);
        if (direct) {
            this.files.delete(f);
            this.files.set(t, direct);
            writes.push([t, direct]);
            gone.push(f);
            changes.push({ type: 'moved', path: t, from: f });
        } else {
            for (const key of Array.from(this.files.keys())) {
                if (!key.startsWith(`${f}/`)) continue;
                const dest = `${t}/${key.slice(f.length + 1)}`;
                const row = this.files.get(key)!;
                this.files.set(dest, row);
                this.files.delete(key);
                writes.push([dest, row]);
                gone.push(key);
                changes.push({ type: 'moved', path: dest, from: key });
            }
        }
        if (writes.length || gone.length) {
            const tx = this.db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const [p, row] of writes) store.put(row, p);
            for (const g of gone) store.delete(g);
            await txDone(tx);
        }
        this.emit(changes);
    }

    watch(cb: (changes: FsChange[]) => void): { close(): void } {
        this.watchers.add(cb);
        return { close: () => this.watchers.delete(cb) };
    }

    async snapshot(dir: FsPath = ''): Promise<FilesystemSnapshot> {
        const d = normalize(dir);
        const frozen = new Map<FsPath, Uint8Array>();
        for (const [p, f] of this.files) {
            if (!inDir(p, d)) continue;
            const rel = d === '' ? p : p.slice(d.length + 1);
            frozen.set(rel, f.bytes.slice());
        }
        return {
            read(path) {
                const bytes = frozen.get(normalize(path));
                if (!bytes) throw new Error(`[fs snapshot] missing: ${path}`);
                return bytes;
            },
            readText(path) {
                const bytes = frozen.get(normalize(path));
                if (!bytes) throw new Error(`[fs snapshot] missing: ${path}`);
                return dec.decode(bytes);
            },
            exists(path) {
                return frozen.has(normalize(path));
            },
            list() {
                return Array.from(frozen.keys()).sort();
            },
        };
    }
}
