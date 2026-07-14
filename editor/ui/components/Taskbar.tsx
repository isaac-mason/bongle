// editor/ui/components/Taskbar.tsx — the left vertical taskbar. One button per
// window; click to focus / restore, right-click for per-window actions. `footer`
// items pin to the bottom (utility icons like folder-sync), pushed down by a
// flex spacer.

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

export function Taskbar({ items, footer, presence }: { items: TaskbarItem[]; footer?: TaskbarItem[]; presence?: ReactNode }) {
    const geom = useWindows((s) => s.geom);
    const focused = useWindows((s) => s.focused);
    const { focus, setMode } = useWindows.getState();
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

    const renderItem = (it: TaskbarItem): ReactNode => {
        const g = geom[it.id];
        const minimized = g?.mode === 'minimized';
        // a minimized window is never "active" — even if it still holds focus.
        const active = !minimized && (it.isActive ?? focused === it.id);
        const running = it.running ?? true;
        // clicking the icon of the visible, focused window minimizes it (toggle);
        // otherwise run its normal open/focus action.
        const toggleMinimize = !!g && focused === it.id && !minimized;
        return (
            <button
                key={it.id}
                type="button"
                aria-label={it.title}
                className={`group relative grid h-8 w-8 cursor-pointer place-items-center border border-border font-mono text-[15px] leading-none ${
                    active ? 'taskbar-active' : 'bg-surface text-fg'
                } ${minimized ? 'opacity-50' : ''}`}
                onClick={() => (toggleMinimize ? setMode(it.id, 'minimized') : (it.onClick ?? (() => focus(it.id)))())}
                onContextMenu={(e) => {
                    if (!it.menu) return;
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, items: it.menu });
                }}
            >
                {/* macOS-style running indicator, just left of the icon. */}
                {running && <span className="absolute top-1/2 -left-1.5 h-3 w-[3px] -translate-y-1/2 bg-fg" />}
                {it.glyph}
                {/* hover label popover, to the right of the taskbar (CSS-only). */}
                <span className="pointer-events-none absolute top-1/2 left-full z-[1] ml-2 hidden -translate-y-1/2 whitespace-nowrap border border-border bg-surface px-2 py-1 font-mono text-xs text-fg shadow-[2px_2px_0_rgba(0,0,0,0.4)] group-hover:block">
                    {it.title}
                </span>
            </button>
        );
    };

    return (
        <div
            className="absolute top-0 bottom-0 left-0 z-[1000000] flex flex-col gap-1.5 border-r border-border bg-surface p-1.5"
            style={{ width: TASKBAR_W }}
        >
            {items.map(renderItem)}
            {(footer?.length || presence) && (
                <div className="mt-auto flex flex-col gap-1.5">
                    {footer?.map(renderItem)}
                    {presence}
                </div>
            )}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
    );
}
