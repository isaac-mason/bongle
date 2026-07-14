// editor/stores/system-windows.ts — open/closed state for the fixed "system"
// windows (files, code, build, server). Unlike launched apps they're pinned in
// the taskbar and reopen to their last geometry — this just tracks which are
// currently open, so their taskbar running indicator is truthful. Absent key =
// open (they all start open).

import { create } from 'zustand';
import { useWindows } from './windows';

type SystemWindowsStore = {
    closed: Record<string, boolean>;
    open: (id: string) => void;
    close: (id: string) => void;
};

export const useSystemWindows = create<SystemWindowsStore>((set, get) => ({
    closed: {},
    open: (id) => {
        if (get().closed[id]) set((s) => ({ closed: { ...s.closed, [id]: false } }));
        useWindows.getState().focus(id); // raise + restore
    },
    close: (id) => {
        set((s) => ({ closed: { ...s.closed, [id]: true } }));
        useWindows.getState().blur(id);
    },
}));
