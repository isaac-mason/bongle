// editor/stores/server.ts — the server realm's lifecycle for the UI. Holds the
// manager (set once at boot) and a restart status the server app reflects, and
// drives a restart: reboot the worker (graceful flush to disk) then reconnect the
// open client windows to the fresh worker.

import { create } from 'zustand';
import type { ServerManager } from '../realms/server/server-manager';
import { useClients } from './clients';

type ServerStatus = 'running' | 'restarting';

type ServerStore = {
    status: ServerStatus;
    manager: ServerManager | null;
    /** wire the manager created at boot. */
    init: (manager: ServerManager) => void;
    /** reboot the server worker (flushes to disk), then rejoin open clients.
     *  No-op while already restarting or before the manager is wired. */
    restart: () => Promise<void>;
};

export const useServer = create<ServerStore>((set, get) => ({
    status: 'running',
    manager: null,
    init: (manager) => set({ manager }),
    restart: async () => {
        const { manager, status } = get();
        if (!manager || status === 'restarting') return;
        set({ status: 'restarting' });
        try {
            await manager.restart();
            // the fresh worker is `ready`; reconnect the open client iframes (their
            // transports died with the old worker).
            useClients.getState().host?.rejoinAll();
        } finally {
            set({ status: 'running' });
        }
    },
}));
