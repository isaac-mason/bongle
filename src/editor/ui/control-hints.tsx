// Control indicator, bottom-right of the viewport. Shows the equipped camera
// controller's input scheme as keycap rows (fly / orbit only — character has the
// crosshair instead). Passive: pointer-events off, reads controlMode from the
// edit-room store. Reuses the shared <Kbd> keycap for both keyboard keys and
// mouse-button chips so every control indicator looks the same.

import type { ReactNode } from 'react';
import { useEditRoom } from '../edit-room-store';
import { Kbd } from './kbd';

type Hint = { keys: ReactNode; label: string };

const FLY_HINTS: Hint[] = [
    { keys: <Kbd>RMB</Kbd>, label: 'look' },
    {
        keys: (
            <>
                <Kbd>W</Kbd>
                <Kbd>A</Kbd>
                <Kbd>S</Kbd>
                <Kbd>D</Kbd>
            </>
        ),
        label: 'move',
    },
    {
        keys: (
            <>
                <Kbd>Space</Kbd>
                <Kbd>Shift</Kbd>
            </>
        ),
        label: 'up / down',
    },
    { keys: <Kbd>scroll</Kbd>, label: 'speed' },
];

const ORBIT_HINTS: Hint[] = [
    { keys: <Kbd>LMB</Kbd>, label: 'rotate' },
    { keys: <Kbd>RMB</Kbd>, label: 'pan' },
    { keys: <Kbd>scroll</Kbd>, label: 'zoom' },
];

export function ControlHints() {
    const controlMode = useEditRoom((s) => s.controlMode);
    const hints = controlMode === 'fly' ? FLY_HINTS : controlMode === 'orbit' ? ORBIT_HINTS : null;
    if (!hints) return null;

    return (
        <div className="absolute bottom-2 right-2 z-10 pointer-events-none select-none">
            <div className="flex flex-col gap-1 border border-neutral-200 bg-white/90 px-2 py-1.5">
                {hints.map((h) => (
                    <div key={h.label} className="flex items-center justify-between gap-3 text-[10px] font-mono">
                        <span className="flex items-center gap-0.5">{h.keys}</span>
                        <span className="text-neutral-500">{h.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
