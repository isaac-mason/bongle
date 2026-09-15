// os/interface.ts — the OS contract: pure types, zero logic. Both sides of the
// version boundary import this: apps (engine artifact or user code) program
// against App/Env; the host implements IO and delivers Env. Forever-contract:
// evolve additively, never repurpose a field. Init crosses postMessage —
// structured-cloneable values only.

// ── the disk ─────────────────────────────────────────────────────────────────

export type FsPath = string;

export type FsKind = 'file' | 'dir';

/** enumeration: what is there. Never carries metadata, so listing is never
 *  expensive (no file is opened to produce it). */
export type FsEntry = { path: FsPath; kind: FsKind };

/** metadata for one path. Producing it may open the file; ask per path. */
export type FsStat = { path: FsPath; kind: FsKind; size: number; mtime: number };

/** one change to the tree. `path` is always the path the change is about (a
 *  move's destination). Every structural variant carries `kind`, so a consumer
 *  holding a replica of the tree can apply it without asking the disk. */
export type FsChange =
    | { type: 'created'; path: FsPath; kind: FsKind }
    | { type: 'modified'; path: FsPath }
    | { type: 'deleted'; path: FsPath; kind: FsKind }
    | { type: 'moved'; path: FsPath; from: FsPath; kind: FsKind };

export type FsWatchHandle = { close(): void };

/** the project disk. Paths are POSIX, root-relative, no leading slash. */
export type Filesystem = {
    read(path: FsPath): Promise<Uint8Array>;
    readText(path: FsPath): Promise<string>;
    stat(path: FsPath): Promise<FsStat | null>;
    exists(path: FsPath): Promise<boolean>;
    /** immediate children as name -> kind. A missing dir is an empty map. */
    readDir(dir?: FsPath): Promise<Map<string, FsKind>>;
    /** the whole subtree under `dir` (dirs included), sorted by path. A missing
     *  dir is an empty list. */
    list(dir?: FsPath): Promise<FsEntry[]>;
    write(path: FsPath, data: Uint8Array | string): Promise<void>;
    /** write only when bytes differ; true if written (emitters rely on it). */
    writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean>;
    remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void>;
    move(from: FsPath, to: FsPath): Promise<void>;
    /** every change to the project, from every context that holds it, in the
     *  order they landed, one batch per operation, delivered after the change is
     *  visible to read/list/stat on this same object.
     *  USER files only: bake outputs are announced by the producer on the
     *  'pipeline' service (see `BakedArtifacts`), because a watcher observes an
     *  artifact's files one at a time and races writes made before it existed. */
    watch(cb: (changes: readonly FsChange[]) => void): FsWatchHandle;
};

// ── apps ─────────────────────────────────────────────────────────────────────

/** an app: given its environment, do work. Returning ends it unless it holds a
 *  window, a listener, or a watcher. `TInit` is what the spawner hands it; the
 *  engine's own apps take `AppInit`. Only the module loader deals in `unknown`,
 *  because only it resolves an app by string at runtime. */
export type App<TInit = unknown> = (env: Env<TInit>) => void | Promise<void>;

/** a defined app: a module specifier the runner evaluates; its default export
 *  is the App. */
export type AppDef = {
    module: string;
    /** windowed (iframe) vs headless (worker). */
    surface?: boolean;
    /** 'auto' = spawned at boot with the session; default 'manual'. */
    start?: 'auto' | 'manual';
};

export type AppDefs = Record<string, AppDef>;

export type ResolveDef = (ref: string) => Promise<AppDef | null>;

/** what the shell hands every app it starts. Not a "session": the pipeline bake is
 *  headless and takes this too. It is the set of decisions the HOST has already made
 *  that a realm cannot work out for itself. */
export type AppInit = {
    user: { id: string; username: string };
    /** `file:///<path>` reads the project vfs; http(s) is fetched. */
    avatarUrl?: string;
    /** platform avatars for dressing OTHER joining clients (extra windows / guests)
     *  that have no account avatar of their own. Host-resolved — the realm never
     *  talks to the platform itself. Absent/empty → the engine's builtin fallback. */
    sampleAvatars?: { modelId: string; clientUrl: string; rigType?: string }[];
    /** the game entry module (project-root-relative); default 'src/index.ts'. */
    entry?: string;
    /** the host's chosen render backend, from its device-wide GPU probe. Windowed
     *  apps read it off their own `location.search`, but a WORKER app can't — its
     *  `self.location` is the shim script's URL — so the shell carries it here for
     *  the pipeline's icon bake, which must land on the same backend as the client
     *  that will display those icons. Absent only outside that host, where the realm
     *  falls back to its own adapter check. */
    renderer?: 'webgpu' | 'webgl';
};

/** the project's launch config — DEFINED here because it crosses the boundary:
 *  reported by the 'pipeline' service and stamped into the bundle manifest
 *  (bongle.json), so it is stable across engine pins by the same rule as the
 *  manifest schema — narrow, infrastructure-only, additive-only. The engine
 *  re-exports this as its `Config` (src/core/config.ts); one definition. */
