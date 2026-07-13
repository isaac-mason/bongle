// editor/ui/components/LogView.tsx — renders one log stream, auto-scrolled.

import { useEffect, useRef } from 'react';
import { type LogStream, useLogs } from '../../stores/logs';

export function LogView({ stream }: { stream: LogStream }) {
    const lines = useLogs((s) => s.lines[stream]);
    const ref = useRef<HTMLDivElement>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every append.
    useEffect(() => {
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);

    return (
        <div
            ref={ref}
            style={{
                height: '100%',
                overflow: 'auto',
                padding: 8,
                whiteSpace: 'pre-wrap',
                font: '12px/1.5 ui-monospace, monospace',
            }}
        >
            {lines.length === 0 ? <span style={{ color: '#888' }}>(no output)</span> : lines.join('\n')}
        </div>
    );
}
