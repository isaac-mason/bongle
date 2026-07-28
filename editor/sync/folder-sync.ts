// editor/sync/folder-sync.ts — two-way mirror between the editor's OPFS working
// copy and a picked on-disk folder.
//
// Two entry points, one loop:
//   - connect()        standalone/top-level editor: the picker runs here, the disk
//                      folder is a local `openDiskFolder` SyncTarget.
//   - connectViaPort() embedded (cross-origin iframe): the iframe can't open the
//                      picker, so the host picks and serves the folder over a
//                      MessagePort; the editor drives it via `consumeFolderSync`.
// Either way the disk side is a `SyncTarget`, so the loop below is identical. The
// protocol + the browser disk backing live in the platform contract
// (interface/editor.ts) so the website host can serve it without reaching into here.
//
// Design (see llm/plan-sync-folder.md): one live session at a time. An initial
// reconcile seeds one side from the other (the direction the user picks), then
// both directions run live: editor edits push to disk via fs.watch, disk edits
// pull into OPFS via a poll. A per-path content-signature map (`synced`) is the
// loop-suppression oracle — a side only propagates a path whose live content
// differs from the last-reconciled signature, so a change crosses exactly once.
// A cheap size+mtime `diskSig` filter keeps the poll from re-reading unchanged
// files.

import { consumeFolderSync, openDiskFolder, type SyncTarget } from '../../interface/editor';
import { seedEngineDist } from '../engine-dist';
import type { Filesystem, FsChange } from '../fs';
import { IGNORED_DIRS } from '../ignored';
import { type SyncLogKind, useSync } from '../stores/sync';

export type SyncDirection = 'editor-to-folder' | 'folder-to-editor';

const POLL_MS = 1000;

type Sig = { size: number; hash: number };

type Session = {
    fs: Filesystem;
    /** picked folder's display name — for restoring the 'connected' status if a poll
     *  recovers after a transient failure. */
    folderName: string;
    /** the on-disk folder as a SyncTarget — local (openDiskFolder) when standalone,
     *  a port proxy to the host's handle when embedded. */
    disk: SyncTarget;
    /** content signature currently equal on both sides — the loop oracle. */
    synced: Map<string, Sig>;
    /** last-seen disk size+mtime, so the poll reads only files that moved. */
    diskSig: Map<string, { size: number; mtime: number }>;
    watch: { close(): void };
    poll: ReturnType<typeof setInterval> | null;
    stopped: boolean;
    /** a pull/push in flight, so ticks don't overlap. */
    busy: boolean;
    /** embedded only: the port to close and the host to notify on disconnect. */
    port: MessagePort | null;
    onStopped: (() => void) | null;
};

let session: Session | null = null;

