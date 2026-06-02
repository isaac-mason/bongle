// api/rooms.ts — script-facing rooms surface.
//
// Polymorphic verbs: most accept any ScriptContext and dispatch on
// ctx.server vs ctx.client. Membership verbs (join/leave/swap) are
// server-only; active/observed are client-only.
//
// Namespace gating: every authored verb requires the target room to
// be in the caller's namespace. Reaching into another namespace from
// authored code is rejected — only the editor's Admin path bypasses
// this gate.

import type { Client } from '@bongle/interface';
import { env } from 'bongle';
import type { PlayerMode } from '../core/protocol';
import type { ScriptContext } from '../core/scene/scripts';
import * as Net from '../server/net';
import * as ServerRooms from '../server/rooms';
import * as ClientRooms from '../client/rooms';

/* ── helpers ─────────────────────────────────────────────────────── */

function callerNamespace(ctx: ScriptContext): string {
    return ctx.server?.room.namespace ?? ctx.client?.room?.namespace ?? 'main';
}

function assertSameNamespace(callerNs: string, targetNs: string, roomId: string): void {
    if (callerNs !== targetNs) {
        throw new Error(`[bongle] rooms: room '${roomId}' (namespace '${targetNs}') is outside caller's namespace '${callerNs}'`);
    }
}

/* ── lifecycle ───────────────────────────────────────────────────── */

/**
 * Create a new room from a scene id.
 *
 * Server: allocates a server room in the caller's namespace, never as
 * a namespace root. Returns the new roomId.
 *
 * Client: creates a local-only ClientRoom from a scene() handle (Phase 8).
 */
export function create(
    ctx: ScriptContext,
    sceneId: string,
    o?: { mode?: PlayerMode; sourceRoomId?: string },
): string {
    if (env.server && ctx.server) {
        const ns = callerNamespace(ctx);
        const room = ServerRooms.createRoomInNamespace(
            ctx.server.state,
            sceneId,
            o?.mode ?? 'play',
            ns,
            false,
            o?.sourceRoomId,
        );
        return room.id;
    }
    if (env.client && ctx.client?.state) {
        if (ctx.client.clientId === undefined) {
            throw new Error('[bongle] rooms.create (client): clientId not assigned yet');
        }
        const room = ClientRooms.startLocalRoom({
            state: ctx.client.state,
            clientId: ctx.client.clientId,
            sceneId,
            playerMode: o?.mode ?? 'play',
            roomMode: o?.mode ?? 'play',
            namespace: callerNamespace(ctx),
        });
        return room.roomId;
    }
    throw new Error('[bongle] rooms.create: ctx has neither server nor client');
}

/**
 * Stop a room.
 *
 * Server: destroys the server room. If it's the namespace root, the
 * stop cascades to every other room in the namespace. Forbidden across
 * namespaces.
 *
 * Client: disposes a local ClientRoom; throws on server-mirrored rooms
 * (those are membership-driven, not script-controlled).
 */
export function stop(ctx: ScriptContext, roomId: string): void {
    if (env.server && ctx.server) {
        const target = ServerRooms.getRoom(ctx.server.state.rooms, roomId);
        if (!target) return;
        assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
        ServerRooms.queueStopRoom(ctx.server.state.rooms, roomId);
        return;
    }
    if (env.client && ctx.client?.state) {
        const rooms = ctx.client.state.rooms;
        const target = ClientRooms.findRoomByRoomId(rooms, roomId);
        if (!target) return;
        assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
        ClientRooms.stopLocalRoom(rooms, roomId);
        return;
    }
    throw new Error('[bongle] rooms.stop: ctx has neither server nor client');
}

/* ── active control ──────────────────────────────────────────────── */

/**
 * Activate a room — make it the focused view.
 *
 * Server form (4 args): instructs `client` to activate (roomId, mode).
 * Sends an `activate_room` message over the per-client outbox.
 *
 * Client form (3 args): switches the local active view among rooms the
 * client already observes (server-mirrored or local).
 */
