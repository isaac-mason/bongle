// editor/ui/components/Tabs.tsx — VSCode-style tab strip for one editor group.
// Right-click a tab for close actions (close / close unsaved / to the right / all).

import { useState } from 'react';
import { useEditor } from '../../stores/editor';
import { useTabDrag } from '../../stores/tab-drag';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function Tabs({ group }: { group: string }) {
    const g = useEditor((s) => s.groups[group]);
    const dirty = useEditor((s) => s.dirty);
    const { activate, closeTab, closeMany, moveTab } = useEditor.getState();
    const { setDrag } = useTabDrag.getState();
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

    // drop the in-flight tab into this group at `index` (end when omitted).
    const onDrop = (e: React.DragEvent, index?: number): void => {
        const drag = useTabDrag.getState().drag;
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        moveTab(drag.path, drag.group, group, index);
        setDrag(null);
    };
    const allowDrop = (e: React.DragEvent): void => {
        if (useTabDrag.getState().drag) e.preventDefault();
    };

    if (!g || g.tabs.length === 0) return <div className="h-[26px] shrink-0 border-b border-border" />;
    const { tabs, active } = g;

    const openMenu = (e: React.MouseEvent, path: string, i: number): void => {
        e.preventDefault();
        e.stopPropagation();
        const unsaved = tabs.filter((t) => dirty[t]);
        const toRight = tabs.slice(i + 1);
        setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                { label: 'Close', onClick: () => closeTab(group, path) },
                ...(unsaved.length ? [{ label: 'Close Unsaved', onClick: () => closeMany(group, unsaved) }] : []),
                ...(toRight.length ? [{ label: 'Close to the Right', onClick: () => closeMany(group, toRight) }] : []),
                { label: 'Close All', onClick: () => closeMany(group, [...tabs]) },
            ],
        });
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: tab strip is a pointer drop target.
        <div
            className="flex h-[26px] shrink-0 overflow-auto border-b border-border"
            onDragOver={allowDrop}
            onDrop={(e) => onDrop(e)}
        >
            {tabs.map((path, i) => {
                const on = path === active;
                const name = path.split('/').pop() ?? path;
                return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: tab row is pointer chrome.
                    // biome-ignore lint/a11y/noStaticElementInteractions: tab row is pointer chrome.
                    <div
                        key={path}
                        draggable
                        onDragStart={(e) => {
                            setDrag({ group, path });
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', path); // Firefox needs data to start a drag
                        }}
                        onDragEnd={() => setDrag(null)}
                        onDragOver={allowDrop}
                        onDrop={(e) => onDrop(e, i)}
                        onClick={() => activate(group, path)}
                        onContextMenu={(e) => openMenu(e, path, i)}
                        title={path}
                        className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-border px-2 font-mono text-xs leading-none ${
                            on ? 'bg-accent text-on-accent' : 'bg-surface text-fg'
                        }`}
                    >
                        <span>{name}</span>
                        <span className="w-2 text-center">{dirty[path] ? '●' : ''}</span>
                        <button
                            type="button"
                            title="close"
                            onClick={(e) => {
                                e.stopPropagation();
                                closeTab(group, path);
                            }}
                            className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center border-none bg-transparent p-0 font-mono text-[15px] leading-none text-inherit hover:bg-fg/20"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
    );
}
