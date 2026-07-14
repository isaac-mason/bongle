// editor/net/host-session.ts — the host's guest-acceptor.
//
// When a host opens its session to multiplayer, it dials the relay room and
// hands the resulting socket here. Each guest that joins (surfaced as a control
// frame) is wired into the host's EXISTING subsystems exactly as a local client
// iframe is — the guest is "just another client," only reached over the relay:
//
//   game   : bridge ↔ server worker   (serverHost.joinClient — a real port)
//   bundler: bridge ↔ bundler worker  (connectRealm — a real port)
//   fsrpc  : served in-doc from OPFS   (serveFilesystemOverPort — no worker)
//
// The bridge pattern: serverHost/bundler expect a transferable MessagePort, but
// the relay lane is a PortLike living in this document. So per lane we make a
// MessageChannel — one end transferred to the worker, the other pumped byte-for-
// byte to/from the relay PortLike. The workers stay unchanged; only the pipe in
// front of them differs (local channel vs relay).

import type { Filesystem } from '../fs';
import type { ServerHost } from '../server/server-host';
import { Channel, createRelayHostLink, type PortLike, type SocketLike } from './relay-link';
import { serveFilesystemOverPort } from './remote-fs';

/** Guest connectionIds live above the local client iframe range so the server
 *  worker's connectionId→Client map never collides a guest with a local window. */
const GUEST_CONNECTION_BASE = 1_000_000;

/** The guest identity the relay room forwards in its guest-join control frame
 *  (from the reservation the matchmaker stamped). */
type GuestJoin = { type: 'guest-join'; localId: number; userId?: string; username?: string; permission?: string };
type GuestLeave = { type: 'guest-leave'; localId: number };
type ControlMessage = GuestJoin | GuestLeave;

export type HostSessionOptions = {
    /** the relay socket (a gatho RoomConnection adapted to SocketLike). */
    socket: SocketLike;
    /** the host's server worker — guests join it as ordinary clients. */
    serverHost: ServerHost;
    /** route a realm's bundler conduit to the bundler worker (main.tsx's
     *  connectRealm — the same one local realms use). */
    connectRealm: (env: string, port: MessagePort) => void;
    /** the host's authoritative project fs (OPFS); guests read through it. */
    fs: Filesystem;
    log?: (msg: string) => void;
    /** presence hooks — fired as guests connect/leave (drives the roster UI). */
    onGuestJoin?: (localId: number, user: { username: string }) => void;
    onGuestLeave?: (localId: number) => void;
};

export type HostSession = { close(): void };

/** Pump bytes/frames both ways between a worker-side MessagePort and a relay
 *  PortLike. Assigning onmessage implicitly starts the MessagePort. */
function bridge(port: MessagePort, relay: PortLike): void {
    port.onmessage = (e) => relay.postMessage(e.data);
    relay.onmessage = (e) => port.postMessage(e.data);
}

export function createHostSession(opts: HostSessionOptions): HostSession {
    const { socket, serverHost, connectRealm, fs, log = () => {}, onGuestJoin, onGuestLeave } = opts;
    const guests = new Map<number, { close(): void }>();

    const say = (m: string) => {
        console.log(`[mp:host] ${m}`);
        log(m);
    };

    const link = createRelayHostLink(socket, {
        onControl: (localId, message) => {
            const msg = message as ControlMessage;
            say(`control frame from guest ${localId}: ${msg?.type ?? 'unknown'}`);
            if (msg?.type === 'guest-join') addGuest(localId, msg);
            else if (msg?.type === 'guest-leave') removeGuest(localId);
        },
    });

    function addGuest(localId: number, join: GuestJoin): void {
        if (guests.has(localId)) return; // idempotent — duplicate join is ignored
        const connectionId = GUEST_CONNECTION_BASE + localId;

        // game lane: a channel to the server worker, bridged to the relay.
        const game = new MessageChannel();
        serverHost.joinClient(connectionId, game.port2, {
            user: { id: join.userId || `guest-${localId}`, username: join.username || `guest-${localId}` },
            joinData: {},
        });
        bridge(game.port1, link.guestPort(localId, Channel.game));

        // bundler lane: this guest's own realm graph, fed by the one host
        // DevServer (it transforms once, every realm evaluates).
        const bundler = new MessageChannel();
        connectRealm(`client:guest-${localId}`, bundler.port2);
        bridge(bundler.port1, link.guestPort(localId, Channel.bundler));

        // fsrpc lane: served straight from OPFS in this document (no worker).
        const fsServed = serveFilesystemOverPort(fs, link.guestPort(localId, Channel.fsrpc));

        guests.set(localId, {
            close() {
                fsServed.close();
                game.port1.close();
                bundler.port1.close();
                serverHost.leaveClient(connectionId);
                link.dropGuest(localId);
            },
        });
        say(`guest ${localId} (${join.username ?? 'anon'}) joined — wired game/bundler/fsrpc`);
        onGuestJoin?.(localId, { username: join.username || `guest-${localId}` });
    }

    function removeGuest(localId: number): void {
        const guest = guests.get(localId);
        if (!guest) return;
        guests.delete(localId);
        guest.close();
        say(`guest ${localId} left`);
        onGuestLeave?.(localId);
    }

    return {
        close() {
            for (const localId of [...guests.keys()]) removeGuest(localId);
            link.close();
        },
    };
}
