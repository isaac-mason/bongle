import { recordCommand } from './capture/module-scope';
import type { NetMessage } from './protocol';
import { get, registry, upsert, type ProtocolTable } from './registry';
import { pack } from './scene/pack';
import { logScriptError } from './scene/script-errors';

/* ── rpc direction constants ─────────────────────────────────────────── */

export const CLIENT_TO_SERVER = 'client_to_server' as const;
export const SERVER_TO_CLIENT = 'server_to_client' as const;

export type RpcDirection = typeof CLIENT_TO_SERVER | typeof SERVER_TO_CLIENT;

/* ── Rpc state ───────────────────────────────────────────────────────── */

/**
 * side-specific outbound transport. server impl routes via Net.send /
 * Net.broadcastToRoom; client impl routes via ClientNet.send. constructed
 * by `server/rpc.ts` and `client/rpc.ts`; lives on `NodesRuntime` so
 * scripts can dispatch sends without knowing the side.
 */
export type RpcDriver = {
    /**
     * unified outbound. `client` is the optional addressee:
     * - client→server side: client param is ignored (client only ever sends to its server)
     * - server→client side: client param routes to that specific peer; absent = noop
     *   (server uses `broadcast` for the to-all path)
     */
    send(commandIndex: number, roomId: string, payload: Uint8Array, client?: unknown): void;
    broadcast(commandIndex: number, roomId: string, payload: Uint8Array): void;
};

/**
 * registered listener entry. `room` is the roomId the handler is scoped to,
 * dispatch matches it against the inbound message's roomId.
 */
export type ListenerEntry = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (...args: any[]) => void;
    room: string;
};

/**
 * one Rpc state per side. the driver carries side-specific send impls;
 * `listeners` is a per-room registry, entries scoped by roomId, matched
 * against `message.roomId` at dispatch time.
 *
 * the command wire-index table lives on `ProjectModule.commandProtocolTable`,
 * not here, callers of `send`/`dispatchNetMessage` pass it in. that way
 * one rebuild (`getProjectModule()`) covers every wire-index table the
 * project derives from its registries (commands, traits).
 */
export type Rpc = RpcDriver & {
    listeners: Map<string, Set<ListenerEntry>>;
};

export function init(driver: RpcDriver): Rpc {
    return {
        ...driver,
        listeners: new Map(),
    };
}

/**
 * register a handler for a command, scoped to `room`. returns the
 * registered entry so callers can hold it as data and pass it to
 * `unlisten` later, no closure-based unsubscribe, callers are
 * responsible for the bookkeeping.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listen(rpc: Rpc, commandId: string, fn: (...args: any[]) => void, room: string): ListenerEntry {
    let set = rpc.listeners.get(commandId);
    if (!set) {
        set = new Set();
        rpc.listeners.set(commandId, set);
    }
    const entry: ListenerEntry = { fn, room };
    set.add(entry);
    return entry;
}

/** remove a previously-registered listener entry. no-op if already gone. */
export function unlisten(rpc: Rpc, commandId: string, entry: ListenerEntry): void {
    rpc.listeners.get(commandId)?.delete(entry);
}

/**
 * resolve, unpack, and invoke listeners for an inbound NetMessage. handlers
 * are called as `fn(args, from)`; the server passes the originating client
 * as `from`, the client passes nothing (server→client handlers register
 * with a `(data) => void` shape and ignore the extra arg). matches entries
 * whose `room` equals the message's roomId.
 *
 * commandIndex → id via `commandProtocolTable` (caller passes it from the
 * current ProjectModule); def (serdes) via the live `commandsRegistry`.
 * stale `CommandHandle.serdes` captured in user closures is not consulted
 * on the dispatch path.
 */
