// editor/realms/server/server-manager.ts — a stable handle to the server worker
// that can be RESTARTED under its consumers.
//
// The raw ServerHost is a one-worker handle: dispose kills it, and a new worker
// is a new object. But clientHost, useMultiplayer, the fs-change fan-out, and
// devtools all captured the host by value at boot — handing them a new object on
// restart would strand them on the dead worker. So this wraps the host in a
// facade whose identity never changes: every method delegates to the CURRENT
// worker host, and `restart()` swaps that host out underneath.
//
// restart() is graceful: it awaits the old worker's flush+drain (dispose) before
// respawning, and awaits the fresh worker's `ready` before returning — so the new
// worker reads current bytes off OPFS and the sim is live before callers rejoin
// their clients. Rejoining the client iframes is the caller's job (they own the
// iframes); it happens after this resolves.

import { type ServerHost, type SpawnServerWorkerOptions, spawnServerWorker } from './server-host';

export type ServerManager = ServerHost & {
    /** dispose the current worker (graceful flush to OPFS), respawn it against the
     *  same project, and await its `ready`. Clients must be rejoined afterwards —
     *  terminating the worker dropped their transports. */
    restart(): Promise<void>;
};

export function createServerManager(opts: SpawnServerWorkerOptions): ServerManager {
    // the live worker host. Every facade method reads through this, so a restart
    // is invisible to everything holding the facade.
    let active = spawnServerWorker(opts);

    return {
        // `ready` reflects the CURRENT worker (a getter, so it re-reads after a
        // restart). Boot reads it once for initial layout; that captures the first
        // worker's promise, which is exactly right.
        get ready() {
            return active.ready;
        },
        joinClient: (connectionId, port, meta) => active.joinClient(connectionId, port, meta),
        leaveClient: (connectionId) => active.leaveClient(connectionId),
        relayFsChange: (path) => active.relayFsChange(path),
        dispose: () => active.dispose(),
        async restart() {
            // fully tear down (flush + drain + terminate) BEFORE respawning: the
            // fresh worker opens the same OPFS project, so it must not race the old
            // worker's final save. dispose resolves only once those bytes landed.
            await active.dispose();
            active = spawnServerWorker(opts);
            await active.ready;
        },
    };
}
