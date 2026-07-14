// editor/ui/components/PlatformWindow.tsx — the "editing X" window shown when the
// editor is embedded under a platform. A normal window-manager window (draggable,
// minimizable) but NOT closable: it surfaces the platform intent + the actions
// that comm back out (save avatar / build + publish / save source). Editor-
// initiated — the buttons run the shared platform actions and hand payloads to
// the platform over the bridge. A taskbar entry keeps it reachable if minimized.

import { useEffect } from 'react';
import type { Filesystem } from '../../fs';
import { runBuild, runSave, saveAvatar } from '../../platform/actions';
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
        if (embedded) register(PLATFORM_WINDOW_ID, { x: TASKBAR_W + 12, y: 12, w: 240, h: 132 });
    }, [embedded, register]);

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
                    </>
                )}
            </div>
        </Window>
    );
}
