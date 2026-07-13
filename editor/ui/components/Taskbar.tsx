// editor/ui/components/Taskbar.tsx — the left vertical taskbar. One button per
// window; click to focus / restore. Square, black-bordered.

import { type CSSProperties, type ReactNode, useState } from 'react';
import { useWindows } from '../../stores/windows';
import { ContextMenu, type MenuItem } from './ContextMenu';

export const TASKBAR_W = 44;

export type TaskbarItem = { id: string; title: string; glyph: ReactNode };
/** a launcher button (not tied to a window): left-click acts, right-click menu. */
export type TaskbarAction = { id: string; title: string; glyph: ReactNode; onClick: () => void; menu?: MenuItem[] };

export function Taskbar({ items, actions = [] }: { items: TaskbarItem[]; actions?: TaskbarAction[] }) {
    const geom = useWindows((s) => s.geom);
    const focused = useWindows((s) => s.focused);
    const { focus } = useWindows.getState();
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

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
            {actions.map((a) => (
                <button
                    key={a.id}
                    type="button"
                    title={a.title}
                    // first action sits pinned to the bottom, under the windows.
                    style={{
                        width: 32,
                        height: 32,
                        marginTop: a.id === actions[0]?.id ? 'auto' : undefined,
                        border: '1px solid #000',
                        background: '#fff',
                        cursor: 'pointer',
                        display: 'grid',
                        placeItems: 'center',
                    }}
                    onClick={a.onClick}
                    onContextMenu={(e) => {
                        if (!a.menu) return;
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, items: a.menu });
                    }}
                >
                    {a.glyph}
                </button>
            ))}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
    );
}
