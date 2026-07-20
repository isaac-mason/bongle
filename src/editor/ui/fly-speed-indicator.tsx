import { useEffect, useState } from 'react';
import { useEditRoom } from '../edit-room-store';

const VISIBLE_MS = 1200;
const FADE_MS = 300;

export function FlySpeedIndicator() {
    const flySpeed = useEditRoom((s) => s.flySpeed);
    const flySpeedShownAt = useEditRoom((s) => s.flySpeedShownAt);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (flySpeedShownAt === 0) return;
        setVisible(true);
        const id = window.setTimeout(() => setVisible(false), VISIBLE_MS);
        return () => window.clearTimeout(id);
    }, [flySpeedShownAt]);

    if (flySpeed === null) return null;

    return (
        <div
            className="absolute bottom-20 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded bg-desktop/80 text-fg text-[11px] font-mono pointer-events-none transition-opacity"
            style={{ opacity: visible ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        >
            fly speed: {flySpeed.toFixed(1)}
        </div>
    );
}
