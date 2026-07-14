// editor/ui/components/ContextMenu.tsx — a minimal right-click menu. Fixed to
// the cursor, closes on any outside click / next context-menu / Escape. Square,
// black-bordered to match the desktop. The first context menu in the editor;
// reuse this rather than hand-rolling another.

import { useEffect } from 'react';

export type MenuItem = { label: string; onClick: () => void };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        // deferred to the next tick so the opening contextmenu event doesn't
        // immediately close it.
        window.addEventListener('click', onClose);
        window.addEventListener('contextmenu', onClose);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('click', onClose);
            window.removeEventListener('contextmenu', onClose);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    return (
        <div
            className="fixed z-[2000000] min-w-[130px] border border-border bg-surface py-0.5 font-mono text-[11px] leading-none text-fg shadow-[2px_2px_0_rgba(0,0,0,0.5)]"
            style={{ left: x, top: y }}
        >
            {items.map((it) => (
                <button
                    key={it.label}
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                        it.onClick();
                    }}
                    className="block w-full cursor-pointer border-0 bg-transparent px-2.5 py-1 text-left font-mono text-[11px] leading-none hover:bg-accent hover:text-on-accent"
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}
