// interface/editor.ts — the editor⇄platform boundary contract. A peer of
// client.ts / server.ts (the engine⇄host boundary): the postMessage protocol
// between the editor (mounted in an iframe) and its embedding platform (the
// parent window). The editor is a purpose-agnostic shell — the platform declares
// what it's FOR via an `intent`, and the editor hands finished payloads back for
// the platform to persist/upload. The platform owns auth + storage; the editor
// never holds a token.
//
// STABILITY CONTRACT (this is what lets one latest-wins platform drive many
// pinned editor bundle versions — see plan-in-browser-editor):
//   1. Evolve ADDITIVELY. Add new intent `kind`s / message `type`s / OPTIONAL
//      fields; never remove or repurpose. Major bumps only for genuine breaks,
//      and then the platform carries both majors through a transition window.
//   2. Payloads stay OPAQUE to the platform. Every payload is `Uint8Array` — the
//      platform stores/forwards bytes tagged with a version, it never parses a
//      save/build's internals. The churny stuff (engine api, scene format,
//      bundler, pipeline) lives BELOW this line, inside the versioned artifact.
//   3. No editor internals leak across the boundary (no engine version, scene
//      format, bundler flags). Keep the verbs coarse + capability-shaped.
//
// This file also carries the FOLDER-SYNC fs channel (bottom of the file): when the
// platform brokers an on-disk folder (bongle:sync-folder-port), it serves it over the
// handed-off MessagePort using the small packcat protocol here. It lives in this
// contract (not editor internals) because both the editor AND the platform host parse
// it — so it's version-governed by EDITOR_INTERFACE_VERSION like everything else here.

import * as pack from 'packcat';

/** Semver of THIS editor⇄platform contract (distinct from the engine⇄game
 *  INTERFACE_VERSION — they evolve independently). The editor announces its
 *  value in `bongle:ready`; the platform announces its own in `bongle:init`, so
 *  either side can warn / degrade when the peer's major differs. */
export const EDITOR_INTERFACE_VERSION = '1.4.0';

/** whether two EDITOR_INTERFACE_VERSION values can bridge. The contract has
 *  stabilised to same-major-compatible per rule #1: minor/patch changes are
 *  additive (new intent kinds, new message types, optional fields), so a peer on
 *  the same major can always be driven — a newer minor just carries fields an
 *  older peer ignores. Only a major bump signals a genuine break. A missing
 *  version, or a version we can't parse a major out of, is treated as compatible
 *  (best effort — a bundle predating the handshake, don't warn). */
export function editorInterfaceCompatible(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return true;
    const majorA = major(a);
    const majorB = major(b);
    if (majorA === undefined || majorB === undefined) return true;
    return majorA === majorB;
}

/** parse the major component of a semver ("1.2.3" → 1). Returns undefined for a
 *  malformed value so the caller can fall back to best-effort compatible. */
function major(version: string): number | undefined {
    const n = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
    return Number.isNaN(n) ? undefined : n;
}

/** what the platform mounted the editor to do. */
export type PlatformIntent =
    | {
          kind: 'project';
          /** the project-save source zip to open into OPFS (absent = new/empty project). */
          save?: Uint8Array;
          /** a project file to open in the code editor on boot. */
          openPath?: string;
          /** our account avatar's glb URL, so we play/edit the project as ourselves
           *  (the local player wears it). Absent → a random sample avatar. */
          avatarUrl?: string;
          /** the project_version id `save` was taken from — echoed back on
           *  autosave/save so the platform knows which slot a draft descends from.
           *  An OPAQUE round-trip token: the editor never interprets version
           *  semantics (rule #3), it just carries it back out. Absent = new/anonymous. */
          baseVersion?: string;
          /** the draft rev `save` represents, so the editor resumes its monotonic
           *  counter above it (restore continuity across the local ring + server).
           *  OPAQUE like baseVersion — a round-trip token, not interpreted. Absent = fresh. */
          rev?: number;
      }
    | {
          kind: 'avatar';
          /** the .bbmodel source (JSON text) to edit in Blockbench (absent = new). */
          bbmodel?: string;
          /** display name / id for the avatar being edited. */
          name?: string;
          /** the user may edit this existing avatar (save a new version of it): the
           *  platform resolved `?edit=<slug>` AND confirmed the user is on its team
           *  (the editor can't check team membership — it's platform auth). When
           *  set, Save prompts for a version name prefilled "new version of <name>".
           *  Absent for a brand-new avatar or a non-member. */
          canEdit?: boolean;
      }
    | {
          /** join someone else's live edit session as a guest. The platform
           *  resolved the invite (/api/edit/join) and hands over the relay ws
           *  url (token baked in); the editor connects to it as a remote client. */
          kind: 'joinEdit';
          url: string;
      };

