// editor/ui/components/Blockbench.tsx — the "blockbench" app: embeds the static
// Blockbench build (served same-origin at /static/blockbench, assembled from
// lib/bongle-blockbench) as an iframe and bridges it over postMessage. Opening a
// .bbmodel seeds it into Blockbench; Save compiles the glb + bbmodel back to the
// editor fs. This is the editor side of the inner contract; the iframe side is
// lib/bongle-blockbench's merged plugin. The bridge talks ONLY to this iframe.

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';

const BLOCKBENCH_SRC = '/static/blockbench/index.html';

type Incoming =
    | { type: 'bongle:ready' }
    | { type: 'bongle:saved'; glb: ArrayBuffer; bbmodel: string; name: string; warnings: string[] }
    | { type: 'bongle:save-failed'; errors: string[] }
    | { type: 'bongle:load-failed'; error: string };

type Status = 'loading' | 'ready' | 'saving' | 'saved' | 'error';

/** the .glb the compiler emits sits beside the source (character.bbmodel -> character.glb). */
function glbPathFor(bbmodelPath: string): string {
    return bbmodelPath.replace(/\.bbmodel$/i, '.glb');
}

export function Blockbench({ fs, path }: { fs: Filesystem; path: string }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [status, setStatus] = useState<Status>('loading');
    const [note, setNote] = useState<string | null>(null);

    useEffect(() => {
        const post = (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);

        const onMessage = (e: MessageEvent) => {
            if (e.source !== iframeRef.current?.contentWindow || e.origin !== window.location.origin) return;
            const data = e.data as Incoming | undefined;
            if (!data || typeof data !== 'object') return;

            void (async () => {
                switch (data.type) {
                    case 'bongle:ready': {
                        setStatus('ready');
                        // seed the iframe with this file, or a fresh character if new/empty.
                        let bbmodel = '';
                        try {
                            bbmodel = await fs.readText(path);
                        } catch {
                            /* new file */
                        }
                        if (bbmodel.trim()) {
                            post({ type: 'bongle:load', bbmodel, name: path.split('/').pop(), origin: path });
                        } else {
                            post({ type: 'bongle:new', origin: path });
                        }
                        break;
                    }
                    case 'bongle:saved': {
                        await fs.write(path, data.bbmodel);
                        await fs.write(glbPathFor(path), new Uint8Array(data.glb));
                        post({ type: 'bongle:clear-draft' });
                        setStatus('saved');
                        setNote(data.warnings.length ? `saved (${data.warnings.length} warnings)` : 'saved');
                        break;
                    }
                    case 'bongle:save-failed':
                        setStatus('error');
                        setNote(data.errors.join('; ') || 'save failed');
                        break;
                    case 'bongle:load-failed':
                        setStatus('error');
                        setNote(data.error || 'load failed');
                        break;
                }
            })();
        };

        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [fs, path]);

    const save = () => {
        setStatus('saving');
        setNote(null);
        iframeRef.current?.contentWindow?.postMessage({ type: 'bongle:save-request' }, window.location.origin);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={toolbar}>
                <button type="button" style={btn} onClick={save} disabled={status === 'loading'}>
                    save
                </button>
                <span style={{ flex: 1 }} />
                <span style={{ color: status === 'error' ? '#c00' : '#888' }}>{note ?? status}</span>
            </div>
            <iframe
                ref={iframeRef}
                src={BLOCKBENCH_SRC}
                title="Blockbench"
                allow="clipboard-read; clipboard-write; fullscreen"
                style={{ flex: 1, minHeight: 0, border: 'none', width: '100%' }}
            />
        </div>
    );
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

const btn: CSSProperties = {
    border: '1px solid #000',
    background: '#fff',
    cursor: 'pointer',
    font: '12px/1 ui-monospace, monospace',
    padding: '3px 10px',
};
