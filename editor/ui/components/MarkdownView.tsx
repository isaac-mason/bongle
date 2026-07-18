// editor/ui/components/MarkdownView.tsx — rendered Markdown preview for the code
// editor. Reads the live editor buffer (so unsaved edits show) or the fs, and
// re-renders on disk changes. Styled via .bongle-md in index.html.

import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { renderMarkdown } from '../markdown';
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
    const [html, setHtml] = useState('');
    const ref = useRef<HTMLDivElement>(null);

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
            if (alive) setHtml(renderMarkdown(src));
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

    // syntax-highlight fenced code blocks after each render — Monaco is already
    // loaded and colorize() honors the active theme, so no extra deps. Runs on
    // `html` change (post-innerHTML commit); unknown languages are left as-is.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let alive = true;
        for (const code of el.querySelectorAll<HTMLElement>('code[data-lang]')) {
            const lang = MD_LANG[code.dataset.lang ?? ''];
            if (!lang) continue;
            void monaco.editor.colorize(code.textContent ?? '', lang, {}).then((colored) => {
                if (alive) code.innerHTML = colored;
            });
        }
        return () => {
            alive = false;
        };
    }, [html]);

    return (
        <div
            ref={ref}
            className="bongle-md absolute inset-0 overflow-auto bg-surface"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered Markdown (incl. raw HTML) from a local, user-authored file.
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