export function syncSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// FNV-1a over the bytes; paired with size it's an ample change/identity check
// (not security). Cheap enough to run on every propagated file.
function hashBytes(b: Uint8Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) {
        h ^= b[i]!;
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
const sigOf = (b: Uint8Array): Sig => ({ size: b.length, hash: hashBytes(b) });
const sameSig = (a: Sig | undefined, b: Sig): boolean => !!a && a.size === b.size && a.hash === b.hash;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** append a line to the panel's activity log. Thin wrapper so the loop reads as
 *  `log('pull', ...)` and the store stays the single owner of the ring. */
const log = (kind: SyncLogKind, message: string): void => useSync.getState().log(kind, message);

/** node_modules (engine seed) + dist/resources (bake output) are EDITOR-OWNED derived
 *  trees. They're published editor→disk so an on-disk checkout has what external tooling
 *  needs (VS Code type acquisition, a resolvable resource tree), but they're strictly
 *  ONE-WAY: the editor re-seeds / re-bakes them, so we never import them from the target
 *  folder, never pull disk edits back, and never track them for loop-suppression.
 *  Publish writes them untracked, skipping files already on disk at the same size (the
 *  reconcile's slow path — node_modules alone is ~1k files). Matches ignored.ts. */
const isDerived = (path: string): boolean => path.split('/').some((seg) => (IGNORED_DIRS as readonly string[]).includes(seg));

/** run `fn` over items with a fixed pool of `concurrency` workers pulling from a shared
 *  cursor. A working copy holds thousands of files and sequential awaits are the slow
 *  path, so the per-file OPFS/disk latencies must overlap — but unlike a per-batch
 *  Promise.all barrier, a pool never stalls the whole group on its slowest file (no
 *  head-of-line blocking), keeping the disk saturated end to end. */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) await fn(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
const RECONCILE_CONCURRENCY = 32;

/** a per-file tick that logs a coarse "reconcile: N%" line every 20% of `total`, so a
 *  large seed shows steady progress in the panel without flooding it (5 lines, not 1k).
 *  Call the returned fn once per processed file. */
function reconcileProgress(total: number): () => void {
    let done = 0;
    let lastPct = 0;
    return () => {
        done++;
        const pct = total ? Math.floor((done / total) * 100) : 100;
        if (pct >= lastPct + 20) {
            lastPct = pct;
            log('info', `reconcile: ${pct}% (${done}/${total})`);
        }
    };
}

/** standalone/top-level: pick a folder and start a live two-way sync. Must be
 *  called from a user gesture (the picker requires one). No-op if unsupported or
 *  the user cancels the picker. */
export async function connect(fs: Filesystem, direction: SyncDirection): Promise<void> {
    if (!syncSupported()) return;
    let handle: FileSystemDirectoryHandle;
    try {
        handle = await (
            window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<FileSystemDirectoryHandle> }
        ).showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
        // AbortError is the user closing the picker — fall back to idle quietly.
        // Anything else is a real failure (e.g. Chromium blocks the picker inside
        // an iframe: "Cross origin sub frames aren't allowed to show a file
        // picker"); surface it instead of silently pretending it was a dismiss.
        if (e instanceof DOMException && e.name === 'AbortError') {
            useSync.getState().cancel();
            return;
        }
        console.error('[folder-sync] showDirectoryPicker failed', e);
        useSync.getState().fail(errText(e));
        return;
    }

    const perm = await (
        handle as unknown as { requestPermission?(o: { mode: string }): Promise<PermissionState> }
    ).requestPermission?.({ mode: 'readwrite' });
    if (perm && perm !== 'granted') {
        useSync.getState().fail('read/write permission was denied for that folder');
        return;
    }

    await startSession(fs, openDiskFolder(handle), direction, handle.name, { port: null, onStopped: null });
}

/** embedded: the host already picked a folder and serves it over `port`. Drive the
 *  same loop against the port-backed SyncTarget. `onStopped` tells the host to release
 *  the handle when the sync ends. */
export async function connectViaPort(
    fs: Filesystem,
    port: MessagePort,
    direction: SyncDirection,
    folderName: string,
    onStopped: () => void,
): Promise<void> {
    await startSession(fs, consumeFolderSync(port), direction, folderName, { port, onStopped });
}

async function startSession(
    fs: Filesystem,
    disk: SyncTarget,
    direction: SyncDirection,
    folderName: string,
    transport: { port: MessagePort | null; onStopped: (() => void) | null },
): Promise<void> {
    await disconnect();
    const s: Session = {
        fs,
        folderName,
        disk,
        synced: new Map(),
        diskSig: new Map(),
        watch: { close() {} },
        poll: null,
        stopped: false,
        busy: false,
        port: transport.port,
        onStopped: transport.onStopped,
    };
    session = s;
    useSync.getState().connecting(folderName);

    try {
        if (direction === 'editor-to-folder') await reconcilePublish(s);
        else await reconcileImport(s);
    } catch (e) {
        useSync.getState().fail(errText(e));
        teardown(s);
        return;
    }
    if (s.stopped) return;

    // editor → disk: every write through OPFS (this adds a second watcher
    // alongside main.tsx's HMR fan-out; both fire).
    s.watch = fs.watch((changes) => void pushEditorChanges(s, changes));
    // disk → editor: poll for external edits (VS Code, git, formatters).
    s.poll = setInterval(() => void pullDiskChanges(s), POLL_MS);

    useSync.getState().connected(folderName);
}

export async function disconnect(): Promise<void> {
    const s = session;
    if (s) teardown(s);
    // Always reset the store, even with no live session: a reconcile failure tears
    // the session down (session === null) but leaves the store in 'error', so the
    // "Stop syncing" button must still be able to clear it back to idle.
    useSync.getState().reset();
}

/** stop the loop and release the transport, without touching the store (callers
 *  set the appropriate phase). Notifies the host to release its handle when embedded. */
function teardown(s: Session): void {
    s.stopped = true;
    s.watch.close();
    if (s.poll !== null) clearInterval(s.poll);
    s.onStopped?.();
    s.port?.close();
    if (session === s) session = null;
}

// ── initial reconcile ───────────────────────────────────────────────