export function dispatchNetMessage(rpc: Rpc, commandProtocolTable: ProtocolTable, message: NetMessage, from: unknown | undefined): void {
    const commandId = commandProtocolTable.indexToId[message.commandIndex];
    if (commandId === undefined) return;
    const def = get(registry.commands, commandId);
    if (!def) return;

    const set = rpc.listeners.get(def.id);
    if (!set || set.size === 0) return;

    let args: Record<string, unknown>;
    try {
        args = def.serdes.unpack(message.payload) as Record<string, unknown>;
    } catch (e) {
        console.error('[bongle] failed to unpack net message args:', e);
        return;
    }

    for (const entry of set) {
        if (entry.room !== message.roomId) continue;
        try {
            entry.fn(args, from);
        } catch (err) {
            logScriptError(`listen '${def.id}' handler`, err);
        }
    }
}

/**
 * resolve, pack, and dispatch an outbound command. side-agnostic, server
 * and client both reach the wire via the same path. the script `send(ctx,
 * ...)` API in scene/scripts wraps this with ctx-derived runtime/rpc/roomId.
 * `client` is the addressee for server-side targeted sends; omit for the
 * broadcast path.
 *
 * commandIndex via `commandProtocolTable` (caller passes it from the current
 * ProjectModule); serdes via the live `commandsRegistry`. stale
 * `CommandHandle.serdes` captured in user closures is not used, closures
 * resolve fresh serdes on every send.
 */
export function send<S extends pack.Schema, D extends RpcDirection>(
    rpc: Rpc,
    commandProtocolTable: ProtocolTable,
    handle: CommandHandle<S, D>,
    data: pack.SchemaType<S>,
    roomId: string,
    client?: unknown,
): void {
    const index = commandProtocolTable.idToIndex.get(handle.id);
    if (index === undefined) {
        console.warn(`[rpc] unknown command (not in wire index): ${handle.id}`);
        return;
    }
    const def = get(registry.commands, handle.id);
    if (!def) {
        console.warn(`[rpc] no registered def for command: ${handle.id}`);
        return;
    }
    const payload = def.serdes.pack(data);
    const isClientToServer = handle.direction === CLIENT_TO_SERVER;
    if (isClientToServer || client) {
        rpc.send(index, roomId, payload, client);
    } else {
        rpc.broadcast(index, roomId, payload);
    }
}

/* ── types ───────────────────────────────────────────────────────── */

/** a command handle returned by command(). */
export type CommandHandle<S extends pack.Schema, D extends RpcDirection> = {
    readonly id: string;
    /** DepGraph dependency, see SceneHandle.dependency. */
    dependency: { registry: 'commands'; id: string };
    readonly direction: D;
    readonly schema: S;
    readonly serdes: ReturnType<typeof pack.build>;
};

/** internal def stored in registry. */
export type CommandDef = {
    id: string;
    direction: RpcDirection;
    schema: pack.Schema;
    serdes: ReturnType<typeof pack.build>;
};

/* ── command() ─────────────────────────────────────────────────────── */

/**
 * define a command. commands are typed network messages.
 *
 * direction determines where send() can be called and where listen() receives:
 * - CLIENT_TO_SERVER: client sends to server (routed via room), server listens per-room
 * - SERVER_TO_CLIENT: server sends/broadcasts to client, client listens
 *
 * handlers are NOT in the definition, they are registered in scripts via listen().
 *
 * ```ts
 * const placeBlock = command('place_block', CLIENT_TO_SERVER, p.object({
 *   x: p.int32(),
 *   y: p.int32(),
 *   z: p.int32(),
 *   blockId: p.string(),
 * }))
 *
 * // in client script:
 * send(ctx, placeBlock, { x: 0, y: 0, z: 0, blockId: 'stone' })
 *
 * // in server script:
 * listen(ctx, placeBlock, (args, from) => { ... })
 * ```
 */
export function command<S extends pack.Schema, D extends RpcDirection>(id: string, direction: D, schema: S): CommandHandle<S, D> {
    const serdes = pack.build(schema);

    const def: CommandDef = {
        id,
        direction,
        schema,
        serdes,
    };

    upsert(registry.commands, id, def);
    recordCommand(id);

    return {
        id,
        dependency: { registry: 'commands', id },
        direction,
        schema,
        serdes,
    };
}
