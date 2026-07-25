// editor/ui/components/PreviewStatusChip.tsx — the top-bar boot indicator for the
// game preview. The workspace opens before the realm stack (compiler → bake →
// server) finishes, so this is the persistent signal that the preview is still
// coming up: a spinner + current phase while booting, nothing once it's live, and
// a red "preview failed" click target (→ build + server logs) on failure.

import { Loader2 } from '../../../icons';
import { useBuild } from '../../stores/build';
import { useServer } from '../../stores/server';
import { useSystemWindows } from '../../stores/system-windows';

export function PreviewStatusChip() {
    const status = useServer((s) => s.status);
    const phase = useServer((s) => s.phase);
    const buildStatus = useBuild((s) => s.status);

    // failed first boot: a click opens where the user diagnoses + retries it.
    if (status === 'failed') {
        return (
            <button
                type="button"
                title="The game preview failed to start — open the build + server logs"
                onClick={() => {
                    useSystemWindows.getState().open('build');
                    useSystemWindows.getState().open('server');
                }}
                className="flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[11px] text-red-500 hover:bg-hover"
            >
                <span className="h-2 w-2 bg-red-500" />
                preview failed — logs
            </button>
        );
    }

    // booting or restarting (initial start, server restart, or a build restart-all /
    // re-bake) — show the phase with a spinner. `phase` carries the initial-boot
    // milestone; the build restart has no server phase, so fall back to a label.
    const busy = status === 'starting' || status === 'restarting' || buildStatus === 'restarting';
    if (!busy) return null;
    const label = phase || (buildStatus === 'restarting' ? 'rebuilding preview' : 'starting preview');

    return (
        <span className="flex items-center gap-1 font-mono text-[11px] text-fg-muted">
            <Loader2 size={12} className="animate-spin" />
            {label}…
        </span>
    );
}
