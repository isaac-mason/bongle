// editor/ui/components/Blockbench.tsx — the "blockbench" app: ONE window that
// embeds the static Blockbench build (served same-origin at /static/blockbench)
// and lets it keep its native multi-project tabs. The editor fs is the source of
// truth; this bridges the two:
//   - the file tree asks (via the blockbench store) to open an fs path -> we tell
//     Blockbench to open it as a tab (or focus it if already open);
//   - Blockbench's own Save (Ctrl+S / File > Save, intercepted by the plugin)
//     hands artefacts back -> we write the .bbmodel + compiled .glb to the fs
//     (untitled projects prompt for a path first).
// The iframe side is lib/bongle-blockbench's merged plugin.

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useBlockbench } from '../../stores/blockbench';
import { useLaunched } from '../../stores/launched';

const BLOCKBENCH_SRC = '/static/blockbench/index.html';

type Incoming =
    | { type: 'bongle:ready' }
    | { type: 'bongle:save'; path: string; glb: ArrayBuffer | null; bbmodel: string; name: string; warnings: string[] }
    | { type: 'bongle:save-as'; uuid: string; glb: ArrayBuffer | null; bbmodel: string; name: string; warnings: string[] }
    | { type: 'bongle:dirty'; path: string; saved: boolean }
    | { type: 'bongle:save-failed'; errors: string[] }
    | { type: 'bongle:open-failed'; path: string; error: string };

/** a short status line for a completed save. */
function savedNote(path: string, warnings: string[]): string {
    const base = path.split('/').pop();
    return warnings.length ? `saved ${base} (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : `saved ${base}`;
}

/** the compiled .glb sits beside the source (character.bbmodel -> character.glb). */
function glbPathFor(bbmodelPath: string): string {
    return bbmodelPath.replace(/\.bbmodel$/i, '.glb');
}

export function Blockbench({ fs, windowId }: { fs: Filesystem; windowId: string }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [ready, setReady] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const openReq = useBlockbench((s) => s.openReq);
    const dirtyMap = useBlockbench((s) => s.dirty);
    const lastSeq = useRef(-1);

    // reflect "any open file unsaved" onto the window chrome (title-bar dot).
    useEffect(() => {
        useLaunched.getState().setDirty(windowId, Object.values(dirtyMap).some(Boolean));
    }, [dirtyMap, windowId]);

    useEffect(() => {
        const post = (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
        const onMessage = (e: MessageEvent) => {
            if (e.source !== iframeRef.current?.contentWindow || e.origin !== window.location.origin) return;
            const data = e.data as Incoming | undefined;
            if (!data || typeof data !== 'object') return;
            void (async () => {
                switch (data.type) {
                    case 'bongle:ready':
                        setReady(true);
                        break;
                    case 'bongle:save':
                        await fs.write(data.path, data.bbmodel);
                        if (data.glb) await fs.write(glbPathFor(data.path), new Uint8Array(data.glb));
                        useBlockbench.getState().setDirty(data.path, false);
                        setNote(savedNote(data.path, data.warnings));
                        break;
                    case 'bongle:save-as': {
                        const chosen = window.prompt('Save as (path in project):', `${data.name || 'untitled'}.bbmodel`);
                        if (!chosen) return;
                        const path = chosen.replace(/^\/+/, '');
                        await fs.write(path, data.bbmodel);
                        if (data.glb) await fs.write(glbPathFor(path), new Uint8Array(data.glb));
                        post({ type: 'bongle:assign-path', uuid: data.uuid, path });
                        useBlockbench.getState().setDirty(path, false);
                        setNote(savedNote(path, data.warnings));
                        break;
                    }
                    case 'bongle:dirty':
                        useBlockbench.getState().setDirty(data.path, !data.saved);
                        break;
                    case 'bongle:save-failed':
                        setNote(data.errors.join('; ') || 'save failed');
                        break;
                    case 'bongle:open-failed':
                        setNote(`open failed: ${data.error}`);
                        break;
                }
            })();
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [fs]);

    // deliver the pending open request once Blockbench is ready (and on each new one).
    useEffect(() => {
        if (!ready || !openReq || openReq.seq === lastSeq.current) return;
        lastSeq.current = openReq.seq;
        void (async () => {
            let bbmodel = '';
            try {
                bbmodel = await fs.readText(openReq.path);
            } catch {
                /* missing — open blank */
            }
            iframeRef.current?.contentWindow?.postMessage(
                { type: 'bongle:open', path: openReq.path, bbmodel },
                window.location.origin,
            );
        })();
    }, [ready, openReq, fs]);

    const save = () => {
        setNote(null);
        iframeRef.current?.contentWindow?.postMessage({ type: 'bongle:save-active' }, window.location.origin);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={toolbar}>
                <button type="button" style={btn} onClick={save} disabled={!ready}>
                    save
                </button>
                <span style={{ flex: 1 }} />
                <span style={{ color: '#888' }}>{note ?? (ready ? 'ready' : 'loading…')}</span>
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
