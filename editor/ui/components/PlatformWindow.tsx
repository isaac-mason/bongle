// editor/ui/components/PlatformWindow.tsx — the "editing X" window shown when the
// editor is embedded under a platform. A normal window-manager window (draggable,
// minimizable) but NOT closable: it surfaces the platform intent + the actions
// that comm back out (save avatar / build + publish / save source). Editor-
// initiated — the buttons run the shared platform actions and hand payloads to
// the platform over the bridge. A taskbar entry keeps it reachable if minimized.

import { useEffect, useState } from 'react';
import type { Filesystem } from '../../fs';
import { backToBongle, runBuild, runSave, saveAvatar } from '../../platform/actions';
import { isSourcePath, SAVE_MAX_BYTES, SAVE_WARN_BYTES, saveSizeBytes } from '../../project-save';
import { useAutosave } from '../../stores/autosave';
import { useMultiplayer } from '../../stores/multiplayer';
import { usePlatform } from '../../stores/platform';
import { useWindows } from '../../stores/windows';
import { TASKBAR_W } from './Taskbar';
import { Window } from './Window';

export const PLATFORM_WINDOW_ID = 'platform';

const BTN = 'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-xs hover:bg-hover';

// bigger footprint now that the window carries build/save + the multiplayer
// control (which grows a share-link block when a session is open).
const PLATFORM_W = 300;
const PLATFORM_H = 260;

export function PlatformWindow({ fs }: { fs: Filesystem }) {
    const intent = usePlatform((s) => s.intent);
    const embedded = usePlatform((s) => s.embedded);
    const register = useWindows((s) => s.register);

    useEffect(() => {
        if (!embedded) return;
        // dock top-right for BOTH game + avatar — keeps the canvas center clear.
        // `register` is idempotent (a stale placement across HMR would stick) and
        // may run before the iframe has its final width, so re-pin the x now + on
        // every resize.
        const topRightX = () => Math.max(TASKBAR_W + 12, window.innerWidth - PLATFORM_W - 12);
        register(PLATFORM_WINDOW_ID, { x: topRightX(), y: 12, w: PLATFORM_W, h: PLATFORM_H });
        const pin = () => useWindows.getState().move(PLATFORM_WINDOW_ID, topRightX(), 12);
        pin();
        window.addEventListener('resize', pin);
        return () => window.removeEventListener('resize', pin);
    }, [embedded, register]);

    if (!embedded || !intent) return null;
    const label = intent.kind === 'avatar' ? (intent.name ?? 'avatar') : 'project';

    return (
        // no onClose → the X minimizes (reopen from the taskbar) rather than destroys.
        <Window id={PLATFORM_WINDOW_ID} title={`editing ${label}`}>
            <div className="flex flex-col gap-1.5 p-2">
                {intent.kind === 'avatar' ? (
                    <button
                        type="button"
                        className={BTN}
                        onClick={() => void saveAvatar(fs, intent.name ?? 'avatar', intent.canEdit)}
                    >
                        Save avatar to bongle
                    </button>
                ) : (
                    <>
                        <button type="button" className={BTN} onClick={() => void runBuild(fs)}>
                            Build &amp; publish
                        </button>
                        <section className="flex flex-col gap-1.5 border border-border p-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">Save</span>
                            <DraftButton />
                            <SaveButton fs={fs} />
                            <SaveSizeIndicator fs={fs} />
                        </section>
                        <MultiplayerControl />
                    </>
                )}
                {/* leave the editor — common to every intent. Confirms first. */}
                <button type="button" className={`${BTN} mt-0.5 text-fg-muted`} onClick={backToBongle}>
                    Back to bongle.io
                </button>
            </div>
        </Window>
    );
}

/** Save version button: mints an immutable manual version (enters history, is what
 *  builds come from). Lifecycle feedback — "Saving…" (disabled) while the platform
 *  uploads, then a transient "Saved" tick or a sticky error from the bongle:result. */
