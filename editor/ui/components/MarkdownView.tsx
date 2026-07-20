// editor/ui/components/MarkdownView.tsx — rendered Markdown preview for the code
// editor. Reads the live editor buffer (so unsaved edits show) or the fs, and
// re-renders on disk changes. A right-hand "On this page" outline scroll-spies
// the content. Styled via .bongle-md in editor.css.

import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { renderMarkdownWithToc, type TocEntry } from '../markdown';
import { getBufferText } from './Monaco';

// fenced-code info-string → Monaco language id (Monaco ships these grammars).
const MD_LANG: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    typescript: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    javascript: 'javascript',
    json: 'json',
    jsonc: 'json',
    sh: 'shell',
    bash: 'shell',
    shell: 'shell',
    zsh: 'shell',
    css: 'css',
    html: 'html',
    xml: 'xml',
};

export function MarkdownView({ fs, path }: { fs: Filesystem; path: string }) {
    const [doc, setDoc] = useState<{ html: string; toc: TocEntry[] }>({ html: '', toc: [] });
    const [activeId, setActiveId] = useState<string | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            let src = getBufferText(path);
            if (src == null) {
                try {
                    src = await fs.readText(path);
                } catch {
                    src = '';
                }
            }
            if (alive) setDoc(renderMarkdownWithToc(src));
        };
        void load();
        const w = fs.watch((changes) => {
            if (changes.some((c) => c.path === path)) void load();
        });
        return () => {
            alive = false;
            w.close();
        };
    }, [fs, path]);

    // syntax-highlight fenced code blocks after each render. Monaco is already
    // loaded and colorize() honors the active theme, so no extra deps. Colorize
    // from the pristine source captured once per block (data-raw): Monaco joins
    // lines with <br/>, so re-reading a highlighted block's textContent would
    // drop the newlines and garble a re-highlight.
    // biome-ignore lint/correctness/useExhaustiveDependencies: doc.html is the trigger to re-highlight after re-render, not a value read here.
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;
        let alive = true;
        for (const code of el.querySelectorAll<HTMLElement>('code[data-lang]')) {
            const lang = MD_LANG[code.dataset.lang ?? ''];
            if (!lang) continue;
            let raw = code.dataset.raw;
            if (raw == null) {
                raw = code.textContent ?? '';
                code.dataset.raw = raw;
            }
            void monaco.editor.colorize(raw, lang, {}).then((colored) => {
                if (alive) code.innerHTML = colored;
            });
        }
        return () => {
            alive = false;
        };
    }, [doc.html]);

    // scroll-spy: mark the heading nearest the top of the viewport as active.
    useEffect(() => {
        const el = contentRef.current;
        if (!el || doc.toc.length < 2) return;
        const onScroll = () => {
            const top = el.getBoundingClientRect().top;
            let current: string | null = doc.toc[0]?.id ?? null;
            for (const entry of doc.toc) {
                const node = el.querySelector<HTMLElement>(`#${CSS.escape(entry.id)}`);
                if (!node) continue;
                if (node.getBoundingClientRect().top - top <= 80) current = entry.id;
                else break;
            }
            setActiveId(current);
        };
        onScroll();
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, [doc.toc]);

    const goTo = (id: string) => {
        const el = contentRef.current;
        const node = el?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
        if (el && node) {
            const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
            el.scrollTo({ top: el.scrollTop + delta - 12, behavior: 'smooth' });
        }
        setActiveId(id);
    };

    const minLevel = doc.toc.reduce((m, t) => Math.min(m, t.level), 6);

    return (
        <div className="absolute inset-0 flex bg-surface">
            <div
                ref={contentRef}
                className="bongle-md min-w-0 flex-1 overflow-auto"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered Markdown (incl. raw HTML) from a local, user-authored file.
                dangerouslySetInnerHTML={{ __html: doc.html }}
            />
            {doc.toc.length >= 2 && (
                <nav className="w-52 shrink-0 overflow-auto border-border border-l bg-surface px-3 py-4 text-xs">
                    <div className="mb-2 font-medium text-[10px] text-fg-muted uppercase tracking-wide">On this page</div>
                    {doc.toc.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            onClick={() => goTo(entry.id)}
                            style={{ paddingLeft: (entry.level - minLevel) * 10 }}
                            className={`block w-full truncate py-0.5 text-left hover:text-fg ${
                                activeId === entry.id ? 'text-accent' : 'text-fg-muted'
                            }`}
                            title={entry.text}
                        >
                            {entry.text}
                        </button>
                    ))}
                </nav>
            )}
        </div>
    );
}
