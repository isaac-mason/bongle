// editor/stores/clients.ts — the open client windows. Each is its own iframe
// realm (own registry + input + canvas) connected to the one server worker, so
// opening several is multiplayer-in-a-tab. The host is set once at boot; `open`
// spawns a fresh client, `close` disposes it (dropping its server connection).

import { create } from 'zustand';
import type { ClientConnection, ClientHost } from '../realms/client/client-host';
import { useServer } from './server';
import { useWindows } from './windows';

// connection is null while a window is a preview SHELL — framed eagerly at boot so
// the user sees the play surface (with a boot status inside it) instead of a blank
// desktop while the realm stack comes up. attachPending() fills it once the server
// is live and the iframe mounts.
export type ClientWindow = { id: string; title: string; connection: ClientConnection | null };

let count = 0;

type ClientsStore = {
    host: ClientHost | null;
    windows: ClientWindow[];
    /** the shell window awaiting a connection (see openShell/attachPending), or null. */
    pending: string | null;
    setHost: (host: ClientHost) => void;
    /** frame the primary preview window NOW, before the realm stack is up, showing a
     *  boot status in place of the iframe. Its connection mounts on attachPending().
     *  Returns the window id (for the caller to snap it full). */
    openShell: () => string;
    /** give the pending shell window a live connection (mounts its iframe). Called once
     *  the server is running (initial boot or a recovery restart); no-op if nothing is
     *  pending or the host isn't up yet. */
    attachPending: () => void;
    /** spawn a client window; returns its window id (for e.g. maximizing it). */
    open: () => string;
    close: (id: string) => void;
    /** reload every open client iframe — respawns each client realm (fresh registry
     *  + reconnect to the server + bundler). Backs the "reload all" action and the
     *  post-restart rejoin. */
    reloadAll: () => void;
};

export const useClients = create<ClientsStore>((set, get) => ({
    host: null,
    windows: [],
    pending: null,
    setHost: (host) => set({ host }),
    openShell: () => {
        const id = 'client:preview';
        useWindows.getState().register(id, { x: 780, y: 40, w: 480, h: 360 });
        set((s) => ({ windows: [...s.windows, { id, title: 'client', connection: null }], pending: id }));
        useWindows.getState().focus(id);
        return id;
    },
    attachPending: () => {
        const { host, pending } = get();
        if (!host || !pending) return;
        const connection = host.createClient();
        set((s) => ({
            windows: s.windows.map((w) =>
                w.id === pending ? { ...w, title: `client ${connection.connectionId}`, connection } : w,
            ),
            pending: null,
        }));
    },
    open: () => {
        const host = get().host;
        if (!host) {
            // Avatar mode, pre-preview: the realm stack isn't up yet. Start it, then
            // open once the server + client host exist. (Cross-store call at run time,
            // not module-eval, so the server↔clients import cycle is fine.)
            void useServer
                .getState()
                .start()
                .then(() => get().open());
            return '';
        }
        const connection = host.createClient();
        const id = `client:${connection.connectionId}`;
        const off = (count++ % 6) * 28;
        useWindows.getState().register(id, { x: 780 + off, y: 40 + off, w: 480, h: 360 });
        set((s) => ({ windows: [...s.windows, { id, title: `client ${connection.connectionId}`, connection }] }));
        useWindows.getState().focus(id);
        return id;
    },
    close: (id) =>
        set((s) => {
            s.windows.find((w) => w.id === id)?.connection?.dispose();
            return {
                windows: s.windows.filter((w) => w.id !== id),
                pending: s.pending === id ? null : s.pending,
            };
        }),
    reloadAll: () => get().host?.rejoinAll(),
}));
