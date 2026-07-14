// editor/stores/multiplayer.ts — host-side multiplayer session state.
//
// "Open to multiplayer" is opt-in: a solo edit session never touches the relay.
// When the host opts in, the editor asks the platform to allocate a relay room
// (/api/edit/host), then dials it and accepts guests through createHostSession.
// The store holds the share link + status for the UI; the deps (platform bridge,
// server worker, bundler conduit, fs) are injected once from main.tsx boot.

import { create } from 'zustand';
import type { Filesystem } from '../fs';
import { connectRelaySocket } from '../net/gatho-socket';
import { createHostSession, type HostSession } from '../net/host-session';
import type { PlatformBridge } from '../platform/bridge';
import type { ServerHost } from '../server/server-host';

type MultiplayerDeps = {
    platform: PlatformBridge;
    serverHost: ServerHost;
    connectRealm: (env: string, port: MessagePort) => void;
    fs: Filesystem;
    log?: (msg: string) => void;
};

export type Participant = { localId: number; username: string };

type MultiplayerState = {
    status: 'off' | 'opening' | 'open' | 'error';
    /** the ready-to-share invite link (from /api/edit/host). */
    shareUrl: string | null;
    error: string | null;
    /** connected guests (host view). */
    participants: Participant[];
    _deps: MultiplayerDeps | null;
    _session: HostSession | null;
    /** wire the host subsystems once, at boot. */
    init(deps: MultiplayerDeps): void;
    /** allocate a relay room + start accepting guests. Idempotent while open. */
    open(region?: string): Promise<void>;
    /** end the session (drops all guests; solo editing continues). */
    close(): void;
};

export const useMultiplayer = create<MultiplayerState>((set, get) => ({
    status: 'off',
    shareUrl: null,
    error: null,
    participants: [],
    _deps: null,
    _session: null,

    init(deps) {
        set({ _deps: deps });
    },

    async open(region) {
        const deps = get()._deps;
        if (!deps) return;
        const status = get().status;
        if (status === 'opening' || status === 'open') return;
        set({ status: 'opening', error: null });
        try {
            console.log('[mp:host] requesting relay allocation from platform…');
            const { url, shareUrl } = await deps.platform.requestMultiplayer(region);
            console.log('[mp:host] allocated; dialing relay', url);
            const socket = connectRelaySocket(url, {
                onOpen: () => console.log('[mp:host] relay socket open — ready for guests'),
                onError: () => console.error('[mp:host] relay socket error'),
                onClose: () => {
                    console.warn('[mp:host] relay closed');
                    // the relay dropped us (host tab closing elsewhere / session
                    // ended). Reflect it; the local edit session keeps running.
                    if (get().status === 'open') set({ status: 'off', shareUrl: null, _session: null });
                },
            });
            const session = createHostSession({
                socket,
                serverHost: deps.serverHost,
                connectRealm: deps.connectRealm,
                fs: deps.fs,
                log: deps.log,
                onGuestJoin: (localId, user) =>
                    set((s) => ({ participants: [...s.participants, { localId, username: user.username }] })),
                onGuestLeave: (localId) => set((s) => ({ participants: s.participants.filter((p) => p.localId !== localId) })),
            });
            set({ status: 'open', shareUrl, participants: [], _session: session });
            console.log('[mp:host] session open — share:', shareUrl);
        } catch (err) {
            console.error('[mp:host] open failed:', err);
            set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        }
    },

    close() {
        get()._session?.close();
        set({ status: 'off', shareUrl: null, participants: [], _session: null });
    },
}));