export type Config = { server?: false | { maxPlayers: number; tickRate?: number } };

/**
 * Identity of each artifact the bake has left in `resources/`, as of this report.
 * The bake ANNOUNCES its outputs here so consumers re-read on change instead of
 * sniffing the filesystem for them: `fs.watch` is the source of truth for USER
 * files, never for bake outputs (an artifact is several files written one at a
 * time, so a watcher observes torn pairs and races the writes it was registered
 * to catch).
 *
 * Each value is the artifact's sidecar hash, null when it isn't baked. Compare
 * against the one you last read; a different value means re-read it.
 * `prefabIcons` is a list of ids instead, because those are fetched lazily per
 * prefab: a consumer holds no whole-set state to compare, it needs to know which
 * ones moved.
 */
export type BakedArtifacts = {
    /** voxels-atlas.json — the block texture atlas. */
    blocks: string | null;
    /** sprites-atlas.json. */
    sprites: string | null;
    /** audio-manifest.json (its own sidecar). */
    audio: string | null;
    /** voxels-icons.json — the block-icon atlas the editor palette reads. */
    blockIcons: string | null;
    /** prefab ids whose icon png was re-rendered or removed this pass. */
    prefabIcons: string[];
};

/** what the 'pipeline' service sends: on accept, and after every bake. The icon
 *  render lands after the data bake (it is deliberately not awaited), so one bake
 *  sends more than one report — the later one carries the icon artifacts. */
export type PipelineReport = { config: Config | null; artifacts: BakedArtifacts };

/** an app's whole syscall surface. */
export type Env<TInit = unknown> = {
    readonly init: TInit;
    /** aborts on shutdown. */
    readonly signal: AbortSignal;
    /** AWAITED teardown (flush-to-disk) — the OS holds shutdown for these. */
    onDispose(fn: () => void | Promise<void>): void;
    readonly fs: Filesystem;
    /** root-anchored module eval for DATA specifiers; the app itself already
     *  runs in the same runner graph, so plain imports cover the rest. */
    readonly runner: Runner;
    spawn(ref: string, init?: unknown): Process;
    connect(name: string, onMessage?: (m: unknown) => void, opts?: { signal?: AbortSignal }): Promise<Channel>;
    /** side-effect-free readiness: resolves once `name` is served, WITHOUT opening a
     *  connection. `connect(name)` used to stand in for this, which left the waiter
     *  parked in the server's subscriber set for the life of the process. */
    served(name: string, opts?: { signal?: AbortSignal }): Promise<void>;
    listen(name: string, onConnect: (conn: Channel, meta: ConnMeta) => ((m: unknown) => void) | void): Server;
    readonly surface?: Surface;
    log(...parts: unknown[]): void;
    err(...parts: unknown[]): void;
    /** the process's current phase, as one short human string ('baking assets').
     *  Distinct from log lines: this REPLACES, it doesn't append. The host reflects
     *  it (task manager / phase chip) and the OS keeps the latest on the process. */
    progress(status: string): void;
    /** receive stdin written to this process by the operator (OS.stdin). An app
     *  that never calls this simply never reads stdin. */
    onStdin(cb: (data: string | Uint8Array) => void): void;
};

/** who dialed: app ref + pid, plus a user when the shell dials on behalf of
 *  an identified party (a peer guest joining 'game'). */
export type ConnMeta = { ref: string; pid: number; user?: { id: string; username: string } };

export type Channel = { send(data: unknown): void; close(): void; readonly closed: Promise<void> };
export type Server = { close(): void };
export type Process = { readonly exit: Promise<number>; kill(): void };
export type Surface = { readonly root: HTMLElement };

// biome-ignore lint/suspicious/noExplicitAny: a module namespace is dynamically typed.
export type Runner = { import<T = any>(specifier: string): Promise<T> };

// ── observability ────────────────────────────────────────────────────────────

export type ProcInfo = {
    pid: number;
    ref: string;
    /** ms epoch (host clock). */
    startedAt: number;
    /** 'stopping' between kill and the app's dispose ack. */
    state: 'running' | 'stopping';
    serves: string[];
    surface: boolean;
    /** the latest phase the process emitted via env.progress. */
    progress?: string;
};

export type ConnEndpoint = number | 'shell' | 'peer';

export type OSSnapshot = {
    procs: ProcInfo[];
    /** open channels: from = the dialer, to = the listener. */
    conns: { name: string; from: ConnEndpoint; to: ConnEndpoint }[];
    /** connects parked on an unserved name. */
    pending: { name: string; count: number }[];
};

// ── what the shell drives ────────────────────────────────────────────────────

