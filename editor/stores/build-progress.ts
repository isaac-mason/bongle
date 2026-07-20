// editor/stores/build-progress.ts — live progress for the prod build, shown in
// the BuildModal. The build (editor/build) reports phase labels through an
// onProgress callback; runBuild in Desktop drives this store from them.

import { create } from 'zustand';

export type StepState = 'active' | 'done' | 'error';
export type BuildStep = { label: string; state: StepState };

/** Set on a successful embedded publish (the platform hands these back on
 *  bongle:result). Drives the "Published" confirmation + a link to the builds
 *  dashboard, in place of the standalone "downloaded" note. */
export type PublishResult = { buildId?: string; versionId?: string; dashboardUrl?: string };

type BuildProgressStore = {
    open: boolean;
    status: 'running' | 'done' | 'error';
    steps: BuildStep[];
    error: string | null;
    /** which phase the error is in — the bundle build itself, or the publish that
     *  follows it. Drives the modal title ("Build failed" vs "Publish failed"). */
    errorKind: 'build' | 'publish' | null;
    /** built bundle size in bytes — set for a STANDALONE build (downloaded). */
    sizeBytes: number | null;
    /** publish confirmation — set for an EMBEDDED build (published to the platform). */
    published: PublishResult | null;
    /** open the modal + reset to a fresh running build. */
    begin: () => void;
    /** finish the current step and start a new active one. */
    step: (label: string) => void;
    /** standalone: bundle built + downloaded, all steps done. */
    finish: (sizeBytes: number) => void;
    /** embedded: the platform published the bundle — confirm with ids + dashboard link. */
    finishPublish: (result: PublishResult) => void;
    /** the bundle build itself failed. */
    fail: (error: string) => void;
    /** the bundle built, but the platform publish failed. */
    failPublish: (error: string) => void;
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
    errorKind: null,
    sizeBytes: null,
    published: null,
    begin: () =>
        set({ open: true, status: 'running', steps: [], error: null, errorKind: null, sizeBytes: null, published: null }),
    step: (label) => set((s) => ({ steps: [...seal(s.steps, 'done'), { label, state: 'active' }] })),
    finish: (sizeBytes) => set((s) => ({ status: 'done', sizeBytes, steps: seal(s.steps, 'done') })),
    finishPublish: (published) => set((s) => ({ status: 'done', published, steps: seal(s.steps, 'done') })),
    fail: (error) => set((s) => ({ status: 'error', error, errorKind: 'build', steps: seal(s.steps, 'error') })),
    failPublish: (error) => set((s) => ({ status: 'error', error, errorKind: 'publish', steps: seal(s.steps, 'error') })),
    close: () => set({ open: false }),
}));
