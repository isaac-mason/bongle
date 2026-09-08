// build/dev/host.ts, the parts every dev host assembles around the engine, kept
// engine-free: the loops, the inert dev-driver pieces, the editor net-sim binding
// and the avatar picker. Engine modules and stores arrive as parameters, never as
// imports: the browser editor reaches its engine only through a runner, and a
// static engine import here would be a second instance.

import { RIG_TYPE_6BONE } from '../../avatar/index';
import {
    type AvatarsServerDriver,
    Channel,
    type Client,
    type ClientDriver,
    type ClientUser,
    type JsonValue,
    type Platform,
    type ResolvedAvatar,
    type ServerApp,
    type ServerInitOptions,
    type User,
} from '../../interface/index';
import { createNetSim, type NetSim, type NetSimConfig, type NetSimSinks } from './net-sim';

/* ── loops ── */

/** a requestAnimationFrame loop around `step`; returns stop. the next frame is
 *  scheduled before the work and the work is bracketed, so a throw out of a step
 *  (a bad block state, a script error) costs one frame instead of killing the loop
 *  for good. repeats of one message are counted, not reprinted, so a per-frame
 *  throw cannot bury every other line. */
export function frameLoop(
    step: (dt: number, now: number) => void,
    o?: { onError?: (message: string) => void; onFirstFrame?: () => void },
): () => void {
    const report = o?.onError ?? ((message: string) => console.error(message));
    let last = performance.now();
    let lastError = '';
    let repeats = 0;
    let frames = 0;
    let handle = 0;
    const frame = (now: number) => {
        handle = requestAnimationFrame(frame);
        const dt = (now - last) / 1000;
        last = now;
        // the first call only schedules and runs frame 0's step
        if (frames++ === 1) o?.onFirstFrame?.();
        try {
            step(dt, now);
        } catch (err) {
            const message = String((err as Error)?.stack ?? err);
            if (message === lastError) {
                repeats++;
                return;
            }
            lastError = message;
            report(`frame error${repeats > 0 ? ` (previous repeated ${repeats}x)` : ''}: ${message}`);
            repeats = 0;
        }
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
}

/** a setInterval loop around `step` at `hz`; returns stop. a throw is reported,
 *  not fatal. */
export function serverTick(step: (dt: number) => void, hz: number, o?: { onError?: (message: string) => void }): () => void {
    const report = o?.onError ?? ((message: string) => console.error(message));
    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        try {
            step(dt);
        } catch (err) {
            report(`tick error: ${(err as Error)?.message ?? String(err)}`);
        }
    }, 1000 / hz);
    return () => clearInterval(timer);
}

/* ── the inert dev driver ── */

/** no ads outside a platform. */
export const inertPlatform: Platform = { commercialBreak: async () => {}, rewardedBreak: async () => false };

/** the stand-in local identity a dev host plays as (no session, no account). */
export function devUser(avatar: ResolvedAvatar): ClientUser {
    return { id: 'dev', username: 'dev', avatar };
}

/** a `transfer` that says so rather than failing silently: this host has nowhere
 *  to send the player. */
export function transferNotWired(why: string): ClientDriver['transfer'] {
    return async ({ slug }) => {
        console.warn(`[bongle] client.transfer to '${slug}': ${why}, staying here`);
        return false;
    };
}

/* ── the editor net-sim ── */

/** the debug-pane knobs the net-sim reads. structurally the editor store's fields,
 *  so the store is handed in rather than imported. */
export type NetSimKnobs = {
    netSimEnabled: boolean;
    netSimRttMs: number;
    netSimJitterMs: number;
    netSimBurstMs: number;
    netSimBurstChance: number;
};

/** the latency sim between the game transport and the engine, driven live by the
 *  editor's debug pane. inbound is always engine bytes; outbound is whatever the
 *  transport sends. */
export function editorNetSim<Out>(
    knobs: { getState(): NetSimKnobs },
    sinks: NetSimSinks<Uint8Array, Out>,
): NetSim<Uint8Array, Out> {
    const config = (): NetSimConfig => {
        const s = knobs.getState();
        return {
            enabled: s.netSimEnabled,
            rttMs: s.netSimRttMs,
            jitterMs: s.netSimJitterMs,
            burstMs: s.netSimBurstMs,
            burstChance: s.netSimBurstChance,
        };
    };
    return createNetSim<Uint8Array, Out>(config, sinks);
}