/** One end of an open connection, handed to whoever dialled it. */
export type Connection = {
    /** the connection id, as it appears in `inspect()`. */
    conn: number;
    /** the dialer's port. Queues until the connection pairs; safe to transfer. */
    port: MessagePort;
    /** resolves once the serving end is wired; rejects if the open was retracted. */
    opened: Promise<void>;
    close(): void;
};

export type OpenOptions = {
    /** what the listener sees as the dialer's identity. */
    meta?: Partial<ConnMeta>;
    /** retracts the open if it aborts before the name is served. */
    signal?: AbortSignal;
};

export type AttachPeerOptions = {
    /** names this OS may open ON the peer. */
    dial?: string[];
    /** names the peer may open ON US; anything else is refused. */
    serve?: string[];
    /** who the peer is. Stamped onto every inbound open — the frame's own meta is
     *  written by the far side, so it is a label, not an identity. */
    identity?: ConnMeta['user'];
};

export type OS = {
    spawn(ref: string, init?: unknown): number;
    run(ref: string, init?: unknown): Promise<number>;
    /** parks until served; meta overrides what the listener sees. `signal` retracts the wait — a
     *  caller racing this against a timeout must be able to withdraw the loser. */
    connect(name: string, onMessage?: (m: unknown) => void, meta?: Partial<ConnMeta>, signal?: AbortSignal): Promise<Channel>;
    /** the primitive `connect` is built on: open a connection and get the DIALER's port
     *  back immediately, for handing to another realm. The port queues anything posted
     *  to it until the connection pairs, so it is usable (and transferable) at once;
     *  `opened` is the readiness signal. */
    open(name: string, opts?: OpenOptions): Connection;
    /** Serve `name` from the SHELL rather than a process — the host's bundler and disk
     *  live in the document. `handler` receives the serving end of each connection.
     *  Throws if the name is already served; returns the unlisten. */
    listen(name: string, handler: (port: MessagePort, meta: ConnMeta) => void): () => void;
    /** side-effect-free readiness: resolves once `name` is served. `signal` retracts the wait. */
    served(name: string, signal?: AbortSignal): Promise<void>;
    /** exit code; resolves immediately for an already-exited pid (127 = unknown app). */
    wait(pid: number): Promise<number>;
    /** write stdin to a process (delivered to its env.onStdin). No-op if the pid
     *  is gone. */
    stdin(pid: number, data: string | Uint8Array): void;
    kill(pid: number): void;
    /** attach a peer OS; local connects to its `dial` names route out to it, and its
     *  inbound opens reach local listeners (identity stamped from the attachment). */
    /** Attach a peer OS under `id` (a host attaches one per guest). Re-attaching the
     *  same id replaces the previous link. */
    attachPeer(id: string, link: PeerLink, opts?: AttachPeerOptions): void;
    /** Retire a peer; every connection through it tears down as if the far end hung up. */
    detachPeer(id: string): void;
    inspect(): OSSnapshot;
    /** coarse change stream; re-inspect on fire. Returns the unsubscriber. */
    onChange(cb: () => void): () => void;
};

/** a window the OS produced; the shell places it and unmounts on `closed`. */
export type Window = {
    readonly ref: string;
    readonly pid: number;
    readonly element: HTMLIFrameElement;
    readonly closed: Promise<void>;
};

/** host primitives createOS runs on. */
export type IO = {
    spawnWorker(): Link;
    spawnFrame(): { link: Link; element: HTMLIFrameElement };
    /** a runner conduit keyed to this process's module graph, transferred in
     *  the start message. */
    openRunner(ref: string, pid: number): MessagePort;
    /** an fs conduit for this process's disk, transferred in the start message,
     *  or null when the process opens the project disk itself (a local host whose
     *  storage every context can reach). A guest OS serves one from the host's fs. */
    openFs(ref: string, pid: number): MessagePort | null;
    mount(win: Window): void;
    stdout(ref: string, pid: number, line: string, isErr: boolean): void;
};

// ── transport ────────────────────────────────────────────────────────────────

export type Link = {
    post(msg: unknown, transfer?: Transferable[]): void;
    // biome-ignore lint/suspicious/noExplicitAny: control frames are loosely typed at the transport.
    onMessage(cb: (data: any, ports: readonly MessagePort[]) => void): void;
    close(): void;
};

/** a byte pipe to a peer OS (implemented over a relay, a MessagePort, …). Only
 *  channels route over it — fs stays its own lane (fsrpc). The OS names the peer,
 *  not the transport. */
export type PeerFrame =
    | { t: 'open'; cid: number; name: string; meta: ConnMeta }
    /** the open paired — the dialer may now treat the connection as live. */
    | { t: 'opened'; cid: number }
    /** the open will never pair (not routable here, or retracted by the dialer). */
    | { t: 'refused'; cid: number; reason: string }
    | { t: 'data'; cid: number; data: unknown }
    | { t: 'close'; cid: number };

export type PeerLink = {
    send(frame: PeerFrame): void;
    onMessage(cb: (frame: PeerFrame) => void): void;
};
