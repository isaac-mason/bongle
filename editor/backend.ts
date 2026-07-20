// editor/backend.ts — the one seam between a HOST editor and a GUEST editor.
//
// The Desktop + every app is backend-blind: they take a Filesystem and drive
// client windows through the ClientHost, unaware whether those resolve to local
// OPFS + local worker realms (host) or the host's project over the relay (guest).
// main.tsx builds one of these and hands `fs` to the Desktop + `host` to the
// gated actions; nothing else needs to know which mode it's in.

import { create } from 'zustand';
import type { Filesystem } from './fs';
import type { ClientHost } from './realms/client/client-host';

export type EditorBackend = {
    /** OPFS (host) | createRemoteFilesystem over the relay fsrpc lane (guest). */
    fs: Filesystem;
    /** client (play) windows → local server worker (host) | relay lanes (guest). */
    clients: ClientHost;
    /** true = host (owns the workers + platform identity); false = guest. Gates the
     *  host-only actions (build/publish, save/draft, load-zip, open-to-multiplayer). */
    host: boolean;
};

// the `host` flag as a store so the gated action components can read it without
// threading the backend through every prop. Defaults to host; the guest boot flips
// it before the Desktop renders.
type SessionStore = { host: boolean; setHost: (host: boolean) => void };
export const useSession = create<SessionStore>((set) => ({
    host: true,
    setHost: (host) => set({ host }),
}));