export function activate(
    ctx: ScriptContext,
    client: Client,
    roomId: string,
    o?: { mode?: PlayerMode },
): void;
export function activate(ctx: ScriptContext, roomId: string, o?: { mode?: PlayerMode }): void;
export function activate(
    ctx: ScriptContext,
    a: Client | string,
    b?: string | { mode?: PlayerMode },
    c?: { mode?: PlayerMode },
): void {
    // server form: (ctx, client, roomId, opts?)
    if (typeof a !== 'string') {
        if (!env.server) {
            throw new Error('[bongle] rooms.activate (server form): not in a server bundle');
        }
        if (!ctx.server) {
            throw new Error('[bongle] rooms.activate (server form): called without a server context');
        }
        const client = a;
        const roomId = b as string;
        const mode = c?.mode ?? 'play';
        const target = ServerRooms.getRoom(ctx.server.state.rooms, roomId);
        if (!target) throw new ServerRooms.RoomNotFoundError(roomId);
        assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
        const player = ServerRooms.findPlayer(ctx.server.state.rooms, client, roomId, mode);
        if (!player) {
            throw new Error(`[bongle] rooms.activate: client has no Player in (room '${roomId}', mode '${mode}')`);
        }
        ServerRooms.setActivePlayer(ctx.server.state.rooms, client, player.id);
        Net.send(ctx.server.state.net, client, { type: 'activate_room', playerId: player.id });
        return;
    }

    // client form: (ctx, roomId, opts?)
    if (!env.client) {
        throw new Error('[bongle] rooms.activate (client form): not in a client bundle');
    }
    if (!ctx.client?.state) {
        throw new Error('[bongle] rooms.activate (client form): called without a client context');
    }
    const roomId = a;
    const mode = (b as { mode?: PlayerMode } | undefined)?.mode;
    const rooms = ctx.client.state.rooms;
    let target: ClientRooms.ClientRoom | undefined;
    for (const r of rooms.rooms.values()) {
        if (r.roomId === roomId && (!mode || r.playerMode === mode)) {
            target = r;
            break;
        }
    }
    if (!target) {
        throw new Error(`[bongle] rooms.activate: client is not observing (room '${roomId}'${mode ? `, mode '${mode}'` : ''})`);
    }
    assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
    ClientRooms.setActivePlayer(rooms, ctx.client.state.net, ctx.client.state.voxelResources, target.playerId);
}

/* ── enumeration ─────────────────────────────────────────────────── */

/**
 * List rooms visible to the caller — all roomIds in the caller's
 * namespace (server) or all roomIds the client observes (client).
 */
export function list(ctx: ScriptContext): string[] {
    if (env.server && ctx.server) {
        const ns = callerNamespace(ctx);
        return ServerRooms.findRoomsInNamespace(ctx.server.state.rooms, ns).map((r) => r.id);
    }
    if (env.client && ctx.client?.state) {
        const out = new Set<string>();
        for (const r of ctx.client.state.rooms.rooms.values()) out.add(r.roomId);
        return [...out];
    }
    throw new Error('[bongle] rooms.list: ctx has neither server nor client');
}

/* ── cross-room access ──────────────────────────────────────────── */

/**
 * Return a ScriptContext pointing at another room. Returns null if the
 * target is unknown (or in a different namespace, server) or not
 * observed (client). Mutation through the returned context is allowed
 * — advanced; it bypasses the calling room's tick boundaries.
 */
export function view(
    ctx: ScriptContext,
    roomId: string,
    o?: { mode?: PlayerMode },
): ScriptContext | null {
    if (env.server && ctx.server) {
        const target = ServerRooms.getRoom(ctx.server.state.rooms, roomId);
        if (!target) return null;
        if (target.namespace !== callerNamespace(ctx)) return null;
        const rt = target.scriptRuntime;
        return {
            mode: target.mode,
            project: rt.project,
            node: target.nodes.root,
            nodes: target.nodes,
            voxels: target.voxels,
            physics: target.physics,
            blocks: rt.blocks,
            client: undefined,
            server: { state: ctx.server.state, room: target },
            _runtime: rt,
            _instance: ctx._instance,
            trait: ctx.trait,
        };
    }
    if (env.client && ctx.client?.state) {
        const mode = o?.mode;
        let target: ClientRooms.ClientRoom | undefined;
        for (const r of ctx.client.state.rooms.rooms.values()) {
            if (r.roomId !== roomId) continue;
            if (mode && r.playerMode !== mode) continue;
            // when mode is unspecified and the client holds two views, refuse to guess
            if (target) return null;
            target = r;
        }
        if (!target) return null;
        if (target.namespace !== callerNamespace(ctx)) return null;
        const rt = target.scriptRuntime;
        return {
            mode: target.playerMode,
            project: rt.project,
            node: target.nodes.root,
            nodes: target.nodes,
            voxels: target.voxels,
            physics: target.physics,
            blocks: rt.blocks,
            client: rt.client,
            server: undefined,
            _runtime: rt,
            _instance: ctx._instance,
            trait: ctx.trait,
        };
    }
    throw new Error('[bongle] rooms.view: ctx has neither server nor client');
}

