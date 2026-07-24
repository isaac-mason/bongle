// editor/stores/platform.ts — shared handle on the platform bridge. main.tsx
// creates the bridge at boot and stashes it here; the save/build actions read
// `embedded` to decide download-vs-hand-back, and surface result acks.

import { create } from 'zustand';
import type { PlatformBridge } from '../platform/bridge';
import type { EditorMessage, PlatformIntent, PlatformResult } from '../platform/contract';

/** Save-button lifecycle for the "editing X" window: 'saving' from the moment
 *  runSave hands the source off until the platform's bongle:result lands. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Save-draft lifecycle (a local, on-device snapshot): 'saving' while the autosave
 *  driver flushes, 'saved' for a transient tick after. No error state — a draft flush
 *  is local and effectively always succeeds. */
export type DraftStatus = 'idle' | 'saving' | 'saved';

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
    /** the Save-draft action's lifecycle, surfaced next to the Save button. */
    draftStatus: DraftStatus;
    /** the working copy has source edits not yet captured in a bongle version — the
     *  "unsaved · on this device" state. Set on source change, cleared on a
     *  successful version save. */
    dirty: boolean;
    /** this thing has been saved to bongle at least once (or was opened from an
     *  existing version). false → a brand-new, never-saved draft that lives only in
     *  this browser; the top bar shows the loud "Save it to bongle" CTA. Flips true
     *  on the first successful version save. */
    savedToBongle: boolean;
    init: (bridge: PlatformBridge, intent: PlatformIntent | null) => void;
    /** mark a save in flight (runSave calls this the instant it hands off). */
    beginSave: () => void;
    /** clear the transient 'saved' tick back to idle. */
    resetSave: () => void;
    /** drive the Save-draft lifecycle (saving → saved → idle). */
    setDraftStatus: (s: DraftStatus) => void;
    /** flag the working copy as having unsaved (on-device) source edits. */
    markDirty: () => void;
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
    draftStatus: 'idle',
    dirty: false,
    savedToBongle: true,
    init: (bridge, intent) =>
        set({
            bridge,
            embedded: bridge.embedded(),
            intent,
            // a project descends from a version (baseVersion) or an avatar the user can
            // edit → already on bongle; a fresh draft has neither → show the save CTA.
            // guest / standalone have no CTA, so default to "saved" (suppress it).
            savedToBongle:
                intent?.kind === 'project'
                    ? !!intent.baseVersion
                    : intent?.kind === 'avatar'
                      ? !!intent.canEdit
                      : true,
        }),
    beginSave: () => set({ saveStatus: 'saving', saveMessage: null }),
    resetSave: () => set({ saveStatus: 'idle', saveMessage: null }),
    setDraftStatus: (draftStatus) => set({ draftStatus }),
    markDirty: () => set((s) => (s.dirty ? s : { dirty: true })),
    // A version's bongle:result drives the Save button's saved/error state; other
    // hand-backs (build, avatar-export) just update lastResult. A successful version
    // save is the point the working copy is captured — clear the dirty flag there.
    setResult: (r) =>
        set(
            r.of === 'version'
                ? {
                      lastResult: r,
                      saveStatus: r.ok ? 'saved' : 'error',
                      saveMessage: r.ok ? null : (r.message ?? 'Save failed'),
                      ...(r.ok ? { dirty: false, savedToBongle: true } : {}),
                  }
                : { lastResult: r },
        ),
    send: (msg) => get().bridge?.send(msg),
}));