/* ── the avatar picker ── */

export type AvatarPicker = {
    /** the avatar a joining client wears: the local one when set, else a random
     *  sample from the driver's pool, else undefined (the engine's builtin). */
    resolve(): ResolvedAvatar | undefined;
    /** the local avatar's file was rewritten at the same url: mint a fresh modelId so
     *  the CharacterTrait reconciler swaps rigs (the same id would be a no-op).
     *  returns the new avatar for the host to re-stamp onto connected clients, or
     *  undefined when there is no local avatar. */
    reload(): ResolvedAvatar | undefined;
};

/** per-join avatar choice for a dev server. a platform-supplied local avatar (the
 *  edited one, or the account's) overrides a random pick from the driver's sample
 *  pool, so a join wears a real avatar instead of the builtin fallback. */
export async function avatarPicker(avatars: AvatarsServerDriver, o?: { local?: string }): Promise<AvatarPicker> {
    let pool: ResolvedAvatar[] = [];
    try {
        pool = await avatars.sample();
    } catch {
        // an empty pool: joins get the builtin.
    }
    let version = 0;
    const local = (): ResolvedAvatar | undefined =>
        o?.local
            ? {
                  source: 'runtime',
                  modelId: `local-player-avatar@${version}`,
                  clientUrl: o.local,
                  serverUrl: o.local,
                  rigType: RIG_TYPE_6BONE,
              }
            : undefined;
    let current = local();
    return {
        resolve: () => current ?? (pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : undefined),
        reload: () => {
            version++;
            current = local();
            return current;
        },
    };
}

/* ── the client table ── */

/** one connected client's pipe, as the host's socket presents it. */
export type ClientConn = { send(bytes: Uint8Array): void; close(): void };

/** the connected clients of one server: the map the engine's `send` closes over
 *  (created BEFORE the engine) plus the id allocator. a client with no conn (left,
 *  or never joined) is a silent drop. */
export type ClientTable = {
    conns: Map<Client, ClientConn>;
    nextClientId: Client;
    send: ServerInitOptions['send'];
};

export function createClientTable(): ClientTable {
    const conns = new Map<Client, ClientConn>();
    return { conns, nextClientId: 1, send: (client, _channel, bytes) => conns.get(client)?.send(bytes) };
}

export type ClientMember = {
    clientId: Client;
    /** an inbound frame for the engine. */
    receive(bytes: Uint8Array): void;
    /** the client went away: onClientLeave once, a second call is a no-op. */
    leave(): void;
};

/** a connection became a client: allocate its id, onClientJoin, and hand back its
 *  receive + leave. a join that throws closes the conn and returns null. */
export function joinClient<S>(
    table: ClientTable,
    app: ServerApp<S>,
    state: S,
    conn: ClientConn,
    user: User,
    joinData: Record<string, JsonValue>,
    avatar: ResolvedAvatar | undefined,
): ClientMember | null {
    const clientId: Client = table.nextClientId++;
    table.conns.set(clientId, conn);
    try {
        app.onClientJoin(state, clientId, user, joinData, avatar);
    } catch (err) {
        console.error(`[game-transport] onClientJoin threw for ${clientId}:`, err);
        table.conns.delete(clientId);
        conn.close();
        return null;
    }
    return {
        clientId,
        receive: (bytes) => app.receive(state, clientId, Channel.RELIABLE, bytes),
        leave: () => {
            if (!table.conns.delete(clientId)) return;
            try {
                app.onClientLeave(state, clientId);
            } catch (err) {
                console.error(`[game-transport] onClientLeave threw for ${clientId}:`, err);
            }
        },
    };
}

/** shutdown: close every conn without a leave (the rooms are going away whole). */
export function closeClients(table: ClientTable): void {
    const open = [...table.conns.values()];
    table.conns.clear();
    for (const conn of open) conn.close();
}
