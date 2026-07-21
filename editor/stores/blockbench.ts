// editor/stores/blockbench.ts — glue between the file tree and the single
// Blockbench app window. Blockbench owns its own project tabs; this carries
// "open this fs path" requests (tree -> window) and per-path unsaved state
// (window -> tree), so the two stay in sync without a window per file.

import { create } from 'zustand';

type BlockbenchStore = {
    /** the latest "open this path" request; the app opens it when seq changes. */
    openReq: { path: string; seq: number } | null;
    open: (path: string) => void;
    /** avatar mode: true from boot until the model is loaded (source resolved + the
     *  plugin acked `bongle:opened`), so the window shows a boot-style cover over the
     *  raw iframe instead of flashing empty Blockbench while it warms up. */
    sourceLoading: boolean;
    setSourceLoading: (loading: boolean) => void;
    /** unsaved flag per fs path, mirrored from Blockbench's saved_state. */
    dirty: Record<string, boolean>;
    setDirty: (path: string, dirty: boolean) => void;
};

export const useBlockbench = create<BlockbenchStore>((set) => ({
    openReq: null,
    open: (path) => set((s) => ({ openReq: { path, seq: (s.openReq?.seq ?? 0) + 1 } })),
    sourceLoading: false,
    setSourceLoading: (sourceLoading) => set({ sourceLoading }),
    dirty: {},
    setDirty: (path, dirty) => set((s) => (s.dirty[path] === dirty ? s : { dirty: { ...s.dirty, [path]: dirty } })),
}));
