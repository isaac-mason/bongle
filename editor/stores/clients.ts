// editor/stores/clients.ts — the open client windows. Each is its own iframe
// realm (own registry + input + canvas) connected to the one server worker, so
// opening several is multiplayer-in-a-tab. The host is set once at boot; `open`
// spawns a fresh client, `close` disposes it (dropping its server connection).

import { create } from 'zustand';
import type { ClientConnection, ClientHost } from '../client-host';
import { useWindows } from './windows';

export type ClientWindow = { id: string; title: string; connection: ClientConnection };

let count = 0;

type ClientsStore = {
    host: ClientHost | null;
    windows: ClientWindow[];
    setHost: (host: ClientHost) => void;
    open: () => void;
    close: (id: string) => void;
};

export const useClients = create<ClientsStore>((set, get) => ({
    host: null,
    windows: [],
    setHost: (host) => set({ host }),
    open: () => {
        const host = get().host;
        if (!host) return;
        const connection = host.createClient();
        const id = `client:${connection.connectionId}`;
        const off = (count++ % 6) * 28;
        useWindows.getState().register(id, { x: 780 + off, y: 40 + off, w: 480, h: 360 });
        set((s) => ({ windows: [...s.windows, { id, title: `client ${connection.connectionId}`, connection }] }));
        useWindows.getState().focus(id);
    },
    close: (id) =>
        set((s) => {
            s.windows.find((w) => w.id === id)?.connection.dispose();
            return { windows: s.windows.filter((w) => w.id !== id) };
        }),
}));
