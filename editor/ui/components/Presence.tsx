// editor/ui/components/Presence.tsx — connected-participant avatars, pinned to
// the bottom of the taskbar while a multiplayer session is open. Host view: one
// circle per connected guest (first two initials of their username). The editor
// is otherwise square/no-radius, but a presence chip reads as a person — hence a
// circle (owner ask).

import { useMultiplayer } from '../../stores/multiplayer';

function initials(name: string): string {
    const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
    const a = parts[0]?.[0] ?? '';
    const b = parts[1]?.[0] ?? parts[0]?.[1] ?? '';
    return (a + b).toUpperCase() || '?';
}

export function Presence() {
    const status = useMultiplayer((s) => s.status);
    const participants = useMultiplayer((s) => s.participants);
    if (status !== 'open') return null;

    return (
        <div className="flex flex-col items-center gap-1.5">
            {participants.length === 0 ? (
                // no guests yet: a single "live" beacon rather than tiny wrapped
                // text (the readable status lives in the editing window). The dot
                // sits centred in the 44px taskbar column; tooltip spells it out.
                <div className="grid h-8 w-8 place-items-center" title="Live · waiting for guests…">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-green-500" />
                </div>
            ) : (
                participants.map((p) => (
                    <div
                        key={p.localId}
                        title={p.username}
                        className="grid h-8 w-8 place-items-center rounded-full border border-border bg-accent font-mono text-[10px] font-bold text-fg"
                    >
                        {initials(p.username)}
                    </div>
                ))
            )}
        </div>
    );
}
