// editor/ui/components/QuickPalette.tsx — VS Code-style unified quick-open. One
// widget for both files and commands: it fuzzy-filters the project's files by
// default, and a leading `>` switches it to command mode (the registry in
// ui/commands.ts). Cmd/Ctrl+P opens it on files; Cmd/Ctrl+Shift+P opens it with
// `>` pre-typed. Mounted only while open, so it reloads the file list each time.

import { useEffect, useMemo, useRef, useState } from 'react';
import { File as FileIcon } from '../../../icons';
import type { Filesystem } from '../../fs';
import { isIgnored } from '../../ignored';
import { MAIN_PANE, useEditor } from '../../stores/editor';
import { appForFile, openPath } from '../apps';
import { type Command, COMMANDS } from '../commands';
import { fuzzyScore } from '../fuzzy';

export type PaletteMode = 'files' | 'commands';

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
};

export function QuickPalette({ fs, mode, onClose }: { fs: Filesystem; mode: PaletteMode; onClose: () => void }) {
    // A leading `>` is command mode (VS Code). Cmd+Shift+P opens with it pre-typed;
    // deleting it flips back to files. So the mode is derived from the query, not
    // held as state — `mode` only seeds the initial character.
    const [query, setQuery] = useState(mode === 'commands' ? '>' : '');
    const [sel, setSel] = useState(0);
    const [files, setFiles] = useState<string[]>([]);
    const listRef = useRef<HTMLDivElement>(null);

    const commandMode = query.startsWith('>');
    const term = (commandMode ? query.slice(1) : query).trim().toLowerCase();

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
                else
                    for (const f of await fs.list(e.path, { recursive: true })) {
                        if (f.kind === 'file' && !isIgnored(f.path)) out.push(f.path);
                    }
            }
            if (alive) setFiles(out);
        })();
        return () => {
            alive = false;
        };
    }, [fs]);

    // only commands whose availability guard passes (e.g. an editor is focused).
    const commands = useMemo(() => COMMANDS.filter((c) => c.when?.() ?? true), []);

    const fileResults = useMemo(() => {
        if (!term) {
            // recent (open) first, then the rest alphabetically by name.
            const rest = files.filter((p) => !openPaths.has(p));
            const recent = files.filter((p) => openPaths.has(p));
            rest.sort((a, b) => basename(a).localeCompare(basename(b)));
            return [...recent, ...rest].slice(0, 100);
        }
        const scored: { path: string; score: number }[] = [];
        for (const p of files) {
            const bs = fuzzyScore(term, basename(p));
            const ps = fuzzyScore(term, p);
            const score = Math.max(bs === null ? -Infinity : bs + 24, ps === null ? -Infinity : ps);
            if (score > -Infinity) scored.push({ path: p, score });
        }
        scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
        return scored.slice(0, 100).map((s) => s.path);
    }, [term, files, openPaths]);

    const commandResults = useMemo(() => {
        if (!term) {
            return [...commands].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
        }
        const scored: { cmd: Command; score: number }[] = [];
        for (const cmd of commands) {
            const ts = fuzzyScore(term, cmd.title);
            const cs = fuzzyScore(term, `${cmd.category} ${cmd.title}`);
            const score = Math.max(ts === null ? -Infinity : ts + 24, cs === null ? -Infinity : cs);
            if (score > -Infinity) scored.push({ cmd, score });
        }
        scored.sort((a, b) => b.score - a.score || a.cmd.title.length - b.cmd.title.length);
        return scored.map((s) => s.cmd);
    }, [term, commands]);

    const count = commandMode ? commandResults.length : fileResults.length;

    // keep the selection valid + scrolled into view as the list changes.
    useEffect(() => {
        setSel((s) => (s >= count ? 0 : s));
    }, [count]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [sel]);

    const choose = (i: number) => {
        if (commandMode) {
            const cmd = commandResults[i];
            if (!cmd) return;
            onClose();
            void (async () => {
                try {
                    await cmd.run({ fs });
                } catch (err) {
                    console.error(`[command] ${cmd.id} failed`, err);
                }
            })();
            return;
        }
        const path = fileResults[i];
        if (!path) return;
        openPath(path, MAIN_PANE);
        onClose();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, count - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(sel);
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
                    placeholder={commandMode ? 'Type a command' : 'Search files by name (> for commands)'}
                    className="border-border border-b bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted"
                />
                <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                    {count === 0 && (
                        <div className="px-3 py-2 text-xs text-fg-muted">
                            {commandMode ? 'No matching commands' : files.length ? 'No matching files' : 'Loading...'}
                        </div>
                    )}
                    {commandMode
                        ? commandResults.map((cmd, i) => (
                              <button
                                  key={cmd.id}
                                  type="button"
                                  data-sel={i === sel}
                                  onPointerEnter={() => setSel(i)}
                                  onClick={() => choose(i)}
                                  className={`flex w-full items-center justify-between gap-3 px-3 py-1 text-left text-xs ${
                                      i === sel ? 'bg-accent text-on-accent' : 'text-fg'
                                  }`}
                              >
                                  <span className="truncate">{cmd.title}</span>
                                  <span className={`shrink-0 text-[11px] ${i === sel ? 'text-on-accent/70' : 'text-fg-muted'}`}>
                                      {cmd.category}
                                  </span>
                              </button>
                          ))
                        : fileResults.map((path, i) => {
                              const glyph = appForFile(path)?.glyph;
                              const dir = dirname(path);
                              return (
                                  <button
                                      key={path}
                                      type="button"
                                      data-sel={i === sel}
                                      onPointerEnter={() => setSel(i)}
                                      onClick={() => choose(i)}
                                      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                                          i === sel ? 'bg-accent text-on-accent' : 'text-fg'
                                      }`}
                                  >
                                      <span className="grid h-4 w-4 shrink-0 place-items-center opacity-80">
                                          {glyph ?? <FileIcon size={13} />}
                                      </span>
                                      <span className="truncate">{basename(path)}</span>
                                      {dir && (
                                          <span className={`truncate text-[11px] ${i === sel ? 'text-on-accent/70' : 'text-fg-muted'}`}>
                                              {dir}
                                          </span>
                                      )}
                                  </button>
                              );
                          })}
                </div>
            </div>
        </div>
    );
}
