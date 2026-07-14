// editor/ui/components/Taskbar.tsx — the left vertical taskbar. One button per
// window; click to focus / restore, right-click for per-window actions.
// Right-clicking empty rail space opens the taskbar menu (e.g. new client).

import { type ReactNode, useState } from 'react';
import { useWindows } from '../../stores/windows';
import { ContextMenu, type MenuItem } from './ContextMenu';

export const TASKBAR_W = 44;

export type TaskbarItem = {
    id: string;
    title: string;
    glyph: ReactNode;
    /** overrides the default focus-id-on-click. */
    onClick?: () => void;
    /** overrides the default active-window highlight. */
    isActive?: boolean;
    /** macOS-style running dot; default true (open windows). Pinned-but-closed
     *  apps pass false. */
    running?: boolean;
    /** right-click menu (e.g. show / close). */
    menu?: MenuItem[];
};

export function Taskbar({ items, menu: railMenu = [] }: { items: TaskbarItem[]; menu?: MenuItem[] }) {
    const geom = useWindows((s) => s.geom);
    const focused = useWindows((s) => s.focused);
    const { focus } = useWindows.getState();
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: right-click the rail for the taskbar menu.
        <div
            className="absolute top-0 bottom-0 left-0 z-[1000000] flex flex-col gap-1.5 border-r border-border bg-surface p-1.5"
            style={{ width: TASKBAR_W }}
            onContextMenu={(e) => {
                // only for empty rail space; item buttons handle their own menu.
                if (!railMenu.length || e.target !== e.currentTarget) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: railMenu });
            }}
        >
            {items.map((it) => {
                const g = geom[it.id];
                const minimized = g?.mode === 'minimized';
                // a minimized window is never "active" — even if it still holds focus.
                const active = !minimized && (it.isActive ?? focused === it.id);
                const running = it.running ?? true;
                return (
                    <button
                        key={it.id}
                        type="button"
                        title={it.title}
                        className={`relative grid h-8 w-8 cursor-pointer place-items-center border border-border font-mono text-[15px] leading-none ${
                            active ? 'taskbar-active' : 'bg-surface text-fg'
                        } ${minimized ? 'opacity-50' : ''}`}
                        onClick={() => (it.onClick ?? (() => focus(it.id)))()}
                        onContextMenu={(e) => {
                            if (!it.menu) return;
                            e.preventDefault();
                            setMenu({ x: e.clientX, y: e.clientY, items: it.menu });
                        }}
                    >
                        {/* macOS-style running indicator, just left of the icon. */}
                        {running && <span className="absolute top-1/2 -left-1.5 h-3 w-[3px] -translate-y-1/2 bg-fg" />}
                        {it.glyph}
                    </button>
                );
            })}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
    );
}
