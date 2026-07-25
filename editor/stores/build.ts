// editor/stores/build.ts — the "build" side of the realm stack for the UI: the
// bundler (code compiler) + pipeline (asset bake) managers, and the actions the
// build log window drives (restart all / re-bake).
//
// The bundler is the ROOT every realm pulls modules from, so it can't restart
// alone — `restartAll` respawns it, then re-runs the downstream realms (pipeline
// bake → server → clients) so each re-handshakes a fresh conduit to the new
// compiler. `rebake` restarts just the pipeline (re-run the asset bake).

import { create } from 'zustand';
import type { BundlerManager } from '../dev/bundler-manager';
import type { PipelineManager } from '../realms/pipeline/pipeline-manager';
import { useClients } from './clients';
import { useServer } from './server';

// idle: managers not wired yet. running: stack live. restarting: a restart-all /
// re-bake is in flight.
type BuildStatus = 'idle' | 'running' | 'restarting';

type BuildStore = {
    status: BuildStatus;
    bundler: BundlerManager | null;
    pipeline: PipelineManager | null;
    /** wire the managers once the stack has created them (bundler at boot, pipeline
     *  in startRealms). */
    init: (bundler: BundlerManager, pipeline: PipelineManager) => void;
    /** re-run the asset bake (pipeline restart) against the current compiler. */
    rebake: () => Promise<void>;
    /** respawn the whole stack in place: compiler → bake → server → clients. The
     *  only in-editor recovery for a wedged compiler (the root of the module graph). */
    restartAll: () => Promise<void>;
};

export const useBuild = create<BuildStore>((set, get) => ({
    status: 'idle',
    bundler: null,
    pipeline: null,
    init: (bundler, pipeline) => set({ bundler, pipeline, status: 'running' }),
    rebake: async () => {
        const { pipeline, status } = get();
        if (!pipeline || status === 'restarting') return;
        set({ status: 'restarting' });
        try {
            await pipeline.restart();
        } finally {
            set({ status: 'running' });
        }
    },
    restartAll: async () => {
        const { bundler, pipeline, status } = get();
        if (status === 'restarting') return;
        set({ status: 'restarting' });
        try {
            // order matters: the new compiler must be up before the realms below
            // re-handshake to it, and the bake must finish before the server
            // re-imports the generated barrel (bake-then-run). Each await gates the
            // next, so downstream realms always reconnect to the live compiler.
            await bundler?.restart();
            await pipeline?.restart();
            await useServer.getState().restart();
            useClients.getState().reloadAll();
        } finally {
            set({ status: 'running' });
        }
    },
}));
