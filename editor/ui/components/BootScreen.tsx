// editor/ui/components/BootScreen.tsx — full-viewport overlay shown while the
// dev env boots (bundler → bake → server → client). A big rainbow "bongle"
// wordmark over the desktop backdrop, with the boot steps streaming beneath it
// as a terminal-style log. Fades out and unmounts once boot completes. The
// rainbow-clipped-to-glyphs treatment matches the website header wordmark.

import { useEffect, useRef, useState } from 'react';
import { useBoot } from '../../stores/boot';

export function BootScreen() {
    const ready = useBoot((s) => s.ready);
    const lines = useBoot((s) => s.lines);
    // keep the overlay mounted through the fade-out, then drop it.
    const [gone, setGone] = useState(false);
    useEffect(() => {
        if (!ready) return;
        const t = setTimeout(() => setGone(true), 500);
        return () => clearTimeout(t);
    }, [ready]);

    // pin the log to its latest line as steps stream in.
    const logRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);

    if (gone) return null;
    return (
        <div className={`boot-screen${ready ? ' boot-screen-hidden' : ''}`}>
            <div className="boot-content">
                <span className="boot-notch boot-notch-tl" />
                <span className="boot-notch boot-notch-br" />
                <div className="boot-wordmark">bongle</div>
                <div className="boot-terminal">
                    <div className="boot-terminal-bar">
                        <span className="boot-terminal-dot" />
                        <span className="boot-terminal-dot" />
                        <span className="boot-terminal-dot" />
                        <span className="boot-terminal-title">boot</span>
                    </div>
                    <div className="boot-log" ref={logRef}>
                        {lines.map((line, i) => (
                            // steps are append-only and ordered, so the index is a stable key.
                            // biome-ignore lint/suspicious/noArrayIndexKey: append-only ordered log.
                            <div key={i} className="boot-log-line">
                                <span className="boot-log-prompt">›</span> {line}
                            </div>
                        ))}
                        {!ready && <span className="boot-cursor" />}
                    </div>
                </div>
            </div>
        </div>
    );
}
