// editor/stores/server.ts — the server realm's lifecycle for the UI. The realm
// stack (bundler → pipeline → server → clients) is started lazily: project mode
// boots it at load, avatar mode on demand (first "+ client" / "Start server"). This
// store holds the start thunk + the manager (once started) and drives start/restart.

import { create } from 'zustand';
import type { ServerManager } from '../realms/server/server-manager';
import { useClients } from './clients';

// idle: realms not started yet (avatar mode pre-preview). starting: startRealms in
// flight. running: server live. restarting: rebooting the worker in place. failed:
// the first boot ran but the server never came up (e.g. a bad import) — the manager
// still exists, so recovery is an in-place `restart`, NOT re-running the starter
// (which would spawn a duplicate worker stack).
type ServerStatus = 'idle' | 'starting' | 'running' | 'restarting' | 'failed';

type ServerStore = {
    status: ServerStatus;
    manager: ServerManager | null;
    /** the current realm-boot phase (e.g. "baking assets", "starting server"), shown
     *  by the top-bar preview chip while the stack comes up. '' when there's nothing
     *  in flight. Set by startRealms at each milestone; cleared on running/failed. */
    phase: string;
    /** boot the realm stack (idempotent, memoized in main.tsx). Null until wired, and
     *  absent for a guest session (no local realms) — which is how the UI knows there's
     *  nothing to start. */
    starter: (() => Promise<void>) | null;
    /** wire the start thunk (main.tsx, at boot). */
    setStarter: (starter: () => Promise<void>) => void;
    /** update the boot-phase label shown by the preview chip. */
    setPhase: (phase: string) => void;
    /** wire the manager once the realm stack has created it (called by startRealms). */
    init: (manager: ServerManager) => void;
    /** start the realm stack for the first time. No-op unless idle + startable. */
    start: () => Promise<void>;
    /** reboot the server worker (flushes to disk), then rejoin open clients. Works
     *  from `running` (healthy restart) and `failed` (retry a bad first boot) — both
     *  swap the worker in place via the manager, so no duplicate stack is spawned.
     *  No-op if the manager was never created (a rare pre-server boot failure). */
    restart: () => Promise<void>;
};

export const useServer = create<ServerStore>((set, get) => ({
    status: 'idle',
    manager: null,
    phase: '',
    starter: null,
    setStarter: (starter) => set({ starter }),
    setPhase: (phase) => set({ phase }),
    init: (manager) => set({ manager }),
    start: async () => {
        const { status, starter } = get();
        if (status !== 'idle' || !starter) return;
        set({ status: 'starting', phase: 'starting preview' });
        try {
            await starter();
            set({ status: 'running', phase: '' });
        } catch {
            // the manager was created before the failing await, so recovery is an
            // in-place `restart` — mark `failed` (not `idle`) so the UI offers that
            // rather than re-running the starter (which spawns a duplicate stack).
            set({ status: 'failed', phase: '' });
        }
    },
    restart: async () => {
        const { manager, status } = get();
        if (!manager || (status !== 'running' && status !== 'failed')) return;
        set({ status: 'restarting', phase: 'restarting server' });
        try {
            await manager.restart();
            // the fresh worker is `ready`; reconnect the open client iframes (their
            // transports died with the old worker), and mount the preview shell if a
            // failed first boot left it waiting (recovery restart).
            useClients.getState().host?.rejoinAll();
            useClients.getState().attachPending();
            set({ status: 'running', phase: '' });
        } catch {
            set({ status: 'failed', phase: '' });
        }
    },
}));
