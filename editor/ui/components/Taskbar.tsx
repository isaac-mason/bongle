// editor/ui/components/Taskbar.tsx — the left vertical taskbar. One button per
// window; click to focus / restore. Square, black-bordered.

import type { CSSProperties, ReactNode } from 'react';
import { useWindows } from '../../stores/windows';

export const TASKBAR_W = 44;

export type TaskbarItem = { id: string; title: string; glyph: ReactNode };

export function Taskbar({ items }: { items: TaskbarItem[] }) {
    const geom = useWindows((s) => s.geom);
    const focused = useWindows((s) => s.focused);
    const { focus } = useWindows.getState();

    return (
        <div
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: TASKBAR_W,
                borderRight: '1px solid #000',
                background: '#fff',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: 6,
                zIndex: 1_000_000,
            }}
        >
            {items.map((it) => {
                const g = geom[it.id];
                const active = focused === it.id && g?.mode !== 'minimized';
                const minimized = g?.mode === 'minimized';
                const style: CSSProperties = {
                    width: 32,
                    height: 32,
                    border: '1px solid #000',
                    background: active ? '#000' : '#fff',
                    color: active ? '#fff' : '#000',
                    cursor: 'pointer',
                    font: '15px/1 ui-monospace, monospace',
                    display: 'grid',
                    placeItems: 'center',
                    opacity: minimized ? 0.5 : 1,
                };
                return (
                    <button key={it.id} type="button" title={it.title} style={style} onClick={() => focus(it.id)}>
                        {it.glyph}
                    </button>
                );
            })}
        </div>
    );
}
