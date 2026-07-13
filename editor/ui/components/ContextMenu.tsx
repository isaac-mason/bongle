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
            style={{
                position: 'fixed',
                left: x,
                top: y,
                zIndex: 2_000_000,
                minWidth: 130,
                background: '#fff',
                border: '1px solid #000',
                boxShadow: '2px 2px 0 rgba(0,0,0,0.2)',
                padding: '2px 0',
                font: '11px/1 ui-monospace, monospace',
            }}
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
                    style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 10px',
                        border: 0,
                        background: '#fff',
                        cursor: 'pointer',
                        font: 'inherit',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#000';
                        e.currentTarget.style.color = '#fff';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = '#fff';
                        e.currentTarget.style.color = '#000';
                    }}
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}
