// editor/ui/components/CodePane.tsx — the code editor window: a self-contained
// mini-IDE laid out like VSCode — an activity bar (icon column) picks what the
// sidebar shows (file tree / search), then tabs + Monaco. ⌘/ctrl+shift+F opens
// search-across-files (scoped to src/); ⌘/ctrl+F stays Monaco's in-file find.
// Markdown files get a preview/source toggle (preview by default).

import { Code, Eye, FolderTree, Search } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useOpenFile } from '../../stores/open-file';
import { FileTree } from './FileTree';
import { MarkdownView } from './MarkdownView';
import { Monaco } from './Monaco';
import { SearchPanel } from './SearchPanel';
import { Tabs } from './Tabs';

type View = 'files' | 'search';
type MdMode = 'preview' | 'edit';

export function CodePane({ fs }: { fs: Filesystem }) {
    const [view, setView] = useState<View>('files');
    const searchInputRef = useRef<HTMLInputElement>(null);

    const active = useOpenFile((s) => s.active);
    const isMd = !!active && /\.(md|markdown)$/i.test(active);
    const [mdMode, setMdMode] = useState<Record<string, MdMode>>({});
    const mode: MdMode = active ? (mdMode[active] ?? 'preview') : 'preview'; // rendered by default

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
        <div style={{ display: 'flex', height: '100%' }}>
            <div style={activityBar}>
                <button type="button" style={actBtn(view === 'files')} onClick={() => setView('files')} title="Files">
                    <FolderTree size={17} />
                </button>
                <button
                    type="button"
                    style={actBtn(view === 'search')}
                    onClick={() => setView('search')}
                    title="Search across files (⌘/ctrl+shift+F)"
                >
                    <Search size={17} />
                </button>
            </div>
            <div style={{ width: 190, borderRight: '1px solid #000', flexShrink: 0, minHeight: 0 }}>
                {view === 'files' ? <FileTree fs={fs} /> : <SearchPanel fs={fs} inputRef={searchInputRef} />}
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Tabs />
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <Monaco fs={fs} />
                    {isMd && mode === 'preview' && active && <MarkdownView fs={fs} path={active} />}
                    {isMd && (
                        // floating preview/source toggle, top-right over the editor area.
                        <div style={mdToggle}>
                            <button
                                type="button"
                                style={mdBtn(mode === 'preview')}
                                title="Preview"
                                onClick={() => active && setMdMode((m) => ({ ...m, [active]: 'preview' }))}
                            >
                                <Eye size={14} />
                            </button>
                            <button
                                type="button"
                                style={mdBtn(mode === 'edit')}
                                title="Source"
                                onClick={() => active && setMdMode((m) => ({ ...m, [active]: 'edit' }))}
                            >
                                <Code size={14} />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

const activityBar: CSSProperties = {
    width: 40,
    flexShrink: 0,
    borderRight: '1px solid #000',
    background: '#fff',
    display: 'flex',
    flexDirection: 'column',
    padding: '4px 0',
    gap: 2,
};

function actBtn(active: boolean): CSSProperties {
    return {
        height: 38,
        display: 'grid',
        placeItems: 'center',
        border: 'none',
        // VSCode-style left accent for the active view; icon dims when inactive.
        borderLeft: `3px solid ${active ? '#000' : 'transparent'}`,
        background: 'transparent',
        color: active ? '#000' : '#aaa',
        cursor: 'pointer',
    };
}

const mdToggle: CSSProperties = {
    position: 'absolute',
    top: 8,
    right: 16, // clear of Monaco's scrollbar / MarkdownView's overflow gutter.
    zIndex: 5,
    display: 'flex',
    gap: 2,
};

function mdBtn(active: boolean): CSSProperties {
    return {
        display: 'grid',
        placeItems: 'center',
        width: 26,
        height: 22,
        border: '1px solid #000',
        background: active ? '#000' : '#fff',
        color: active ? '#fff' : '#000',
        cursor: 'pointer',
    };
}