/** editor → platform. */
export type EditorMessage =
    /** editor booted + listening. `version` is EDITOR_INTERFACE_VERSION of the
     *  editor bundle (optional until every live bundle announces it). */
    | { type: 'bongle:ready'; version?: string }
    /** mint a manual version: hand back the source zip for the platform to persist
     *  as an immutable snapshot (origin='manual'). Deliberate, enters history. */
    | { type: 'bongle:version'; payload: Uint8Array }
    /** high-frequency working snapshot for the platform to persist as a DRAFT
     *  (autosave snapshot: local ring always; server if owned + dirty). Distinct
     *  from bongle:version so the platform keeps it quiet — no version minted, no
     *  toast. `baseVersion`/`rev` are the opaque tokens from bongle:init, `rev`
     *  incremented per edit. */
    | { type: 'bongle:draft'; payload: Uint8Array; baseVersion: string | null; rev: number }
    /** hand back the built project-build bundle.zip for the platform to upload.
     *  `source` is the project source zip (same as bongle:version) so the platform
     *  can snapshot it as a project_version + record the build's provenance. */
    | { type: 'bongle:build'; payload: Uint8Array; source?: Uint8Array }
    /** hand back the exported avatar (compiled .glb + .bbmodel source) for the
     *  platform to upload (editor-initiated from the "editing X" window). */
    | { type: 'bongle:avatar-export'; glb: Uint8Array; bbmodel: string; name: string }
    /** the host asks the platform to open this session to multiplayer. The
     *  platform calls /api/edit/host (it owns the session) and replies with a
     *  multiplayer-opened. `region` is the host's picked region. */
    | { type: 'bongle:open-multiplayer'; region?: string }
    /** the user asked to leave the editor. The editor never navigates itself
     *  (it may be a cross-origin iframe); the platform routes back to bongle.io. */
    | { type: 'bongle:exit' }
    /** start a folder sync. The editor can't open the file picker itself (a
     *  cross-origin iframe is barred from showDirectoryPicker), so it asks the
     *  host — which owns the top frame — to pick a folder and hand back a port.
     *  `direction` is which side seeds the other on the initial reconcile. */
    | { type: 'bongle:request-sync-folder'; direction: 'editor-to-folder' | 'folder-to-editor' }
    /** the editor tore down its live folder sync — the host closes its end of the
     *  fs bridge and releases the directory handle. */
    | { type: 'bongle:sync-folder-stopped' };

