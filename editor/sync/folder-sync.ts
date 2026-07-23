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

import { consumeFolderSync, openDiskFolder, type SyncTarget, syncManaged } from '../../interface/editor';
import { seedEngineDist } from '../engine-dist';
import type { Filesystem, FsChange } from '../fs';
import { useSync } from '../stores/sync';

export type SyncDirection = 'editor-to-folder' | 'folder-to-editor';

const POLL_MS = 1000;

type Sig = { size: number; hash: number };

type Session = {
    fs: Filesystem;
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

/** standalone/top-level: pick a folder and start a live two-way sync. Must be
 *  called from a user gesture (the picker requires one). No-op if unsupported or
 *  the user cancels the picker. */
export async function connect(fs: Filesystem, direction: SyncDirection): Promise<void> {
    if (!syncSupported()) return;
    let handle: FileSystemDirectoryHandle;
    try {
        handle = await (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<FileSystemDirectoryHandle> })
            .showDirectoryPicker({ mode: 'readwrite' });
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
    if (!s) return;
    teardown(s);
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

/** editor wins: write the OPFS managed set out to disk, leaving unmanaged disk
 *  paths (node_modules, .git) untouched. */
async function reconcilePublish(s: Session): Promise<void> {
    const files = await s.fs.list('', { recursive: true });
    for (const f of files) {
        if (f.kind !== 'file' || !syncManaged(f.path)) continue;
        const bytes = await s.fs.read(f.path);
        const sig = sigOf(bytes);
        await s.disk.write(f.path, bytes);
        const st = await s.disk.stat(f.path);
        s.synced.set(f.path, sig);
        s.diskSig.set(f.path, { size: sig.size, mtime: st?.mtime ?? 0 });
    }
}

/** disk wins: mirror the folder's managed source into OPFS — writing what's on
 *  disk and deleting managed OPFS files absent from it — then re-seed the engine
 *  libs on top. Unmanaged paths (node_modules seeds, dist/resources bakes,
 *  src/generated barrels) are never read, written, or deleted, so an imported
 *  folder without them keeps them and still boots. */
async function reconcileImport(s: Session): Promise<void> {
    const entries = await s.disk.list(); // recursive, managed files only
    const onDisk = new Set<string>();
    for (const e of entries) {
        if (!syncManaged(e.path)) continue;
        onDisk.add(e.path);
        const bytes = await s.disk.read(e.path);
        const sig = sigOf(bytes);
        await s.fs.writeIfChanged(e.path, bytes);
        s.synced.set(e.path, sig);
        s.diskSig.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // disk is the source of truth: drop managed OPFS files the folder doesn't have.
    const files = await s.fs.list('', { recursive: true });
    for (const f of files) {
        if (f.kind !== 'file' || !syncManaged(f.path) || onDisk.has(f.path)) continue;
        await s.fs.remove(f.path);
    }
    await seedEngineDist(s.fs);
}

// ── live editor → disk ──────────────────────────────────────────────

async function pushEditorChanges(s: Session, changes: FsChange[]): Promise<void> {
    if (s.stopped) return;
    try {
        let moved = false;
        for (const c of changes) {
            if (!syncManaged(c.path)) continue;
            if (c.type === 'deleted') {
                await s.disk.remove(c.path);
                s.synced.delete(c.path);
                s.diskSig.delete(c.path);
                moved = true;
            } else {
                if (c.type === 'moved' && c.from && syncManaged(c.from)) {
                    await s.disk.remove(c.from);
                    s.synced.delete(c.from);
                    s.diskSig.delete(c.from);
                    moved = true;
                }
                if (await writeToDisk(s, c.path)) moved = true;
            }
        }
        if (moved) useSync.getState().tick();
    } catch (e) {
        useSync.getState().fail(errText(e));
    }
}

/** returns whether it actually wrote (false when the content matched `synced`,
 *  i.e. the change was an echo of a disk→editor apply). */
async function writeToDisk(s: Session, path: string): Promise<boolean> {
    const bytes = await s.fs.read(path);
    const sig = sigOf(bytes);
    if (sameSig(s.synced.get(path), sig)) return false; // echo of a disk→editor apply
    await s.disk.write(path, bytes);
    const st = await s.disk.stat(path);
    s.synced.set(path, sig);
    s.diskSig.set(path, { size: sig.size, mtime: st?.mtime ?? 0 });
    return true;
}

// ── live disk → editor ──────────────────────────────────────────────

async function pullDiskChanges(s: Session): Promise<void> {
    if (s.stopped || s.busy) return;
    s.busy = true;
    try {
        const entries = await s.disk.list(); // recursive, managed files only
        const present = new Set<string>();
        let moved = false;
        for (const e of entries) {
            if (!syncManaged(e.path)) continue;
            present.add(e.path);
            const prev = s.diskSig.get(e.path);
            if (prev && prev.size === e.size && prev.mtime === e.mtime) continue; // unchanged on disk
            const bytes = await s.disk.read(e.path);
            const sig = sigOf(bytes);
            s.diskSig.set(e.path, { size: e.size, mtime: e.mtime });
            if (sameSig(s.synced.get(e.path), sig)) continue; // our own write landing
            await s.fs.writeIfChanged(e.path, bytes); // fires editor watch → HMR / bake
            s.synced.set(e.path, sig);
            moved = true;
        }
        // files we were tracking that vanished from disk → delete from OPFS.
        for (const path of [...s.diskSig.keys()]) {
            if (present.has(path) || !syncManaged(path)) continue;
            s.diskSig.delete(path);
            s.synced.delete(path);
            await s.fs.remove(path);
            moved = true;
        }
        if (moved) useSync.getState().tick();
    } catch (e) {
        if (!s.stopped) useSync.getState().fail(errText(e));
    } finally {
        s.busy = false;
    }
}
