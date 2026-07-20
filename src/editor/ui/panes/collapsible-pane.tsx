import * as Icons from "../../../../icons";
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

type CollapsiblePaneProps = {
    title: string;
    defaultOpen?: boolean;
    /** initial height of the content area in px. undefined = auto (no resize handle). */
    defaultHeight?: number;
    children: ReactNode;
};

const MIN_HEIGHT = 48;

/**
 * a collapsible pane section used inside <RightPanel>.
 * title bar has a chevron toggle. content slot is freely composable.
 * moving a pane = moving its <CollapsiblePane> line in right-panel.tsx.
 *
 * when defaultHeight is provided the content area has an explicit height
 * and a bottom-edge drag handle lets the user resize it.
 */
export function CollapsiblePane({ title, defaultOpen = true, defaultHeight, children }: CollapsiblePaneProps) {
    const [open, setOpen] = useState(defaultOpen);
    const [height, setHeight] = useState<number | undefined>(defaultHeight);
    const lastY = useRef(0);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        lastY.current = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const dy = e.clientY - lastY.current;
        lastY.current = e.clientY;
        setHeight((h) => Math.max(MIN_HEIGHT, (h ?? MIN_HEIGHT) + dy));
    }, []);

    const resizable = defaultHeight !== undefined;

    return (
        <div className="flex flex-col border-b border-border last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center justify-between px-2 py-1.5 text-[10px] font-mono font-semibold text-fg-muted uppercase tracking-wide hover:bg-surface-muted cursor-pointer select-none flex-shrink-0 bg-surface-muted"
            >
                {title}
                {open ? <Icons.ChevronDown size={11} /> : <Icons.ChevronRight size={11} />}
            </button>

            {open && (
                <div className="relative flex flex-col min-h-0 overflow-y-auto" style={resizable ? { height } : undefined}>
                    {children}

                    {/* bottom-edge resize handle, only when resizable */}
                    {resizable && (
                        <div
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            className="absolute bottom-0 left-0 right-0 h-1 cursor-row-resize hover:bg-accent hover:opacity-60 z-10"
                        />
                    )}
                </div>
            )}
        </div>
    );
}
