// editor/ui/components/ImageViewer.tsx — the "image" app: previews an image
// file and live-refreshes when it changes on disk (e.g. saved from the paint
// editor). The toolbar's "edit" button opens the same file in the pixel editor.

import { Paintbrush } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useLaunched } from '../../stores/launched';
import { imageEditorApp } from '../apps';
import { useObjectUrl } from '../hooks/useObjectUrl';
import { imageMime } from '../image-mime';

// transparency checkerboard, tinted to the dark surface.
const CHECKER = 'repeating-conic-gradient(#2a2e35 0% 25%, #202329 0% 50%) 50% / 16px 16px';

export function ImageViewer({ fs, path }: { fs: Filesystem; path: string }) {
    const [data, setData] = useState<Uint8Array | null>(null);
    const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
    const [missing, setMissing] = useState(false);
    const url = useObjectUrl(data, imageMime(path));

    useEffect(() => {
        let alive = true;
        const load = async () => {
            if (!(await fs.exists(path))) {
                if (alive) {
                    setMissing(true);
                    setData(null);
                }
                return;
            }
            const bytes = await fs.read(path);
            if (!alive) return;
            setMissing(false);
            setData(bytes);
        };
        void load();
        // re-read when the file changes underneath us (paint editor save, bake…).
        const w = fs.watch((changes) => {
            if (changes.some((c) => c.path === path)) void load();
        });
        return () => {
            alive = false;
            w.close();
        };
    }, [fs, path]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-1.5 py-1 font-mono text-xs">
                <button
                    type="button"
                    className="flex cursor-pointer items-center gap-[5px] border border-border bg-surface px-2 py-[3px] font-mono text-xs text-fg"
                    onClick={() => useLaunched.getState().launch(imageEditorApp, path)}
                >
                    <Paintbrush size={13} /> edit
                </button>
                <span className="flex-1" />
                <span className="text-fg-muted">
                    {dims ? `${dims.w}×${dims.h}` : ''}
                    {data ? ` · ${fmtBytes(data.length)}` : ''}
                </span>
            </div>
            <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3" style={{ background: CHECKER }}>
                {missing ? (
                    <span className="text-fg-muted">(file not found)</span>
                ) : url ? (
                    <img
                        src={url}
                        alt={path}
                        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                        className="max-h-full max-w-full border border-border object-contain [image-rendering:pixelated]"
                    />
                ) : (
                    <span className="text-fg-muted">(loading…)</span>
                )}
            </div>
        </div>
    );
}

function fmtBytes(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