/** platform → editor. */
export type PlatformMessage =
    /** configure the editor for its purpose. `version` is the platform's
     *  EDITOR_INTERFACE_VERSION (optional until wired). */
    | { type: 'bongle:init'; version?: string; intent: PlatformIntent }
    /** a cheap "hold on" ack, sent the moment the platform sees `bongle:ready` and
     *  BEFORE it has resolved the intent — resolving it can need a network fetch (an
     *  avatar remix downloads its .bbmodel source first), which may outlast the
     *  editor's standalone-fallback timeout. It tells the editor a real platform IS
     *  answering, so the editor stops that timer and waits for the (possibly slow)
     *  `bongle:init` rather than booting standalone. Optional: an editor bundle that
     *  predates it just ignores it and keeps the timeout. */
    | { type: 'bongle:init-pending' }
    /** outcome of the editor's last hand-back (version/build/avatar-export). A save
     *  (`of: 'version'`) AND a build (`of: 'build'`) both mint a manual version and
     *  carry its `versionId`/`rev`, so the editor rebases its draft to
     *  `draft@versionId` with a fresh `rev` baseline. Load-bearing, not cosmetic:
     *  without them the editor keeps autosaving into the stale pre-save slot. */
    | {
          type: 'bongle:result';
          of: 'version' | 'build' | 'avatar-export';
          ok: boolean;
          message?: string;
          versionId?: string;
          rev?: number;
          /** On a successful `of: 'build'`: the minted build's id + an absolute link to
           *  the platform's builds dashboard, so the editor confirms the publish with
           *  ids + a "view builds" link instead of a bare "downloaded". */
          buildId?: string;
          dashboardUrl?: string;
      }
    /** deliver an avatar's source AFTER a `bongle:init { kind:'avatar' }`, so the editor
     *  can boot Blockbench immediately and load the model when it arrives (resolving the
     *  source can need a download — a remixed/edited version). `bbmodel` null = there's
     *  no source, use the editor's bundled starter rig. `name` is the avatar's display
     *  name, used to seed the Save dialog. Sent exactly once per avatar session. */
    | { type: 'bongle:source'; bbmodel: string | null; name?: string }
    /** ask the editor to run its Save-version action now (export the source → hand it
     *  back as `bongle:version`). Lets the platform drive a prominent "save this to
     *  bongle" CTA from outside the iframe (e.g. on an anonymous local-only draft). */
    | { type: 'bongle:request-save' }
    /** answer to open-multiplayer: the relay ws url the host connects to + the
     *  ready-to-share invite link. */
    | { type: 'bongle:multiplayer-opened'; url: string; shareUrl: string }
    | { type: 'bongle:multiplayer-failed'; message: string }
    /** answer to request-sync-folder: the host picked a folder and is now serving
     *  it as a remote Filesystem. The MessagePort rides in the postMessage TRANSFER
     *  LIST (event.ports[0]), NOT this payload — the editor connects its sync loop
     *  to it. `direction` echoes the request so the editor runs the right reconcile. */
    | {
          type: 'bongle:sync-folder-port';
          direction: 'editor-to-folder' | 'folder-to-editor';
          /** the picked folder's name, for the editor's sync status display. */
          folderName: string;
      }
    /** the user dismissed the folder picker — the editor falls back to idle with no
     *  error. Distinct from failed so a plain cancel stays quiet. */
    | { type: 'bongle:sync-folder-cancelled' }
    /** the host couldn't start the sync (picker blocked, permission denied, no FS
     *  Access API). The editor surfaces `message` on its sync status. */
    | { type: 'bongle:sync-folder-failed'; message: string };

/** the result payload the editor surfaces to the user. Mirrors bongle:result:
 *  `versionId`/`rev` populated on a successful `of: 'version'` OR `of: 'build'` so the
 *  editor rebases its draft to `draft@versionId` with a fresh `rev` baseline. */
export type PlatformResult = {
    of: 'version' | 'build' | 'avatar-export';
    ok: boolean;
    message?: string;
    versionId?: string;
    rev?: number;
    /** Successful `of: 'build'`: minted build id + builds-dashboard link (see above). */
    buildId?: string;
    dashboardUrl?: string;
};

// ── folder-sync fs channel ──────────────────────────────────────────
// The platform host (which owns the picked directory handle) serves the folder to the
// editor over the MessagePort from `bongle:sync-folder-port`, speaking the small packcat
// protocol below. The editor's sync loop drives it like a local fs. This is a SEPARATE,
// smaller protocol from the multiplayer relay fs (editor/net/remote-fs): that one needs
// 1 MiB chunking for the WebSocket's frame budget; a local MessagePort carries a whole
// file in one message, so this one has no chunking. Same concept, different channel.

