// editor/ui/components/ContextMenu.tsx — a minimal right-click menu. Fixed to
// the cursor, closes on any outside click / next context-menu / Escape. Square,
// black-bordered to match the desktop. The first context menu in the editor;
// reuse this rather than hand-rolling another. Portalled to <body> so it escapes
// any overflow-clipping / stacking context of whatever opened it.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem = { label: string; onClick: () => void };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // close on the next pointerdown outside the menu (a right-click elsewhere
        // fires pointerdown too). Capture phase so an ancestor that stops
        // propagation (e.g. a dialog swallowing pointerdown to keep its backdrop
        // from closing) can't hide the outside click from us. The gesture that
        // OPENED this menu already pointerdown'd before it mounted, so it can't
        // self-close — no timers.
        const onDown = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    return createPortal(
        <div
            ref={ref}
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
        </div>,
        document.body,
    );
}