/** editor wins: write the entire OPFS project out to disk. */
async function reconcilePublish(s: Session): Promise<void> {
    const files = (await s.fs.list('', { recursive: true })).filter((f) => f.kind === 'file');
    log('info', `reconcile: publishing ${files.length} file${files.length === 1 ? '' : 's'} to the folder`);
    // one round-trip to learn what's already on disk, so a reconnect skips re-writing
    // the unchanged seed tree (node_modules is ~1k files — the reconcile's slow path).
    const diskSize = new Map<string, number>();
    for (const e of await s.disk.list()) diskSize.set(e.path, e.size);

    const progress = reconcileProgress(files.length);
    let wrote = 0;
    let skipped = 0;
    await runPool(files, RECONCILE_CONCURRENCY, async (f) => {
        try {
            if (isDerived(f.path)) {
                // one-way: write only when missing or a different size (bins are
                // content-hashed and the seed is stable, so size is a sufficient
                // change check), then forget it — no stat, no synced/diskSig, so the
                // live loop never pulls it back.
                if (diskSize.get(f.path) !== f.size) {
                    await s.disk.write(f.path, await s.fs.read(f.path));
                    wrote++;
                }
                return;
            }
            const bytes = await s.fs.read(f.path);
            const sig = sigOf(bytes);
            const st = await s.disk.write(f.path, bytes); // returns the post-write stat, no separate round trip
            s.synced.set(f.path, sig);
            s.diskSig.set(f.path, { size: sig.size, mtime: st?.mtime ?? 0 });
            wrote++;
        } catch (e) {
            // A name the disk FS rejects ("Name is not allowed") shouldn't abort the
            // whole publish — skip that file, seed the rest.
            skipped++;
            log('warn', `skipped ${f.path}: ${errText(e)}`);
            console.warn(`[folder-sync] skipped publish of ${f.path}:`, errText(e));
        } finally {
            progress();
        }
    });
    log('info', `reconcile complete: wrote ${wrote}${skipped ? `, skipped ${skipped}` : ''}`);
}

/** disk wins: mirror the whole folder into OPFS — writing what's on disk and
 *  deleting OPFS files absent from it — then re-seed the engine libs on top. */
async function reconcileImport(s: Session): Promise<void> {
    // never take the editor-owned derived trees (node_modules/dist/resources) from the
    // target folder — the editor re-seeds + re-bakes them itself.
    const entries = (await s.disk.list()).filter((e) => !isDerived(e.path));
    log('info', `reconcile: importing ${entries.length} file${entries.length === 1 ? '' : 's'} from the folder`);
    const onDisk = new Set(entries.map((e) => e.path));
    const progress = reconcileProgress(entries.length);
    let loaded = 0;
    let skipped = 0;
    await runPool(entries, RECONCILE_CONCURRENCY, async (e) => {
        try {
            const bytes = await s.disk.read(e.path);
            const sig = sigOf(bytes);
            await s.fs.writeIfChanged(e.path, bytes);
            s.synced.set(e.path, sig);
            s.diskSig.set(e.path, { size: e.size, mtime: e.mtime });
            loaded++;
        } catch (err) {
            skipped++;
            log('warn', `skipped ${e.path}: ${errText(err)}`);
            console.warn(`[folder-sync] skipped import of ${e.path}:`, errText(err));
        } finally {
            progress();
        }
    });
    // disk is the source of truth for SOURCE: drop OPFS source the folder lacks — but
    // never a derived tree (seedEngineDist owns node_modules and reseeds it just below;
    // the bake owns dist/resources).
    const files = await s.fs.list('', { recursive: true });
    let removed = 0;
    for (const f of files) {
        if (f.kind !== 'file' || isDerived(f.path) || onDisk.has(f.path)) continue;
        await s.fs.remove(f.path);
        removed++;
    }
    if (removed) log('info', `removed ${removed} editor file${removed === 1 ? '' : 's'} absent from the folder`);
    log('info', 'reconcile: reseeding engine libraries');
    await seedEngineDist(s.fs);
    log('info', `reconcile complete: loaded ${loaded}${skipped ? `, skipped ${skipped}` : ''}`);
}

// ── live editor → disk ──────────────────────────────────────────────

