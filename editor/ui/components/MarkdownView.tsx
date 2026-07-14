// editor/ui/components/MarkdownView.tsx — rendered Markdown preview for the code
// editor. Reads the live editor buffer (so unsaved edits show) or the fs, and
// re-renders on disk changes. Styled via .bongle-md in index.html.

import { useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { renderMarkdown } from '../markdown';
import { getBufferText } from './Monaco';

export function MarkdownView({ fs, path }: { fs: Filesystem; path: string }) {
    const [html, setHtml] = useState('');

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

    return (
        <div
            className="bongle-md absolute inset-0 overflow-auto bg-surface"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered Markdown (incl. raw HTML) from a local, user-authored file.
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
