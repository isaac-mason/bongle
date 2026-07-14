// editor/stores/platform.ts — shared handle on the platform bridge. main.tsx
// creates the bridge at boot and stashes it here; the save/build actions read
// `embedded` to decide download-vs-hand-back, and surface result acks.

import { create } from 'zustand';
import type { PlatformBridge } from '../platform/bridge';
import type { EditorMessage, PlatformResult } from '../platform/contract';

type PlatformStore = {
    bridge: PlatformBridge | null;
    /** true when embedded under a platform — payloads hand back instead of download. */
    embedded: boolean;
    /** the last hand-back result the platform reported (for UI surfacing). */
    lastResult: PlatformResult | null;
    init: (bridge: PlatformBridge) => void;
    setResult: (r: PlatformResult) => void;
    /** post to the platform if embedded; no-op otherwise. */
    send: (msg: EditorMessage) => void;
};

export const usePlatform = create<PlatformStore>((set, get) => ({
    bridge: null,
    embedded: false,
    lastResult: null,
    init: (bridge) => set({ bridge, embedded: bridge.embedded() }),
    setResult: (r) => set({ lastResult: r }),
    send: (msg) => get().bridge?.send(msg),
}));
