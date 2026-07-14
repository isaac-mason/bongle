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
        <div ref={ref} className="h-full overflow-auto whitespace-pre-wrap p-2 font-mono text-xs leading-normal text-fg">
            {lines.length === 0 ? <span className="text-fg-muted">(no output)</span> : lines.join('\n')}
        </div>
    );
}
