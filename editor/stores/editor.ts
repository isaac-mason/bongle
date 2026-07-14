// editor/stores/editor.ts — the code editor's panes + groups + shared buffer state.
//
// The editor is a two-level tree:
//   Pane  — one per code window ('main', plus any torn-off windows). Holds a
//           left→right row of groups (horizontal split).
//   Group — one tab strip + one editor instance.
// `dirty` is keyed by PATH, not tab: a file's unsaved state belongs to its shared
// Monaco buffer, so the same file open in two groups mirrors edits + dirty.
//
// Boots with one pane ('main') holding one empty group — which behaves exactly
// like the pre-split editor. Split adds a group to a pane's row; tear-off spawns
// a new pane (rendered in its own desktop window by the Desktop).

import { create } from 'zustand';

export const MAIN_PANE = 'main';

export type Group = {
    /** owning pane id. */
    pane: string;
    /** open file paths, in tab order. */
    tabs: string[];
    /** focused tab in this group, or null when empty. */
    active: string | null;
};

export type Pane = {
    /** child groups, left→right (the horizontal split row). */
    groups: string[];
    /** the group that `open`/`reveal` target within this pane (last-focused). */
    activeGroup: string;
};

/** a request to reveal a line in a group's editor (search hit). */
export type Reveal = { group: string; path: string; line: number; seq: number };

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${++counter}`;

const FIRST_GROUP = nextId('g');

type EditorState = {
    panes: Record<string, Pane>;
    groups: Record<string, Group>;
    /** torn-off pane ids (each rendered in its own desktop window); excludes main. */
    windowPanes: string[];
    /** unsaved flag per PATH (shared across groups showing the same file). */
    dirty: Record<string, boolean>;
    reveal: Reveal | null;
};

type EditorActions = {
    /** open a file into a pane's active group, focusing it. */
    open: (pane: string, path: string) => void;
    /** open a file and request a jump to `line` (search hit). */
    openAt: (pane: string, path: string, line: number) => void;
    /** focus an already-open tab within a group. */
    activate: (group: string, path: string) => void;
    /** mark a group as its pane's active target (called on click/focus). */
    focusGroup: (group: string) => void;
    /** close one tab in a group. */
    closeTab: (group: string, path: string) => void;
    /** close a batch of tabs in a group (close-all / to-the-right / unsaved). */
    closeMany: (group: string, paths: string[]) => void;
    /** move/reorder a tab into `to` at `index` (defaults to the end). */
    moveTab: (path: string, from: string, to: string, index?: number) => void;
    /** split: a new group at `index` in `pane`'s row, holding `path` (moved from `from`). */
    splitGroup: (pane: string, index: number, path: string, from: string) => void;
    /** tear `path` into a brand-new pane + window; returns the new pane id. */
    tearOff: (path: string, from: string) => string;
    /** close a whole torn-off pane (its window's close button); main is permanent. */
    closePane: (pane: string) => void;
    setDirty: (path: string, dirty: boolean) => void;
};

/** drop empty groups (except the sole group of the main pane) and empty torn-off
 *  panes; repair any pane.activeGroup that pointed at a removed group. Returns the
 *  cleaned slices to spread into a set(). */
function prune(state: EditorState): Pick<EditorState, 'panes' | 'groups' | 'windowPanes'> {
    const panes = { ...state.panes };
    const groups = { ...state.groups };
    let windowPanes = state.windowPanes;

    for (const [gid, g] of Object.entries(state.groups)) {
        if (g.tabs.length > 0) continue;
        const pane = panes[g.pane];
        if (!pane) {
            delete groups[gid];
            continue;
        }
        // keep an empty group only when it's the sole group of the main pane
        // (that's the editor's "nothing open" state).
        if (pane.groups.length === 1 && g.pane === MAIN_PANE) continue;

        const remaining = pane.groups.filter((x) => x !== gid);
        delete groups[gid];
        if (remaining.length === 0) {
            // pane emptied → close it (a torn-off window disappears; main never gets here).
            delete panes[g.pane];
            windowPanes = windowPanes.filter((p) => p !== g.pane);
        } else {
            const activeGroup =
                pane.activeGroup === gid
                    ? (remaining[Math.min(pane.groups.indexOf(gid), remaining.length - 1)] ?? remaining[0])
                    : pane.activeGroup;
            panes[g.pane] = { ...pane, groups: remaining, activeGroup };
        }
    }
    return { panes, groups, windowPanes };
}

/** remove `paths` from a group, repairing its active tab (nearest survivor). */
function withoutTabs(g: Group, paths: Set<string>): Group {
    const tabs = g.tabs.filter((t) => !paths.has(t));
    let active = g.active;
    if (active && paths.has(active)) {
        const i = g.tabs.indexOf(active);
        active =
            g.tabs.slice(i + 1).find((t) => !paths.has(t)) ??
            [...g.tabs.slice(0, i)].reverse().find((t) => !paths.has(t)) ??
            null;
    }
    return { ...g, tabs, active };
}

export const useEditor = create<EditorState & EditorActions>((set) => ({
    panes: { [MAIN_PANE]: { groups: [FIRST_GROUP], activeGroup: FIRST_GROUP } },
    groups: { [FIRST_GROUP]: { pane: MAIN_PANE, tabs: [], active: null } },
    windowPanes: [],
    dirty: {},
    reveal: null,

    open: (pane, path) =>
        set((s) => {
            const gid = s.panes[pane]?.activeGroup;
            const g = gid ? s.groups[gid] : undefined;
            if (!gid || !g) return s;
            const tabs = g.tabs.includes(path) ? g.tabs : [...g.tabs, path];
            return { groups: { ...s.groups, [gid]: { ...g, tabs, active: path } } };
        }),

    openAt: (pane, path, line) =>
        set((s) => {
            const gid = s.panes[pane]?.activeGroup;
            const g = gid ? s.groups[gid] : undefined;
            if (!gid || !g) return s;
            const tabs = g.tabs.includes(path) ? g.tabs : [...g.tabs, path];
            return {
                groups: { ...s.groups, [gid]: { ...g, tabs, active: path } },
                reveal: { group: gid, path, line, seq: (s.reveal?.seq ?? 0) + 1 },
            };
        }),

    activate: (group, path) =>
        set((s) => {
            const g = s.groups[group];
            if (!g) return s;
            return {
                groups: { ...s.groups, [group]: { ...g, active: path } },
                panes: { ...s.panes, [g.pane]: { ...s.panes[g.pane]!, activeGroup: group } },
            };
        }),

    focusGroup: (group) =>
        set((s) => {
            const g = s.groups[group];
            if (!g || s.panes[g.pane]?.activeGroup === group) return s;
            return { panes: { ...s.panes, [g.pane]: { ...s.panes[g.pane]!, activeGroup: group } } };
        }),

    closeTab: (group, path) =>
        set((s) => {
            const g = s.groups[group];
            if (!g) return s;
            const groups = { ...s.groups, [group]: withoutTabs(g, new Set([path])) };
            return prune({ ...s, groups });
        }),

    closeMany: (group, paths) =>
        set((s) => {
            const g = s.groups[group];
            if (!g || paths.length === 0) return s;
            const groups = { ...s.groups, [group]: withoutTabs(g, new Set(paths)) };
            return prune({ ...s, groups });
        }),

    moveTab: (path, from, to, index) =>
        set((s) => {
            const src = s.groups[from];
            const dst = s.groups[to];
            if (!src || !dst) return s;
            const groups = { ...s.groups };
            // remove from source (unless reordering within the same group).
            const srcTabs = from === to ? dst.tabs.filter((t) => t !== path) : src.tabs.filter((t) => t !== path);
            const base = from === to ? srcTabs : dst.tabs.filter((t) => t !== path);
            const at = index === undefined ? base.length : Math.max(0, Math.min(index, base.length));
            const dstTabs = [...base.slice(0, at), path, ...base.slice(at)];
            if (from !== to) groups[from] = { ...src, ...withoutTabs(src, new Set([path])) };
            groups[to] = { ...dst, tabs: dstTabs, active: path };
            const panes = { ...s.panes, [dst.pane]: { ...s.panes[dst.pane]!, activeGroup: to } };
            return prune({ ...s, groups, panes });
        }),

    splitGroup: (pane, index, path, from) =>
        set((s) => {
            const p = s.panes[pane];
            const src = s.groups[from];
            if (!p || !src) return s;
            const gid = nextId('g');
            const at = Math.max(0, Math.min(index, p.groups.length));
            const order = [...p.groups.slice(0, at), gid, ...p.groups.slice(at)];
            const groups = {
                ...s.groups,
                [gid]: { pane, tabs: [path], active: path } satisfies Group,
                [from]: withoutTabs(src, new Set([path])),
            };
            const panes = { ...s.panes, [pane]: { groups: order, activeGroup: gid } };
            return prune({ ...s, groups, panes });
        }),

    tearOff: (path, from) => {
        const pid = nextId('pane');
        const gid = nextId('g');
        set((s) => {
            const src = s.groups[from];
            if (!src) return s;
            const groups = {
                ...s.groups,
                [gid]: { pane: pid, tabs: [path], active: path } satisfies Group,
                [from]: withoutTabs(src, new Set([path])),
            };
            const panes = { ...s.panes, [pid]: { groups: [gid], activeGroup: gid } satisfies Pane };
            return prune({ ...s, groups, panes, windowPanes: [...s.windowPanes, pid] });
        });
        return pid;
    },

    closePane: (pane) =>
        set((s) => {
            if (pane === MAIN_PANE || !s.panes[pane]) return s;
            const groups = { ...s.groups };
            for (const gid of s.panes[pane].groups) delete groups[gid];
            const panes = { ...s.panes };
            delete panes[pane];
            return { panes, groups, windowPanes: s.windowPanes.filter((p) => p !== pane) };
        }),

    setDirty: (path, dirty) => set((s) => ({ dirty: { ...s.dirty, [path]: dirty } })),
}));
