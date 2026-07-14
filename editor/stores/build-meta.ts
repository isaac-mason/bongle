// editor/stores/build-meta.ts — build-time project metadata the prod build can't
// derive itself. The build bundles but never EVALUATES user code, so it can't
// read the capture registries; the pipeline realm already imports user code, so
// it reports what the build needs (matchmaking config) here after each bake.

import { create } from 'zustand';

type BuildMetaStore = {
    /** latest matchmaking.maxPlayers from the pipeline realm's registry. Seeded
     *  with the engine default until the first bake reports the real value. */
    maxPlayers: number;
    setMaxPlayers: (n: number) => void;
};

export const useBuildMeta = create<BuildMetaStore>((set) => ({
    maxPlayers: 10,
    setMaxPlayers: (n) => set({ maxPlayers: n }),
}));