/* ── membership (server-only) ───────────────────────────────────── */

/**
 * Add `client` as a Player in `roomId`. Does NOT activate; pair with
 * rooms.activate when the new view should become focused.
 */
export function join(
    ctx: ScriptContext,
    client: Client,
    roomId: string,
    o?: { mode?: PlayerMode },
): void {
    if (!env.server) throw new Error('[bongle] rooms.join: server-only');
    if (!ctx.server) throw new Error('[bongle] rooms.join: server-only');
    const target = ServerRooms.getRoom(ctx.server.state.rooms, roomId);
    if (!target) throw new ServerRooms.RoomNotFoundError(roomId);
    assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
    ServerRooms.addClientToRoom(ctx.server.state, client, target, o?.mode);
}

/**
 * Remove `client`'s Player from `roomId`. Does NOT auto-destroy the
 * room when empty — use rooms.stop explicitly.
 */
export function leave(
    ctx: ScriptContext,
    client: Client,
    roomId: string,
    o?: { mode?: PlayerMode },
): void {
    if (!env.server) throw new Error('[bongle] rooms.leave: server-only');
    if (!ctx.server) throw new Error('[bongle] rooms.leave: server-only');
    const target = ServerRooms.getRoom(ctx.server.state.rooms, roomId);
    if (!target) return;
    assertSameNamespace(callerNamespace(ctx), target.namespace, roomId);
    const mode = o?.mode ?? target.mode;
    const player = ServerRooms.findPlayer(ctx.server.state.rooms, client, roomId, mode);
    if (!player) return;
    ServerRooms.leaveClientFromRoom(ctx.server.state, player.id);
}

/**
 * Move `client` from one room to another. Composes leave + join +
 * activate. `fromRoomId` defaults to the client's currently active
 * room. mode defaults to the destination room's mode.
 */
export function swap(
    ctx: ScriptContext,
    client: Client,
    toRoomId: string,
    o?: { fromRoomId?: string; mode?: PlayerMode },
): void {
    if (!env.server) throw new Error('[bongle] rooms.swap: server-only');
    if (!ctx.server) throw new Error('[bongle] rooms.swap: server-only');
    const state = ctx.server.state;
    const target = ServerRooms.getRoom(state.rooms, toRoomId);
    if (!target) throw new ServerRooms.RoomNotFoundError(toRoomId);
    const callerNs = callerNamespace(ctx);
    assertSameNamespace(callerNs, target.namespace, toRoomId);

    const fromRoomId = o?.fromRoomId ?? ServerRooms.getActivePlayer(state.rooms, client)?.roomId;
    const mode = o?.mode ?? target.mode;

    if (fromRoomId) {
        const from = ServerRooms.getRoom(state.rooms, fromRoomId);
        if (from) {
            assertSameNamespace(callerNs, from.namespace, fromRoomId);
            const fromPlayer = ServerRooms.findPlayer(state.rooms, client, fromRoomId, mode);
            if (fromPlayer) ServerRooms.leaveClientFromRoom(state, fromPlayer.id);
        }
    }

    const player = ServerRooms.addClientToRoom(state, client, target, mode);
    Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
}

/* ── client-only observation ─────────────────────────────────────── */

/** The client's active room view, or null. */
export function active(ctx: ScriptContext): { roomId: string; mode: PlayerMode } | null {
    if (!env.client) throw new Error('[bongle] rooms.active: client-only');
    if (!ctx.client?.state) throw new Error('[bongle] rooms.active: client-only');
    const r = ClientRooms.getActiveRoom(ctx.client.state.rooms);
    if (!r) return null;
    return { roomId: r.roomId, mode: r.playerMode };
}

/** Every (roomId, mode) the client is currently observing. */
export function observed(
    ctx: ScriptContext,
): { roomId: string; mode: PlayerMode; local: boolean }[] {
    if (!env.client) throw new Error('[bongle] rooms.observed: client-only');
    if (!ctx.client?.state) throw new Error('[bongle] rooms.observed: client-only');
    const out: { roomId: string; mode: PlayerMode; local: boolean }[] = [];
    for (const r of ctx.client.state.rooms.rooms.values()) {
        out.push({ roomId: r.roomId, mode: r.playerMode, local: r.local });
    }
    return out;
}
