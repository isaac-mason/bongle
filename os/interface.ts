// os/interface.ts — the OS contract: pure types, zero logic. Both sides of the
// version boundary import this: apps (engine artifact or user code) program
// against App/Env; the host implements IO and delivers Env. Forever-contract:
// evolve additively, never repurpose a field. Init crosses postMessage —
// structured-cloneable values only.

// ── the disk ─────────────────────────────────────────────────────────────────

export type FsPath = string;

export type FsStat = { path: FsPath; kind: 'file' | 'dir'; size: number; mtime: number };

export type FsChange = { type: 'created' | 'modified' | 'deleted' | 'moved'; path: FsPath; from?: FsPath };

export type FsWatchHandle = { close(): void };

/** frozen, synchronously-readable view of a subtree. */
export type FilesystemSnapshot = {
    read(path: FsPath): Uint8Array;
    readText(path: FsPath): string;
    exists(path: FsPath): boolean;
    list(): FsPath[];
};

/** the project disk. Paths are POSIX, root-relative, no leading slash. */
export type Filesystem = {
    read(path: FsPath): Promise<Uint8Array>;
    readText(path: FsPath): Promise<string>;
    stat(path: FsPath): Promise<FsStat | null>;
    list(dir?: FsPath, opts?: { recursive?: boolean }): Promise<FsStat[]>;
    /** immediate children as name -> kind — the cheap enumeration primitive. */
    readDir(dir?: FsPath): Promise<Map<string, 'file' | 'dir'>>;
    exists(path: FsPath): Promise<boolean>;
    write(path: FsPath, data: Uint8Array | string): Promise<void>;
    /** write only when bytes differ; true if written (emitters rely on it). */
    writeIfChanged(path: FsPath, data: Uint8Array | string): Promise<boolean>;
    remove(path: FsPath, opts?: { recursive?: boolean }): Promise<void>;
    move(from: FsPath, to: FsPath): Promise<void>;
    /** change events, batched per flush — from ALL contexts of the project
     *  (another realm's writes fire here too; apps rely on this to self-watch
     *  bake outputs and edits, there is no push channel). */
    watch(cb: (changes: FsChange[]) => void): FsWatchHandle;
    snapshot(dir?: FsPath): Promise<FilesystemSnapshot>;
};

// ── apps ─────────────────────────────────────────────────────────────────────

/** an app: given its environment, do work. Returning ends it unless it holds a
 *  window, a listener, or a watcher. */
export type App = (env: Env) => void | Promise<void>;

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

/** what every auto-started app (and shell-opened window) receives as init. */
export type EditorSession = {
    user: { id: string; username: string };
    /** `file:///<path>` reads the project vfs; http(s) is fetched. */
    avatarUrl?: string;
    /** the game entry module (project-root-relative); default 'src/index.ts'. */
    entry?: string;
};

/** the project's launch config — DEFINED here because it crosses the boundary:
 *  reported by the 'pipeline' service and stamped into the bundle manifest
 *  (bongle.json), so it is stable across engine pins by the same rule as the
 *  manifest schema — narrow, infrastructure-only, additive-only. The engine
 *  re-exports this as its `Config` (src/core/config.ts); one definition. */
export type Config = { server?: false | { maxPlayers: number } };

/** what the 'pipeline' service sends: on accept, and after every bake. */
export type PipelineReport = { config: Config | null };

/** an app's whole syscall surface. */
export type Env = {
    readonly init: unknown;
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
    listen(name: string, onConnect: (conn: Channel, meta: ConnMeta) => ((m: unknown) => void) | void): Server;
    readonly surface?: Surface;
    log(...parts: unknown[]): void;
    err(...parts: unknown[]): void;
    /** emit a STRUCTURED status (distinct from log lines) — a boot phase today,
     *  richer later. The host reflects it (task manager / a phase chip); the OS
     *  keeps the latest on the process (see ProcInfo.progress). */
    progress(status: unknown): void;
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
    /** the latest structured status the process emitted via env.progress. */
    progress?: unknown;
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
    /** side-effect-free readiness: resolves once `name` is served. `signal` retracts the wait. */
    served(name: string, signal?: AbortSignal): Promise<void>;
    /** exit code; resolves immediately for an already-exited pid (127 = unknown app). */
    wait(pid: number): Promise<number>;
    /** write stdin to a process (delivered to its env.onStdin). No-op if the pid
     *  is gone. */
    stdin(pid: number, data: string | Uint8Array): void;
    kill(pid: number): void;
    /** attach a peer OS; local connects to `remoteNames` route out to it, and its
     *  inbound opens reach local listeners (with the dialer's identity). */
    attachPeer(peer: PeerLink, remoteNames: string[]): void;
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

/** host primitives createOS runs on; fs is opened per-app in the host shim. */
export type IO = {
    spawnWorker(): Link;
    spawnFrame(): { link: Link; element: HTMLIFrameElement };
    /** a runner conduit keyed to this process's module graph, transferred in
     *  the start message. */
    openRunner(ref: string, pid: number): MessagePort;
    /** an fsrpc conduit for this process's disk, or null to open the local
     *  project disk in the shim. A guest OS returns a port served from the
     *  host's fs (over the relay); a local OS returns null (OPFS in-shim). */
    openFs?(ref: string, pid: number): MessagePort | null;
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
    | { t: 'data'; cid: number; data: unknown }
    | { t: 'close'; cid: number };

export type PeerLink = {
    send(frame: PeerFrame): void;
    onMessage(cb: (frame: PeerFrame) => void): void;
};
