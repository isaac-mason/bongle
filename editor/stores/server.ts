// editor/stores/server.ts — the server realm's lifecycle for the UI. The realm
// stack (bundler → pipeline → server → clients) is started lazily: project mode
// boots it at load, avatar mode on demand (first "+ client" / "Start server"). This
// store holds the start thunk + the manager (once started) and drives start/restart.

import { create } from 'zustand';
import type { ServerManager } from '../realms/server/server-manager';
import { useClients } from './clients';

// idle: realms not started yet (avatar mode pre-preview). starting: startRealms in
// flight. running: server live. restarting: rebooting the worker in place.
type ServerStatus = 'idle' | 'starting' | 'running' | 'restarting';

type ServerStore = {
    status: ServerStatus;
    manager: ServerManager | null;
    /** boot the realm stack (idempotent, memoized in main.tsx). Null until wired, and
     *  absent for a guest session (no local realms) — which is how the UI knows there's
     *  nothing to start. */
    starter: (() => Promise<void>) | null;
    /** wire the start thunk (main.tsx, at boot). */
    setStarter: (starter: () => Promise<void>) => void;
    /** wire the manager once the realm stack has created it (called by startRealms). */
    init: (manager: ServerManager) => void;
    /** start the realm stack. No-op unless idle + startable. */
    start: () => Promise<void>;
    /** reboot the server worker (flushes to disk), then rejoin open clients.
     *  No-op unless running. */
    restart: () => Promise<void>;
};

export const useServer = create<ServerStore>((set, get) => ({
    status: 'idle',
    manager: null,
    starter: null,
    setStarter: (starter) => set({ starter }),
    init: (manager) => set({ manager }),
    start: async () => {
        const { status, starter } = get();
        if (status !== 'idle' || !starter) return;
        set({ status: 'starting' });
        try {
            await starter();
            set({ status: 'running' });
        } catch {
            set({ status: 'idle' }); // let a later attempt retry (startRealms resets too)
        }
    },
    restart: async () => {
        const { manager, status } = get();
        if (!manager || status !== 'running') return;
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
