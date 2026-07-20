// editor/ui/components/CodePane.tsx — one code-editor pane (the 'main' code
// window, and every torn-off window). A VSCode-ish mini-IDE: an activity bar
// (file tree / search) + sidebar, then a horizontal row of editor groups.
// ⌘/ctrl+shift+F opens search-across-files (scoped to src/); ⌘/ctrl+F stays
// Monaco's in-file find. Drag a tab to another group / a split / a new window.

import { FolderTree, Search } from "../../../icons";
import { useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useEditor } from '../../stores/editor';
import { EditorGroup } from './EditorGroup';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';

type View = 'files' | 'search';

// stable empty fallback so the selector snapshot stays referentially stable
// (returning a fresh [] each render trips useSyncExternalStore's infinite loop).
const NO_GROUPS: string[] = [];

export function CodePane({ fs, pane }: { fs: Filesystem; pane: string }) {
    const [view, setView] = useState<View>('files');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const groups = useEditor((s) => s.panes[pane]?.groups) ?? NO_GROUPS;

    // ⌘/ctrl+shift+F -> search across files (capture, to beat Monaco's own binds).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                e.stopPropagation();
                setView('search');
                requestAnimationFrame(() => searchInputRef.current?.focus());
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    return (
        <div className="flex h-full">
            <div className="flex w-10 shrink-0 flex-col gap-0.5 border-r border-border bg-surface py-1">
                <button type="button" className={actBtn(view === 'files')} onClick={() => setView('files')} title="Files">
                    <FolderTree size={17} />
                </button>
                <button
                    type="button"
                    className={actBtn(view === 'search')}
                    onClick={() => setView('search')}
                    title="Search across files (⌘/ctrl+shift+F)"
                >
                    <Search size={17} />
                </button>
            </div>
            <div className="min-h-0 w-[190px] shrink-0 border-r border-border">
                {view === 'files' ? (
                    <FileTree fs={fs} pane={pane} />
                ) : (
                    <SearchPanel fs={fs} pane={pane} inputRef={searchInputRef} />
                )}
            </div>
            <div className="flex min-w-0 flex-1">
                {groups.map((gid, i) => (
                    <div key={gid} className={`flex min-w-0 flex-1 ${i > 0 ? 'border-l border-border' : ''}`}>
                        <EditorGroup fs={fs} group={gid} pane={pane} index={i} />
                    </div>
                ))}
            </div>
        </div>
    );
}

// VSCode-style left accent for the active view; icon dims when inactive.
function actBtn(active: boolean): string {
    return `grid h-[38px] cursor-pointer place-items-center border-0 border-l-[3px] bg-transparent ${
        active ? 'border-l-fg text-fg' : 'border-l-transparent text-fg-muted'
    }`;
}
