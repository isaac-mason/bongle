// editor/ui/components/ClientView.tsx — mounts a client connection's iframe
// into a window body. The iframe element is owned by the ClientHost (created up
// front so the handshake can start); this just parents it into the DOM. Before a
// connection exists (the eager preview SHELL framed at boot), it shows the realm's
// boot status in the same words as the top-bar chip, so the empty surface reads as
// "still coming up" rather than a dead black window the user pokes at.

import { useEffect, useRef } from 'react';
import { Loader2 } from '../../../icons';
import type { ClientConnection } from '../../realms/client/client-host';
import { useBuild } from '../../stores/build';
import { useServer } from '../../stores/server';
import { useSystemWindows } from '../../stores/system-windows';

export function ClientView({ connection }: { connection: ClientConnection | null }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (el && connection && connection.iframe.parentElement !== el) el.appendChild(connection.iframe);
    }, [connection]);
    return (
        <div ref={ref} className="relative h-full w-full bg-black">
            {!connection && <ClientBootStatus />}
        </div>
    );
}

/** the shell's centered boot indicator — mirrors the top-bar PreviewStatusChip
 *  (spinner + current phase, a red "failed → logs" target on failure) so the play
 *  surface explains itself while the realm stack comes up. */
function ClientBootStatus() {
    const status = useServer((s) => s.status);
    const phase = useServer((s) => s.phase);
    const buildStatus = useBuild((s) => s.status);

    if (status === 'failed') {
        return (
            <button
                type="button"
                title="The game preview failed to start — open the build + server logs"
                onClick={() => {
                    useSystemWindows.getState().open('build');
                    useSystemWindows.getState().open('server');
                }}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 font-mono text-[12px] text-red-500 hover:bg-white/5"
            >
                <span className="h-2.5 w-2.5 bg-red-500" />
                preview failed — open logs
            </button>
        );
    }

    const label = phase || (buildStatus === 'restarting' ? 'rebuilding preview' : 'starting preview');
    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 font-mono text-[12px] text-fg-muted">
            <Loader2 size={18} className="animate-spin" />
            {label}…
        </div>
    );
}
