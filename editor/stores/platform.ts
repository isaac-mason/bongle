// editor/stores/platform.ts — shared handle on the platform bridge. main.tsx
// creates the bridge at boot and stashes it here; the save/build actions read
// `embedded` to decide download-vs-hand-back, and surface result acks.

import { create } from 'zustand';
import type { PlatformBridge } from '../platform/bridge';
import type { EditorMessage, PlatformIntent, PlatformResult } from '../platform/contract';

/** Save-button lifecycle for the "editing X" window: 'saving' from the moment
 *  runSave hands the source off until the platform's bongle:result lands. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type PlatformStore = {
    bridge: PlatformBridge | null;
    /** true when embedded under a platform — payloads hand back instead of download. */
    embedded: boolean;
    /** what the platform mounted us to do — drives the "editing X" window. */
    intent: PlatformIntent | null;
    /** the last hand-back result the platform reported (for UI surfacing). */
    lastResult: PlatformResult | null;
    /** the save action's lifecycle + last message, surfaced on the Save button. */
    saveStatus: SaveStatus;
    saveMessage: string | null;
    init: (bridge: PlatformBridge, intent: PlatformIntent | null) => void;
    /** mark a save in flight (runSave calls this the instant it hands off). */
    beginSave: () => void;
    /** clear the transient 'saved' tick back to idle. */
    resetSave: () => void;
    setResult: (r: PlatformResult) => void;
    /** post to the platform if embedded; no-op otherwise. */
    send: (msg: EditorMessage) => void;
};

export const usePlatform = create<PlatformStore>((set, get) => ({
    bridge: null,
    embedded: false,
    intent: null,
    lastResult: null,
    saveStatus: 'idle',
    saveMessage: null,
    init: (bridge, intent) => set({ bridge, embedded: bridge.embedded(), intent }),
    beginSave: () => set({ saveStatus: 'saving', saveMessage: null }),
    resetSave: () => set({ saveStatus: 'idle', saveMessage: null }),
    // A version's bongle:result drives the Save button's saved/error state; other
    // hand-backs (build, avatar-export) just update lastResult.
    setResult: (r) =>
        set(
            r.of === 'version'
                ? {
                      lastResult: r,
                      saveStatus: r.ok ? 'saved' : 'error',
                      saveMessage: r.ok ? null : (r.message ?? 'Save failed'),
                  }
                : { lastResult: r },
        ),
    send: (msg) => get().bridge?.send(msg),
}));
