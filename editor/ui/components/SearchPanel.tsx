// editor/ui/components/SearchPanel.tsx — search across all files under src/.
// Debounced, case-insensitive substring search; results grouped by file with the
// match bolded. Clicking a hit opens the file and jumps to the line (Monaco
// reveals via the open-file store).

import { useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useOpenFile } from '../../stores/open-file';

const SCOPE = 'src';

type Hit = { line: number; col: number; text: string };
type FileHits = { path: string; hits: Hit[] };

export function SearchPanel({ fs, inputRef }: { fs: Filesystem; inputRef: React.RefObject<HTMLInputElement | null> }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<FileHits[]>([]);
    const [matchLen, setMatchLen] = useState(0);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) {
            setResults([]);
            return;
        }
        let alive = true;
        setSearching(true);
        const t = setTimeout(async () => {
            const files = (await fs.list(SCOPE, { recursive: true })).filter((f) => f.kind === 'file');
            const out: FileHits[] = [];
            for (const f of files) {
                let text = '';
                try {
                    text = await fs.readText(f.path);
                } catch {
                    continue;
                }
                const hits: Hit[] = [];
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const col = lines[i].toLowerCase().indexOf(needle);
                    if (col === -1) continue;
                    const lead = lines[i].length - lines[i].trimStart().length;
                    hits.push({ line: i + 1, col: col - lead, text: lines[i].trimStart().slice(0, 240) });
                }
                if (hits.length) out.push({ path: f.path, hits });
            }
            if (!alive) return;
            setResults(out);
            setMatchLen(needle.length);
            setSearching(false);
        }, 200);
        return () => {
            alive = false;
            clearTimeout(t);
        };
    }, [query, fs]);

    const total = results.reduce((n, r) => n + r.hits.length, 0);

    return (
        <div className="flex h-full flex-col font-mono text-xs leading-[1.4]">
            <div className="shrink-0 border-b border-border p-1.5">
                <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${SCOPE}/…`}
                    spellCheck={false}
                    className="w-full border border-border bg-surface px-1.5 py-1 font-mono text-xs text-fg placeholder:text-fg-muted"
                />
                {query.trim() && (
                    <div className="mt-1 text-fg-muted">
                        {searching
                            ? 'searching…'
                            : `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}`}
                    </div>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {results.map((r) => (
                    <div key={r.path}>
                        <div
                            className="sticky top-0 overflow-hidden text-ellipsis whitespace-nowrap bg-surface-muted px-1.5 py-[3px] text-fg-muted"
                            title={r.path}
                        >
                            {r.path.replace(new RegExp(`^${SCOPE}/`), '')}
                        </div>
                        {r.hits.map((h) => (
                            <button
                                key={`${h.line}:${h.col}`}
                                type="button"
                                onClick={() => useOpenFile.getState().openAt(r.path, h.line)}
                                title={`${r.path}:${h.line}`}
                                className="flex w-full cursor-pointer items-center border-none bg-transparent px-1.5 py-0.5 text-left font-mono text-xs hover:bg-surface-muted"
                            >
                                <span className="mr-2 w-8 shrink-0 text-right text-fg-muted">{h.line}</span>
                                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                    {h.text.slice(0, h.col)}
                                    <b className="bg-[#ffe08a] text-black">{h.text.slice(h.col, h.col + matchLen)}</b>
                                    {h.text.slice(h.col + matchLen)}
                                </span>
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