/** file size + mtime (ms epoch). mtime is change-detection quality, not ordering. */
export type SyncStat = { size: number; mtime: number };
/** a managed file in a `SyncTarget.list()`. */
export type SyncEntry = { path: string; size: number; mtime: number };

/** the minimal fs surface the folder sync moves over the port: exactly the 5 ops the
 *  reconcile/poll loop calls on the on-disk side. Disk changes flow back by POLLING
 *  (the editor re-`list`s + reads what moved); there's no push channel because a
 *  directory handle has no native change stream. A future watching backing (a node
 *  host's fs.watch, a FileSystemObserver fast-path) would ADD a `watch`/change frame
 *  here — additive, so we don't carry the plumbing until it's actually used.
 *  Paths are POSIX, root-relative. */
export type SyncTarget = {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
    stat(path: string): Promise<SyncStat | null>;
    /** every managed file (recursive), with size + mtime. */
    list(): Promise<SyncEntry[]>;
};

// ── wire protocol (packcat, no chunking) ────────────────────────────
const syncStatSchema = pack.object({ size: pack.float64(), mtime: pack.float64() });
const syncEntrySchema = pack.object({ path: pack.string(), size: pack.float64(), mtime: pack.float64() });

const syncCodec = pack.build(
    pack.union('t', [
        // requests (consumer → owner)
        pack.object({ t: pack.literal('read'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('write'), id: pack.uint32(), path: pack.string(), bytes: pack.uint8Array() }),
        pack.object({ t: pack.literal('remove'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('stat'), id: pack.uint32(), path: pack.string() }),
        pack.object({ t: pack.literal('list'), id: pack.uint32() }),
        // responses (owner → consumer)
        pack.object({ t: pack.literal('ok:bytes'), id: pack.uint32(), bytes: pack.uint8Array() }),
        pack.object({ t: pack.literal('ok:void'), id: pack.uint32() }),
        pack.object({ t: pack.literal('ok:stat'), id: pack.uint32(), stat: pack.nullable(syncStatSchema) }),
        pack.object({ t: pack.literal('ok:list'), id: pack.uint32(), entries: pack.list(syncEntrySchema) }),
        pack.object({ t: pack.literal('err'), id: pack.uint32(), error: pack.string() }),
    ]),
);
type SyncFrame = ReturnType<typeof syncCodec.unpack>;

/** consumer side (the editor): a `SyncTarget` whose ops RPC to the owner over `port`. */
export function consumeFolderSync(port: MessagePort): SyncTarget {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;

    port.onmessage = (e) => {
        const msg = syncCodec.unpack(e.data as Uint8Array);
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.t === 'err') p.reject(new Error(msg.error));
        else p.resolve(syncResultOf(msg));
    };

    const call = <T>(build: (id: number) => SyncFrame): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            port.postMessage(syncCodec.pack(build(id)));
        });

    return {
        read: (path) => call<Uint8Array>((id) => ({ t: 'read', id, path })),
        write: (path, bytes) => call<void>((id) => ({ t: 'write', id, path, bytes })),
        remove: (path) => call<void>((id) => ({ t: 'remove', id, path })),
        stat: (path) => call<SyncStat | null>((id) => ({ t: 'stat', id, path })),
        list: () => call<SyncEntry[]>((id) => ({ t: 'list', id })),
    };
}

function syncResultOf(msg: SyncFrame): unknown {
    switch (msg.t) {
        case 'ok:bytes':
            return msg.bytes;
        case 'ok:stat':
            return msg.stat as SyncStat | null;
        case 'ok:list':
            return msg.entries as SyncEntry[];
        default:
            return undefined; // ok:void
    }
}

/** owner side (the platform host): answer a consumer's ops from `target`. Returns a
 *  handle to detach when the sync stops. */
