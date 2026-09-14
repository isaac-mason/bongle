import type { Channel, JsonValue } from './client';

export type Client = number;

export type User = { id: string; username: string };

export type StorageEntry = { value: JsonValue; version: string };

export type StorageSetResult =
    | { ok: true; version: string }
    | { ok: false; code: 'version_conflict' | 'too_large' | 'rate_limited' | 'cap_exceeded' };

export type StorageDeleteResult = { ok: true } | { ok: false; code: 'version_conflict' | 'rate_limited' };

export type StorageListPage = {
    items: Array<{ key: string; value: JsonValue; version: string }>;
    nextCursor: string | null;
};

export type StorageListOpts = {
    prefix?: string;
    cursor?: string;
    limit?: number;
};

export type StorageServerDriver = {
    project: {
        get(key: string): Promise<StorageEntry | null>;
        set(key: string, value: JsonValue, opts?: { ifVersion?: string }): Promise<StorageSetResult>;
        delete(key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult>;
        list(opts?: StorageListOpts): Promise<StorageListPage>;
    };
    user: {
        get(userId: string, key: string): Promise<StorageEntry | null>;
        set(userId: string, key: string, value: JsonValue, opts?: { ifVersion?: string }): Promise<StorageSetResult>;
        delete(userId: string, key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult>;
        list(userId: string, opts?: StorageListOpts): Promise<StorageListPage>;
    };
};

export type ResolvedAvatar =
    | {
          source: 'bundled';
          modelId: string;
      }
    | {
          source: 'runtime';
          modelId: string;
          clientUrl: string;
          serverUrl: string;
          hash?: string;
          rigType?: string;
      };

export type AvatarsServerDriver = {
    sample: () => Promise<ResolvedAvatar[]>;
};

export type ServerDriver = {
    storage: StorageServerDriver;
    avatars: AvatarsServerDriver;
};

export type FsEntry = { path: string; kind: 'file' | 'dir' };

export type Filesystem = {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    /** the whole subtree under `dir` (dirs included); a missing dir is empty. */
    list(dir: string): Promise<FsEntry[]>;
    remove(path: string): Promise<void>;
};

export type Zstd = { compress: (payload: Uint8Array, level: number) => Uint8Array };

export type ServerInitOptions = {
    options?: Record<string, string | number | boolean>;
    driver: ServerDriver;
    fs: Filesystem;
    zstd: Zstd;
    send(client: Client, channel: Channel, bytes: Uint8Array): void;
};

/** tick timing since the previous `stats` call, for a host that samples room metrics. */
export type TickStats = {
    /** the rate the loop is paced at, the denominator for utilisation. */
    tickHz: number;
    ticks: number;
    maxMs: number;
    totalMs: number;
};

/**
 * The host-facing server. Lifecycle is `init`, `load`, `start`, `dispose`, in that
 * order, and the engine throws on any other order rather than ticking a state that
 * isn't ready. The host never paces the loop or decides what a throwing tick means:
 * the engine reschedules regardless and lets the exception propagate, so a deployed
 * room dies and is respawned while a dev host's own error handler keeps it up.
 */
export type ServerApp<S = unknown> = {
    /** sync: wires capabilities, so `send` closures exist before anything async. */
    init: (opts: ServerInitOptions) => S;
    load: (state: S) => Promise<void>;
    /** owns the fixed-step loop, paced at the game's configured tick rate. */
    start: (state: S) => void;
    /** stops the loop, then tears down. awaits honestly and unboundedly; bounding the
     *  wait is the host's call. */
    dispose: (state: S) => Promise<void>;
    /** drains tick timing accumulated since the last call. */
    stats: (state: S) => TickStats;

    onClientJoin: (state: S, client: Client, user: User, joinData: Record<string, JsonValue>, avatar?: ResolvedAvatar) => void;
    onClientLeave: (state: S, client: Client) => void;
    receive: (state: S, client: Client, channel: Channel, bytes: Uint8Array) => void;
};

export function server<S>(app: ServerApp<S>): ServerApp<S> {
    return app;
}
