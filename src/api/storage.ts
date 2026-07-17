// api/storage.ts, script-facing persistent KV.
//
// Two scopes (matching the service tables `project_storage` /
// `project_user_storage`):
//   - `projectStorage.*`, project-scoped, shared across all rooms/players.
//     Use for leaderboards, world state, season buckets.
//   - `userStorage.*`, (project, user)-scoped, private to one player.
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

/** Project-scoped KV, shared across every room and player of this project. */
export const projectStorage = {
    get(ctx: ScriptContext, key: string): Promise<StorageEntry | null> {
        return requireDriver(ctx).project.get(key);
    },
    set(ctx: ScriptContext, key: string, value: JsonValue, opts?: { ifVersion?: string }): Promise<StorageSetResult> {
        return requireDriver(ctx).project.set(key, value, opts);
    },
    delete(ctx: ScriptContext, key: string, opts?: { ifVersion?: string }): Promise<StorageDeleteResult> {
        return requireDriver(ctx).project.delete(key, opts);
    },
    list(ctx: ScriptContext, opts?: StorageListOpts): Promise<StorageListPage> {
        return requireDriver(ctx).project.list(opts);
    },
};

/**
 * Per-(project, user) KV, private to one player within this project. `userId`
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
