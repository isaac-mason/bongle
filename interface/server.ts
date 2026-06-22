import type { JsonValue } from './client';

export type Client = number;

export type User = { id: string; username: string };

export type StorageEntry = { value: JsonValue; version: string };

export type StorageSetResult =
    | { ok: true; version: string }
    | { ok: false; code: 'version_conflict' | 'too_large' | 'rate_limited' | 'cap_exceeded' };

export type StorageDeleteResult =
    | { ok: true }
    | { ok: false; code: 'version_conflict' | 'rate_limited' };

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
    game: {
        get(key: string): Promise<StorageEntry | null>;
        set(
            key: string,
            value: JsonValue,
            opts?: { ifVersion?: string },
        ): Promise<StorageSetResult>;
        delete(key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult>;
        list(opts?: StorageListOpts): Promise<StorageListPage>;
    };
    user: {
        get(userId: string, key: string): Promise<StorageEntry | null>;
        set(
            userId: string,
            key: string,
            value: JsonValue,
            opts?: { ifVersion?: string },
        ): Promise<StorageSetResult>;
        delete(
            userId: string,
            key: string,
            opts?: { ifVersion?: string },
        ): Promise<StorageDeleteResult>;
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

/** Host capability: a source of avatars for populating non-player characters.
 *  The host owns curation — popular / random / trending / seasonal — and MAY
 *  change strategy at any time; treat the result as unordered + non-stable and
 *  visual-only (no usernames / PII). Bulk by design — call once, not per-NPC. */
export type AvatarsServerDriver = {
    /** A batch of avatars to dress NPCs in. Empty array when the host has none. */
    sample: () => Promise<ResolvedAvatar[]>;
};

export type ServerDriver = {
    storage: StorageServerDriver;
    /** Always present, like `storage`: a deployed host sources real avatars; dev /
     *  edit / offline supply a fallback (`createFallbackAvatarsDriver`). */
    avatars: AvatarsServerDriver;
};

export type ServerInitOptions = {
    options?: Record<string, string | number | boolean>;
    driver: ServerDriver;
};

export type ServerApp<S = any> = {
    init: (opts: ServerInitOptions) => S;
    load: (state: S) => Promise<void>;
    update: (state: S, dt: number) => void;
    dispose?: (state: S) => void;

    onClientJoin: (
        state: S,
        client: Client,
        user: User,
        joinData: Record<string, JsonValue>,
        // Avatar the matchmaker resolved at allocation time and stamped
        // into the reservation. Absent on the dev/edit path (no
        // matchmaker) — the engine defaults to the builtin then.
        avatar?: ResolvedAvatar,
    ) => void;
    onClientLeave: (state: S, client: Client) => void;

    getInbox: (state: S) => Map<Client, Uint8Array[]>;
    getOutbox: (state: S) => Map<Client, Uint8Array[]>;
    clearOutbox: (state: S) => void;
};

export function server<S>(app: ServerApp<S>): ServerApp<S> {
    return app;
}
