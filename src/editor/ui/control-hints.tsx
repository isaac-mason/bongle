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

// a repeated key (double-tap sprint/noclip) gets a tiny "×2" chip after it rather than a wordy
// "(double-tap)" label suffix.
function Twice({ children }: { children: ReactNode }) {
    return (
        <>
            {children}
            <Kbd size="xs">×2</Kbd>
        </>
    );
}

const CHARACTER_HINTS: Hint[] = [
    { keys: <Kbd>mouse</Kbd>, label: 'look' },
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
    { keys: <Kbd>Space</Kbd>, label: 'jump' },
    { keys: <Kbd>Shift</Kbd>, label: 'crouch' },
    {
        keys: (
            <Twice>
                <Kbd>Space</Kbd>
            </Twice>
        ),
        label: 'toggle fly',
    },
    {
        keys: (
            <Twice>
                <Kbd>W</Kbd>
            </Twice>
        ),
        label: 'sprint',
    },
];

/** mode-agnostic, appended after whichever list above applies. */
const MODE_CYCLE_HINT: Hint = { keys: <Kbd>M</Kbd>, label: 'cycle control mode' };

/** unpositioned: the caller places it (currently stacked above the control-mode switch). */
export function ControlHints() {
    const controlMode = useEditRoom((s) => s.controlMode);
    const modeHints = controlMode === 'fly' ? FLY_HINTS : controlMode === 'orbit' ? ORBIT_HINTS : CHARACTER_HINTS;
    const hints = [...modeHints, MODE_CYCLE_HINT];

    return (
        <div className="flex flex-col gap-1 border border-border bg-surface/90 px-2 py-1.5 pointer-events-none select-none">
            {hints.map((h) => (
                <div key={h.label} className="flex items-center justify-between gap-3 text-[10px] font-mono">
                    <span className="flex items-center gap-0.5">{h.keys}</span>
                    <span className="text-fg-muted">{h.label}</span>
                </div>
            ))}
        </div>
    );
}
