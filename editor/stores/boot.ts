// editor/stores/boot.ts — tracks the one-shot boot of the in-browser dev env
// (bundler worker → first bake → server → first client). The BootScreen overlay
// covers the desktop (taskbar hidden) until `ready` flips, showing the boot
// steps as a terminal-style log, then fades itself out.

import { create } from 'zustand';

type BootStore = {
    ready: boolean;
    /** boot progress steps, in order, shown under the wordmark. */
    lines: string[];
    /** append a boot step. */
    log: (msg: string) => void;
    /** flip once the session is laid out (client up / avatar Blockbench framed). */
    setReady: () => void;
};

export const useBoot = create<BootStore>((set) => ({
    ready: false,
    lines: [],
    log: (msg) => set((s) => ({ lines: [...s.lines, msg] })),
    setReady: () => set({ ready: true }),
}));
