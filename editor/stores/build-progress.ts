// editor/stores/build-progress.ts — live progress for the prod build, shown in
// the BuildModal. The build (editor/build) reports phase labels through an
// onProgress callback; runBuild in Desktop drives this store from them.

import { create } from 'zustand';

export type StepState = 'active' | 'done' | 'error';
export type BuildStep = { label: string; state: StepState };

type BuildProgressStore = {
    open: boolean;
    status: 'running' | 'done' | 'error';
    steps: BuildStep[];
    error: string | null;
    /** built bundle size in bytes, once done. */
    sizeBytes: number | null;
    /** open the modal + reset to a fresh running build. */
    begin: () => void;
    /** finish the current step and start a new active one. */
    step: (label: string) => void;
    /** all steps done. */
    finish: (sizeBytes: number) => void;
    /** the active step failed. */
    fail: (error: string) => void;
    close: () => void;
};

/** mark the last step (if any) with a terminal state. */
function seal(steps: BuildStep[], state: StepState): BuildStep[] {
    if (steps.length === 0) return steps;
    return steps.map((s, i) => (i === steps.length - 1 ? { ...s, state } : s));
}

export const useBuildProgress = create<BuildProgressStore>((set) => ({
    open: false,
    status: 'running',
    steps: [],
    error: null,
    sizeBytes: null,
    begin: () => set({ open: true, status: 'running', steps: [], error: null, sizeBytes: null }),
    step: (label) => set((s) => ({ steps: [...seal(s.steps, 'done'), { label, state: 'active' }] })),
    finish: (sizeBytes) => set((s) => ({ status: 'done', sizeBytes, steps: seal(s.steps, 'done') })),
    fail: (error) => set((s) => ({ status: 'error', error, steps: seal(s.steps, 'error') })),
    close: () => set({ open: false }),
}));
