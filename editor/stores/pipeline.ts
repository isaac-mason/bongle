// editor/stores/pipeline.ts — reactive pipeline state for the UI.
//
// Bumped after each bake so views (the atlas) re-read the fs outputs. Grows to
// hold more pipeline result (last timings, atlas hash) as the UI needs it.

import { create } from 'zustand';

export const usePipeline = create<{ bakeVersion: number; baked: () => void }>((set) => ({
    /** incremented after each bake pass. */
    bakeVersion: 0,
    baked: () => set((s) => ({ bakeVersion: s.bakeVersion + 1 })),
}));
