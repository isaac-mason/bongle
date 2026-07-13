// editor/ui/components/ImageViewer.tsx — the "image" app: previews an image
// file and live-refreshes when it changes on disk (e.g. saved from the paint
// editor). The toolbar's "edit" button opens the same file in the pixel editor.

import { Paintbrush } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useLaunched } from '../../stores/launched';
import { imageEditorApp } from '../apps';
import { useObjectUrl } from '../hooks/useObjectUrl';
import { imageMime } from '../image-mime';

const CHECKER = 'repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px';

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
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={toolbar}>
                <button type="button" style={toolBtn} onClick={() => useLaunched.getState().launch(imageEditorApp, path)}>
                    <Paintbrush size={13} /> edit
                </button>
                <span style={{ flex: 1 }} />
                <span style={{ color: '#888' }}>
                    {dims ? `${dims.w}×${dims.h}` : ''}
                    {data ? ` · ${fmtBytes(data.length)}` : ''}
                </span>
            </div>
            <div style={stage}>
                {missing ? (
                    <span style={{ color: '#888' }}>(file not found)</span>
                ) : url ? (
                    <img
                        src={url}
                        alt={path}
                        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                        style={{
                            maxWidth: '100%',
                            maxHeight: '100%',
                            objectFit: 'contain',
                            imageRendering: 'pixelated',
                            border: '1px solid #000',
                        }}
                    />
                ) : (
                    <span style={{ color: '#888' }}>(loading…)</span>
                )}
            </div>
        </div>
    );
}

function fmtBytes(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const toolbar: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 6px',
    borderBottom: '1px solid #000',
    font: '12px/1 ui-monospace, monospace',
    flexShrink: 0,
};

const toolBtn: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid #000',
    background: '#fff',
    cursor: 'pointer',
    font: '12px/1 ui-monospace, monospace',
    padding: '3px 8px',
};

const stage: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    placeItems: 'center',
    overflow: 'auto',
    padding: 12,
    background: CHECKER,
};