async function pushEditorChanges(s: Session, changes: FsChange[]): Promise<void> {
    if (s.stopped) return;
    let moved = false;
    // derived (bake/seed) writes are collapsed into one line per batch: they churn on
    // every bake and would drown the real source edits the log is there to show.
    let derived = 0;
    for (const c of changes) {
        try {
            if (c.type === 'deleted') {
                await s.disk.remove(c.path);
                s.synced.delete(c.path);
                s.diskSig.delete(c.path);
                if (!isDerived(c.path)) log('remove', `removed ${c.path} from the folder`);
                moved = true;
            } else {
                if (c.type === 'moved' && c.from) {
                    await s.disk.remove(c.from);
                    s.synced.delete(c.from);
                    s.diskSig.delete(c.from);
                    moved = true;
                }
                if (isDerived(c.path)) {
                    // one-way: keep the disk copy fresh as the bake regenerates it, but
                    // untracked — never pulled back, so it stays out of synced/diskSig
                    // (else the pull's vanished-sweep would delete it from OPFS).
                    await s.disk.write(c.path, await s.fs.read(c.path));
                    derived++;
                    moved = true;
                } else if (await writeToDisk(s, c.path)) {
                    log(
                        'push',
                        c.type === 'moved' && c.from
                            ? `moved ${c.from} to ${c.path} in the folder`
                            : `wrote ${c.path} to the folder`,
                    );
                    moved = true;
                }
            }
        } catch (e) {
            // One unwritable path (e.g. a name the disk FS rejects with "Name is not
            // allowed") must not tear the whole session down — skip it and keep
            // mirroring everything else. The stopped guard prevents an in-flight
            // write that rejects after disconnect from re-flagging the store.
            if (s.stopped) return;
            log('warn', `skipped ${c.path}: ${errText(e)}`);
            console.warn(`[folder-sync] skipped push of ${c.path}:`, errText(e));
        }
    }
    if (derived) log('push', `wrote ${derived} build output${derived === 1 ? '' : 's'} to the folder`);
    if (moved && !s.stopped) useSync.getState().tick();
}

/** returns whether it actually wrote (false when the content matched `synced`,
 *  i.e. the change was an echo of a disk→editor apply). */
async function writeToDisk(s: Session, path: string): Promise<boolean> {
    const bytes = await s.fs.read(path);
    const sig = sigOf(bytes);
    if (sameSig(s.synced.get(path), sig)) return false; // echo of a disk→editor apply
    const st = await s.disk.write(path, bytes); // returns the post-write stat, no separate round trip
    s.synced.set(path, sig);
    s.diskSig.set(path, { size: sig.size, mtime: st?.mtime ?? 0 });
    return true;
}

// ── live disk → editor ──────────────────────────────────────────────

async function pullDiskChanges(s: Session): Promise<void> {
    if (s.stopped || s.busy) return;
    s.busy = true;
    useSync.getState().polled(); // heartbeat: stamp each poll so the panel shows the loop is alive
    try {
        // never pull the editor-owned derived trees back from disk.
        const entries = (await s.disk.list()).filter((e) => !isDerived(e.path));
        const present = new Set<string>();
        let moved = false;
        for (const e of entries) {
            present.add(e.path);
            try {
                const prev = s.diskSig.get(e.path);
                if (prev && prev.size === e.size && prev.mtime === e.mtime) continue; // unchanged on disk
                const bytes = await s.disk.read(e.path);
                const sig = sigOf(bytes);
                s.diskSig.set(e.path, { size: e.size, mtime: e.mtime });
                if (sameSig(s.synced.get(e.path), sig)) continue; // our own write landing
                await s.fs.writeIfChanged(e.path, bytes); // fires editor watch → HMR / bake
                s.synced.set(e.path, sig);
                log('pull', `loaded ${e.path} from the folder`);
                moved = true;
            } catch (err) {
                // A single unreadable/unwritable path must not kill the poll — skip
                // it and keep the rest of the folder in sync.
                if (s.stopped) return;
                log('warn', `skipped ${e.path}: ${errText(err)}`);
                console.warn(`[folder-sync] skipped pull of ${e.path}:`, errText(err));
            }
        }
        // files we were tracking that vanished from disk → delete from OPFS.
        for (const path of [...s.diskSig.keys()]) {
            if (present.has(path)) continue;
            s.diskSig.delete(path);
            s.synced.delete(path);
            await s.fs.remove(path);
            log('remove', `removed ${path} (gone from the folder)`);
            moved = true;
        }
        if (moved && !s.stopped) useSync.getState().tick();
        // The poll keeps running after a fail() (unlike a reconcile fail, which tears
        // the session down), so a transient blip can leave the UI pinned to 'error'
        // while the loop silently heals. A poll that completes cleanly means the folder
        // is reachable again — restore 'connected' so the status stops lying.
        if (!s.stopped && useSync.getState().phase === 'error') useSync.getState().connected(s.folderName);
    } catch (e) {
        if (!s.stopped) useSync.getState().fail(errText(e));
    } finally {
        s.busy = false;
    }
}
