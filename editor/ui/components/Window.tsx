// editor/ui/components/Window.tsx — a single draggable / resizable window.
//
// Square, black-bordered (bongle UI style) with macOS-style behavior: title
// bar drags, corner handle resizes, chrome buttons minimize / maximize /
// close. Pointer events, hand-rolled, no lib. The close button only appears
// for windows that pass `onClose` (launched apps); the fixed windows omit it.

import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useWindows } from '../../stores/windows';
import { TASKBAR_W } from './Taskbar';

type DragKind = 'move' | 'resize';

/** shared pointer-drag: capture on window, delta-drive `onDelta`, release on up. */
function beginDrag(e: ReactPointerEvent, onDelta: (dx: number, dy: number) => void): void {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent) => onDelta(ev.clientX - startX, ev.clientY - startY);
    const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

const btn: CSSProperties = {
    width: 18,
    height: 18,
    border: '1px solid #000',
    background: '#fff',
    cursor: 'pointer',
    font: '11px/1 ui-monospace, monospace',
    padding: 0,
    display: 'grid',
    placeItems: 'center',
};

export function Window({
    id,
    title,
    children,
    dirty,
    onClose,
}: {
    id: string;
    title: string;
    children: ReactNode;
    dirty?: boolean;
    onClose?: () => void;
}) {
    const g = useWindows((s) => s.geom[id]);
    const focused = useWindows((s) => s.focused === id);
    const { focus, move, resize, setMode, toggleMax } = useWindows.getState();

    if (!g || g.mode === 'minimized') return null;
    const max = g.mode === 'maximized';

    const start = (kind: DragKind) => (e: ReactPointerEvent) => {
        if (max) return;
        e.stopPropagation();
        focus(id);
        const { x, y, w, h } = g;
        beginDrag(e, (dx, dy) => (kind === 'move' ? move(id, x + dx, y + dy) : resize(id, w + dx, h + dy)));
    };

    const frame: CSSProperties = max
        ? { position: 'absolute', left: TASKBAR_W, top: 0, right: 0, bottom: 0, zIndex: g.z }
        : { position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h, zIndex: g.z };

    return (
        <div
            style={{
                ...frame,
                display: 'flex',
                flexDirection: 'column',
                border: '1px solid #000',
                background: '#fff',
                boxShadow: focused ? '3px 3px 0 rgba(0,0,0,0.25)' : 'none',
            }}
            onPointerDown={() => focus(id)}
        >
            <div
                onPointerDown={start('move')}
                onDoubleClick={() => toggleMax(id)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 6px',
                    borderBottom: '1px solid #000',
                    background: focused ? '#000' : '#fff',
                    color: focused ? '#fff' : '#000',
                    cursor: max ? 'default' : 'move',
                    userSelect: 'none',
                    font: '12px/1 ui-monospace, monospace',
                }}
            >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                {dirty && (
                    <span title="unsaved changes" style={{ marginRight: 2, fontSize: 10 }}>
                        ●
                    </span>
                )}
                <button
                    type="button"
                    title="minimize"
                    style={btn}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setMode(id, 'minimized')}
                >
                    <Minus size={13} />
                </button>
                <button
                    type="button"
                    title="maximize"
                    style={btn}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => toggleMax(id)}
                >
                    {max ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
                {onClose && (
                    <button type="button" title="close" style={btn} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
                        <X size={13} />
                    </button>
                )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>

            {!max && (
                // biome-ignore lint/a11y/noStaticElementInteractions: resize handle is pointer-only chrome.
                <div
                    onPointerDown={start('resize')}
                    style={{
                        position: 'absolute',
                        right: 0,
                        bottom: 0,
                        width: 14,
                        height: 14,
                        cursor: 'nwse-resize',
                        background:
                            'linear-gradient(135deg, transparent 50%, #000 50%, #000 60%, transparent 60%, transparent 75%, #000 75%)',
                    }}
                />
            )}
        </div>
    );
}
