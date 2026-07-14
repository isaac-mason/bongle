// editor/sync/folder-sync.ts — two-way mirror between the editor's OPFS working
// copy and a picked on-disk folder (Chromium File System Access API).
//
// Design (see llm/plan-sync-folder.md): one live session at a time. An initial
// reconcile seeds one side from the other (the direction the user picks), then
// both directions run live: editor edits push to disk via fs.watch, disk edits
// pull into OPFS via a poll. A per-path content-signature map (`synced`) is the
// loop-suppression oracle — a side only propagates a path whose live content
// differs from the last-reconciled signature, so a change crosses exactly once.
// A cheap size+mtime `diskSig` filter keeps the poll from re-reading unchanged
// files.

import { seedEngineDist } from '../engine-dist';
import type { Filesystem, FsChange } from '../fs';
import { useSync } from '../stores/sync';
import { type DiskMirror, openDiskMirror } from './disk-mirror';
import { syncManaged } from './policy';

export type SyncDirection = 'publish' | 'import';

const POLL_MS = 1000;

type Sig = { size: number; hash: number };

type Session = {
    fs: Filesystem;
    mirror: DiskMirror;
    /** content signature currently equal on both sides — the loop oracle. */
    synced: Map<string, Sig>;
    /** last-seen disk size+mtime, so the poll reads only files that moved. */
    diskSig: Map<string, { size: number; mtime: number }>;
    watch: { close(): void };
    poll: ReturnType<typeof setInterval> | null;
    stopped: boolean;
    /** a pull/push in flight, so ticks don't overlap. */
    busy: boolean;
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

/** pick a folder and start a live two-way sync, seeding via `direction`. Must be
 *  called from a user gesture (the picker requires one). No-op if unsupported or
 *  the user cancels the picker. */
export async function connect(fs: Filesystem, direction: SyncDirection): Promise<void> {
    if (!syncSupported()) return;
    let handle: FileSystemDirectoryHandle;
    try {
        handle = await (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<FileSystemDirectoryHandle> })
            .showDirectoryPicker({ mode: 'readwrite' });
    } catch {
        // user dismissed the picker — fall back to idle without an error.
        useSync.getState().cancel();
        return;
    }

    const perm = await (
        handle as unknown as { requestPermission?(o: { mode: string }): Promise<PermissionState> }
    ).requestPermission?.({ mode: 'readwrite' });
    if (perm && perm !== 'granted') {
        useSync.getState().fail('read/write permission was denied for that folder');
        return;
    }

    await disconnect();
    const s: Session = {
        fs,
        mirror: openDiskMirror(handle),
        synced: new Map(),
        diskSig: new Map(),
        watch: { close() {} },
        poll: null,
        stopped: false,
        busy: false,
    };
    session = s;
    useSync.getState().connecting(handle.name);

    try {
        if (direction === 'publish') await reconcilePublish(s);
        else await reconcileImport(s);
    } catch (e) {
        useSync.getState().fail(errText(e));
        session = null;
        return;
    }
    if (s.stopped) return;

    // editor → disk: every write through OPFS (this adds a second watcher
    // alongside main.tsx's HMR fan-out; both fire).
    s.watch = fs.watch((changes) => void pushEditorChanges(s, changes));
    // disk → editor: poll for external edits (VS Code, git, formatters).
    s.poll = setInterval(() => void pullDiskChanges(s), POLL_MS);

    useSync.getState().connected(handle.name);
}

export async function disconnect(): Promise<void> {
    const s = session;
    if (!s) return;
    s.stopped = true;
    s.watch.close();
    if (s.poll !== null) clearInterval(s.poll);
    session = null;
    useSync.getState().reset();
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── initial reconcile ───────────────────────────────────────────────

/** editor wins: write the OPFS managed set out to disk, leaving unmanaged disk
 *  paths (node_modules, .git) untouched. */
async function reconcilePublish(s: Session): Promise<void> {
    const files = await s.fs.list('', { recursive: true });
    for (const f of files) {
        if (f.kind !== 'file' || !syncManaged(f.path)) continue;
        const bytes = await s.fs.read(f.path);
        const sig = sigOf(bytes);
        await s.mirror.write(f.path, bytes);
        const st = await s.mirror.stat(f.path);
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
    const entries = await s.mirror.list();
    const onDisk = new Set<string>();
    for (const e of entries) {
        if (!syncManaged(e.path)) continue;
        onDisk.add(e.path);
        const bytes = await s.mirror.read(e.path);
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
                await s.mirror.remove(c.path);
                s.synced.delete(c.path);
                s.diskSig.delete(c.path);
                moved = true;
            } else {
                if (c.type === 'moved' && c.from && syncManaged(c.from)) {
                    await s.mirror.remove(c.from);
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
    await s.mirror.write(path, bytes);
    const st = await s.mirror.stat(path);
    s.synced.set(path, sig);
    s.diskSig.set(path, { size: sig.size, mtime: st?.mtime ?? 0 });
    return true;
}

// ── live disk → editor ──────────────────────────────────────────────

async function pullDiskChanges(s: Session): Promise<void> {
    if (s.stopped || s.busy) return;
    s.busy = true;
    try {
        const entries = await s.mirror.list();
        const present = new Set<string>();
        let moved = false;
        for (const e of entries) {
            if (!syncManaged(e.path)) continue;
            present.add(e.path);
            const prev = s.diskSig.get(e.path);
            if (prev && prev.size === e.size && prev.mtime === e.mtime) continue; // unchanged on disk
            const bytes = await s.mirror.read(e.path);
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
