// editor/ui/components/QuickOpen.tsx — VS Code-style Cmd/Ctrl+P file palette.
// Fuzzy-filters the project's files (minus generated/vendored dirs), arrow keys +
// enter to open into the main code pane. Mounted only while open, so it reloads
// the file list each time.

import { File as FileIcon } from 'bongle/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { isIgnored } from '../../ignored';
import { MAIN_PANE, useEditor } from '../../stores/editor';
import { appForFile, openPath } from '../apps';
import { fuzzyScore } from '../fuzzy';

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
};

export function QuickOpen({ fs, onClose }: { fs: Filesystem; onClose: () => void }) {
    const [files, setFiles] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [sel, setSel] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // open tabs across all groups — surfaced first on an empty query, like VS
    // Code's "recently opened". Derive the Set in a memo, not the selector: a
    // selector returning a fresh object every call loops React's snapshot check.
    const groups = useEditor((s) => s.groups);
    const openPaths = useMemo(() => {
        const set = new Set<string>();
        for (const g of Object.values(groups)) for (const t of g.tabs) set.add(t);
        return set;
    }, [groups]);

    // load the file list, walking top-level but skipping ignored dirs (never
    // recursing node_modules — that'd be hundreds of files).
    useEffect(() => {
        let alive = true;
        void (async () => {
            const out: string[] = [];
            for (const e of await fs.list('', { recursive: false })) {
                if (isIgnored(e.path)) continue;
                if (e.kind === 'file') out.push(e.path);
                else for (const f of await fs.list(e.path, { recursive: true })) {
                    if (f.kind === 'file' && !isIgnored(f.path)) out.push(f.path);
                }
            }
            if (alive) setFiles(out);
        })();
        return () => {
            alive = false;
        };
    }, [fs]);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
            // recent (open) first, then the rest alphabetically by name.
            const rest = files.filter((p) => !openPaths.has(p));
            const recent = files.filter((p) => openPaths.has(p));
            rest.sort((a, b) => basename(a).localeCompare(basename(b)));
            return [...recent, ...rest].slice(0, 100);
        }
        const scored: { path: string; score: number }[] = [];
        for (const p of files) {
            const bs = fuzzyScore(q, basename(p));
            const ps = fuzzyScore(q, p);
            const score = Math.max(bs === null ? -Infinity : bs + 24, ps === null ? -Infinity : ps);
            if (score > -Infinity) scored.push({ path: p, score });
        }
        scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
        return scored.slice(0, 100).map((s) => s.path);
    }, [query, files, openPaths]);

    // keep the selection valid + scrolled into view as the list changes.
    useEffect(() => {
        setSel((s) => (s >= results.length ? 0 : s));
    }, [results.length]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [sel]);

    const choose = (path: string | undefined) => {
        if (!path) return;
        openPath(path, MAIN_PANE);
        onClose();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[sel]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss backdrop.
        <div className="fixed inset-0 z-[2000000] flex justify-center pt-[8vh]" onPointerDown={onClose}>
            <div
                className="flex h-fit max-h-[70vh] w-[600px] max-w-[90vw] flex-col border border-border bg-surface font-mono shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
                onPointerDown={(e) => e.stopPropagation()}
            >
                {/* biome-ignore lint/a11y/noAutofocus: a palette exists to take focus immediately. */}
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search files by name"
                    className="border-border border-b bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted"
                />
                <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                    {results.length === 0 && (
                        <div className="px-3 py-2 text-xs text-fg-muted">{files.length ? 'No matching files' : 'Loading…'}</div>
                    )}
                    {results.map((path, i) => {
                        const glyph = appForFile(path)?.glyph;
                        const dir = dirname(path);
                        return (
                            <button
                                key={path}
                                type="button"
                                data-sel={i === sel}
                                onPointerEnter={() => setSel(i)}
                                onClick={() => choose(path)}
                                className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                                    i === sel ? 'bg-accent text-on-accent' : 'text-fg'
                                }`}
                            >
                                <span className="grid h-4 w-4 shrink-0 place-items-center opacity-80">
                                    {glyph ?? <FileIcon size={13} />}
                                </span>
                                <span className="truncate">{basename(path)}</span>
                                {dir && <span className={`truncate text-[11px] ${i === sel ? 'text-on-accent/70' : 'text-fg-muted'}`}>{dir}</span>}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
