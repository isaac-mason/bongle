// editor/stores/tab-drag.ts — the tab currently being dragged (HTML5 DnD).
//
// dataTransfer.getData isn't readable during dragover, so we mirror the payload
// here: components react to `drag != null` to show split/move drop hints, and
// read `drag` on drop to know which tab moved.

import { create } from 'zustand';

export type TabDrag = { group: string; path: string };

export const useTabDrag = create<{ drag: TabDrag | null; setDrag: (drag: TabDrag | null) => void }>((set) => ({
    drag: null,
    setDrag: (drag) => set({ drag }),
}));
