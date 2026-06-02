import { useEffect, useRef } from 'react';
import { useClient } from './client-store';

/**
 * The 3D viewport `<div>`. Owns the canvas mount surface (per-room canvases
 * are appended into this div by `rooms.ts`) and the ResizeObserver that
 * drives the engine's `onViewportResize` callback.
 *
 * Shared by both `play-ui.tsx` and `edit-ui.tsx`.
 */
export function Viewport() {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const viewport = ref.current;
        if (!viewport) return;

        const { setViewportElement, setViewportSize } = useClient.getState();
        setViewportElement(viewport);

        const onResize = () => {
            setViewportSize(viewport.clientWidth, viewport.clientHeight);
        };

        const ro = new ResizeObserver(onResize);
        ro.observe(viewport);
        onResize();

        return () => {
            ro.disconnect();
            setViewportElement(null);
        };
    }, []);

    return <div ref={ref} className="flex-1 relative overflow-hidden" />;
}