export function serveFolderSync(target: SyncTarget, port: MessagePort): { close(): void } {
    const reply = (msg: SyncFrame) => port.postMessage(syncCodec.pack(msg));

    async function handle(req: SyncFrame): Promise<void> {
        const id = req.id;
        try {
            switch (req.t) {
                case 'read':
                    return reply({ t: 'ok:bytes', id, bytes: await target.read(req.path) });
                case 'write':
                    await target.write(req.path, req.bytes);
                    return reply({ t: 'ok:void', id });
                case 'remove':
                    await target.remove(req.path);
                    return reply({ t: 'ok:void', id });
                case 'stat':
                    return reply({ t: 'ok:stat', id, stat: await target.stat(req.path) });
                case 'list':
                    return reply({ t: 'ok:list', id, entries: await target.list() });
                default:
                    return; // a response frame reaching the owner — ignore
            }
        } catch (err) {
            reply({ t: 'err', id, error: err instanceof Error ? err.message : String(err) });
        }
    }

    port.onmessage = (e) => void handle(syncCodec.unpack(e.data as Uint8Array));
    return { close: () => port.close() };
}

// ── the managed set + the browser backing ───────────────────────────
// Which project paths the folder sync owns (publish + import + delete). Everything NOT
// excluded here is two-way synced. We mirror almost everything so the on-disk copy is a
// complete, standalone project — including node_modules (the engine seed), resources
// (bake output), and src/generated (generated barrels). Only `dist` (the bundler's JS
// output) is excluded: it's large, fully regenerated, and not useful on disk.
const IGNORED_SYNC_DIRS = new Set(['dist']);

/** does the folder sync manage this path? False only for `dist`, which it never
 *  publishes, imports, or deletes on either side. */
export function syncManaged(path: string): boolean {
    for (const seg of path.split('/')) if (IGNORED_SYNC_DIRS.has(seg)) return false;
    return true;
}

function syncSplit(path: string): { dirs: string[]; name: string } {
    const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1]! };
}

type AnyDirHandle = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

/** THE browser backing: expose a picked directory handle (File System Access API) as a
 *  `SyncTarget`. Chromium-only (`showDirectoryPicker`). The disk walk skips unmanaged
 *  paths, so a real project's node_modules is never enumerated. A node host would ship
 *  its own `SyncTarget` over node fs — the loop + wire protocol are backing-agnostic. */
export function openDiskFolder(root: FileSystemDirectoryHandle): SyncTarget {
    const dirHandle = async (dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> => {
        let cur = root;
        for (const d of dirs) {
            try {
                cur = await cur.getDirectoryHandle(d, { create });
            } catch {
                return null;
            }
        }
        return cur;
    };

    return {
        async read(path) {
            const { dirs, name } = syncSplit(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) throw new Error(`[disk] no dir for ${path}`);
            const f = await (await dir.getFileHandle(name)).getFile();
            return new Uint8Array(await f.arrayBuffer());
        },
        async write(path, bytes) {
            const { dirs, name } = syncSplit(path);
            const dir = await dirHandle(dirs, true);
            if (!dir) throw new Error(`[disk] cannot create dir for ${path}`);
            const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
            // cast: the DOM lib types a Uint8Array<ArrayBufferLike> as not-quite a
            // BufferSource, but the bytes write fine.
            await w.write(bytes as BufferSource);
            await w.close();
        },
        async remove(path) {
            const { dirs, name } = syncSplit(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) return;
            try {
                await dir.removeEntry(name, { recursive: true });
            } catch {
                /* already gone */
            }
        },
        async stat(path) {
            const { dirs, name } = syncSplit(path);
            const dir = await dirHandle(dirs, false);
            if (!dir) return null;
            try {
                const f = await (await dir.getFileHandle(name)).getFile();
                return { size: f.size, mtime: f.lastModified };
            } catch {
                return null;
            }
        },
        async list() {
            const out: SyncEntry[] = [];
            const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
                for await (const [name, h] of (dir as AnyDirHandle).entries()) {
                    const path = prefix ? `${prefix}/${name}` : name;
                    if (!syncManaged(path)) continue;
                    if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, path);
                    else {
                        const f = await (h as FileSystemFileHandle).getFile();
                        out.push({ path, size: f.size, mtime: f.lastModified });
                    }
                }
            };
            await walk(root, '');
            return out;
        },
    };
}
