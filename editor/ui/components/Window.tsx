// editor/ui/components/Window.tsx — a single draggable / resizable window.
//
// Square, black-bordered (bongle UI style) with macOS-style behavior: title
// bar drags, corner handle resizes, chrome buttons minimize / maximize /
// close. Pointer events, hand-rolled, no lib. When no explicit `onClose` is
// provided (fixed windows like code / logs) the X button minimizes instead
// — users re-open from the taskbar.
//
// Dragging near a desktop edge/corner previews + commits an Aero-style snap
// (full / half / quarter); dragging a snapped window peels it back to floating.

import { Maximize2, Minimize2, Minus, X } from 'bongle/icons';
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { MIN_H, MIN_W, type SnapZone, useSnapPreview, useWindows, zoneAt } from '../../stores/windows';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

// the four resize corners: position + cursor, `se` also carries the visible grip.
const CORNERS: { corner: Corner; cls: string; grip?: boolean }[] = [
    { corner: 'nw', cls: 'top-0 left-0 cursor-nwse-resize' },
    { corner: 'ne', cls: 'top-0 right-0 cursor-nesw-resize' },
    { corner: 'sw', cls: 'bottom-0 left-0 cursor-nesw-resize' },
    { corner: 'se', cls: 'right-0 bottom-0 cursor-nwse-resize', grip: true },
];

// striped corner grip in the muted fg colour so it reads on the dark surface.
const GRIP_BG: CSSProperties = {
    background:
        'linear-gradient(135deg, transparent 50%, var(--color-fg-muted) 50%, var(--color-fg-muted) 60%, transparent 60%, transparent 75%, var(--color-fg-muted) 75%)',
};

/** shared pointer-drag: delta-drive `onDelta` (with live client coords), fire
 *  `onEnd` on release. While dragging, the `window-dragging` body class makes
 *  iframes pointer-transparent (see editor.css) so moving over the game client /
 *  Blockbench doesn't swallow the move events. */
function beginDrag(
    e: ReactPointerEvent,
    onDelta: (dx: number, dy: number, clientX: number, clientY: number) => void,
    onEnd?: () => void,
): void {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    document.body.classList.add('window-dragging');
    const onMove = (ev: PointerEvent) => onDelta(ev.clientX - startX, ev.clientY - startY, ev.clientX, ev.clientY);
    const onUp = () => {
        document.body.classList.remove('window-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        onEnd?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

// chrome button (minimize / maximize / close) — z-10 so it stays clickable over
// the top corner resize handles.
const btnClass =
    'relative z-10 grid h-[18px] w-[18px] cursor-pointer place-items-center border border-border bg-surface p-0 font-mono text-[11px] leading-none text-fg';

export function Window({
    id,
    title,
    children,
    dirty,
    onClose,
    keepMounted,
}: {
    id: string;
    title: string;
    children: ReactNode;
    dirty?: boolean;
    onClose?: () => void;
    /** keep the DOM mounted (hidden) while minimized instead of unmounting.
     *  Client windows hold a live <iframe> (WebGPU + engine + connection) that
     *  would be destroyed on detach, so they hide rather than unmount. */
    keepMounted?: boolean;
}) {
    const g = useWindows((s) => s.geom[id]);
    const focused = useWindows((s) => s.focused === id);
    const { focus, move, setBox, setMode, toggleMax, snapTo, unsnap } = useWindows.getState();

    if (!g) return null;
    const minimized = g.mode === 'minimized';
    if (minimized && !keepMounted) return null;
    const snapped = g.snap != null;
    const max = g.snap === 'full';

    const startMove = (e: ReactPointerEvent) => {
        e.stopPropagation();
        focus(id);
        const { setZone } = useSnapPreview.getState();

        // where the window's top-left lands once dragged. For a snapped window this
        // is the peeled-off floating position: keep the pointer at the same
        // proportional spot along the (now narrower) title bar so it doesn't jump
        // out from under. The peel itself is deferred until a real drag crosses the
        // threshold, so a plain focus-click on a snapped title bar doesn't restore it.
        const wasSnapped = g.snap != null;
        const flW = g.float?.w ?? Math.min(g.w, 640);
        const propX = g.w > 0 ? (e.clientX - g.x) / g.w : 0.5;
        const baseX = wasSnapped ? e.clientX - propX * flW : g.x;
        const baseY = wasSnapped ? e.clientY - 13 : g.y;

        let peeled = !wasSnapped;
        let zone: SnapZone | null = null;
        beginDrag(
            e,
            (dx, dy, cx, cy) => {
                if (!peeled) {
                    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
                    unsnap(id, baseX, baseY);
                    peeled = true;
                }
                move(id, baseX + dx, baseY + dy);
                zone = zoneAt(cx, cy);
                setZone(zone);
            },
            () => {
                setZone(null);
                if (peeled && zone) snapTo(id, zone);
            },
        );
    };

    // corner resize: the dragged corner follows the pointer; the opposite corner
    // is anchored, so growing past MIN pins that edge and moves x/y accordingly.
    const startResize = (corner: Corner) => (e: ReactPointerEvent) => {
        if (snapped) return;
        e.stopPropagation();
        focus(id);
        const { x, y, w, h } = g;
        const west = corner === 'nw' || corner === 'sw';
        const north = corner === 'nw' || corner === 'ne';
        beginDrag(e, (dx, dy) => {
            const nw = Math.max(MIN_W, west ? w - dx : w + dx);
            const nh = Math.max(MIN_H, north ? h - dy : h + dy);
            setBox(id, west ? x + (w - nw) : x, north ? y + (h - nh) : y, nw, nh);
        });
    };

    const frame: CSSProperties = minimized
        ? { display: 'none' }
        : { position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h, zIndex: g.z };

    return (
        <div
            data-window-id={id}
            className={`flex flex-col border border-border bg-surface ${focused ? 'shadow-[3px_3px_0_rgba(0,0,0,0.5)]' : ''}`}
            style={frame}
            onPointerDown={() => focus(id)}
        >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: title bar is pointer-only chrome (drag / double-click to maximize). */}
            <div
                onPointerDown={startMove}
                onDoubleClick={() => toggleMax(id)}
                className={`flex h-[26px] cursor-move select-none items-center gap-1.5 border-b border-border px-2 font-mono text-xs leading-none ${
                    focused ? 'bg-surface-muted text-fg' : 'bg-surface text-fg-muted'
                }`}
            >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
                {dirty && (
                    <span title="unsaved changes" className="mr-0.5 text-[10px]">
                        ●
                    </span>
                )}
                <button
                    type="button"
                    title="minimize"
                    className={btnClass}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setMode(id, 'minimized')}
                >
                    <Minus size={13} />
                </button>
                <button
                    type="button"
                    title="maximize"
                    className={btnClass}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => toggleMax(id)}
                >
                    {max ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
                <button
                    type="button"
                    title="close"
                    className={btnClass}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={onClose ?? (() => setMode(id, 'minimized'))}
                >
                    <X size={13} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">{children}</div>

            {!snapped &&
                CORNERS.map(({ corner, cls, grip }) => (
                    <div
                        key={corner}
                        onPointerDown={startResize(corner)}
                        className={`absolute h-[14px] w-[14px] ${cls}`}
                        style={grip ? GRIP_BG : undefined}
                    />
                ))}
        </div>
    );
}
