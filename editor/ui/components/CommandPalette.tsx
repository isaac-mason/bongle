// editor/ui/components/CommandPalette.tsx — VS Code-style Cmd/Ctrl+Shift+P action
// palette. Fuzzy-filters the command registry (ui/commands.ts), arrow keys + enter
// to run. Mirrors QuickOpen's shape; the data source is commands, not files.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { type Command, COMMANDS } from '../commands';
import { fuzzyScore } from '../fuzzy';

export function CommandPalette({ fs, onClose }: { fs: Filesystem; onClose: () => void }) {
    const [query, setQuery] = useState('');
    const [sel, setSel] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // only commands whose availability guard passes (e.g. an editor is focused).
    const available = useMemo(() => COMMANDS.filter((c) => c.when?.() ?? true), []);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
            return [...available].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
        }
        const scored: { cmd: Command; score: number }[] = [];
        for (const cmd of available) {
            const ts = fuzzyScore(q, cmd.title);
            const cs = fuzzyScore(q, `${cmd.category} ${cmd.title}`);
            const score = Math.max(ts === null ? -Infinity : ts + 24, cs === null ? -Infinity : cs);
            if (score > -Infinity) scored.push({ cmd, score });
        }
        scored.sort((a, b) => b.score - a.score || a.cmd.title.length - b.cmd.title.length);
        return scored.map((s) => s.cmd);
    }, [query, available]);

    useEffect(() => {
        setSel((s) => (s >= results.length ? 0 : s));
    }, [results.length]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [sel]);

    const choose = (cmd: Command | undefined) => {
        if (!cmd) return;
        onClose();
        void (async () => {
            try {
                await cmd.run({ fs });
            } catch (err) {
                console.error(`[command] ${cmd.id} failed`, err);
            }
        })();
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
                    placeholder="Type a command"
                    className="border-border border-b bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted"
                />
                <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                    {results.length === 0 && <div className="px-3 py-2 text-xs text-fg-muted">No matching commands</div>}
                    {results.map((cmd, i) => (
                        <button
                            key={cmd.id}
                            type="button"
                            data-sel={i === sel}
                            onPointerEnter={() => setSel(i)}
                            onClick={() => choose(cmd)}
                            className={`flex w-full items-center justify-between gap-3 px-3 py-1 text-left text-xs ${
                                i === sel ? 'bg-accent text-on-accent' : 'text-fg'
                            }`}
                        >
                            <span className="truncate">{cmd.title}</span>
                            <span className={`shrink-0 text-[11px] ${i === sel ? 'text-on-accent/70' : 'text-fg-muted'}`}>
                                {cmd.category}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
