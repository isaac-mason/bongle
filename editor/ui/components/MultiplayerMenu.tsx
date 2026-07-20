// editor/ui/components/MultiplayerMenu.tsx — a taskbar footer button that folds out
// the "Open to multiplayer" control: dial the relay to co-edit, then the share link
// + stop while a session is live. Moved here from the platform window so co-editing
// is reachable straight from the sidebar; the Presence dots below show who's in.
//
// The globe glyphs are inlined (not from bongle/icons) so they resolve live in the
// editor build without an icon-bundle rebuild — globe = idle, globe-check = live.

import { useEffect, useRef, useState } from 'react';
import { useMultiplayer } from '../../stores/multiplayer';

const BTN = 'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-xs hover:bg-hover';
// stop is the one destructive control here; red text sets it apart.
const STOP_BTN =
    'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-center text-xs font-medium text-red-500 hover:bg-hover';

const svgBase = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
} as const;

function GlobeIcon({ size = 18 }: { size?: number }) {
    return (
        <svg width={size} height={size} {...svgBase}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
        </svg>
    );
}

function GlobeCheckIcon({ size = 18 }: { size?: number }) {
    return (
        <svg width={size} height={size} {...svgBase}>
            <path d="m15 6 2 2 4-4" />
            <path d="M2 12h20A10 10 0 1 1 12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 4-10" />
        </svg>
    );
}

export function MultiplayerMenu() {
    const status = useMultiplayer((s) => s.status);
    const shareUrl = useMultiplayer((s) => s.shareUrl);
    const participants = useMultiplayer((s) => s.participants);
    const error = useMultiplayer((s) => s.error);
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        // dismiss on outside pointerdown / Escape (same pattern as ContextMenu).
        const onDown = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
        window.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const live = status === 'open';
    const count = participants.length;

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                aria-label="Multiplayer"
                className={`group relative grid h-8 w-8 cursor-pointer place-items-center border border-border font-mono text-[15px] leading-none ${
                    open ? 'taskbar-active' : live ? 'bg-surface text-green-500' : 'bg-surface text-fg'
                }`}
                onClick={() => setOpen((v) => !v)}
            >
                {live ? <GlobeCheckIcon /> : <GlobeIcon />}
                {/* hover label, matching the other taskbar icons (hidden while open). */}
                {!open && (
                    <span className="pointer-events-none absolute top-1/2 left-full z-[1] ml-2 hidden -translate-y-1/2 whitespace-nowrap border border-border bg-surface px-2 py-1 font-mono text-xs text-fg shadow-[2px_2px_0_rgba(0,0,0,0.4)] group-hover:block">
                        {live ? 'Multiplayer · live' : 'Multiplayer'}
                    </span>
                )}
            </button>
            {open && (
                // anchored to the right of the button, bottom-aligned so it grows up.
                <div className="absolute bottom-0 left-full z-[2000000] ml-2 w-64 border border-border bg-surface p-2 shadow-[2px_2px_0_rgba(0,0,0,0.5)]">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">Multiplayer</span>
                        {live && shareUrl ? (
                            <>
                                {/* readable live status — the Presence dots show who's in. */}
                                <div className="flex items-center gap-1.5">
                                    <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                                    <span className="text-[10px] text-fg">
                                        {count === 0
                                            ? 'Live · waiting for guests…'
                                            : `Live · ${count} guest${count === 1 ? '' : 's'} connected`}
                                    </span>
                                </div>
                                <span className="text-[10px] text-muted">Share this link to co-edit:</span>
                                <input
                                    readOnly
                                    className="w-full border border-border bg-surface px-1.5 py-1 text-[10px]"
                                    value={shareUrl}
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                                <button type="button" className={BTN} onClick={() => void navigator.clipboard?.writeText(shareUrl)}>
                                    Copy invite link
                                </button>
                                <button type="button" className={STOP_BTN} onClick={() => useMultiplayer.getState().close()}>
                                    Stop multiplayer
                                </button>
                            </>
                        ) : (
                            <>
                                <p className="text-[10px] leading-snug text-fg-muted">
                                    Invite others to edit this project with you, live.
                                </p>
                                <button
                                    type="button"
                                    className={BTN}
                                    disabled={status === 'opening'}
                                    onClick={() => void useMultiplayer.getState().open()}
                                >
                                    {status === 'opening' ? 'Opening…' : 'Open to multiplayer'}
                                </button>
                                {status === 'error' && <span className="text-[10px] text-red-500">{error}</span>}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
