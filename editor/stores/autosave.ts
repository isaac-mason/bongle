// editor/stores/autosave.ts — the on-demand handle onto the autosave driver.
// initAutosave (platform/autosave.ts) registers `flush` here while it's armed
// (embedded + project intent) and clears it on dispose. The "Save draft" button
// reads it to force an immediate draft snapshot; null → standalone / non-project,
// so the button hides. Kept separate from the platform store: autosave is the fs
// change stream, not the bridge.

import { create } from 'zustand';

type AutosaveStore = {
    /** force an immediate draft snapshot now, bypassing the debounce. null while the
     *  driver is parked (standalone or a non-project intent). */
    flush: (() => Promise<void>) | null;
    register: (flush: (() => Promise<void>) | null) => void;
};

export const useAutosave = create<AutosaveStore>((set) => ({
    flush: null,
    register: (flush) => set({ flush }),
}));
