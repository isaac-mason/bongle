// editor/ui/components/Blockbench.tsx — the "blockbench" app: ONE window that
// embeds the static Blockbench build (served same-origin at /static/blockbench)
// and lets it keep its native multi-project tabs + File menu. The editor fs is
// the source of truth; this bridges the two:
//   - the file tree asks (via the blockbench store) to open an fs path -> we tell
//     Blockbench to open it as a tab (or focus it if already open);
//   - Blockbench's own Save (Ctrl+S / File > Save, intercepted by the plugin)
//     hands artefacts back -> we write the .bbmodel + compiled .glb to the fs
//     (untitled projects prompt for a path first).
// Saving is Blockbench-native, so there's no editor chrome here — just the iframe.
// The iframe side is lib/blockbench's merged plugin.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filesystem } from '../../fs';
import { useBlockbench } from '../../stores/blockbench';
import { useLaunched } from '../../stores/launched';
import { useWindows } from '../../stores/windows';
import { BLOCKBENCH_VERSION } from '../blockbench-version';

// base-relative so it resolves at dev root AND under the deployed subpath
// (/static/bongle-editor/static/blockbench/…) — see editor/vite.config's base.
// The version segment is a content hash of the bundle (build stamps it): a
// changed bundle lands at a new path so the whole thing can be cached immutable.
const BLOCKBENCH_SRC = `${import.meta.env.BASE_URL}static/blockbench/${BLOCKBENCH_VERSION}/index.html`;

type Incoming =
    | { type: 'bongle:ready' }
    | { type: 'bongle:save'; path: string; glb: ArrayBuffer | null; bbmodel: string; name: string; warnings: string[] }
    | { type: 'bongle:save-as'; uuid: string; glb: ArrayBuffer | null; bbmodel: string; name: string; warnings: string[] }
    | { type: 'bongle:autosave'; path: string; bbmodel: string }
    | { type: 'bongle:dirty'; path: string; saved: boolean }
    | { type: 'bongle:opened'; path: string }
    | { type: 'bongle:save-failed'; errors: string[] }
    | { type: 'bongle:open-failed'; path: string; error: string };

// idle window after the last edit before we ask Blockbench for a silent source
// snapshot (matches the platform autosave debounce — no point flushing faster).
const AUTOSAVE_IDLE_MS = 8_000;

/** the compiled .glb sits beside the source (character.bbmodel -> character.glb). */
function glbPathFor(bbmodelPath: string): string {
    return bbmodelPath.replace(/\.bbmodel$/i, '.glb');
}

