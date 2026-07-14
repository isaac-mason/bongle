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
        <div className="flex flex-col items-center gap-1.5 pt-1.5">
            <div className="h-px w-6 bg-border" />
            {participants.length === 0 ? (
                <span className="text-center text-[8px] leading-tight text-muted">waiting for guests</span>
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