function SaveButton({ fs }: { fs: Filesystem }) {
    const status = usePlatform((s) => s.saveStatus);
    const message = usePlatform((s) => s.saveMessage);
    const resetSave = usePlatform((s) => s.resetSave);

    // clear the transient "Saved" tick after a moment; errors stay until the next save.
    useEffect(() => {
        if (status !== 'saved') return;
        const t = setTimeout(resetSave, 2500);
        return () => clearTimeout(t);
    }, [status, resetSave]);

    return (
        <>
            <button type="button" className={BTN} disabled={status === 'saving'} onClick={() => void runSave(fs)}>
                {status === 'saving' ? 'Saving…' : 'Save version'}
            </button>
            {status === 'saved' && <span className="text-[10px] text-green-500">Saved ✓</span>}
            {status === 'error' && <span className="text-[10px] text-red-500">{message ?? 'Save failed'}</span>}
        </>
    );
}

/** Save draft button: force an immediate draft snapshot (the working copy) without
 *  minting a version — the crash-net on demand. Drafts have no bongle:result ack, so
 *  feedback is optimistic: a transient "Draft saved" once the flush resolves. Hidden
 *  until the autosave driver is armed (embedded + a project intent). */
function DraftButton() {
    const flush = useAutosave((s) => s.flush);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        if (!saved) return;
        const t = setTimeout(() => setSaved(false), 2500);
        return () => clearTimeout(t);
    }, [saved]);

    if (!flush) return null;

    const onSaveDraft = async () => {
        setBusy(true);
        setSaved(false);
        try {
            await flush();
            setSaved(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button type="button" className={BTN} disabled={busy} onClick={() => void onSaveDraft()}>
                {busy ? 'Saving draft…' : 'Save draft'}
            </button>
            {saved && <span className="text-[10px] text-green-500">Draft saved ✓</span>}
        </>
    );
}

/** Live estimate of the current save size, amber past the warn threshold and red
 *  over the hard cap (a save over the cap is refused). Recomputes only on
 *  SOURCE-file changes (not derived bake writes), so it stays cheap + event-driven. */
function SaveSizeIndicator({ fs }: { fs: Filesystem }) {
    const [bytes, setBytes] = useState<number | null>(null);
    useEffect(() => {
        let live = true;
        const recompute = () =>
            void saveSizeBytes(fs).then((b) => {
                if (live) setBytes(b);
            });
        recompute();
        const handle = fs.watch((changes) => {
            if (changes.some((c) => isSourcePath(c.path))) recompute();
        });
        return () => {
            live = false;
            handle.close();
        };
    }, [fs]);

    if (bytes === null) return null;
    const capMb = SAVE_MAX_BYTES / (1024 * 1024);
    const mb = bytes / (1024 * 1024);
    const over = bytes > SAVE_MAX_BYTES;
    const warn = bytes > SAVE_WARN_BYTES;
    const pct = Math.min(100, (bytes / SAVE_MAX_BYTES) * 100);
    const textColor = over ? 'text-red-500' : warn ? 'text-amber-500' : 'text-fg-muted';
    const barColor = over ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-fg-muted';
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-[10px]">
                <span className="text-fg-muted">Disk used</span>
                <span className={textColor}>
                    {mb.toFixed(1)} / {capMb} MB
                </span>
            </div>
            {/* fill bar: how full the save is against the hard cap. */}
            <div className="h-1.5 w-full border border-border bg-surface">
                <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            {over && <span className="text-[10px] text-red-500">Over the {capMb} MB limit — trim assets to save.</span>}
        </div>
    );
}

const BTN2 = 'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-xs hover:bg-hover';

/** Open-to-multiplayer button + share link. Solo until pressed. */
function MultiplayerControl() {
    const status = useMultiplayer((s) => s.status);
    const shareUrl = useMultiplayer((s) => s.shareUrl);
    const error = useMultiplayer((s) => s.error);

    if (status === 'open' && shareUrl) {
        return (
            <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted">Share this link to co-edit:</span>
                <input
                    readOnly
                    className="w-full border border-border bg-surface px-1.5 py-1 text-[10px]"
                    value={shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" className={BTN2} onClick={() => void navigator.clipboard?.writeText(shareUrl)}>
                    Copy invite link
                </button>
            </div>
        );
    }
    return (
        <>
            <button
                type="button"
                className={BTN2}
                disabled={status === 'opening'}
                onClick={() => void useMultiplayer.getState().open()}
            >
                {status === 'opening' ? 'Opening…' : 'Open to multiplayer'}
            </button>
            {status === 'error' && <span className="text-[10px] text-red-500">{error}</span>}
        </>
    );
}