export function Blockbench({ fs, windowId }: { fs: Filesystem; windowId: string }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [ready, setReady] = useState(false);
    const openReq = useBlockbench((s) => s.openReq);
    const dirtyMap = useBlockbench((s) => s.dirty);
    const sourceLoading = useBlockbench((s) => s.sourceLoading);
    const lastSeq = useRef(-1);
    // debounce handle for the silent source-snapshot request (crash-net autosave).
    const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // a transient "wrote …" confirmation, shown over the iframe after a save.
    const [savedToast, setSavedToast] = useState<string | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashSaved = useCallback((wrote: string) => {
        setSavedToast(wrote);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setSavedToast(null), 2500);
    }, []);

    // reflect "any open file unsaved" onto the window chrome (title-bar dot).
    useEffect(() => {
        useLaunched.getState().setDirty(windowId, Object.values(dirtyMap).some(Boolean));
    }, [dirtyMap, windowId]);

    // Robust Ctrl/Cmd+S when the Blockbench WINDOW is active but DOM focus sits in the
    // parent doc (its title bar, the desktop) rather than inside the iframe. There the
    // plugin's own in-iframe handler never sees the key, so the browser's "save page"
    // dialog would fire. Catch it here (capture, so it beats the browser) and ask the
    // iframe to save the active project. Focus INSIDE the iframe stays the plugin's job
    // — the parent never receives that keydown, so there's no double-save.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== 's' && e.key !== 'S')) return;
            if (useWindows.getState().focused !== windowId) return;
            e.preventDefault();
            iframeRef.current?.contentWindow?.postMessage({ type: 'bongle:save-active' }, window.location.origin);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [windowId]);

    useEffect(() => () => void (toastTimer.current !== null && clearTimeout(toastTimer.current)), []);

    useEffect(() => {
        const post = (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
        // (re)arm the debounced snapshot request: after the edits settle, ask
        // Blockbench for the current .bbmodel source so the platform's autosave can
        // capture it — no user Ctrl+S required.
        const armAutosave = () => {
            if (autosaveTimer.current !== null) clearTimeout(autosaveTimer.current);
            autosaveTimer.current = setTimeout(() => {
                autosaveTimer.current = null;
                post({ type: 'bongle:autosave-request' });
            }, AUTOSAVE_IDLE_MS);
        };
        const onMessage = (e: MessageEvent) => {
            if (e.source !== iframeRef.current?.contentWindow || e.origin !== window.location.origin) return;
            const data = e.data as Incoming | undefined;
            if (!data || typeof data !== 'object') return;
            void (async () => {
                switch (data.type) {
                    case 'bongle:ready':
                        setReady(true);
                        break;
                    case 'bongle:opened':
                        // the model finished loading in Blockbench — lift the "loading
                        // avatar…" cover (avatar mode boots covered until the model is in).
                        useBlockbench.getState().setSourceLoading(false);
                        break;
                    case 'bongle:save':
                        await fs.write(data.path, data.bbmodel);
                        if (data.glb) await fs.write(glbPathFor(data.path), new Uint8Array(data.glb));
                        useBlockbench.getState().setDirty(data.path, false);
                        flashSaved(data.glb ? `"${data.path}" + "${glbPathFor(data.path)}"` : `"${data.path}" (glb skipped)`);
                        break;
                    case 'bongle:autosave':
                        // Silent source snapshot: write ONLY the .bbmodel (no glb), and
                        // leave the dirty flag alone — the work is still unsaved to bongle.
                        // The fs write is what the platform autosave watcher picks up.
                        await fs.write(data.path, data.bbmodel);
                        break;
                    case 'bongle:save-as': {
                        const chosen = window.prompt('Save as (path in project):', `${data.name || 'untitled'}.bbmodel`);
                        if (!chosen) return;
                        const path = chosen.replace(/^\/+/, '');
                        await fs.write(path, data.bbmodel);
                        if (data.glb) await fs.write(glbPathFor(path), new Uint8Array(data.glb));
                        post({ type: 'bongle:assign-path', uuid: data.uuid, path });
                        useBlockbench.getState().setDirty(path, false);
                        flashSaved(data.glb ? `"${path}" + "${glbPathFor(path)}"` : `"${path}" (glb skipped)`);
                        break;
                    }
                    case 'bongle:dirty':
                        useBlockbench.getState().setDirty(data.path, !data.saved);
                        // an unsaved edit → schedule a silent source snapshot (crash-net).
                        if (!data.saved) armAutosave();
                        break;
                    case 'bongle:save-failed':
                        console.warn('[blockbench] save failed:', data.errors.join('; '));
                        break;
                    case 'bongle:open-failed':
                        console.warn('[blockbench] open failed:', data.path, data.error);
                        break;
                }
            })();
        };
        window.addEventListener('message', onMessage);
        return () => {
            window.removeEventListener('message', onMessage);
            if (autosaveTimer.current !== null) clearTimeout(autosaveTimer.current);
        };
    }, [fs, flashSaved]);

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

    return (
        <div className="relative h-full w-full">
            <iframe
                ref={iframeRef}
                src={BLOCKBENCH_SRC}
                title="Blockbench"
                // Blockbench uses a SharedArrayBuffer worker while processing a model,
                // so this nested iframe needs cross-origin isolation delegated too
                // (only bites in avatar mode, which auto-loads a .bbmodel — a blank
                // Blockbench never touches SAB).
                allow="cross-origin-isolated; clipboard-read; clipboard-write; fullscreen"
                className="block h-full w-full border-none"
            />
            {sourceLoading && (
                <div className="bb-loading">
                    <div className="bb-loading-mark">bongle</div>
                    <div className="bb-loading-label">loading avatar…</div>
                </div>
            )}
            {savedToast && (
                <div className="pointer-events-none absolute bottom-2 right-2 border border-border bg-background px-2 py-1 text-xs">
                    <span className="font-semibold">Saved</span> <span className="font-mono text-muted">wrote {savedToast}</span>
                </div>
            )}
        </div>
    );
}
