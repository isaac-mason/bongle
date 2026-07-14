// editor/ui/components/PlatformWindow.tsx — the "editing X" window shown when the
// editor is embedded under a platform. A normal window-manager window (draggable,
// minimizable) but NOT closable: it surfaces the platform intent + the actions
// that comm back out (save avatar / build + publish / save source). Editor-
// initiated — the buttons run the shared platform actions and hand payloads to
// the platform over the bridge. A taskbar entry keeps it reachable if minimized.

import { useEffect } from 'react';
import type { Filesystem } from '../../fs';
import { backToBongle, runBuild, runSave, saveAvatar } from '../../platform/actions';
import { useMultiplayer } from '../../stores/multiplayer';
import { usePlatform } from '../../stores/platform';
import { useWindows } from '../../stores/windows';
import { TASKBAR_W } from './Taskbar';
import { Window } from './Window';

export const PLATFORM_WINDOW_ID = 'platform';

const BTN = 'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-xs hover:bg-hover';

export function PlatformWindow({ fs }: { fs: Filesystem }) {
    const intent = usePlatform((s) => s.intent);
    const embedded = usePlatform((s) => s.embedded);
    const register = useWindows((s) => s.register);

    useEffect(() => {
        if (!embedded) return;
        // avatar mode gives Blockbench the center, so dock the widget top-right;
        // other intents keep it top-left (just right of the taskbar).
        const avatar = intent?.kind === 'avatar';
        register(PLATFORM_WINDOW_ID, {
            x: avatar ? Math.max(TASKBAR_W + 12, window.innerWidth - 252) : TASKBAR_W + 12,
            y: 12,
            w: 240,
            h: 132,
        });
        if (!avatar) return;
        // `register` is idempotent (a prior top-left placement, e.g. across HMR,
        // would stick) and may run before the embedded iframe has its final width.
        // `move` overrides, so re-pin top-right now and on every resize.
        const pin = () => useWindows.getState().move(PLATFORM_WINDOW_ID, window.innerWidth - 252, 12);
        pin();
        window.addEventListener('resize', pin);
        return () => window.removeEventListener('resize', pin);
    }, [embedded, intent, register]);

    if (!embedded || !intent) return null;
    const label = intent.kind === 'avatar' ? (intent.name ?? 'avatar') : 'game';

    return (
        // no onClose → the X minimizes (reopen from the taskbar) rather than destroys.
        <Window id={PLATFORM_WINDOW_ID} title={`editing ${label}`}>
            <div className="flex flex-col gap-1.5 p-2">
                {intent.kind === 'avatar' ? (
                    <button type="button" className={BTN} onClick={() => void saveAvatar(fs, intent.name ?? 'avatar')}>
                        Save avatar to bongle
                    </button>
                ) : (
                    <>
                        <button type="button" className={BTN} onClick={() => void runBuild(fs)}>
                            Build &amp; publish
                        </button>
                        <button type="button" className={BTN} onClick={() => void runSave(fs)}>
                            Save source
                        </button>
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
