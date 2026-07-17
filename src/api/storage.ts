// api/storage.ts, script-facing persistent KV.
//
// Two scopes (matching the service tables `game_storage` /
// `game_user_storage`):
//   - `gameStorage.*`, gameId-scoped, shared across all rooms/players.
//     Use for leaderboards, world state, season buckets.
//   - `userStorage.*`, (gameId, userId)-scoped, private to one player.
//     Use for inventory, progression, settings.
//
// Server-only. Calling from a client context throws. Backed by the
// `ServerDriver.storage` handle wired at engine init: HTTP in deployed
// rooms, in-memory in bongle-dev / editor.
//
// Both surfaces are CAS-safe: pass `opts.ifVersion` on set/delete to
// guard against concurrent overwrites. The version is returned by
// every get/set call; treat it as opaque.

import type {
    JsonValue,
    StorageDeleteResult,
    StorageEntry,
    StorageListOpts,
    StorageListPage,
    StorageSetResult,
} from 'bongle/interface';
import type { ScriptContext } from '../core/scene/scripts';

function requireDriver(ctx: ScriptContext) {
    if (!ctx.server) {
        throw new Error('[bongle] storage: server-only');
    }
    return ctx.server.state.driver.storage;
}

/** Game-scoped KV, shared across every room and player of this game. */
export const gameStorage = {
    get(ctx: ScriptContext, key: string): Promise<StorageEntry | null> {
        return requireDriver(ctx).game.get(key);
    },
    set(ctx: ScriptContext, key: string, value: JsonValue, opts?: { ifVersion?: string }): Promise<StorageSetResult> {
        return requireDriver(ctx).game.set(key, value, opts);
    },
    delete(ctx: ScriptContext, key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult> {
        return requireDriver(ctx).game.delete(key, opts);
    },
    list(ctx: ScriptContext, opts?: StorageListOpts): Promise<StorageListPage> {
        return requireDriver(ctx).game.list(opts);
    },
};

/**
 * Per-(game, user) KV, private to one player within this game. `userId`
 * is the durable platform identity (`User.id`). Resolve it from a
 * `Client` via `clientToUser(ctx, client).id`.
 */
export const userStorage = {
    get(ctx: ScriptContext, userId: string, key: string): Promise<StorageEntry | null> {
        return requireDriver(ctx).user.get(userId, key);
    },
    set(
        ctx: ScriptContext,
        userId: string,
        key: string,
        value: JsonValue,
        opts?: { ifVersion?: string },
    ): Promise<StorageSetResult> {
        return requireDriver(ctx).user.set(userId, key, value, opts);
    },
    delete(ctx: ScriptContext, userId: string, key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult> {
        return requireDriver(ctx).user.delete(userId, key, opts);
    },
    list(ctx: ScriptContext, userId: string, opts?: StorageListOpts): Promise<StorageListPage> {
        return requireDriver(ctx).user.list(userId, opts);
    },
};
